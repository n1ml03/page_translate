"""
Page Translator Middleware.
FastAPI server that proxies translation requests to internal LLM API.
"""

import asyncio
import base64
import hashlib
import json
import re
import socket
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

import requests
import urllib3
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = FastAPI(title="Page Translator Middleware")

# Configuration
CACHE_MAX_SIZE = 2000
CACHE_TTL = 3600
HTTP_TIMEOUT = 120

http_executor = ThreadPoolExecutor(max_workers=10)


# ============================================================================
# LRU CACHE
# ============================================================================


class TranslationCache:
    def __init__(self, max_size: int = CACHE_MAX_SIZE, ttl: int = CACHE_TTL):
        self.max_size = max_size
        self.ttl = ttl
        self._cache: OrderedDict = OrderedDict()
        self._lock = asyncio.Lock()

    def _key(self, texts: List[str], lang: str, model: str) -> str:
        data = json.dumps({"t": texts, "l": lang, "m": model}, sort_keys=True)
        return hashlib.sha256(data.encode()).hexdigest()

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
        self.rate = rpm / 60.0
        self.burst = burst
        self._tokens: Dict[str, float] = {}
        self._last: Dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, client: str = "global") -> tuple[bool, float]:
        async with self._lock:
            now = time.time()
            if client not in self._tokens:
                self._tokens[client] = self.burst
                self._last[client] = now

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
# HELPERS
# ============================================================================


def generate_basic_auth_header(username: str, password: str) -> str:
    credentials = f"{username}:{password}"
    encoded = base64.b64encode(credentials.encode("utf-8")).decode("utf-8")
    return f"Basic {encoded}"


def extract_target_language(messages: List[Dict[str, str]]) -> str:
    for msg in messages:
        if msg.get("role") == "system":
            match = re.search(r"into\s+(\w+)", msg.get("content", ""), re.IGNORECASE)
            if match:
                return match.group(1)
    return "English"


def extract_texts(messages: List[Dict[str, str]]) -> Optional[List[str]]:
    for msg in messages:
        if msg.get("role") == "user":
            try:
                texts = json.loads(msg.get("content", ""))
                if isinstance(texts, list):
                    return texts
            except (json.JSONDecodeError, TypeError):
                pass
    return None


def categorize_error(
    status_code: int, response_text: str, model: str
) -> tuple[str, str]:
    error_detail = ""
    try:
        error_json = json.loads(response_text)
        if isinstance(error_json, dict):
            error_detail = error_json.get("error", {})
            if isinstance(error_detail, dict):
                error_detail = error_detail.get("message", str(error_detail))
            else:
                error_detail = str(error_detail)
    except Exception:
        error_detail = response_text[:200] if response_text else "No response body"

    if status_code == 400:
        lower_text = response_text.lower()
        if "context_length_exceeded" in lower_text or "token" in lower_text:
            return "CONTEXT_LENGTH_EXCEEDED", f"Token limit exceeded. {error_detail}"
        if "model" in lower_text and (
            "not found" in lower_text or "invalid" in lower_text
        ):
            return "MODEL_NOT_FOUND", f"Model '{model}' not found. {error_detail}"
        return "BAD_REQUEST", f"Bad request: {error_detail}"

    if status_code == 404:
        return "MODEL_NOT_FOUND", f"Model '{model}' not found. {error_detail}"

    if status_code == 429:
        return "RATE_LIMIT_EXCEEDED", f"Rate limit exceeded. {error_detail}"

    if status_code in (502, 503):
        is_html = (
            "<html" in response_text.lower() or "<!doctype" in response_text.lower()
        )
        if is_html:
            return (
                "PROXY_HTML_ERROR",
                f"Proxy returned HTML error. {response_text[:200]}",
            )
        return "GATEWAY_ERROR", f"Gateway error: {error_detail}"

    if status_code == 504:
        return "GATEWAY_TIMEOUT", "Gateway timeout."

    if status_code == 401:
        return "UNAUTHORIZED", "Authentication failed."

    if status_code == 403:
        return "FORBIDDEN", "Access forbidden."

    if status_code >= 500:
        return "SERVER_ERROR", f"Server error ({status_code}): {error_detail}"

    return "UNKNOWN_ERROR", f"Unexpected error ({status_code}): {error_detail}"


def is_private_ip(ip: str) -> bool:
    if ip in ("0.0.0.0", "127.0.0.1"):
        return False
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        octets = [int(p) for p in parts]
    except ValueError:
        return False
    if octets[0] == 10:
        return True
    if octets[0] == 172 and 16 <= octets[1] <= 31:
        return True
    if octets[0] == 192 and octets[1] == 168:
        return True
    return False


def get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if is_private_ip(ip):
            return ip
    except (socket.error, OSError):
        pass

    try:
        hostname = socket.gethostname()
        ip = socket.gethostbyname(hostname)
        if is_private_ip(ip):
            return ip
    except socket.error:
        pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if is_private_ip(ip):
                return ip
    except socket.error:
        pass

    raise RuntimeError("Could not detect a valid LAN IP address.")


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
    target_endpoint: str = Field(..., description="Internal LLM API URL")
    username: str = Field(..., description="Username for Basic Auth")
    password: str = Field(..., description="Password for Basic Auth")
    model: str = Field(..., description="LLM model name")
    messages: List[Dict[str, str]] = Field(..., description="Chat messages")
    temperature: float = Field(default=0.3)


# ============================================================================
# ENDPOINTS
# ============================================================================


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/stats")
async def stats():
    return {"status": "ok", "cache": await cache.stats()}


@app.post("/proxy/translate")
async def translate(request: TranslateRequest, req: Request) -> JSONResponse:
    client_id = req.client.host if req.client else "unknown"

    allowed, wait = await limiter.acquire(client_id)
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={
                "error": {
                    "type": "RATE_LIMIT_EXCEEDED",
                    "message": f"Rate limited. Wait {wait:.1f}s",
                }
            },
        )

    texts_to_translate = extract_texts(request.messages)
    target_language = extract_target_language(request.messages)

    if texts_to_translate:
        cached = await cache.get(texts_to_translate, target_language, request.model)
        if cached:
            return JSONResponse(
                content={
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": json.dumps(cached),
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "model": request.model,
                    "cached": True,
                }
            )

    headers = {
        "Authorization": generate_basic_auth_header(request.username, request.password),
        "Content-Type": "application/json",
    }
    payload = {
        "model": request.model,
        "messages": request.messages,
        "temperature": request.temperature,
    }

    try:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            http_executor,
            lambda: requests.post(
                request.target_endpoint,
                json=payload,
                headers=headers,
                verify=False,
                timeout=HTTP_TIMEOUT,
            ),
        )

        if not response.ok:
            error_type, error_message = categorize_error(
                response.status_code, response.text, request.model
            )
            return JSONResponse(
                content={
                    "error": {
                        "type": error_type,
                        "message": error_message,
                        "status_code": response.status_code,
                    }
                },
                status_code=response.status_code,
            )

        try:
            json_response = response.json()

            if texts_to_translate and "choices" in json_response:
                try:
                    content = json_response["choices"][0]["message"]["content"]
                    translated = json.loads(content)
                    if isinstance(translated, list) and len(translated) == len(
                        texts_to_translate
                    ):
                        await cache.set(
                            texts_to_translate,
                            target_language,
                            request.model,
                            translated,
                        )
                except (json.JSONDecodeError, KeyError, IndexError):
                    pass

            json_response["cached"] = False
            return JSONResponse(content=json_response, status_code=response.status_code)

        except requests.exceptions.JSONDecodeError:
            is_html = (
                "<html" in response.text.lower() or "<!doctype" in response.text.lower()
            )
            error_type = "PROXY_HTML_RESPONSE" if is_html else "INVALID_JSON_RESPONSE"
            raise HTTPException(
                status_code=502, detail=f"{error_type}: Response is not valid JSON"
            )

    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=502, detail="Failed to connect to target API")

    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Target API timeout")


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import uvicorn

    ip = get_lan_ip()
    port = 8000
    print(f"Server: http://{ip}:{port}")
    uvicorn.run(app, host=ip, port=port)
