// Background Script - Translation requests with streaming support

const ERROR_TYPES = {
  CONTEXT_LENGTH_EXCEEDED: 'CONTEXT_LENGTH_EXCEEDED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  PROXY_HTML_ERROR: 'PROXY_HTML_ERROR',
  GATEWAY_ERROR: 'GATEWAY_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  CONNECTION_ERROR: 'CONNECTION_ERROR'
};

const DEFAULT_SETTINGS = {
  serverUrl: 'http://localhost:8001/proxy/translate',
  model: 'gemini-2.0-flash',
  targetLanguage: 'English'
};

const LANG_CODE_TO_NAME = {
  'ja': 'Japanese', 'en': 'English', 'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)', 'ko': 'Korean', 'vi': 'Vietnamese'
};

function cleanMarkdownCodeBlocks(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/^```(?:json|javascript|js)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, result => {
      chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(result);
    });
  });
}

function normalizeLanguage(lang) { return LANG_CODE_TO_NAME[lang] || lang; }

function constructPayload(batch, settings, stream = false, options = {}) {
  const targetLang = normalizeLanguage(settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage);
  const isInlineTranslator = options.preserveFormat && batch.length === 1;
  
  if (isInlineTranslator) {
    const hasPlaceholders = /\{\{\/?(\d+|br)\}\}/.test(batch[0]);
    const prompt = hasPlaceholders
      ? `Translate the following text to ${targetLang}. 
CRITICAL RULES:
1. Preserve ALL placeholders like {{0}}, {{/0}}, {{1}}, {{/1}}, {{br}} EXACTLY as they appear.
2. These placeholders represent HTML formatting - keep them in the same relative position around translated words.
3. Keep all line breaks and paragraph spacing.
4. Return ONLY the translation, no explanations.
Example: "Hello {{0}}World{{/0}}" → "Bonjour {{0}}Monde{{/0}}"`
      : `Translate the following text to ${targetLang}. IMPORTANT: Preserve exact formatting - keep all line breaks, paragraph spacing, and special characters exactly as in the original. Return only the translation.`;
    
    return {
      model: settings.model || DEFAULT_SETTINGS.model,
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: batch[0] }],
      temperature: 0.3,
      html_aware: false,
      stream
    };
  }
  
  const payload = {
    model: settings.model || DEFAULT_SETTINGS.model,
    messages: [
      { 
        role: 'system', 
        content: `You are a professional web translator.
Task: Translate the following JSON array of strings into ${targetLang}.
Input: A JSON array of strings.
Output: Render ONLY a valid JSON array of translated strings.
Rules:
1. Maintain exact array length and order.
2. Translate in context.
3. Keep the output valid JSON. Escape all double quotes within strings correctly.
4. Do NOT output Markdown code blocks.
5. Do NOT add any conversational text.
6. The input text may contain placeholders like {{0}}, {{/0}}, {{br}}. These represent HTML tags.
   - You MUST preserve them exactly in the translation.
   - You MUST place the translated text INSIDE the corresponding tags if they wrap content.
   - Example: "Hello {{0}}World{{/0}}" -> "Bonjour {{0}}Monde{{/0}}".`
      },
      { role: 'user', content: JSON.stringify(batch) }
    ],
    temperature: 0.3,
    html_aware: true,
    target_language: targetLang,
    stream
  };
  
  if (options.useMasking) payload.use_masking = true;
  return payload;
}

function parseResponse(response) {
  if (!response?.choices?.[0]?.message) throw new Error('Invalid response format');
  const content = cleanMarkdownCodeBlocks(response.choices[0].message.content);
  const translations = JSON.parse(content);
  if (!Array.isArray(translations)) throw new Error('Response is not an array');
  return translations;
}

function parseErrorResponse(statusCode, data) {
  let type = 'UNKNOWN_ERROR', message = `Request failed with status ${statusCode}`, retryable = false, retryAfterMs = 0;

  if (data?.error) { type = data.error.type || type; message = data.error.message || message; }
  else if (data?.detail) message = data.detail;
  else if (typeof data === 'string') message = data;

  switch (type) {
    case ERROR_TYPES.RATE_LIMIT_EXCEEDED: retryable = true; retryAfterMs = 5000; break;
    case ERROR_TYPES.GATEWAY_ERROR:
    case ERROR_TYPES.PROXY_HTML_ERROR: retryable = true; retryAfterMs = 3000; break;
    case ERROR_TYPES.CONTEXT_LENGTH_EXCEEDED:
    case ERROR_TYPES.MODEL_NOT_FOUND:
    case ERROR_TYPES.UNAUTHORIZED: retryable = false; break;
    default: retryable = statusCode >= 500; retryAfterMs = 2000;
  }

  return { type, message, statusCode, retryable, retryAfterMs };
}

function formatErrorMessage(errorInfo) {
  const messages = {
    [ERROR_TYPES.CONTEXT_LENGTH_EXCEEDED]: 'Token limit exceeded. Reduce batch size.',
    [ERROR_TYPES.RATE_LIMIT_EXCEEDED]: 'Rate limit hit. Please wait.',
    [ERROR_TYPES.MODEL_NOT_FOUND]: 'Model not found. Check settings.',
    [ERROR_TYPES.PROXY_HTML_ERROR]: 'Server unavailable.'
  };
  return messages[errorInfo.type] || errorInfo.message;
}

async function sendStreamingTranslationRequest(batch, settings, onTranslation, options = {}) {
  const isInlineTranslator = options.preserveFormat && batch.length === 1;
  
  if (isInlineTranslator) {
    const payload = constructPayload(batch, settings, false, options);
    const response = await fetch(settings.serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch { data = await response.text(); }
      throw new Error(formatErrorMessage(parseErrorResponse(response.status, data)));
    }

    const data = await response.json();
    const translation = data.choices?.[0]?.message?.content || '';
    onTranslation(0, translation, false);
    return [translation];
  }
  
  const payload = constructPayload(batch, settings, true, options);
  const response = await fetch(settings.serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch { data = await response.text(); }
    throw new Error(formatErrorMessage(parseErrorResponse(response.status, data)));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const translations = [];

  function processLine(line) {
    if (!line.startsWith('data: ')) return null;
    const data = line.slice(6).trim();
    if (!data) return null;

    try {
      const parsed = JSON.parse(data);
      if (parsed.error) throw new Error(parsed.error.message || 'Translation error');
      if (parsed.translation !== undefined && parsed.index !== undefined) {
        translations[parsed.index] = parsed.translation;
        onTranslation(parsed.index, parsed.translation, parsed.cached);
      }
      if (parsed.done) return 'done';
    } catch (e) {
      if (e.message !== 'Translation error') return null;
      throw e;
    }
    return null;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (processLine(line) === 'done') return translations;
    }
  }

  if (buffer.trim() && processLine(buffer) === 'done') return translations;
  return translations;
}

async function sendTranslationRequest(batch, settings, maxRetries = 2) {
  const payload = constructPayload(batch, settings, false);
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(settings.serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let data;
        try { data = await response.json(); } catch { data = await response.text(); }
        const errorInfo = parseErrorResponse(response.status, data);
        if (errorInfo.retryable && attempt < maxRetries) { await sleep(errorInfo.retryAfterMs); lastError = errorInfo; continue; }
        throw new Error(formatErrorMessage(errorInfo));
      }

      const data = await response.json();
      if (data.error) throw new Error(parseErrorResponse(200, data).message);
      return parseResponse(data);
    } catch (error) {
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        if (attempt < maxRetries) { await sleep(2000); lastError = error; continue; }
        throw new Error('Network error: Cannot connect to server');
      }
      throw error;
    }
  }

  throw lastError || new Error('Translation failed after retries');
}

const activePorts = new Map();

async function handleStreamingTranslationRequest(request, port) {
  try {
    const settings = await getSettings();
    if (!settings.serverUrl) throw new Error('Server URL not configured');
    if (request.targetLang) settings.targetLanguage = request.targetLang;

    await sendStreamingTranslationRequest(
      request.batch,
      settings,
      (index, translation, cached) => port.postMessage({ type: 'translation', index, translation, cached: !!cached }),
      { preserveFormat: request.preserveFormat || false, useMasking: request.useMasking || false }
    );
    port.postMessage({ type: 'done' });
  } catch (error) {
    port.postMessage({ type: 'error', error: error.message });
  }
}

async function handleTranslationRequest(request) {
  try {
    const settings = await getSettings();
    if (!settings.serverUrl) throw new Error('Server URL not configured');
    return { translations: await sendTranslationRequest(request.batch, settings) };
  } catch (error) {
    return { error: error.message };
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'translate-stream') return;

  const portId = Date.now() + Math.random();
  activePorts.set(portId, port);

  port.onMessage.addListener(request => {
    if (request.type === 'translate' && request.batch) handleStreamingTranslationRequest(request, port);
  });

  port.onDisconnect.addListener(() => activePorts.delete(portId));
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'translate' && request.batch) {
    handleTranslationRequest(request).then(sendResponse).catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { cleanMarkdownCodeBlocks, constructPayload, parseResponse, sendTranslationRequest, handleTranslationRequest };
}
