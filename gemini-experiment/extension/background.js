// Background Script - Handles translation requests from content script with streaming support

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
  serverUrl: 'http://192.168.110.58:8001/proxy/translate',
  model: 'gemini-2.0-flash',
  targetLanguage: 'English'
};

// ============================================================================
// UTILITIES
// ============================================================================

function cleanMarkdownCodeBlocks(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/^```(?:json|javascript|js)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(result);
    });
  });
}

// ============================================================================
// PAYLOAD & RESPONSE
// ============================================================================

function constructPayload(batch, settings, stream = false) {
  return {
    model: settings.model || DEFAULT_SETTINGS.model,
    messages: [{ role: 'user', content: JSON.stringify(batch) }],
    temperature: 0.3,
    html_aware: true,
    target_language: settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage,
    stream
  };
}

function parseResponse(response) {
  if (!response?.choices?.[0]?.message) {
    throw new Error('Invalid response format');
  }

  const content = cleanMarkdownCodeBlocks(response.choices[0].message.content);
  const translations = JSON.parse(content);

  if (!Array.isArray(translations)) {
    throw new Error('Response is not an array');
  }

  return translations;
}

function parseErrorResponse(statusCode, data) {
  let type = 'UNKNOWN_ERROR';
  let message = `Request failed with status ${statusCode}`;
  let retryable = false;
  let retryAfterMs = 0;

  if (data?.error) {
    type = data.error.type || type;
    message = data.error.message || message;
  } else if (data?.detail) {
    message = data.detail;
  } else if (typeof data === 'string') {
    message = data;
  }

  switch (type) {
    case ERROR_TYPES.RATE_LIMIT_EXCEEDED:
      retryable = true;
      retryAfterMs = 5000;
      break;
    case ERROR_TYPES.GATEWAY_ERROR:
    case ERROR_TYPES.PROXY_HTML_ERROR:
      retryable = true;
      retryAfterMs = 3000;
      break;
    case ERROR_TYPES.CONTEXT_LENGTH_EXCEEDED:
    case ERROR_TYPES.MODEL_NOT_FOUND:
    case ERROR_TYPES.UNAUTHORIZED:
      retryable = false;
      break;
    default:
      retryable = statusCode >= 500;
      retryAfterMs = 2000;
  }

  return { type, message, statusCode, retryable, retryAfterMs };
}

// ============================================================================
// STREAMING API REQUEST
// ============================================================================

async function sendStreamingTranslationRequest(batch, settings, onTranslation) {
  const payload = constructPayload(batch, settings, true);

  const response = await fetch(settings.serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch { data = await response.text(); }
    const errorInfo = parseErrorResponse(response.status, data);
    throw new Error(formatErrorMessage(errorInfo));
  }

  const reader = response.body.getReader();
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

        if (parsed.error) {
          throw new Error(parsed.error.message || 'Translation error');
        }

        if (parsed.translation !== undefined && parsed.index !== undefined) {
          translations[parsed.index] = parsed.translation;
          onTranslation(parsed.index, parsed.translation, parsed.cached);
        }

        if (parsed.done) {
          return translations;
        }
      } catch (e) {
        if (e.message !== 'Translation error') {
          // JSON parse error, skip this line
          continue;
        }
        throw e;
      }
    }
  }

  return translations;
}

// ============================================================================
// NON-STREAMING API REQUEST (fallback)
// ============================================================================

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

        if (errorInfo.retryable && attempt < maxRetries) {
          await sleep(errorInfo.retryAfterMs);
          lastError = errorInfo;
          continue;
        }

        throw new Error(formatErrorMessage(errorInfo));
      }

      const data = await response.json();
      if (data.error) throw new Error(parseErrorResponse(200, data).message);

      return parseResponse(data);

    } catch (error) {
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        if (attempt < maxRetries) {
          await sleep(2000);
          lastError = error;
          continue;
        }
        throw new Error('Network error: Cannot connect to server');
      }
      throw error;
    }
  }

  throw lastError || new Error('Translation failed after retries');
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

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

// Store active ports for streaming communication
const activePorts = new Map();

async function handleStreamingTranslationRequest(request, port) {
  try {
    const settings = await getSettings();

    if (!settings.serverUrl) {
      throw new Error('Server URL not configured');
    }

    // Override targetLanguage if provided in request (for inline translator)
    if (request.targetLang) {
      settings.targetLanguage = request.targetLang;
    }

    await sendStreamingTranslationRequest(
      request.batch,
      settings,
      (index, translation, cached) => {
        port.postMessage({
          type: 'translation',
          index,
          translation,
          cached: !!cached
        });
      }
    );

    port.postMessage({ type: 'done' });
  } catch (error) {
    port.postMessage({ type: 'error', error: error.message });
  }
}

async function handleTranslationRequest(request) {
  try {
    const settings = await getSettings();

    if (!settings.serverUrl) {
      throw new Error('Server URL not configured');
    }

    const translations = await sendTranslationRequest(request.batch, settings);
    return { translations };
  } catch (error) {
    return { error: error.message };
  }
}

// Handle long-lived connections for streaming
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate-stream') return;

  const portId = Date.now() + Math.random();
  activePorts.set(portId, port);

  port.onMessage.addListener((request) => {
    if (request.type === 'translate' && request.batch) {
      handleStreamingTranslationRequest(request, port);
    }
  });

  port.onDisconnect.addListener(() => {
    activePorts.delete(portId);
  });
});

// Handle simple one-shot messages (fallback for non-streaming)
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'translate' && request.batch) {
    handleTranslationRequest(request)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cleanMarkdownCodeBlocks,
    constructPayload,
    parseResponse,
    sendTranslationRequest,
    handleTranslationRequest
  };
}
