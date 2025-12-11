// InlineTranslator - Inline translation with Shadow DOM isolation

class InlineTranslator {
  static MAX_TEXT = 5000;
  static INLINE_TAGS = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'SPAN', 'A', 'FONT', 'SMALL', 'BIG', 'SUB', 'SUP', 'BR', 'IMG', 'CODE', 'MARK', 'DEL', 'INS', 'S']);
  static BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'ARTICLE', 'SECTION']);

  static ERROR_MAP = {
    UNAUTHORIZED: 'Auth failed', FORBIDDEN: 'Access denied', MODEL_NOT_FOUND: 'Model not found',
    RATE_LIMIT: 'Rate limited', TIMEOUT: 'Timeout', CONTEXT_LENGTH_EXCEEDED: 'Text too long',
    BAD_REQUEST: 'Bad request', GATEWAY_ERROR: 'Server unavailable', SERVER_ERROR: 'Server error',
    UNKNOWN_ERROR: 'Unknown error', CONNECTION_ERROR: 'Connection failed', RATE_LIMITED: 'Too many requests',
    LOCKED: 'Account locked', ERROR: 'Error',
    401: 'Auth failed', 403: 'Forbidden', 404: 'Not found', 429: 'Rate limited',
    500: 'Server error', 502: 'Bad gateway', 503: 'Unavailable', 504: 'Timeout'
  };

  static parseError(error) {
    const msg = error?.message || String(error);
    for (const [k, v] of Object.entries(this.ERROR_MAP)) {
      if (msg.includes(k) || msg.toUpperCase().includes(k)) return v;
    }
    const m = msg.match(/(\d{3})/);
    if (m && this.ERROR_MAP[m[1]]) return this.ERROR_MAP[m[1]];
    if (/fetch|network/i.test(msg)) return this.ERROR_MAP.CONNECTION_ERROR;
    if (/timeout/i.test(msg)) return this.ERROR_MAP.TIMEOUT;
    return msg.length > 80 ? msg.substring(0, 80) + '...' : msg;
  }

  static TagAbstraction = class {
    constructor() { this.placeholderRegex = /\{\{(\/?)(\d+|br)\}\}/g; }
    
    abstractSmart(html) {
      const mapping = new Map();
      let uid = 0;
      const stack = [];
      const tokens = html.split(/(<\/?(?:[a-z0-9]+)[^>]*>)/gi);
      let result = '';
      
      for (const token of tokens) {
        if (!token.match(/<[^>]+>/)) { result += token; continue; }
        if (/^<br\s*\/?>$/i.test(token)) { result += '{{br}}'; continue; }

        const isClose = token.startsWith('</');
        const tagNameMatches = token.match(/<\/?([a-z0-9]+).*/i);
        const tagName = tagNameMatches ? tagNameMatches[1].toLowerCase() : 'tag';
        const isSelfClosing = token.endsWith('/>') || ['img', 'hr', 'input', 'meta', 'link'].includes(tagName);

        if (isSelfClosing) {
          const id = uid++;
          mapping.set(id, { open: token, close: '' });
          result += `{{${id}}}`;
          continue; 
        }

        if (isClose) {
          let lastIdx = stack.length - 1;
          while (lastIdx >= 0 && stack[lastIdx].tagName !== tagName) lastIdx--;
          
          if (lastIdx >= 0) {
            const { id } = stack[lastIdx];
            mapping.get(id).close = token;
            result += `{{/${id}}}`;
            stack.splice(lastIdx, stack.length - lastIdx);
          } else {
            const id = uid++;
            mapping.set(id, { open: token, close: '' });
            result += `{{${id}}}`;
          }
        } else {
          const id = uid++;
          mapping.set(id, { open: token, close: '' });
          stack.push({ tagName, id });
          result += `{{${id}}}`;
        }
      }
      return { text: result, mapping };
    }

    restore(translatedText, mapping) {
      let res = translatedText.replace(/\{\{br\}\}/gi, '<br>');
      res = res.replace(/\{\{(\/?)([0-9]+)\}\}/g, (match, slash, idDigits) => {
        const id = parseInt(idDigits, 10);
        const map = mapping.get(id);
        if (!map) return '';
        return slash ? (map.close || '') : (map.open || '');
      });
      return res;
    }
  }

  constructor(opts = {}) {
    this.translateFn = opts.translateFn || (async (text) => `[Mock] ${text}`);
    this.languages = opts.languages || [];
    this.defaultLang = opts.defaultLang || 'English';
    this.iconUrl = opts.iconUrl || null;
    this.onHistoryAdd = opts.onHistoryAdd || null;
    this.recentLanguages = opts.recentLanguages || [];

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
    this.replacementMap = new WeakMap();

    this.tagAbstractor = new InlineTranslator.TagAbstraction();
    this.currentMapping = null;
    this.currentOriginalHTML = '';
    this.selectedPlainText = '';
    this._needsAbstraction = false;

    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onMouseDown = this._handleClickOutside.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onScroll = this._debounce(this._handleScroll.bind(this), 100);
    this._onRevert = this._handleRevert.bind(this);
  }

  updateRecentLanguages(langs) { this.recentLanguages = langs; }
  
  _debounce(func, wait) {
    let timeout;
    return (...args) => { clearTimeout(timeout); timeout = setTimeout(() => func.apply(this, args), wait); };
  }

  static getStyles() {
    return `
      :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
      * { box-sizing: border-box; }
      .it-icon { position: fixed; width: 24px; height: 24px; background: transparent; border: none; border-radius: 5px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2147483647; padding: 0; opacity: 0.9; animation: pulse 0.25s ease-out; }
      @keyframes pulse { 0% { transform: scale(0.8); opacity: 0; } 50% { transform: scale(1.08); } 100% { transform: scale(1); opacity: 0.9; } }
      .it-icon:hover { transform: scale(1.12); opacity: 1; }
      .it-icon svg { width: 18px; height: 18px; fill: #4285f4; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2)); }
      .it-icon img { width: 24px; height: 24px; object-fit: contain; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2)); }
      .it-panel { position: fixed; width: calc(100vw - 24px); max-width: 420px; min-width: 280px; background: #fff; border-radius: 10px; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15); z-index: 2147483647; overflow: hidden; animation: fadeIn 0.18s ease; }
      @media (min-width: 1200px) { .it-panel { max-width: 480px; } }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
      .it-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: linear-gradient(135deg, #4285f4, #34a853); color: white; }
      .it-title { font-size: 12px; font-weight: 600; }
      .it-close { width: 20px; height: 20px; background: rgba(255, 255, 255, 0.2); border: none; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
      .it-close:hover { background: rgba(255, 255, 255, 0.3); }
      .it-close svg { width: 12px; height: 12px; fill: white; }
      .it-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
      .it-quick { display: flex; gap: 5px; flex-wrap: wrap; }
      .it-quick-btn { padding: 3px 8px; font-size: 11px; font-weight: 500; color: #4285f4; background: rgba(66, 133, 244, 0.1); border: 1px solid rgba(66, 133, 244, 0.3); border-radius: 4px; cursor: pointer; }
      .it-quick-btn:hover { background: rgba(66, 133, 244, 0.2); border-color: #4285f4; }
      .it-quick-btn.active { background: #4285f4; color: white; border-color: #4285f4; }
      .it-select { flex: 1; padding: 6px 8px; font-size: 12px; border: 1px solid #e0e0e0; border-radius: 5px; background: #f8f9fa; cursor: pointer; outline: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24'%3E%3Cpath fill='%23666' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; }
      .it-select:focus { border-color: #4285f4; }
      .it-label { font-size: 9px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 3px; display: block; }
      .it-box { width: 100%; padding: 8px 10px; font-size: 13px; line-height: 1.45; border: 1px solid #e0e0e0; border-radius: 6px; background: #f8f9fa; min-height: 50px; max-height: 100px; overflow-y: auto; word-wrap: break-word; }
      .it-box.source { color: #333; }
      .it-box.translated { background: #e8f5e9; border-color: #c8e6c9; color: #2e7d32; }
      .it-box.loading { display: flex; flex-direction: column; align-items: center; justify-content: center; color: #888; min-height: 60px; }
      .it-box.error { background: #ffebee; border-color: #ffcdd2; color: #c5221f; }
      .it-progress { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .it-progress-bar { width: 75%; height: 3px; background: #e0e0e0; border-radius: 2px; overflow: hidden; }
      .it-progress-fill { height: 100%; background: linear-gradient(90deg, #4285f4, #34a853); border-radius: 2px; transition: width 0.3s ease; animation: progressPulse 1.5s ease-in-out infinite; }
      @keyframes progressPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
      .it-progress-text { font-size: 11px; color: #666; }
      .it-elapsed { font-size: 10px; color: #999; }
      .it-btns { display: flex; gap: 6px; margin-top: 3px; }
      .it-btn { flex: 1; padding: 6px; font-size: 12px; font-weight: 500; color: white; background: linear-gradient(135deg, #4285f4, #34a853); border: none; border-radius: 5px; cursor: pointer; }
      .it-btn:hover { opacity: 0.9; }
      .it-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .it-btn.copied, .it-btn.replaced { background: #34a853; }
      .it-btn.retry { background: #f44336; flex: 0 0 auto; padding: 6px 12px; }
      .it-hint { font-size: 9px; color: #999; text-align: center; margin-top: 3px; }
      .it-kbd { display: inline-block; padding: 1px 3px; background: #f0f0f0; border: 1px solid #ddd; border-radius: 2px; font-family: monospace; font-size: 9px; }
    `;
  }

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
    if (!document.body) return;
    
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

  _handleKeyDown(e) {
    if (e.key === 'Escape') {
      if (this.panel) { this._hidePanel(); e.preventDefault(); }
      else if (this.icon) { this._hideIcon(); e.preventDefault(); }
    }
  }

  _handleScroll() {
    try {
      const sel = window.getSelection();
      if (sel?.rangeCount > 0) {
        this.selectionRect = sel.getRangeAt(0).getBoundingClientRect();
        
        if (this.panel) {
          const pos = this._panelPos(this.selectionRect, this.panel.offsetWidth || 320, 320);
          this.panel.style.left = `${pos.left}px`;
          this.panel.style.top = `${pos.top}px`;
        }
        
        if (this.icon) {
          const pos = this._iconPos(this.selectionRect);
          this.icon.style.left = `${pos.left}px`;
          this.icon.style.top = `${pos.top}px`;
        }
      }
    } catch {}
  }

  _handleMouseUp(e) {
    if (this.host?.contains(e.target) || e.target === this.host) return;
    setTimeout(() => {
      let sel;
      try { sel = window.getSelection(); } catch { return; }
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

      const text = sel.toString().trim();
      if (!text) return;

      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;

      try {
        const range = sel.getRangeAt(0);
        this.selectionRect = range.getBoundingClientRect();
        this.selectionRange = range.cloneRange();
        this.selectedPlainText = text;
        this._needsAbstraction = true;
        
        this._hidePanel();
        this._showIcon();
      } catch {}
    }, 10);
  }
  
  _performAbstraction() {
    if (!this._needsAbstraction || !this.selectionRange) return false;
    
    try {
      if (!this.selectionRange.commonAncestorContainer || !document.contains(this.selectionRange.commonAncestorContainer)) {
        this.currentOriginalHTML = this.selectedPlainText;
        this.selectedText = this.selectedPlainText;
        this.currentMapping = new Map();
        this._needsAbstraction = false;
        return true;
      }
      
      const div = document.createElement('div');
      div.appendChild(this.selectionRange.cloneContents());
      this.currentOriginalHTML = div.innerHTML;
      
      const { text: abstractText, mapping } = this.tagAbstractor.abstractSmart(this.currentOriginalHTML);
      this.selectedText = abstractText;
      this.currentMapping = mapping;
      this._needsAbstraction = false;
      return true;
    } catch {
      this.currentOriginalHTML = this.selectedPlainText;
      this.selectedText = this.selectedPlainText;
      this.currentMapping = new Map();
      this._needsAbstraction = false;
      return true;
    }
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
    const origHtml = target.dataset.ptOriginalHtml;
    if (!origHtml) return;
    
    e.preventDefault();
    e.stopPropagation();
    const parent = target.parentNode;
    if (!parent) return;

    if (this.replacementMap.has(target)) {
      const fragment = this.replacementMap.get(target);
      parent.replaceChild(fragment, target);
    } else {
      const temp = document.createElement('div');
      temp.innerHTML = origHtml;
      const frag = document.createDocumentFragment();
      while (temp.firstChild) frag.appendChild(temp.firstChild);
      parent.replaceChild(frag, target);
    }

    window.getSelection()?.removeAllRanges();
  }

  _iconPos(r) { return { left: r.right + 5, top: r.bottom + 5 }; }

  _panelPos(r, w, h) {
    const vpW = window.innerWidth, vpH = window.innerHeight;
    let left = r.left, top = r.bottom + 10;

    if (left + w > vpW) left = vpW - w - 10;
    if (left < 10) left = 10;
    if (top + h > vpH) {
      top = r.top - h - 10;
      if (top < 10) top = 10;
    }
    return { left, top };
  }

  _showIcon() {
    this._hideIcon();
    const icon = document.createElement('button');
    icon.className = 'it-icon';
    icon.title = 'Translate selection';

    if (this.iconUrl) {
      const img = document.createElement('img');
      img.src = this.iconUrl;
      icon.appendChild(img);
    } else {
      icon.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>`;
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

  _hideIcon() {
    if (this.icon) { this.icon.remove(); this.icon = null; }
  }

  _showPanel() {
    this._hidePanel();
    this.isTranslating = false;
    this._performAbstraction();

    let plainTextDisplay = this.selectedPlainText || '';
    try { 
      const freshText = window.getSelection().toString().trim();
      if (freshText) plainTextDisplay = freshText;
    } catch {}
    if (!plainTextDisplay) plainTextDisplay = this.selectedText;

    const truncated = plainTextDisplay.length > InlineTranslator.MAX_TEXT;
    const displayText = truncated ? plainTextDisplay.substring(0, InlineTranslator.MAX_TEXT) : plainTextDisplay;

    const panel = document.createElement('div');
    panel.className = 'it-panel';
    panel.setAttribute('role', 'dialog');
    this._buildPanel(panel, displayText);

    const pos = this._panelPos(this.selectionRect, 320, 380);
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;

    this.panel = panel;
    this.shadow.appendChild(panel);
    panel.querySelector('.it-select')?.focus();
    this._translate(panel);
  }

  _buildPanel(panel, text) {
    const header = document.createElement('div');
    header.className = 'it-header';
    header.innerHTML = `<span class="it-title">Translate</span><button class="it-close" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>`;
    const closeBtn = header.querySelector('.it-close');
    const closeHandler = () => this._hidePanel();
    closeBtn.addEventListener('click', closeHandler);
    this._listeners.push({ el: closeBtn, type: 'click', fn: closeHandler });
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'it-body';

    const quick = document.createElement('div');
    quick.className = 'it-quick';
    this.recentLanguages.forEach(code => {
      const lang = this.languages.find(l => l.code === code);
      if (!lang) return;
      const btn = document.createElement('button');
      btn.className = 'it-quick-btn' + (code === this.currentLang ? ' active' : '');
      btn.textContent = lang.name;
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
      this.currentLang = e.target.value;
      quick.querySelectorAll('.it-quick-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === this.currentLang));
      this._translate(panel);
    };
    select.addEventListener('change', selectHandler);
    this._listeners.push({ el: select, type: 'change', fn: selectHandler });
    body.appendChild(select);

    const srcSection = document.createElement('div');
    srcSection.innerHTML = `<span class="it-label">Source</span>`;
    const srcBox = document.createElement('div');
    srcBox.className = 'it-box source';
    srcBox.style.whiteSpace = 'pre-wrap';
    srcBox.textContent = text;
    srcSection.appendChild(srcBox);
    body.appendChild(srcSection);

    const transSection = document.createElement('div');
    transSection.innerHTML = `<span class="it-label">Translation</span>`;
    const transBox = document.createElement('div');
    transBox.className = 'it-box translated loading';
    transBox.innerHTML = `<div class="it-progress"><div class="it-progress-bar"><div class="it-progress-fill" style="width:30%"></div></div><span class="it-progress-text">Translating...</span><span class="it-elapsed"></span></div>`;
    transSection.appendChild(transBox);
    body.appendChild(transSection);

    const btns = document.createElement('div');
    btns.className = 'it-btns';
    
    const copyBtn = document.createElement('button');
    copyBtn.className = 'it-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.disabled = true;
    copyBtn.addEventListener('click', () => this._copy(panel));
    this._listeners.push({ el: copyBtn, type: 'click', fn: () => this._copy(panel) });
    btns.appendChild(copyBtn);

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'it-btn';
    replaceBtn.textContent = 'Replace';
    replaceBtn.disabled = true;
    replaceBtn.addEventListener('click', () => this._replace(panel));
    this._listeners.push({ el: replaceBtn, type: 'click', fn: () => this._replace(panel) });
    btns.appendChild(replaceBtn);

    body.appendChild(btns);

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
    const textToSend = this.selectedText;

    try {
      const trans = await this.translateFn(textToSend, this.currentLang, signal);
      clearInterval(interval);
      if (!this.panel || signal.aborted) return;

      fill.style.width = '100%';
      setTimeout(() => {
        transBox.classList.remove('loading');
        transBox.style.whiteSpace = 'pre-wrap';
        
        const restoredHTML = this.tagAbstractor.restore(trans, this.currentMapping);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = restoredHTML;
        const displayText = tempDiv.textContent;

        transBox.textContent = displayText;
        transBox.dataset.translationHtml = restoredHTML;
        transBox.dataset.translationText = displayText;
        
        copyBtn.disabled = false;
        if (replaceBtn) replaceBtn.disabled = false;
        if (this.onHistoryAdd) this.onHistoryAdd(textToSend, displayText, this.currentLang);
      }, 150);
    } catch (e) {
      clearInterval(interval);
      if (e.name === 'AbortError' || !this.panel) return;
      transBox.classList.remove('loading');
      transBox.classList.add('error');
      transBox.textContent = InlineTranslator.parseError(e);
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

  _copy(panel) {
    const trans = panel.querySelector('.it-box.translated')?.dataset.translationText;
    const btn = panel.querySelector('.it-btn');
    if (!trans) return;
    navigator.clipboard.writeText(trans).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
    }).catch(() => {});
  }

  _replace(panel) {
    const transHtml = panel.querySelector('.it-box.translated')?.dataset.translationHtml;
    const btn = panel.querySelectorAll('.it-btn')[1];
    if (!transHtml || !this.selectionRange) return;

    try {
      if (!this.selectionRange.commonAncestorContainer || !document.contains(this.selectionRange.commonAncestorContainer)) {
        btn.textContent = 'Selection lost';
        setTimeout(() => btn.textContent = 'Replace', 1500);
        return;
      }
      
      const wrapper = document.createElement('span');
      wrapper.className = 'pt-inline-replaced';
      wrapper.title = 'Click to revert';
      wrapper.dataset.ptOriginalHtml = this.currentOriginalHTML;
      wrapper.innerHTML = transHtml;

      const fragment = this.selectionRange.extractContents();
      this.replacementMap.set(wrapper, fragment);
      this.selectionRange.insertNode(wrapper);

      window.getSelection()?.removeAllRanges();

      btn.textContent = 'Replaced!';
      btn.classList.add('replaced');
      btn.disabled = true;
      setTimeout(() => this._hidePanel(), 800);
    } catch {
      btn.textContent = 'Failed';
      setTimeout(() => btn.textContent = 'Replace', 1500);
    }
  }
}

if (typeof window !== 'undefined') window.InlineTranslator = InlineTranslator;
