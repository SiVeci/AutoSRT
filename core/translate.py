import os
import re
import time
import httpx
import asyncio
import traceback
import openai
from openai import AsyncOpenAI, APIStatusError, APIConnectionError

from core.local_llm_manager import llm_manager

DEFAULT_SYSTEM_PROMPT = """### 🎯 风格要求：
1. **自然流畅**：符合目标语言母语者的表达习惯。
2. **专业严谨**：准确翻译专有名词和术语。
3. **结合语境**：根据前后文调整语气和用词。"""

def parse_srt(content: str) -> list:
    """
    将 SRT 内容解析为独立的字幕块列表
    """
    content = content.replace('\r\n', '\n').replace('\r', '\n')
    blocks = content.split('\n\n')
    return [b.strip() for b in blocks if b.strip()]

class LocalClient:
    def __init__(self, model_path, n_gpu_layers, n_ctx, idle_timeout):
        self.model_path = model_path
        self.n_gpu_layers = n_gpu_layers
        self.n_ctx = n_ctx
        self.idle_timeout = idle_timeout
        self.chat = self.Chat(self)

    class Chat:
        def __init__(self, parent):
            self.completions = self.Completions(parent)

        class Completions:
            def __init__(self, parent):
                self.parent = parent

            async def create(self, model, messages, temperature, max_tokens, stream=False):
                # model parameter is ignored for local, using config's model_path
                resp = await llm_manager.chat_completion(
                    model_path=self.parent.model_path,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    n_gpu_layers=self.parent.n_gpu_layers,
                    n_ctx=self.parent.n_ctx,
                    idle_timeout=self.parent.idle_timeout
                )
                
                # Wrap response in a SimpleNamespace-like object to mimic OpenAI's Response object
                from types import SimpleNamespace
                
                choice = SimpleNamespace(
                    message=SimpleNamespace(content=resp['choices'][0]['message']['content']),
                    finish_reason=resp['choices'][0]['finish_reason']
                )
                return SimpleNamespace(choices=[choice])

async def translate_batch(client, model_name, system_prompt, batch_content, batch_index, total_batches, semaphore, progress_state, previous_context="", progress_callback=None, temperature=1.0, max_tokens=8192, cancel_event=None):
    """
    发送单个分块进行翻译 (异步并发)
    """
    async with semaphore:
        text_to_translate = "\n\n".join(batch_content)
        user_content = text_to_translate
        
        if previous_context:
            user_content = f"【以下是上一段原文结尾，仅供上下文衔接参考，🚫禁止翻译该部分🚫】：\n{previous_context}\n\n====================\n\n【👇请严格按照原格式，正式翻译以下字幕片段👇】：\n{text_to_translate}"

        try:
            api_task = asyncio.create_task(
                client.chat.completions.create(
                    model=model_name,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_content}
                    ],
                    temperature=temperature,
                    max_tokens=max_tokens,
                    stream=False
                )
            )

            if cancel_event:
                cancel_task = asyncio.create_task(cancel_event.wait())
                try:
                    done, pending = await asyncio.wait(
                        [api_task, cancel_task], 
                        return_when=asyncio.FIRST_COMPLETED
                    )
                    for p in pending:
                        p.cancel()
                    if cancel_task in done:
                        raise asyncio.CancelledError()
                    completion = api_task.result()
                except asyncio.CancelledError:
                    api_task.cancel()
                    cancel_task.cancel()
                    raise
            else:
                try:
                    completion = await api_task
                except asyncio.CancelledError:
                    api_task.cancel()
                    raise

            if not completion.choices:
                raise Exception(f"大模型未返回任何 choices。响应: {completion}")
                
            choice = completion.choices[0]
            if choice.finish_reason == 'length':
                raise Exception(f"大模型生成的上下文长度超出限制 (max_tokens 耗尽)。【原因】：可能是翻译文本过长，或者你使用的是带深度思考 (Reasoning) 的模型，思考过程耗尽了配额。请尝试在设置中调低「翻译批次大小 (Batch Size)」，或适当调大 max_tokens 的值。")
                
            if not choice.message.content:
                raise Exception(f"大模型返回了空内容或遇到了安全拦截。响应: {completion}")
                
            translated_text = choice.message.content
            translated_text = re.sub(r'<think>.*?</think>', '', translated_text, flags=re.DOTALL)
            translated_text = translated_text.replace("```srt", "").replace("```", "").strip()
            
            progress_state["completed"] += 1
            msg = f"⚡ 正在全速并发翻译中... (已完成 {progress_state['completed']}/{total_batches} 批)"
            
            if progress_callback:
                progress_callback(msg)
            else:
                print(f"   {msg}")
                
            parsed_blocks = []
            # 回退：宽容的正则解析方案
            blocks = translated_text.replace('\r\n', '\n').replace('\r', '\n').split('\n\n')
            for block in blocks:
                lines = block.strip().split('\n')
                if len(lines) >= 3:
                    # 宽容的正则：允许缺位、允许 . 和 , 混用
                    time_match = re.search(r"(\d{1,2}:\d{1,2}:\d{1,2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{1,2}:\d{1,2}[,.]\d{1,3})", lines[1])
                    if time_match:
                        start = time_match.group(1).replace('.', ',')
                        end = time_match.group(2).replace('.', ',')
                        
                        # 补齐不足的位数 (简单的规整逻辑)
                        def normalize_time(t_str):
                            parts = t_str.split(',')
                            main_time = parts[0]
                            ms = parts[1] if len(parts) > 1 else "000"
                            ms = ms.ljust(3, '0')
                            time_parts = main_time.split(':')
                            time_parts = [p.zfill(2) for p in time_parts]
                            return f"{':'.join(time_parts)},{ms}"
                            
                        start = normalize_time(start)
                        end = normalize_time(end)
                        
                        text = "\n".join(lines[2:])
                        parsed_blocks.append((start, end, text))
                        
            if not parsed_blocks:
                parsed_blocks = translated_text
                
            return (batch_index, parsed_blocks, batch_content)

        except Exception as e:
            if isinstance(e, APIStatusError):
                error_message = f"❌ 第 {batch_index} 批次大模型 API 返回状态错误 (HTTP Status: {e.status_code})！\n"
                error_message += f"   - 错误详情 (Response): {e.response.text}\n"
                print(error_message)
                if progress_callback: progress_callback(error_message)
                raise Exception(error_message)
                
            elif isinstance(e, APIConnectionError):
                error_message = f"❌ 第 {batch_index} 批次无法连接到大模型 API 服务器！请检查网络或代理设置。\n   - 错误根源: {e.__cause__}\n"
                print(error_message)
                if progress_callback: progress_callback(error_message)
                raise Exception(error_message)
                
            else:
                error_msg = f"❌ 第 {batch_index} 批次翻译发生未知错误: {e}"
                print(error_msg)
                traceback.print_exc()
                if progress_callback: progress_callback(error_msg)
                raise Exception(f"大模型接口请求失败: {e}")

async def run_llm_translation(
    input_srt_path: str, 
    output_srt_path: str, 
    llm_config: dict, 
    system_config: dict,
    progress_callback=None,
    cancel_event: asyncio.Event = None
):
    """
    执行 LLM 翻译任务的核心调度函数。
    """
    api_key = llm_config.get("api_key", "").strip()
    base_url = llm_config.get("base_url", "https://api.openai.com/v1").strip()
    model_name = llm_config.get("model_name", "Pro/deepseek-ai/DeepSeek-V3.2").strip()
    target_language_code = llm_config.get("target_language", "zh").strip()
    batch_size = llm_config.get("batch_size", 50)
    concurrent_workers = llm_config.get("concurrent_workers", 3)
    use_proxy = llm_config.get("use_network_proxy", False)
    enable_global_proxy = system_config.get("enable_global_proxy", False)
    proxy_url = system_config.get("network_proxy", "")
    
    actual_use_proxy = enable_global_proxy and use_proxy and proxy_url
    
    from api.services.config_service import SUPPORTED_LANGUAGES
    lang_name = SUPPORTED_LANGUAGES.get(target_language_code, target_language_code).capitalize()

    fixed_role_and_lang = f"你是一位精通各国文化的专业影视字幕翻译。\n任务：将用户提供的 SRT 字幕片段翻译成【{lang_name}】。\n\n"
    fixed_format_instructions = """### 🚫 格式死命令：
1. **保留原文结构**：这是字幕片段，不要合并，不要遗漏。
2. **保留时间轴**：所有时间戳（如 00:00:01,000 --> ...）必须原样保留，不得修改。
3. **只输出结果**：不要加“好的”、“片段翻译如下”等废话，直接输出 SRT 格式文本。

"""

    custom_style_prompt = llm_config.get("system_prompt", "").strip()
    if not custom_style_prompt:
        custom_style_prompt = DEFAULT_SYSTEM_PROMPT
        
    full_system_prompt = fixed_role_and_lang + fixed_format_instructions + custom_style_prompt

    engine = llm_config.get("engine", "api")
    
    if engine == "local":
        local_cfg = llm_config.get("local_settings", {})
        model_path = local_cfg.get("model_path", "")
        if not model_path:
            raise ValueError("未配置本地模型路径，请先在设置中选择模型文件。")
        
        # 本地引擎强制并发为 1 以防显存溢出
        concurrent_workers = 1
        client = LocalClient(
            model_path=model_path,
            n_gpu_layers=local_cfg.get("n_gpu_layers", -1),
            n_ctx=local_cfg.get("n_ctx", 4096),
            idle_timeout=local_cfg.get("idle_timeout", 300)
        )
    else:
        if not api_key:
            raise ValueError("缺少大模型 API Key，请先在设置中配置。")

        if not base_url:
            base_url = "https://api.openai.com/v1"

        # 提取用户配置的超时时间，并做下限防呆保护
        timeout_cfg = llm_config.get("timeout_settings", {})
        try:
            user_connect = max(float(timeout_cfg.get("connect", 10.0)), 3.0)
            user_read = max(float(timeout_cfg.get("read", 120.0)), 30.0)
        except (TypeError, ValueError):
            user_connect, user_read = 10.0, 120.0
            
        # 组装精细化的 httpx Timeout 控制器
        timeout_config = httpx.Timeout(connect=user_connect, read=user_read, write=20.0, pool=10.0)

        client_params = {
            "api_key": api_key, 
            "base_url": base_url,
            "max_retries": 2
        }
        if actual_use_proxy:
            client_params["http_client"] = httpx.AsyncClient(proxy=proxy_url, timeout=timeout_config)
        else:
            client_params["http_client"] = httpx.AsyncClient(proxy=None, trust_env=False, timeout=timeout_config)

        client = AsyncOpenAI(**client_params)

    try:
        if progress_callback:
            progress_callback("📖 正在读取并解析原生字幕...")

        with open(input_srt_path, "r", encoding="utf-8") as f:
            full_content = f.read()
        
        srt_blocks = parse_srt(full_content)
        total_blocks = len(srt_blocks)
        
        if total_blocks == 0:
            raise ValueError("未检测到任何有效字幕块，请检查字幕文件内容。")

        msg = f"📊 共解析到 {total_blocks} 条字幕，准备分批请求模型..."
        if progress_callback:
            progress_callback(msg)
        else:
            print(msg)

        with open(output_srt_path, "w", encoding="utf-8") as f:
            f.write("")

        success_count = 0
        total_batches = (total_blocks + batch_size - 1) // batch_size
        
        semaphore = asyncio.Semaphore(concurrent_workers)
        progress_state = {"completed": 0}
        tasks = []
        
        for i in range(0, total_blocks, batch_size):
            if cancel_event and cancel_event.is_set():
                if progress_callback:
                    progress_callback("⚠️ 检测到取消请求，正在终止翻译操作...")
                raise asyncio.CancelledError()

            batch = srt_blocks[i : i + batch_size]
            current_batch_num = (i // batch_size) + 1
            
            prev_context = ""
            if i > 0:
                prev_batch = srt_blocks[max(0, i - 3) : i]
                prev_context = "\n\n".join(prev_batch)
            
            tasks.append(
                translate_batch(
                    client=client, 
                    model_name=model_name, 
                    system_prompt=full_system_prompt, 
                    batch_content=batch, 
                    batch_index=current_batch_num, 
                    total_batches=total_batches,
                    semaphore=semaphore,
                    progress_state=progress_state,
                    previous_context=prev_context,
                    progress_callback=progress_callback,
                    temperature=float(llm_config.get("temperature", 1.0)),
                    max_tokens=int(llm_config.get("max_tokens", 8192)),
                    cancel_event=cancel_event
                )
            )
            
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        for res in results:
            if isinstance(res, BaseException):
                raise res
        
        # 按 batch_index 排序确保写入顺序正确
        results.sort(key=lambda x: x[0])
        
        current_global_idx = 1
        
        for idx, parsed_blocks, original_batch in results:
            if isinstance(parsed_blocks, list):
                with open(output_srt_path, "a", encoding="utf-8") as f:
                    for i, block in enumerate(parsed_blocks):
                        start, end, text = block
                        # 强制对齐: 如果数量一致，强制使用原视频时间轴，防格式雪崩
                        if len(parsed_blocks) == len(original_batch):
                            orig_match = re.search(r"(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})", original_batch[i])
                            if orig_match:
                                start, end = orig_match.group(1), orig_match.group(2)
                                
                        f.write(f"{current_global_idx}\n{start} --> {end}\n{text}\n\n")
                        current_global_idx += 1
                success_count += len(parsed_blocks)
            else:
                # 极端后备: 直接写入文本
                with open(output_srt_path, "a", encoding="utf-8") as f:
                    f.write(parsed_blocks + "\n\n")

        finish_msg = f"🎉 翻译完毕！共成功处理 {success_count}/{total_blocks} 条字幕。"
        if progress_callback:
            progress_callback(finish_msg)
        else:
            print(finish_msg)
            
    finally:
        # [内存/句柄泄漏修复] 强制关闭并清理底层的 AsyncClient
        try:
            await client_params["http_client"].aclose()
        except Exception:
            pass

if __name__ == "__main__":
    print("本脚本已重构为通用核心模块，请通过 WebUI 工作流或主程序调用。")