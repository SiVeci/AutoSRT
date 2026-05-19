import os
import time
import asyncio
import threading
import uuid
from typing import Optional, List, Dict, Any
from multiprocessing import Process, Queue
from queue import Empty
from core.llm_engine import llm_worker_process_loop

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
        self.idle_timer: Optional[asyncio.TimerHandle] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        
        self.llm_process: Optional[Process] = None
        self.llm_task_queue: Optional[Queue] = None
        self.llm_result_queue: Optional[Queue] = None
        
        # 结果等待字典，用于将子进程吐出的结果分发回对应的协程
        self._pending_requests = {}
        
        self._initialized = True

    def ensure_llm_worker_running(self):
        if self.llm_process is None or not self.llm_process.is_alive():
            print("[进程管理] 启动新的 LLM 推理子进程...")
            self.llm_task_queue = Queue()
            self.llm_result_queue = Queue()
            self.llm_process = Process(
                target=llm_worker_process_loop, 
                args=(self.llm_task_queue, self.llm_result_queue), 
                daemon=True
            )
            self.llm_process.start()
            
            # 如果已有循环，启动队列轮询监听器
            if self.loop and self.loop.is_running():
                self.loop.create_task(self._poll_results())

    async def _poll_results(self):
        """异步持续轮询子进程返回的结果，并分发给等待的协程"""
        while self.llm_process and self.llm_process.is_alive():
            try:
                # 使用 run_in_executor 避免阻塞主循环
                msg = await self.loop.run_in_executor(None, self.llm_result_queue.get, True, 0.5)
                if isinstance(msg, dict):
                    msg_type = msg.get("type")
                    req_id = msg.get("req_id")
                    
                    if req_id and req_id in self._pending_requests:
                        future = self._pending_requests[req_id]
                        if not future.done():
                            if msg_type == "error":
                                future.set_exception(Exception(msg.get("error")))
                            else:
                                future.set_result(msg)
                    elif msg_type == "unloaded" and "UNLOAD" in self._pending_requests:
                        future = self._pending_requests["UNLOAD"]
                        if not future.done():
                            future.set_result(True)
                    elif msg_type == "reset_done" and "RESET" in self._pending_requests:
                        future = self._pending_requests["RESET"]
                        if not future.done():
                            future.set_result(True)
            except Empty:
                await asyncio.sleep(0) # 让出控制权
            except Exception as e:
                print(f"[LLM Agent] 轮询异常: {e}")
                await asyncio.sleep(1)

    def _reset_idle_timer(self, timeout: int):
        if self.idle_timer:
            self.idle_timer.cancel()
        
        if self.loop and timeout > 0:
            self.idle_timer = self.loop.call_later(timeout, lambda: self.loop.create_task(self.async_release_model()))

    async def async_release_model(self):
        """异步安全释放模型：向子进程发送卸载指令"""
        if self.llm_process and self.llm_process.is_alive() and self.llm_task_queue:
            if not self.loop:
                self.loop = asyncio.get_running_loop()
            
            future = self.loop.create_future()
            self._pending_requests["UNLOAD"] = future
            self.llm_task_queue.put(("UNLOAD",))
            
            try:
                # 等待卸载完成，最多等 10 秒
                await asyncio.wait_for(future, timeout=10.0)
            except asyncio.TimeoutError:
                print("[!] 等待 LLM 子进程释放模型超时。")
            finally:
                self._pending_requests.pop("UNLOAD", None)
                if self.idle_timer:
                    self.idle_timer.cancel()
                    self.idle_timer = None

    def reset_context(self):
        """向子进程发送重置指令"""
        if self.llm_process and self.llm_process.is_alive() and self.llm_task_queue:
            if not self.loop:
                return # 同步上下文中暂不强制等待重置
            future = self.loop.create_future()
            self._pending_requests["RESET"] = future
            self.llm_task_queue.put(("RESET",))
            # 采用即发即弃策略，不阻塞等待

    async def chat_completion(self, 
                               model_path: str, 
                               messages: List[Dict[str, str]], 
                               temperature: float = 0.7, 
                               max_tokens: int = 2048,
                               n_gpu_layers: int = -1,
                               n_ctx: int = 4096,
                               idle_timeout: int = 300) -> Dict[str, Any]:
        
        self.loop = asyncio.get_running_loop()
        self.ensure_llm_worker_running()
        
        if self.idle_timer:
            self.idle_timer.cancel()

        req_id = str(uuid.uuid4())
        future = self.loop.create_future()
        self._pending_requests[req_id] = future

        try:
            self.llm_task_queue.put((
                "CHAT", 
                req_id, 
                model_path, 
                messages, 
                temperature, 
                max_tokens, 
                n_gpu_layers, 
                n_ctx,
                idle_timeout
            ))
            
            # 等待子进程返回结果
            result = await future
            return result.get("response")
            
        finally:
            self._pending_requests.pop(req_id, None)
            self._reset_idle_timer(idle_timeout)

# Global singleton
llm_manager = LocalLLMManager()