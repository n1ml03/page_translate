"""
Gemini Translation Server
FastAPI server for HTML-aware translation using Google Gemini API with streaming support.
"""

import asyncio
import hashlib
import json
import os
import re
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
# TRANSLATION VALIDATION
# ============================================================================
ENGLISH_COMMON_WORDS = {
    "the",
    "a",
    "an",
    "this",
    "that",
    "these",
    "those",
    "my",
    "your",
    "his",
    "her",
    "its",
    "our",
    "their",
    "i",
    "you",
    "he",
    "she",
    "it",
    "we",
    "they",
    "me",
    "him",
    "them",
    "us",
    "who",
    "what",
    "which",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "up",
    "down",
    "out",
    "and",
    "or",
    "but",
    "click",
    "here",
    "more",
    "view",
    "read",
    "next",
    "back",
    "home",
    "page",
    "link",
    "button",
    "menu",
}
ENGLISH_WORD_PATTERN = re.compile(r"\b[a-zA-Z]+\b")
ASCII_LETTER_PATTERN = re.compile(r"[a-zA-Z]")
NON_LATIN_LANGS = {
    "japanese",
    "chinese",
    "korean",
    "thai",
    "vietnamese",
    "arabic",
    "hebrew",
    "hindi",
    "russian",
    "greek",
    "日本語",
    "中文",
    "한국어",
    "tiếng việt",
}
HTML_TAG_PATTERN = re.compile(r"<(/?)(\w+)([^>]*)>", re.IGNORECASE)
HTML_SELF_CLOSING = {
    "br",
    "hr",
    "img",
    "input",
    "meta",
    "link",
    "area",
    "base",
    "col",
    "embed",
    "source",
    "track",
    "wbr",
}


def strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text)


def extract_words(text: str) -> List[str]:
    return [
        w.lower() for w in ENGLISH_WORD_PATTERN.findall(strip_html(text)) if len(w) > 1
    ]


def is_non_latin(lang: str) -> bool:
    return any(l in lang.lower() for l in NON_LATIN_LANGS)


def detect_untranslated(orig: str, trans: str, lang: str) -> bool:
    orig_clean, trans_clean = strip_html(orig).strip(), strip_html(trans).strip()
    if not trans_clean and orig_clean:
        return True
    if orig_clean.lower() == trans_clean.lower() and len(orig_clean) > 2:
        return True
    if len(orig_clean) > 5 and len(trans_clean) > 5:
        common = sum(1 for c in orig_clean.lower() if c in trans_clean.lower())
        if common / max(len(orig_clean), len(trans_clean)) > 0.85:
            return True
    if is_non_latin(lang):
        ascii_ratio = len(ASCII_LETTER_PATTERN.findall(trans_clean)) / max(
            len(trans_clean.replace(" ", "")), 1
        )
        if ascii_ratio > 0.5:
            words = extract_words(trans_clean)
            eng_count = sum(1 for w in words if w in ENGLISH_COMMON_WORDS)
            if words and eng_count / len(words) > 0.2:
                return True
    return False


def detect_residual_tags(orig: str, trans: str) -> bool:
    orig_tags = [
        m[1].lower()
        for m in HTML_TAG_PATTERN.findall(orig)
        if m[1].lower() not in HTML_SELF_CLOSING
    ]
    trans_tags = [
        m[1].lower()
        for m in HTML_TAG_PATTERN.findall(trans)
        if m[1].lower() not in HTML_SELF_CLOSING
    ]
    if sorted(orig_tags) != sorted(trans_tags):
        return True
    stack = []
    for match in HTML_TAG_PATTERN.finditer(trans):
        is_closing, tag = match.group(1) == "/", match.group(2).lower()
        if tag in HTML_SELF_CLOSING:
            continue
        if is_closing:
            if not stack or stack[-1] != tag:
                return True
            stack.pop()
        else:
            stack.append(tag)
    return bool(stack)


def validate_translation(orig: str, trans: str, lang: str) -> tuple[bool, str]:
    if not trans:
        return False, "empty"
    if detect_untranslated(orig, trans, lang):
        return False, "untranslated"
    if detect_residual_tags(orig, trans):
        return False, "residual_tags"
    return True, "ok"


def get_incomplete_indices(
    originals: List[str], translations: List[str], lang: str
) -> List[int]:
    return [
        i
        for i, (o, t) in enumerate(zip(originals, translations))
        if not validate_translation(o, t, lang)[0]
    ]


# ============================================================================
# STREAMING JSON PARSER
# ============================================================================
class StreamingJSONArrayParser:
    def __init__(self):
        self.buffer, self.in_array, self.items_yielded = "", False, 0

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
                    self.items_yielded += 1
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


def get_retry_prompt(texts: List[str], lang: str, issues: List[str]) -> str:
    instructions = []
    if "untranslated" in issues:
        instructions.extend(
            [
                f"- Translate ALL text completely to {lang}",
                "- Do NOT leave source language words",
            ]
        )
    if "residual_tags" in issues:
        instructions.extend(
            [
                "- Preserve HTML tag structure exactly",
                "- Ensure matching opening/closing tags",
            ]
        )
    if "empty" in issues:
        instructions.append("- Provide actual translated content")
    return f"""Fix and translate these texts to {lang}.
CRITICAL:
{chr(10).join(instructions) or '- Translate completely and preserve HTML'}
Input: {json.dumps(texts)}
Return ONLY a valid JSON array."""


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
        parser = StreamingJSONArrayParser()
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

        # Build contents
        system_prompt = (
            get_translation_prompt(request.target_language)
            if request.html_aware and request.target_language
            else None
        )
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

        # Validate and retry incomplete translations
        if success and texts_to_translate and request.target_language and response_text:
            try:
                translations = json.loads(response_text)
                if isinstance(translations, list) and len(translations) == len(
                    texts_to_translate
                ):
                    incomplete_idx = get_incomplete_indices(
                        texts_to_translate, translations, request.target_language
                    )
                    retried = False
                    if incomplete_idx:
                        issues = set(
                            validate_translation(
                                texts_to_translate[i],
                                translations[i],
                                request.target_language,
                            )[1]
                            for i in incomplete_idx
                        )
                        log_validation(instance_id, len(incomplete_idx), list(issues))
                        retry_contents = [
                            types.Content(
                                role="user",
                                parts=[
                                    types.Part(
                                        text=get_retry_prompt(
                                            [
                                                texts_to_translate[i]
                                                for i in incomplete_idx
                                            ],
                                            request.target_language,
                                            list(issues),
                                        )
                                    )
                                ],
                            )
                        ]
                        retry_text, retry_ok, _ = await call_gemini(
                            request.model,
                            retry_contents,
                            config,
                            len(incomplete_idx),
                            instance_id=instance_id,
                        )
                        if retry_ok and retry_text:
                            retry_translations = json.loads(retry_text)
                            if len(retry_translations) == len(incomplete_idx):
                                for i, idx in enumerate(incomplete_idx):
                                    translations[idx] = retry_translations[i]
                                response_text = json.dumps(translations)
                                retried = True
                    await cache.set(
                        texts_to_translate,
                        request.target_language,
                        request.model,
                        translations,
                    )
                    log_response(
                        instance_id,
                        len(translations),
                        (time.time() - start_time) * 1000,
                        retried=retried,
                    )
            except (json.JSONDecodeError, TypeError):
                pass

        duration_ms = (time.time() - start_time) * 1000
        if not texts_to_translate:
            log_response(instance_id, 1, duration_ms)

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
    retried: bool = False,
):
    status = "CACHED" if cached else ("RETRIED" if retried else "OK")
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


def log_validation(instance_id: str, count: int, issues: List[str]):
    print(f"[{instance_id}] VAL | incomplete={count} | issues={','.join(issues)}")


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
