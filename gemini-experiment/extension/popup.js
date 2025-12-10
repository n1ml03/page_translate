// Popup Script - Gemini Translator

const DEFAULT_SETTINGS = {
  serverUrl: 'http://localhost:8001/proxy/translate',
  model: 'gemini-2.0-flash',
  targetLanguage: 'English',
  activeTab: 'page',
  textTargetLang: 'English',
  recentLanguages: ['Japanese', 'English', 'Vietnamese'],
  translationHistory: [],
  autoTranslate: false
};

const LANGUAGES = [
  { code: 'Japanese', name: 'Japanese', native: '日本語' },
  { code: 'English', name: 'English', native: 'English' },
  { code: 'Chinese (Simplified)', name: 'Chinese Simplified', native: '简体中文' },
  { code: 'Chinese (Traditional)', name: 'Chinese Traditional', native: '繁體中文' },
  { code: 'Korean', name: 'Korean', native: '한국어' },
  { code: 'Vietnamese', name: 'Vietnamese', native: 'Tiếng Việt' }
];

const MAX_TEXT_LENGTH = 5000, MAX_HISTORY_ITEMS = 20, MAX_RECENT_LANGUAGES = 3, CONNECTION_TIMEOUT = 5000;

const saveSettings = settings => new Promise((resolve, reject) => {
  chrome.storage.local.set(settings, () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve());
});

const loadSettings = () => new Promise((resolve, reject) => {
  chrome.storage.local.get(DEFAULT_SETTINGS, result => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(result));
});

const validateUrl = url => typeof url === 'string' && /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url.trim());

function showToast(message, type = 'info', autoDismissMs = null) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-message">${message}</span><button class="toast-dismiss" aria-label="Dismiss">&times;</button>`;
  toast.querySelector('.toast-dismiss').addEventListener('click', () => dismissToast(toast));
  container.appendChild(toast);

  const defaultTimes = { error: 1500, success: 800, info: 600 };
  const dismissTime = autoDismissMs ?? (defaultTimes[type] || 800);
  if (dismissTime > 0) setTimeout(() => dismissToast(toast), dismissTime);
}

function dismissToast(toast) {
  if (!toast?.parentNode) return;
  toast.classList.add('toast-exit');
  setTimeout(() => toast.parentNode?.removeChild(toast), 200);
}

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

async function checkServerConnection(serverUrl) {
  if (!serverUrl?.trim()) return { status: 'unconfigured', message: 'Not configured' };
  if (!validateUrl(serverUrl)) return { status: 'disconnected', message: 'Invalid URL' };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT);
    const response = await fetch(serverUrl.replace('/proxy/translate', '/health'), { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    return response.ok ? { status: 'connected', message: 'Connected' } : { status: 'disconnected', message: `Error: ${response.status}` };
  } catch (error) {
    return { status: 'disconnected', message: error.name === 'AbortError' ? 'Timeout' : 'Cannot connect' };
  }
}

function openSettingsModal() {
  document.getElementById('settingsModal')?.classList.remove('hidden');
  document.getElementById('serverUrl')?.focus();
}

function closeSettingsModal() { document.getElementById('settingsModal')?.classList.add('hidden'); }

async function handleTestConnection() {
  const serverUrl = document.getElementById('serverUrl').value;
  const resultEl = document.getElementById('connectionResult');
  const testBtn = document.getElementById('testConnectionBtn');
  
  setButtonLoading(testBtn, true);
  resultEl.textContent = 'Testing...';
  resultEl.className = 'connection-result checking';
  
  const status = await checkServerConnection(serverUrl);
  resultEl.textContent = status.message;
  resultEl.className = `connection-result ${status.status}`;
  setButtonLoading(testBtn, false);
}

async function handleSaveSettings() {
  const serverUrl = document.getElementById('serverUrl').value;
  const model = document.getElementById('model').value;
  
  if (!validateUrl(serverUrl)) { showToast('Please enter a valid server URL', 'error'); return; }
  
  setButtonLoading(document.getElementById('saveSettingsBtn'), true);
  
  try {
    await saveSettings({ serverUrl, model });
    showToast('Settings saved!', 'success');
    closeSettingsModal();
    updateConnectionStatusUI({ status: 'checking', message: 'Checking...' });
    updateConnectionStatusUI(await checkServerConnection(serverUrl));
  } catch { showToast('Failed to save settings', 'error'); }
  finally { setButtonLoading(document.getElementById('saveSettingsBtn'), false); }
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('active', content.id === `${tabId}Tab`));
  chrome.storage.local.set({ activeTab: tabId });
  if (tabId === 'history') renderHistoryList();
}

function renderQuickLanguageButtons(containerId, currentLang, recentLanguages, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  container.innerHTML = '';
  recentLanguages.filter(code => code !== currentLang).slice(0, MAX_RECENT_LANGUAGES).forEach(langCode => {
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
  const recent = [langCode, ...(settings.recentLanguages || []).filter(l => l !== langCode)].slice(0, MAX_RECENT_LANGUAGES + 1);
  await saveSettings({ recentLanguages: recent });
  return recent;
}

async function addToHistory(sourceText, translatedText, targetLang) {
  const settings = await loadSettings();
  const entry = {
    id: Date.now(),
    source: sourceText.substring(0, 200),
    translation: translatedText.substring(0, 200),
    targetLang,
    timestamp: new Date().toISOString()
  };
  const newHistory = [entry, ...(settings.translationHistory || [])].slice(0, MAX_HISTORY_ITEMS);
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
        <button type="button" class="history-copy-btn" data-text="${escapeAttr(entry.translation)}" title="Copy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
        <button type="button" class="history-reuse-btn" data-source="${escapeAttr(entry.source)}" title="Translate again">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
        </button>
      </div>
    </div>
  `).join('');
  
  container.querySelectorAll('.history-copy-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      await navigator.clipboard.writeText(e.currentTarget.dataset.text);
      showToast('Copied!', 'success');
    });
  });
  
  container.querySelectorAll('.history-reuse-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      document.getElementById('sourceText').value = e.currentTarget.dataset.source;
      switchTab('text');
      updateCharCount();
    });
  });
}

function formatRelativeTime(isoString) {
  const diffMs = Date.now() - new Date(isoString);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(isoString).toLocaleDateString();
}

const escapeHtml = str => str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeAttr = str => str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function showTranslationProgress(show) {
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
  const translatedTextEl = document.getElementById('translatedText');
  const textTargetLang = document.getElementById('textTargetLang').value;
  const translateBtn = document.getElementById('textTranslateBtn');
  const sourceText = sourceTextEl.value;

  if (!sourceText.trim()) { showToast('Enter text to translate', 'error'); return; }
  if (sourceText.length > MAX_TEXT_LENGTH) { showToast(`Text exceeds ${MAX_TEXT_LENGTH} characters`, 'error'); return; }

  const settings = await loadSettings();
  if (!validateUrl(settings.serverUrl)) { showToast('Configure server URL in Settings', 'error'); openSettingsModal(); return; }

  setButtonLoading(translateBtn, true);
  showTranslationProgress(true);
  translatedTextEl.innerText = '';

  try {
    const response = await fetch(settings.serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: `Translate the following text to ${textTargetLang}. IMPORTANT: Preserve exact formatting - keep all line breaks, paragraph spacing, and special characters exactly as in the original. Return only the translation.` },
          { role: 'user', content: sourceText }
        ],
        model: settings.model || DEFAULT_SETTINGS.model,
        temperature: 0.3,
        html_aware: false
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
  updateRecentLanguages(langCode).then(recent => renderQuickLanguageButtons('pageQuickLangs', langCode, recent, handlePageQuickLangSelect));
}

function handleClearSource() {
  document.getElementById('sourceText').value = '';
  document.getElementById('translatedText').innerText = '';
  updateCharCount();
  saveTextTabState();
}

let lastClipboardText = '', clipboardCheckInterval = null, clipboardPermissionGranted = false;

async function checkClipboardPermission() {
  try {
    if (navigator.permissions?.query) {
      const result = await navigator.permissions.query({ name: 'clipboard-read' });
      clipboardPermissionGranted = result.state === 'granted';
      result.onchange = () => { clipboardPermissionGranted = result.state === 'granted'; };
      return clipboardPermissionGranted;
    }
  } catch {}
  return false;
}

async function readClipboard(requireUserActivation = false) {
  try {
    if (navigator.clipboard?.readText && (clipboardPermissionGranted || requireUserActivation)) {
      const text = await navigator.clipboard.readText();
      if (text) return text;
    }
  } catch (e) {
    if (requireUserActivation && e.name === 'NotAllowedError') showToast('Clipboard access denied. Try Ctrl+V.', 'error');
  }
  
  try {
    const stored = await new Promise(resolve => chrome.storage.local.get(['lastCopiedText', 'lastCopiedTimestamp'], resolve));
    if (stored.lastCopiedTimestamp && Date.now() - stored.lastCopiedTimestamp < 60000) return stored.lastCopiedText;
  } catch {}
  
  return null;
}

async function handlePasteFromClipboard() {
  const pasteBtn = document.getElementById('pasteBtn');
  const sourceTextEl = document.getElementById('sourceText');
  if (!sourceTextEl) return;

  const text = await readClipboard(true);

  if (text?.trim()) {
    sourceTextEl.value = text.trim();
    updateCharCount();
    saveTextTabState();
    chrome.storage.local.remove(['lastCopiedText', 'lastCopiedTimestamp']);
    pasteBtn?.classList.add('pasted');
    setTimeout(() => pasteBtn?.classList.remove('pasted'), 1000);
    if (document.getElementById('autoTranslateToggle')?.checked) handleTextTranslate();
    showToast('Pasted from clipboard', 'success');
  } else {
    showToast('Clipboard is empty or inaccessible', 'info');
  }
}

async function checkClipboardForNewText() {
  let text = null, isFromStorage = false;
  
  try {
    const stored = await new Promise(resolve => chrome.storage.local.get(['lastCopiedText', 'lastCopiedTimestamp'], resolve));
    if (stored.lastCopiedTimestamp && Date.now() - stored.lastCopiedTimestamp < 30000 && stored.lastCopiedText) {
      text = stored.lastCopiedText;
      isFromStorage = true;
    }
  } catch {}
  
  if (!text && clipboardPermissionGranted) text = await readClipboard(false);
  if (!text || text === lastClipboardText) return;
  
  lastClipboardText = text;
  const sourceTextEl = document.getElementById('sourceText');
  
  if (sourceTextEl && !sourceTextEl.value.trim() && document.querySelector('.tab-btn.active')?.dataset.tab === 'text') {
    sourceTextEl.value = text.trim();
    updateCharCount();
    saveTextTabState();
    showToast('Clipboard text loaded', 'info');
    if (document.getElementById('autoTranslateToggle')?.checked) handleTextTranslate();
  }
  
  if (isFromStorage) chrome.storage.local.remove(['lastCopiedText', 'lastCopiedTimestamp']);
}

async function startClipboardMonitoring() {
  await checkClipboardPermission();
  checkClipboardForNewText();
  clipboardCheckInterval = setInterval(checkClipboardForNewText, 1500);
}

function stopClipboardMonitoring() { if (clipboardCheckInterval) { clearInterval(clipboardCheckInterval); clipboardCheckInterval = null; } }

async function handleAutoTranslateToggle(e) {
  await saveSettings({ autoTranslate: e.target.checked });
  if (e.target.checked) {
    showToast('Auto-translate enabled', 'success');
    if (document.getElementById('sourceText')?.value.trim()) handleTextTranslate();
  }
}

function handleSwapTexts() {
  const sourceTextEl = document.getElementById('sourceText');
  const translatedTextEl = document.getElementById('translatedText');
  if (!sourceTextEl || !translatedTextEl) return;
  
  const translatedText = translatedTextEl.innerText;
  if (!translatedText.trim()) { showToast('No translation to swap', 'info'); return; }
  
  const sourceText = sourceTextEl.value;
  sourceTextEl.value = translatedText;
  translatedTextEl.innerText = sourceText;
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
  } catch { showToast('Failed to copy', 'error'); }
}

function saveTextTabState() {
  chrome.storage.local.set({ _textTabState: {
    sourceText: document.getElementById('sourceText')?.value || '',
    translatedText: document.getElementById('translatedText')?.innerText || ''
  }});
}

function restoreTextTabState() {
  chrome.storage.local.get({ _textTabState: null }, r => {
    if (r._textTabState) {
      const sourceEl = document.getElementById('sourceText');
      const translatedEl = document.getElementById('translatedText');
      if (sourceEl) sourceEl.value = r._textTabState.sourceText || '';
      if (translatedEl) translatedEl.innerText = r._textTabState.translatedText || '';
      updateCharCount();
    }
  });
}

async function handleTranslate() {
  const settings = await loadSettings();
  const targetLanguage = document.getElementById('targetLanguage').value;
  const translateBtn = document.getElementById('translateBtn');

  if (!validateUrl(settings.serverUrl)) { showToast('Configure server URL in Settings', 'error'); openSettingsModal(); return; }

  setButtonLoading(translateBtn, true);

  try {
    await saveSettings({ targetLanguage });
    await updateRecentLanguages(targetLanguage);
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { showToast('No active tab found', 'error'); return; }

    chrome.tabs.sendMessage(tab.id, { action: 'translate', targetLanguage }, _response => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js']
        }).then(() => setTimeout(() => chrome.tabs.sendMessage(tab.id, { action: 'translate', targetLanguage }), 100));
      }
      // Check translation status after a short delay
      setTimeout(checkTranslationStatus, 500);
    });

    showToast('Translation started!', 'success');
    // Update UI after translation starts
    setTimeout(checkTranslationStatus, 2000);
  } catch (error) { showToast('Failed: ' + error.message, 'error'); }
  finally { setButtonLoading(translateBtn, false); }
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

async function initializePopup() {
  let settings;
  try { settings = await loadSettings(); } catch { settings = DEFAULT_SETTINGS; }

  document.getElementById('serverUrl').value = settings.serverUrl;
  document.getElementById('model').value = settings.model;
  document.getElementById('targetLanguage').value = settings.targetLanguage;
  document.getElementById('textTargetLang').value = settings.textTargetLang || DEFAULT_SETTINGS.textTargetLang;

  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  if (settings.activeTab) switchTab(settings.activeTab);

  document.getElementById('settingsBtn')?.addEventListener('click', openSettingsModal);
  document.getElementById('closeSettingsBtn')?.addEventListener('click', closeSettingsModal);
  document.getElementById('testConnectionBtn')?.addEventListener('click', handleTestConnection);
  document.getElementById('saveSettingsBtn')?.addEventListener('click', handleSaveSettings);
  document.getElementById('settingsModal')?.addEventListener('click', e => { if (e.target.id === 'settingsModal') closeSettingsModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettingsModal(); });

  document.getElementById('translateBtn')?.addEventListener('click', handleTranslate);
  document.getElementById('toggleTranslationBtn')?.addEventListener('click', handleToggleTranslation);
  document.getElementById('targetLanguage')?.addEventListener('change', e => {
    updateRecentLanguages(e.target.value).then(recent => renderQuickLanguageButtons('pageQuickLangs', e.target.value, recent, handlePageQuickLangSelect));
  });
  
  // Check translation status when popup opens
  checkTranslationStatus();

  document.getElementById('sourceText')?.addEventListener('input', () => { updateCharCount(); saveTextTabState(); });
  document.getElementById('textTranslateBtn')?.addEventListener('click', handleTextTranslate);
  document.getElementById('clearSourceBtn')?.addEventListener('click', handleClearSource);
  document.getElementById('copyResultBtn')?.addEventListener('click', handleCopyResult);
  document.getElementById('pasteBtn')?.addEventListener('click', handlePasteFromClipboard);
  document.getElementById('swapBtn')?.addEventListener('click', handleSwapTexts);
  document.getElementById('textTargetLang')?.addEventListener('change', e => {
    updateRecentLanguages(e.target.value).then(recent => renderQuickLanguageButtons('textQuickLangs', e.target.value, recent, handleTextQuickLangSelect));
  });
  
  const autoTranslateToggle = document.getElementById('autoTranslateToggle');
  if (autoTranslateToggle) {
    autoTranslateToggle.checked = settings.autoTranslate || false;
    autoTranslateToggle.addEventListener('change', handleAutoTranslateToggle);
  }

  document.getElementById('sourceText')?.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); handleTextTranslate(); }
  });

  document.getElementById('clearHistoryBtn')?.addEventListener('click', clearHistory);

  restoreTextTabState();
  updateCharCount();

  const recentLangs = settings.recentLanguages || DEFAULT_SETTINGS.recentLanguages;
  renderQuickLanguageButtons('pageQuickLangs', settings.targetLanguage, recentLangs, handlePageQuickLangSelect);
  renderQuickLanguageButtons('textQuickLangs', settings.textTargetLang, recentLangs, handleTextQuickLangSelect);

  updateConnectionStatusUI({ status: 'checking', message: 'Checking...' });
  updateConnectionStatusUI(await checkServerConnection(settings.serverUrl));
  
  startClipboardMonitoring();
  window.addEventListener('unload', stopClipboardMonitoring);
}

if (typeof chrome !== 'undefined' && chrome.storage) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializePopup);
  else initializePopup();
}
