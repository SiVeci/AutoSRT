import os
import asyncio
from multiprocessing import Process, Queue
from queue import Empty

from ..state import q_transcribe, q_translate, global_tasks_status, global_cancel_events, update_task_status, get_task_status, gpu_lock
from ..ws_manager import manager

from core.whisper_engine import worker_process_loop, transcribe_audio, unload_model
from core.srt_formatter import generate_srt
from core.api_transcribe import run_api_transcription
from core.local_llm_manager import llm_manager
from faster_whisper.utils import _MODELS

WORKSPACE_DIR = os.path.abspath(os.path.join(os.getcwd(), "workspace"))

# 全局进程状态
whisper_process = None
whisper_task_queue = None
whisper_result_queue = None

def ensure_worker_running():
    global whisper_process, whisper_task_queue, whisper_result_queue
    if whisper_process is None or not whisper_process.is_alive():
        print("[进程管理] 启动新的 Whisper 推理子进程...")
        whisper_task_queue = Queue()
        whisper_result_queue = Queue()
        whisper_process = Process(target=worker_process_loop, args=(whisper_task_queue, whisper_result_queue), daemon=True)
        whisper_process.start()

def force_kill_worker():
    """向子进程发送毒丸强制回收，用于清理模型文件或资源重置"""
    global whisper_process, whisper_task_queue, whisper_result_queue
    if whisper_process is not None:
        if whisper_process.is_alive():
            print("[进程管理] 收到强制关闭指令，正在关闭 Whisper 子进程并释放物理句柄...")
            try:
                if whisper_task_queue is not None:
                    whisper_task_queue.put(None) # 发送毒丸
                whisper_process.join(timeout=1.0) # 等待优雅退出
                if whisper_process.is_alive():
                    whisper_process.terminate() # 强杀
                    whisper_process.join(timeout=1.0) # 阻塞等待进程真正死亡
                print("[进程管理] 子进程已彻底销毁。")
            except Exception as e:
                print(f"[进程管理] 销毁子进程时发生异常: {e}")
        
        # 无论如何，彻底切断指针引用，防止后续排队任务误用死进程
        whisper_process = None
        whisper_task_queue = None
        whisper_result_queue = None

def get_hf_repo_id(model_size: str) -> str:
    if isinstance(_MODELS, dict):
        return _MODELS.get(model_size, model_size)
    if "distil" in model_size:
        return f"Systran/faster-distil-whisper-{model_size.replace('distil-', '')}"
    return f"Systran/faster-whisper-{model_size}"

def get_folder_size(folder_path: str) -> int:
    total_size = 0
    if not os.path.exists(folder_path):
        return 0
    for dirpath, _, filenames in os.walk(folder_path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if not os.path.islink(fp):
                total_size += os.path.getsize(fp)
    return total_size

async def monitor_download(task_id: str, download_root: str, model_size: str):
    repo_id = get_hf_repo_id(model_size)
    repo_folder_name = f"models--{repo_id.replace('/', '--')}"
    target_folder = os.path.join(os.getcwd(), download_root, repo_folder_name)
    try:
        while True:
            current_size = await asyncio.to_thread(get_folder_size, target_folder)
            mb_size = current_size / (1024 * 1024)

            msg = {
                "status": "processing",
                "step": "downloading",
                "downloaded_mb": round(mb_size, 1)
            }

            await manager.send_json(msg, task_id)
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"[监控线程异常] {e}")

async def process_transcribe_task(task_id, config_payload, loop):
    global whisper_task_queue, whisper_result_queue, whisper_process
    steps = config_payload.get("steps", [])
    task_dir = os.path.join(WORKSPACE_DIR, task_id)

    if task_id in global_cancel_events and global_cancel_events[task_id].is_set():
        return

    task_status = await get_task_status(task_id)
    if task_status:
        if task_status.get("current_step") in ["transcribing", "translating"]:
            print(f"[识别车间] 任务 {task_id} 已在后续处理中，忽略并发抢占。")
            return

    try:
        old_translated_path = os.path.join(task_dir, "translated.srt")
        if os.path.exists(old_translated_path):
            try: os.remove(old_translated_path)
            except Exception: pass

        audio_path = os.path.join(task_dir, "audio.wav")
        if not os.path.exists(audio_path):
            raise Exception("缺少 audio.wav 文件，无法执行语音识别。")

        output_srt = os.path.join(task_dir, "original.srt")
        transcribe_settings = config_payload.get("transcribe_settings", {})
        system_settings = config_payload.get("system_settings", {})
        secrets_settings = config_payload.get("secrets", {})
        engine = transcribe_settings.get("engine", "local")

        if engine == "api":
            await update_task_status(task_id, {"current_step": "transcribing"})
            online_asr_settings = config_payload.get("online_asr_settings", {})
            def api_progress_callback(msg_text):
                msg = {"status": "processing", "step": "transcribing", "message": msg_text}
                asyncio.run_coroutine_threadsafe(manager.send_json(msg, task_id), loop)
            
            import threading
            cancel_event = global_cancel_events.get(task_id)
            thread_cancel = threading.Event()
            
            async def watch_cancel():
                if cancel_event:
                    await cancel_event.wait()
                    thread_cancel.set()
            cancel_watcher = asyncio.create_task(watch_cancel()) if cancel_event else None
            
            try:
                api_future = loop.run_in_executor(None, run_api_transcription, audio_path, output_srt, online_asr_settings, system_settings, api_progress_callback, thread_cancel)
                
                if cancel_event:
                    cancel_task = asyncio.create_task(cancel_event.wait())
                    done, pending = await asyncio.wait(
                        [api_future, cancel_task], return_when=asyncio.FIRST_COMPLETED
                    )
                    if cancel_task in done:
                        api_future.cancel()
                        try:
                            await api_future
                        except asyncio.CancelledError:
                            pass
                        raise asyncio.CancelledError("任务已被手动中断")
                    # 如果 api_future 先完成，要抛出其中可能包含的异常
                    api_future.result()
                else:
                    await api_future
            finally:
                if cancel_watcher:
                    cancel_watcher.cancel()

        else:
            model_settings = config_payload.get("model_settings", {})
            vad_settings = config_payload.get("vad_settings", {})
            use_lock = system_settings.get("vram_mutual_exclusion", True)

            lock_ctx = gpu_lock if use_lock else asyncio.Lock()

            async with lock_ctx:
                await update_task_status(task_id, {"current_step": "transcribing"})
                if use_lock:
                    print(f"[识别车间] 任务 {task_id} 已获得 GPU 锁，正在清理可能驻留的本地 LLM...")
                    await llm_manager.async_release_model()

                # 确保子进程存活
                ensure_worker_running()

                monitor_task = asyncio.create_task(monitor_download(task_id, model_settings.get("download_root", "models"), model_settings.get("model_size", "large-v2")))

                # 向子进程投递任务
                whisper_task_queue.put((
                    task_id,
                    audio_path,
                    output_srt,
                    model_settings,
                    transcribe_settings,
                    vad_settings,
                    system_settings,
                    secrets_settings
                ))

                # 开始在主进程阻塞读取消息，直到收到 done 或 error
                process_error = None
                while True:
                    if task_id in global_cancel_events and global_cancel_events[task_id].is_set():
                        monitor_task.cancel()
                        force_kill_worker()
                        raise asyncio.CancelledError("任务已被手动中断")

                    try:
                        # 0.5 秒超时轮询，避免完全卡死线程，同时能够响应取消或其他事件
                        msg = await loop.run_in_executor(None, whisper_result_queue.get, True, 0.5)
                        msg_type = msg.get("type")
                        if msg.get("task_id") != task_id:
                            continue # 忽略残留的旧消息

                        if msg_type == "status":
                            # 如果子进程报告开始读取/下载模型，则前端显示进度
                            if "正在读取" in msg.get("message", ""):
                                pass # monitor_task is running
                            elif "模型加载完毕" in msg.get("message", ""):
                                monitor_task.cancel()
                            await manager.send_json({"status": "processing", "step": "transcribing", "message": msg.get("message")}, task_id)
                        elif msg_type == "progress":
                            await manager.send_json({"status": "processing", "step": "transcribing", "progress": msg.get("progress"), "text": msg.get("text")}, task_id)
                        elif msg_type == "error":
                            process_error = Exception(msg.get("message"))
                            monitor_task.cancel()
                            break
                        elif msg_type == "done":
                            monitor_task.cancel()
                            break
                    except Empty:
                        # 检查进程是否意外死亡
                        if not whisper_process.is_alive():
                            process_error = Exception("Whisper 推理子进程意外崩溃！(可能发生了 Segmentation Fault 或 Out of Memory)")
                            monitor_task.cancel()
                            break
                        await asyncio.sleep(0) # 让出控制权

                if process_error:
                    raise process_error

        # 下游处理
        if "translate" in steps:
            await update_task_status(task_id, {"current_step": "pending_translate"})
            await q_translate.put((task_id, config_payload))
        else:
            await update_task_status(task_id, {"current_step": "completed"})
            await manager.send_json({"status": "completed", "step": "done", "message": "任务流水线执行完毕！"}, task_id)

    except asyncio.CancelledError:
        print(f"[识别车间] 任务 {task_id} 被手动中断")
        err_srt_path = os.path.join(task_dir, "original.srt")
        if os.path.exists(err_srt_path):
            try: os.remove(err_srt_path)
            except: pass
            
        current_status = await get_task_status(task_id)
        if current_status and current_status.get("current_step") != "cancelled": 
            await update_task_status(task_id, {"current_step": "error", "interrupted_step": "transcribing"})
            
        await manager.send_json({"status": "error", "message": "任务已被手动中断"}, task_id)

    except Exception as e:
        print(f"[识别车间错误] {e}")
        err_srt_path = os.path.join(task_dir, "original.srt")
        if os.path.exists(err_srt_path):
            try: os.remove(err_srt_path)
            except: pass
        if await get_task_status(task_id):
            await update_task_status(task_id, {"current_step": "error", "interrupted_step": "transcribing"})
        await manager.send_json({"status": "error", "message": f"语音识别失败: {str(e)}"}, task_id)

async def worker_transcribe_loop():
    loop = asyncio.get_running_loop()

    async def _run_task(t_id, payload):
        try:
            await process_transcribe_task(t_id, payload, loop)
        finally:
            q_transcribe.task_done()

    while True:
        task_id, config_payload = await q_transcribe.get()
        asyncio.create_task(_run_task(task_id, config_payload))