"""
Page Translator Middleware - Optimized
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

CACHE_MAX_SIZE = int(os.environ.get("CACHE_MAX_SIZE", "5000"))
CACHE_TTL = int(os.environ.get("CACHE_TTL", "3600"))
HTTP_TIMEOUT = int(os.environ.get("HTTP_TIMEOUT", "120"))
MAX_CONNECTIONS = int(os.environ.get("MAX_CONNECTIONS", "100"))
MAX_KEEPALIVE = int(os.environ.get("MAX_KEEPALIVE", "50"))
CONNECT_TIMEOUT = int(os.environ.get("CONNECT_TIMEOUT", "10"))
RATE_LIMIT_RPM = int(os.environ.get("RATE_LIMIT_RPM", "120"))
RATE_LIMIT_BURST = int(os.environ.get("RATE_LIMIT_BURST", "20"))
AUTH_FAILURE_MAX = int(os.environ.get("AUTH_FAILURE_MAX_ATTEMPTS", "10"))
AUTH_LOCKOUT_SEC = int(os.environ.get("AUTH_FAILURE_LOCKOUT_SECONDS", "300"))
AUTH_WINDOW_SEC = int(os.environ.get("AUTH_FAILURE_WINDOW_SECONDS", "60"))
INSTANCE_ID = os.environ.get("INSTANCE_ID", str(uuid.uuid4())[:8])

ALLOWED_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS",
    "chrome-extension://*,moz-extension://*,http://localhost:*,http://127.0.0.1:*,http://192.168.*:*,http://10.*:*,http://172.16.*:*",
).split(",")

http_client: Optional[httpx.AsyncClient] = None


# ============================================================================
# LIFECYCLE
# ============================================================================


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
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
    print(f"[{INSTANCE_ID}] HTTP client initialized")
    yield
    if http_client:
        await http_client.aclose()


app = FastAPI(title="Page Translator Middleware", lifespan=lifespan)


# ============================================================================
# CACHE
# ============================================================================


class TranslationCache:
    def __init__(self, max_size: int = CACHE_MAX_SIZE, ttl: int = CACHE_TTL):
        self.max_size, self.ttl = max_size, ttl
        self._cache: OrderedDict = OrderedDict()
        self._lock = asyncio.Lock()
        self._hits = self._misses = 0

    def _key(self, texts: List[str], lang: str, model: str) -> str:
        return hashlib.sha256(
            json.dumps({"t": texts, "l": lang, "m": model}, sort_keys=True).encode()
        ).hexdigest()

    async def get(self, texts: List[str], lang: str, model: str) -> Optional[List[str]]:
        key = self._key(texts, lang, model)
        async with self._lock:
            if key in self._cache and time.time() - self._cache[key]["ts"] < self.ttl:
                self._cache.move_to_end(key)
                self._hits += 1
                return self._cache[key]["data"]
            self._cache.pop(key, None)
            self._misses += 1
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
            total = self._hits + self._misses
            return {
                "size": len(self._cache),
                "hits": self._hits,
                "misses": self._misses,
                "hit_rate": f"{(self._hits / total * 100) if total else 0:.1f}%",
            }


cache = TranslationCache()


# ============================================================================
# RATE LIMITER
# ============================================================================


class RateLimiter:
    def __init__(self, rpm: int = RATE_LIMIT_RPM, burst: int = RATE_LIMIT_BURST):
        self.rate, self.burst = rpm / 60.0, burst
        self._tokens: Dict[str, float] = {}
        self._last: Dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, client: str = "global") -> tuple[bool, float]:
        async with self._lock:
            now = time.time()
            if client not in self._tokens:
                self._tokens[client], self._last[client] = self.burst, now
            self._tokens[client] = min(
                self.burst,
                self._tokens[client] + (now - self._last[client]) * self.rate,
            )
            self._last[client] = now
            if self._tokens[client] >= 1:
                self._tokens[client] -= 1
                return True, 0
            return False, (1 - self._tokens[client]) / self.rate


limiter = RateLimiter()


# ============================================================================
# AUTH LIMITER
# ============================================================================


class AuthLimiter:
    def __init__(self):
        self._failures: Dict[str, List[float]] = {}
        self._lockouts: Dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def is_locked(self, client: str) -> tuple[bool, float]:
        async with self._lock:
            if client in self._lockouts:
                remaining = self._lockouts[client] - time.time()
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


auth_limiter = AuthLimiter()


# ============================================================================
# HELPERS
# ============================================================================


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


def log_tokens(usage: Dict):
    """Log: Instance ID: token_usage (prompt/completion/total)"""
    p, c, t = (
        usage.get("prompt_tokens", "N/A"),
        usage.get("completion_tokens", "N/A"),
        usage.get("total_tokens", "N/A"),
    )
    print(f"{INSTANCE_ID}: token_usage ({p}/{c}/{t})")


def categorize_error(status: int, text: str, model: str) -> tuple[str, str]:
    detail = ""
    try:
        err = json.loads(text).get("error", {})
        detail = err.get("message", str(err)) if isinstance(err, dict) else str(err)
    except Exception:
        detail = text[:200]

    errors = {
        401: "UNAUTHORIZED",
        403: "FORBIDDEN",
        404: "MODEL_NOT_FOUND",
        429: "RATE_LIMIT",
        504: "TIMEOUT",
    }
    if status in errors:
        return errors[status], f"{errors[status]}: {detail}"
    if status == 400:
        if "context_length" in text.lower() or "token" in text.lower():
            return "CONTEXT_LENGTH_EXCEEDED", detail
        return "BAD_REQUEST", detail
    if status in (502, 503):
        return "GATEWAY_ERROR", detail
    return "SERVER_ERROR" if status >= 500 else "UNKNOWN_ERROR", detail


def get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "0.0.0.0"


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
    """HEAD request cho connection check từ extension"""
    return JSONResponse(content=None, headers={"X-Instance-ID": INSTANCE_ID})


@app.get("/stats")
async def stats():
    return {"instance_id": INSTANCE_ID, "cache": await cache.stats()}


# ============================================================================
# STREAMING TRANSLATION
# ============================================================================


async def stream_translations(
    request: TranslateRequest, texts: Optional[List[str]], lang: str, client_id: str
) -> AsyncGenerator[str, None]:
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

    if not http_client:
        yield f"data: {json.dumps({'error': {'type': 'SERVER_ERROR', 'message': 'HTTP client not initialized'}})}\n\n"
        return

    try:
        async with http_client.stream(
            "POST", request.target_endpoint, json=payload, headers=headers
        ) as response:
            if response.status_code != 200:
                text = (await response.aread()).decode()
                err_type, err_msg = categorize_error(
                    response.status_code, text, request.model
                )
                if response.status_code in (401, 403):
                    locked, left = await auth_limiter.record_failure(client_id)
                    err_msg = (
                        "Account locked"
                        if locked
                        else f"{err_msg} ({left} attempts left)"
                    )
                yield f"data: {json.dumps({'error': {'type': err_type, 'message': err_msg}})}\n\n"
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
                    content = data.get("content", "") or data.get("choices", [{}])[
                        0
                    ].get("delta", {}).get("content", "")
                    if content:
                        for item in parser.feed(content):
                            translations.append(item)
                            yield f"data: {json.dumps({'index': len(translations) - 1, 'translation': item})}\n\n"
                except json.JSONDecodeError:
                    continue

            if texts and len(translations) == len(texts):
                await cache.set(texts, lang, request.model, translations)
            yield f"data: {json.dumps({'done': True, 'total': len(translations)})}\n\n"

    except httpx.ConnectError:
        yield f"data: {json.dumps({'error': {'type': 'CONNECTION_ERROR', 'message': 'Failed to connect'}})}\n\n"
    except httpx.TimeoutException:
        yield f"data: {json.dumps({'error': {'type': 'TIMEOUT', 'message': 'Request timeout'}})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': {'type': 'ERROR', 'message': str(e)}})}\n\n"


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
            content={
                "error": {
                    "type": "LOCKED",
                    "message": f"Try again in {int(remaining)}s",
                }
            },
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
            print(f"{INSTANCE_ID}: cache_hit ({len(cached)} items)")
            if request.stream:

                async def stream_cached():
                    for i, item in enumerate(cached):
                        yield f"data: {json.dumps({'index': i, 'translation': item, 'cached': True})}\n\n"
                    yield f"data: {json.dumps({'done': True, 'total': len(cached), 'cached': True})}\n\n"

                return StreamingResponse(
                    stream_cached(),
                    media_type="text/event-stream",
                    headers={"X-Instance-ID": INSTANCE_ID},
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

    if not http_client:
        raise HTTPException(status_code=503, detail="HTTP client not initialized")

    try:
        response = await http_client.post(
            request.target_endpoint, json=payload, headers=headers
        )

        if response.status_code != 200:
            err_type, err_msg = categorize_error(
                response.status_code, response.text, request.model
            )
            if response.status_code in (401, 403):
                locked, left = await auth_limiter.record_failure(client_id)
                err_msg = (
                    "Account locked" if locked else f"{err_msg} ({left} attempts left)"
                )
            return JSONResponse(
                status_code=response.status_code,
                content={"error": {"type": err_type, "message": err_msg}},
                headers={"X-Instance-ID": INSTANCE_ID},
            )

        await auth_limiter.record_success(client_id)
        data = response.json()

        # Log token usage
        usage = data.get("usage", {})
        log_tokens(usage)

        # Extract content
        content = data.get("content", "") or data.get("choices", [{}])[0].get(
            "message", {}
        ).get("content", "")

        # Cache if applicable
        if texts and content:
            try:
                trans = json.loads(content)
                if isinstance(trans, list) and len(trans) == len(texts):
                    await cache.set(texts, lang, request.model, trans)
            except (json.JSONDecodeError, KeyError):
                pass

        return JSONResponse(
            content={
                "choices": [{"message": {"role": "assistant", "content": content}}],
                "model": request.model,
                "usage": usage,
            },
            headers={"X-Instance-ID": INSTANCE_ID},
        )

    except httpx.ConnectError:
        raise HTTPException(status_code=502, detail="Connection failed")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout")


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()

    host = args.host or get_lan_ip()
    print(f"{'=' * 50}\nPage Translator Middleware\n{'=' * 50}")
    print(f"Instance: {INSTANCE_ID} | Server: http://{host}:{args.port}")
    print(f"{'=' * 50}")

    uvicorn.run(
        "server:app", host=host, port=args.port, workers=args.workers, access_log=True
    )
