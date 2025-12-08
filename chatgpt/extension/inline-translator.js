/**
 * InlineTranslator - Inline translation with Shadow DOM isolation
 */
class InlineTranslator {
  static MAX_TEXT = 1000;
  static INLINE_TAGS = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'SPAN', 'A', 'FONT', 'SMALL', 'BIG', 'SUB', 'SUP', 'BR', 'IMG', 'CODE', 'MARK', 'DEL', 'INS', 'S']);
  static BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'ARTICLE', 'SECTION']);

  constructor(opts = {}) {
    this.translateFn = opts.translateFn || this._mock.bind(this);
    this.languages = opts.languages || [
      { code: 'ja', name: 'Japanese', native: '日本語' },
      { code: 'en', name: 'English', native: 'English' },
      { code: 'zh-CN', name: 'Chinese Simplified', native: '简体中文' },
      { code: 'zh-TW', name: 'Chinese Traditional', native: '繁體中文' },
      { code: 'ko', name: 'Korean', native: '한국어' },
      { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
    ];
    this.defaultLang = opts.defaultLang || 'en';
    this.iconUrl = opts.iconUrl || null;
    this.onHistoryAdd = opts.onHistoryAdd || null;
    this.recentLanguages = opts.recentLanguages || ['en', 'ja', 'vi'];

    this.host = null;
    this.shadow = null;
    this.icon = null;
    this.panel = null;
    this.selectedText = '';
    this.selectionRect = null;
    this.currentLang = this.defaultLang;
    this.isTranslating = false;
    this.selectionRange = null;
    this.abortCtrl = null;
    this.startTime = null;
    this._listeners = [];

    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onMouseDown = this._handleClickOutside.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onScroll = this._debounce(this._handleScroll.bind(this), 100);
    this._onRevert = this._handleRevert.bind(this);
  }

  updateRecentLanguages(langs) { this.recentLanguages = langs; }

  // ============================================================================
  // STYLES
  // ============================================================================

  static getStyles() {
    return `
      :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
      * { box-sizing: border-box; }
      .it-icon { position: fixed; width: 28px; height: 28px; background: transparent; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2147483647; padding: 0; opacity: 0.9; animation: pulse 0.3s ease-out; }
      @keyframes pulse { 0% { transform: scale(0.8); opacity: 0; } 50% { transform: scale(1.1); } 100% { transform: scale(1); opacity: 0.9; } }
      .it-icon:hover { transform: scale(1.15); opacity: 1; }
      .it-icon svg { width: 22px; height: 22px; fill: #4285f4; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.25)); }
      .it-icon img { width: 28px; height: 28px; object-fit: contain; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.25)); }
      .it-panel { position: fixed; width: calc(100vw - 30px); max-width: 520px; min-width: 300px; background: #fff; border-radius: 12px; box-shadow: 0 6px 32px rgba(0, 0, 0, 0.18); z-index: 2147483647; overflow: hidden; animation: fadeIn 0.2s ease; }
      @media (min-width: 1200px) { .it-panel { max-width: 600px; } }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
      .it-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: linear-gradient(135deg, #4285f4, #34a853); color: white; }
      .it-title { font-size: 14px; font-weight: 600; }
      .it-close { width: 24px; height: 24px; background: rgba(255, 255, 255, 0.2); border: none; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
      .it-close:hover { background: rgba(255, 255, 255, 0.3); }
      .it-close svg { width: 14px; height: 14px; fill: white; }
      .it-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
      .it-quick { display: flex; gap: 6px; flex-wrap: wrap; }
      .it-quick-btn { padding: 4px 10px; font-size: 12px; font-weight: 500; color: #4285f4; background: rgba(66, 133, 244, 0.1); border: 1px solid rgba(66, 133, 244, 0.3); border-radius: 4px; cursor: pointer; }
      .it-quick-btn:hover { background: rgba(66, 133, 244, 0.2); border-color: #4285f4; }
      .it-quick-btn.active { background: #4285f4; color: white; border-color: #4285f4; }
      .it-select { flex: 1; padding: 8px 10px; font-size: 13px; border: 1px solid #e0e0e0; border-radius: 6px; background: #f8f9fa; cursor: pointer; outline: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24'%3E%3Cpath fill='%23666' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; }
      .it-select:focus { border-color: #4285f4; }
      .it-label { font-size: 10px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; display: block; }
      .it-box { width: 100%; padding: 10px 12px; font-size: 14px; line-height: 1.5; border: 1px solid #e0e0e0; border-radius: 8px; background: #f8f9fa; min-height: 60px; max-height: 120px; overflow-y: auto; word-wrap: break-word; }
      .it-box.source { color: #333; }
      .it-box.translated { background: #e8f5e9; border-color: #c8e6c9; color: #2e7d32; }
      .it-box.loading { display: flex; flex-direction: column; align-items: center; justify-content: center; color: #888; min-height: 80px; }
      .it-box.error { background: #ffebee; border-color: #ffcdd2; color: #c5221f; }
      .it-progress { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 8px; }
      .it-progress-bar { width: 80%; height: 4px; background: #e0e0e0; border-radius: 2px; overflow: hidden; }
      .it-progress-fill { height: 100%; background: linear-gradient(90deg, #4285f4, #34a853); border-radius: 2px; transition: width 0.3s ease; animation: progressPulse 1.5s ease-in-out infinite; }
      @keyframes progressPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
      .it-progress-text { font-size: 12px; color: #666; }
      .it-elapsed { font-size: 11px; color: #999; }
      .it-btns { display: flex; gap: 8px; margin-top: 4px; }
      .it-btn { flex: 1; padding: 8px; font-size: 13px; font-weight: 500; color: white; background: linear-gradient(135deg, #4285f4, #34a853); border: none; border-radius: 6px; cursor: pointer; }
      .it-btn:hover { opacity: 0.9; }
      .it-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .it-btn.copied, .it-btn.replaced { background: #34a853; }
      .it-btn.retry { background: #f44336; flex: 0 0 auto; padding: 8px 16px; }
      .it-hint { font-size: 10px; color: #999; text-align: center; margin-top: 4px; }
      .it-kbd { display: inline-block; padding: 1px 4px; background: #f0f0f0; border: 1px solid #ddd; border-radius: 3px; font-family: monospace; font-size: 10px; }
    `;
  }

  async _mock(text, lang, signal) {
    await new Promise((res, rej) => {
      const t = setTimeout(res, 500 + Math.random() * 500);
      signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); });
    });
    return `[${lang.toUpperCase()}] ${text}`;
  }

  // ============================================================================
  // INIT
  // ============================================================================

  init() {
    this._createHost();
    this._attachListeners();
  }

  destroy() {
    this._cancel();
    this._removeListeners();
    this._cleanupListeners();
    if (this.host) { this.host.remove(); this.host = null; this.shadow = null; }
    this.icon = null;
    this.panel = null;
  }

  _createHost() {
    this.host = document.createElement('div');
    this.host.id = 'inline-translator-host';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = InlineTranslator.getStyles();
    this.shadow.appendChild(style);
    document.body.appendChild(this.host);
    this._injectReplacedStyles();
  }

  _injectReplacedStyles() {
    if (document.getElementById('inline-translator-replaced-styles')) return;
    const style = document.createElement('style');
    style.id = 'inline-translator-replaced-styles';
    style.textContent = `
      .pt-inline-replaced { background-color: rgba(52, 168, 83, 0.15) !important; border-radius: 2px !important; cursor: pointer !important; position: relative !important; display: inline !important; }
      .pt-inline-replaced:hover { background-color: rgba(52, 168, 83, 0.25) !important; }
      .pt-inline-replaced::after { content: '↩' !important; position: absolute !important; top: -10px !important; right: -10px !important; width: 18px !important; height: 18px !important; background: #f44336 !important; color: white !important; font-size: 11px !important; line-height: 18px !important; text-align: center !important; border-radius: 50% !important; opacity: 0 !important; transform: scale(0.8) !important; transition: opacity 0.15s ease, transform 0.15s ease !important; pointer-events: none !important; z-index: 10000 !important; }
      .pt-inline-replaced:hover::after { opacity: 1 !important; transform: scale(1) !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  _attachListeners() {
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('scroll', this._onScroll, true);
    document.addEventListener('click', this._onRevert);
  }

  _removeListeners() {
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('scroll', this._onScroll, true);
    document.removeEventListener('click', this._onRevert);
  }

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  _handleKeyDown(e) {
    if (e.key === 'Escape') {
      if (this.panel) { this._hidePanel(); e.preventDefault(); }
      else if (this.icon) { this._hideIcon(); e.preventDefault(); }
    }
  }

  _handleScroll() {
    if (this.panel && this.selectionRect) {
      try {
        const sel = window.getSelection();
        if (sel?.rangeCount > 0) {
          this.selectionRect = this._getRect(sel.getRangeAt(0));
          const pos = this._panelPos(this.selectionRect, this._panelWidth(), 320);
          this.panel.style.left = `${pos.left}px`;
          this.panel.style.top = `${pos.top}px`;
        }
      } catch {}
    }
    if (this.icon && this.selectionRect) {
      const pos = this._iconPos(this.selectionRect);
      this.icon.style.left = `${pos.left}px`;
      this.icon.style.top = `${pos.top}px`;
    }
  }

  _handleMouseUp(e) {
    if (this.host?.contains(e.target) || e.target === this.host) return;
    setTimeout(() => {
      let sel, text;
      try { sel = window.getSelection(); text = sel?.toString().trim(); } catch { return; }
      if (!text) return;
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
      try {
        const range = sel.getRangeAt(0);
        this.selectionRect = this._getRect(range);
        this.selectedText = text;
        this.selectionRange = range.cloneRange();
        this._hidePanel();
        this._showIcon();
      } catch {}
    }, 10);
  }

  _handleClickOutside(e) {
    const path = e.composedPath();
    const inside = path.some(el => el === this.icon || el === this.panel || el === this.host);
    if (!inside && !this.shadow?.contains(e.target)) {
      this._hideIcon();
      this._hidePanel();
    }
  }

  _handleRevert(e) {
    const target = e.target;
    if (!target.classList?.contains('pt-inline-replaced')) return;
    const orig = target.dataset.ptOriginal;
    const origHtml = target.dataset.ptOriginalHtml;
    if (!orig && !origHtml) return;
    e.preventDefault();
    e.stopPropagation();
    const parent = target.parentNode;
    if (!parent) return;
    if (origHtml) {
      const temp = document.createElement('div');
      temp.innerHTML = origHtml;
      const frag = document.createDocumentFragment();
      while (temp.firstChild) frag.appendChild(temp.firstChild);
      parent.replaceChild(frag, target);
    } else if (orig.includes('\n')) {
      const wrapper = document.createElement('span');
      wrapper.style.whiteSpace = 'pre-wrap';
      this._setTextLines(wrapper, orig);
      parent.replaceChild(wrapper, target);
    } else {
      parent.replaceChild(document.createTextNode(orig), target);
    }
    window.getSelection()?.removeAllRanges();
  }


  // ============================================================================
  // ICON
  // ============================================================================

  _showIcon() {
    this._hideIcon();
    const icon = document.createElement('button');
    icon.className = 'it-icon';
    icon.setAttribute('aria-label', 'Translate');
    icon.title = 'Translate selection';

    if (this.iconUrl && this._validUrl(this.iconUrl)) {
      const img = document.createElement('img');
      img.src = this.iconUrl;
      img.alt = 'Translate';
      icon.appendChild(img);
    } else {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z');
      svg.appendChild(path);
      icon.appendChild(svg);
    }

    const handler = e => { e.stopPropagation(); this._hideIcon(); this._showPanel(); };
    icon.addEventListener('click', handler);
    this._listeners.push({ el: icon, type: 'click', fn: handler });

    const pos = this._iconPos(this.selectionRect);
    icon.style.left = `${pos.left}px`;
    icon.style.top = `${pos.top}px`;

    this.icon = icon;
    this.shadow.appendChild(icon);
  }

  _validUrl(url) {
    try {
      const p = new URL(url, window.location.href);
      return ['http:', 'https:', 'data:', 'chrome-extension:'].includes(p.protocol);
    } catch { return false; }
  }

  _hideIcon() {
    if (this.icon) { this.icon.remove(); this.icon = null; }
  }

  // ============================================================================
  // PANEL
  // ============================================================================

  _showPanel() {
    this._hidePanel();
    this.isTranslating = false;

    const truncated = this.selectedText.length > InlineTranslator.MAX_TEXT;
    const text = truncated ? this.selectedText.substring(0, InlineTranslator.MAX_TEXT) : this.selectedText;

    const panel = document.createElement('div');
    panel.className = 'it-panel';
    panel.setAttribute('role', 'dialog');
    this._buildPanel(panel, text, truncated);

    const pos = this._panelPos(this.selectionRect, this._panelWidth(), 380);
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;

    this.panel = panel;
    this.shadow.appendChild(panel);
    panel.querySelector('.it-select')?.focus();
    this._translate(panel);
  }

  _buildPanel(panel, text, truncated) {
    // Header
    const header = document.createElement('div');
    header.className = 'it-header';
    const title = document.createElement('span');
    title.className = 'it-title';
    title.textContent = 'Translate';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'it-close';
    closeBtn.title = 'Close (Esc)';
    closeBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    const closeHandler = () => this._hidePanel();
    closeBtn.addEventListener('click', closeHandler);
    this._listeners.push({ el: closeBtn, type: 'click', fn: closeHandler });
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'it-body';

    // Quick langs
    const quick = document.createElement('div');
    quick.className = 'it-quick';
    this.recentLanguages.forEach(code => {
      const lang = this.languages.find(l => l.code === code);
      if (!lang) return;
      const btn = document.createElement('button');
      btn.className = 'it-quick-btn' + (code === this.currentLang ? ' active' : '');
      btn.textContent = lang.native;
      btn.title = lang.name;
      btn.dataset.lang = code;
      const handler = () => {
        this.currentLang = code;
        quick.querySelectorAll('.it-quick-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        panel.querySelector('.it-select').value = code;
        this._translate(panel);
      };
      btn.addEventListener('click', handler);
      this._listeners.push({ el: btn, type: 'click', fn: handler });
      quick.appendChild(btn);
    });
    body.appendChild(quick);

    // Select
    const select = document.createElement('select');
    select.className = 'it-select';
    this.languages.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.name;
      if (l.code === this.currentLang) opt.selected = true;
      select.appendChild(opt);
    });
    const selectHandler = e => {
      e.stopPropagation();
      this.currentLang = e.target.value;
      quick.querySelectorAll('.it-quick-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === this.currentLang));
      this._translate(panel);
    };
    select.addEventListener('change', selectHandler);
    this._listeners.push({ el: select, type: 'change', fn: selectHandler });
    body.appendChild(select);

    // Source
    const srcSection = document.createElement('div');
    const srcLabel = document.createElement('span');
    srcLabel.className = 'it-label';
    srcLabel.textContent = 'Source';
    srcSection.appendChild(srcLabel);
    const srcBox = document.createElement('div');
    srcBox.className = 'it-box source';
    srcBox.style.whiteSpace = 'pre-wrap';
    this._setTextLines(srcBox, text);
    srcSection.appendChild(srcBox);
    body.appendChild(srcSection);

    // Translation
    const transSection = document.createElement('div');
    const transLabel = document.createElement('span');
    transLabel.className = 'it-label';
    transLabel.textContent = 'Translation';
    transSection.appendChild(transLabel);
    const transBox = document.createElement('div');
    transBox.className = 'it-box translated loading';
    transBox.innerHTML = `<div class="it-progress"><div class="it-progress-bar"><div class="it-progress-fill" style="width:30%"></div></div><span class="it-progress-text">Translating...</span><span class="it-elapsed"></span></div>`;
    transSection.appendChild(transBox);
    body.appendChild(transSection);

    // Buttons
    const btns = document.createElement('div');
    btns.className = 'it-btns';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'it-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.disabled = true;
    const copyHandler = () => this._copy(panel);
    copyBtn.addEventListener('click', copyHandler);
    this._listeners.push({ el: copyBtn, type: 'click', fn: copyHandler });
    btns.appendChild(copyBtn);

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'it-btn';
    replaceBtn.textContent = 'Replace';
    replaceBtn.disabled = true;
    const replaceHandler = () => this._replace(panel);
    replaceBtn.addEventListener('click', replaceHandler);
    this._listeners.push({ el: replaceBtn, type: 'click', fn: replaceHandler });
    btns.appendChild(replaceBtn);
    body.appendChild(btns);

    // Hint
    const hint = document.createElement('div');
    hint.className = 'it-hint';
    hint.innerHTML = 'Press <span class="it-kbd">Esc</span> to close';
    body.appendChild(hint);

    panel.appendChild(body);
  }

  _hidePanel() {
    this._cancel();
    this._cleanupListeners();
    if (this.panel) { this.panel.remove(); this.panel = null; }
    this.isTranslating = false;
    this.startTime = null;
  }

  _cancel() {
    if (this.abortCtrl) { this.abortCtrl.abort(); this.abortCtrl = null; }
  }

  _cleanupListeners() {
    this._listeners.forEach(({ el, type, fn }) => el.removeEventListener(type, fn));
    this._listeners = [];
  }

  // ============================================================================
  // TRANSLATION
  // ============================================================================

  async _translate(panel) {
    if (this.isTranslating) this._cancel();

    const transBox = panel.querySelector('.it-box.translated');
    const copyBtn = panel.querySelector('.it-btn');
    const replaceBtn = panel.querySelectorAll('.it-btn')[1];
    const btns = panel.querySelector('.it-btns');

    btns.querySelector('.it-btn.retry')?.remove();

    this.isTranslating = true;
    this.startTime = Date.now();
    transBox.classList.add('loading');
    transBox.classList.remove('error');
    transBox.innerHTML = `<div class="it-progress"><div class="it-progress-bar"><div class="it-progress-fill" style="width:20%"></div></div><span class="it-progress-text">Translating...</span><span class="it-elapsed"></span></div>`;

    const fill = transBox.querySelector('.it-progress-fill');
    const elapsed = transBox.querySelector('.it-elapsed');
    let progress = 20;
    const interval = setInterval(() => {
      if (progress < 85) { progress += Math.random() * 10; fill.style.width = `${Math.min(progress, 85)}%`; }
      elapsed.textContent = `${((Date.now() - this.startTime) / 1000).toFixed(1)}s`;
    }, 300);

    copyBtn.disabled = true;
    copyBtn.textContent = 'Copy';
    copyBtn.classList.remove('copied');
    if (replaceBtn) { replaceBtn.disabled = true; replaceBtn.textContent = 'Replace'; replaceBtn.classList.remove('replaced'); }

    this.abortCtrl = new AbortController();
    const signal = this.abortCtrl.signal;
    const text = this.selectedText.length > InlineTranslator.MAX_TEXT ? this.selectedText.substring(0, InlineTranslator.MAX_TEXT) : this.selectedText;

    try {
      const trans = await this.translateFn(text, this.currentLang, signal);
      clearInterval(interval);
      if (!this.panel || signal.aborted) return;

      fill.style.width = '100%';
      setTimeout(() => {
        transBox.classList.remove('loading');
        transBox.style.whiteSpace = 'pre-wrap';
        this._setTextLines(transBox, trans);
        transBox.dataset.translation = trans;
        copyBtn.disabled = false;
        if (replaceBtn) replaceBtn.disabled = false;
        if (this.onHistoryAdd) this.onHistoryAdd(text, trans, this.currentLang);
      }, 150);
    } catch (e) {
      clearInterval(interval);
      if (e.name === 'AbortError' || !this.panel) return;
      transBox.classList.remove('loading');
      transBox.classList.add('error');
      transBox.textContent = `Error: ${e.message}`;
      this._addRetry(panel, btns);
    } finally {
      this.isTranslating = false;
      this.abortCtrl = null;
    }
  }

  _addRetry(panel, btns) {
    const btn = document.createElement('button');
    btn.className = 'it-btn retry';
    btn.textContent = 'Retry';
    const handler = () => { btn.remove(); this._translate(panel); };
    btn.addEventListener('click', handler);
    this._listeners.push({ el: btn, type: 'click', fn: handler });
    btns.appendChild(btn);
    btn.focus();
  }

  // ============================================================================
  // COPY & REPLACE
  // ============================================================================

  _copy(panel) {
    const trans = panel.querySelector('.it-box.translated')?.dataset.translation;
    const btn = panel.querySelector('.it-btn');
    if (!trans) return;
    navigator.clipboard.writeText(trans).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
    }).catch(() => {});
  }

  _replace(panel) {
    const trans = panel.querySelector('.it-box.translated')?.dataset.translation;
    const btn = panel.querySelectorAll('.it-btn')[1];
    if (!trans || !this.selectionRange) return;

    try {
      if (!this.selectionRange.commonAncestorContainer || !document.contains(this.selectionRange.commonAncestorContainer)) {
        btn.textContent = 'Selection lost';
        setTimeout(() => btn.textContent = 'Replace', 1500);
        return;
      }

      const container = this.selectionRange.commonAncestorContainer;
      const parent = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;

      if (parent?.isContentEditable) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(this.selectionRange);
        this.selectionRange.deleteContents();
        this.selectionRange.insertNode(document.createTextNode(trans));
        parent.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: trans, bubbles: true }));
      } else {
        this._replacePreserving(trans);
        window.getSelection()?.removeAllRanges();
      }

      btn.textContent = 'Replaced!';
      btn.classList.add('replaced');
      btn.disabled = true;
      setTimeout(() => this._hidePanel(), 800);
    } catch (e) {
      console.error('[InlineTranslator] Replace error:', e);
      btn.textContent = 'Failed';
      setTimeout(() => btn.textContent = 'Replace', 1500);
    }
  }

  _replacePreserving(trans) {
    const range = this.selectionRange;
    const start = range.startContainer;
    const end = range.endContainer;

    if (start === end && start.nodeType === Node.TEXT_NODE) {
      const parent = start.parentElement;
      if (!parent) { range.deleteContents(); range.insertNode(document.createTextNode(trans)); return; }

      const before = start.textContent.substring(0, range.startOffset);
      const after = start.textContent.substring(range.endOffset);

      const wrapper = document.createElement('span');
      wrapper.className = 'pt-inline-replaced';
      wrapper.dataset.ptOriginal = this.selectedText;
      wrapper.title = 'Click to revert';
      this._setTextLines(wrapper, trans);

      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(wrapper);
      if (after) frag.appendChild(document.createTextNode(after));
      parent.replaceChild(frag, start);
    } else {
      range.deleteContents();
      const wrapper = document.createElement('span');
      wrapper.className = 'pt-inline-replaced';
      wrapper.dataset.ptOriginal = this.selectedText;
      wrapper.title = 'Click to revert';
      wrapper.style.whiteSpace = 'pre-wrap';
      this._setTextLines(wrapper, trans);
      range.insertNode(wrapper);
    }
  }

  // ============================================================================
  // POSITIONING
  // ============================================================================

  _getRect(range) {
    const rects = range.getClientRects();
    if (rects.length === 0) return range.getBoundingClientRect();
    if (rects.length === 1) return rects[0];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const r of rects) {
      if (r.width === 0 && r.height === 0) continue;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  _iconPos(rect) {
    const size = 28, gap = 8, pad = 10;
    let left = rect.right + gap, top = rect.top + (rect.height - size) / 2;
    if (left + size > window.innerWidth - pad) left = rect.left - size - gap;
    if (left < pad) { left = rect.left + rect.width / 2 - size / 2; top = rect.top - size - gap; }
    return { left: Math.max(pad, Math.min(left, window.innerWidth - size - pad)), top: Math.max(pad, Math.min(top, window.innerHeight - size - pad)) };
  }

  _panelWidth() {
    const w = window.innerWidth;
    return w >= 1600 ? 680 : w >= 1200 ? 600 : 520;
  }

  _panelPos(rect, width, height) {
    const pad = 15, gap = 12;
    const w = Math.min(width, window.innerWidth - 30);
    let left = Math.max(pad, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - pad));
    const above = rect.top - pad - gap, below = window.innerHeight - rect.bottom - pad - gap;
    let top = above >= height ? rect.top - height - gap : below >= height ? rect.bottom + gap : pad;
    return { left, top: Math.max(pad, Math.min(top, window.innerHeight - height - pad)) };
  }

  // ============================================================================
  // UTILS
  // ============================================================================

  _setTextLines(el, text) {
    el.innerHTML = '';
    text.split('\n').forEach((line, i) => {
      if (i > 0) el.appendChild(document.createElement('br'));
      if (line) el.appendChild(document.createTextNode(line));
    });
  }

  _debounce(fn, delay) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); };
  }
}

if (typeof window !== 'undefined') window.InlineTranslator = InlineTranslator;
