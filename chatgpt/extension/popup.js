// Popup Script - Page Translator with Unified Settings, History & Quick Language Toggle

// ============================================================================
// CONSTANTS & DEFAULTS
// ============================================================================

const DEFAULT_SETTINGS = {
  proxyUrl: 'http://localhost:8000/proxy/translate',
  targetEndpoint: '',
  username: '',
  encryptedPassword: '', // Password is now stored encrypted
  model: '41-mini',
  targetLanguage: 'English',
  activeTab: 'page',
  textTargetLang: 'English',
  recentLanguages: ['Japanese', 'English', 'Vietnamese'],
  translationHistory: []
};

const LANGUAGES = [
  { code: 'Japanese', name: 'Japanese', native: '日本語' },
  { code: 'English', name: 'English', native: 'English' },
  { code: 'Chinese (Simplified)', name: 'Chinese Simplified', native: '简体中文' },
  { code: 'Chinese (Traditional)', name: 'Chinese Traditional', native: '繁體中文' },
  { code: 'Korean', name: 'Korean', native: '한국어' },
  { code: 'Vietnamese', name: 'Vietnamese', native: 'Tiếng Việt' }
];

const MAX_TEXT_LENGTH = 5000;
const MAX_HISTORY_ITEMS = 20;
const MAX_RECENT_LANGUAGES = 3;
const CONNECTION_TIMEOUT = 5000;

// ============================================================================
// STORAGE HELPERS WITH ENCRYPTION
// ============================================================================

const saveSettings = (settings) => new Promise((resolve, reject) => {
  chrome.storage.local.set(settings, () => 
    chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
  );
});

const loadSettings = () => new Promise((resolve, reject) => {
  chrome.storage.local.get(DEFAULT_SETTINGS, (result) => 
    chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(result)
  );
});

/**
 * Save credentials with password encryption
 */
async function saveCredentials(credentials) {
  const { username, password, ...otherSettings } = credentials;
  
  // Encrypt password before saving
  const encryptedPassword = password ? await CryptoModule.encrypt(password) : '';
  
  return saveSettings({
    ...otherSettings,
    username,
    encryptedPassword
  });
}

/**
 * Load credentials with password decryption
 */
async function loadCredentials() {
  const settings = await loadSettings();
  
  // Decrypt password
  let password = '';
  if (settings.encryptedPassword) {
    password = await CryptoModule.decrypt(settings.encryptedPassword);
  } else if (settings.password) {
    // Migration: encrypt old plain text password
    password = settings.password;
    const encryptedPassword = await CryptoModule.encrypt(password);
    await saveSettings({ encryptedPassword, password: '' });
  }
  
  return {
    ...settings,
    password
  };
}

// ============================================================================
// VALIDATION
// ============================================================================

const validateUrl = (url) => 
  typeof url === 'string' && /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url.trim());

const validateSettings = (settings) => {
  const errors = new Map();
  if (!settings.proxyUrl?.trim()) errors.set('proxyUrl', 'Proxy URL is required');
  else if (!validateUrl(settings.proxyUrl)) errors.set('proxyUrl', 'Invalid URL format');
  if (!settings.targetEndpoint?.trim()) errors.set('targetEndpoint', 'Target Endpoint is required');
  else if (!validateUrl(settings.targetEndpoint)) errors.set('targetEndpoint', 'Invalid URL format');
  if (!settings.username?.trim()) errors.set('username', 'Username is required');
  // Check for password (decrypted) or encryptedPassword
  const hasPassword = settings.password?.trim() || settings.encryptedPassword?.trim();
  if (!hasPassword) errors.set('password', 'Password is required');
  return { isValid: errors.size === 0, errors };
};

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================

function showToast(message, type = 'info', autoDismissMs = null) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-message">${message}</span>
    <button class="toast-dismiss" aria-label="Dismiss">&times;</button>
  `;
  toast.querySelector('.toast-dismiss').addEventListener('click', () => dismissToast(toast));
  container.appendChild(toast);

  const dismissTime = autoDismissMs ?? (type === 'error' ? 2500 : 1500);
  if (dismissTime > 0) setTimeout(() => dismissToast(toast), dismissTime);
}

function dismissToast(toast) {
  if (!toast?.parentNode) return;
  toast.classList.add('toast-exit');
  setTimeout(() => toast.parentNode?.removeChild(toast), 200);
}

// ============================================================================
// UI HELPERS
// ============================================================================

function setButtonLoading(button, loading) {
  if (!button) return;
  button.disabled = loading;
  button.classList.toggle('loading', loading);
}

function updateConnectionStatusUI({ status, message }) {
  const indicator = document.getElementById('statusIndicator');
  if (!indicator) return;
  indicator.classList.remove('connected', 'disconnected', 'unconfigured', 'checking');
  indicator.classList.add(status);
  const statusText = indicator.querySelector('.status-text');
  if (statusText) statusText.textContent = message;
}

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  const wrapper = input?.closest('.password-wrapper');
  const toggleBtn = wrapper?.querySelector('.password-toggle');
  if (!input || !toggleBtn) return;

  const eyeIcon = toggleBtn.querySelector('.icon-eye');
  const eyeOffIcon = toggleBtn.querySelector('.icon-eye-off');

  if (input.type === 'password') {
    input.type = 'text';
    if (eyeIcon) eyeIcon.style.display = 'none';
    if (eyeOffIcon) eyeOffIcon.style.display = 'block';
  } else {
    input.type = 'password';
    if (eyeIcon) eyeIcon.style.display = 'block';
    if (eyeOffIcon) eyeOffIcon.style.display = 'none';
  }
}

// ============================================================================
// CONNECTION CHECK
// ============================================================================

async function checkServerConnection(proxyUrl) {
  if (!proxyUrl?.trim()) return { status: 'unconfigured', message: 'Not configured' };
  if (!validateUrl(proxyUrl)) return { status: 'disconnected', message: 'Invalid URL' };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT);
    await fetch(proxyUrl, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
    clearTimeout(timeoutId);
    return { status: 'connected', message: 'Connected' };
  } catch (error) {
    return { 
      status: 'disconnected', 
      message: error.name === 'AbortError' ? 'Timeout' : 'Cannot connect' 
    };
  }
}

// ============================================================================
// SETTINGS MODAL
// ============================================================================

function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  modal?.classList.remove('hidden');
  document.getElementById('proxyUrl')?.focus();
}

function closeSettingsModal() {
  document.getElementById('settingsModal')?.classList.add('hidden');
}

async function handleTestConnection() {
  const proxyUrl = document.getElementById('proxyUrl').value;
  const resultEl = document.getElementById('connectionResult');
  const testBtn = document.getElementById('testConnectionBtn');
  
  setButtonLoading(testBtn, true);
  resultEl.textContent = 'Testing...';
  resultEl.className = 'connection-result checking';
  
  const status = await checkServerConnection(proxyUrl);
  
  resultEl.textContent = status.message;
  resultEl.className = `connection-result ${status.status}`;
  setButtonLoading(testBtn, false);
}

async function handleSaveSettings() {
  const settings = {
    proxyUrl: document.getElementById('proxyUrl').value,
    targetEndpoint: document.getElementById('targetEndpoint').value,
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
    model: document.getElementById('model').value
  };
  
  const { isValid, errors } = validateSettings(settings);
  if (!isValid) {
    const firstError = errors.values().next().value;
    showToast(firstError, 'error');
    return;
  }
  
  setButtonLoading(document.getElementById('saveSettingsBtn'), true);
  
  try {
    // Save with encrypted password
    await saveCredentials(settings);
    showToast('Settings saved securely!', 'success');
    closeSettingsModal();
    
    updateConnectionStatusUI({ status: 'checking', message: 'Checking...' });
    const status = await checkServerConnection(settings.proxyUrl);
    updateConnectionStatusUI(status);
  } catch (error) {
    showToast('Failed to save settings', 'error');
  } finally {
    setButtonLoading(document.getElementById('saveSettingsBtn'), false);
  }
}


// ============================================================================
// TAB MANAGEMENT
// ============================================================================

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => 
    btn.classList.toggle('active', btn.dataset.tab === tabId)
  );
  document.querySelectorAll('.tab-content').forEach(content => 
    content.classList.toggle('active', content.id === `${tabId}Tab`)
  );
  chrome.storage.local.set({ activeTab: tabId });
  
  if (tabId === 'history') {
    renderHistoryList();
  }
}

// ============================================================================
// QUICK LANGUAGE TOGGLE
// ============================================================================

function renderQuickLanguageButtons(containerId, currentLang, recentLanguages, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  container.innerHTML = '';
  
  const langsToShow = recentLanguages
    .filter(code => code !== currentLang)
    .slice(0, MAX_RECENT_LANGUAGES);
  
  langsToShow.forEach(langCode => {
    const lang = LANGUAGES.find(l => l.code === langCode);
    if (!lang) return;
    
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-lang-btn';
    btn.textContent = lang.name;
    btn.title = lang.name;
    btn.dataset.lang = langCode;
    btn.addEventListener('click', () => onSelect(langCode));
    container.appendChild(btn);
  });
}

async function updateRecentLanguages(langCode) {
  const settings = await loadSettings();
  let recent = settings.recentLanguages || [];
  
  recent = [langCode, ...recent.filter(l => l !== langCode)].slice(0, MAX_RECENT_LANGUAGES + 1);
  
  await saveSettings({ recentLanguages: recent });
  return recent;
}

// ============================================================================
// TRANSLATION HISTORY
// ============================================================================

async function addToHistory(sourceText, translatedText, targetLang) {
  const settings = await loadSettings();
  const history = settings.translationHistory || [];
  
  const entry = {
    id: Date.now(),
    source: sourceText.substring(0, 200),
    translation: translatedText.substring(0, 200),
    targetLang,
    timestamp: new Date().toISOString()
  };
  
  const newHistory = [entry, ...history].slice(0, MAX_HISTORY_ITEMS);
  await saveSettings({ translationHistory: newHistory });
  
  return newHistory;
}

async function clearHistory() {
  await saveSettings({ translationHistory: [] });
  renderHistoryList();
  showToast('History cleared', 'success');
}

async function renderHistoryList() {
  const container = document.getElementById('historyList');
  if (!container) return;
  
  const settings = await loadSettings();
  const history = settings.translationHistory || [];
  
  if (history.length === 0) {
    container.innerHTML = '<div class="history-empty">No translation history yet</div>';
    return;
  }
  
  container.innerHTML = history.map(entry => `
    <div class="history-item" data-id="${entry.id}">
      <div class="history-item-header">
        <span class="history-lang">${entry.targetLang}</span>
        <span class="history-time">${formatRelativeTime(entry.timestamp)}</span>
      </div>
      <div class="history-source">${escapeHtml(entry.source)}</div>
      <div class="history-translation">${escapeHtml(entry.translation)}</div>
      <div class="history-actions">
        <button type="button" class="history-copy-btn" data-text="${escapeAttr(entry.translation)}" title="Copy translation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
        <button type="button" class="history-reuse-btn" data-source="${escapeAttr(entry.source)}" title="Translate again">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M23 4v6h-6"></path>
            <path d="M1 20v-6h6"></path>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
        </button>
      </div>
    </div>
  `).join('');
  
  container.querySelectorAll('.history-copy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const text = e.currentTarget.dataset.text;
      await navigator.clipboard.writeText(text);
      showToast('Copied!', 'success');
    });
  });
  
  container.querySelectorAll('.history-reuse-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const source = e.currentTarget.dataset.source;
      document.getElementById('sourceText').value = source;
      switchTab('text');
      updateCharCount();
    });
  });
}

function formatRelativeTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


// ============================================================================
// TEXT TRANSLATION WITH PROGRESS
// ============================================================================

function showTranslationProgress(show) {
  const progress = document.getElementById('translationProgress');
  const output = document.getElementById('translatedText');
  
  if (show) {
    progress?.classList.remove('hidden');
    output?.classList.add('translating');
    const fill = progress?.querySelector('.progress-fill');
    if (fill) {
      fill.style.width = '0%';
      setTimeout(() => fill.style.width = '70%', 100);
    }
  } else {
    const fill = progress?.querySelector('.progress-fill');
    if (fill) fill.style.width = '100%';
    setTimeout(() => {
      progress?.classList.add('hidden');
      output?.classList.remove('translating');
    }, 200);
  }
}

function updateCharCount() {
  const sourceText = document.getElementById('sourceText');
  const charCount = document.getElementById('charCount');
  if (!sourceText || !charCount) return;

  const len = sourceText.value.length;
  charCount.textContent = `${len} / ${MAX_TEXT_LENGTH}`;
  charCount.classList.remove('warning', 'error');
  if (len > MAX_TEXT_LENGTH) charCount.classList.add('error');
  else if (len > MAX_TEXT_LENGTH * 0.9) charCount.classList.add('warning');
}

async function handleTextTranslate() {
  const sourceTextEl = document.getElementById('sourceText');
  const sourceText = sourceTextEl.value;
  const translatedTextEl = document.getElementById('translatedText');
  const textTargetLang = document.getElementById('textTargetLang').value;
  const translateBtn = document.getElementById('textTranslateBtn');

  if (!sourceText.trim()) {
    showToast('Enter text to translate', 'error');
    return;
  }

  if (sourceText.length > MAX_TEXT_LENGTH) {
    showToast(`Text exceeds ${MAX_TEXT_LENGTH} characters`, 'error');
    return;
  }

  const settings = await loadCredentials();
  const { isValid } = validateSettings(settings);
  if (!isValid) {
    showToast('Configure server settings first', 'error');
    openSettingsModal();
    return;
  }

  setButtonLoading(translateBtn, true);
  showTranslationProgress(true);
  translatedTextEl.innerText = '';

  try {
    const response = await fetch(settings.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_endpoint: settings.targetEndpoint,
        username: settings.username,
        password: settings.password,
        model: settings.model || DEFAULT_SETTINGS.model,
        messages: [
          { role: 'system', content: `Translate the following text to ${textTargetLang}. IMPORTANT: Preserve exact formatting - keep all line breaks, paragraph spacing, and special characters exactly as in the original. Return only the translation.` },
          { role: 'user', content: sourceText }
        ],
        temperature: 0.3,
        stream: false
      })
    });

    if (!response.ok) throw new Error(`Server error: ${response.status}`);

    const data = await response.json();
    const translation = data.choices?.[0]?.message?.content || '';
    translatedTextEl.innerText = translation;

    const recentLangs = await updateRecentLanguages(textTargetLang);
    await addToHistory(sourceText, translation, textTargetLang);
    
    renderQuickLanguageButtons('textQuickLangs', textTargetLang, recentLangs, handleTextQuickLangSelect);
    
    chrome.storage.local.set({ textTargetLang });
    saveTextTabState();
    
  } catch (error) {
    showToast(`Translation failed: ${error.message}`, 'error');
    translatedTextEl.textContent = '';
  } finally {
    showTranslationProgress(false);
    setButtonLoading(translateBtn, false);
  }
}

function handleTextQuickLangSelect(langCode) {
  document.getElementById('textTargetLang').value = langCode;
  handleTextTranslate();
}

function handlePageQuickLangSelect(langCode) {
  document.getElementById('targetLanguage').value = langCode;
  updateRecentLanguages(langCode).then(recent => {
    renderQuickLanguageButtons('pageQuickLangs', langCode, recent, handlePageQuickLangSelect);
  });
}

function handleClearSource() {
  document.getElementById('sourceText').value = '';
  document.getElementById('translatedText').innerText = '';
  updateCharCount();
  saveTextTabState();
}

async function handleCopyResult() {
  const translatedText = document.getElementById('translatedText');
  const copyBtn = document.getElementById('copyResultBtn');
  if (!translatedText?.textContent) return;

  try {
    await navigator.clipboard.writeText(translatedText.textContent);
    copyBtn?.classList.add('copied');
    showToast('Copied!', 'success');
    setTimeout(() => copyBtn?.classList.remove('copied'), 1500);
  } catch {
    showToast('Failed to copy', 'error');
  }
}

function saveTextTabState() {
  const sourceText = document.getElementById('sourceText')?.value || '';
  const translatedText = document.getElementById('translatedText')?.innerText || '';
  chrome.storage.local.set({ _textTabState: { sourceText, translatedText } });
}

function restoreTextTabState() {
  chrome.storage.local.get({ _textTabState: null }, (r) => {
    if (r._textTabState) {
      const sourceEl = document.getElementById('sourceText');
      const translatedEl = document.getElementById('translatedText');
      if (sourceEl) sourceEl.value = r._textTabState.sourceText || '';
      if (translatedEl) translatedEl.innerText = r._textTabState.translatedText || '';
      updateCharCount();
    }
  });
}

// ============================================================================
// PAGE TRANSLATION
// ============================================================================

async function handleTranslate() {
  const settings = await loadCredentials();
  const targetLanguage = document.getElementById('targetLanguage').value;
  const translateBtn = document.getElementById('translateBtn');

  const { isValid } = validateSettings(settings);
  if (!isValid) {
    showToast('Configure server settings first', 'error');
    openSettingsModal();
    return;
  }

  setButtonLoading(translateBtn, true);

  try {
    await saveSettings({ targetLanguage });
    await updateRecentLanguages(targetLanguage);
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showToast('No active tab found', 'error');
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'translate' }, _response => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js']
        }).then(() => {
          setTimeout(() => chrome.tabs.sendMessage(tab.id, { action: 'translate' }), 100);
        });
      }
    });

    showToast('Translation started!', 'success');
  } catch (error) {
    showToast('Failed: ' + error.message, 'error');
  } finally {
    setButtonLoading(translateBtn, false);
  }
}


// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializePopup() {
  let settings;
  try {
    settings = await loadCredentials();
  } catch {
    settings = DEFAULT_SETTINGS;
  }

  // Populate form fields in modal
  document.getElementById('proxyUrl').value = settings.proxyUrl;
  document.getElementById('targetEndpoint').value = settings.targetEndpoint;
  document.getElementById('username').value = settings.username;
  document.getElementById('password').value = settings.password || '';
  document.getElementById('model').value = settings.model;
  document.getElementById('targetLanguage').value = settings.targetLanguage;
  document.getElementById('textTargetLang').value = settings.textTargetLang || DEFAULT_SETTINGS.textTargetLang;

  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Restore active tab
  if (settings.activeTab) switchTab(settings.activeTab);

  // Settings modal
  document.getElementById('settingsBtn')?.addEventListener('click', openSettingsModal);
  document.getElementById('closeSettingsBtn')?.addEventListener('click', closeSettingsModal);
  document.getElementById('testConnectionBtn')?.addEventListener('click', handleTestConnection);
  document.getElementById('saveSettingsBtn')?.addEventListener('click', handleSaveSettings);
  document.getElementById('passwordToggle')?.addEventListener('click', () => togglePasswordVisibility('password'));
  
  // Close modal on overlay click
  document.getElementById('settingsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'settingsModal') closeSettingsModal();
  });
  
  // Close modal on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettingsModal();
  });

  // Page tab events
  document.getElementById('translateBtn')?.addEventListener('click', handleTranslate);
  document.getElementById('targetLanguage')?.addEventListener('change', (e) => {
    updateRecentLanguages(e.target.value).then(recent => {
      renderQuickLanguageButtons('pageQuickLangs', e.target.value, recent, handlePageQuickLangSelect);
    });
  });

  // Text tab events
  document.getElementById('sourceText')?.addEventListener('input', () => {
    updateCharCount();
    saveTextTabState();
  });
  document.getElementById('textTranslateBtn')?.addEventListener('click', handleTextTranslate);
  document.getElementById('clearSourceBtn')?.addEventListener('click', handleClearSource);
  document.getElementById('copyResultBtn')?.addEventListener('click', handleCopyResult);
  document.getElementById('textTargetLang')?.addEventListener('change', (e) => {
    updateRecentLanguages(e.target.value).then(recent => {
      renderQuickLanguageButtons('textQuickLangs', e.target.value, recent, handleTextQuickLangSelect);
    });
  });

  // Keyboard shortcuts
  document.getElementById('sourceText')?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleTextTranslate();
    }
  });

  // History tab events
  document.getElementById('clearHistoryBtn')?.addEventListener('click', clearHistory);

  // Restore text tab state
  restoreTextTabState();
  updateCharCount();

  // Render quick language buttons
  const recentLangs = settings.recentLanguages || DEFAULT_SETTINGS.recentLanguages;
  renderQuickLanguageButtons('pageQuickLangs', settings.targetLanguage, recentLangs, handlePageQuickLangSelect);
  renderQuickLanguageButtons('textQuickLangs', settings.textTargetLang, recentLangs, handleTextQuickLangSelect);

  // Check connection status
  updateConnectionStatusUI({ status: 'checking', message: 'Checking...' });
  const status = await checkServerConnection(settings.proxyUrl);
  updateConnectionStatusUI(status);
}

// Start
if (typeof chrome !== 'undefined' && chrome.storage) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePopup);
  } else {
    initializePopup();
  }
}