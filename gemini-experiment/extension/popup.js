// Popup Script - Gemini Translator with Page & Text Translation

const DEFAULT_SETTINGS = {
  serverUrl: 'http://192.168.110.58:8001/proxy/translate',
  model: 'gemini-2.0-flash',
  targetLanguage: 'English',
  activeTab: 'page',
  textModel: 'gemini-2.0-flash',
  textTargetLang: 'English'
};

const REQUIRED_FIELDS = ['serverUrl'];
const CONNECTION_TIMEOUT = 5000;
const MAX_TEXT_LENGTH = 5000;

let lastSavedSettings = null;

// ============================================================================
// VALIDATION & STORAGE
// ============================================================================

const validateUrl = (url) => typeof url === 'string' && /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url.trim());

function validateSettings(settings) {
  const errors = new Map();
  for (const field of REQUIRED_FIELDS) {
    const value = settings[field];
    if (!value || (typeof value === 'string' && !value.trim())) {
      errors.set(field, `${field} is required`);
    }
  }
  if (settings.serverUrl?.trim() && !errors.has('serverUrl') && !validateUrl(settings.serverUrl)) {
    errors.set('serverUrl', 'Invalid URL format');
  }
  return { isValid: errors.size === 0, errors };
}

const saveSettings = (settings) => new Promise((resolve, reject) => {
  chrome.storage.local.set(settings, () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve());
});

const loadSettings = () => new Promise((resolve, reject) => {
  chrome.storage.local.get(DEFAULT_SETTINGS, (result) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(result));
});

// ============================================================================
// FORM HELPERS
// ============================================================================

const getFormSettings = () => ({
  serverUrl: document.getElementById('serverUrl').value,
  model: document.getElementById('model').value,
  targetLanguage: document.getElementById('targetLanguage').value,
  textModel: document.getElementById('textModel').value,
  textTargetLang: document.getElementById('textTargetLang').value
});

const populateForm = (settings) => {
  document.getElementById('serverUrl').value = settings.serverUrl;
  document.getElementById('model').value = settings.model;
  document.getElementById('targetLanguage').value = settings.targetLanguage;
  document.getElementById('textModel').value = settings.textModel || DEFAULT_SETTINGS.textModel;
  document.getElementById('textTargetLang').value = settings.textTargetLang || DEFAULT_SETTINGS.textTargetLang;
};

// ============================================================================
// TOAST
// ============================================================================

function showToast(message, type = 'info', autoDismissMs = null) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-message">${message}</span><button class="toast-dismiss" aria-label="Dismiss">&times;</button>`;
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

function setButtonLoading(buttonId, loading) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  if (loading && !button.dataset.originalText) button.dataset.originalText = button.textContent;
  button.disabled = loading;
  const spinner = button.querySelector('.spinner');
  if (loading && !spinner) {
    const s = document.createElement('span');
    s.className = 'spinner';
    button.insertBefore(s, button.firstChild);
  } else if (!loading && spinner) {
    spinner.remove();
  }
}

function highlightInvalidField(fieldId, errorMessage) {
  const field = document.getElementById(fieldId);
  const formGroup = field?.closest('.form-group');
  if (!formGroup) return;
  formGroup.classList.add('has-error');
  let errorEl = formGroup.querySelector('.field-error-message');
  if (!errorEl) {
    errorEl = document.createElement('span');
    errorEl.className = 'field-error-message';
    formGroup.appendChild(errorEl);
  }
  errorEl.textContent = errorMessage;
}

function clearFieldError(fieldId) {
  const field = document.getElementById(fieldId);
  const formGroup = field?.closest('.form-group');
  if (!formGroup) return;
  formGroup.classList.remove('has-error');
  formGroup.querySelector('.field-error-message')?.remove();
}

// ============================================================================
// CONNECTION STATUS
// ============================================================================

async function checkServerConnection(serverUrl) {
  if (!serverUrl?.trim()) return { status: 'unconfigured', message: 'Configure server URL' };
  if (!validateUrl(serverUrl)) return { status: 'disconnected', message: 'Invalid URL format' };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT);
    const healthUrl = serverUrl.replace('/proxy/translate', '/health');
    const response = await fetch(healthUrl, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    return response.ok ? { status: 'connected', message: 'Connected' } : { status: 'disconnected', message: `Error: ${response.status}` };
  } catch (error) {
    return { status: 'disconnected', message: error.name === 'AbortError' ? 'Timeout' : 'Cannot connect' };
  }
}

function updateConnectionStatusUI({ status, message }) {
  const indicator = document.getElementById('statusIndicator');
  if (!indicator) return;
  indicator.classList.remove('connected', 'disconnected', 'unconfigured', 'checking');
  indicator.classList.add(status);
  const statusText = indicator.querySelector('.status-text');
  if (statusText) statusText.textContent = message;
}

function setRefreshButtonSpinning(spinning) {
  const btn = document.getElementById('refreshBtn');
  if (!btn) return;
  btn.classList.toggle('spinning', spinning);
  btn.disabled = spinning;
}

// ============================================================================
// SECTION COLLAPSE
// ============================================================================

const toggleSection = (sectionId) => {
  document.getElementById(sectionId)?.classList.toggle('collapsed');
  saveCollapsedState();
};

const setSectionCollapsed = (sectionId, collapsed) => {
  document.getElementById(sectionId)?.classList.toggle('collapsed', collapsed);
};

function updateSectionStatus(sectionId, isValid) {
  const statusId = { serverConfigSection: 'serverConfigStatus' }[sectionId];
  const el = statusId && document.getElementById(statusId);
  if (el) {
    el.className = `section-status ${isValid ? 'valid' : 'invalid'}`;
    el.innerHTML = `<span class="section-status-dot"></span>${isValid ? 'OK' : '!'}`;
  }
}

const updateAllSectionStatuses = (settings) => {
  updateSectionStatus('serverConfigSection', validateUrl(settings.serverUrl));
};

function autoCollapseSectionsOnSuccess(status, settings) {
  if (status.status !== 'connected') return;
  if (validateUrl(settings.serverUrl)) setSectionCollapsed('serverConfigSection', true);
  saveCollapsedState();
}

const saveCollapsedState = () => {
  chrome.storage.local.set({ _collapsed: { serverConfigSection: document.getElementById('serverConfigSection')?.classList.contains('collapsed') } });
};

const restoreCollapsedState = () => {
  chrome.storage.local.get({ _collapsed: null }, (r) => {
    if (r._collapsed) setSectionCollapsed('serverConfigSection', r._collapsed.serverConfigSection);
  });
};

// ============================================================================
// UNSAVED CHANGES
// ============================================================================

const setLastSavedSettings = (settings) => { lastSavedSettings = { ...settings }; };

const hasUnsavedChanges = () => {
  if (!lastSavedSettings) return false;
  const current = getFormSettings();
  return ['serverUrl', 'model', 'targetLanguage'].some(key => current[key] !== lastSavedSettings[key]);
};

const markUnsavedChanges = (hasChanges) => {
  document.getElementById('saveBtn')?.classList.toggle('has-changes', hasChanges);
};

const updateTranslateButtonState = (settings) => {
  const btn = document.getElementById('translateBtn');
  if (btn) btn.disabled = !validateSettings(settings).isValid;
};

function handleInputChange() {
  markUnsavedChanges(hasUnsavedChanges());
  const settings = getFormSettings();
  updateTranslateButtonState(settings);
  updateAllSectionStatuses(settings);
}

// ============================================================================
// TAB MANAGEMENT
// ============================================================================

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('active', content.id === `${tabId}Tab`));
  chrome.storage.local.set({ activeTab: tabId });
}

// ============================================================================
// TEXT TRANSLATION
// ============================================================================

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

async function handleTextTranslate() {
  const sourceTextEl = document.getElementById('sourceText');
  const sourceText = sourceTextEl.value;
  const translatedText = document.getElementById('translatedText');
  const textModel = document.getElementById('textModel').value;
  const textTargetLang = document.getElementById('textTargetLang').value;

  if (!sourceText.trim()) {
    showToast('Enter text to translate', 'error');
    return;
  }

  if (sourceText.length > MAX_TEXT_LENGTH) {
    showToast(`Text exceeds ${MAX_TEXT_LENGTH} characters`, 'error');
    return;
  }

  const settings = await loadSettings();
  if (!validateUrl(settings.serverUrl)) {
    showToast('Configure server URL in Page tab', 'error');
    return;
  }

  setButtonLoading('textTranslateBtn', true);
  translatedText.innerText = '';
  translatedText.classList.add('loading');

  try {
    const response = await fetch(settings.serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: `Translate the following text to ${textTargetLang}. IMPORTANT: Preserve exact formatting - keep all line breaks, paragraph spacing, and special characters exactly as in the original. Return only the translation.` },
          { role: 'user', content: sourceText }
        ],
        model: textModel,
        temperature: 0.3,
        html_aware: false
      })
    });

    if (!response.ok) throw new Error(`Server error: ${response.status}`);

    const data = await response.json();
    const translation = data.choices?.[0]?.message?.content || '';
    translatedText.innerText = translation;

    // Save preferences and state
    chrome.storage.local.set({ textModel, textTargetLang });
    saveTextTabState();
  } catch (error) {
    showToast(`Translation failed: ${error.message}`, 'error');
    translatedText.textContent = '';
  } finally {
    translatedText.classList.remove('loading');
    setButtonLoading('textTranslateBtn', false);
  }
}

function handleClearSource() {
  const sourceText = document.getElementById('sourceText');
  const translatedText = document.getElementById('translatedText');
  if (sourceText) sourceText.value = '';
  if (translatedText) translatedText.innerText = '';
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

// ============================================================================
// PAGE TRANSLATION HANDLERS
// ============================================================================

async function handleRefreshConnection() {
  const settings = getFormSettings();
  updateConnectionStatusUI({ status: 'checking', message: 'Checking...' });
  setRefreshButtonSpinning(true);
  try {
    const status = await checkServerConnection(settings.serverUrl);
    updateConnectionStatusUI(status);
    autoCollapseSectionsOnSuccess(status, settings);
  } finally {
    setRefreshButtonSpinning(false);
  }
}

async function handleSave() {
  const settings = getFormSettings();
  REQUIRED_FIELDS.forEach(clearFieldError);

  const { isValid, errors } = validateSettings(settings);
  if (!isValid) {
    let firstField = null;
    errors.forEach((msg, fieldId) => {
      highlightInvalidField(fieldId, msg);
      if (!firstField) firstField = fieldId;
    });
    document.getElementById(firstField)?.focus();
    showToast('Please fix validation errors', 'error');
    return;
  }

  setButtonLoading('saveBtn', true);
  try {
    await saveSettings(settings);
    setLastSavedSettings(settings);
    markUnsavedChanges(false);
    showToast('Settings saved!', 'success');
    updateTranslateButtonState(settings);
    updateAllSectionStatuses(settings);

    updateConnectionStatusUI({ status: 'checking', message: 'Checking...' });
    setRefreshButtonSpinning(true);
    try {
      const status = await checkServerConnection(settings.serverUrl);
      updateConnectionStatusUI(status);
      autoCollapseSectionsOnSuccess(status, settings);
    } finally {
      setRefreshButtonSpinning(false);
    }
  } catch (error) {
    showToast('Failed to save: ' + error.message, 'error');
  } finally {
    setButtonLoading('saveBtn', false);
  }
}

async function handleTranslate() {
  const settings = getFormSettings();
  REQUIRED_FIELDS.forEach(clearFieldError);

  const { isValid, errors } = validateSettings(settings);
  if (!isValid) {
    let firstField = null;
    errors.forEach((msg, fieldId) => {
      highlightInvalidField(fieldId, msg);
      if (!firstField) firstField = fieldId;
    });
    document.getElementById(firstField)?.focus();
    showToast('Configure required settings first', 'error');
    return;
  }

  setButtonLoading('translateBtn', true);
  try {
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
    setButtonLoading('translateBtn', false);
  }
}

// ============================================================================
// INIT
// ============================================================================

async function initializePopup() {
  let settings;
  try {
    settings = await loadSettings();
    populateForm(settings);
    setLastSavedSettings(settings);
    updateTranslateButtonState(settings);
  } catch {
    settings = DEFAULT_SETTINGS;
    setLastSavedSettings(settings);
    updateTranslateButtonState(settings);
  }

  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Restore active tab
  if (settings.activeTab) switchTab(settings.activeTab);

  // Page tab events
  document.getElementById('saveBtn').addEventListener('click', handleSave);
  document.getElementById('translateBtn').addEventListener('click', handleTranslate);
  document.getElementById('refreshBtn')?.addEventListener('click', handleRefreshConnection);

  ['serverUrl', 'model'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', handleInputChange);
  });
  document.getElementById('targetLanguage')?.addEventListener('change', handleInputChange);

  document.querySelectorAll('.section-header[data-section]').forEach(header => {
    header.addEventListener('click', () => toggleSection(header.dataset.section));
  });

  // Text tab events
  document.getElementById('sourceText')?.addEventListener('input', () => {
    updateCharCount();
    saveTextTabState();
  });
  document.getElementById('textTranslateBtn')?.addEventListener('click', handleTextTranslate);
  document.getElementById('clearSourceBtn')?.addEventListener('click', handleClearSource);
  document.getElementById('copyResultBtn')?.addEventListener('click', handleCopyResult);

  // Ctrl+Enter to translate
  document.getElementById('sourceText')?.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') handleTextTranslate();
  });

  // Restore text tab state
  restoreTextTabState();

  updateAllSectionStatuses(settings);
  restoreCollapsedState();
  updateCharCount();

  // Check connection
  updateConnectionStatusUI({ status: 'checking', message: 'Checking...' });
  setRefreshButtonSpinning(true);
  try {
    const status = await checkServerConnection(settings.serverUrl);
    updateConnectionStatusUI(status);
    autoCollapseSectionsOnSuccess(status, settings);
  } finally {
    setRefreshButtonSpinning(false);
  }
}

if (typeof chrome !== 'undefined' && chrome.storage) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePopup);
  } else {
    initializePopup();
  }
}

// Export for testing
export {
  validateUrl, validateSettings, showToast, dismissToast, setButtonLoading,
  highlightInvalidField, clearFieldError, checkServerConnection, updateConnectionStatusUI,
  setRefreshButtonSpinning, handleRefreshConnection, updateTranslateButtonState,
  markUnsavedChanges, hasUnsavedChanges, setLastSavedSettings, handleInputChange,
  getFormSettings, populateForm, loadSettings, saveSettings, handleSave, handleTranslate,
  toggleSection, setSectionCollapsed, updateSectionStatus, updateAllSectionStatuses,
  autoCollapseSectionsOnSuccess, saveCollapsedState, restoreCollapsedState,
  switchTab, handleTextTranslate, handleClearSource, handleCopyResult, updateCharCount,
  saveTextTabState, restoreTextTabState,
  DEFAULT_SETTINGS, REQUIRED_FIELDS, CONNECTION_TIMEOUT, MAX_TEXT_LENGTH
};
