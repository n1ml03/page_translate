// Background Script - Translation requests with streaming support
importScripts('crypto.js');

const DEFAULT_SETTINGS = {
  proxyUrl: 'http://localhost:8000/proxy/translate',
  targetEndpoint: 'https://llm.api.local/chatapp/api/41_mini',
  username: '',
  encryptedPassword: '',
  model: '41-mini',
  targetLanguage: 'English'
};

// Language code to full name mapping (fallback for short codes)
const LANG_MAP = {
  'ja': 'Japanese',
  'en': 'English',
  'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  'ko': 'Korean',
  'vi': 'Vietnamese'
};

// Convert language code to full name for AI prompt
const getLanguageName = code => LANG_MAP[code] || code;

// ============================================================================
// UTILITIES
// ============================================================================

const cleanMarkdown = text => typeof text === 'string' 
  ? text.replace(/^```(?:json|javascript|js)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim() 
  : text;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, async result => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      let password = '';
      if (result.encryptedPassword) {
        password = await CryptoModule.decrypt(result.encryptedPassword);
      } else if (result.password) {
        password = result.password;
      }
      resolve({ ...result, password });
    });
  });
}

// ============================================================================
// PAYLOAD CONSTRUCTION - New API Format
// ============================================================================

function buildPayload(batch, settings, stream = false) {
  const systemPrompt = `You are a professional web translator.
Task: Translate the following JSON array of strings into ${settings.targetLanguage}.
Input: A JSON array of strings.
Output: Render ONLY a valid JSON array of translated strings.
Rules:
1. Maintain exact array length and order.
2. Translate in context.
3. Keep the output valid JSON. Escape all double quotes within strings correctly.
4. Do NOT output Markdown code blocks.
5. Do NOT add any conversational text.`;

  return {
    target_endpoint: settings.targetEndpoint,
    username: settings.username,
    password: settings.password,
    model: settings.model,
    system_prompt: systemPrompt,
    user_input: JSON.stringify(batch),
    temperature: 0.3,
    top_p: 0.9,
    stream
  };
}

function buildInlinePayload(text, settings) {
  return {
    target_endpoint: settings.targetEndpoint,
    username: settings.username,
    password: settings.password,
    model: settings.model,
    system_prompt: `Translate the following text to ${settings.targetLanguage}. Preserve exact formatting - keep all line breaks and spacing. Return only the translation.`,
    user_input: text,
    temperature: 0.3,
    top_p: 0.9,
    stream: false
  };
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

function parseError(status, data) {
  const type = data?.error?.type || 'UNKNOWN';
  const message = data?.error?.message || (typeof data === 'string' ? data : `Error ${status}`);
  const retryable = ['RATE_LIMIT', 'GATEWAY_ERROR'].includes(type) || status >= 500;
  return { type, message, retryable, retryMs: type === 'RATE_LIMIT' ? 5000 : 2000 };
}

function formatError(err) {
  const msgs = {
    CONTEXT_LENGTH_EXCEEDED: 'Token limit exceeded',
    RATE_LIMIT: 'Rate limit hit',
    MODEL_NOT_FOUND: 'Model not found',
    UNAUTHORIZED: 'Auth failed'
  };
  return msgs[err.type] || err.message;
}

// ============================================================================
// STREAMING REQUEST
// ============================================================================

async function streamTranslation(batch, settings, onTranslation, options = {}) {
  // Inline translator uses non-streaming
  if (options.preserveFormat && batch.length === 1) {
    const res = await fetch(settings.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildInlinePayload(batch[0], settings))
    });
    if (!res.ok) {
      const data = await res.json().catch(() => res.text());
      throw new Error(formatError(parseError(res.status, data)));
    }
    const data = await res.json();
    const translation = data.choices?.[0]?.message?.content || '';
    onTranslation(0, translation, false);
    return [translation];
  }

  // Streaming for page translation
  const res = await fetch(settings.proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPayload(batch, settings, true))
  });

  if (!res.ok) {
    const data = await res.json().catch(() => res.text());
    throw new Error(formatError(parseError(res.status, data)));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const translations = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data) continue;

      try {
        const parsed = JSON.parse(data);
        if (parsed.error) throw new Error(parsed.error.message || 'Translation error');
        if (parsed.translation !== undefined && parsed.index !== undefined) {
          translations[parsed.index] = parsed.translation;
          onTranslation(parsed.index, parsed.translation, parsed.cached);
        }
        if (parsed.done) return translations;
      } catch (e) {
        if (e.message === 'Translation error') throw e;
      }
    }
  }
  return translations;
}

// ============================================================================
// NON-STREAMING REQUEST
// ============================================================================

async function sendRequest(batch, settings, retries = 2) {
  const payload = buildPayload(batch, settings, false);
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(settings.proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json().catch(() => res.text());
        const err = parseError(res.status, data);
        if (err.retryable && i < retries) {
          await sleep(err.retryMs);
          lastErr = err;
          continue;
        }
        throw new Error(formatError(err));
      }

      const data = await res.json();
      if (data.error) throw new Error(parseError(200, data).message);

      const content = cleanMarkdown(data.choices?.[0]?.message?.content);
      const translations = JSON.parse(content);
      if (!Array.isArray(translations)) throw new Error('Response is not an array');
      return translations;

    } catch (e) {
      if (e.name === 'TypeError' && e.message.includes('fetch')) {
        if (i < retries) { await sleep(2000); lastErr = e; continue; }
        throw new Error('Cannot connect to server');
      }
      throw e;
    }
  }
  throw lastErr || new Error('Translation failed');
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

// Track active streaming connections for cleanup
const activePorts = new Map();

async function handleStreaming(request, port, portId) {
  try {
    const settings = await getSettings();
    if (!settings.targetEndpoint) throw new Error('Target endpoint not configured');
    if (!settings.username || !settings.password) throw new Error('Credentials not configured');
    // Convert language code to full name for AI prompt
    if (request.targetLang) settings.targetLanguage = getLanguageName(request.targetLang);

    await streamTranslation(request.batch, settings, (idx, trans, cached) => {
      // Check if port still active before sending
      if (activePorts.has(portId)) {
        try {
          port.postMessage({ type: 'translation', index: idx, translation: trans, cached: !!cached });
        } catch (e) {
          // Port disconnected, clean up
          activePorts.delete(portId);
        }
      }
    }, { preserveFormat: request.preserveFormat || false });

    if (activePorts.has(portId)) {
      port.postMessage({ type: 'done' });
    }
  } catch (e) {
    if (activePorts.has(portId)) {
      try {
        port.postMessage({ type: 'error', error: e.message });
      } catch { /* Port already disconnected */ }
    }
  }
}

async function handleTranslation(request) {
  try {
    const settings = await getSettings();
    if (!settings.targetEndpoint) throw new Error('Target endpoint not configured');
    if (!settings.username || !settings.password) throw new Error('Credentials not configured');
    return { translations: await sendRequest(request.batch, settings) };
  } catch (e) {
    return { error: e.message };
  }
}

async function handleInline(request) {
  try {
    const settings = await getSettings();
    if (!settings.targetEndpoint) throw new Error('Configure target endpoint in settings');
    if (!settings.username || !settings.password) throw new Error('Configure credentials in settings');
    
    const lang = request.targetLanguage || settings.targetLanguage;
    const translations = await sendRequest([request.text], { ...settings, targetLanguage: lang });
    return translations?.length > 0 ? { translation: translations[0] } : { error: 'No translation' };
  } catch (e) {
    return { error: e.message };
  }
}

// Long-lived connections for streaming
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'translate-stream') return;
  const portId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activePorts.set(portId, port);
  
  port.onMessage.addListener(req => {
    if (req.type === 'translate' && req.batch) {
      handleStreaming(req, port, portId);
    }
  });
  
  port.onDisconnect.addListener(() => {
    activePorts.delete(portId);
  });
});

// One-shot messages
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.type === 'translate' && req.batch) {
    handleTranslation(req).then(sendResponse);
    return true;
  }
  if (req.type === 'translateInline' && req.text) {
    handleInline(req).then(sendResponse);
    return true;
  }
});
