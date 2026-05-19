import os
import shutil
import gc
import sys
import time
from multiprocessing import Queue
from queue import Empty
import traceback

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

from faster_whisper import WhisperModel
from huggingface_hub import snapshot_download
from faster_whisper.utils import _MODELS
from core.srt_formatter import generate_srt

_cached_model = None
_cached_model_params = None

def get_current_model_size():
    global _cached_model_params
    if _cached_model_params:
        return _cached_model_params[0]
    return None

def unload_model():
    global _cached_model, _cached_model_params
    if _cached_model is not None:
        del _cached_model
        _cached_model = None
        _cached_model_params = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        print("[*] Whisper 模型已从显存中卸载。")

def worker_process_loop(task_queue: Queue, result_queue: Queue):
    """
    独立运行的子进程循环。
    不断从 task_queue 获取任务，支持根据用户配置动态设置空闲超时自动退出以彻底释放显存。
    """
    global _cached_model, _cached_model_params
    current_idle_timeout = 300

    while True:
        try:
            wait_time = current_idle_timeout if current_idle_timeout > 0 else 99999999
            task = task_queue.get(timeout=wait_time)
            if task is None: 
                break
            
            # 支持优雅显存交接
            if isinstance(task, tuple) and task[0] == "UNLOAD":
                unload_model()
                result_queue.put({"task_id": "system", "type": "unloaded"})
                continue

        except Empty:
            print(f"[Whisper Worker] {wait_time}秒无任务，主动退出释放显存。")
            sys.exit(0)
            
        task_id, audio_path, output_srt, model_settings, transcribe_settings, vad_settings, system_config, secrets_settings = task
        current_idle_timeout = transcribe_settings.get("idle_timeout", 300)
        
        try:
            model_size = model_settings.get("model_size", "large-v2")
            download_root = model_settings.get("download_root", "models")
            use_proxy = system_config.get("use_proxy_for_model_download", False)
            enable_global_proxy = system_config.get("enable_global_proxy", False)
            proxy_url = system_config.get("network_proxy", "")

            actual_use_proxy = enable_global_proxy and use_proxy and proxy_url

            hf_token = secrets_settings.get("hf_token", "") if secrets_settings else ""
            token_kwargs = {"token": hf_token} if hf_token else {}

            if shutil.which("nvidia-smi"):
                device = "cuda"
                compute_type = "float16"
            else:
                device = "cpu"
                compute_type = "int8"

            custom_model_dir = os.path.join(os.getcwd(), download_root)
            current_params = (model_size, device, compute_type, custom_model_dir)
            
            if _cached_model is None or _cached_model_params != current_params:
                print(f"[*] 正在加载 Whisper 模型 ({model_size}) 到 {device.upper()} ({compute_type})...")
                result_queue.put({"task_id": task_id, "type": "status", "message": "正在读取或下载模型..."})
                
                if isinstance(_MODELS, dict):
                    repo_id = _MODELS.get(model_size, model_size)
                else:
                    repo_id = f"Systran/faster-whisper-{model_size}"
                    if "distil" in model_size:
                        repo_id = f"Systran/faster-distil-whisper-{model_size.replace('distil-', '')}"
                    
                _dl_proxy = proxy_url
                if _dl_proxy and _dl_proxy.startswith("socks5://"):
                    _dl_proxy = _dl_proxy.replace("socks5://", "socks5h://", 1)
                    
                proxies = {"http": _dl_proxy, "https": _dl_proxy} if actual_use_proxy else {"http": None, "https": None}
                try:
                    snapshot_download(repo_id=repo_id, cache_dir=custom_model_dir, proxies=proxies, **token_kwargs)
                except Exception as e:
                    print(f"[*] 模型预下载检查因网络失败或被跳过，将尝试直接使用本地缓存。原因: {e}")
                
                try:
                    _cached_model = WhisperModel(
                        model_size, 
                        device=device, 
                        compute_type=compute_type,
                        download_root=custom_model_dir,
                        local_files_only=True
                    )
                    _cached_model_params = current_params
                except Exception as e:
                    err_str = str(e).lower()
                    _cached_model = None
                    _cached_model_params = None
                    if "safetensors" in err_str or "json" in err_str or "corrupted" in err_str or "utf-8" in err_str:
                        raise RuntimeError(f"模型加载失败，可能是文件损坏。如果持续失败，请尝试手动删除 {custom_model_dir} 目录下的模型缓存。详细错误: {str(e)}")
                    else:
                        raise RuntimeError(f"模型加载不完整或网络被中断。请重试以继续断点续传。详细错误: {str(e)}")

            print(f"[*] 开始识别音频: {audio_path}")
            result_queue.put({"task_id": task_id, "type": "status", "message": "模型加载完毕，开始语音识别..."})
            
            transcribe_kwargs = transcribe_settings.copy()
            transcribe_kwargs.pop("engine", None)
            transcribe_kwargs.pop("idle_timeout", None)
            
            segments, info = _cached_model.transcribe(
                audio_path,
                **transcribe_kwargs,
                **vad_settings
            )
            
            def progress_callback(start_time, end_time, text):
                result_queue.put({
                    "task_id": task_id,
                    "type": "progress",
                    "progress": f"{start_time} -> {end_time}",
                    "text": text
                })
                
            generate_srt(segments, output_srt, progress_callback)
            result_queue.put({"task_id": task_id, "type": "done"})
            
        except Exception as e:
            traceback.print_exc()
            result_queue.put({"task_id": task_id, "type": "error", "message": str(e)})


def transcribe_audio(
    audio_path: str,
    model_settings: dict,
    transcribe_settings: dict,
    vad_settings: dict,
    system_config: dict,
    secrets_settings: dict = None
):
    global _cached_model, _cached_model_params

    model_size = model_settings.get("model_size", "large-v2")
    download_root = model_settings.get("download_root", "models")
    use_proxy = system_config.get("use_proxy_for_model_download", False)
    enable_global_proxy = system_config.get("enable_global_proxy", False)
    proxy_url = system_config.get("network_proxy", "")

    actual_use_proxy = enable_global_proxy and use_proxy and proxy_url

    hf_token = secrets_settings.get("hf_token", "") if secrets_settings else ""
    token_kwargs = {"token": hf_token} if hf_token else {}

    if shutil.which("nvidia-smi"):
        device = "cuda"
        compute_type = "float16"
    else:
        device = "cpu"
        compute_type = "int8"

    custom_model_dir = os.path.join(os.getcwd(), download_root)
    
    current_params = (model_size, device, compute_type, custom_model_dir)
    
    if _cached_model is None or _cached_model_params != current_params:
        print(f"[*] 正在加载 Whisper 模型 ({model_size}) 到 {device.upper()} ({compute_type})...")
        
        # --- 多线程安全预下载逻辑 ---
        if isinstance(_MODELS, dict):
            repo_id = _MODELS.get(model_size, model_size)
        else:
            repo_id = f"Systran/faster-whisper-{model_size}"
            if "distil" in model_size:
                repo_id = f"Systran/faster-distil-whisper-{model_size.replace('distil-', '')}"
            
        # 处理 SOCKS5 远端 DNS 解析，防止 Hugging Face 被本地 DNS 阻断
        _dl_proxy = proxy_url
        if _dl_proxy and _dl_proxy.startswith("socks5://"):
            _dl_proxy = _dl_proxy.replace("socks5://", "socks5h://", 1)
            
        proxies = {"http": _dl_proxy, "https": _dl_proxy} if actual_use_proxy else {"http": None, "https": None}
        try:
            snapshot_download(repo_id=repo_id, cache_dir=custom_model_dir, proxies=proxies, **token_kwargs)
        except Exception as e:
            print(f"[*] 模型预下载检查因网络失败或被跳过，将尝试直接使用本地缓存。原因: {e}")
        # -----------------------------
        
        try:
            _cached_model = WhisperModel(
                model_size, 
                device=device, 
                compute_type=compute_type,
                download_root=custom_model_dir,
                local_files_only=True
            )
            _cached_model_params = current_params
        except Exception as e:
            err_str = str(e).lower()
            _cached_model = None
            _cached_model_params = None
            if "safetensors" in err_str or "json" in err_str or "corrupted" in err_str or "utf-8" in err_str:
                raise RuntimeError(f"模型加载失败，可能是文件损坏。如果持续失败，请尝试手动删除 {custom_model_dir} 目录下的模型缓存。详细错误: {str(e)}")
            else:
                raise RuntimeError(f"模型加载不完整或网络被中断。请重试以继续断点续传。详细错误: {str(e)}")

    print(f"[*] 开始识别音频: {audio_path}")
    
    transcribe_kwargs = transcribe_settings.copy()
    transcribe_kwargs.pop("engine", None)
    transcribe_kwargs.pop("idle_timeout", None)
    
    segments, info = _cached_model.transcribe(
        audio_path,
        **transcribe_kwargs,
        **vad_settings
    )
    
    print(f"[*] 识别到语言: {info.language} (概率: {info.language_probability:.2f})")
    return segments