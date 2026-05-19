import os
import json
import shutil
import socket
import urllib.parse
import subprocess
import asyncio
import httpx
from fastapi import HTTPException
from faster_whisper import available_models
from faster_whisper.utils import _MODELS
from ..state import global_tasks_status, global_downloading_models

SUPPORTED_LANGUAGES = {
    "af": "afrikaans", "am": "amharic", "ar": "arabic", "as": "assamese", "az": "azerbaijani", 
    "ba": "bashkir", "be": "belarusian", "bg": "bulgarian", "bn": "bengali", "bo": "tibetan", 
    "br": "breton", "bs": "bosnian", "ca": "catalan", "cs": "czech", "cy": "welsh", 
    "da": "danish", "de": "german", "el": "greek", "en": "english", "es": "spanish", 
    "et": "estonian", "eu": "basque", "fa": "persian", "fi": "finnish", "fo": "faroese", 
    "fr": "french", "gl": "galician", "gu": "gujarati", "ha": "hausa", "haw": "hawaiian", 
    "he": "hebrew", "hi": "hindi", "hr": "croatian", "ht": "haitian creole", "hu": "hungarian", 
    "hy": "armenian", "id": "indonesian", "is": "icelandic", "it": "italian", "ja": "japanese", 
    "jw": "javanese", "ka": "georgian", "kk": "kazakh", "km": "khmer", "kn": "kannada", 
    "ko": "korean", "la": "latin", "lb": "luxembourgish", "ln": "lingala", "lo": "lao", 
    "lt": "lithuanian", "lv": "latvian", "mg": "malagasy", "mi": "maori", "mk": "macedonian", 
    "ml": "malayalam", "mn": "mongolian", "mr": "marathi", "ms": "malay", "mt": "maltese", 
    "my": "myanmar", "ne": "nepali", "nl": "dutch", "nn": "nynorsk", "no": "norwegian", 
    "oc": "occitan", "pa": "punjabi", "pl": "polish", "ps": "pashto", "pt": "portuguese", 
    "ro": "romanian", "ru": "russian", "sa": "sanskrit", "sd": "sindhi", "si": "sinhala", 
    "sk": "slovak", "sl": "slovenian", "sn": "shona", "so": "somali", "sq": "albanian", 
    "sr": "serbian", "su": "sundanese", "sv": "swedish", "sw": "swahili", "ta": "tamil", 
    "te": "telugu", "tg": "tajik", "th": "thai", "tk": "turkmen", "tl": "tagalog", 
    "tr": "turkish", "tt": "tatar", "uk": "ukrainian", "ur": "urdu", "uz": "uzbek", 
    "vi": "vietnamese", "yi": "yiddish", "yo": "yoruba", "zh": "chinese"
}

CONFIG_DIR = "config"
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
EXAMPLE_CONFIG_PATH = os.path.join(CONFIG_DIR, "config.example.json")

def set_global_proxy(system_settings: dict):
    proxy_url = system_settings.get("network_proxy", "").strip()
    enable_global = system_settings.get("enable_global_proxy", False)
    
    if enable_global and proxy_url:
        proxy = proxy_url
        if proxy.startswith("socks5://"): proxy = proxy.replace("socks5://", "socks5h://", 1)
        elif not proxy.startswith("http://") and not proxy.startswith("https://") and not proxy.startswith("socks5h://"):
            proxy = f"http://{proxy}"
        for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]: os.environ[k] = proxy
        os.environ["NO_PROXY"] = "localhost,127.0.0.1,::1"
        print(f"[*] 已动态应用全局网络代理: {proxy}")
    else:
        for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY"]: os.environ.pop(k, None)
        if not enable_global:
            print("[*] 全局代理总闸已关闭，恢复纯净直连模式。")

config_lock = asyncio.Lock()
_background_tasks = set()

def get_system_info():
    if shutil.which("nvidia-smi"):
        gpu_name = "NVIDIA GPU"
        try:
            result = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, check=False)
            if result.returncode == 0 and result.stdout.strip():
                gpu_name = result.stdout.strip().split('\n')[0]
        except Exception:
            pass
        return {"device": "cuda", "gpu_name": gpu_name}
    return {"device": "cpu", "gpu_name": ""}

def _migrate_config_internal(config: dict) -> bool:
    """内部迁移函数，将旧版单配置迁移为 Profile 结构。返回 True 表示有改动。"""
    changed = False
    
    # 1. 迁移 llm_settings
    if "llm_settings" in config:
        old_llm = config["llm_settings"]
        if "profiles" not in old_llm:
            new_profile = {
                "id": "default",
                "name": "默认方案",
                "api_key": old_llm.get("api_key", ""),
                "base_url": old_llm.get("base_url", "https://api.openai.com/v1"),
                "model_name": old_llm.get("model_name", "gpt-4o"),
                "batch_size": old_llm.get("batch_size", 100),
                "concurrent_workers": old_llm.get("concurrent_workers", 3),
                "system_prompt": old_llm.get("system_prompt", ""),
                "timeout_settings": old_llm.get("timeout_settings", {"connect": 15, "read": 300}),
                "max_tokens": old_llm.get("max_tokens", 8192),
                "temperature": old_llm.get("temperature", 1.0)
            }
            config["llm_settings"] = {
                "active_profile_id": "default",
                "profiles": [new_profile],
                "target_language": old_llm.get("target_language", "chs"),
                "use_network_proxy": old_llm.get("use_network_proxy", False)
            }
            changed = True
        
        # 补全 engine 和 local_settings
        if "engine" not in config["llm_settings"]:
            config["llm_settings"]["engine"] = "api"
            changed = True
        if "local_settings" not in config["llm_settings"]:
            config["llm_settings"]["local_settings"] = {
                "model_path": "",
                "n_gpu_layers": -1,
                "n_ctx": 4096,
                "idle_timeout": 300
            }
            changed = True

    if "system_settings" in config:
        if "vram_mutual_exclusion" not in config["system_settings"]:
            config["system_settings"]["vram_mutual_exclusion"] = True
            changed = True
        if "max_upload_size_mb" not in config["system_settings"]:
            config["system_settings"]["max_upload_size_mb"] = 4096
            changed = True

    if "transcribe_settings" in config:
        if "idle_timeout" not in config["transcribe_settings"]:
            config["transcribe_settings"]["idle_timeout"] = 300
            changed = True

    # 2. 迁移 online_asr_settings
    if "online_asr_settings" in config and "profiles" not in config["online_asr_settings"]:
        old_asr = config["online_asr_settings"]
        new_profile = {
            "id": "default",
            "name": "默认方案",
            "api_key": old_asr.get("api_key", ""),
            "base_url": old_asr.get("base_url", "https://api.openai.com/v1"),
            "model_name": old_asr.get("model_name", "whisper-1"),
            "prompt": old_asr.get("prompt", ""),
            "translate": old_asr.get("translate", False),
            "speaker_labels": old_asr.get("speaker_labels", False),
            "word_timestamps": old_asr.get("word_timestamps", False),
            "timeout_settings": old_asr.get("timeout_settings", {"connect": 15, "read": 300})
        }
        config["online_asr_settings"] = {
            "active_profile_id": "default",
            "profiles": [new_profile],
            "language": old_asr.get("language", None),
            "use_network_proxy": old_asr.get("use_network_proxy", False)
        }
        changed = True
        
    return changed

def _save_config_sync(config: dict):
    """同步保存配置函数"""
    temp_path = CONFIG_PATH + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    os.replace(temp_path, CONFIG_PATH)

async def get_config():
    if not os.path.exists(CONFIG_PATH) and os.path.exists(EXAMPLE_CONFIG_PATH):
        os.makedirs(CONFIG_DIR, exist_ok=True)
        shutil.copy(EXAMPLE_CONFIG_PATH, CONFIG_PATH)
        
    def _read():
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            config = json.load(f)
            
        if _migrate_config_internal(config):
            _save_config_sync(config)
        return config
        
    try:
        async with config_lock:
            return await asyncio.to_thread(_read)
    except Exception as e: raise HTTPException(status_code=500, detail=f"读取配置失败: {str(e)}")

async def restore_config():
    if not os.path.exists(EXAMPLE_CONFIG_PATH): raise HTTPException(status_code=404, detail="找不到默认配置文件")
    os.makedirs(CONFIG_DIR, exist_ok=True)
    
    def _restore():
        shutil.copy(EXAMPLE_CONFIG_PATH, CONFIG_PATH)
        with open(CONFIG_PATH, "r", encoding="utf-8") as f: return json.load(f)
        
    try:
        async with config_lock:
            config = await asyncio.to_thread(_restore)
        set_global_proxy(config.get("system_settings", {}))
        return config
    except Exception as e: raise HTTPException(status_code=500, detail=f"读取恢复后的配置失败: {str(e)}")

async def update_config(payload: dict):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        
        # 增量合并逻辑：以前端传来的 payload 为主
        # 仅当 payload 完全缺失某个顶级节点时，才从物理文件中补全（防呆保护）
        existing_config = {}
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                    existing_config = json.load(f)
            except Exception: pass
            
        final_config = payload.copy()
        
        # 检查并补全缺失的顶级节点
        for key in ["library", "system_settings", "model_settings", "transcribe_settings", "llm_settings", "online_asr_settings"]:
            if key in existing_config and key not in final_config:
                final_config[key] = existing_config[key]

        async with config_lock:
            await asyncio.to_thread(_save_config_sync, final_config)
            
        set_global_proxy(final_config.get("system_settings", {}))
        return {"message": "配置已保存并生效"}
    except Exception as e: raise HTTPException(status_code=500, detail=f"保存配置失败: {str(e)}")

def resolve_active_profile(settings: dict) -> dict:
    """从设置中解析出当前激活的 Profile 并将其字段平铺到根部"""
    if not settings or "profiles" not in settings:
        return settings
    
    active_id = settings.get("active_profile_id", "default")
    profiles = settings.get("profiles", [])
    if not profiles:
        return settings
        
    profile = next((p for p in profiles if p["id"] == active_id), profiles[0])
    
    # 合并 Profile 的字段到 settings 中
    new_settings = settings.copy()
    new_settings.update(profile)
    return new_settings

def test_proxy(proxy_url: str):
    proxy_url = proxy_url.strip()
    if not proxy_url: return {"status": "ok", "message": "未配置代理"}
    try:
        if "://" not in proxy_url: proxy_url = f"http://{proxy_url}"
        parsed = urllib.parse.urlparse(proxy_url)
        if not parsed.hostname or not parsed.port: raise ValueError("代理地址或端口格式无效")
        with socket.create_connection((parsed.hostname, parsed.port), timeout=3.0): pass
        return {"status": "ok", "message": "代理服务器连接成功"}
    except Exception as e: raise HTTPException(status_code=400, detail=f"代理服务器连接失败，请检查配置。({str(e)})")

def get_languages():
    langs = [{"code": k, "name": v.capitalize()} for k, v in SUPPORTED_LANGUAGES.items()]
    return sorted(langs, key=lambda x: x["name"])

def get_folder_size(folder_path: str) -> int:
    total_size = 0
    if not os.path.exists(folder_path): return 0
    for dirpath, _, filenames in os.walk(folder_path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if not os.path.islink(fp):
                total_size += os.path.getsize(fp)
    return total_size

def get_models():
    models = available_models()
    
    # 动态去重逻辑：基于真实物理仓库过滤别名 (如 large-v3-turbo 和 turbo)
    models_sorted_by_len = sorted(models, key=len, reverse=True)
    seen_repos = set()
    unique_models = set()
    
    for m in models_sorted_by_len:
        repo_id = _MODELS.get(m, m) if isinstance(_MODELS, dict) else (f"Systran/faster-distil-whisper-{m.replace('distil-', '')}" if "distil" in m else f"Systran/faster-whisper-{m}")
        if repo_id not in seen_repos:
            seen_repos.add(repo_id)
            unique_models.add(m)
            
    filtered_models = [m for m in models if m in unique_models]
    
    download_root = "models"
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                download_root = json.load(f).get("model_settings", {}).get("download_root", "models")
    except Exception: pass

    def check_downloaded(m):
        repo_id = _MODELS.get(m, m) if isinstance(_MODELS, dict) else (f"Systran/faster-distil-whisper-{m.replace('distil-', '')}" if "distil" in m else f"Systran/faster-whisper-{m}")
        target_folder = os.path.join(os.getcwd(), download_root, f"models--{repo_id.replace('/', '--')}", "snapshots")
        if not os.path.exists(target_folder): return False, 0
        try:
            for hash_dir in os.listdir(target_folder):
                hp = os.path.join(target_folder, hash_dir)
                if os.path.isdir(hp) and (os.path.exists(os.path.join(hp, "model.bin")) or os.path.exists(os.path.join(hp, "model.safetensors"))):
                    root_folder = os.path.join(os.getcwd(), download_root, f"models--{repo_id.replace('/', '--')}")
                    return True, get_folder_size(root_folder)
        except Exception: pass
        return False, 0

    def get_model_option(m):
        is_dl, size_b = check_downloaded(m)
        return {"id": m, "downloaded": is_dl, "size_bytes": size_b}

    return [
        {"label": "✨ 常规多语言模型 (Standard)", "options": [get_model_option(m) for m in filtered_models if "distil" not in m and not m.endswith(".en")]},
        {"label": "⚡ 蒸馏加速模型 (Distilled)", "options": [get_model_option(m) for m in filtered_models if "distil" in m]},
        {"label": "🇬🇧 纯英文模型 (English Only)", "options": [get_model_option(m) for m in filtered_models if m.endswith(".en")]}
    ]

def delete_model(model_id: str):
    from ..workers.transcribe import force_kill_worker
    for task in global_tasks_status.values():
        if task.get("current_step") in ["pending_transcribe", "transcribing"]:
            raise HTTPException(status_code=400, detail="当前有任务正在识别队列中，为防止崩溃，请等待识别完成后再执行删除！")
            
    # 因为进程隔离，主进程无法判断当前子进程具体加载了哪个模型，
    # 且既然安全锁已确认无识别任务在跑，最安全的做法是直接销毁存活的子进程，彻底释放所有文件句柄锁。
    force_kill_worker()
        
    download_root = "models"
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                download_root = json.load(f).get("model_settings", {}).get("download_root", "models")
    except Exception: pass
    
    repo_id = _MODELS.get(model_id, model_id) if isinstance(_MODELS, dict) else (f"Systran/faster-distil-whisper-{model_id.replace('distil-', '')}" if "distil" in model_id else f"Systran/faster-whisper-{model_id}")
    target_folder = os.path.join(os.getcwd(), download_root, f"models--{repo_id.replace('/', '--')}")
    
    if os.path.exists(target_folder):
        try: shutil.rmtree(target_folder)
        except Exception as e: raise HTTPException(status_code=500, detail=f"删除文件失败，可能被占用: {str(e)}")
    return {"message": f"模型 {model_id} 删除成功"}

async def start_model_download(model_id: str, payload: dict):
    if model_id in global_downloading_models:
        raise HTTPException(status_code=400, detail="该模型已经在后台下载中！")
        
    for task in global_tasks_status.values():
        if task.get("current_step") in ["pending_transcribe", "transcribing"]:
            raise HTTPException(status_code=400, detail="当前有任务正在识别队列中，请等待识别完成后再执行手动下载！")

    global_downloading_models[model_id] = {"status": "started", "downloaded_mb": 0.0}
    
    system_settings = payload.get("system_settings", {})
    use_proxy = system_settings.get("use_proxy_for_model_download", False)
    enable_global_proxy = system_settings.get("enable_global_proxy", False)
    proxy_url = system_settings.get("network_proxy", "")
    
    actual_use_proxy = enable_global_proxy and use_proxy and proxy_url
    
    _dl_proxy = proxy_url
    if _dl_proxy and _dl_proxy.startswith("socks5://"):
        _dl_proxy = _dl_proxy.replace("socks5://", "socks5h://", 1)
        
    proxies = {"http": _dl_proxy, "https": _dl_proxy} if actual_use_proxy else {"http": None, "https": None}
    
    download_root = "models"
    hf_token = ""
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                config_data = json.load(f)
                download_root = config_data.get("model_settings", {}).get("download_root", "models")
                hf_token = config_data.get("secrets", {}).get("hf_token", "")
    except Exception: pass
    
    token_kwargs = {"token": hf_token} if hf_token else {}
    
    from huggingface_hub import snapshot_download
    repo_id = _MODELS.get(model_id, model_id) if isinstance(_MODELS, dict) else (f"Systran/faster-distil-whisper-{model_id.replace('distil-', '')}" if "distil" in model_id else f"Systran/faster-whisper-{model_id}")
    custom_model_dir = os.path.join(os.getcwd(), download_root)
    target_folder = os.path.join(custom_model_dir, f"models--{repo_id.replace('/', '--')}")

    from ..ws_manager import manager
    
    async def _download_task():
        loop = asyncio.get_running_loop()
        monitor_active = True
        
        async def _monitor():
            try:
                while monitor_active:
                    current_size = await asyncio.to_thread(get_folder_size, target_folder)
                    mb_size = current_size / (1024 * 1024)
                    if model_id in global_downloading_models:
                        global_downloading_models[model_id]["downloaded_mb"] = round(mb_size, 1)
                    
                    msg = {"status": "processing", "step": "downloading", "model_id": model_id, "downloaded_mb": round(mb_size, 1)}
                    await manager.send_json(msg, f"sys_download_{model_id}")
                    await asyncio.sleep(1)
            except Exception: pass
                
        monitor_task = asyncio.create_task(_monitor())
        _background_tasks.add(monitor_task)
        monitor_task.add_done_callback(_background_tasks.discard)
        try:
            await loop.run_in_executor(None, lambda: snapshot_download(repo_id=repo_id, cache_dir=custom_model_dir, proxies=proxies, **token_kwargs))
            global_downloading_models.pop(model_id, None)
            await manager.send_json({"status": "completed", "step": "done", "model_id": model_id, "message": f"模型 {model_id} 下载完成！"}, f"sys_download_{model_id}")
        except Exception as e:
            global_downloading_models.pop(model_id, None)
            if os.path.exists(target_folder):
                try: shutil.rmtree(target_folder)
                except Exception: pass
            await manager.send_json({"status": "error", "model_id": model_id, "message": f"网络异常，下载中断: {str(e)}"}, f"sys_download_{model_id}")
        finally:
            monitor_active = False
            monitor_task.cancel()

    task = asyncio.create_task(_download_task())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {"message": "后台下载已启动", "model_id": model_id}

def get_download_status():
    return global_downloading_models

def _fetch_openai_models(api_key: str, base_url: str, filter_keywords=None):
    if not api_key: raise HTTPException(status_code=400, detail="请先填写 API Key")
    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.get(
                f"{base_url.strip().rstrip('/')}/models",
                headers={"accept": "application/json", "authorization": f"Bearer {api_key}"}
            )
            response.raise_for_status()
            data = response.json()
            model_ids = [m["id"] for m in data.get("data", []) if "id" in m]
            if filter_keywords:
                filtered = [m for m in model_ids if any(kw in m.lower() for kw in filter_keywords)]
                return filtered if filtered else model_ids
            return model_ids
    except httpx.HTTPStatusError as e: raise HTTPException(status_code=e.response.status_code, detail=f"获取失败: {e.response.text}")
    except Exception as e: raise HTTPException(status_code=400, detail=f"拉取模型列表异常: {str(e)}")

def get_llm_models(api_key: str, base_url: str):
    return _fetch_openai_models(api_key, base_url)

def get_local_llm_models():
    """扫描 models/llm/ 目录下的 .gguf 文件"""
    llm_dir = os.path.join(os.getcwd(), "models", "llm")
    if not os.path.exists(llm_dir):
        os.makedirs(llm_dir, exist_ok=True)
        return []
    
    models = []
    for f in os.listdir(llm_dir):
        if f.endswith(".gguf"):
            models.append(os.path.join("models", "llm", f))
    return sorted(models)

def get_asr_models(api_key: str, base_url: str):
    return _fetch_openai_models(api_key, base_url, filter_keywords=["whisper", "asr", "audio", "speech", "stt", "sensevoice", "paraformer"])