"""
Gemini Translation Server - High Concurrency Optimized
FastAPI server for translation using Google Gemini API with streaming support.
"""

import asyncio
import hashlib
import json
import os
import socket
import time
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

load_dotenv()

# ============================================================================
# CONFIGURATION
# ============================================================================

CACHE_MAX_SIZE = int(os.environ.get("CACHE_MAX_SIZE", "2000"))
CACHE_TTL = int(os.environ.get("CACHE_TTL", "3600"))
RATE_LIMIT_RPM = int(os.environ.get("RATE_LIMIT_RPM", "60"))
RATE_LIMIT_BURST = int(os.environ.get("RATE_LIMIT_BURST", "10"))
MAX_RETRIES = int(os.environ.get("MAX_RETRIES", "2"))
RETRY_DELAY = float(os.environ.get("RETRY_DELAY", "0.5"))
LOCK_TIMEOUT = float(os.environ.get("LOCK_TIMEOUT", "5.0"))
MAX_CONCURRENT_API_CALLS = int(os.environ.get("MAX_CONCURRENT_API_CALLS", "50"))
CLEANUP_INTERVAL = int(os.environ.get("CLEANUP_INTERVAL", "300"))
CLIENT_TTL = int(os.environ.get("CLIENT_TTL", "3600"))
DEDUP_ENABLED = os.environ.get("DEDUP_ENABLED", "true").lower() == "true"
INSTANCE_ID = os.environ.get("INSTANCE_ID", str(uuid.uuid4())[:8])

ALLOWED_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS",
    "chrome-extension://*,moz-extension://*,http://localhost:*,http://127.0.0.1:*,http://192.168.*:*,http://10.*:*,http://172.16.*:*",
).split(",")

api_semaphore: asyncio.Semaphore
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


# ============================================================================
# HELPERS
# ============================================================================


def cache_key(texts: List[str], lang: str, model: str) -> str:
    """Generate cache key for translation requests."""
    return hashlib.sha256(
        json.dumps({"t": texts, "l": lang, "m": model}, sort_keys=True).encode()
    ).hexdigest()


def log_msg(msg_type: str, details: str):
    print(f"[{INSTANCE_ID}] {msg_type} | {details}")


def get_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.1)
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


# ============================================================================
# LIFECYCLE
# ============================================================================


@asynccontextmanager
async def lifespan(app: FastAPI):
    global api_semaphore
    api_semaphore = asyncio.Semaphore(MAX_CONCURRENT_API_CALLS)
    log_msg("INIT", f"Server initialized (max {MAX_CONCURRENT_API_CALLS} concurrent API calls)")
    yield


app = FastAPI(title="Gemini Translation Server", lifespan=lifespan)


# ============================================================================
# CACHE
# ============================================================================


class TranslationCache:
    """LRU cache with TTL expiration, periodic cleanup, and lock timeout."""

    def __init__(self, max_size: int = CACHE_MAX_SIZE, ttl: int = CACHE_TTL):
        self.max_size, self.ttl = max_size, ttl
        self._cache: OrderedDict = OrderedDict()
        self._lock = asyncio.Lock()
        self._hits = self._misses = self._timeouts = 0
        self._last_cleanup = time.time()

    async def get(self, texts: List[str], lang: str, model: str) -> Optional[List[str]]:
        key = cache_key(texts, lang, model)
        try:
            async with asyncio.timeout(LOCK_TIMEOUT):
                async with self._lock:
                    now = time.time()
                    if now - self._last_cleanup > CLEANUP_INTERVAL:
                        self._cleanup_expired(now)
                        self._last_cleanup = now

                    if key in self._cache and now - self._cache[key]["ts"] < self.ttl:
                        self._cache.move_to_end(key)
                        self._hits += 1
                        return self._cache[key]["data"]
                    self._cache.pop(key, None)
                    self._misses += 1
        except asyncio.TimeoutError:
            self._timeouts += 1
        return None

    async def set(self, texts: List[str], lang: str, model: str, translations: List[str]):
        key = cache_key(texts, lang, model)
        try:
            async with asyncio.timeout(LOCK_TIMEOUT):
                async with self._lock:
                    self._cache[key] = {"data": translations, "ts": time.time()}
                    self._cache.move_to_end(key)
                    while len(self._cache) > self.max_size:
                        self._cache.popitem(last=False)
        except asyncio.TimeoutError:
            pass

    def _cleanup_expired(self, now: float):
        expired = [k for k, v in self._cache.items() if now - v["ts"] > self.ttl]
        for key in expired:
            del self._cache[key]
        if expired:
            log_msg("CACHE", f"Cleaned {len(expired)} expired entries")

    async def stats(self) -> Dict:
        async with self._lock:
            total = self._hits + self._misses
            return {
                "size": len(self._cache),
                "max_size": self.max_size,
                "hits": self._hits,
                "misses": self._misses,
                "timeouts": self._timeouts,
                "hit_rate": f"{(self._hits / total * 100) if total else 0:.1f}%",
            }


cache = TranslationCache()


# ============================================================================
# REQUEST DEDUPLICATION (Coalescing)
# ============================================================================


class RequestDeduplicator:
    """Coalesces identical in-flight requests to avoid duplicate API calls."""

    def __init__(self):
        self._pending: Dict[str, asyncio.Future] = {}
        self._lock = asyncio.Lock()
        self._coalesced = 0

    async def get_or_create(
        self, texts: List[str], lang: str, model: str
    ) -> tuple[Optional[asyncio.Future], bool]:
        """Returns (future, is_owner). Owner executes request; others await the future."""
        if not DEDUP_ENABLED:
            return None, True

        key = cache_key(texts, lang, model)
        async with self._lock:
            if key in self._pending:
                self._coalesced += 1
                return self._pending[key], False
            future = asyncio.get_event_loop().create_future()
            self._pending[key] = future
            return future, True

    async def complete(
        self, texts: List[str], lang: str, model: str,
        result: Optional[List[str]], error: Optional[str] = None
    ):
        """Mark request as complete, notify all waiters."""
        if not DEDUP_ENABLED:
            return

        key = cache_key(texts, lang, model)
        async with self._lock:
            future = self._pending.pop(key, None)
            if future and not future.done():
                if error:
                    future.set_exception(Exception(error))
                else:
                    future.set_result(result)

    async def stats(self) -> Dict:
        async with self._lock:
            return {"pending": len(self._pending), "coalesced": self._coalesced}


deduplicator = RequestDeduplicator()


# ============================================================================
# RATE LIMITER
# ============================================================================


class RateLimiter:
    """Token bucket rate limiter with automatic cleanup of stale clients."""

    def __init__(self, rpm: int = RATE_LIMIT_RPM, burst: int = RATE_LIMIT_BURST):
        self.rate, self.burst = rpm / 60.0, burst
        self._tokens: Dict[str, float] = {}
        self._last: Dict[str, float] = {}
        self._lock = asyncio.Lock()
        self._last_cleanup = time.time()

    async def acquire(self, client_id: str = "global") -> tuple[bool, float]:
        async with self._lock:
            now = time.time()
            if now - self._last_cleanup > CLEANUP_INTERVAL:
                self._cleanup_stale(now)
                self._last_cleanup = now

            if client_id not in self._tokens:
                self._tokens[client_id], self._last[client_id] = self.burst, now
            self._tokens[client_id] = min(
                self.burst, self._tokens[client_id] + (now - self._last[client_id]) * self.rate
            )
            self._last[client_id] = now
            if self._tokens[client_id] >= 1:
                self._tokens[client_id] -= 1
                return True, 0
            return False, (1 - self._tokens[client_id]) / self.rate

    def _cleanup_stale(self, now: float):
        stale = [c for c, t in self._last.items() if now - t > CLIENT_TTL]
        for client_id in stale:
            self._tokens.pop(client_id, None)
            self._last.pop(client_id, None)
        if stale:
            log_msg("RATE", f"Cleaned {len(stale)} stale rate limit entries")


limiter = RateLimiter()


# ============================================================================
# STREAMING JSON PARSER
# ============================================================================


class StreamingJSONParser:
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
                self.buffer = self.buffer[idx + 1:]
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
                    return json.loads(self.buffer[:i + 1]), self.buffer[i + 1:]
                except json.JSONDecodeError:
                    return None, self.buffer
            i += 1
        return None, self.buffer


# ============================================================================
# CORS & MODELS
# ============================================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"^(chrome-extension|moz-extension)://.*$|^http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?(/.*)?$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


class TranslateRequest(BaseModel):
    messages: List[Dict[str, str]] = Field(..., description="Chat messages")
    model: str = Field(default="gemini-2.0-flash")
    temperature: float = Field(default=0.3)
    target_language: Optional[str] = None
    html_aware: bool = False
    stream: bool = False


# ============================================================================
# GEMINI API CALLS
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


async def call_gemini(model: str, contents: list, config: types.GenerateContentConfig,
                      expected_len=None, validate_json=True):
    loop = asyncio.get_event_loop()
    response_text, usage = None, None
    max_attempts = MAX_RETRIES + 1 if validate_json else 1

    for attempt in range(max_attempts):
        try:
            if attempt > 0:
                await asyncio.sleep(RETRY_DELAY)
                contents = contents.copy()
                contents.append(types.Content(role="model", parts=[types.Part(text=response_text)]))
                contents.append(types.Content(role="user", parts=[types.Part(text="Invalid JSON. Return ONLY a valid JSON array.")]))

            async with api_semaphore:
                response = await loop.run_in_executor(
                    None, lambda: client.models.generate_content(model=model, contents=contents, config=config)
                )
            response_text = response.text
            usage = response.usage_metadata

            if usage:
                log_msg("TOKENS", f"prompt={getattr(usage, 'prompt_token_count', 0)} | completion={getattr(usage, 'candidates_token_count', 0)} | total={getattr(usage, 'total_token_count', 0)}")

            if not validate_json:
                return response_text, True, usage

            if response_text:
                parsed = json.loads(response_text)
                if isinstance(parsed, list) and (expected_len is None or len(parsed) == expected_len):
                    return response_text, True, usage
        except json.JSONDecodeError:
            if attempt == max_attempts - 1:
                return response_text, False, usage
    return response_text, False, usage


async def call_gemini_streaming(model: str, contents: list, config: types.GenerateContentConfig) -> AsyncGenerator[tuple, None]:
    loop = asyncio.get_event_loop()
    async with api_semaphore:
        stream = await loop.run_in_executor(
            None, lambda: client.models.generate_content_stream(model=model, contents=contents, config=config)
        )

    final_usage = None
    for chunk in stream:
        if hasattr(chunk, "usage_metadata") and chunk.usage_metadata:
            final_usage = chunk.usage_metadata
        if chunk.text:
            yield chunk.text, None

    if final_usage:
        yield "", final_usage


# ============================================================================
# ENDPOINTS
# ============================================================================


@app.get("/health")
async def health():
    return {"status": "ok", "instance_id": INSTANCE_ID}


@app.head("/proxy/translate")
async def translate_head():
    """HEAD request for connection check from extension."""
    return JSONResponse(content=None, headers={"X-Instance-ID": INSTANCE_ID})


@app.get("/stats")
async def stats():
    return {
        "instance_id": INSTANCE_ID,
        "cache": await cache.stats(),
        "deduplication": await deduplicator.stats(),
    }


def streaming_headers():
    return {"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no", "X-Instance-ID": INSTANCE_ID}


async def stream_translations(request: TranslateRequest, texts: List[str], contents: list,
                              config: types.GenerateContentConfig, start_time: float):
    try:
        parser = StreamingJSONParser()
        all_translations = []
        final_usage = None

        async for chunk_text, usage in call_gemini_streaming(request.model, contents, config):
            if usage:
                final_usage = usage
            if chunk_text:
                for item in parser.feed(chunk_text):
                    all_translations.append(item)
                    yield f"data: {json.dumps({'index': len(all_translations) - 1, 'translation': item})}\n\n"

        if final_usage:
            log_msg("TOKENS", f"prompt={getattr(final_usage, 'prompt_token_count', 0)} | completion={getattr(final_usage, 'candidates_token_count', 0)} | total={getattr(final_usage, 'total_token_count', 0)}")

        if texts and len(all_translations) == len(texts):
            await cache.set(texts, request.target_language or "English", request.model, all_translations)
            log_msg("RES", f"OK | texts={len(all_translations)} | time={(time.time() - start_time) * 1000:.0f}ms")

        yield f"data: {json.dumps({'done': True, 'total': len(all_translations)})}\n\n"
    except Exception as e:
        log_msg("ERR", f"STREAM_ERROR | {str(e)[:100]}")
        yield f"data: {json.dumps({'error': {'type': 'UNKNOWN_ERROR', 'message': str(e)}})}\n\n"


# ============================================================================
# MAIN ENDPOINT
# ============================================================================


@app.post("/proxy/translate")
async def translate(request: TranslateRequest, req: Request):
    client_ip = req.client.host if req.client else "unknown"
    start_time = time.time()
    target_lang = request.target_language or "English"

    # Rate limit check
    allowed, wait = await limiter.acquire(client_ip)
    if not allowed:
        log_msg("ERR", f"RATE_LIMITED | Wait {wait:.1f}s")
        return JSONResponse(
            status_code=429,
            content={"error": {"type": "RATE_LIMITED", "message": f"Wait {wait:.1f}s", "retry_after": wait}},
        )

    texts_to_translate: Optional[List[str]] = None
    is_owner = True
    
    try:
        user_content = next((m.get("content", "") for m in request.messages if m.get("role") == "user"), None)

        if user_content and request.html_aware:
            try:
                texts_to_translate = json.loads(user_content)
                if isinstance(texts_to_translate, list):
                    # Cache check
                    cached = await cache.get(texts_to_translate, target_lang, request.model)
                    if cached:
                        mode = "STREAM" if request.stream else "BATCH"
                        log_msg("REQ", f"{client_ip} | {mode} | CACHE-HIT | model={request.model} | lang={target_lang} | texts={len(texts_to_translate)}")
                        log_msg("RES", f"CACHED | texts={len(cached)} | time={(time.time() - start_time) * 1000:.0f}ms")

                        if request.stream:
                            async def stream_cached():
                                for i, item in enumerate(cached):
                                    yield f"data: {json.dumps({'index': i, 'translation': item, 'cached': True})}\n\n"
                                yield f"data: {json.dumps({'done': True, 'total': len(cached), 'cached': True})}\n\n"
                            return StreamingResponse(stream_cached(), media_type="text/event-stream", headers=streaming_headers())

                        return JSONResponse(
                            content={
                                "choices": [{"message": {"role": "assistant", "content": json.dumps(cached)}}],
                                "model": request.model, "cached": True
                            },
                            headers={"X-Instance-ID": INSTANCE_ID},
                        )
            except (json.JSONDecodeError, TypeError):
                pass

        text_count = len(texts_to_translate) if texts_to_translate else 1
        mode = "STREAM" if request.stream else "BATCH"
        log_msg("REQ", f"{client_ip} | {mode} | NEW | model={request.model} | lang={target_lang} | texts={text_count}")

        system_prompt = get_translation_prompt(request.target_language) if request.target_language and request.html_aware else None
        contents = []
        for msg in request.messages:
            role, content = msg.get("role", "user"), msg.get("content", "")
            if role == "system" and not system_prompt:
                system_prompt = content
            elif role == "user":
                contents.append(types.Content(role="user", parts=[types.Part(text=content)]))
            elif role == "assistant":
                contents.append(types.Content(role="model", parts=[types.Part(text=content)]))

        config = types.GenerateContentConfig(temperature=request.temperature, system_instruction=system_prompt)

        # Streaming mode
        if request.stream and texts_to_translate:
            return StreamingResponse(
                stream_translations(request, texts_to_translate, contents, config, start_time),
                media_type="text/event-stream", headers=streaming_headers()
            )

        # Non-streaming with deduplication
        future = None
        if texts_to_translate:
            future, is_owner = await deduplicator.get_or_create(texts_to_translate, target_lang, request.model)
            if not is_owner and future:
                try:
                    result = await asyncio.wait_for(future, timeout=120)
                    if result:
                        log_msg("RES", f"COALESCED | texts={len(result)} | time={(time.time() - start_time) * 1000:.0f}ms")
                        return JSONResponse(
                            content={
                                "choices": [{"message": {"role": "assistant", "content": json.dumps(result)}}],
                                "model": request.model, "coalesced": True
                            },
                            headers={"X-Instance-ID": INSTANCE_ID},
                        )
                except asyncio.TimeoutError:
                    pass  # Fallback to making our own request
                except Exception:
                    pass

        expected_len = len(texts_to_translate) if texts_to_translate else None
        response_text, success, usage = await call_gemini(
            request.model, contents, config, expected_len, validate_json=request.html_aware
        )

        translations = None
        if success and texts_to_translate and request.target_language and response_text:
            try:
                translations = json.loads(response_text)
                if isinstance(translations, list) and len(translations) == len(texts_to_translate):
                    await cache.set(texts_to_translate, request.target_language, request.model, translations)
            except (json.JSONDecodeError, TypeError):
                translations = None

        # Complete deduplication
        if texts_to_translate and is_owner:
            await deduplicator.complete(texts_to_translate, target_lang, request.model, translations)

        log_msg("RES", f"OK | texts={len(texts_to_translate) if texts_to_translate else 1} | time={(time.time() - start_time) * 1000:.0f}ms")

        return JSONResponse(
            content={
                "choices": [{"message": {"role": "assistant", "content": response_text}, "finish_reason": "stop"}],
                "model": request.model, "cached": False,
                "usage": {"prompt_tokens": getattr(usage, "prompt_token_count", 0),
                          "completion_tokens": getattr(usage, "candidates_token_count", 0),
                          "total_tokens": getattr(usage, "total_token_count", 0)} if usage else None
            },
            headers={"X-Instance-ID": INSTANCE_ID},
        )
    except Exception as e:
        # Complete deduplication on error
        if texts_to_translate and is_owner:
            await deduplicator.complete(texts_to_translate, target_lang, request.model, None, str(e))
        log_msg("ERR", f"EXCEPTION | {str(e)[:100]}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import argparse
    import multiprocessing

    import uvicorn

    parser = argparse.ArgumentParser(description="Gemini Translation Server")
    parser.add_argument("--host", default=None, help="Host to bind (default: auto-detect LAN IP)")
    parser.add_argument("--port", type=int, default=8001, help="Port to bind (default: 8001)")
    parser.add_argument(
        "--workers", type=int, default=None,
        help="Number of worker processes (default: 1)",
    )
    args = parser.parse_args()

    if args.workers is None:
        args.workers = min(multiprocessing.cpu_count(), 1)

    host = args.host or get_lan_ip()

    print(f"\n{'=' * 60}")
    print("  Gemini Translation Server")
    print(f"{'=' * 60}")
    print(f"  Instance:    {INSTANCE_ID}")
    print(f"  Server:      http://{host}:{args.port}")
    print(f"  Workers:     {args.workers}")
    print(f"  API Key:     {'✓ Set' if os.getenv('GEMINI_API_KEY') else '✗ Missing'}")
    print(f"  Cache:       {CACHE_MAX_SIZE} entries, {CACHE_TTL}s TTL")
    print(f"  Dedup:       {'enabled' if DEDUP_ENABLED else 'disabled'}")
    print(f"  Concurrency: {MAX_CONCURRENT_API_CALLS} max API calls")
    print(f"{'=' * 60}")
    print("  Endpoints:")
    print("    POST /proxy/translate  - Translation endpoint")
    print("    GET  /health           - Health check")
    print("    GET  /stats            - Cache & dedup statistics")
    print(f"{'=' * 60}\n")

    if args.workers > 1:
        print(f"⚠️  Note: Running {args.workers} workers with in-memory cache.")
        print("   Each worker has separate cache.\n")

    uvicorn.run(
        "server:app",
        host=host,
        port=args.port,
        workers=args.workers,
        access_log=True,
        limit_concurrency=1000,
        limit_max_requests=10000,
    )
