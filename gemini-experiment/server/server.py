"""
Gemini Translation Server
FastAPI server for HTML-aware translation using Google Gemini API with streaming support.
"""

import asyncio
import hashlib
import json
import os
import socket
import time
import uuid
from collections import OrderedDict
from typing import Any, AsyncGenerator, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

load_dotenv()

app = FastAPI(title="Gemini Translation Server")

# Configuration
MAX_RETRIES, RETRY_DELAY, CACHE_MAX_SIZE, CACHE_TTL = 2, 0.5, 2000, 3600

# Gemini Client
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


# ============================================================================
# LRU CACHE
# ============================================================================
class TranslationCache:
    def __init__(self, max_size: int = CACHE_MAX_SIZE, ttl: int = CACHE_TTL):
        self.max_size, self.ttl = max_size, ttl
        self._cache: OrderedDict = OrderedDict()
        self._lock = asyncio.Lock()

    def _key(self, texts: List[str], lang: str, model: str) -> str:
        return hashlib.sha256(
            json.dumps({"t": texts, "l": lang, "m": model}, sort_keys=True).encode()
        ).hexdigest()

    async def get(self, texts: List[str], lang: str, model: str) -> Optional[List[str]]:
        key = self._key(texts, lang, model)
        async with self._lock:
            if key in self._cache:
                entry = self._cache[key]
                if time.time() - entry["ts"] < self.ttl:
                    self._cache.move_to_end(key)
                    return entry["data"]
                del self._cache[key]
        return None

    async def set(
        self, texts: List[str], lang: str, model: str, translations: List[str]
    ):
        key = self._key(texts, lang, model)
        async with self._lock:
            self._cache[key] = {"data": translations, "ts": time.time()}
            self._cache.move_to_end(key)
            while len(self._cache) > self.max_size:
                self._cache.popitem(last=False)

    async def stats(self) -> Dict:
        async with self._lock:
            return {"size": len(self._cache), "max_size": self.max_size}


cache = TranslationCache()


# ============================================================================
# RATE LIMITER
# ============================================================================
class RateLimiter:
    def __init__(self, rpm: int = 60, burst: int = 10):
        self.rate, self.burst = rpm / 60.0, burst
        self._tokens: Dict[str, float] = {}
        self._last: Dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, client: str = "global") -> tuple[bool, float]:
        async with self._lock:
            now = time.time()
            if client not in self._tokens:
                self._tokens[client], self._last[client] = self.burst, now
            elapsed = now - self._last[client]
            self._tokens[client] = min(
                self.burst, self._tokens[client] + elapsed * self.rate
            )
            self._last[client] = now
            if self._tokens[client] >= 1:
                self._tokens[client] -= 1
                return True, 0
            return False, (1 - self._tokens[client]) / self.rate


limiter = RateLimiter()




# ============================================================================
# STREAMING JSON PARSER
# ============================================================================


class StreamingJSONParser:
    """Simple streaming JSON array parser."""
    
    def __init__(self):
        self.buffer = ""
        self.in_array = False

    def feed(self, chunk: str) -> List[str]:
        self.buffer += chunk
        items = []
        if not self.in_array:
            idx = self.buffer.find("[")
            if idx != -1:
                self.in_array = True
                self.buffer = self.buffer[idx + 1 :]
            else:
                return items

        while self.buffer:
            self.buffer = self.buffer.lstrip()
            if not self.buffer or self.buffer.startswith("]"):
                break
            if self.buffer.startswith(","):
                self.buffer = self.buffer[1:].lstrip()
                continue
            if self.buffer.startswith('"'):
                item, remaining = self._parse_string()
                if item is not None:
                    items.append(item)
                    self.buffer = remaining
                else:
                    break
            else:
                break
        return items

    def _parse_string(self) -> tuple[Optional[str], str]:
        if not self.buffer.startswith('"'):
            return None, self.buffer
        i = 1
        while i < len(self.buffer):
            if self.buffer[i] == "\\":
                i += 2
                continue
            if self.buffer[i] == '"':
                try:
                    return json.loads(self.buffer[: i + 1]), self.buffer[i + 1 :]
                except json.JSONDecodeError:
                    return None, self.buffer
            i += 1
        return None, self.buffer


# ============================================================================
# PROMPTS
# ============================================================================
def get_translation_prompt(lang: str) -> str:
    return f"""You are a professional HTML-aware translator.
Translate the JSON array of HTML fragments into {lang}.
RULES:
1. Translate TEXT CONTENT to {lang}, PRESERVE HTML tags in relative positions.
2. DO NOT translate HTML attributes (href, src, style, color, class, id).
3. PRESERVE all HTML tags exactly (<b>, <i>, <font>, <span>, <a>, <br>, etc.).
4. Maintain exact array length and order.
5. Return ONLY valid JSON array, no markdown blocks.
6. Escape quotes properly in JSON strings.
Return ONLY the JSON array."""




# ============================================================================
# GEMINI API CALLS
# ============================================================================
async def call_gemini(
    model: str,
    contents: list,
    config: types.GenerateContentConfig,
    expected_len: Optional[int] = None,
    validate_json: bool = True,
    instance_id: str = "",
) -> tuple[Optional[str], bool, Any]:
    loop = asyncio.get_event_loop()
    response_text, usage = None, None
    max_attempts = MAX_RETRIES + 1 if validate_json else 1

    for attempt in range(max_attempts):
        try:
            if attempt > 0:
                await asyncio.sleep(RETRY_DELAY)
                contents = contents.copy()
                contents.append(
                    types.Content(role="model", parts=[types.Part(text=response_text)])
                )
                contents.append(
                    types.Content(
                        role="user",
                        parts=[
                            types.Part(
                                text="Invalid JSON. Return ONLY a valid JSON array."
                            )
                        ],
                    )
                )

            response = await loop.run_in_executor(
                None,
                lambda: client.models.generate_content(
                    model=model, contents=contents, config=config
                ),
            )
            response_text = response.text
            usage = response.usage_metadata

            # Log token usage
            if usage:
                log_tokens(instance_id, usage)

            if not validate_json:
                return response_text, True, usage

            if response_text:
                parsed = json.loads(response_text)
                if isinstance(parsed, list) and (
                    expected_len is None or len(parsed) == expected_len
                ):
                    return response_text, True, usage
        except json.JSONDecodeError:
            if attempt == max_attempts - 1:
                return response_text, False, usage
    return response_text, False, usage


async def call_gemini_streaming(
    model: str,
    contents: list,
    config: types.GenerateContentConfig,
    instance_id: str = "",
) -> AsyncGenerator[tuple[str, Any], None]:
    """Yields (text_chunk, final_usage) - final_usage is only set on last chunk"""
    loop = asyncio.get_event_loop()
    stream = await loop.run_in_executor(
        None,
        lambda: client.models.generate_content_stream(
            model=model, contents=contents, config=config
        ),
    )

    final_usage = None
    for chunk in stream:
        # Capture usage from each chunk (last one will have final totals)
        if hasattr(chunk, "usage_metadata") and chunk.usage_metadata:
            final_usage = chunk.usage_metadata
        if chunk.text:
            yield chunk.text, None
    
    # Yield final usage after stream completes
    if final_usage:
        yield "", final_usage


# ============================================================================
# CORS & MODELS
# ============================================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TranslateRequest(BaseModel):
    messages: List[Dict[str, str]] = Field(..., description="Chat messages")
    model: str = Field(default="gemini-2.0-flash")
    temperature: float = Field(default=0.3)
    target_language: Optional[str] = Field(default=None)
    html_aware: bool = Field(default=False)
    stream: bool = Field(default=False)


# ============================================================================
# ENDPOINTS
# ============================================================================
@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/stats")
async def stats():
    return {"status": "ok", "cache": await cache.stats()}


async def stream_translations(
    request: TranslateRequest,
    texts: List[str],
    contents: list,
    config: types.GenerateContentConfig,
    instance_id: str,
    start_time: float,
) -> AsyncGenerator[str, None]:
    try:
        parser = StreamingJSONParser()
        all_translations = []
        final_usage = None
        
        async for chunk_text, usage in call_gemini_streaming(
            request.model, contents, config, instance_id
        ):
            if usage:
                final_usage = usage
            if chunk_text:
                for item in parser.feed(chunk_text):
                    all_translations.append(item)
                    yield f"data: {json.dumps({'index': len(all_translations) - 1, 'translation': item})}\n\n"
        
        # Log token summary once at the end
        if final_usage:
            log_tokens(instance_id, final_usage)
        
        if texts and len(all_translations) == len(texts):
            await cache.set(
                texts,
                request.target_language or "English",
                request.model,
                all_translations,
            )
            log_response(
                instance_id, len(all_translations), (time.time() - start_time) * 1000
            )
        yield f"data: {json.dumps({'done': True, 'total': len(all_translations)})}\n\n"
    except Exception as e:
        log_error(instance_id, "STREAM_ERROR", str(e))
        yield f"data: {json.dumps({'error': {'type': 'UNKNOWN_ERROR', 'message': str(e)}})}\n\n"


@app.post("/proxy/translate")
async def translate(request: TranslateRequest, req: Request):
    instance_id = str(uuid.uuid4())[:8]
    client_ip = req.client.host if req.client else "unknown"
    start_time = time.time()
    target_lang = request.target_language or "English"

    # Rate limit
    allowed, wait = await limiter.acquire(client_ip)
    if not allowed:
        log_error(instance_id, "RATE_LIMITED", f"Wait {wait:.1f}s")
        return JSONResponse(
            status_code=429,
            content={
                "error": {
                    "message": f"Rate limited. Wait {wait:.1f}s",
                    "retry_after": wait,
                }
            },
        )

    try:
        # Extract user content
        user_content = next(
            (m.get("content", "") for m in request.messages if m.get("role") == "user"),
            None,
        )
        texts_to_translate = None

        if user_content and request.html_aware:
            try:
                texts_to_translate = json.loads(user_content)
                if isinstance(texts_to_translate, list):
                    cached = await cache.get(
                        texts_to_translate, target_lang, request.model
                    )
                    if cached:
                        log_request(
                            instance_id,
                            client_ip,
                            request.model,
                            target_lang,
                            len(texts_to_translate),
                            cached=True,
                            stream=request.stream,
                        )
                        log_response(
                            instance_id,
                            len(cached),
                            (time.time() - start_time) * 1000,
                            cached=True,
                        )
                        if request.stream:

                            async def stream_cached():
                                for i, item in enumerate(cached):
                                    yield f"data: {json.dumps({'index': i, 'translation': item, 'cached': True})}\n\n"
                                yield f"data: {json.dumps({'done': True, 'total': len(cached), 'cached': True})}\n\n"

                            return StreamingResponse(
                                stream_cached(),
                                media_type="text/event-stream",
                                headers={
                                    "Cache-Control": "no-cache",
                                    "Connection": "keep-alive",
                                    "X-Accel-Buffering": "no",
                                },
                            )
                        return JSONResponse(
                            content={
                                "choices": [
                                    {
                                        "message": {
                                            "role": "assistant",
                                            "content": json.dumps(cached),
                                        }
                                    }
                                ],
                                "model": request.model,
                                "cached": True,
                            }
                        )
            except (json.JSONDecodeError, TypeError):
                pass

        text_count = len(texts_to_translate) if texts_to_translate else 1
        log_request(
            instance_id,
            client_ip,
            request.model,
            target_lang,
            text_count,
            cached=False,
            stream=request.stream,
        )

        # Build contents - select appropriate prompt based on content type
        system_prompt = None
        if request.target_language and request.html_aware:
            system_prompt = get_translation_prompt(request.target_language)
        contents = []
        for msg in request.messages:
            role, content = msg.get("role", "user"), msg.get("content", "")
            if role == "system" and not system_prompt:
                system_prompt = content
            elif role == "user":
                contents.append(
                    types.Content(role="user", parts=[types.Part(text=content)])
                )
            elif role == "assistant":
                contents.append(
                    types.Content(role="model", parts=[types.Part(text=content)])
                )

        config = types.GenerateContentConfig(
            temperature=request.temperature, system_instruction=system_prompt
        )

        # Streaming
        if request.stream and texts_to_translate:
            return StreamingResponse(
                stream_translations(
                    request,
                    texts_to_translate,
                    contents,
                    config,
                    instance_id,
                    start_time,
                ),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

        # Non-streaming
        expected_len = len(texts_to_translate) if texts_to_translate else None
        response_text, success, usage = await call_gemini(
            request.model,
            contents,
            config,
            expected_len,
            validate_json=request.html_aware,
            instance_id=instance_id,
        )

        # Cache successful translations
        if success and texts_to_translate and request.target_language and response_text:
            try:
                translations = json.loads(response_text)
                if isinstance(translations, list) and len(translations) == len(texts_to_translate):
                    await cache.set(
                        texts_to_translate,
                        request.target_language,
                        request.model,
                        translations,
                    )
            except (json.JSONDecodeError, TypeError):
                pass

        duration_ms = (time.time() - start_time) * 1000
        log_response(instance_id, len(texts_to_translate) if texts_to_translate else 1, duration_ms)

        return JSONResponse(
            content={
                "choices": [
                    {
                        "message": {"role": "assistant", "content": response_text},
                        "finish_reason": "stop",
                    }
                ],
                "model": request.model,
                "cached": False,
                "usage": (
                    {
                        "prompt_tokens": getattr(usage, "prompt_token_count", 0),
                        "completion_tokens": getattr(
                            usage, "candidates_token_count", 0
                        ),
                        "total_tokens": getattr(usage, "total_token_count", 0),
                    }
                    if usage
                    else None
                ),
            }
        )
    except Exception as e:
        log_error(instance_id, "EXCEPTION", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# LOGGING
# ============================================================================
def log_request(
    instance_id: str,
    client_ip: str,
    model: str,
    lang: str,
    count: int,
    cached: bool = False,
    stream: bool = False,
):
    mode = "STREAM" if stream else "BATCH"
    status = "CACHE-HIT" if cached else "NEW"
    print(
        f"[{instance_id}] REQ | {client_ip} | {mode} | {status} | model={model} | lang={lang} | texts={count}"
    )


def log_response(
    instance_id: str,
    count: int,
    duration_ms: float,
    cached: bool = False,
):
    status = "CACHED" if cached else "OK"
    print(f"[{instance_id}] RES | {status} | texts={count} | time={duration_ms:.0f}ms")


def log_tokens(instance_id: str, usage):
    prompt = getattr(usage, "prompt_token_count", 0)
    completion = getattr(usage, "candidates_token_count", 0)
    total = getattr(usage, "total_token_count", 0)
    print(
        f"[{instance_id}] TOKENS | prompt={prompt} | completion={completion} | total={total}"
    )


def log_error(instance_id: str, error_type: str, message: str):
    print(f"[{instance_id}] ERR | {error_type} | {message[:100]}")


# ============================================================================
# MAIN
# ============================================================================
def get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="Gemini Translation Server")
    parser.add_argument(
        "--host", default=None, help="Host to bind (default: auto-detect LAN IP)"
    )
    parser.add_argument(
        "--port", type=int, default=8001, help="Port to bind (default: 8001)"
    )
    args = parser.parse_args()

    host = args.host or get_lan_ip()
    print("=" * 60)
    print("Gemini Translation Server")
    print("=" * 60)
    print(f"Server: http://{host}:{args.port}")
    print(f"Cache: {CACHE_MAX_SIZE} entries | TTL: {CACHE_TTL}s")
    print(f"API Key: {'✓ Set' if os.getenv('GEMINI_API_KEY') else '✗ Missing'}")
    print("=" * 60)
    uvicorn.run(app, host=host, port=args.port)
