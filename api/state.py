import asyncio
import os
import json

# 任务队列
q_extract = asyncio.Queue()
q_transcribe = asyncio.Queue()
q_translate = asyncio.Queue()

# 全局任务状态字典 (内存缓存)
# key: task_id, value: {"steps": [...], "current_step": "...", "config": {...}}
global_tasks_status: dict[str, dict] = {}

# 全局下载模型状态字典
global_downloading_models: dict[str, dict] = {}

# 全局媒体库发现列表
# key: fingerprint, value: {"path": "...", "size": 0, "mtime": 0, "status": "new/imported"}
global_library_discoveries: dict[str, dict] = {}

# 全局取消事件字典 (用于手动中断任务)
global_cancel_events: dict[str, asyncio.Event] = {}

# 全局显存互斥锁 (用于保护本地 LLM 和 本地 Whisper)
gpu_lock = asyncio.Lock()

WORKSPACE_DIR = os.path.abspath(os.path.join(os.getcwd(), "workspace"))

# 终结态集合：进入这些状态的任务不再需要保留在内存中
# get_task_status() 会从磁盘 state.json 回退读取，所以清理后功能无损
TERMINAL_STATES = {"completed", "error", "cancelled"}

async def get_task_status(task_id: str) -> dict:
    """获取任务状态（优先从内存读取，否则从 state.json 读取）"""
    if task_id in global_tasks_status:
        return global_tasks_status[task_id]
    
    state_path = os.path.join(WORKSPACE_DIR, task_id, "state.json")
    if os.path.exists(state_path):
        try:
            def _read():
                with open(state_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            data = await asyncio.to_thread(_read)
            global_tasks_status[task_id] = data
            return data
        except Exception:
            pass
    return {}

async def update_task_status(task_id: str, status_data: dict):
    """更新任务状态并实时持久化到磁盘"""
    if task_id not in global_tasks_status:
        await get_task_status(task_id)
        
    if task_id in global_tasks_status:
        global_tasks_status[task_id].update(status_data)
    else:
        global_tasks_status[task_id] = status_data
        
    # 持久化到磁盘
    state_dir = os.path.join(WORKSPACE_DIR, task_id)
    if not os.path.exists(state_dir):
        os.makedirs(state_dir, exist_ok=True)
    
    state_path = os.path.join(state_dir, "state.json")
    def _write():
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(global_tasks_status[task_id], f, ensure_ascii=False, indent=2)
    await asyncio.to_thread(_write)
    
    current_step = status_data.get("current_step")
    if current_step in TERMINAL_STATES:
        global_tasks_status.pop(task_id, None)
        global_cancel_events.pop(task_id, None)
        print(f"[内存回收] 任务 {task_id} 已进入终结态 ({current_step})，内存缓存已释放")

def delete_task_status(task_id: str):
    """清理内存中的任务状态缓存"""
    global_tasks_status.pop(task_id, None)

def is_local_asr(t_state: dict) -> bool:
    """判定任务是否使用本地识别引擎"""
    config = t_state.get("config") or {}
    trans_settings = config.get("transcribe_settings")

    # 如果识别引擎明确是 api，那它绝对不是本地识别
    if isinstance(trans_settings, dict) and trans_settings.get("engine") == "api":
        return False

    # 只有当包含 transcribe 步骤，且引擎不是 api 时，才视为本地识别
    steps = t_state.get("steps") or config.get("steps") or []
    if "transcribe" in steps:
        # 兜底：如果 trans_settings 缺失或没有 engine，默认视为本地
        engine = (trans_settings or {}).get("engine", "local")
        return engine != "api"
    return False

def is_local_llm(t_state: dict) -> bool:
    """判定任务是否使用本地翻译引擎"""
    config = t_state.get("config") or {}
    llm_settings = config.get("llm_settings")

    # 如果翻译引擎明确是 local，判定为本地
    if isinstance(llm_settings, dict) and llm_settings.get("engine") == "local":
        # 还需要确认包含 translate 步骤
        steps = t_state.get("steps") or config.get("steps") or []
        return "translate" in steps
    return False
