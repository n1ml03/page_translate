"""
Page Translator Middleware.
FastAPI server that proxies translation requests to internal LLM API with streaming support.
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
from typing import AsyncGenerator, Dict, List, Optional

import requests
import urllib3
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = FastAPI(title="Page Translator Middleware")

# Configuration
CACHE_MAX_SIZE = 2000
CACHE_TTL = 3600
HTTP_TIMEOUT = 120
MAX_RETRIES = 2
RETRY_DELAY = 0.5

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
# TRANSLATION VALIDATION
# ============================================================================

# Common English words to detect untranslated text
ENGLISH_COMMON_WORDS = {
    "the", "a", "an", "this", "that", "these", "those", "my", "your", "his",
    "her", "its", "our", "their", "some", "any", "no", "every", "each", "all",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "them", "us",
    "who", "what", "which", "whom", "whose",
    "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might",
    "must", "can", "shall", "get", "got", "make", "made", "go", "went", "come",
    "came", "take", "took", "see", "saw", "know", "knew", "think", "thought",
    "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "down",
    "out", "into", "over", "under", "about", "after", "before", "between",
    "and", "or", "but", "if", "when", "where", "while", "because", "although",
    "than", "then", "so", "as", "not", "just", "only", "also", "even", "still",
    "click", "here", "more", "view", "read", "next", "back", "home", "page",
    "link", "button", "menu", "search", "login", "logout", "sign", "submit",
    "cancel", "save", "delete", "edit", "add", "remove", "close", "open",
    "settings", "profile", "account", "help", "contact", "about", "privacy",
    "terms", "loading", "error", "success", "warning", "info", "message",
}

ENGLISH_WORD_PATTERN = re.compile(r"\b[a-zA-Z]+\b")
ASCII_LETTER_PATTERN = re.compile(r"[a-zA-Z]")

NON_LATIN_LANGS = {
    "japanese", "chinese", "korean", "thai", "vietnamese", "arabic", "hebrew",
    "hindi", "russian", "greek", "persian", "bengali", "tamil", "telugu",
    "marathi", "gujarati", "kannada", "malayalam", "punjabi", "urdu",
    "tiếng việt", "日本語", "中文", "简体中文", "繁體中文", "한국어", "ไทย",
    "العربية", "עברית", "हिन्दी", "русский", "ελληνικά", "فارسی",
}

HTML_TAG_PATTERN = re.compile(r"<(/?)(\w+)([^>]*)>", re.IGNORECASE)
HTML_SELF_CLOSING_TAGS = {"br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"}


def strip_html_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text)


def extract_text_words(text: str) -> List[str]:
    clean_text = strip_html_tags(text)
    return [w.lower() for w in ENGLISH_WORD_PATTERN.findall(clean_text) if len(w) > 1]


def is_non_latin_target(target_lang: str) -> bool:
    return any(lang in target_lang.lower() for lang in NON_LATIN_LANGS)


def count_english_indicators(text: str) -> tuple[int, int]:
    words = extract_text_words(text)
    if not words:
        return 0, 0
    english_count = sum(1 for w in words if w in ENGLISH_COMMON_WORDS)
    return english_count, len(words)


def has_significant_ascii_content(text: str) -> bool:
    clean_text = strip_html_tags(text)
    if not clean_text:
        return False
    ascii_letters = len(ASCII_LETTER_PATTERN.findall(clean_text))
    total_chars = len(clean_text.replace(" ", ""))
    if total_chars == 0:
        return False
    return ascii_letters / total_chars > 0.5


def detect_untranslated(original: str, translated: str, target_lang: str) -> bool:
    orig_clean = strip_html_tags(original).strip()
    trans_clean = strip_html_tags(translated).strip()

    if not trans_clean and orig_clean:
        return True

    orig_lower = orig_clean.lower()
    trans_lower = trans_clean.lower()

    if orig_lower == trans_lower and len(orig_clean) > 2:
        return True

    if len(orig_lower) > 5 and len(trans_lower) > 5:
        common = sum(1 for c in orig_lower if c in trans_lower)
        similarity = common / max(len(orig_lower), len(trans_lower))
        if similarity > 0.85:
            return True

    if is_non_latin_target(target_lang):
        if has_significant_ascii_content(trans_clean):
            eng_count, total_count = count_english_indicators(trans_clean)
            if total_count > 0:
                if eng_count / total_count > 0.2:
                    return True
                if eng_count >= 3 and total_count < 10:
                    return True

        orig_words = set(extract_text_words(original))
        trans_words = set(extract_text_words(translated))
        common_words = orig_words & trans_words & ENGLISH_COMMON_WORDS
        if len(common_words) >= 2:
            return True

    return False


def extract_html_tags(text: str) -> List[tuple[str, str, bool]]:
    tags = []
    for match in HTML_TAG_PATTERN.finditer(text):
        is_closing = match.group(1) == "/"
        tag_name = match.group(2).lower()
        tags.append((tag_name, match.group(0), is_closing))
    return tags


def detect_residual_tags(original: str, translated: str) -> bool:
    orig_tags = extract_html_tags(original)
    trans_tags = extract_html_tags(translated)

    orig_tag_names = [t[0] for t in orig_tags]
    trans_tag_names = [t[0] for t in trans_tags]

    orig_paired = [t for t in orig_tag_names if t not in HTML_SELF_CLOSING_TAGS]
    trans_paired = [t for t in trans_tag_names if t not in HTML_SELF_CLOSING_TAGS]
    if sorted(orig_paired) != sorted(trans_paired):
        return True

    tag_stack = []
    for tag_name, _, is_closing in trans_tags:
        if tag_name in HTML_SELF_CLOSING_TAGS:
            continue
        if is_closing:
            if not tag_stack or tag_stack[-1] != tag_name:
                return True
            tag_stack.pop()
        else:
            tag_stack.append(tag_name)

    if tag_stack:
        return True

    broken_tag_pattern = re.compile(r"<[^>]*$|^[^<]*>|<[^a-zA-Z/]|<\s+\w")
    if broken_tag_pattern.search(translated):
        return True

    duplicate_pattern = re.compile(r"<(\w+)([^>]*)>\s*<\1[^>]*>", re.IGNORECASE)
    if duplicate_pattern.search(translated):
        return True

    empty_tag_pattern = re.compile(r"<(\w+)[^>]*>\s*</\1>", re.IGNORECASE)
    empty_matches = empty_tag_pattern.findall(translated)
    orig_empty = empty_tag_pattern.findall(original)
    if len(empty_matches) > len(orig_empty):
        return True

    return False


def validate_translation(original: str, translated: str, target_lang: str) -> tuple[bool, str]:
    if not translated:
        return False, "empty_translation"
    if detect_untranslated(original, translated, target_lang):
        return False, "untranslated"
    if detect_residual_tags(original, translated):
        return False, "residual_tags"
    return True, "ok"


def get_incomplete_indices(
    originals: List[str], translations: List[str], target_lang: str
) -> List[int]:
    incomplete = []
    for i, (orig, trans) in enumerate(zip(originals, translations)):
        is_valid, _ = validate_translation(orig, trans, target_lang)
        if not is_valid:
            incomplete.append(i)
    return incomplete


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
        is_html = "<html" in response_text.lower() or "<!doctype" in response_text.lower()
        if is_html:
            return "PROXY_HTML_ERROR", f"Proxy returned HTML error. {response_text[:200]}"
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
            ip = str(info[4][0])
            if is_private_ip(ip):
                return ip
    except socket.error:
        pass

    raise RuntimeError("Could not detect a valid LAN IP address.")


def get_retry_prompt(incomplete_texts: List[str], target_lang: str, issues: List[str]) -> str:
    issue_instructions = []
    if "untranslated" in issues:
        issue_instructions.append("- Translate ALL text content completely to " + target_lang)
        issue_instructions.append("- Do NOT leave any source language words untranslated")
        issue_instructions.append("- Common words like 'the', 'and', 'click', 'here' MUST be translated")
    if "residual_tags" in issues:
        issue_instructions.append("- Preserve HTML tag structure exactly as in original")
        issue_instructions.append("- Ensure all opening tags have matching closing tags")
        issue_instructions.append("- Do NOT duplicate, remove, or break HTML tags")
    if "empty_translation" in issues:
        issue_instructions.append("- Provide actual translated content, not empty strings")

    instructions = "\n".join(issue_instructions) if issue_instructions else "- Translate completely and preserve HTML structure"

    return f"""Previous translations had issues. Please fix and translate these texts to {target_lang}.

CRITICAL REQUIREMENTS:
{instructions}

Input: {json.dumps(incomplete_texts)}

Return ONLY a valid JSON array with corrected translations."""


# ============================================================================
# STREAMING JSON PARSER
# ============================================================================


class StreamingJSONArrayParser:
    """Parses a streaming JSON array and yields complete items as they arrive."""

    def __init__(self):
        self.buffer = ""
        self.in_array = False
        self.items_yielded = 0

    def feed(self, chunk: str) -> List[str]:
        self.buffer += chunk
        items = []

        if not self.in_array:
            start_idx = self.buffer.find("[")
            if start_idx != -1:
                self.in_array = True
                self.buffer = self.buffer[start_idx + 1 :]
            else:
                return items

        while self.buffer:
            self.buffer = self.buffer.lstrip()
            if not self.buffer:
                break

            if self.buffer.startswith("]"):
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
            char = self.buffer[i]
            if char == "\\":
                i += 2
                continue
            if char == '"':
                try:
                    parsed = json.loads(self.buffer[: i + 1])
                    return parsed, self.buffer[i + 1 :]
                except json.JSONDecodeError:
                    return None, self.buffer
            i += 1

        return None, self.buffer


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
    stream: bool = Field(default=False, description="Enable streaming response")


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
    texts_to_translate: Optional[List[str]],
    target_language: str,
) -> AsyncGenerator[str, None]:
    """Stream translations as Server-Sent Events."""
    headers = {
        "Authorization": generate_basic_auth_header(request.username, request.password),
        "Content-Type": "application/json",
    }
    payload = {
        "model": request.model,
        "messages": request.messages,
        "temperature": request.temperature,
        "stream": True,
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
                stream=True,
            ),
        )

        if not response.ok:
            error_type, error_message = categorize_error(
                response.status_code, response.text, request.model
            )
            yield f"data: {json.dumps({'error': {'type': error_type, 'message': error_message}})}\n\n"
            return

        parser = StreamingJSONArrayParser()
        all_translations = []

        for line in response.iter_lines(decode_unicode=True):
            if not line:
                continue

            if line.startswith("data: "):
                line = line[6:]

            if line == "[DONE]":
                break

            try:
                chunk_data = json.loads(line)
                content = ""

                if "choices" in chunk_data:
                    delta = chunk_data["choices"][0].get("delta", {})
                    content = delta.get("content", "")
                elif "content" in chunk_data:
                    content = chunk_data["content"]

                if content:
                    items = parser.feed(content)
                    for item in items:
                        all_translations.append(item)
                        yield f"data: {json.dumps({'index': len(all_translations) - 1, 'translation': item})}\n\n"

            except json.JSONDecodeError:
                continue

        if texts_to_translate and len(all_translations) == len(texts_to_translate):
            await cache.set(
                texts_to_translate, target_language, request.model, all_translations
            )

        yield f"data: {json.dumps({'done': True, 'total': len(all_translations)})}\n\n"

    except requests.exceptions.ConnectionError:
        yield f"data: {json.dumps({'error': {'type': 'CONNECTION_ERROR', 'message': 'Failed to connect to target API'}})}\n\n"
    except requests.exceptions.Timeout:
        yield f"data: {json.dumps({'error': {'type': 'TIMEOUT', 'message': 'Target API timeout'}})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': {'type': 'UNKNOWN_ERROR', 'message': str(e)}})}\n\n"


@app.post("/proxy/translate")
async def translate(request: TranslateRequest, req: Request):
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
            else:
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

    if request.stream:
        return StreamingResponse(
            stream_translations(request, texts_to_translate, target_language),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming request with validation and retry
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

            # Validate translations and retry if incomplete
            if texts_to_translate and "choices" in json_response:
                try:
                    content = json_response["choices"][0]["message"]["content"]
                    translations = json.loads(content)
                    if isinstance(translations, list) and len(translations) == len(texts_to_translate):
                        # Check for incomplete translations
                        incomplete_idx = get_incomplete_indices(
                            texts_to_translate, translations, target_language
                        )

                        if incomplete_idx:
                            # Collect issues for better retry prompt
                            incomplete_texts = []
                            issues = set()
                            for i in incomplete_idx:
                                incomplete_texts.append(texts_to_translate[i])
                                _, reason = validate_translation(
                                    texts_to_translate[i],
                                    translations[i],
                                    target_language,
                                )
                                issues.add(reason)

                            # Retry with focused prompt
                            retry_messages = [
                                {"role": "system", "content": get_retry_prompt(
                                    incomplete_texts, target_language, list(issues)
                                )},
                                {"role": "user", "content": json.dumps(incomplete_texts)}
                            ]
                            retry_payload = {
                                "model": request.model,
                                "messages": retry_messages,
                                "temperature": request.temperature,
                            }

                            retry_response = await loop.run_in_executor(
                                http_executor,
                                lambda: requests.post(
                                    request.target_endpoint,
                                    json=retry_payload,
                                    headers=headers,
                                    verify=False,
                                    timeout=HTTP_TIMEOUT,
                                ),
                            )

                            if retry_response.ok:
                                try:
                                    retry_json = retry_response.json()
                                    retry_content = retry_json["choices"][0]["message"]["content"]
                                    retry_translations = json.loads(retry_content)
                                    if len(retry_translations) == len(incomplete_idx):
                                        for i, idx in enumerate(incomplete_idx):
                                            translations[idx] = retry_translations[i]
                                        json_response["choices"][0]["message"]["content"] = json.dumps(translations)
                                except (json.JSONDecodeError, KeyError, IndexError):
                                    pass

                        # Cache valid result
                        await cache.set(
                            texts_to_translate,
                            target_language,
                            request.model,
                            translations,
                        )
                except (json.JSONDecodeError, KeyError, IndexError):
                    pass

            json_response["cached"] = False
            return JSONResponse(content=json_response, status_code=response.status_code)

        except requests.exceptions.JSONDecodeError:
            is_html = "<html" in response.text.lower() or "<!doctype" in response.text.lower()
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
