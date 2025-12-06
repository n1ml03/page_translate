/**
 * InlineTranslator - Inline translation feature for Chrome extensions
 * Uses Shadow DOM for style isolation
 */
class InlineTranslator {
  static MAX_TEXT_LENGTH = 1000;
  
  constructor(options = {}) {
    this.translateFn = options.translateFn || this._mockTranslate.bind(this);
    this.languages = options.languages || [
      { code: 'ja', name: 'Japanese (日本語)' },
      { code: 'en', name: 'English' },
      { code: 'zh-CN', name: 'Chinese Simplified (简体中文)' },
      { code: 'zh-TW', name: 'Chinese Traditional (繁體中文)' },
      { code: 'ko', name: 'Korean (한국어)' },
      { code: 'vi', name: 'Vietnamese (Tiếng Việt)' },
    ];
    this.defaultLang = options.defaultLang || 'ja';
    this.iconUrl = options.iconUrl || null;
    
    this.hostElement = null;
    this.shadowRoot = null;
    this.iconElement = null;
    this.panelElement = null;
    this.selectedText = '';
    this.selectionRect = null;
    this.currentLang = this.defaultLang;
    this.isTranslating = false;
    this.selectionRange = null;
    this.abortController = null;
    
    this._boundHandleMouseUp = this._handleMouseUp.bind(this);
    this._boundHandleClickOutside = this._handleClickOutside.bind(this);
    this._boundHandleKeyDown = this._handleKeyDown.bind(this);
    this._boundHandleScroll = this._debounce(this._handleScroll.bind(this), 100);
    this._boundHandleRevertClick = this._handleRevertClick.bind(this);
    this._panelListeners = [];
  }

  // ============================================================================
  // STYLES
  // ============================================================================

  static getStyles() {
    return `
      :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
      * { box-sizing: border-box; }

      .it-icon { position: fixed; width: 24px; height: 24px; background: transparent; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2147483647; transition: transform 0.15s ease, opacity 0.15s ease; padding: 0; opacity: 0.85; }
      .it-icon:hover { transform: scale(1.15); opacity: 1; }
      .it-icon svg { width: 20px; height: 20px; fill: #4285f4; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2)); }
      .it-icon img { width: 24px; height: 24px; object-fit: contain; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2)); }
      
      .it-panel { position: fixed; width: calc(100vw - 30px); max-width: 520px; min-width: 300px; background: #fff; border-radius: 12px; box-shadow: 0 6px 32px rgba(0, 0, 0, 0.18); z-index: 2147483647; overflow: hidden; animation: it-fadeIn 0.2s ease; }
      @media (min-width: 1200px) { .it-panel { max-width: 600px; } }
      @media (min-width: 1600px) { .it-panel { max-width: 680px; } }
      @keyframes it-fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
      
      .it-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: linear-gradient(135deg, #4285f4, #34a853); color: white; }
      .it-panel-title { font-size: 14px; font-weight: 600; margin: 0; }
      .it-close-btn { width: 24px; height: 24px; background: rgba(255, 255, 255, 0.2); border: none; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; transition: background 0.15s ease; }
      .it-close-btn:hover { background: rgba(255, 255, 255, 0.3); }
      .it-close-btn:focus { outline: 2px solid white; outline-offset: 2px; }
      .it-close-btn svg { width: 14px; height: 14px; fill: white; }
      
      .it-panel-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
      @media (min-width: 1200px) { .it-panel-body { padding: 16px 20px; gap: 12px; } }
      
      .it-lang-select { width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid #e0e0e0; border-radius: 6px; background: #f8f9fa; cursor: pointer; outline: none; transition: border-color 0.15s ease; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24'%3E%3Cpath fill='%23666' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; }
      .it-lang-select:focus { border-color: #4285f4; outline: 2px solid #4285f433; }
      
      .it-text-section { margin-top: 0; }
      .it-text-label { font-size: 10px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; display: block; }
      .it-text-box { width: 100%; padding: 10px 12px; font-size: 14px; line-height: 1.5; border: 1px solid #e0e0e0; border-radius: 8px; background: #f8f9fa; min-height: 60px; max-height: 120px; overflow-y: auto; word-wrap: break-word; }
      .it-text-box.it-source { color: #333; }
      .it-text-box.it-translated { background: #e8f5e9; border-color: #c8e6c9; color: #2e7d32; }
      .it-text-box.it-loading { display: flex; align-items: center; justify-content: center; color: #888; }
      .it-text-box.it-error { background: #ffebee; border-color: #ffcdd2; color: #c5221f; }
      @media (min-width: 1200px) { .it-text-box { min-height: 80px; max-height: 180px; font-size: 15px; } }
      @media (min-width: 1600px) { .it-text-box { min-height: 100px; max-height: 240px; } }
      
      .it-warning { font-size: 11px; color: #f57c00; padding: 4px 8px; background: #fff3e0; border-radius: 4px; margin-bottom: 4px; }
      .it-spinner { width: 20px; height: 20px; border: 2px solid #e0e0e0; border-top-color: #4285f4; border-radius: 50%; animation: it-spin 0.8s linear infinite; margin-right: 8px; }
      @keyframes it-spin { to { transform: rotate(360deg); } }
      
      .it-btn-row { display: flex; gap: 8px; margin-top: 4px; }
      .it-copy-btn, .it-retry-btn, .it-replace-btn { flex: 1; padding: 8px; font-size: 13px; font-weight: 500; color: white; background: linear-gradient(135deg, #4285f4, #34a853); border: none; border-radius: 6px; cursor: pointer; transition: opacity 0.15s ease; }
      .it-copy-btn:hover, .it-retry-btn:hover, .it-replace-btn:hover { opacity: 0.9; }
      .it-copy-btn:focus, .it-retry-btn:focus, .it-replace-btn:focus { outline: 2px solid #4285f4; outline-offset: 2px; }
      .it-copy-btn:disabled, .it-retry-btn:disabled, .it-replace-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .it-copy-btn.it-copied, .it-replace-btn.it-replaced { background: #34a853; }
      .it-retry-btn { background: #f44336; flex: 0 0 auto; padding: 8px 16px; }
      .it-retry-btn:hover { background: #d32f2f; }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    `;
  }

  // ============================================================================
  // MOCK TRANSLATE
  // ============================================================================

  async _mockTranslate(text, lang, signal) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, 500 + Math.random() * 500);
      signal?.addEventListener('abort', () => { clearTimeout(timeout); reject(new DOMException('Aborted', 'AbortError')); });
    });
    return `[${lang.toUpperCase()}] ${text}`;
  }


  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  init() {
    this._createHost();
    this._attachListeners();
  }

  destroy() {
    this._cancelPendingRequest();
    this._removeListeners();
    this._cleanupPanelListeners();
    if (this.hostElement) { this.hostElement.remove(); this.hostElement = null; this.shadowRoot = null; }
    this.iconElement = null;
    this.panelElement = null;
  }

  _createHost() {
    this.hostElement = document.createElement('div');
    this.hostElement.id = 'inline-translator-host';
    this.shadowRoot = this.hostElement.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = InlineTranslator.getStyles();
    this.shadowRoot.appendChild(style);
    document.body.appendChild(this.hostElement);
    this._injectReplacedTextStyles();
  }

  _injectReplacedTextStyles() {
    if (document.getElementById('inline-translator-replaced-styles')) return;
    const style = document.createElement('style');
    style.id = 'inline-translator-replaced-styles';
    style.textContent = `
      .pt-inline-replaced { background-color: rgba(52, 168, 83, 0.15) !important; border-radius: 2px !important; cursor: pointer !important; position: relative !important; display: inline !important; }
      .pt-inline-replaced:hover { background-color: rgba(52, 168, 83, 0.25) !important; }
      .pt-inline-replaced::after { content: '↩' !important; position: absolute !important; top: -10px !important; right: -10px !important; width: 18px !important; height: 18px !important; background: #f44336 !important; color: white !important; font-size: 11px !important; line-height: 18px !important; text-align: center !important; border-radius: 50% !important; opacity: 0 !important; transform: scale(0.8) !important; transition: opacity 0.15s ease, transform 0.15s ease !important; pointer-events: none !important; z-index: 10000 !important; font-family: sans-serif !important; }
      .pt-inline-replaced:hover::after { opacity: 1 !important; transform: scale(1) !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  _attachListeners() {
    document.addEventListener('mouseup', this._boundHandleMouseUp);
    document.addEventListener('mousedown', this._boundHandleClickOutside);
    document.addEventListener('keydown', this._boundHandleKeyDown);
    window.addEventListener('scroll', this._boundHandleScroll, true);
    document.addEventListener('click', this._boundHandleRevertClick);
  }

  _removeListeners() {
    document.removeEventListener('mouseup', this._boundHandleMouseUp);
    document.removeEventListener('mousedown', this._boundHandleClickOutside);
    document.removeEventListener('keydown', this._boundHandleKeyDown);
    window.removeEventListener('scroll', this._boundHandleScroll, true);
    document.removeEventListener('click', this._boundHandleRevertClick);
  }

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  _handleKeyDown(e) {
    if (e.key === 'Escape') {
      if (this.panelElement) { this._hidePanel(); e.preventDefault(); }
      else if (this.iconElement) { this._hideIcon(); e.preventDefault(); }
    }
    if (e.key === 'Tab' && this.panelElement) this._handleFocusTrap(e);
  }

  _handleFocusTrap(e) {
    const focusableElements = this.panelElement.querySelectorAll('button:not([disabled]), select, [tabindex]:not([tabindex="-1"])');
    if (focusableElements.length === 0) return;
    const firstEl = focusableElements[0];
    const lastEl = focusableElements[focusableElements.length - 1];
    if (e.shiftKey && this.shadowRoot.activeElement === firstEl) { lastEl.focus(); e.preventDefault(); }
    else if (!e.shiftKey && this.shadowRoot.activeElement === lastEl) { firstEl.focus(); e.preventDefault(); }
  }

  _handleScroll() {
    if (this.panelElement && this.selectionRect) {
      try {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          this.selectionRect = this._getMultiLineRect(range);
          const pos = this._calculatePanelPosition(this.selectionRect, this._getPanelWidth(), 320);
          this.panelElement.style.left = `${pos.left}px`;
          this.panelElement.style.top = `${pos.top}px`;
        }
      } catch (e) {}
    }
    if (this.iconElement && this.selectionRect) {
      const pos = this._calculateIconPosition(this.selectionRect);
      this.iconElement.style.left = `${pos.left}px`;
      this.iconElement.style.top = `${pos.top}px`;
    }
  }

  _handleMouseUp(e) {
    if (this.hostElement?.contains(e.target) || e.target === this.hostElement) return;
    setTimeout(() => {
      let selection, text;
      try { selection = window.getSelection(); text = selection?.toString().trim(); } catch (err) { return; }
      if (!text) return;
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) return;
      try {
        const range = selection.getRangeAt(0);
        this.selectionRect = this._getMultiLineRect(range);
        this.selectedText = text;
        this.selectionRange = range.cloneRange();
        this._hidePanel();
        this._showIcon();
      } catch (err) { return; }
    }, 10);
  }

  _handleClickOutside(e) {
    const path = e.composedPath();
    const isInsideUI = path.some(el => el === this.iconElement || el === this.panelElement || el === this.hostElement);
    if (!isInsideUI && !this.shadowRoot?.contains(e.target)) { this._hideIcon(); this._hidePanel(); }
  }

  _handleRevertClick(e) {
    const target = e.target;
    if (!target.classList?.contains('pt-inline-replaced')) return;
    const originalText = target.dataset.ptOriginal;
    if (!originalText) return;
    e.preventDefault();
    e.stopPropagation();
    const textNode = document.createTextNode(originalText);
    target.parentNode?.replaceChild(textNode, target);
    window.getSelection()?.removeAllRanges();
  }


  // ============================================================================
  // ICON
  // ============================================================================

  _showIcon() {
    this._hideIcon();
    const icon = document.createElement('button');
    icon.className = 'it-icon';
    icon.setAttribute('aria-label', 'Translate selection');
    icon.title = 'Translate selection';
    
    if (this.iconUrl && this._isValidIconUrl(this.iconUrl)) {
      const img = document.createElement('img');
      img.setAttribute('src', this.iconUrl);
      img.setAttribute('alt', 'Translate');
      icon.appendChild(img);
    } else {
      this._appendDefaultIcon(icon);
    }
    
    const clickHandler = (e) => { e.stopPropagation(); this._hideIcon(); this._showPanel(); };
    icon.addEventListener('click', clickHandler);
    this._panelListeners.push({ element: icon, type: 'click', handler: clickHandler });
    
    const pos = this._calculateIconPosition(this.selectionRect);
    icon.style.left = `${pos.left}px`;
    icon.style.top = `${pos.top}px`;
    this.iconElement = icon;
    this.shadowRoot.appendChild(icon);
  }

  _isValidIconUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return ['http:', 'https:', 'data:', 'chrome-extension:'].includes(parsed.protocol);
    } catch { return false; }
  }

  _appendDefaultIcon(container) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z');
    svg.appendChild(path);
    container.appendChild(svg);
  }

  _hideIcon() {
    if (this.iconElement) { this.iconElement.remove(); this.iconElement = null; }
  }

  // ============================================================================
  // PANEL
  // ============================================================================

  _showPanel() {
    this._hidePanel();
    this.isTranslating = false;
    
    const isTextTruncated = this.selectedText.length > InlineTranslator.MAX_TEXT_LENGTH;
    const displayText = isTextTruncated ? this.selectedText.substring(0, InlineTranslator.MAX_TEXT_LENGTH) : this.selectedText;
    
    const panel = document.createElement('div');
    panel.className = 'it-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Translation panel');
    
    this._buildPanelContent(panel, displayText, isTextTruncated);
    
    const pos = this._calculatePanelPosition(this.selectionRect, this._getPanelWidth(), 320);
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;
    
    this.panelElement = panel;
    this.shadowRoot.appendChild(panel);
    
    const langSelect = panel.querySelector('.it-lang-select');
    if (langSelect) langSelect.focus();
    
    this._fetchTranslation(panel);
  }

  _buildPanelContent(panel, displayText, isTextTruncated) {
    // Header
    const header = document.createElement('div');
    header.className = 'it-panel-header';
    const title = document.createElement('span');
    title.className = 'it-panel-title';
    title.textContent = 'Translate';
    header.appendChild(title);
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'it-close-btn';
    closeBtn.title = 'Close (Esc)';
    closeBtn.setAttribute('aria-label', 'Close translation panel');
    const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    closeSvg.setAttribute('viewBox', '0 0 24 24');
    const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    closePath.setAttribute('d', 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z');
    closeSvg.appendChild(closePath);
    closeBtn.appendChild(closeSvg);
    const closeHandler = () => this._hidePanel();
    closeBtn.addEventListener('click', closeHandler);
    this._panelListeners.push({ element: closeBtn, type: 'click', handler: closeHandler });
    header.appendChild(closeBtn);
    panel.appendChild(header);
    
    // Body
    const body = document.createElement('div');
    body.className = 'it-panel-body';
    
    if (isTextTruncated) {
      const warning = document.createElement('div');
      warning.className = 'it-warning';
      warning.setAttribute('role', 'alert');
      warning.textContent = `Text truncated to ${InlineTranslator.MAX_TEXT_LENGTH.toLocaleString()} characters`;
      body.appendChild(warning);
    }
    
    // Language select
    const langSelect = document.createElement('select');
    langSelect.className = 'it-lang-select';
    langSelect.setAttribute('aria-label', 'Target language');
    this.languages.forEach(lang => {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = lang.name;
      if (lang.code === this.currentLang) option.selected = true;
      langSelect.appendChild(option);
    });
    const langChangeHandler = (e) => { e.stopPropagation(); this.currentLang = e.target.value; this._fetchTranslation(panel); };
    langSelect.addEventListener('change', langChangeHandler);
    this._panelListeners.push({ element: langSelect, type: 'change', handler: langChangeHandler });
    body.appendChild(langSelect);
    
    // Source text
    const sourceSection = document.createElement('div');
    sourceSection.className = 'it-text-section';
    const sourceLabel = document.createElement('span');
    sourceLabel.className = 'it-text-label';
    sourceLabel.textContent = 'Source';
    sourceSection.appendChild(sourceLabel);
    const sourceBox = document.createElement('div');
    sourceBox.className = 'it-text-box it-source';
    sourceBox.textContent = displayText;
    sourceSection.appendChild(sourceBox);
    body.appendChild(sourceSection);
    
    // Translation
    const transSection = document.createElement('div');
    transSection.className = 'it-text-section';
    const transLabel = document.createElement('span');
    transLabel.className = 'it-text-label';
    transLabel.textContent = 'Translation';
    transSection.appendChild(transLabel);
    const transBox = document.createElement('div');
    transBox.className = 'it-text-box it-translated it-loading';
    transBox.setAttribute('aria-live', 'polite');
    const spinner = document.createElement('div');
    spinner.className = 'it-spinner';
    transBox.appendChild(spinner);
    const loadingText = document.createElement('span');
    loadingText.textContent = 'Translating...';
    transBox.appendChild(loadingText);
    transSection.appendChild(transBox);
    body.appendChild(transSection);
    
    // Buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'it-btn-row';
    
    const copyBtn = document.createElement('button');
    copyBtn.className = 'it-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.disabled = true;
    const copyHandler = () => this._copyTranslation(panel);
    copyBtn.addEventListener('click', copyHandler);
    this._panelListeners.push({ element: copyBtn, type: 'click', handler: copyHandler });
    btnRow.appendChild(copyBtn);
    
    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'it-replace-btn';
    replaceBtn.textContent = 'Replace';
    replaceBtn.title = 'Replace original text with translation';
    replaceBtn.disabled = true;
    const replaceHandler = () => this._replaceWithTranslation(panel);
    replaceBtn.addEventListener('click', replaceHandler);
    this._panelListeners.push({ element: replaceBtn, type: 'click', handler: replaceHandler });
    btnRow.appendChild(replaceBtn);
    
    body.appendChild(btnRow);
    panel.appendChild(body);
  }

  _hidePanel() {
    this._cancelPendingRequest();
    this._cleanupPanelListeners();
    if (this.panelElement) { this.panelElement.remove(); this.panelElement = null; }
    this.isTranslating = false;
  }

  _cancelPendingRequest() {
    if (this.abortController) { this.abortController.abort(); this.abortController = null; }
  }

  _cleanupPanelListeners() {
    this._panelListeners.forEach(({ element, type, handler }) => element.removeEventListener(type, handler));
    this._panelListeners = [];
  }


  // ============================================================================
  // TRANSLATION
  // ============================================================================

  async _fetchTranslation(panel) {
    if (this.isTranslating) this._cancelPendingRequest();
    
    const translatedBox = panel.querySelector('.it-translated');
    const copyBtn = panel.querySelector('.it-copy-btn');
    const replaceBtn = panel.querySelector('.it-replace-btn');
    const btnRow = panel.querySelector('.it-btn-row');
    
    if (!translatedBox || !copyBtn || !btnRow) return;
    
    const existingRetry = btnRow.querySelector('.it-retry-btn');
    if (existingRetry) existingRetry.remove();
    
    this.isTranslating = true;
    translatedBox.classList.add('it-loading');
    translatedBox.classList.remove('it-error');
    
    const spinner = document.createElement('div');
    spinner.className = 'it-spinner';
    const loadingText = document.createElement('span');
    loadingText.textContent = 'Translating...';
    translatedBox.replaceChildren(spinner, loadingText);
    
    copyBtn.disabled = true;
    copyBtn.textContent = 'Copy';
    copyBtn.classList.remove('it-copied');
    if (replaceBtn) { replaceBtn.disabled = true; replaceBtn.textContent = 'Replace'; replaceBtn.classList.remove('it-replaced'); }
    
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    
    const textToTranslate = this.selectedText.length > InlineTranslator.MAX_TEXT_LENGTH
      ? this.selectedText.substring(0, InlineTranslator.MAX_TEXT_LENGTH)
      : this.selectedText;
    
    try {
      const translation = await this.translateFn(textToTranslate, this.currentLang, signal);
      if (!this.panelElement || signal.aborted) return;
      
      translatedBox.classList.remove('it-loading');
      translatedBox.textContent = translation;
      translatedBox.dataset.translation = translation;
      copyBtn.disabled = false;
      if (replaceBtn) replaceBtn.disabled = false;
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!this.panelElement) return;
      
      translatedBox.classList.remove('it-loading');
      translatedBox.classList.add('it-error');
      translatedBox.textContent = `Error: ${err.message}`;
      this._addRetryButton(panel, btnRow);
    } finally {
      this.isTranslating = false;
      this.abortController = null;
    }
  }

  _addRetryButton(panel, btnRow) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'it-retry-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.setAttribute('aria-label', 'Retry translation');
    const retryHandler = () => { retryBtn.remove(); this._fetchTranslation(panel); };
    retryBtn.addEventListener('click', retryHandler);
    this._panelListeners.push({ element: retryBtn, type: 'click', handler: retryHandler });
    btnRow.appendChild(retryBtn);
    retryBtn.focus();
  }

  _copyTranslation(panel) {
    const translatedBox = panel.querySelector('.it-translated');
    const copyBtn = panel.querySelector('.it-copy-btn');
    const translation = translatedBox?.dataset.translation;
    if (!translation) return;
    
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(translation)
        .then(() => this._showCopySuccess(copyBtn))
        .catch(() => this._fallbackCopy(translation, copyBtn));
    } else {
      this._fallbackCopy(translation, copyBtn);
    }
  }

  async _fallbackCopy(text, copyBtn) {
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const blob = new Blob([text], { type: 'text/plain' });
        const item = new ClipboardItem({ 'text/plain': blob });
        await navigator.clipboard.write([item]);
        this._showCopySuccess(copyBtn);
        return;
      }
      this._showManualCopyDialog(text, copyBtn);
    } catch (err) {
      this._showManualCopyDialog(text, copyBtn);
    }
  }

  _showManualCopyDialog(text, copyBtn) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;';
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#fff;padding:16px;border-radius:8px;max-width:400px;width:90%;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
    dialog.innerHTML = `<p style="margin:0 0 8px;font-size:14px;color:#333;">Select and copy the text below:</p><textarea readonly style="width:100%;height:80px;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:13px;resize:none;">${text.replace(/</g, '&lt;')}</textarea><button style="margin-top:8px;padding:8px 16px;background:#4285f4;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">Close</button>`;
    const textarea = dialog.querySelector('textarea');
    const closeBtn = dialog.querySelector('button');
    textarea.addEventListener('focus', () => textarea.select());
    closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    textarea.focus();
    textarea.select();
    copyBtn.textContent = 'Copy manually';
    setTimeout(() => { if (copyBtn) copyBtn.textContent = 'Copy'; }, 2000);
  }

  _showCopySuccess(copyBtn) {
    if (!copyBtn) return;
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('it-copied');
    setTimeout(() => { if (copyBtn) { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('it-copied'); } }, 1500);
  }


  // ============================================================================
  // REPLACE
  // ============================================================================

  _replaceWithTranslation(panel) {
    const translatedBox = panel.querySelector('.it-translated');
    const replaceBtn = panel.querySelector('.it-replace-btn');
    const translation = translatedBox?.dataset.translation;
    
    if (!translation || !this.selectionRange) return;
    
    try {
      if (!this.selectionRange.commonAncestorContainer || !document.contains(this.selectionRange.commonAncestorContainer)) {
        this._showReplaceError(replaceBtn, 'Selection lost');
        return;
      }
      
      const container = this.selectionRange.commonAncestorContainer;
      const parentElement = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
      
      if (parentElement?.isContentEditable) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(this.selectionRange);
        const inputEvent = new InputEvent('beforeinput', { inputType: 'insertText', data: translation, bubbles: true, cancelable: true });
        if (!parentElement.dispatchEvent(inputEvent)) return;
        this.selectionRange.deleteContents();
        const textNode = document.createTextNode(translation);
        this.selectionRange.insertNode(textNode);
        parentElement.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: translation, bubbles: true }));
      } else {
        const isMultiBlock = this._isMultiBlockSelection(this.selectionRange);
        if (isMultiBlock) this._replaceMultiBlockSelection(translation);
        else this._replaceSingleSelection(translation);
        window.getSelection()?.removeAllRanges();
      }
      
      this._showReplaceSuccess(replaceBtn);
      setTimeout(() => this._hidePanel(), 800);
    } catch (err) {
      console.error('[InlineTranslator] Replace error:', err);
      this._showReplaceError(replaceBtn, 'Replace failed');
    }
  }

  _isMultiBlockSelection(range) {
    const container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) return false;
    const startBlock = this._getBlockParent(range.startContainer);
    const endBlock = this._getBlockParent(range.endContainer);
    return startBlock !== endBlock;
  }

  _getBlockParent(node) {
    const blockTags = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'ARTICLE', 'SECTION']);
    let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (current && current !== document.body) {
      if (blockTags.has(current.tagName)) return current;
      current = current.parentElement;
    }
    return document.body;
  }

  _replaceSingleSelection(translation) {
    const wrapper = document.createElement('span');
    wrapper.className = 'pt-inline-replaced';
    wrapper.textContent = translation;
    wrapper.dataset.ptOriginal = this.selectedText;
    wrapper.title = 'Click to revert to original';
    this.selectionRange.deleteContents();
    this.selectionRange.insertNode(wrapper);
  }

  _replaceMultiBlockSelection(translation) {
    const textNodes = this._getTextNodesInRange(this.selectionRange);
    if (textNodes.length === 0) return;
    
    const firstNode = textNodes[0];
    const startOffset = firstNode.node === this.selectionRange.startContainer ? this.selectionRange.startOffset : 0;
    
    const wrapper = document.createElement('span');
    wrapper.className = 'pt-inline-replaced';
    wrapper.textContent = translation;
    wrapper.dataset.ptOriginal = this.selectedText;
    wrapper.title = 'Click to revert to original';
    
    const beforeText = firstNode.node.textContent.substring(0, startOffset);
    
    for (let i = textNodes.length - 1; i >= 0; i--) {
      const { node } = textNodes[i];
      if (i === 0) {
        const parent = node.parentNode;
        if (!parent) continue;
        if (beforeText) { const beforeNode = document.createTextNode(beforeText); parent.insertBefore(beforeNode, node); }
        parent.insertBefore(wrapper, node);
        if (node === this.selectionRange.startContainer && node === this.selectionRange.endContainer) {
          const afterText = node.textContent.substring(this.selectionRange.endOffset);
          if (afterText) { const afterNode = document.createTextNode(afterText); parent.insertBefore(afterNode, node); }
        }
        parent.removeChild(node);
      } else if (i === textNodes.length - 1) {
        const endOffset = node === this.selectionRange.endContainer ? this.selectionRange.endOffset : node.textContent.length;
        const afterText = node.textContent.substring(endOffset);
        if (afterText) node.textContent = afterText;
        else node.parentNode?.removeChild(node);
      } else {
        node.parentNode?.removeChild(node);
      }
    }
  }

  _getTextNodesInRange(range) {
    const textNodes = [];
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const nodeRange = document.createRange();
        nodeRange.selectNodeContents(node);
        const startsBeforeEnd = range.compareBoundaryPoints(Range.START_TO_END, nodeRange) >= 0;
        const endsAfterStart = range.compareBoundaryPoints(Range.END_TO_START, nodeRange) <= 0;
        if (startsBeforeEnd && endsAfterStart && node.textContent.trim()) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const isPartial = node === range.startContainer || node === range.endContainer;
      textNodes.push({ node, isPartial });
    }
    return textNodes;
  }

  _showReplaceSuccess(replaceBtn) {
    if (!replaceBtn) return;
    replaceBtn.textContent = 'Replaced!';
    replaceBtn.classList.add('it-replaced');
    replaceBtn.disabled = true;
  }

  _showReplaceError(replaceBtn, message) {
    if (!replaceBtn) return;
    replaceBtn.textContent = message;
    setTimeout(() => { if (replaceBtn) replaceBtn.textContent = 'Replace'; }, 1500);
  }


  // ============================================================================
  // POSITIONING
  // ============================================================================

  _getMultiLineRect(range) {
    const rects = range.getClientRects();
    if (rects.length === 0) return range.getBoundingClientRect();
    if (rects.length === 1) return rects[0];
    
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const rect of rects) {
      if (rect.width === 0 && rect.height === 0) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top };
  }

  _calculateIconPosition(rect) {
    const iconSize = 24, gap = 8, padding = 10;
    let left = rect.right + gap;
    let top = rect.top + (rect.height - iconSize) / 2;
    
    if (left + iconSize > window.innerWidth - padding) left = rect.left - iconSize - gap;
    if (left < padding) { left = rect.left + rect.width / 2 - iconSize / 2; top = rect.top - iconSize - gap; }
    
    left = Math.max(padding, Math.min(left, window.innerWidth - iconSize - padding));
    top = Math.max(padding, Math.min(top, window.innerHeight - iconSize - padding));
    return { left, top };
  }

  _getPanelWidth() {
    const viewW = window.innerWidth;
    if (viewW >= 1600) return 680;
    if (viewW >= 1200) return 600;
    return 520;
  }

  _calculatePanelPosition(rect, panelWidth, panelHeight) {
    const padding = 15, gap = 12;
    const viewW = window.innerWidth, viewH = window.innerHeight;
    const actualPanelWidth = Math.min(panelWidth, viewW - 30);
    const maxLeft = viewW - actualPanelWidth - padding;
    const maxTop = viewH - panelHeight - padding;
    
    let left = rect.left + rect.width / 2 - actualPanelWidth / 2;
    left = Math.max(padding, Math.min(left, maxLeft));
    
    const spaceAbove = rect.top - padding - gap;
    const spaceBelow = viewH - rect.bottom - padding - gap;
    
    let top;
    if (spaceAbove >= panelHeight) top = rect.top - panelHeight - gap;
    else if (spaceBelow >= panelHeight) top = rect.bottom + gap;
    else top = padding;
    
    top = Math.max(padding, Math.min(top, maxTop));
    return { left, top };
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  _debounce(fn, delay) {
    let timeoutId;
    return (...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn.apply(this, args), delay); };
  }
}

// Export for use in content.js
if (typeof window !== 'undefined') {
  window.InlineTranslator = InlineTranslator;
}
