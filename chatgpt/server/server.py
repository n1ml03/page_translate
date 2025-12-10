"""
Translator Middleware - High Concurrency Optimized
FastAPI server proxying translation requests to LLM API with streaming support.
"""

import asyncio
import base64
import hashlib
import json
import os
import re
import socket
import time
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

# ============================================================================
# CONFIGURATION
# ============================================================================

CACHE_MAX_SIZE = int(os.environ.get("CACHE_MAX_SIZE", "10000"))
CACHE_TTL = int(os.environ.get("CACHE_TTL", "3600"))
HTTP_TIMEOUT = int(os.environ.get("HTTP_TIMEOUT", "120"))
MAX_CONNECTIONS = int(os.environ.get("MAX_CONNECTIONS", "500"))
MAX_KEEPALIVE = int(os.environ.get("MAX_KEEPALIVE", "100"))
CONNECT_TIMEOUT = int(os.environ.get("CONNECT_TIMEOUT", "10"))
RATE_LIMIT_RPM = int(os.environ.get("RATE_LIMIT_RPM", "120"))
RATE_LIMIT_BURST = int(os.environ.get("RATE_LIMIT_BURST", "20"))
AUTH_FAILURE_MAX = int(os.environ.get("AUTH_FAILURE_MAX_ATTEMPTS", "10"))
AUTH_LOCKOUT_SEC = int(os.environ.get("AUTH_FAILURE_LOCKOUT_SECONDS", "300"))
AUTH_WINDOW_SEC = int(os.environ.get("AUTH_FAILURE_WINDOW_SECONDS", "60"))
INSTANCE_ID = os.environ.get("INSTANCE_ID", str(uuid.uuid4())[:8])
DEDUP_ENABLED = os.environ.get("DEDUP_ENABLED", "true").lower() == "true"
LOCK_TIMEOUT = float(os.environ.get("LOCK_TIMEOUT", "5.0"))
MAX_CONCURRENT_API_CALLS = int(os.environ.get("MAX_CONCURRENT_API_CALLS", "50"))
CLEANUP_INTERVAL = int(os.environ.get("CLEANUP_INTERVAL", "300"))
CLIENT_TTL = int(os.environ.get("CLIENT_TTL", "3600"))

ALLOWED_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS",
    "chrome-extension://*,moz-extension://*,http://localhost:*,http://127.0.0.1:*,http://192.168.*:*,http://10.*:*,http://172.16.*:*",
).split(",")

http_client: Optional[httpx.AsyncClient] = None
api_semaphore: Optional[asyncio.Semaphore] = None


# ============================================================================
# HELPERS
# ============================================================================


def cache_key(texts: List[str], lang: str, model: str) -> str:
    """Generate cache key for translation requests."""
    return hashlib.sha256(
        json.dumps({"t": texts, "l": lang, "m": model}, sort_keys=True).encode()
    ).hexdigest()


def basic_auth(username: str, password: str) -> str:
    return f"Basic {base64.b64encode(f'{username}:{password}'.encode()).decode()}"


def extract_lang(prompt: str) -> str:
    match = re.search(r"into\s+(\w+)", prompt, re.IGNORECASE)
    return match.group(1) if match else "English"


def extract_texts(user_input: str) -> Optional[List[str]]:
    try:
        texts = json.loads(user_input)
        return texts if isinstance(texts, list) else None
    except (json.JSONDecodeError, TypeError):
        return None


def sse_json(data: dict) -> str:
    """Format data as Server-Sent Event."""
    return f"data: {json.dumps(data)}\n\n"


def sse_error(err_type: str, message: str) -> str:
    """Format error as Server-Sent Event."""
    return sse_json({"error": {"type": err_type, "message": message}})


def categorize_error(status: int, text: str, model: str) -> tuple[str, str]:
    detail = ""
    try:
        err = json.loads(text).get("error", {})
        detail = err.get("message", str(err)) if isinstance(err, dict) else str(err)
    except Exception:
        detail = text[:200]

    error_map = {
        401: "UNAUTHORIZED",
        403: "FORBIDDEN",
        404: "MODEL_NOT_FOUND",
        429: "RATE_LIMIT",
        504: "TIMEOUT",
    }
    if status in error_map:
        return error_map[status], f"{error_map[status]}: {detail}"
    if status == 400:
        if "context_length" in text.lower() or "token" in text.lower():
            return "CONTEXT_LENGTH_EXCEEDED", detail
        return "BAD_REQUEST", detail
    if status in (502, 503):
        return "GATEWAY_ERROR", detail
    return "SERVER_ERROR" if status >= 500 else "UNKNOWN_ERROR", detail


def get_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.1)
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "0.0.0.0"


# ============================================================================
# LIFECYCLE
# ============================================================================


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client, api_semaphore
    http_client = httpx.AsyncClient(
        limits=httpx.Limits(
            max_connections=MAX_CONNECTIONS,
            max_keepalive_connections=MAX_KEEPALIVE,
            keepalive_expiry=30.0,
        ),
        timeout=httpx.Timeout(timeout=HTTP_TIMEOUT, connect=CONNECT_TIMEOUT),
        verify=False,
        http2=True,
    )
    api_semaphore = asyncio.Semaphore(MAX_CONCURRENT_API_CALLS)
    print(f"[{INSTANCE_ID}] HTTP client initialized (max {MAX_CONCURRENT_API_CALLS} concurrent API calls)")
    yield
    if http_client:
        await http_client.aclose()


app = FastAPI(title="Translator Middleware", lifespan=lifespan)


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
            print(f"[{INSTANCE_ID}] Cleaned {len(expired)} expired cache entries")

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

    async def acquire(self, client: str = "global") -> tuple[bool, float]:
        async with self._lock:
            now = time.time()
            if now - self._last_cleanup > CLEANUP_INTERVAL:
                self._cleanup_stale(now)
                self._last_cleanup = now

            if client not in self._tokens:
                self._tokens[client], self._last[client] = self.burst, now
            self._tokens[client] = min(
                self.burst, self._tokens[client] + (now - self._last[client]) * self.rate
            )
            self._last[client] = now
            if self._tokens[client] >= 1:
                self._tokens[client] -= 1
                return True, 0
            return False, (1 - self._tokens[client]) / self.rate

    def _cleanup_stale(self, now: float):
        stale = [c for c, t in self._last.items() if now - t > CLIENT_TTL]
        for client in stale:
            self._tokens.pop(client, None)
            self._last.pop(client, None)
        if stale:
            print(f"[{INSTANCE_ID}] Cleaned {len(stale)} stale rate limit entries")


limiter = RateLimiter()


# ============================================================================
# AUTH LIMITER
# ============================================================================


class AuthLimiter:
    """Tracks authentication failures with automatic cleanup."""

    def __init__(self):
        self._failures: Dict[str, List[float]] = {}
        self._lockouts: Dict[str, float] = {}
        self._lock = asyncio.Lock()
        self._last_cleanup = time.time()

    async def is_locked(self, client: str) -> tuple[bool, float]:
        async with self._lock:
            now = time.time()
            if now - self._last_cleanup > CLEANUP_INTERVAL:
                self._cleanup_stale(now)
                self._last_cleanup = now

            if client in self._lockouts:
                remaining = self._lockouts[client] - now
                if remaining > 0:
                    return True, remaining
                del self._lockouts[client]
                self._failures.pop(client, None)
            return False, 0

    async def record_failure(self, client: str) -> tuple[bool, int]:
        async with self._lock:
            now = time.time()
            self._failures.setdefault(client, [])
            self._failures[client] = [
                ts for ts in self._failures[client] if now - ts < AUTH_WINDOW_SEC
            ]
            self._failures[client].append(now)
            if len(self._failures[client]) >= AUTH_FAILURE_MAX:
                self._lockouts[client] = now + AUTH_LOCKOUT_SEC
                return True, 0
            return False, AUTH_FAILURE_MAX - len(self._failures[client])

    async def record_success(self, client: str):
        async with self._lock:
            self._failures.pop(client, None)
            self._lockouts.pop(client, None)

    def _cleanup_stale(self, now: float):
        expired = [c for c, t in self._lockouts.items() if now > t]
        for client in expired:
            del self._lockouts[client]
            self._failures.pop(client, None)
        stale = [
            c for c, ts in self._failures.items() 
            if not ts or now - max(ts) > CLIENT_TTL
        ]
        for client in stale:
            del self._failures[client]
        if expired or stale:
            print(f"[{INSTANCE_ID}] Cleaned {len(expired)} lockouts, {len(stale)} stale auth entries")


auth_limiter = AuthLimiter()


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
    target_endpoint: str = Field(..., description="LLM API URL")
    username: str
    password: str
    model: str
    system_prompt: str
    user_input: str
    temperature: float = 0.3
    top_p: float = 0.9
    stream: bool = False


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


# ============================================================================
# STREAMING TRANSLATION
# ============================================================================


async def stream_translations(
    request: TranslateRequest, texts: Optional[List[str]], lang: str, client_id: str
) -> AsyncGenerator[str, None]:
    if not http_client or not api_semaphore:
        yield sse_error("SERVER_ERROR", "Server not initialized")
        return

    headers = {
        "Authorization": basic_auth(request.username, request.password),
        "Content-Type": "application/json",
    }
    payload = {
        "system_prompt": request.system_prompt,
        "user_input": request.user_input,
        "temperature": request.temperature,
        "top_p": request.top_p,
    }

    try:
        async with api_semaphore:
            async with http_client.stream(
                "POST", request.target_endpoint, json=payload, headers=headers
            ) as response:
                if response.status_code != 200:
                    text = (await response.aread()).decode()
                    err_type, err_msg = categorize_error(response.status_code, text, request.model)
                    if response.status_code in (401, 403):
                        locked, left = await auth_limiter.record_failure(client_id)
                        err_msg = "Account locked" if locked else f"{err_msg} ({left} attempts left)"
                    yield sse_error(err_type, err_msg)
                    return

                await auth_limiter.record_success(client_id)
                parser = StreamingJSONParser()
                translations = []

                async for line in response.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("data: "):
                        line = line[6:]
                    if line == "[DONE]":
                        break
                    try:
                        data = json.loads(line)
                        content = data.get("system_response", "") or data.get(
                            "choices", [{}]
                        )[0].get("delta", {}).get("system_response", "")
                        if content:
                            for item in parser.feed(content):
                                translations.append(item)
                                yield sse_json({"index": len(translations) - 1, "translation": item})
                    except json.JSONDecodeError:
                        continue

                if texts and len(translations) == len(texts):
                    await cache.set(texts, lang, request.model, translations)
                yield sse_json({"done": True, "total": len(translations)})

    except httpx.ConnectError:
        yield sse_error("CONNECTION_ERROR", "Failed to connect")
    except httpx.TimeoutException:
        yield sse_error("TIMEOUT", "Request timeout")
    except Exception as e:
        yield sse_error("ERROR", str(e))


# ============================================================================
# MAIN ENDPOINT
# ============================================================================


@app.post("/proxy/translate")
async def translate(request: TranslateRequest, req: Request):
    client_id = req.client.host if req.client else "unknown"

    # Auth lockout check
    locked, remaining = await auth_limiter.is_locked(client_id)
    if locked:
        return JSONResponse(
            status_code=429,
            content={"error": {"type": "LOCKED", "message": f"Try again in {int(remaining)}s"}},
        )

    # Rate limit check
    allowed, wait = await limiter.acquire(client_id)
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={"error": {"type": "RATE_LIMITED", "message": f"Wait {wait:.1f}s"}},
        )

    texts = extract_texts(request.user_input)
    lang = extract_lang(request.system_prompt)

    # Cache check
    if texts:
        cached = await cache.get(texts, lang, request.model)
        if cached:
            print(f"[{INSTANCE_ID}] Cache hit ({len(cached)} items)")
            if request.stream:
                async def stream_cached():
                    for i, item in enumerate(cached):
                        yield sse_json({"index": i, "translation": item, "cached": True})
                    yield sse_json({"done": True, "total": len(cached), "cached": True})

                return StreamingResponse(
                    stream_cached(),
                    media_type="text/event-stream",
                    headers={"X-Instance-ID": INSTANCE_ID},
                )
            return JSONResponse(
                content={
                    "choices": [{"message": {"role": "assistant", "content": json.dumps(cached)}}],
                    "cached": True,
                },
                headers={"X-Instance-ID": INSTANCE_ID},
            )

    # Streaming
    if request.stream:
        return StreamingResponse(
            stream_translations(request, texts, lang, client_id),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Instance-ID": INSTANCE_ID},
        )

    # Non-streaming
    return await handle_sync_request(request, texts, lang, client_id)


async def handle_sync_request(
    request: TranslateRequest, texts: Optional[List[str]], lang: str, client_id: str
) -> JSONResponse:
    """Handle synchronous translation with request deduplication."""
    future, is_owner = None, True
    if texts:
        future, is_owner = await deduplicator.get_or_create(texts, lang, request.model)
        if not is_owner and future:
            try:
                result = await asyncio.wait_for(future, timeout=HTTP_TIMEOUT)
                if result:
                    return JSONResponse(
                        content={
                            "choices": [{"message": {"role": "assistant", "content": json.dumps(result)}}],
                            "model": request.model,
                            "coalesced": True,
                        },
                        headers={"X-Instance-ID": INSTANCE_ID},
                    )
            except asyncio.TimeoutError:
                pass  # Fallback to making our own request
            except Exception:
                pass

    headers = {
        "Authorization": basic_auth(request.username, request.password),
        "Content-Type": "application/json",
    }
    payload = {
        "system_prompt": request.system_prompt,
        "user_input": request.user_input,
        "temperature": request.temperature,
        "top_p": request.top_p,
    }

    if not http_client or not api_semaphore:
        if texts and is_owner:
            await deduplicator.complete(texts, lang, request.model, None, "Server not initialized")
        raise HTTPException(status_code=503, detail="Server not initialized")

    try:
        async with api_semaphore:
            response = await http_client.post(
                request.target_endpoint, json=payload, headers=headers
            )

        if response.status_code != 200:
            err_type, err_msg = categorize_error(response.status_code, response.text, request.model)
            if response.status_code in (401, 403):
                locked, left = await auth_limiter.record_failure(client_id)
                err_msg = "Account locked" if locked else f"{err_msg} ({left} attempts left)"
            if texts and is_owner:
                await deduplicator.complete(texts, lang, request.model, None, err_msg)
            return JSONResponse(
                status_code=response.status_code,
                content={"error": {"type": err_type, "message": err_msg}},
                headers={"X-Instance-ID": INSTANCE_ID},
            )

        await auth_limiter.record_success(client_id)
        data = response.json()

        usage = data.get("token_usage", {})
        print(f"[{INSTANCE_ID}] Token usage: {usage}")

        content = data.get("system_response", "") or data.get("choices", [{}])[0].get(
            "message", {}
        ).get("system_response", "")

        translations = None
        if texts and content:
            try:
                trans = json.loads(content)
                if isinstance(trans, list) and len(trans) == len(texts):
                    translations = trans
                    await cache.set(texts, lang, request.model, trans)
            except (json.JSONDecodeError, KeyError):
                pass

        if texts and is_owner:
            await deduplicator.complete(texts, lang, request.model, translations)

        return JSONResponse(
            content={
                "choices": [{"message": {"role": "assistant", "content": content}}],
                "model": request.model,
                "usage": usage,
            },
            headers={"X-Instance-ID": INSTANCE_ID},
        )

    except httpx.ConnectError:
        if texts and is_owner:
            await deduplicator.complete(texts, lang, request.model, None, "Connection failed")
        raise HTTPException(status_code=502, detail="Connection failed")
    except httpx.TimeoutException:
        if texts and is_owner:
            await deduplicator.complete(texts, lang, request.model, None, "Timeout")
        raise HTTPException(status_code=504, detail="Timeout")


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import argparse
    import multiprocessing

    import uvicorn

    parser = argparse.ArgumentParser(description="Translator Middleware Server")
    parser.add_argument("--host", default=None, help="Host to bind to")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to")
    parser.add_argument(
        "--workers", type=int, default=None,
        help="Number of worker processes (default: CPU cores, max 4)",
    )
    args = parser.parse_args()

    if args.workers is None:
        args.workers = min(multiprocessing.cpu_count(), 1)

    host = args.host or get_lan_ip()

    print(f"\n{'=' * 60}")
    print("  Translator Middleware")
    print(f"{'=' * 60}")
    print(f"  Instance:    {INSTANCE_ID}")
    print(f"  Server:      http://{host}:{args.port}")
    print(f"  Workers:     {args.workers}")
    print(f"  Connections: {MAX_CONNECTIONS} max")
    print(f"  Cache:       {CACHE_MAX_SIZE} entries, {CACHE_TTL}s TTL")
    print(f"  Dedup:       {'enabled' if DEDUP_ENABLED else 'disabled'}")
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
