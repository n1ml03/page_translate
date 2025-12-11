// Popup Script - Translator with Settings, History & Quick Language Toggle

const DEFAULT_SETTINGS = {
  proxyUrl: 'http://localhost:8000/proxy/translate',
  username: '',
  encryptedPassword: '',
  model: '41_nano',
  targetLanguage: 'English',
  activeTab: 'page',
  textTargetLang: 'English',
  recentLanguages: ['Japanese', 'English', 'Vietnamese'],
  translationHistory: [],
  autoTranslate: false,
  inlineIconEnabled: true
};

// Hardcoded base endpoint URL - model will be appended automatically
const BASE_ENDPOINT = 'https://llm.api.local/chatapp/api';

// Construct full endpoint URL from base URL and model
const getFullEndpoint = (model) => `${BASE_ENDPOINT}/${model || DEFAULT_SETTINGS.model}`;

const LANGUAGES = [
  { code: 'Japanese', name: 'Japanese' },
  { code: 'English', name: 'English' },
  { code: 'Chinese (Simplified)', name: 'Chinese Simplified' },
  { code: 'Chinese (Traditional)', name: 'Chinese Traditional' },
  { code: 'Korean', name: 'Korean' },
  { code: 'Vietnamese', name: 'Vietnamese' }
];

const MAX_TEXT = 5000, MAX_HISTORY = 20, MAX_RECENT = 3, TIMEOUT = 5000, VERIFY_TIMEOUT = 10000;

// Global connection state
let isConnected = false;

// Error type to user-friendly message mapping (must match server error types)
const ERROR_MAP = {
  // Server error types from categorize_error()
  UNAUTHORIZED: 'Authentication failed - check credentials',
  FORBIDDEN: 'Access denied',
  MODEL_NOT_FOUND: 'Model not found - check settings',
  RATE_LIMIT: 'Rate limited - please wait',
  TIMEOUT: 'Request timeout',
  CONTEXT_LENGTH_EXCEEDED: 'Text too long',
  BAD_REQUEST: 'Bad request',
  GATEWAY_ERROR: 'Server unavailable',
  SERVER_ERROR: 'Server error',
  UNKNOWN_ERROR: 'Unknown error',
  // Server error types from stream/rate limiter
  CONNECTION_ERROR: 'Connection failed - check network',
  RATE_LIMITED: 'Too many requests - wait and retry',
  LOCKED: 'Account locked - wait before retry',
  ERROR: 'Translation error',
  // HTTP status codes fallback
  401: 'Auth failed', 403: 'Access denied', 404: 'Not found',
  429: 'Rate limited', 500: 'Server error', 502: 'Bad gateway',
  503: 'Service unavailable', 504: 'Timeout'
};

function parseErrorMessage(error, data = null) {
  // Server error response with type
  if (data?.error) {
    const type = data.error.type || data.error.code;
    const msg = data.error.message || '';
    return ERROR_MAP[type] ? `${ERROR_MAP[type]}${msg ? ': ' + msg : ''}` : (msg || 'Translation failed');
  }
  // HTTP status
  if (error?.status) {
    const s = error.status;
    return ERROR_MAP[s] || (s >= 500 ? `Server error (${s})` : `Request failed (${s})`);
  }
  // Error object
  if (error instanceof Error) {
    const msg = error.message || '';
    if (msg.includes('fetch') || msg.includes('Network')) return ERROR_MAP.CONNECTION_ERROR;
    if (/timeout/i.test(msg)) return ERROR_MAP.TIMEOUT;
    const m = msg.match(/(\d{3})/);
    if (m && ERROR_MAP[m[1]]) return ERROR_MAP[m[1]];
    return msg;
  }
  return 'Translation failed';
}

// ============================================================================
// STORAGE
// ============================================================================

const saveSettings = s => new Promise((res, rej) => chrome.storage.local.set(s, () => chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()));
const loadSettings = () => new Promise((res, rej) => chrome.storage.local.get(DEFAULT_SETTINGS, r => chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(r)));

async function saveCredentials(creds) {
  const { username, password, ...rest } = creds;
  const encryptedPassword = password ? await CryptoModule.encrypt(password) : '';
  return saveSettings({ ...rest, username, encryptedPassword });
}

async function loadCredentials() {
  const s = await loadSettings();
  let password = '';
  if (s.encryptedPassword) {
    password = await CryptoModule.decrypt(s.encryptedPassword);
  } else if (s.password) {
    password = s.password;
    await saveSettings({ encryptedPassword: await CryptoModule.encrypt(password), password: '' });
  }
  return { ...s, password };
}

// ============================================================================
// VALIDATION
// ============================================================================

const isValidUrl = url => typeof url === 'string' && /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url.trim());

function validateSettings(s) {
  const errors = new Map();
  if (!s.proxyUrl?.trim()) errors.set('proxyUrl', 'Proxy URL required');
  else if (!isValidUrl(s.proxyUrl)) errors.set('proxyUrl', 'Invalid URL');
  if (!s.username?.trim()) errors.set('username', 'Username required');
  if (!s.password?.trim() && !s.encryptedPassword?.trim()) errors.set('password', 'Password required');
  return { isValid: errors.size === 0, errors };
}

// ============================================================================
// TOAST
// ============================================================================

function showToast(msg, type = 'info', ms = null) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-message">${msg}</span><button class="toast-dismiss">&times;</button>`;
  toast.querySelector('.toast-dismiss').onclick = () => dismissToast(toast);
  container.appendChild(toast);
  // Shorter toast times: error=1500ms, success=800ms, info=600ms
  const defaultTimes = { error: 1500, success: 800, info: 600 };
  setTimeout(() => dismissToast(toast), ms ?? (defaultTimes[type] || 800));
}

function dismissToast(t) {
  if (!t?.parentNode) return;
  t.classList.add('toast-exit');
  setTimeout(() => t.parentNode?.removeChild(t), 200);
}

// ============================================================================
// UI HELPERS
// ============================================================================

const setLoading = (btn, loading) => { if (btn) { btn.disabled = loading; btn.classList.toggle('loading', loading); } };

function updateStatus({ status, message }) {
  const el = document.getElementById('statusIndicator');
  if (!el) return;
  el.classList.remove('connected', 'disconnected', 'unconfigured', 'checking');
  el.classList.add(status);
  const text = el.querySelector('.status-text');
  if (text) text.textContent = message;
  
  // Update global state and button states
  isConnected = status === 'connected';
  updateTranslateButtons();
}

function updateTranslateButtons() {
  const translateBtn = document.getElementById('translateBtn');
  const textTranslateBtn = document.getElementById('textTranslateBtn');
  
  if (translateBtn) {
    translateBtn.disabled = !isConnected;
    translateBtn.title = isConnected ? 'Translate current page' : 'Not connected - check settings';
  }
  if (textTranslateBtn) {
    textTranslateBtn.disabled = !isConnected;
    textTranslateBtn.title = isConnected ? 'Translate text' : 'Not connected - check settings';
  }
}

function togglePassword(id) {
  const input = document.getElementById(id);
  const wrapper = input?.closest('.password-wrapper');
  const btn = wrapper?.querySelector('.password-toggle');
  if (!input || !btn) return;
  const eye = btn.querySelector('.icon-eye'), eyeOff = btn.querySelector('.icon-eye-off');
  if (input.type === 'password') {
    input.type = 'text';
    if (eye) eye.style.display = 'none';
    if (eyeOff) eyeOff.style.display = 'block';
  } else {
    input.type = 'password';
    if (eye) eye.style.display = 'block';
    if (eyeOff) eyeOff.style.display = 'none';
  }
}

// ============================================================================
// CONNECTION
// ============================================================================

async function checkConnection(url) {
  if (!url?.trim()) return { status: 'unconfigured', message: 'Not configured' };
  if (!isValidUrl(url)) return { status: 'disconnected', message: 'Invalid URL' };
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), TIMEOUT);
    await fetch(url, { method: 'HEAD', mode: 'no-cors', signal: ctrl.signal });
    return { status: 'connected', message: 'Connected' };
  } catch (e) {
    return { status: 'disconnected', message: e.name === 'AbortError' ? 'Timeout' : 'Cannot connect' };
  }
}

// Verify connection with credentials by sending a minimal test request
async function verifyConnection(settings = null) {
  if (!settings) {
    try { settings = await loadCredentials(); } 
    catch { return { status: 'unconfigured', message: 'Not configured' }; }
  }
  
  const { isValid } = validateSettings(settings);
  if (!isValid) return { status: 'unconfigured', message: 'Not configured' };
  
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT);
    
    // Construct full endpoint from model
    const fullEndpoint = getFullEndpoint(settings.model);
    
    // Send a minimal test request to verify credentials
    const res = await fetch(settings.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        target_endpoint: fullEndpoint,
        username: settings.username,
        password: settings.password,
        model: settings.model || DEFAULT_SETTINGS.model,
        system_prompt: 'Reply with: OK',
        user_input: 'test',
        temperature: 0,
        top_p: 1,
        stream: false
      })
    });
    
    const data = await res.json().catch(() => ({}));
    
    if (res.ok) {
      return { status: 'connected', message: 'Connected' };
    }
    
    // Handle specific error types
    const errType = data?.error?.type;
    if (res.status === 401 || errType === 'UNAUTHORIZED') {
      return { status: 'disconnected', message: 'Invalid credentials' };
    }
    if (res.status === 403 || errType === 'FORBIDDEN') {
      return { status: 'disconnected', message: 'Access denied' };
    }
    if (res.status === 429 || errType === 'RATE_LIMIT' || errType === 'RATE_LIMITED' || errType === 'LOCKED') {
      // Rate limited but credentials are valid
      return { status: 'connected', message: 'Connected (rate limited)' };
    }
    if (res.status === 404 || errType === 'MODEL_NOT_FOUND') {
      return { status: 'disconnected', message: 'Model not found' };
    }
    if (res.status >= 500) {
      return { status: 'disconnected', message: 'Server error' };
    }
    
    return { status: 'disconnected', message: data?.error?.message || 'Connection failed' };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'disconnected', message: 'Timeout' };
    if (e.message?.includes('fetch') || e.message?.includes('Network')) {
      return { status: 'disconnected', message: 'Cannot connect' };
    }
    return { status: 'disconnected', message: 'Connection failed' };
  }
}

// ============================================================================
// SETTINGS MODAL
// ============================================================================

const openModal = () => document.getElementById('settingsModal')?.classList.remove('hidden');
const closeModal = () => document.getElementById('settingsModal')?.classList.add('hidden');

async function testConnection() {
  const result = document.getElementById('connectionResult');
  const btn = document.getElementById('testConnectionBtn');
  setLoading(btn, true);
  result.textContent = 'Testing...';
  result.className = 'connection-result checking';
  
  // Get current form values for testing
  const testSettings = {
    proxyUrl: document.getElementById('proxyUrl').value,
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
    model: document.getElementById('model').value
  };
  
  const s = await verifyConnection(testSettings);
  result.textContent = s.message;
  result.className = `connection-result ${s.status}`;
  setLoading(btn, false);
}

async function saveSettingsHandler() {
  const settings = {
    proxyUrl: document.getElementById('proxyUrl').value,
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
    model: document.getElementById('model').value
  };
  const { isValid, errors } = validateSettings(settings);
  if (!isValid) return showToast(errors.values().next().value, 'error');

  setLoading(document.getElementById('saveSettingsBtn'), true);
  try {
    await saveCredentials(settings);
    showToast('Settings saved! Verifying...', 'success');
    closeModal();
    updateStatus({ status: 'checking', message: 'Verifying...' });
    updateStatus(await verifyConnection(settings));
  } catch { showToast('Failed to save', 'error'); }
  finally { setLoading(document.getElementById('saveSettingsBtn'), false); }
}

// ============================================================================
// RESIZE MANAGER
// ============================================================================

/**
 * ResizeManager - Handles popup resizing with dimension persistence
 * Features:
 * - Smooth resizing with requestAnimationFrame
 * - Dimension persistence to chrome.storage
 * - Min/max constraints for usability
 * - Responsive to user preferences
 * - Touch support for mobile/tablet
 */
const ResizeManager = {
  // Dimension constraints
  MIN_WIDTH: 320,
  MIN_HEIGHT: 350,
  MAX_WIDTH: 800,
  MAX_HEIGHT: 700,
  DEFAULT_WIDTH: 380,
  DEFAULT_HEIGHT: 520,

  // State
  isResizing: false,
  startX: 0,
  startY: 0,
  startWidth: 0,
  startHeight: 0,
  rafId: null,
  pendingWidth: 0,
  pendingHeight: 0,
  isDetached: false,

  /**
   * Initialize resize functionality
   */
  init() {
    // Check if running in detached mode
    this.checkDetachedMode();
    
    // Load saved dimensions
    this.loadDimensions();
    
    // Attach resize handle events
    this.attachHandles();
    
    // Listen for window resize events (for detached mode)
    window.addEventListener('resize', this.handleWindowResize.bind(this));
  },

  /**
   * Check if running as a detached popup window
   */
  async checkDetachedMode() {
    try {
      const currentWindow = await chrome.windows.getCurrent();
      this.isDetached = currentWindow.type === 'popup';
      if (this.isDetached) {
        document.documentElement.classList.add('detached');
        document.body.classList.add('detached');
        // In detached mode, allow smaller sizes for flexibility
        this.MIN_WIDTH = 280;
        this.MIN_HEIGHT = 280;
      }
    } catch (e) {
      // If we can't get window info, assume it's a normal popup
      this.isDetached = false;
    }
  },

  /**
   * Handle window resize events (for detached mode)
   */
  handleWindowResize() {
    if (this.isDetached) {
      // In detached mode, let window control size
      return;
    }
  },

  /**
   * Load saved dimensions from storage and apply them
   */
  async loadDimensions() {
    // In detached mode, don't apply fixed dimensions
    if (this.isDetached) {
      return;
    }
    
    try {
      const stored = await new Promise(resolve => {
        chrome.storage.local.get(['popupWidth', 'popupHeight'], resolve);
      });
      
      const width = this.clamp(
        stored.popupWidth || this.DEFAULT_WIDTH,
        this.MIN_WIDTH,
        this.MAX_WIDTH
      );
      const height = this.clamp(
        stored.popupHeight || this.DEFAULT_HEIGHT,
        this.MIN_HEIGHT,
        this.MAX_HEIGHT
      );
      
      this.applyDimensions(width, height);
    } catch (e) {
      // Apply default dimensions on error
      this.applyDimensions(this.DEFAULT_WIDTH, this.DEFAULT_HEIGHT);
    }
  },

  /**
   * Apply dimensions to the popup
   */
  applyDimensions(width, height) {
    // Set dimensions on both html and body for consistent behavior
    document.documentElement.style.width = `${width}px`;
    document.documentElement.style.height = `${height}px`;
    document.body.style.width = `${width}px`;
    document.body.style.height = `${height}px`;
    
    // Also update CSS custom properties for responsive components
    document.documentElement.style.setProperty('--popup-width', `${width}px`);
    document.documentElement.style.setProperty('--popup-height', `${height}px`);
  },

  /**
   * Attach event listeners to resize handle
   */
  attachHandles() {
    const handle = document.getElementById('resizeHandle');
    if (!handle) return;

    // Use bound methods for proper this context
    this._startResize = this.startResize.bind(this);
    this._doResize = this.doResize.bind(this);
    this._stopResize = this.stopResize.bind(this);

    // Mouse events
    handle.addEventListener('mousedown', this._startResize);
    document.addEventListener('mousemove', this._doResize);
    document.addEventListener('mouseup', this._stopResize);
    
    // Double-click to reset to default size
    handle.addEventListener('dblclick', this.resetToDefault.bind(this));
    
    // Handle mouse leaving window during resize
    document.addEventListener('mouseleave', (e) => {
      // Only stop if we actually left the window (not just entered a child element)
      if (this.isResizing && e.relatedTarget === null) {
        this._stopResize(e);
      }
    });

    // Touch events for mobile/tablet support
    handle.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
    document.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
    document.addEventListener('touchend', this._stopResize);
    document.addEventListener('touchcancel', this._stopResize);
  },

  /**
   * Clamp value between min and max
   */
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },

  /**
   * Start resize operation (mouse)
   */
  startResize(e) {
    if (this.isDetached) return; // Don't resize in detached mode (use window chrome)
    
    this.isResizing = true;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.startWidth = document.documentElement.offsetWidth;
    this.startHeight = document.documentElement.offsetHeight;
    this.pendingWidth = this.startWidth;
    this.pendingHeight = this.startHeight;
    
    document.body.classList.add('resizing');
    e.preventDefault();
    e.stopPropagation();
  },

  /**
   * Handle touch start for mobile resize
   */
  handleTouchStart(e) {
    if (this.isDetached || e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    this.isResizing = true;
    this.startX = touch.clientX;
    this.startY = touch.clientY;
    this.startWidth = document.documentElement.offsetWidth;
    this.startHeight = document.documentElement.offsetHeight;
    this.pendingWidth = this.startWidth;
    this.pendingHeight = this.startHeight;
    
    document.body.classList.add('resizing');
    e.preventDefault();
  },

  /**
   * Handle resize drag with requestAnimationFrame for smoothness
   */
  doResize(e) {
    if (!this.isResizing) return;

    const clientX = e.clientX;
    const clientY = e.clientY;

    this.pendingWidth = this.clamp(
      this.startWidth + (clientX - this.startX),
      this.MIN_WIDTH,
      this.MAX_WIDTH
    );
    this.pendingHeight = this.clamp(
      this.startHeight + (clientY - this.startY),
      this.MIN_HEIGHT,
      this.MAX_HEIGHT
    );

    // Use requestAnimationFrame for smooth visual updates
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        this.applyDimensions(this.pendingWidth, this.pendingHeight);
        this.rafId = null;
      });
    }
  },

  /**
   * Handle touch move for mobile resize
   */
  handleTouchMove(e) {
    if (!this.isResizing || e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    
    this.pendingWidth = this.clamp(
      this.startWidth + (touch.clientX - this.startX),
      this.MIN_WIDTH,
      this.MAX_WIDTH
    );
    this.pendingHeight = this.clamp(
      this.startHeight + (touch.clientY - this.startY),
      this.MIN_HEIGHT,
      this.MAX_HEIGHT
    );

    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        this.applyDimensions(this.pendingWidth, this.pendingHeight);
        this.rafId = null;
      });
    }
    
    e.preventDefault();
  },

  /**
   * Stop resize operation and persist dimensions
   */
  stopResize() {
    if (!this.isResizing) return;
    
    this.isResizing = false;
    document.body.classList.remove('resizing');
    
    // Cancel any pending animation frame
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    
    // Apply final dimensions
    this.applyDimensions(this.pendingWidth, this.pendingHeight);
    
    // Persist to storage
    this.persistDimensions();
  },

  /**
   * Save current dimensions to storage
   */
  async persistDimensions() {
    try {
      await chrome.storage.local.set({
        popupWidth: this.pendingWidth,
        popupHeight: this.pendingHeight
      });
    } catch (e) {
      console.warn('Failed to persist popup dimensions:', e);
    }
  },

  /**
   * Reset to default dimensions
   */
  async resetToDefault() {
    this.pendingWidth = this.DEFAULT_WIDTH;
    this.pendingHeight = this.DEFAULT_HEIGHT;
    this.applyDimensions(this.DEFAULT_WIDTH, this.DEFAULT_HEIGHT);
    await this.persistDimensions();
    showToast('Popup size reset to default', 'success');
  },

  /**
   * Get current dimensions
   */
  getDimensions() {
    return {
      width: document.documentElement.offsetWidth,
      height: document.documentElement.offsetHeight
    };
  }
};

// ============================================================================
// DRAG MANAGER - Open as detached window for true movability
// ============================================================================

/**
 * DragManager - Allows opening popup as a detached window by dragging header
 * Double-click header to detach, or drag header to detach and position
 */
const DragManager = {
  isDragging: false,
  startX: 0,
  startY: 0,
  dragThreshold: 10, // pixels to move before considering it a drag

  init() {
    const header = document.querySelector('.header');
    if (!header) return;

    // Make header draggable
    header.style.cursor = 'grab';
    
    header.addEventListener('mousedown', this.startDrag.bind(this));
    document.addEventListener('mousemove', this.checkDrag.bind(this));
    document.addEventListener('mouseup', this.stopDrag.bind(this));
    
    // Double-click to open as detached window
    header.addEventListener('dblclick', this.openDetached.bind(this));
  },

  startDrag(e) {
    // Don't drag if clicking on buttons
    if (e.target.closest('button')) return;
    
    this.isDragging = true;
    this.startX = e.screenX;
    this.startY = e.screenY;
    this.hasMoved = false;
    e.preventDefault();
  },

  checkDrag(e) {
    if (!this.isDragging) return;
    
    const dx = Math.abs(e.screenX - this.startX);
    const dy = Math.abs(e.screenY - this.startY);
    
    // If moved beyond threshold, open as detached window
    if (dx > this.dragThreshold || dy > this.dragThreshold) {
      this.hasMoved = true;
      this.openDetached(e);
      this.isDragging = false;
    }
  },

  stopDrag() {
    this.isDragging = false;
  },

  /**
   * Open popup as a detached window that can be moved anywhere
   */
  async openDetached(e) {
    try {
      const width = document.body.offsetWidth || 520;
      const height = document.body.offsetHeight || 500;
      
      // Calculate position - try to place near where user dragged
      let left = e?.screenX ? e.screenX - width / 2 : undefined;
      let top = e?.screenY ? e.screenY - 20 : undefined;
      
      await chrome.windows.create({
        url: 'popup.html',
        type: 'popup',
        width: Math.round(width),
        height: Math.round(height),
        left: left ? Math.round(left) : undefined,
        top: top ? Math.round(top) : undefined
      });
      
      // Close the current popup
      window.close();
    } catch (err) {
      console.log('Failed to open detached window:', err);
      showToast('Drag header to detach window', 'info');
    }
  }
};

// ============================================================================
// CLIPBOARD FEATURES
// ============================================================================

/**
 * ClipboardManager - Handles clipboard reading with immediate activation on Text tab switch
 * Implements fallback to storage-based clipboard when API fails
 */
const ClipboardManager = {
  lastText: '',
  permissionGranted: false,

  async checkPermission() {
    try {
      if (navigator.permissions?.query) {
        const result = await navigator.permissions.query({ name: 'clipboard-read' });
        this.permissionGranted = result.state === 'granted';
        result.onchange = () => { this.permissionGranted = result.state === 'granted'; };
      }
    } catch (e) { /* Permission API not available */ }
    return this.permissionGranted;
  },

  /**
   * Called immediately when Text tab becomes active
   * Reads clipboard and populates source field if empty
   */
  async onTextTabActivated() {
    const sourceText = document.getElementById('sourceText');
    if (sourceText?.value.trim()) return;

    // Check permission first (won't prompt), then try to read
    await this.checkPermission();
    const text = await this.readClipboard(false);
    if (text && text.trim()) {
      sourceText.value = text.trim();
      updateCharCount();
      saveTextState();
      showToast('Clipboard text loaded', 'info');

      // Auto-translate if enabled
      const autoTranslate = document.getElementById('autoTranslateToggle')?.checked;
      if (autoTranslate) translateText();
    }
  },

  /**
   * Unified clipboard read with fallback to storage
   * @param {boolean} userActivated - true if user clicked paste button
   */
  async readClipboard(userActivated = false) {
    // Try clipboard API only if permission granted or user clicked
    try {
      if (navigator.clipboard?.readText && (this.permissionGranted || userActivated)) {
        const text = await navigator.clipboard.readText();
        if (text) return text;
      }
    } catch (e) {
      console.log('Clipboard API unavailable:', e.message);
      if (userActivated && e.name === 'NotAllowedError') {
        showToast('Clipboard access denied. Try Ctrl+V.', 'error');
      }
    }

    // Fallback to storage (from content script copy event)
    try {
      const stored = await new Promise(resolve => {
        chrome.storage.local.get(['lastCopiedText', 'lastCopiedTimestamp'], resolve);
      });
      // Only use stored text if it's recent (within 60 seconds)
      if (stored.lastCopiedTimestamp && Date.now() - stored.lastCopiedTimestamp < 60000) {
        if (userActivated) chrome.storage.local.remove(['lastCopiedText', 'lastCopiedTimestamp']);
        return stored.lastCopiedText;
      }
    } catch (e) {
      console.log('Storage fallback failed:', e);
    }

    return null;
  }
};

async function handlePasteFromClipboard() {
  const pasteBtn = document.getElementById('pasteBtn');
  const sourceTextEl = document.getElementById('sourceText');
  if (!sourceTextEl) return;

  const text = await ClipboardManager.readClipboard(true); // User clicked paste

  if (text && text.trim()) {
    sourceTextEl.value = text.trim();
    updateCharCount();
    saveTextState();
    pasteBtn?.classList.add('pasted');
    setTimeout(() => pasteBtn?.classList.remove('pasted'), 1000);

    // Auto-translate if enabled
    const autoTranslate = document.getElementById('autoTranslateToggle')?.checked;
    if (autoTranslate) translateText();
    showToast('Pasted from clipboard', 'success');
  } else {
    showToast('Clipboard is empty or inaccessible', 'info');
  }
}

// ============================================================================
// TABS
// ============================================================================

function switchTab(id) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `${id}Tab`));
  chrome.storage.local.set({ activeTab: id });
  if (id === 'history') renderHistory();
  // Requirement 1.1, 1.2: Read clipboard immediately when Text tab becomes active
  if (id === 'text') ClipboardManager.onTextTabActivated();
}

// ============================================================================
// QUICK LANGUAGE
// ============================================================================

function renderQuickLangs(containerId, current, recent, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  recent.filter(c => c !== current).slice(0, MAX_RECENT).forEach(code => {
    const lang = LANGUAGES.find(l => l.code === code);
    if (!lang) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-lang-btn';
    btn.textContent = lang.name;
    btn.dataset.lang = code;
    btn.onclick = () => onSelect(code);
    container.appendChild(btn);
  });
}

async function updateRecent(code) {
  const s = await loadSettings();
  let recent = [code, ...(s.recentLanguages || []).filter(l => l !== code)].slice(0, MAX_RECENT + 1);
  await saveSettings({ recentLanguages: recent });
  return recent;
}

// ============================================================================
// HISTORY
// ============================================================================

async function addHistory(src, trans, lang) {
  const s = await loadSettings();
  const history = [{ id: Date.now(), source: src.substring(0, 200), translation: trans.substring(0, 200), targetLang: lang, timestamp: new Date().toISOString() }, ...(s.translationHistory || [])].slice(0, MAX_HISTORY);
  await saveSettings({ translationHistory: history });
  return history;
}

async function clearHistory() {
  await saveSettings({ translationHistory: [] });
  renderHistory();
  showToast('History cleared', 'success');
}

async function renderHistory() {
  const container = document.getElementById('historyList');
  if (!container) return;
  const s = await loadSettings();
  const history = s.translationHistory || [];
  if (!history.length) { container.innerHTML = '<div class="history-empty">No history yet</div>'; return; }

  const escape = str => str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const relTime = ts => {
    const d = new Date(ts), diff = Date.now() - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return d.toLocaleDateString();
  };

  container.innerHTML = history.map(e => `
    <div class="history-item" data-id="${e.id}">
      <div class="history-item-header"><span class="history-lang">${e.targetLang}</span><span class="history-time">${relTime(e.timestamp)}</span></div>
      <div class="history-source">${escape(e.source)}</div>
      <div class="history-translation">${escape(e.translation)}</div>
      <div class="history-actions">
        <button type="button" class="history-copy-btn" data-text="${escape(e.translation)}" title="Copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
        <button type="button" class="history-reuse-btn" data-source="${escape(e.source)}" title="Reuse"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg></button>
      </div>
    </div>`).join('');

  container.querySelectorAll('.history-copy-btn').forEach(b => b.onclick = async e => {
    await navigator.clipboard.writeText(e.currentTarget.dataset.text);
    showToast('Copied!', 'success');
  });
  container.querySelectorAll('.history-reuse-btn').forEach(b => b.onclick = e => {
    document.getElementById('sourceText').value = e.currentTarget.dataset.source;
    switchTab('text');
    updateCharCount();
  });
}


// ============================================================================
// TEXT TRANSLATION
// ============================================================================

function showProgress(show) {
  const progress = document.getElementById('translationProgress');
  const output = document.getElementById('translatedText');
  if (show) {
    progress?.classList.remove('hidden');
    output?.classList.add('translating');
    const fill = progress?.querySelector('.progress-fill');
    if (fill) { fill.style.width = '0%'; setTimeout(() => fill.style.width = '70%', 100); }
  } else {
    const fill = progress?.querySelector('.progress-fill');
    if (fill) fill.style.width = '100%';
    setTimeout(() => { progress?.classList.add('hidden'); output?.classList.remove('translating'); }, 200);
  }
}

function updateCharCount() {
  const src = document.getElementById('sourceText');
  const count = document.getElementById('charCount');
  if (!src || !count) return;
  const len = src.value.length;
  count.textContent = `${len} / ${MAX_TEXT}`;
  count.classList.remove('warning', 'error');
  if (len > MAX_TEXT) count.classList.add('error');
  else if (len > MAX_TEXT * 0.9) count.classList.add('warning');
}

async function translateText() {
  const srcEl = document.getElementById('sourceText');
  const src = srcEl.value;
  const outEl = document.getElementById('translatedText');
  const lang = document.getElementById('textTargetLang').value;
  const btn = document.getElementById('textTranslateBtn');

  if (!isConnected) { showToast('Not connected - check settings', 'error'); return openModal(); }
  if (!src.trim()) return showToast('Enter text', 'error');
  if (src.length > MAX_TEXT) return showToast(`Max ${MAX_TEXT} chars`, 'error');

  const settings = await loadCredentials();
  if (!validateSettings(settings).isValid) { showToast('Configure settings first', 'error'); return openModal(); }

  setLoading(btn, true);
  showProgress(true);
  outEl.innerText = '';

  try {
    // Construct full endpoint from model
    const fullEndpoint = getFullEndpoint(settings.model);
    
    const res = await fetch(settings.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_endpoint: fullEndpoint,
        username: settings.username,
        password: settings.password,
        model: settings.model || DEFAULT_SETTINGS.model,
        system_prompt: `Translate to ${lang}. Preserve formatting. Return only translation.`,
        user_input: src,
        temperature: 0.3,
        top_p: 0.9,
        stream: false
      })
    });
    const data = await res.json();
    if (!res.ok) {
      const errorMsg = parseErrorMessage(res, data);
      throw new Error(errorMsg);
    }
    const trans = data.choices?.[0]?.message?.content || '';
    outEl.innerText = trans;

    const recent = await updateRecent(lang);
    await addHistory(src, trans, lang);
    renderQuickLangs('textQuickLangs', lang, recent, textQuickSelect);
    chrome.storage.local.set({ textTargetLang: lang });
    saveTextState();
  } catch (e) {
    const errorMsg = parseErrorMessage(e);
    showToast(errorMsg, 'error', 3000);
    outEl.textContent = '';
  } finally {
    showProgress(false);
    setLoading(btn, false);
  }
}

const textQuickSelect = code => { document.getElementById('textTargetLang').value = code; translateText(); };
const pageQuickSelect = code => {
  document.getElementById('targetLanguage').value = code;
  updateRecent(code).then(r => renderQuickLangs('pageQuickLangs', code, r, pageQuickSelect));
};

function clearSource() {
  document.getElementById('sourceText').value = '';
  document.getElementById('translatedText').innerText = '';
  updateCharCount();
  saveTextState();
}

async function copyResult() {
  const el = document.getElementById('translatedText');
  const btn = document.getElementById('copyResultBtn');
  if (!el?.textContent) return;
  try {
    await navigator.clipboard.writeText(el.textContent);
    btn?.classList.add('copied');
    showToast('Copied!', 'success');
    setTimeout(() => btn?.classList.remove('copied'), 1500);
  } catch { showToast('Copy failed', 'error'); }
}

async function handleAutoTranslateToggle(e) {
  const enabled = e.target.checked;
  await saveSettings({ autoTranslate: enabled });
  if (enabled) {
    showToast('Auto-translate enabled', 'success');
    const sourceText = document.getElementById('sourceText')?.value.trim();
    if (sourceText) translateText();
  }
}

async function handleInlineIconToggle(e) {
  const enabled = e.target.checked;
  await saveSettings({ inlineIconEnabled: enabled });
  showToast(enabled ? 'Selection icon enabled' : 'Selection icon disabled', 'success');
}

function handleSwapTexts() {
  const sourceTextEl = document.getElementById('sourceText');
  const translatedTextEl = document.getElementById('translatedText');
  if (!sourceTextEl || !translatedTextEl) return;

  const sourceText = sourceTextEl.value;
  const translatedText = translatedTextEl.innerText;
  if (!translatedText.trim()) {
    showToast('No translation to swap', 'info');
    return;
  }

  sourceTextEl.value = translatedText;
  translatedTextEl.innerText = sourceText;
  updateCharCount();
  saveTextState();
}

function saveTextState() {
  const src = document.getElementById('sourceText')?.value || '';
  const trans = document.getElementById('translatedText')?.innerText || '';
  chrome.storage.local.set({ _textTabState: { sourceText: src, translatedText: trans } });
}

function restoreTextState() {
  chrome.storage.local.get({ _textTabState: null }, r => {
    if (r._textTabState) {
      const srcEl = document.getElementById('sourceText');
      const transEl = document.getElementById('translatedText');
      if (srcEl) srcEl.value = r._textTabState.sourceText || '';
      if (transEl) transEl.innerText = r._textTabState.translatedText || '';
      updateCharCount();
    }
  });
}

// ============================================================================
// PAGE TRANSLATION
// ============================================================================

// Lock to prevent race condition on rapid clicks
let _translateLock = false;

async function translatePage() {
  // Immediate lock to prevent race condition
  if (_translateLock) {
    showToast('Translation in progress...', 'info');
    return;
  }
  _translateLock = true;

  const btn = document.getElementById('translateBtn');
  setLoading(btn, true);

  try {
    const settings = await loadCredentials();
    const lang = document.getElementById('targetLanguage').value;

    if (!isConnected) {
      showToast('Not connected - check settings', 'error');
      openModal();
      return;
    }
    if (!validateSettings(settings).isValid) {
      showToast('Configure settings first', 'error');
      openModal();
      return;
    }

    // Check storage flag (may be stale from crashed content script)
    const { pageTranslationInProgress, pageTranslationStartTime } = await new Promise(resolve =>
      chrome.storage.local.get({ pageTranslationInProgress: false, pageTranslationStartTime: 0 }, resolve)
    );

    // Auto-reset stale flag (older than 5 minutes)
    const isStale = pageTranslationStartTime && Date.now() - pageTranslationStartTime > 300000;
    if (pageTranslationInProgress && !isStale) {
      showToast('Translation in progress...', 'info');
      return;
    }

    // Set flag with timestamp for staleness detection
    await chrome.storage.local.set({
      pageTranslationInProgress: true,
      pageTranslationStartTime: Date.now()
    });

    await saveSettings({ targetLanguage: lang });
    await updateRecent(lang);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      await chrome.storage.local.set({ pageTranslationInProgress: false });
      showToast('No active tab', 'error');
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'translate', targetLanguage: lang }, res => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
          .then(() => setTimeout(() => chrome.tabs.sendMessage(tab.id, { action: 'translate', targetLanguage: lang }), 100))
          .catch(() => chrome.storage.local.set({ pageTranslationInProgress: false }));
      }
      // Check translation status after a short delay
      setTimeout(checkTranslationStatus, 500);
    });
    showToast('Translation started!', 'success');
    // Update UI after translation starts
    setTimeout(checkTranslationStatus, 2000);
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
    await chrome.storage.local.set({ pageTranslationInProgress: false });
  } finally {
    _translateLock = false;
    // Button state managed by storage listener
  }
}

// Check translation status from content script
async function checkTranslationStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    chrome.tabs.sendMessage(tab.id, { action: 'getTranslationStatus' }, response => {
      if (chrome.runtime.lastError || !response?.success) {
        updateTranslationStatusUI(null);
        return;
      }
      updateTranslationStatusUI(response);
    });
  } catch {
    updateTranslationStatusUI(null);
  }
}

// Update UI based on translation status
function updateTranslationStatusUI(status) {
  const toggleBtn = document.getElementById('toggleTranslationBtn');
  const statusEl = document.getElementById('translationStatus');
  
  if (!status || !status.isTranslated) {
    toggleBtn?.classList.add('hidden');
    statusEl?.classList.add('hidden');
    return;
  }

  // Show toggle button
  toggleBtn?.classList.remove('hidden');
  statusEl?.classList.remove('hidden');
  
  const isShowingOriginal = status.displayMode === 'original';
  const toggleText = toggleBtn?.querySelector('.toggle-text');
  const statusLabel = statusEl?.querySelector('.status-label');
  const statusInfo = statusEl?.querySelector('.status-info');
  
  if (isShowingOriginal) {
    toggleBtn?.classList.add('showing-original');
    if (toggleText) toggleText.textContent = 'Show Translation';
    statusEl?.classList.add('original-mode');
    if (statusLabel) statusLabel.textContent = 'Showing Original';
  } else {
    toggleBtn?.classList.remove('showing-original');
    if (toggleText) toggleText.textContent = 'Show Original';
    statusEl?.classList.remove('original-mode');
    if (statusLabel) statusLabel.textContent = 'Translated';
  }
  
  if (statusInfo) {
    const lang = status.targetLanguage || '';
    const count = status.totalElements || 0;
    statusInfo.textContent = lang ? `${lang} • ${count} elements` : `${count} elements`;
  }
}

// Handle toggle button click
async function handleToggleTranslation() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    chrome.tabs.sendMessage(tab.id, { action: 'toggleTranslation' }, response => {
      if (chrome.runtime.lastError) {
        showToast('Failed to toggle translation', 'error');
        return;
      }
      if (response?.success) {
        updateTranslationStatusUI({ isTranslated: true, displayMode: response.displayMode });
        // No toast - just update UI silently
      } else {
        showToast(response?.error || 'Page not translated', 'error');
      }
    });
  } catch {
    showToast('Failed to toggle translation', 'error');
  }
}

// Check and update translate button state based on translation progress
async function updateTranslateButtonState() {
  const btn = document.getElementById('translateBtn');
  if (!btn) return;
  const { pageTranslationInProgress } = await new Promise(resolve => 
    chrome.storage.local.get({ pageTranslationInProgress: false }, resolve)
  );
  // Only enable if connected and not in progress
  if (pageTranslationInProgress) {
    setLoading(btn, true);
  } else {
    btn.disabled = !isConnected;
    btn.classList.remove('loading');
  }
}

// ============================================================================
// POPUP PERSISTENCE
// ============================================================================

/**
 * Note on Popup Persistence (Requirements 2.1, 2.2, 2.3, 2.4):
 * 
 * Chrome extension popups inherently close when they lose focus (clicking outside).
 * This is browser-controlled behavior that cannot be overridden via JavaScript.
 * 
 * The popup can be closed via:
 * - Clicking outside the popup (Chrome default behavior - cannot be prevented)
 * - Pressing Escape key (closes settings modal if open)
 * - Clicking the X button on the settings modal
 * 
 * There are NO custom click-outside handlers that close the main popup.
 * The settings modal has a click-outside handler to close the modal overlay only.
 * 
 * If true persistence is required (popup stays open when clicking outside),
 * the extension would need to open as a detached window instead:
 *   chrome.windows.create({ url: 'popup.html', type: 'popup', width: 520, height: 500 });
 */

// ============================================================================
// INIT
// ============================================================================

async function init() {
  // Initialize resize functionality (handles detached mode detection internally)
  ResizeManager.init();
  
  // Initialize drag-to-detach functionality
  DragManager.init();

  let settings;
  try { settings = await loadCredentials(); } catch { settings = DEFAULT_SETTINGS; }

  document.getElementById('proxyUrl').value = settings.proxyUrl;
  document.getElementById('username').value = settings.username;
  document.getElementById('password').value = settings.password || '';
  document.getElementById('model').value = settings.model;
  document.getElementById('targetLanguage').value = settings.targetLanguage;
  document.getElementById('textTargetLang').value = settings.textTargetLang || DEFAULT_SETTINGS.textTargetLang;

  // Tab nav
  document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  if (settings.activeTab) switchTab(settings.activeTab);

  // Settings modal
  document.getElementById('settingsBtn')?.addEventListener('click', openModal);
  document.getElementById('closeSettingsBtn')?.addEventListener('click', closeModal);
  document.getElementById('testConnectionBtn')?.addEventListener('click', testConnection);
  document.getElementById('saveSettingsBtn')?.addEventListener('click', saveSettingsHandler);
  document.getElementById('passwordToggle')?.addEventListener('click', () => togglePassword('password'));
  document.getElementById('settingsModal')?.addEventListener('click', e => { if (e.target.id === 'settingsModal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Page tab
  document.getElementById('translateBtn')?.addEventListener('click', translatePage);
  document.getElementById('toggleTranslationBtn')?.addEventListener('click', handleToggleTranslation);
  document.getElementById('targetLanguage')?.addEventListener('change', e => {
    chrome.storage.local.set({ targetLanguage: e.target.value });
    updateRecent(e.target.value).then(r => renderQuickLangs('pageQuickLangs', e.target.value, r, pageQuickSelect));
  });
  
  // Check translation status when popup opens
  checkTranslationStatus();

  // Text tab
  document.getElementById('sourceText')?.addEventListener('input', () => { updateCharCount(); saveTextState(); });
  document.getElementById('textTranslateBtn')?.addEventListener('click', translateText);
  document.getElementById('clearSourceBtn')?.addEventListener('click', clearSource);
  document.getElementById('copyResultBtn')?.addEventListener('click', copyResult);
  document.getElementById('pasteBtn')?.addEventListener('click', handlePasteFromClipboard);
  document.getElementById('swapBtn')?.addEventListener('click', handleSwapTexts);
  document.getElementById('textTargetLang')?.addEventListener('change', e => {
    chrome.storage.local.set({ textTargetLang: e.target.value });
    updateRecent(e.target.value).then(r => renderQuickLangs('textQuickLangs', e.target.value, r, textQuickSelect));
  });
  document.getElementById('sourceText')?.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); translateText(); } });

  // Auto-translate toggle
  const autoTranslateToggle = document.getElementById('autoTranslateToggle');
  if (autoTranslateToggle) {
    autoTranslateToggle.checked = settings.autoTranslate || false;
    autoTranslateToggle.addEventListener('change', handleAutoTranslateToggle);
  }

  const inlineIconToggle = document.getElementById('inlineIconEnabled');
  if (inlineIconToggle) {
    inlineIconToggle.checked = settings.inlineIconEnabled !== false;
    inlineIconToggle.addEventListener('change', handleInlineIconToggle);
  }

  // History
  document.getElementById('clearHistoryBtn')?.addEventListener('click', clearHistory);

  restoreTextState();
  updateCharCount();

  const recent = settings.recentLanguages || DEFAULT_SETTINGS.recentLanguages;
  renderQuickLangs('pageQuickLangs', settings.targetLanguage, recent, pageQuickSelect);
  renderQuickLangs('textQuickLangs', settings.textTargetLang, recent, textQuickSelect);

  // Quick connection check (HEAD request) - no tokens used
  // Full verification only on "Test Connection" click or after saving settings
  const { isValid } = validateSettings(settings);
  if (!isValid) {
    updateStatus({ status: 'unconfigured', message: 'Not configured' });
  } else {
    updateStatus(await checkConnection(settings.proxyUrl));
  }

  // Check translate button state on popup open
  updateTranslateButtonState();

  // Listen for translation progress changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.pageTranslationInProgress) {
      updateTranslateButtonState();
    }
  });

}

if (typeof chrome !== 'undefined' && chrome.storage) {
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
}
