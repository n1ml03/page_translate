// Popup Script - Page Translator with Settings, History & Quick Language Toggle

const DEFAULT_SETTINGS = {
  proxyUrl: 'http://localhost:8000/proxy/translate',
  targetEndpoint: 'https://llm.api.local/chatapp/api/41_mini',
  username: '',
  encryptedPassword: '',
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

const MAX_TEXT = 5000, MAX_HISTORY = 20, MAX_RECENT = 3, TIMEOUT = 5000;

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
  if (!s.targetEndpoint?.trim()) errors.set('targetEndpoint', 'Target Endpoint required');
  else if (!isValidUrl(s.targetEndpoint)) errors.set('targetEndpoint', 'Invalid URL');
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
  setTimeout(() => dismissToast(toast), ms ?? (type === 'error' ? 2500 : 1500));
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

// ============================================================================
// SETTINGS MODAL
// ============================================================================

const openModal = () => document.getElementById('settingsModal')?.classList.remove('hidden');
const closeModal = () => document.getElementById('settingsModal')?.classList.add('hidden');

async function testConnection() {
  const url = document.getElementById('proxyUrl').value;
  const result = document.getElementById('connectionResult');
  const btn = document.getElementById('testConnectionBtn');
  setLoading(btn, true);
  result.textContent = 'Testing...';
  result.className = 'connection-result checking';
  const s = await checkConnection(url);
  result.textContent = s.message;
  result.className = `connection-result ${s.status}`;
  setLoading(btn, false);
}

async function saveSettingsHandler() {
  const settings = {
    proxyUrl: document.getElementById('proxyUrl').value,
    targetEndpoint: document.getElementById('targetEndpoint').value,
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
    model: document.getElementById('model').value
  };
  const { isValid, errors } = validateSettings(settings);
  if (!isValid) return showToast(errors.values().next().value, 'error');

  setLoading(document.getElementById('saveSettingsBtn'), true);
  try {
    await saveCredentials(settings);
    showToast('Settings saved!', 'success');
    closeModal();
    updateStatus({ status: 'checking', message: 'Checking...' });
    updateStatus(await checkConnection(settings.proxyUrl));
  } catch { showToast('Failed to save', 'error'); }
  finally { setLoading(document.getElementById('saveSettingsBtn'), false); }
}

// ============================================================================
// TABS
// ============================================================================

function switchTab(id) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `${id}Tab`));
  chrome.storage.local.set({ activeTab: id });
  if (id === 'history') renderHistory();
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

  if (!src.trim()) return showToast('Enter text', 'error');
  if (src.length > MAX_TEXT) return showToast(`Max ${MAX_TEXT} chars`, 'error');

  const settings = await loadCredentials();
  if (!validateSettings(settings).isValid) { showToast('Configure settings first', 'error'); return openModal(); }

  setLoading(btn, true);
  showProgress(true);
  outEl.innerText = '';

  try {
    const res = await fetch(settings.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_endpoint: settings.targetEndpoint,
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
    if (!res.ok) throw new Error(`Error: ${res.status}`);
    const data = await res.json();
    const trans = data.choices?.[0]?.message?.content || '';
    outEl.innerText = trans;

    const recent = await updateRecent(lang);
    await addHistory(src, trans, lang);
    renderQuickLangs('textQuickLangs', lang, recent, textQuickSelect);
    chrome.storage.local.set({ textTargetLang: lang });
    saveTextState();
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
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

async function translatePage() {
  const settings = await loadCredentials();
  const lang = document.getElementById('targetLanguage').value;
  const btn = document.getElementById('translateBtn');

  if (!validateSettings(settings).isValid) { showToast('Configure settings first', 'error'); return openModal(); }

  setLoading(btn, true);
  try {
    await saveSettings({ targetLanguage: lang });
    await updateRecent(lang);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return showToast('No active tab', 'error');

    chrome.tabs.sendMessage(tab.id, { action: 'translate' }, res => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
          .then(() => setTimeout(() => chrome.tabs.sendMessage(tab.id, { action: 'translate' }), 100));
      }
    });
    showToast('Translation started!', 'success');
  } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  finally { setLoading(btn, false); }
}

// ============================================================================
// INIT
// ============================================================================

async function init() {
  let settings;
  try { settings = await loadCredentials(); } catch { settings = DEFAULT_SETTINGS; }

  document.getElementById('proxyUrl').value = settings.proxyUrl;
  document.getElementById('targetEndpoint').value = settings.targetEndpoint;
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
  document.getElementById('targetLanguage')?.addEventListener('change', e => updateRecent(e.target.value).then(r => renderQuickLangs('pageQuickLangs', e.target.value, r, pageQuickSelect)));

  // Text tab
  document.getElementById('sourceText')?.addEventListener('input', () => { updateCharCount(); saveTextState(); });
  document.getElementById('textTranslateBtn')?.addEventListener('click', translateText);
  document.getElementById('clearSourceBtn')?.addEventListener('click', clearSource);
  document.getElementById('copyResultBtn')?.addEventListener('click', copyResult);
  document.getElementById('textTargetLang')?.addEventListener('change', e => updateRecent(e.target.value).then(r => renderQuickLangs('textQuickLangs', e.target.value, r, textQuickSelect)));
  document.getElementById('sourceText')?.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); translateText(); } });

  // History
  document.getElementById('clearHistoryBtn')?.addEventListener('click', clearHistory);

  restoreTextState();
  updateCharCount();

  const recent = settings.recentLanguages || DEFAULT_SETTINGS.recentLanguages;
  renderQuickLangs('pageQuickLangs', settings.targetLanguage, recent, pageQuickSelect);
  renderQuickLangs('textQuickLangs', settings.textTargetLang, recent, textQuickSelect);

  updateStatus({ status: 'checking', message: 'Checking...' });
  updateStatus(await checkConnection(settings.proxyUrl));
}

if (typeof chrome !== 'undefined' && chrome.storage) {
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
}
