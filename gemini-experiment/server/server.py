"""
Gemini Translation Server.
FastAPI server for HTML-aware translation using Google Gemini API with streaming support.
"""

import asyncio
import hashlib
import json
import os
import re
import socket
import time
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

# Common English words to detect untranslated text (expanded list)
ENGLISH_COMMON_WORDS = {
    # Articles & determiners
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
    "some",
    "any",
    "no",
    "every",
    "each",
    "all",
    # Pronouns
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
    "whom",
    "whose",
    # Verbs (common)
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "can",
    "shall",
    "get",
    "got",
    "make",
    "made",
    "go",
    "went",
    "come",
    "came",
    "take",
    "took",
    "see",
    "saw",
    "know",
    "knew",
    "think",
    "thought",
    # Prepositions & conjunctions
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
    "into",
    "over",
    "under",
    "about",
    "after",
    "before",
    "between",
    "and",
    "or",
    "but",
    "if",
    "when",
    "where",
    "while",
    "because",
    "although",
    "than",
    "then",
    "so",
    "as",
    "not",
    "just",
    "only",
    "also",
    "even",
    "still",
    # Common nouns & UI terms
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
    "search",
    "login",
    "logout",
    "sign",
    "submit",
    "cancel",
    "save",
    "delete",
    "edit",
    "add",
    "remove",
    "close",
    "open",
    "settings",
    "profile",
    "account",
    "help",
    "contact",
    "about",
    "privacy",
    "terms",
    "loading",
    "error",
    "success",
    "warning",
    "info",
    "message",
}

ENGLISH_WORD_PATTERN = re.compile(r"\b[a-zA-Z]+\b")

# Pattern to detect ASCII-only content (likely English)
ASCII_LETTER_PATTERN = re.compile(r"[a-zA-Z]")

# Non-Latin target languages that should have minimal English
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
    "persian",
    "bengali",
    "tamil",
    "telugu",
    "marathi",
    "gujarati",
    "kannada",
    "malayalam",
    "punjabi",
    "urdu",
    "tiếng việt",
    "日本語",
    "中文",
    "简体中文",
    "繁體中文",
    "한국어",
    "ไทย",
    "العربية",
    "עברית",
    "हिन्दी",
    "русский",
    "ελληνικά",
    "فارسی",
}

# HTML tag pattern for extraction and validation
HTML_TAG_PATTERN = re.compile(r"<(/?)(\w+)([^>]*)>", re.IGNORECASE)
HTML_SELF_CLOSING_TAGS = {
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


def strip_html_tags(text: str) -> str:
    """Remove HTML tags from text for analysis."""
    return re.sub(r"<[^>]+>", "", text)


def extract_text_words(text: str) -> List[str]:
    """Extract words from text, excluding HTML tags."""
    clean_text = strip_html_tags(text)
    return [w.lower() for w in ENGLISH_WORD_PATTERN.findall(clean_text) if len(w) > 1]


def is_non_latin_target(target_lang: str) -> bool:
    """Check if target language uses non-Latin script."""
    return any(lang in target_lang.lower() for lang in NON_LATIN_LANGS)


def count_english_indicators(text: str) -> tuple[int, int]:
    """
    Count English word indicators in text.
    Returns (english_word_count, total_word_count).
    """
    words = extract_text_words(text)
    if not words:
        return 0, 0
    english_count = sum(1 for w in words if w in ENGLISH_COMMON_WORDS)
    return english_count, len(words)


def has_significant_ascii_content(text: str) -> bool:
    """Check if text has significant ASCII letter content (potential untranslated)."""
    clean_text = strip_html_tags(text)
    if not clean_text:
        return False
    ascii_letters = len(ASCII_LETTER_PATTERN.findall(clean_text))
    total_chars = len(clean_text.replace(" ", ""))
    if total_chars == 0:
        return False
    return ascii_letters / total_chars > 0.5


def detect_untranslated(original: str, translated: str, target_lang: str) -> bool:
    """
    Check if translation appears incomplete (still contains source language).
    Returns True if untranslated content is detected.
    """
    orig_clean = strip_html_tags(original).strip()
    trans_clean = strip_html_tags(translated).strip()

    # Empty translation
    if not trans_clean and orig_clean:
        return True

    orig_lower = orig_clean.lower()
    trans_lower = trans_clean.lower()

    # Identical content (case-insensitive) - likely untranslated
    if orig_lower == trans_lower and len(orig_clean) > 2:
        return True

    # Check for high similarity (>80% same characters)
    if len(orig_lower) > 5 and len(trans_lower) > 5:
        common = sum(1 for c in orig_lower if c in trans_lower)
        similarity = common / max(len(orig_lower), len(trans_lower))
        if similarity > 0.85:
            return True

    # For non-Latin targets, apply stricter checks
    if is_non_latin_target(target_lang):
        # Check for excessive ASCII content
        if has_significant_ascii_content(trans_clean):
            # Allow some ASCII (numbers, proper nouns), but flag if too much
            eng_count, total_count = count_english_indicators(trans_clean)
            if total_count > 0:
                # More than 20% common English words is suspicious
                if eng_count / total_count > 0.2:
                    return True
                # Or more than 3 common English words in short text
                if eng_count >= 3 and total_count < 10:
                    return True

        # Check if original English words are still present
        orig_words = set(extract_text_words(original))
        trans_words = set(extract_text_words(translated))
        common_words = orig_words & trans_words & ENGLISH_COMMON_WORDS
        if len(common_words) >= 2:
            return True

    return False


def extract_html_tags(text: str) -> List[tuple[str, str, bool]]:
    """
    Extract HTML tags from text.
    Returns list of (tag_name, full_match, is_closing).
    """
    tags = []
    for match in HTML_TAG_PATTERN.finditer(text):
        is_closing = match.group(1) == "/"
        tag_name = match.group(2).lower()
        tags.append((tag_name, match.group(0), is_closing))
    return tags


def detect_residual_tags(original: str, translated: str) -> bool:
    """
    Check for residual/malformed HTML tags in translation.
    Returns True if issues are detected.
    """
    orig_tags = extract_html_tags(original)
    trans_tags = extract_html_tags(translated)

    # Build tag structure for original
    orig_tag_names = [t[0] for t in orig_tags]
    trans_tag_names = [t[0] for t in trans_tags]

    # Check 1: Tag count mismatch (excluding self-closing)
    orig_paired = [t for t in orig_tag_names if t not in HTML_SELF_CLOSING_TAGS]
    trans_paired = [t for t in trans_tag_names if t not in HTML_SELF_CLOSING_TAGS]
    if sorted(orig_paired) != sorted(trans_paired):
        return True

    # Check 2: Validate tag balance in translation
    tag_stack = []
    for tag_name, _, is_closing in trans_tags:
        if tag_name in HTML_SELF_CLOSING_TAGS:
            continue
        if is_closing:
            if not tag_stack or tag_stack[-1] != tag_name:
                return True  # Mismatched closing tag
            tag_stack.pop()
        else:
            tag_stack.append(tag_name)

    if tag_stack:
        return True  # Unclosed tags

    # Check 3: Detect broken/partial tags
    broken_tag_pattern = re.compile(r"<[^>]*$|^[^<]*>|<[^a-zA-Z/]|<\s+\w")
    if broken_tag_pattern.search(translated):
        return True

    # Check 4: Detect duplicate adjacent tags (e.g., <b><b>)
    duplicate_pattern = re.compile(r"<(\w+)([^>]*)>\s*<\1[^>]*>", re.IGNORECASE)
    if duplicate_pattern.search(translated):
        return True

    # Check 5: Detect empty tag pairs (e.g., <b></b> with no content)
    empty_tag_pattern = re.compile(r"<(\w+)[^>]*>\s*</\1>", re.IGNORECASE)
    empty_matches = empty_tag_pattern.findall(translated)
    orig_empty = empty_tag_pattern.findall(original)
    if len(empty_matches) > len(orig_empty):
        return True

    return False


def validate_translation(
    original: str, translated: str, target_lang: str
) -> tuple[bool, str]:
    """
    Comprehensive validation of a translation.
    Returns (is_valid, reason).
    """
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
    """Find indices of translations that appear incomplete or have issues."""
    incomplete = []
    for i, (orig, trans) in enumerate(zip(originals, translations)):
        is_valid, _ = validate_translation(orig, trans, target_lang)
        if not is_valid:
            incomplete.append(i)
    return incomplete


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
        """Feed a chunk of data and return any complete items found."""
        self.buffer += chunk
        items = []

        # Find array start
        if not self.in_array:
            start_idx = self.buffer.find("[")
            if start_idx != -1:
                self.in_array = True
                self.buffer = self.buffer[start_idx + 1 :]
            else:
                return items

        # Parse items from buffer
        while self.buffer:
            self.buffer = self.buffer.lstrip()
            if not self.buffer:
                break

            # Check for array end
            if self.buffer.startswith("]"):
                break

            # Skip comma
            if self.buffer.startswith(","):
                self.buffer = self.buffer[1:].lstrip()
                continue

            # Try to parse a string item
            if self.buffer.startswith('"'):
                item, remaining = self._parse_string()
                if item is not None:
                    items.append(item)
                    self.items_yielded += 1
                    self.buffer = remaining
                else:
                    break  # Incomplete string, wait for more data
            else:
                # Not a string, might be incomplete or invalid
                break

        return items

    def _parse_string(self) -> tuple[Optional[str], str]:
        """Parse a JSON string from the buffer."""
        if not self.buffer.startswith('"'):
            return None, self.buffer

        i = 1
        while i < len(self.buffer):
            char = self.buffer[i]
            if char == "\\":
                i += 2  # Skip escaped character
                continue
            if char == '"':
                # Found end of string
                try:
                    parsed = json.loads(self.buffer[: i + 1])
                    return parsed, self.buffer[i + 1 :]
                except json.JSONDecodeError:
                    return None, self.buffer
            i += 1

        return None, self.buffer  # Incomplete string


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


def get_retry_prompt(
    incomplete_texts: List[str], target_lang: str, issues: List[str]
) -> str:
    """Generate prompt for retrying incomplete translations."""
    issue_instructions = []
    if "untranslated" in issues:
        issue_instructions.append(
            "- Translate ALL text content completely to " + target_lang
        )
        issue_instructions.append(
            "- Do NOT leave any source language words untranslated"
        )
        issue_instructions.append(
            "- Common words like 'the', 'and', 'click', 'here' MUST be translated"
        )
    if "residual_tags" in issues:
        issue_instructions.append(
            "- Preserve HTML tag structure exactly as in original"
        )
        issue_instructions.append(
            "- Ensure all opening tags have matching closing tags"
        )
        issue_instructions.append("- Do NOT duplicate, remove, or break HTML tags")
    if "empty_translation" in issues:
        issue_instructions.append(
            "- Provide actual translated content, not empty strings"
        )

    instructions = (
        "\n".join(issue_instructions)
        if issue_instructions
        else "- Translate completely and preserve HTML structure"
    )

    return f"""Previous translations had issues. Please fix and translate these texts to {target_lang}.

CRITICAL REQUIREMENTS:
{instructions}

Input: {json.dumps(incomplete_texts)}

Return ONLY a valid JSON array with corrected translations."""


async def call_gemini(
    model: str,
    contents: list,
    config: types.GenerateContentConfig,
    expected_len: Optional[int] = None,
    validate_json: bool = True,
) -> tuple[Optional[str], bool, Any]:
    """Call Gemini API with optional retry logic for JSON parse failures."""
    loop = asyncio.get_event_loop()
    response_text = None
    usage = None

    max_attempts = MAX_RETRIES + 1 if validate_json else 1

    for attempt in range(max_attempts):
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

            # Skip JSON validation for plain text mode
            if not validate_json:
                return response_text, True, usage

            # Validate JSON
            if response_text is not None:
                parsed = json.loads(response_text)
                if isinstance(parsed, list):
                    if expected_len is None or len(parsed) == expected_len:
                        return response_text, True, usage

        except json.JSONDecodeError:
            if attempt == max_attempts - 1:
                return response_text, False, usage

    return response_text, False, usage


async def call_gemini_streaming(
    model: str,
    contents: list,
    config: types.GenerateContentConfig,
) -> AsyncGenerator[str, None]:
    """Call Gemini API with streaming and yield chunks."""
    loop = asyncio.get_event_loop()

    def generate_stream():
        return client.models.generate_content_stream(
            model=model, contents=contents, config=config
        )

    stream = await loop.run_in_executor(None, generate_stream)

    for chunk in stream:
        if chunk.text:
            yield chunk.text


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
    texts_to_translate: List[str],
    contents: list,
    config: types.GenerateContentConfig,
) -> AsyncGenerator[str, None]:
    """Stream translations as Server-Sent Events."""
    try:
        parser = StreamingJSONArrayParser()
        all_translations = []

        async for chunk in call_gemini_streaming(request.model, contents, config):
            items = parser.feed(chunk)
            for item in items:
                all_translations.append(item)
                yield f"data: {json.dumps({'index': len(all_translations) - 1, 'translation': item})}\n\n"

        # Cache the complete translations
        if texts_to_translate and len(all_translations) == len(texts_to_translate):
            await cache.set(
                texts_to_translate,
                request.target_language or "English",
                request.model,
                all_translations,
            )

        yield f"data: {json.dumps({'done': True, 'total': len(all_translations)})}\n\n"

    except Exception as e:
        yield f"data: {json.dumps({'error': {'type': 'UNKNOWN_ERROR', 'message': str(e)}})}\n\n"


@app.post("/proxy/translate")
async def translate(request: TranslateRequest, req: Request):
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

        # Parse texts (only for html_aware mode)
        texts_to_translate = None
        if user_content and request.html_aware:
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
                        if request.stream:
                            # Stream cached items
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

        # Handle streaming request
        if request.stream and texts_to_translate:
            return StreamingResponse(
                stream_translations(request, texts_to_translate, contents, config),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

        # Non-streaming request (original behavior)
        expected_len = len(texts_to_translate) if texts_to_translate else None
        response_text, success, usage = await call_gemini(
            request.model,
            contents,
            config,
            expected_len,
            validate_json=request.html_aware,
        )

        # Validate translations for completeness
        if success and texts_to_translate and request.target_language and response_text:
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
                        # Collect issues for better retry prompt
                        incomplete_texts = []
                        issues = set()
                        for i in incomplete_idx:
                            incomplete_texts.append(texts_to_translate[i])
                            _, reason = validate_translation(
                                texts_to_translate[i],
                                translations[i],
                                request.target_language,
                            )
                            issues.add(reason)

                        retry_contents = [
                            types.Content(
                                role="user",
                                parts=[
                                    types.Part(
                                        text=get_retry_prompt(
                                            incomplete_texts,
                                            request.target_language,
                                            list(issues),
                                        )
                                    )
                                ],
                            )
                        ]

                        retry_text, retry_ok, _ = await call_gemini(
                            request.model, retry_contents, config, len(incomplete_texts)
                        )

                        if retry_ok and retry_text:
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
