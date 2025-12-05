"""
Gemini Translation Server.
FastAPI server for HTML-aware translation using Google Gemini API.
"""

import asyncio
import hashlib
import json
import os
import re
import socket
import time
from collections import OrderedDict
from typing import Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

load_dotenv()

app = FastAPI(title="Gemini Translation Server")

# ============================================================================
# CONFIGURATION
# ============================================================================

MAX_RETRIES = 2
RETRY_DELAY = 0.5
CACHE_MAX_SIZE = 2000
CACHE_TTL = 3600  # 1 hour


# ============================================================================
# LRU CACHE
# ============================================================================


class TranslationCache:
    """Thread-safe LRU cache for translations."""

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
    """Token bucket rate limiter."""

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
ENGLISH_PATTERNS = re.compile(
    r"\b(the|and|is|are|was|were|have|has|been|will|would|could|should|"
    r"this|that|with|from|for|not|but|what|all|when|there|can|an|your|"
    r"which|their|said|each|she|do|how|if|its|about|into|than|them|"
    r"these|some|her|him|my|make|like|just|over|such|our|most|other|"
    r"click|here|more|see|read|view|next|back|home|page|link|button)\b",
    re.IGNORECASE,
)


def strip_html_tags(text: str) -> str:
    """Remove HTML tags from text for analysis."""
    return re.sub(r"<[^>]+>", "", text)


def detect_untranslated(original: str, translated: str, target_lang: str) -> bool:
    """
    Check if translation appears incomplete (still contains source language).
    Returns True if untranslated content is detected.
    """
    # Strip HTML for comparison
    orig_clean = strip_html_tags(original).lower().strip()
    trans_clean = strip_html_tags(translated).lower().strip()

    # If translation is identical to original, likely untranslated
    if orig_clean == trans_clean and len(orig_clean) > 3:
        return True

    # For non-Latin target languages, check for excessive English words
    non_latin_langs = [
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
        "tiếng việt",
        "日本語",
        "中文",
        "한국어",
        "ไทย",
        "العربية",
        "עברית",
        "हिन्दी",
        "русский",
    ]

    is_non_latin = any(lang in target_lang.lower() for lang in non_latin_langs)

    if is_non_latin:
        # Count English word matches in translated text
        matches = ENGLISH_PATTERNS.findall(trans_clean)
        words = trans_clean.split()
        if len(words) > 0 and len(matches) / max(len(words), 1) > 0.3:
            return True

    return False


def get_incomplete_indices(
    originals: List[str], translations: List[str], target_lang: str
) -> List[int]:
    """Find indices of translations that appear incomplete."""
    incomplete = []
    for i, (orig, trans) in enumerate(zip(originals, translations)):
        if detect_untranslated(orig, trans, target_lang):
            incomplete.append(i)
    return incomplete


# ============================================================================
# GEMINI API CALLS
# ============================================================================

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


def get_translation_prompt(target_lang: str) -> str:
    """Generate the translation system prompt."""
    return f"""You are a professional HTML-aware translator.

Task: Translate the JSON array of HTML fragments into {target_lang}.

RULES:
1. Translate TEXT CONTENT to {target_lang}, PRESERVE HTML tags in relative positions.
2. DO NOT translate HTML attributes (href, src, style, color, class, id).
3. PRESERVE all HTML tags exactly (<b>, <i>, <font>, <span>, <a>, <br>, etc.).
4. Maintain exact array length and order.
5. Return ONLY valid JSON array, no markdown blocks.
6. Escape quotes properly in JSON strings.

Example:
Input: ["Score <b><font color=\\"red\\">Big</font></b> Up!"]
Output ({target_lang}): Translate as complete phrase, keep tags around corresponding words.

Return ONLY the JSON array."""


def get_retry_prompt(incomplete_texts: List[str], target_lang: str) -> str:
    """Generate prompt for retrying incomplete translations."""
    return f"""Some translations were incomplete. Please translate these texts COMPLETELY to {target_lang}.

IMPORTANT: 
- These MUST be fully translated to {target_lang}
- Do NOT leave any English/source language words
- Preserve HTML tags but translate ALL text content

Input: {json.dumps(incomplete_texts)}

Return ONLY a valid JSON array with complete translations."""


async def call_gemini(
    model: str,
    contents: list,
    config: types.GenerateContentConfig,
    expected_len: int = None,
) -> tuple[str, bool, dict]:
    """Call Gemini API with retry logic for parse failures."""
    loop = asyncio.get_event_loop()
    response_text = None
    usage = None

    for attempt in range(MAX_RETRIES + 1):
        try:
            if attempt > 0:
                await asyncio.sleep(RETRY_DELAY)
                # Add repair context
                contents = contents.copy()
                contents.append(
                    types.Content(role="model", parts=[types.Part(text=response_text)])
                )
                contents.append(
                    types.Content(
                        role="user",
                        parts=[
                            types.Part(
                                text="Invalid JSON. Return ONLY a valid JSON array, no markdown."
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

            # Validate JSON
            parsed = json.loads(response_text)
            if isinstance(parsed, list):
                if expected_len is None or len(parsed) == expected_len:
                    return response_text, True, usage

        except json.JSONDecodeError:
            if attempt == MAX_RETRIES:
                return response_text, False, usage

    return response_text, False, usage


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
    """Translation endpoint with validation and retry for incomplete translations."""
    client_id = req.client.host if req.client else "unknown"

    # Rate limit
    allowed, wait = await limiter.acquire(client_id)
    if not allowed:
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
        user_content = None
        for msg in request.messages:
            if msg.get("role") == "user":
                user_content = msg.get("content", "")
                break

        # Parse texts
        texts_to_translate = None
        if user_content:
            try:
                texts_to_translate = json.loads(user_content)
                if isinstance(texts_to_translate, list):
                    # Check cache
                    cached = await cache.get(
                        texts_to_translate,
                        request.target_language or "English",
                        request.model,
                    )
                    if cached:
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

        # Build contents
        system_prompt = None
        contents = []

        if request.html_aware and request.target_language:
            system_prompt = get_translation_prompt(request.target_language)

        for msg in request.messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
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

        # Call API
        expected_len = len(texts_to_translate) if texts_to_translate else None
        response_text, success, usage = await call_gemini(
            request.model, contents, config, expected_len
        )

        # Validate translations for completeness
        if success and texts_to_translate and request.target_language:
            try:
                translations = json.loads(response_text)
                if isinstance(translations, list) and len(translations) == len(
                    texts_to_translate
                ):
                    # Check for incomplete translations
                    incomplete_idx = get_incomplete_indices(
                        texts_to_translate, translations, request.target_language
                    )

                    if incomplete_idx:
                        # Retry incomplete ones
                        incomplete_texts = [
                            texts_to_translate[i] for i in incomplete_idx
                        ]
                        retry_contents = [
                            types.Content(
                                role="user",
                                parts=[
                                    types.Part(
                                        text=get_retry_prompt(
                                            incomplete_texts, request.target_language
                                        )
                                    )
                                ],
                            )
                        ]

                        retry_text, retry_ok, _ = await call_gemini(
                            request.model, retry_contents, config, len(incomplete_texts)
                        )

                        if retry_ok:
                            retry_translations = json.loads(retry_text)
                            if len(retry_translations) == len(incomplete_idx):
                                # Merge fixed translations
                                for i, idx in enumerate(incomplete_idx):
                                    translations[idx] = retry_translations[i]
                                response_text = json.dumps(translations)

                    # Cache valid result
                    await cache.set(
                        texts_to_translate,
                        request.target_language,
                        request.model,
                        translations,
                    )
            except (json.JSONDecodeError, TypeError):
                pass

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
                        "prompt_tokens": usage.prompt_token_count,
                        "completion_tokens": usage.candidates_token_count,
                        "total_tokens": usage.total_token_count,
                    }
                    if usage
                    else None
                ),
            }
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    import uvicorn

    ip = get_lan_ip()
    port = 8001
    print(f"Server: http://{ip}:{port}")
    uvicorn.run(app, host=ip, port=port)
