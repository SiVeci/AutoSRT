import os
import asyncio

from ..state import q_translate, global_tasks_status, global_cancel_events, update_task_status, get_task_status, gpu_lock, is_local_asr, is_local_llm
from ..ws_manager import manager
import json

from core.translate import run_llm_translation
from . import transcribe # Import module dynamically for UNLOAD signaling

WORKSPACE_DIR = os.path.abspath(os.path.join(os.getcwd(), "workspace"))

async def process_translate_task(task_id, config_payload, loop):
    task_dir = os.path.join(WORKSPACE_DIR, task_id)
    
    if task_id in global_cancel_events and global_cancel_events[task_id].is_set():
        return

    task_status = await get_task_status(task_id)
    if task_status:
        if task_status.get("current_step") == "translating":
            print(f"[翻译车间] 任务 {task_id} 已在处理中，忽略并发抢占。")
            return

    try:
        input_srt = os.path.join(task_dir, "original.srt")
        if not os.path.exists(input_srt):
            raise Exception("缺少 original.srt 生肉字幕，无法执行翻译。")
            
        output_translated = os.path.join(task_dir, "translated.srt")
        llm_config = config_payload.get("llm_settings", {})
        system_config = config_payload.get("system_settings", {})
        
        # --- 显存互斥调度机制 ---
        is_local = is_local_llm({"config": config_payload, "steps": config_payload.get("steps", [])})
        use_lock = system_config.get("vram_mutual_exclusion", True)
        
        # 引擎感知优先调度 (Engine-Aware Priority Scheduler)
        # 如果是本地 LLM 引擎且启用了显存互斥，翻译任务必须给“本地”识别任务让路
        if is_local and use_lock:
            while True:
                has_prior_local_asr = False
                # 使用 list() 拍摄快照，防止遍历时字典大小变化导致 RuntimeError
                for t_id, t_state in list(global_tasks_status.items()):
                    if t_id == task_id:
                        continue
                        
                    # 仅针对【当前活跃(in global_cancel_events)】且【处于前置阶段】且【配置为本地】的任务进行避让
                    if t_id in global_cancel_events and t_state.get("current_step") in ["pending_extract", "extracting", "pending_transcribe", "transcribing"]:
                        if is_local_asr(t_state):
                            has_prior_local_asr = True
                            break
                if not has_prior_local_asr:
                    break
                # 静默退让，等待识别任务跑完
                await asyncio.sleep(1.0)

        lock_ctx = gpu_lock if (is_local and use_lock) else asyncio.Lock() # Dummy lock if not needed

        async with lock_ctx:
            await update_task_status(task_id, {"current_step": "translating"})
            if is_local and use_lock:
                print(f"[翻译车间] 任务 {task_id} 已获得 GPU 锁，正在向 Whisper 发送卸载指令...")
                if transcribe.whisper_process and transcribe.whisper_process.is_alive() and transcribe.whisper_task_queue and transcribe.whisper_result_queue:
                    transcribe.whisper_task_queue.put(("UNLOAD",))
                    print("[翻译车间] 正在等待 Whisper 子进程释放显存...")
                    try:
                        while True:
                            msg = await loop.run_in_executor(None, transcribe.whisper_result_queue.get, True, 10.0)
                            if isinstance(msg, dict) and msg.get("type") == "unloaded":
                                print("[翻译车间] 成功收到 Whisper 显存释放确认。")
                                break
                    except Exception as e:
                        print(f"[翻译车间] 等待显存释放确认超时或异常 (模型可能已释放): {e}")

            def translate_progress_callback(msg_text):
                msg = {"status": "processing", "step": "translating", "message": msg_text}
                loop.create_task(manager.send_json(msg, task_id))
                
            await manager.send_json({"status": "processing", "step": "translating", "message": "正在并发请求大模型翻译..."}, task_id)
            
            cancel_event = global_cancel_events.get(task_id)
            
            # 封装异步任务以支持 first_completed 抢占机制
            trans_task = asyncio.create_task(
                run_llm_translation(input_srt, output_translated, llm_config, system_config, translate_progress_callback, cancel_event)
            )
            
            if cancel_event:
                wait_cancel_task = asyncio.create_task(cancel_event.wait())
                done, pending = await asyncio.wait(
                    [trans_task, wait_cancel_task], return_when=asyncio.FIRST_COMPLETED
                )
                for p in pending:
                    p.cancel()
                if wait_cancel_task in done:
                    # 优雅阻断：确保底层的 OpenAI 协程也被取消，避免 Http Client 孤儿报错
                    trans_task.cancel()
                    try:
                        await trans_task
                    except asyncio.CancelledError:
                        pass
                    raise asyncio.CancelledError()
                
                # 抛出 trans_task 可能产生的异常
                if trans_task.exception():
                    raise trans_task.exception()
            else:
                await trans_task

        # [薛定谔修复] 将当时使用的目标语种固化到该任务专属的 meta.json 中
        target_lang = llm_config.get("target_language", "zh")
        meta_path = os.path.join(task_dir, "meta.json")
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f: meta_data = json.load(f)
                meta_data["translated_language"] = target_lang
                with open(meta_path, "w", encoding="utf-8") as f: json.dump(meta_data, f, ensure_ascii=False)
            except Exception: pass

        await update_task_status(task_id, {"current_step": "completed"})
        await manager.send_json({"status": "completed", "step": "done", "message": "全量任务流水线完美收官！"}, task_id)

    except asyncio.CancelledError:
        print(f"[翻译车间] 任务 {task_id} 被手动中断")
        err_translated_path = os.path.join(task_dir, "translated.srt")
        if os.path.exists(err_translated_path):
            try: os.remove(err_translated_path)
            except: pass
            
        current_status = await get_task_status(task_id)
        if current_status and current_status.get("current_step") != "cancelled":
            await update_task_status(task_id, {"current_step": "error", "interrupted_step": "translating"})
            
        await manager.send_json({"status": "error", "message": "任务已被手动中断"}, task_id)

    except Exception as e:
        print(f"[翻译车间错误] {e}")
        # 清道夫：如果出错，清理可能残留的损坏文件
        err_translated_path = os.path.join(task_dir, "translated.srt")
        if os.path.exists(err_translated_path):
            try: os.remove(err_translated_path)
            except: pass
        if await get_task_status(task_id):
            await update_task_status(task_id, {"current_step": "error", "interrupted_step": "translating"})
        await manager.send_json({"status": "error", "message": f"智能翻译失败: {str(e)}"}, task_id)

async def worker_translate_loop():
    loop = asyncio.get_running_loop()

    async def _run_task(t_id, payload):
        try:
            await process_translate_task(t_id, payload, loop)
        finally:
            q_translate.task_done()

    while True:
        task_id, config_payload = await q_translate.get()
        asyncio.create_task(_run_task(task_id, config_payload))