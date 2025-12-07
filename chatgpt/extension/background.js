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
  proxyUrl: 'http://localhost:8000/proxy/translate',
  targetEndpoint: '',
  username: '',
  encryptedPassword: '',
  model: '41-mini',
  targetLanguage: 'English'
};

// ============================================================================
// CRYPTO MODULE (Embedded for Service Worker compatibility)
// ============================================================================

const CryptoModule = (() => {
  const SALT = 'page-translator-v1';
  const ITERATIONS = 100000;
  const KEY_LENGTH = 256;

  async function getDeviceKey() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ _deviceKey: null }, async (result) => {
        if (result._deviceKey) {
          resolve(result._deviceKey);
        } else {
          const array = new Uint8Array(32);
          crypto.getRandomValues(array);
          const key = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
          await chrome.storage.local.set({ _deviceKey: key });
          resolve(key);
        }
      });
    });
  }

  async function deriveKey(deviceKey) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(deviceKey),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode(SALT),
        iterations: ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function decrypt(encryptedBase64) {
    if (!encryptedBase64) return '';
    
    try {
      const deviceKey = await getDeviceKey();
      const key = await deriveKey(deviceKey);
      
      const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const encrypted = combined.slice(12);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encrypted
      );

      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (error) {
      console.error('[Crypto] Decryption failed:', error);
      return '';
    }
  }

  return { decrypt };
})();

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

async function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, async (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      
      // Decrypt password
      let password = '';
      if (result.encryptedPassword) {
        password = await CryptoModule.decrypt(result.encryptedPassword);
      } else if (result.password) {
        // Legacy: plain text password (will be migrated on next save)
        password = result.password;
      }
      
      resolve({
        ...result,
        password
      });
    });
  });
}

// ============================================================================
// PAYLOAD & RESPONSE
// ============================================================================

function constructPayload(batch, settings, stream = false) {
  const systemPrompt = `You are a professional web translator.
Task: Translate the following JSON array of strings into ${settings.targetLanguage}.
Input: A JSON array of strings.
Output: Render ONLY a valid JSON array of translated strings.
Rules:
1. Maintain exact array length and order.
2. Translate in context.
3. Keep the output valid JSON. Escape all double quotes within strings correctly.
4. Do NOT output Markdown code blocks (e.g. \`\`\`json).
5. Do NOT add any conversational text or explanations.
6. Verify the JSON syntax before outputting.`;

  return {
    target_endpoint: settings.targetEndpoint,
    username: settings.username,
    password: settings.password,
    model: settings.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(batch) }
    ],
    temperature: 0.3,
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

async function sendStreamingTranslationRequest(batch, settings, onTranslation, options = {}) {
  const isInlineTranslator = options.preserveFormat && batch.length === 1;
  
  // For inline translator, use non-streaming request to get plain text response
  if (isInlineTranslator) {
    const payload = {
      target_endpoint: settings.targetEndpoint,
      username: settings.username,
      password: settings.password,
      model: settings.model,
      messages: [
        { role: 'system', content: `Translate the following text to ${settings.targetLanguage}. IMPORTANT: Preserve exact formatting - keep all line breaks, paragraph spacing, and special characters exactly as in the original. Return only the translation.` },
        { role: 'user', content: batch[0] }
      ],
      temperature: 0.3,
      stream: false
    };
    
    const response = await fetch(settings.proxyUrl, {
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

    const data = await response.json();
    const translation = data.choices?.[0]?.message?.content || '';
    onTranslation(0, translation, false);
    return [translation];
  }
  
  // Standard streaming for page translation
  const payload = constructPayload(batch, settings, true);

  const response = await fetch(settings.proxyUrl, {
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
      const response = await fetch(settings.proxyUrl, {
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
        throw new Error('Network error: Cannot connect to middleware server');
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

    if (!settings.targetEndpoint) {
      throw new Error('Target endpoint not configured');
    }

    if (!settings.username || !settings.password) {
      throw new Error('Credentials not configured');
    }

    // Override targetLanguage if provided in request (for inline translator)
    if (request.targetLang) {
      settings.targetLanguage = request.targetLang;
    }

    // Check if this is an inline translator request (single text with preserveFormat)
    const options = { preserveFormat: request.preserveFormat || false };

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
      },
      options
    );

    port.postMessage({ type: 'done' });
  } catch (error) {
    port.postMessage({ type: 'error', error: error.message });
  }
}

async function handleTranslationRequest(request) {
  try {
    const settings = await getSettings();

    if (!settings.targetEndpoint) {
      throw new Error('Target endpoint not configured');
    }

    if (!settings.username || !settings.password) {
      throw new Error('Credentials not configured');
    }

    const translations = await sendTranslationRequest(request.batch, settings);
    return { translations };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Handle inline translation request (single text translation)
 */
async function handleInlineTranslationRequest(request) {
  try {
    const settings = await getSettings();

    if (!settings.targetEndpoint) {
      throw new Error('Target endpoint not configured. Please configure in extension settings.');
    }

    if (!settings.username || !settings.password) {
      throw new Error('Credentials not configured. Please configure in extension settings.');
    }

    // Override target language if provided in request
    const targetLanguage = request.targetLanguage || settings.targetLanguage;
    const settingsWithLang = { ...settings, targetLanguage };

    // Translate single text as a batch of one
    const translations = await sendTranslationRequest([request.text], settingsWithLang);

    if (translations && translations.length > 0) {
      return { translation: translations[0] };
    } else {
      throw new Error('No translation returned');
    }
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

  // Handle inline translation requests (single text)
  if (request.type === 'translateInline' && request.text) {
    handleInlineTranslationRequest(request)
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
