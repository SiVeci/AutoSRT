import os
import asyncio
import json

from ..state import q_extract, q_transcribe, q_translate, global_tasks_status, global_cancel_events, update_task_status, get_task_status
from ..ws_manager import manager

from core.audio_extractor import extract_audio

WORKSPACE_DIR = os.path.abspath(os.path.join(os.getcwd(), "workspace"))

async def process_extract_task(task_id, config_payload, loop):
    steps = config_payload.get("steps", [])
    task_dir = os.path.join(WORKSPACE_DIR, task_id)
    
    if task_id in global_cancel_events and global_cancel_events[task_id].is_set():
        return

    task_status = await get_task_status(task_id)
    if task_status:
        if task_status.get("current_step") in ["extracting", "transcribing", "translating"]:
            print(f"[提取车间] 任务 {task_id} 已在处理中，忽略并发抢占。")
            return
        await update_task_status(task_id, {"current_step": "extracting"})

    try:
        # [防呆] 流水线倒车清理：重新提取音频前，必须作废下游的旧识别与旧翻译产物
        for old_asset in ["original.srt", "translated.srt"]:
            asset_path = os.path.join(task_dir, old_asset)
            if os.path.exists(asset_path):
                try: os.remove(asset_path)
                except Exception: pass
        
        # 优先从 config_payload 获取绝对路径，其次从 meta.json 获取
        video_path = config_payload.get("absolute_path")
        if not video_path:
            meta_path = os.path.join(task_dir, "meta.json")
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        video_path = json.load(f).get("absolute_path")
                except Exception: pass
        
        if not video_path:
            video_files = [f for f in os.listdir(task_dir) if f.startswith("video.")]
            if not video_files:
                raise Exception("缺少视频源文件，无法执行音频提取。请先上传视频。")
            video_path = os.path.join(task_dir, video_files[0])
        else:
            if not os.path.exists(video_path):
                raise Exception(f"源文件不存在: {video_path}")
        
        audio_path = os.path.join(task_dir, "audio.wav")
        ffmpeg_settings = config_payload.get("ffmpeg_settings", {})
        
        def audio_progress_callback(extracted_time):
            msg = {"status": "processing", "step": "extract_audio", "extracted_time": extracted_time}
            asyncio.run_coroutine_threadsafe(manager.send_json(msg, task_id), loop)
            
        await manager.send_json({"status": "processing", "step": "extract_audio", "message": "正在提取音频..."}, task_id)
        # 透传 cancel_event
        cancel_event = global_cancel_events.get(task_id)
        
        await loop.run_in_executor(None, extract_audio, video_path, audio_path, audio_progress_callback, ffmpeg_settings, cancel_event)

        if "transcribe" in steps:
            await update_task_status(task_id, {"current_step": "pending_transcribe"})
            await q_transcribe.put((task_id, config_payload))
        elif "translate" in steps:
            await update_task_status(task_id, {"current_step": "pending_translate"})
            await q_translate.put((task_id, config_payload))
        else:
            await update_task_status(task_id, {"current_step": "completed"})
            await manager.send_json({"status": "completed", "step": "done", "message": "任务流水线执行完毕！"}, task_id)

    except asyncio.CancelledError:
        print(f"[提取车间] 任务 {task_id} 被手动中断")
        err_audio_path = os.path.join(task_dir, "audio.wav")
        if os.path.exists(err_audio_path):
            try: os.remove(err_audio_path)
            except: pass
        
        current_status = await get_task_status(task_id)
        if current_status and current_status.get("current_step") != "cancelled": 
            await update_task_status(task_id, {"current_step": "error", "interrupted_step": "extracting"})
            
        await manager.send_json({"status": "error", "message": "任务已被手动中断"}, task_id)

    except Exception as e:
        print(f"[提取车间错误] {e}")
        # 清道夫：如果出错，清理可能残留的 0 字节损坏文件
        err_audio_path = os.path.join(task_dir, "audio.wav")
        if os.path.exists(err_audio_path):
            try: os.remove(err_audio_path)
            except: pass
        if await get_task_status(task_id): 
            await update_task_status(task_id, {"current_step": "error", "interrupted_step": "extracting"})
        await manager.send_json({"status": "error", "message": f"音频提取失败: {str(e)}"}, task_id)

async def worker_extract_loop():
    loop = asyncio.get_running_loop()

    async def _run_task(t_id, payload):
        try:
            await process_extract_task(t_id, payload, loop)
        finally:
            q_extract.task_done()

    while True:
        task_id, config_payload = await q_extract.get()
        asyncio.create_task(_run_task(task_id, config_payload))