import os
import time
import asyncio
import threading
import gc
from typing import Optional, List, Dict, Any

try:
    from llama_cpp import Llama
except ImportError:
    Llama = None

class LocalLLMManager:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(LocalLLMManager, cls).__new__(cls)
                cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self.model: Optional[Llama] = None
        self.current_model_path: str = ""
        self.current_n_ctx: int = 0
        self.current_n_gpu_layers: int = 0
        self.idle_timer: Optional[asyncio.TimerHandle] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._inference_lock = threading.Lock()
        self._load_lock = asyncio.Lock()
        self._initialized = True

    def _reset_idle_timer(self, timeout: int):
        if self.idle_timer:
            self.idle_timer.cancel()
        
        if self.loop and timeout > 0:
            self.idle_timer = self.loop.call_later(timeout, self.release_model)

    def release_model(self):
        if self.model:
            print(f"[*] 离线 LLM 模型已超过闲置时间，正在释放显存: {self.current_model_path}")
            # llama-cpp-python release
            del self.model
            self.model = None
            self.current_model_path = ""
            self.current_n_ctx = 0
            self.current_n_gpu_layers = 0
            gc.collect()
            # If using CUDA, we might need to clear cache if possible, 
            # but usually gc.collect() + deleting the object is enough for llama-cpp.
        
        if self.idle_timer:
            self.idle_timer.cancel()
            self.idle_timer = None

    def reset_context(self):
        """显式重置本地 LLM 的上下文缓存 (KV Cache)，确保新任务开始时无残留"""
        if self.model:
            print(f"[*] 正在手动重置本地 LLM 上下文缓存 (KV Cache)...")
            try:
                self.model.reset()
            except Exception as e:
                print(f"[!] 重置上下文缓存失败 (可能由于模型未就绪): {e}")

    async def async_release_model(self):
        """异步安全释放模型：确保当前没有正在执行的推理孤儿线程后再释放，防止段错误或 OOM"""
        def _safe_release():
            with self._inference_lock:
                self.release_model()
        await asyncio.to_thread(_safe_release)

    async def get_model(self, model_path: str, n_gpu_layers: int = -1, n_ctx: int = 4096) -> Llama:
        if Llama is None:
            raise ImportError("未安装 llama-cpp-python，无法使用本地推理功能。")

        if not os.path.exists(model_path):
            raise FileNotFoundError(f"找不到本地模型文件: {model_path}")

        async with self._load_lock:
            if self.model and \
               self.current_model_path == model_path and \
               self.current_n_ctx == n_ctx and \
               self.current_n_gpu_layers == n_gpu_layers:
                return self.model

            # If parameters change or a different model is requested, release first
            if self.model:
                self.release_model()

            print(f"[*] 正在加载本地 LLM 模型: {model_path} (GPU Layers: {n_gpu_layers}, Context: {n_ctx})...")
            
            # In a separate thread to not block event loop
            def load():
                return Llama(
                    model_path=model_path,
                    n_gpu_layers=n_gpu_layers,
                    n_ctx=n_ctx,
                    verbose=False
                )
            
            self.model = await asyncio.to_thread(load)
            self.current_model_path = model_path
            self.current_n_ctx = n_ctx
            self.current_n_gpu_layers = n_gpu_layers
            return self.model

    async def chat_completion(self, 
                               model_path: str, 
                               messages: List[Dict[str, str]], 
                               temperature: float = 0.7, 
                               max_tokens: int = 2048,
                               n_gpu_layers: int = -1,
                               n_ctx: int = 4096,
                               idle_timeout: int = 300) -> Dict[str, Any]:
        
        self.loop = asyncio.get_running_loop()
        model = await self.get_model(model_path, n_gpu_layers, n_ctx)
        
        # Reset idle timer before starting work
        if self.idle_timer:
            self.idle_timer.cancel()

        try:
            # chat completion
            def run():
                with self._inference_lock:
                    return model.create_chat_completion(
                        messages=messages,
                        temperature=temperature,
                        max_tokens=max_tokens
                    )
            
            response = await asyncio.to_thread(run)
            return response
        finally:
            # Start/Reset idle timer after work
            self._reset_idle_timer(idle_timeout)

# Global singleton
llm_manager = LocalLLMManager()
