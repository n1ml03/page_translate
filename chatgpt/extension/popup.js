// Popup Script - Settings UI for Page Translator

const DEFAULT_SETTINGS = {
  proxyUrl: '',
  targetEndpoint: '',
  username: '',
  password: '',
  model: '',
  targetLanguage: 'English'
};

const REQUIRED_FIELDS = ['proxyUrl', 'targetEndpoint', 'username', 'password'];
const CONNECTION_TIMEOUT = 5000;
const FIELD_LABELS = {
  proxyUrl: 'Proxy URL',
  targetEndpoint: 'Target Endpoint',
  username: 'Username',
  password: 'Password'
};

let lastSavedSettings = null;

// ============================================================================
// VALIDATION
// ============================================================================

const validateUrl = (url) => typeof url === 'string' && /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url.trim());

function validateSettings(settings) {
  const errors = new Map();

  for (const field of REQUIRED_FIELDS) {
    const value = settings[field];
    if (!value || (typeof value === 'string' && !value.trim())) {
      errors.set(field, `${FIELD_LABELS[field] || field} is required`);
    }
  }

  if (settings.proxyUrl?.trim() && !errors.has('proxyUrl') && !validateUrl(settings.proxyUrl)) {
    errors.set('proxyUrl', 'Invalid URL format (must start with http:// or https://)');
  }

  if (settings.targetEndpoint?.trim() && !errors.has('targetEndpoint') && !validateUrl(settings.targetEndpoint)) {
    errors.set('targetEndpoint', 'Invalid URL format (must start with http:// or https://)');
  }

  return { isValid: errors.size === 0, errors };
}

// ============================================================================
// STORAGE
// ============================================================================

const saveSettings = (settings) => new Promise((resolve, reject) => {
  chrome.storage.local.set(settings, () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve());
});

const loadSettings = () => new Promise((resolve, reject) => {
  chrome.storage.local.get(DEFAULT_SETTINGS, (result) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(result));
});

// ============================================================================
// FORM
// ============================================================================

const getFormSettings = () => ({
  proxyUrl: document.getElementById('proxyUrl').value,
  targetEndpoint: document.getElementById('targetEndpoint').value,
  username: document.getElementById('username').value,
  password: document.getElementById('password').value,
  model: document.getElementById('model').value,
  targetLanguage: document.getElementById('targetLanguage').value
});

const populateForm = (settings) => {
  document.getElementById('proxyUrl').value = settings.proxyUrl;
  document.getElementById('targetEndpoint').value = settings.targetEndpoint;
  document.getElementById('username').value = settings.username;
  document.getElementById('password').value = settings.password;
  document.getElementById('model').value = settings.model;
  document.getElementById('targetLanguage').value = settings.targetLanguage;
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
    toggleBtn.setAttribute('aria-label', 'Hide password');
  } else {
    input.type = 'password';
    if (eyeIcon) eyeIcon.style.display = 'block';
    if (eyeOffIcon) eyeOffIcon.style.display = 'none';
    toggleBtn.setAttribute('aria-label', 'Show password');
  }
}

// ============================================================================
// CONNECTION STATUS
// ============================================================================

async function checkProxyConnection(proxyUrl) {
  if (!proxyUrl?.trim()) return { status: 'unconfigured', message: 'Configure proxy URL' };
  if (!validateUrl(proxyUrl)) return { status: 'disconnected', message: 'Invalid URL format' };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT);
    await fetch(proxyUrl, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
    clearTimeout(timeoutId);
    return { status: 'connected', message: 'Connected' };
  } catch (error) {
    return { status: 'disconnected', message: error.name === 'AbortError' ? 'Connection timed out' : 'Cannot connect to proxy' };
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
  const statusId = { serverConfigSection: 'serverConfigStatus', authSection: 'authStatus' }[sectionId];
  const el = statusId && document.getElementById(statusId);
  if (el) {
    el.className = `section-status ${isValid ? 'valid' : 'invalid'}`;
    el.innerHTML = `<span class="section-status-dot"></span>${isValid ? 'OK' : '!'}`;
  }
}

const isServerConfigValid = (s) => validateUrl(s.proxyUrl) && validateUrl(s.targetEndpoint);
const isAuthValid = (s) => s.username?.trim() && s.password?.trim();

const updateAllSectionStatuses = (settings) => {
  updateSectionStatus('serverConfigSection', isServerConfigValid(settings));
  updateSectionStatus('authSection', isAuthValid(settings));
};

function autoCollapseSectionsOnSuccess(status, settings) {
  if (status.status !== 'connected') return;
  if (isServerConfigValid(settings)) setSectionCollapsed('serverConfigSection', true);
  if (isAuthValid(settings)) setSectionCollapsed('authSection', true);
  saveCollapsedState();
}

const saveCollapsedState = () => {
  chrome.storage.local.set({
    _collapsed: {
      serverConfigSection: document.getElementById('serverConfigSection')?.classList.contains('collapsed'),
      authSection: document.getElementById('authSection')?.classList.contains('collapsed')
    }
  });
};

const restoreCollapsedState = () => {
  chrome.storage.local.get({ _collapsed: null }, (r) => {
    if (r._collapsed) {
      setSectionCollapsed('serverConfigSection', r._collapsed.serverConfigSection);
      setSectionCollapsed('authSection', r._collapsed.authSection);
    }
  });
};

// ============================================================================
// UNSAVED CHANGES
// ============================================================================

const setLastSavedSettings = (settings) => { lastSavedSettings = { ...settings }; };

const hasUnsavedChanges = () => {
  if (!lastSavedSettings) return false;
  const current = getFormSettings();
  return Object.keys(DEFAULT_SETTINGS).some(key => current[key] !== lastSavedSettings[key]);
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
// HANDLERS
// ============================================================================

async function handleRefreshConnection() {
  const settings = getFormSettings();
  updateConnectionStatusUI({ status: 'checking', message: 'Checking...' });
  setRefreshButtonSpinning(true);

  try {
    const status = await checkProxyConnection(settings.proxyUrl);
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
      const status = await checkProxyConnection(settings.proxyUrl);
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

  // Event listeners
  document.getElementById('saveBtn').addEventListener('click', handleSave);
  document.getElementById('translateBtn').addEventListener('click', handleTranslate);
  document.getElementById('refreshBtn')?.addEventListener('click', handleRefreshConnection);
  document.getElementById('passwordToggle')?.addEventListener('click', () => togglePasswordVisibility('password'));

  ['proxyUrl', 'targetEndpoint', 'username', 'password', 'model'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', handleInputChange);
  });
  document.getElementById('targetLanguage')?.addEventListener('change', handleInputChange);

  document.querySelectorAll('.section-header[data-section]').forEach(header => {
    header.addEventListener('click', () => toggleSection(header.dataset.section));
  });

  updateAllSectionStatuses(settings);
  restoreCollapsedState();

  // Check connection
  updateConnectionStatusUI({ status: 'checking', message: 'Checking...' });
  setRefreshButtonSpinning(true);
  try {
    const status = await checkProxyConnection(settings.proxyUrl);
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
  highlightInvalidField, clearFieldError, togglePasswordVisibility,
  checkProxyConnection, updateConnectionStatusUI, setRefreshButtonSpinning,
  handleRefreshConnection, updateTranslateButtonState, markUnsavedChanges,
  hasUnsavedChanges, setLastSavedSettings, handleInputChange, getFormSettings,
  populateForm, loadSettings, saveSettings, handleSave, handleTranslate,
  toggleSection, setSectionCollapsed, updateSectionStatus, isServerConfigValid,
  isAuthValid, updateAllSectionStatuses, autoCollapseSectionsOnSuccess,
  saveCollapsedState, restoreCollapsedState,
  DEFAULT_SETTINGS, REQUIRED_FIELDS, CONNECTION_TIMEOUT
};
