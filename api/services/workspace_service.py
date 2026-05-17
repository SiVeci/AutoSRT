import os
import json
import uuid
import asyncio
import shutil
from fastapi import UploadFile, HTTPException
from ..state import global_tasks_status, global_cancel_events, get_task_status, delete_task_status, update_task_status
from core.audio_extractor import extract_audio
from .config_service import get_config
from ..ws_manager import manager

WORKSPACE_DIR = os.path.abspath(os.path.join(os.getcwd(), "workspace"))

from .library_service import generate_fingerprint
from pathlib import Path

WORKSPACE_DIR = os.path.abspath(os.path.join(os.getcwd(), "workspace"))

def sanitize_task_id(task_id: str) -> str:
    """彻底过滤路径穿透字符，仅保留最后的文件/文件夹名，防止遍历攻击"""
    if not task_id:
        return str(uuid.uuid4())
    return os.path.basename(str(task_id).replace("\\", "/"))

async def save_asset(file: UploadFile, asset_type: str, task_id: str):
    config_data = await get_config()
    max_mb = config_data.get("system_settings", {}).get("max_upload_size_mb", 4096)
    max_bytes = max_mb * 1024 * 1024
    
    # 1. 预检文件大小 (如果前端/协议提供了 size)
    if file.size is not None and file.size > max_bytes:
        raise HTTPException(status_code=413, detail=f"文件过大 (当前限制: {max_mb}MB)")
        
    # 2. 检查磁盘剩余空间 (保留 500MB 安全冗余)
    _, _, free_bytes = shutil.disk_usage(WORKSPACE_DIR)
    if free_bytes < 500 * 1024 * 1024:
        raise HTTPException(status_code=507, detail="服务器磁盘空间极低，已禁止上传")
    if file.size is not None and free_bytes < (file.size + 200 * 1024 * 1024):
        raise HTTPException(status_code=507, detail="磁盘空间不足以完整存放该文件")

    task_id = sanitize_task_id(task_id)
    task_dir = os.path.join(WORKSPACE_DIR, task_id)
    os.makedirs(task_dir, exist_ok=True)
    
    meta_path, meta_data = os.path.join(task_dir, "meta.json"), {}
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f: meta_data = json.load(f)

    safe_filename = os.path.basename(str(file.filename).replace("\\", "/"))
    base_name = os.path.splitext(safe_filename)[0]
    if "base_name" not in meta_data: meta_data["base_name"] = base_name

    # Bug 3 修复：上传新资产前，清理遗留的同类废弃文件，防止读取冲突
    if asset_type == "video": 
        for f in os.listdir(task_dir):
            if f.startswith("video."):
                try: os.remove(os.path.join(task_dir, f))
                except Exception: pass
        save_path = os.path.join(task_dir, f"video{os.path.splitext(safe_filename)[1]}")
    elif asset_type == "audio": 
        if os.path.exists(os.path.join(task_dir, "audio.wav")):
            try: os.remove(os.path.join(task_dir, "audio.wav"))
            except Exception: pass
        save_path = os.path.join(task_dir, "audio.wav")
    elif asset_type == "srt": 
        if os.path.exists(os.path.join(task_dir, "original.srt")):
            try: os.remove(os.path.join(task_dir, "original.srt"))
            except Exception: pass
        save_path = os.path.join(task_dir, "original.srt")
    else: 
        raise HTTPException(status_code=400, detail="不支持的资产类型")
    
    def _save_file(src, dest, limit):
        written = 0
        with open(dest, "wb") as buffer:
            while True:
                chunk = src.read(1024*1024*10)
                if not chunk: break
                written += len(chunk)
                if written > limit:
                    buffer.close()
                    if os.path.exists(dest): os.remove(dest)
                    raise ValueError(f"文件大小超出限制 ({max_mb}MB)")
                buffer.write(chunk)
            
    try:
        # Bug 4 修复：针对独立上传的音频，先保存为临时文件，再调用 FFmpeg 进行标准化重采样
        if asset_type == "audio":
            temp_audio_path = os.path.join(task_dir, f"temp_upload_{uuid.uuid4().hex[:8]}{os.path.splitext(safe_filename)[1]}")
            await asyncio.to_thread(_save_file, file.file, temp_audio_path, max_bytes)
            try: await asyncio.to_thread(extract_audio, temp_audio_path, save_path)
            except Exception as e: raise HTTPException(status_code=500, detail=f"音频标准化重采样失败: {str(e)}")
            finally:
                if os.path.exists(temp_audio_path):
                    try: os.remove(temp_audio_path)
                    except Exception: pass
        else:
            await asyncio.to_thread(_save_file, file.file, save_path, max_bytes)
    except ValueError as e:
        raise HTTPException(status_code=413, detail=str(e))
        
    with open(meta_path, "w", encoding="utf-8") as f: json.dump(meta_data, f, ensure_ascii=False)
        
    return {"task_id": task_id, "filename": file.filename, "message": f"{asset_type} 上传成功"}

async def create_workspace_from_path(absolute_path: str):
    """从本地绝对路径创建工作区（媒体库导入专用）"""
    if not os.path.exists(absolute_path):
        raise HTTPException(status_code=400, detail=f"文件不存在: {absolute_path}")
    
    filename = os.path.basename(absolute_path)
    base_name = os.path.splitext(filename)[0]
    # 使用 UUID 确保唯一性，避免路径名冲突
    task_id = str(uuid.uuid4())
    task_dir = os.path.join(WORKSPACE_DIR, task_id)
    os.makedirs(task_dir, exist_ok=True)
    
    # 生成指纹并记录，用于后续状态追踪
    fp = generate_fingerprint(Path(absolute_path))

    meta_path = os.path.join(task_dir, "meta.json")
    meta_data = {
        "base_name": base_name,
        "absolute_path": absolute_path,
        "fingerprint": fp,
        "import_source": "library",
        "sort_weight": 0
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta_data, f, ensure_ascii=False, indent=2)
        
    return {"task_id": task_id, "base_name": base_name}

async def get_download_file_path(task_id: str, type: str = "original"):
    task_id = sanitize_task_id(task_id)
    task_dir = os.path.join(WORKSPACE_DIR, task_id)
    if not os.path.exists(task_dir): raise HTTPException(status_code=404, detail="任务目录不存在")
        
    meta_path, base_name = os.path.join(task_dir, "meta.json"), "output"
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f: base_name = json.load(f).get("base_name", "output")
            
    if type == "translated": 
        lang_code = "chs"
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta_data = json.load(f)
                if "translated_language" in meta_data:
                    lang_code = meta_data["translated_language"]
                else:
                    config_data = await get_config()
                    lang_code = config_data.get("llm_settings", {}).get("target_language", "chs")
        except Exception:
            pass
        target_file, out_name = os.path.join(task_dir, "translated.srt"), f"{base_name}_{lang_code}.srt"
    elif type == "audio":
        target_file, out_name = os.path.join(task_dir, "audio.wav"), f"{base_name}.wav"
    elif type == "video":
        video_files = [f for f in os.listdir(task_dir) if f.startswith("video.")]
        if not video_files: 
            # 兼容媒体库导入的文件
            meta_path = os.path.join(task_dir, "meta.json")
            if os.path.exists(meta_path):
                with open(meta_path, "r", encoding="utf-8") as f:
                    abs_path = json.load(f).get("absolute_path")
                    if abs_path and os.path.exists(abs_path):
                        return abs_path, f"{base_name}{os.path.splitext(abs_path)[1]}"
            raise HTTPException(status_code=404, detail="请求的视频文件尚未生成或不存在")
        target_file = os.path.join(task_dir, video_files[0])
        out_name = f"{base_name}{os.path.splitext(video_files[0])[1]}"
    else: 
        target_file, out_name = os.path.join(task_dir, "original.srt"), f"{base_name}.srt"
    
    if not os.path.exists(target_file): raise HTTPException(status_code=404, detail="请求的字幕文件尚未生成或不存在")
    return target_file, out_name

def get_single_task(task_id: str):
    task_id = sanitize_task_id(task_id)
    task_dir = os.path.join(WORKSPACE_DIR, task_id)
    if not os.path.exists(task_dir) or not os.path.isdir(task_dir):
        raise HTTPException(status_code=404, detail="任务不存在")
        
    meta_path, base_name = os.path.join(task_dir, "meta.json"), task_id[:8] + "..."
    has_abs_video = False
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f: 
                meta_data = json.load(f)
                base_name = meta_data.get("base_name", base_name)
                abs_path = meta_data.get("absolute_path")
                if abs_path and os.path.exists(abs_path):
                    has_abs_video = True
        except Exception: pass
            
    def check_valid(file_path):
        return os.path.exists(file_path) and os.path.getsize(file_path) > 5
        
    has_video = has_abs_video or any(f.startswith("video.") and check_valid(os.path.join(task_dir, f)) for f in os.listdir(task_dir))
    
    current_step = "idle"
    state_path = os.path.join(task_dir, "state.json")
    if os.path.exists(state_path):
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                current_step = json.load(f).get("current_step", "idle")
        except Exception: pass

    return { "task_id": task_id, "base_name": base_name, "has_video": has_video, "has_abs_video": has_abs_video, "has_audio": check_valid(os.path.join(task_dir, "audio.wav")), "has_original_srt": check_valid(os.path.join(task_dir, "original.srt")), "has_translated_srt": check_valid(os.path.join(task_dir, "translated.srt")), "created_at": os.path.getmtime(task_dir), "current_step": current_step }

def get_all_tasks():
    tasks = []
    if not os.path.exists(WORKSPACE_DIR): return tasks
        
    for task_id in os.listdir(WORKSPACE_DIR):
        task_dir = os.path.join(WORKSPACE_DIR, task_id)
        if not os.path.isdir(task_dir): continue
            
        meta_path, base_name = os.path.join(task_dir, "meta.json"), task_id[:8] + "..."
        sort_weight = 0
        has_abs_video = False
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f: 
                    meta_data = json.load(f)
                    base_name = meta_data.get("base_name", base_name)
                    sort_weight = meta_data.get("sort_weight", 0)
                    abs_path = meta_data.get("absolute_path")
                    if abs_path and os.path.exists(abs_path):
                        has_abs_video = True
            except Exception: pass
            
        current_step = "idle"
        state_path = os.path.join(task_dir, "state.json")
        if os.path.exists(state_path):
            try:
                with open(state_path, "r", encoding="utf-8") as f:
                    current_step = json.load(f).get("current_step", "idle")
            except Exception: pass
                
        def check_valid(file_path):
            return os.path.exists(file_path) and os.path.getsize(file_path) > 5
            
        has_video = has_abs_video or any(f.startswith("video.") and check_valid(os.path.join(task_dir, f)) for f in os.listdir(task_dir))
        
        tasks.append({ "task_id": task_id, "base_name": base_name, "sort_weight": sort_weight, "has_video": has_video, "has_abs_video": has_abs_video, "has_audio": check_valid(os.path.join(task_dir, "audio.wav")), "has_original_srt": check_valid(os.path.join(task_dir, "original.srt")), "has_translated_srt": check_valid(os.path.join(task_dir, "translated.srt")), "created_at": os.path.getmtime(task_dir), "current_step": current_step })
        
    # 排序规则优先按 sort_weight (降序)，再按 created_at (降序)
    return sorted(tasks, key=lambda x: (x["sort_weight"], x["created_at"]), reverse=True)

async def delete_task_workspace(task_id: str):
    task_id = sanitize_task_id(task_id)
    task_status = await get_task_status(task_id)
    if task_status:
        step = task_status.get("current_step")
        if step in ["pending_extract", "extracting", "pending_transcribe", "transcribing", "pending_translate", "translating"]:
            raise HTTPException(status_code=400, detail="该任务正在执行中，为防止文件损坏，无法删除！")
            
    task_dir = os.path.join(WORKSPACE_DIR, task_id)
    if os.path.exists(task_dir): 
        try:
            shutil.rmtree(task_dir)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"文件被占用或无法删除: {str(e)}")
    delete_task_status(task_id)
    global_cancel_events.pop(task_id, None)
    manager.task_states.pop(task_id, None)
    manager.disconnect(task_id)
    return {"message": "任务删除成功"}

async def delete_single_asset(task_id: str, asset_type: str):
    task_id = sanitize_task_id(task_id)
    task_dir = os.path.join(WORKSPACE_DIR, task_id)
    if not os.path.exists(task_dir): raise HTTPException(status_code=404, detail="任务目录不存在")
    
    task_status = await get_task_status(task_id)
    if task_status:
        step = task_status.get("current_step")
        if step in ["pending_extract", "extracting", "pending_transcribe", "transcribing", "pending_translate", "translating"]:
            raise HTTPException(status_code=400, detail="该任务正在执行中，为防止底层引擎崩溃，暂无法删除资产！")
            
    def check_valid(file_path): return os.path.exists(file_path) and os.path.getsize(file_path) > 5
    
    meta_path = os.path.join(task_dir, "meta.json")
    has_abs_video = False
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                abs_path = json.load(f).get("absolute_path")
                if abs_path and os.path.exists(abs_path):
                    has_abs_video = True
        except Exception: pass

    if asset_type == "video" and has_abs_video:
        raise HTTPException(status_code=400, detail="该视频为媒体库外部映射文件，受系统保护不可单独删除。如需清理，请直接删除整个任务！")

    v_files = [f for f in os.listdir(task_dir) if f.startswith("video.") and check_valid(os.path.join(task_dir, f))]
    has_local_video = len(v_files) > 0
    has_audio = check_valid(os.path.join(task_dir, "audio.wav"))
    has_original = check_valid(os.path.join(task_dir, "original.srt"))
    has_translated = check_valid(os.path.join(task_dir, "translated.srt"))
    
    total_assets = sum([has_abs_video or has_local_video, has_audio, has_original, has_translated])
    if total_assets <= 1:
        raise HTTPException(status_code=400, detail="该任务仅剩最后一份资产，如需彻底清理，请在右侧直接删除整个任务！")
        
    try:
        if asset_type == "video":
            for f in v_files: os.remove(os.path.join(task_dir, f))
        elif asset_type == "audio":
            os.remove(os.path.join(task_dir, "audio.wav"))
        elif asset_type == "original":
            os.remove(os.path.join(task_dir, "original.srt"))
        elif asset_type == "translated":
            os.remove(os.path.join(task_dir, "translated.srt"))
        else:
            raise HTTPException(status_code=400, detail="未知的资产类型")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"删除文件失败: {str(e)}")
        
    return {"message": "资产删除成功"}

def reorder_tasks(task_ids: list[str]):
    total = len(task_ids)
    for i, tid in enumerate(task_ids):
        tid = sanitize_task_id(tid)
        task_dir = os.path.join(WORKSPACE_DIR, tid)
        meta_path = os.path.join(task_dir, "meta.json")
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                meta["sort_weight"] = total - i
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump(meta, f, ensure_ascii=False)
            except Exception: pass
    return {"message": "排序已保存"}