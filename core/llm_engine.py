import os
import gc
import sys
import traceback
from queue import Empty
from multiprocessing import Queue

try:
    from llama_cpp import Llama
except ImportError:
    Llama = None

def llm_worker_process_loop(task_queue: Queue, result_queue: Queue):
    """
    独立运行的 LLM 子进程循环。
    不断从 task_queue 获取任务。如果超过指定时间没有新任务（如父进程崩溃），自动退出释放显存。
    """
    model = None
    current_model_path = ""
    current_n_ctx = 0
    current_n_gpu_layers = 0
    current_idle_timeout = 300 # 默认超时 300 秒

    while True:
        try:
            # 动态兜底超时机制：比业务设定的卸载时间长 60 秒，作为父进程崩溃的防僵尸底线
            wait_time = (current_idle_timeout + 60) if model is not None else 300
            task = task_queue.get(timeout=wait_time)
            if task is None: 
                break
        except Empty:
            print(f"[LLM Worker] {wait_time} 秒兜底超时无任务响应，主动退出防僵尸并释放显存。")
            if model:
                del model
            sys.exit(0)

        # 任务指令分发
        if not isinstance(task, tuple):
            continue

        instruction = task[0]

        if instruction == "UNLOAD":
            if model is not None:
                del model
                model = None
                current_model_path = ""
                current_n_ctx = 0
                current_n_gpu_layers = 0
                current_idle_timeout = 300
                gc.collect()
                print("[*] 离线 LLM 模型已从显存中卸载。")
            result_queue.put({"type": "unloaded"})
            continue

        elif instruction == "RESET":
            if model is not None:
                print(f"[*] 正在手动重置本地 LLM 上下文缓存 (KV Cache)...")
                try:
                    model.reset()
                except Exception as e:
                    print(f"[!] 重置上下文缓存失败 (可能由于模型未就绪): {e}")
            result_queue.put({"type": "reset_done"})
            continue

        elif instruction == "CHAT":
            req_id, model_path, messages, temperature, max_tokens, n_gpu_layers, n_ctx, idle_timeout = task[1:]
            
            # 动态同步防僵尸时间
            current_idle_timeout = idle_timeout
            
            if Llama is None:
                result_queue.put({
                    "req_id": req_id, 
                    "type": "error", 
                    "error": "未安装 llama-cpp-python，无法使用本地推理功能。"
                })
                continue

            if not os.path.exists(model_path):
                result_queue.put({
                    "req_id": req_id, 
                    "type": "error", 
                    "error": f"找不到本地模型文件: {model_path}"
                })
                continue

            try:
                # 检查是否需要重新加载模型
                if model is None or \
                   current_model_path != model_path or \
                   current_n_ctx != n_ctx or \
                   current_n_gpu_layers != n_gpu_layers:
                    
                    if model is not None:
                        del model
                        model = None
                        gc.collect()
                        
                    print(f"[*] 正在加载本地 LLM 模型: {model_path} (GPU Layers: {n_gpu_layers}, Context: {n_ctx})...")
                    model = Llama(
                        model_path=model_path,
                        n_gpu_layers=n_gpu_layers,
                        n_ctx=n_ctx,
                        verbose=False
                    )
                    current_model_path = model_path
                    current_n_ctx = n_ctx
                    current_n_gpu_layers = n_gpu_layers

                # 执行推理
                response = model.create_chat_completion(
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens
                )
                
                result_queue.put({
                    "req_id": req_id,
                    "type": "chat_done",
                    "response": response
                })
                
            except Exception as e:
                traceback.print_exc()
                result_queue.put({
                    "req_id": req_id,
                    "type": "error",
                    "error": str(e)
                })
