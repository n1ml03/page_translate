/**
 * InlineTranslator - Inline translation feature for Chrome extensions
 * Uses Shadow DOM for style isolation
 * Features: Quick language toggle, translation history sync, better loading feedback
 */
class InlineTranslator {
  static MAX_TEXT_LENGTH = 1000;
  
  constructor(options = {}) {
    this.translateFn = options.translateFn || this._mockTranslate.bind(this);
    this.languages = options.languages || [
      { code: 'ja', name: 'Japanese', native: '日本語' },
      { code: 'en', name: 'English', native: 'English' },
      { code: 'zh-CN', name: 'Chinese Simplified', native: '简体中文' },
      { code: 'zh-TW', name: 'Chinese Traditional', native: '繁體中文' },
      { code: 'ko', name: 'Korean', native: '한국어' },
      { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
    ];
    this.defaultLang = options.defaultLang || 'en';
    this.iconUrl = options.iconUrl || null;
    this.onHistoryAdd = options.onHistoryAdd || null;
    
    // Recent languages for quick toggle (synced with popup)
    this.recentLanguages = options.recentLanguages || ['en', 'ja', 'vi'];
    
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
    this.translationStartTime = null;
    
    // Bound event handlers
    this._boundHandleMouseUp = this._handleMouseUp.bind(this);
    this._boundHandleClickOutside = this._handleClickOutside.bind(this);
    this._boundHandleKeyDown = this._handleKeyDown.bind(this);
    this._boundHandleScroll = this._debounce(this._handleScroll.bind(this), 100);
    this._boundHandleRevertClick = this._handleRevertClick.bind(this);
    this._panelListeners = [];
  }

  // Update recent languages (called from content.js when syncing with popup)
  updateRecentLanguages(languages) {
    this.recentLanguages = languages;
  }


  // ============================================================================
  // STYLES - With quick language buttons and progress indicator
  // ============================================================================

  static getStyles() {
    return `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      
      * { box-sizing: border-box; }
      
      .it-icon {
        position: fixed;
        width: 28px;
        height: 28px;
        background: transparent;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483647;
        transition: transform 0.15s ease, opacity 0.15s ease;
        padding: 0;
        opacity: 0.9;
        animation: it-iconPulse 0.3s ease-out;
      }
      
      @keyframes it-iconPulse {
        0% { transform: scale(0.8); opacity: 0; }
        50% { transform: scale(1.1); }
        100% { transform: scale(1); opacity: 0.9; }
      }
      
      .it-icon:hover {
        transform: scale(1.15);
        opacity: 1;
      }
      
      .it-icon svg {
        width: 22px;
        height: 22px;
        fill: #4285f4;
        filter: drop-shadow(0 1px 3px rgba(0,0,0,0.25));
      }
      
      .it-icon img {
        width: 28px;
        height: 28px;
        object-fit: contain;
        filter: drop-shadow(0 1px 3px rgba(0,0,0,0.25));
      }
      
      .it-panel {
        position: fixed;
        width: calc(100vw - 30px);
        max-width: 520px;
        min-width: 300px;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 6px 32px rgba(0, 0, 0, 0.18);
        z-index: 2147483647;
        overflow: hidden;
        animation: it-fadeIn 0.2s ease;
      }
      
      @media (min-width: 1200px) { .it-panel { max-width: 600px; } }
      @media (min-width: 1600px) { .it-panel { max-width: 680px; } }
      
      @keyframes it-fadeIn {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      .it-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: linear-gradient(135deg, #4285f4, #34a853);
        color: white;
      }
      
      .it-panel-title {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
      }
      
      .it-close-btn {
        width: 24px;
        height: 24px;
        background: rgba(255, 255, 255, 0.2);
        border: none;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        transition: background 0.15s ease;
      }
      
      .it-close-btn:hover { background: rgba(255, 255, 255, 0.3); }
      .it-close-btn svg { width: 14px; height: 14px; fill: white; }
      
      .it-panel-body {
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      
      /* Quick Language Toggle */
      .it-quick-langs {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      
      .it-quick-lang-btn {
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 500;
        color: #4285f4;
        background: rgba(66, 133, 244, 0.1);
        border: 1px solid rgba(66, 133, 244, 0.3);
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      
      .it-quick-lang-btn:hover {
        background: rgba(66, 133, 244, 0.2);
        border-color: #4285f4;
      }
      
      .it-quick-lang-btn.active {
        background: #4285f4;
        color: white;
        border-color: #4285f4;
      }
      
      .it-lang-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .it-lang-select {
        flex: 1;
        padding: 8px 10px;
        font-size: 13px;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        background: #f8f9fa;
        cursor: pointer;
        outline: none;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24'%3E%3Cpath fill='%23666' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 10px center;
      }
      
      .it-lang-select:focus { border-color: #4285f4; }
      
      .it-text-section { margin-top: 0; }
      
      .it-text-label {
        font-size: 10px;
        font-weight: 600;
        color: #666;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
        display: block;
      }
      
      .it-text-box {
        width: 100%;
        padding: 10px 12px;
        font-size: 14px;
        line-height: 1.5;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        background: #f8f9fa;
        min-height: 60px;
        max-height: 120px;
        overflow-y: auto;
        word-wrap: break-word;
      }
      
      .it-text-box.it-source { color: #333; }
      
      .it-text-box.it-translated {
        background: #e8f5e9;
        border-color: #c8e6c9;
        color: #2e7d32;
        position: relative;
      }
      
      .it-text-box.it-loading {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: #888;
        min-height: 80px;
      }
      
      .it-text-box.it-error {
        background: #ffebee;
        border-color: #ffcdd2;
        color: #c5221f;
      }
      
      /* Progress Indicator */
      .it-progress-container {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
      }
      
      .it-progress-bar {
        width: 80%;
        height: 4px;
        background: #e0e0e0;
        border-radius: 2px;
        overflow: hidden;
      }
      
      .it-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #4285f4, #34a853);
        border-radius: 2px;
        transition: width 0.3s ease;
        animation: it-progressPulse 1.5s ease-in-out infinite;
      }
      
      @keyframes it-progressPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }
      
      .it-progress-text {
        font-size: 12px;
        color: #666;
      }
      
      .it-elapsed-time {
        font-size: 11px;
        color: #999;
      }
      
      .it-warning {
        font-size: 11px;
        color: #f57c00;
        padding: 4px 8px;
        background: #fff3e0;
        border-radius: 4px;
      }
      
      .it-btn-row {
        display: flex;
        gap: 8px;
        margin-top: 4px;
      }
      
      .it-copy-btn, .it-retry-btn, .it-replace-btn {
        flex: 1;
        padding: 8px;
        font-size: 13px;
        font-weight: 500;
        color: white;
        background: linear-gradient(135deg, #4285f4, #34a853);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: opacity 0.15s ease;
      }
      
      .it-copy-btn:hover, .it-retry-btn:hover, .it-replace-btn:hover { opacity: 0.9; }
      .it-copy-btn:disabled, .it-retry-btn:disabled, .it-replace-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .it-copy-btn.it-copied, .it-replace-btn.it-replaced { background: #34a853; }
      
      .it-retry-btn {
        background: #f44336;
        flex: 0 0 auto;
        padding: 8px 16px;
      }
      
      /* Keyboard hint */
      .it-keyboard-hint {
        font-size: 10px;
        color: #999;
        text-align: center;
        margin-top: 4px;
      }
      
      .it-kbd {
        display: inline-block;
        padding: 1px 4px;
        background: #f0f0f0;
        border: 1px solid #ddd;
        border-radius: 3px;
        font-family: monospace;
        font-size: 10px;
      }
    `;
  }


  // ============================================================================
  // MOCK TRANSLATE (fallback)
  // ============================================================================

  async _mockTranslate(text, lang, signal) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, 500 + Math.random() * 500);
      signal?.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      });
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
    
    if (this.hostElement) {
      this.hostElement.remove();
      this.hostElement = null;
      this.shadowRoot = null;
    }
    
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
      .pt-inline-replaced {
        background-color: rgba(52, 168, 83, 0.15) !important;
        border-radius: 2px !important;
        cursor: pointer !important;
        position: relative !important;
        display: inline !important;
      }
      .pt-inline-replaced:hover {
        background-color: rgba(52, 168, 83, 0.25) !important;
      }
      .pt-inline-replaced::after {
        content: '↩' !important;
        position: absolute !important;
        top: -10px !important;
        right: -10px !important;
        width: 18px !important;
        height: 18px !important;
        background: #f44336 !important;
        color: white !important;
        font-size: 11px !important;
        line-height: 18px !important;
        text-align: center !important;
        border-radius: 50% !important;
        opacity: 0 !important;
        transform: scale(0.8) !important;
        transition: opacity 0.15s ease, transform 0.15s ease !important;
        pointer-events: none !important;
        z-index: 10000 !important;
      }
      .pt-inline-replaced:hover::after {
        opacity: 1 !important;
        transform: scale(1) !important;
      }
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
      if (this.panelElement) {
        this._hidePanel();
        e.preventDefault();
      } else if (this.iconElement) {
        this._hideIcon();
        e.preventDefault();
      }
    }
    
    if (e.key === 'Tab' && this.panelElement) {
      this._handleFocusTrap(e);
    }
  }

  _handleFocusTrap(e) {
    const focusableElements = this.panelElement.querySelectorAll(
      'button:not([disabled]), select, [tabindex]:not([tabindex="-1"])'
    );
    
    if (focusableElements.length === 0) return;
    
    const firstEl = focusableElements[0];
    const lastEl = focusableElements[focusableElements.length - 1];
    
    if (e.shiftKey && this.shadowRoot.activeElement === firstEl) {
      lastEl.focus();
      e.preventDefault();
    } else if (!e.shiftKey && this.shadowRoot.activeElement === lastEl) {
      firstEl.focus();
      e.preventDefault();
    }
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
      try {
        selection = window.getSelection();
        text = selection?.toString().trim();
      } catch (err) {
        return;
      }
      
      if (!text) return;
      
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
        return;
      }
      
      try {
        const range = selection.getRangeAt(0);
        this.selectionRect = this._getMultiLineRect(range);
        this.selectedText = text;
        this.selectionRange = range.cloneRange();
        
        this._hidePanel();
        this._showIcon();
      } catch (err) {
        return;
      }
    }, 10);
  }

  _handleClickOutside(e) {
    const path = e.composedPath();
    const isInsideUI = path.some(el => 
      el === this.iconElement || 
      el === this.panelElement || 
      el === this.hostElement
    );
    
    if (!isInsideUI && !this.shadowRoot?.contains(e.target)) {
      this._hideIcon();
      this._hidePanel();
    }
  }

  _handleRevertClick(e) {
    const target = e.target;
    if (!target.classList?.contains('pt-inline-replaced')) return;
    
    const originalText = target.dataset.ptOriginal;
    const originalHTML = target.dataset.ptOriginalHtml;
    
    if (!originalText && !originalHTML) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const parent = target.parentNode;
    if (!parent) return;
    
    // Prefer restoring original HTML if available (preserves formatting)
    if (originalHTML) {
      const tempContainer = document.createElement('div');
      tempContainer.innerHTML = originalHTML;
      
      const fragment = document.createDocumentFragment();
      while (tempContainer.firstChild) {
        fragment.appendChild(tempContainer.firstChild);
      }
      
      parent.replaceChild(fragment, target);
    } else if (originalText.includes('\n')) {
      const wrapper = document.createElement('span');
      wrapper.style.whiteSpace = 'pre-wrap';
      this._setTextWithLineBreaks(wrapper, originalText);
      parent.replaceChild(wrapper, target);
    } else {
      const textNode = document.createTextNode(originalText);
      parent.replaceChild(textNode, target);
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
    
    const clickHandler = (e) => {
      e.stopPropagation();
      this._hideIcon();
      this._showPanel();
    };
    
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
    } catch {
      return false;
    }
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
    if (this.iconElement) {
      this.iconElement.remove();
      this.iconElement = null;
    }
  }

  // ============================================================================
  // PANEL - With quick language toggle and progress indicator
  // ============================================================================

  _showPanel() {
    this._hidePanel();
    this.isTranslating = false;
    
    const isTextTruncated = this.selectedText.length > InlineTranslator.MAX_TEXT_LENGTH;
    const displayText = isTextTruncated 
      ? this.selectedText.substring(0, InlineTranslator.MAX_TEXT_LENGTH) 
      : this.selectedText;
    
    const panel = document.createElement('div');
    panel.className = 'it-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Translation panel');
    
    this._buildPanelContent(panel, displayText, isTextTruncated);
    
    const pos = this._calculatePanelPosition(this.selectionRect, this._getPanelWidth(), 380);
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
    closeBtn.setAttribute('aria-label', 'Close');
    
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
    
    // Warning for truncated text
    if (isTextTruncated) {
      const warning = document.createElement('div');
      warning.className = 'it-warning';
      warning.textContent = `Text truncated to ${InlineTranslator.MAX_TEXT_LENGTH.toLocaleString()} characters`;
      body.appendChild(warning);
    }
    
    // Quick language buttons
    const quickLangs = document.createElement('div');
    quickLangs.className = 'it-quick-langs';
    
    this.recentLanguages.forEach(langCode => {
      const lang = this.languages.find(l => l.code === langCode);
      if (!lang) return;
      
      const btn = document.createElement('button');
      btn.className = 'it-quick-lang-btn';
      if (langCode === this.currentLang) btn.classList.add('active');
      btn.textContent = lang.native;
      btn.title = lang.name;
      btn.dataset.lang = langCode;
      
      const quickLangHandler = () => {
        this.currentLang = langCode;
        quickLangs.querySelectorAll('.it-quick-lang-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const select = panel.querySelector('.it-lang-select');
        if (select) select.value = langCode;
        this._fetchTranslation(panel);
      };
      
      btn.addEventListener('click', quickLangHandler);
      this._panelListeners.push({ element: btn, type: 'click', handler: quickLangHandler });
      
      quickLangs.appendChild(btn);
    });
    
    body.appendChild(quickLangs);
    
    // Language select row
    const langRow = document.createElement('div');
    langRow.className = 'it-lang-row';
    
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
    
    const langChangeHandler = (e) => {
      e.stopPropagation();
      this.currentLang = e.target.value;
      quickLangs.querySelectorAll('.it-quick-lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === this.currentLang);
      });
      this._fetchTranslation(panel);
    };
    langSelect.addEventListener('change', langChangeHandler);
    this._panelListeners.push({ element: langSelect, type: 'change', handler: langChangeHandler });
    
    langRow.appendChild(langSelect);
    body.appendChild(langRow);
    
    // Source text section
    const sourceSection = document.createElement('div');
    sourceSection.className = 'it-text-section';
    
    const sourceLabel = document.createElement('span');
    sourceLabel.className = 'it-text-label';
    sourceLabel.textContent = 'Source';
    sourceSection.appendChild(sourceLabel);
    
    const sourceBox = document.createElement('div');
    sourceBox.className = 'it-text-box it-source';
    sourceBox.style.whiteSpace = 'pre-wrap';
    this._setTextWithLineBreaks(sourceBox, displayText);
    sourceSection.appendChild(sourceBox);
    
    body.appendChild(sourceSection);
    
    // Translation section
    const transSection = document.createElement('div');
    transSection.className = 'it-text-section';
    
    const transLabel = document.createElement('span');
    transLabel.className = 'it-text-label';
    transLabel.textContent = 'Translation';
    transSection.appendChild(transLabel);
    
    const transBox = document.createElement('div');
    transBox.className = 'it-text-box it-translated it-loading';
    transBox.setAttribute('aria-live', 'polite');
    
    // Progress indicator
    const progressContainer = document.createElement('div');
    progressContainer.className = 'it-progress-container';
    
    const progressBar = document.createElement('div');
    progressBar.className = 'it-progress-bar';
    const progressFill = document.createElement('div');
    progressFill.className = 'it-progress-fill';
    progressFill.style.width = '30%';
    progressBar.appendChild(progressFill);
    progressContainer.appendChild(progressBar);
    
    const progressText = document.createElement('span');
    progressText.className = 'it-progress-text';
    progressText.textContent = 'Translating...';
    progressContainer.appendChild(progressText);
    
    const elapsedTime = document.createElement('span');
    elapsedTime.className = 'it-elapsed-time';
    elapsedTime.textContent = '';
    progressContainer.appendChild(elapsedTime);
    
    transBox.appendChild(progressContainer);
    transSection.appendChild(transBox);
    body.appendChild(transSection);
    
    // Button row
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
    replaceBtn.title = 'Replace original text';
    replaceBtn.disabled = true;
    
    const replaceHandler = () => this._replaceWithTranslation(panel);
    replaceBtn.addEventListener('click', replaceHandler);
    this._panelListeners.push({ element: replaceBtn, type: 'click', handler: replaceHandler });
    
    btnRow.appendChild(replaceBtn);
    body.appendChild(btnRow);
    
    // Keyboard hint
    const hint = document.createElement('div');
    hint.className = 'it-keyboard-hint';
    hint.innerHTML = 'Press <span class="it-kbd">Esc</span> to close';
    body.appendChild(hint);
    
    panel.appendChild(body);
  }

  _hidePanel() {
    this._cancelPendingRequest();
    this._cleanupPanelListeners();
    
    if (this.panelElement) {
      this.panelElement.remove();
      this.panelElement = null;
    }
    this.isTranslating = false;
    this.translationStartTime = null;
  }

  _cancelPendingRequest() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  _cleanupPanelListeners() {
    this._panelListeners.forEach(({ element, type, handler }) => {
      element.removeEventListener(type, handler);
    });
    this._panelListeners = [];
  }


  // ============================================================================
  // TRANSLATION - With progress tracking
  // ============================================================================

  async _fetchTranslation(panel) {
    if (this.isTranslating) {
      this._cancelPendingRequest();
    }
    
    const translatedBox = panel.querySelector('.it-translated');
    const copyBtn = panel.querySelector('.it-copy-btn');
    const replaceBtn = panel.querySelector('.it-replace-btn');
    const btnRow = panel.querySelector('.it-btn-row');
    
    if (!translatedBox || !copyBtn || !btnRow) return;
    
    // Remove existing retry button
    const existingRetry = btnRow.querySelector('.it-retry-btn');
    if (existingRetry) existingRetry.remove();
    
    // Show loading state with progress
    this.isTranslating = true;
    this.translationStartTime = Date.now();
    translatedBox.classList.add('it-loading');
    translatedBox.classList.remove('it-error');
    
    // Build progress UI
    const progressContainer = document.createElement('div');
    progressContainer.className = 'it-progress-container';
    
    const progressBar = document.createElement('div');
    progressBar.className = 'it-progress-bar';
    const progressFill = document.createElement('div');
    progressFill.className = 'it-progress-fill';
    progressFill.style.width = '20%';
    progressBar.appendChild(progressFill);
    progressContainer.appendChild(progressBar);
    
    const progressText = document.createElement('span');
    progressText.className = 'it-progress-text';
    progressText.textContent = 'Translating...';
    progressContainer.appendChild(progressText);
    
    const elapsedTime = document.createElement('span');
    elapsedTime.className = 'it-elapsed-time';
    progressContainer.appendChild(elapsedTime);
    
    translatedBox.replaceChildren(progressContainer);
    
    // Animate progress
    let progressValue = 20;
    const progressInterval = setInterval(() => {
      if (progressValue < 85) {
        progressValue += Math.random() * 10;
        progressFill.style.width = `${Math.min(progressValue, 85)}%`;
      }
      // Update elapsed time
      const elapsed = ((Date.now() - this.translationStartTime) / 1000).toFixed(1);
      elapsedTime.textContent = `${elapsed}s`;
    }, 300);
    
    copyBtn.disabled = true;
    copyBtn.textContent = 'Copy';
    copyBtn.classList.remove('it-copied');
    
    if (replaceBtn) {
      replaceBtn.disabled = true;
      replaceBtn.textContent = 'Replace';
      replaceBtn.classList.remove('it-replaced');
    }
    
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    
    const textToTranslate = this.selectedText.length > InlineTranslator.MAX_TEXT_LENGTH
      ? this.selectedText.substring(0, InlineTranslator.MAX_TEXT_LENGTH)
      : this.selectedText;
    
    try {
      const translation = await this.translateFn(textToTranslate, this.currentLang, signal);
      
      clearInterval(progressInterval);
      
      if (!this.panelElement || signal.aborted) return;
      
      // Complete progress
      progressFill.style.width = '100%';
      
      setTimeout(() => {
        translatedBox.classList.remove('it-loading');
        translatedBox.style.whiteSpace = 'pre-wrap';
        this._setTextWithLineBreaks(translatedBox, translation);
        translatedBox.dataset.translation = translation;
        copyBtn.disabled = false;
        if (replaceBtn) replaceBtn.disabled = false;
        
        // Add to history if callback provided
        if (this.onHistoryAdd) {
          this.onHistoryAdd(textToTranslate, translation, this.currentLang);
        }
      }, 150);
      
    } catch (err) {
      clearInterval(progressInterval);
      
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
    
    const retryHandler = () => {
      retryBtn.remove();
      this._fetchTranslation(panel);
    };
    retryBtn.addEventListener('click', retryHandler);
    this._panelListeners.push({ element: retryBtn, type: 'click', handler: retryHandler });
    
    btnRow.appendChild(retryBtn);
    retryBtn.focus();
  }

  // ============================================================================
  // COPY & REPLACE
  // ============================================================================

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
    } catch {
      this._showManualCopyDialog(text, copyBtn);
    }
  }

  _showManualCopyDialog(text, copyBtn) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#fff;padding:16px;border-radius:8px;max-width:400px;width:90%;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
    dialog.innerHTML = `
      <p style="margin:0 0 8px;font-size:14px;color:#333;">Select and copy:</p>
      <textarea readonly style="width:100%;height:80px;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:13px;resize:none;">${text.replace(/</g, '&lt;')}</textarea>
      <button style="margin-top:8px;padding:8px 16px;background:#4285f4;color:#fff;border:none;border-radius:4px;cursor:pointer;">Close</button>
    `;

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
    setTimeout(() => {
      if (copyBtn) {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('it-copied');
      }
    }, 1500);
  }

  _replaceWithTranslation(panel) {
    const translatedBox = panel.querySelector('.it-translated');
    const replaceBtn = panel.querySelector('.it-replace-btn');
    const translation = translatedBox?.dataset.translation;
    
    if (!translation || !this.selectionRange) return;
    
    try {
      if (!this.selectionRange.commonAncestorContainer || 
          !document.contains(this.selectionRange.commonAncestorContainer)) {
        this._showReplaceError(replaceBtn, 'Selection lost');
        return;
      }
      
      const container = this.selectionRange.commonAncestorContainer;
      const parentElement = container.nodeType === Node.TEXT_NODE 
        ? container.parentElement 
        : container;
      
      if (parentElement?.isContentEditable) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(this.selectionRange);
        
        this.selectionRange.deleteContents();
        const textNode = document.createTextNode(translation);
        this.selectionRange.insertNode(textNode);
        
        parentElement.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText',
          data: translation,
          bubbles: true
        }));
      } else {
        // Use format-preserving replacement algorithm
        this._replaceWithFormatPreservation(translation);
        window.getSelection()?.removeAllRanges();
      }
      
      this._showReplaceSuccess(replaceBtn);
      setTimeout(() => this._hidePanel(), 800);
      
    } catch (err) {
      console.error('[InlineTranslator] Replace error:', err);
      this._showReplaceError(replaceBtn, 'Replace failed');
    }
  }


  // ============================================================================
  // FORMAT-PRESERVING REPLACEMENT ALGORITHM
  // Adapted from content.js page translator for better CSS/HTML preservation
  // ============================================================================

  static INLINE_TAGS = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'SPAN', 'A', 'FONT', 'SMALL', 'BIG', 'SUB', 'SUP', 'BR', 'IMG', 'CODE', 'MARK', 'DEL', 'INS', 'S', 'ABBR', 'CITE', 'DFN', 'KBD', 'Q', 'SAMP', 'VAR', 'TIME', 'DATA', 'RUBY', 'RT', 'RP', 'BDI', 'BDO', 'WBR']);
  static BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'ARTICLE', 'SECTION', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN', 'FIGURE', 'FIGCAPTION', 'DD', 'DT', 'ADDRESS', 'PRE']);

  _replaceWithFormatPreservation(translation) {
    const range = this.selectionRange;
    const container = range.commonAncestorContainer;
    
    // Analyze selection structure
    const selectionInfo = this._analyzeSelection(range);
    
    if (selectionInfo.type === 'singleTextNode') {
      // Simple case: selection within a single text node
      this._replaceSingleTextNode(range, translation, selectionInfo);
    } else if (selectionInfo.type === 'inlineOnly') {
      // Selection spans inline elements only (e.g., <b>text</b><i>more</i>)
      this._replaceInlineSelection(range, translation, selectionInfo);
    } else if (selectionInfo.type === 'singleBlock') {
      // Selection within a single block element with inline content
      this._replaceBlockInlineContent(range, translation, selectionInfo);
    } else {
      // Multi-block selection - use simplified approach
      this._replaceMultiBlockPreserving(range, translation, selectionInfo);
    }
  }

  _analyzeSelection(range) {
    const container = range.commonAncestorContainer;
    const startContainer = range.startContainer;
    const endContainer = range.endContainer;
    
    // Single text node selection
    if (startContainer === endContainer && startContainer.nodeType === Node.TEXT_NODE) {
      return {
        type: 'singleTextNode',
        textNode: startContainer,
        parentElement: startContainer.parentElement
      };
    }
    
    // Get the common ancestor element
    const ancestorElement = container.nodeType === Node.TEXT_NODE 
      ? container.parentElement 
      : container;
    
    // Check if selection is within a single block
    const startBlock = this._getBlockParent(startContainer);
    const endBlock = this._getBlockParent(endContainer);
    
    if (startBlock === endBlock) {
      // Check if the block has only inline content
      if (this._hasOnlyInlineContent(startBlock)) {
        return {
          type: 'singleBlock',
          blockElement: startBlock,
          originalHTML: this._getSelectedHTML(range),
          computedStyles: this._captureComputedStyles(startBlock)
        };
      }
      return {
        type: 'inlineOnly',
        ancestorElement,
        originalHTML: this._getSelectedHTML(range),
        computedStyles: this._captureInlineStyles(range)
      };
    }
    
    // Multi-block selection
    return {
      type: 'multiBlock',
      startBlock,
      endBlock,
      originalHTML: this._getSelectedHTML(range),
      blocks: this._getBlocksInRange(range)
    };
  }

  _getBlockParent(node) {
    let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    
    while (current && current !== document.body) {
      if (InlineTranslator.BLOCK_TAGS.has(current.tagName)) return current;
      current = current.parentElement;
    }
    return document.body;
  }

  _hasOnlyInlineContent(element) {
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (InlineTranslator.BLOCK_TAGS.has(tag)) return false;
        if (!InlineTranslator.INLINE_TAGS.has(tag) && !this._hasOnlyInlineContent(child)) return false;
      }
    }
    return true;
  }

  _getSelectedHTML(range) {
    const fragment = range.cloneContents();
    const div = document.createElement('div');
    div.appendChild(fragment);
    return div.innerHTML;
  }

  _captureComputedStyles(element) {
    const computed = window.getComputedStyle(element);
    return {
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      fontStyle: computed.fontStyle,
      color: computed.color,
      textDecoration: computed.textDecoration,
      lineHeight: computed.lineHeight,
      letterSpacing: computed.letterSpacing,
      textTransform: computed.textTransform,
      whiteSpace: computed.whiteSpace
    };
  }

  _captureInlineStyles(range) {
    // Capture styles from the first text node's parent
    const startElement = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : range.startContainer;
    return startElement ? this._captureComputedStyles(startElement) : {};
  }

  _getBlocksInRange(range) {
    const blocks = [];
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (!InlineTranslator.BLOCK_TAGS.has(node.tagName)) return NodeFilter.FILTER_SKIP;
          const nodeRange = document.createRange();
          nodeRange.selectNodeContents(node);
          if (range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0 &&
              range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );
    
    let node;
    while ((node = walker.nextNode())) {
      blocks.push(node);
    }
    return blocks;
  }

  // ============================================================================
  // REPLACEMENT METHODS
  // ============================================================================

  _replaceSingleTextNode(range, translation, info) {
    const textNode = info.textNode;
    const parent = info.parentElement;
    
    if (!parent) {
      // Fallback: simple replacement
      range.deleteContents();
      range.insertNode(document.createTextNode(translation));
      return;
    }
    
    const beforeText = textNode.textContent.substring(0, range.startOffset);
    const afterText = textNode.textContent.substring(range.endOffset);
    
    // Create wrapper that preserves parent's inline styling context
    const wrapper = document.createElement('span');
    wrapper.className = 'pt-inline-replaced';
    wrapper.dataset.ptOriginal = this.selectedText;
    wrapper.title = 'Click to revert';
    
    // Copy relevant inline styles from parent
    this._copyInlineStyles(parent, wrapper);
    
    // Set translation text with line break handling
    this._setTextWithLineBreaks(wrapper, translation);
    
    // Build replacement structure
    const fragment = document.createDocumentFragment();
    if (beforeText) fragment.appendChild(document.createTextNode(beforeText));
    fragment.appendChild(wrapper);
    if (afterText) fragment.appendChild(document.createTextNode(afterText));
    
    parent.replaceChild(fragment, textNode);
  }

  _replaceInlineSelection(range, translation, info) {
    const wrapper = document.createElement('span');
    wrapper.className = 'pt-inline-replaced';
    wrapper.dataset.ptOriginal = this.selectedText;
    wrapper.dataset.ptOriginalHtml = info.originalHTML;
    wrapper.title = 'Click to revert';
    
    // Apply captured styles
    if (info.computedStyles) {
      this._applyComputedStyles(wrapper, info.computedStyles);
    }
    
    this._setTextWithLineBreaks(wrapper, translation);
    
    range.deleteContents();
    range.insertNode(wrapper);
  }

  _replaceBlockInlineContent(range, translation, info) {
    const wrapper = document.createElement('span');
    wrapper.className = 'pt-inline-replaced';
    wrapper.dataset.ptOriginal = this.selectedText;
    wrapper.dataset.ptOriginalHtml = info.originalHTML;
    wrapper.title = 'Click to revert';
    
    // Preserve the block's text styling
    if (info.computedStyles) {
      this._applyComputedStyles(wrapper, info.computedStyles);
    }
    
    this._setTextWithLineBreaks(wrapper, translation);
    
    range.deleteContents();
    range.insertNode(wrapper);
  }

  _replaceMultiBlockPreserving(range, translation, info) {
    // For multi-block, we need to be more careful
    // Strategy: Replace content in first block, remove content from subsequent blocks
    
    const textNodes = this._getTextNodesInRange(range);
    if (textNodes.length === 0) {
      // Fallback
      range.deleteContents();
      const wrapper = this._createReplacementWrapper(translation, info.originalHTML);
      range.insertNode(wrapper);
      return;
    }
    
    const firstNode = textNodes[0];
    const startOffset = firstNode.node === range.startContainer ? range.startOffset : 0;
    
    // Create wrapper with original HTML stored for revert
    const wrapper = this._createReplacementWrapper(translation, info.originalHTML);
    
    const beforeText = firstNode.node.textContent.substring(0, startOffset);
    
    // Process nodes in reverse order
    for (let i = textNodes.length - 1; i >= 0; i--) {
      const { node } = textNodes[i];
      
      if (i === 0) {
        const parent = node.parentNode;
        if (!parent) continue;
        
        if (beforeText) {
          parent.insertBefore(document.createTextNode(beforeText), node);
        }
        parent.insertBefore(wrapper, node);
        
        if (node === range.startContainer && node === range.endContainer) {
          const afterText = node.textContent.substring(range.endOffset);
          if (afterText) {
            parent.insertBefore(document.createTextNode(afterText), node);
          }
        }
        parent.removeChild(node);
      } else if (i === textNodes.length - 1) {
        const endOffset = node === range.endContainer 
          ? range.endOffset : node.textContent.length;
        const afterText = node.textContent.substring(endOffset);
        
        if (afterText) {
          node.textContent = afterText;
        } else {
          node.parentNode?.removeChild(node);
        }
      } else {
        node.parentNode?.removeChild(node);
      }
    }
  }

  _createReplacementWrapper(translation, originalHTML) {
    const wrapper = document.createElement('span');
    wrapper.className = 'pt-inline-replaced';
    wrapper.dataset.ptOriginal = this.selectedText;
    if (originalHTML) {
      wrapper.dataset.ptOriginalHtml = originalHTML;
    }
    wrapper.title = 'Click to revert';
    wrapper.style.whiteSpace = 'pre-wrap';
    this._setTextWithLineBreaks(wrapper, translation);
    return wrapper;
  }

  _copyInlineStyles(source, target) {
    const computed = window.getComputedStyle(source);
    
    // Only copy text-related styles that affect appearance
    const stylesToCopy = ['font-family', 'font-size', 'font-weight', 'font-style', 
                          'color', 'text-decoration', 'letter-spacing', 'text-transform'];
    
    stylesToCopy.forEach(prop => {
      const value = computed.getPropertyValue(prop);
      if (value && value !== 'normal' && value !== 'none') {
        // Don't override if it's a default value
        const defaultCheck = document.createElement('span');
        document.body.appendChild(defaultCheck);
        const defaultValue = window.getComputedStyle(defaultCheck).getPropertyValue(prop);
        document.body.removeChild(defaultCheck);
        
        if (value !== defaultValue) {
          target.style.setProperty(prop, value);
        }
      }
    });
  }

  _applyComputedStyles(element, styles) {
    if (styles.fontWeight && styles.fontWeight !== 'normal' && styles.fontWeight !== '400') {
      element.style.fontWeight = styles.fontWeight;
    }
    if (styles.fontStyle && styles.fontStyle !== 'normal') {
      element.style.fontStyle = styles.fontStyle;
    }
    if (styles.textDecoration && styles.textDecoration !== 'none') {
      element.style.textDecoration = styles.textDecoration;
    }
    if (styles.textTransform && styles.textTransform !== 'none') {
      element.style.textTransform = styles.textTransform;
    }
  }

  _setTextWithLineBreaks(element, text) {
    element.innerHTML = '';
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) element.appendChild(document.createElement('br'));
      if (line) element.appendChild(document.createTextNode(line));
    });
  }

  _getTextNodesInRange(range) {
    const textNodes = [];
    const container = range.commonAncestorContainer;
    
    // Handle case where container is a text node
    if (container.nodeType === Node.TEXT_NODE) {
      return [{ node: container, isPartial: true }];
    }
    
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const nodeRange = document.createRange();
          nodeRange.selectNodeContents(node);
          
          const startsBeforeEnd = range.compareBoundaryPoints(Range.START_TO_END, nodeRange) >= 0;
          const endsAfterStart = range.compareBoundaryPoints(Range.END_TO_START, nodeRange) <= 0;
          
          if (startsBeforeEnd && endsAfterStart && node.textContent.trim()) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_REJECT;
        }
      }
    );
    
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
    const iconSize = 28;
    const gap = 8;
    const padding = 10;
    
    let left = rect.right + gap;
    let top = rect.top + (rect.height - iconSize) / 2;
    
    if (left + iconSize > window.innerWidth - padding) {
      left = rect.left - iconSize - gap;
    }
    
    if (left < padding) {
      left = rect.left + rect.width / 2 - iconSize / 2;
      top = rect.top - iconSize - gap;
    }
    
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
    const padding = 15;
    const gap = 12;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    
    const actualPanelWidth = Math.min(panelWidth, viewW - 30);
    const maxLeft = viewW - actualPanelWidth - padding;
    const maxTop = viewH - panelHeight - padding;
    
    let left = rect.left + rect.width / 2 - actualPanelWidth / 2;
    left = Math.max(padding, Math.min(left, maxLeft));
    
    const spaceAbove = rect.top - padding - gap;
    const spaceBelow = viewH - rect.bottom - padding - gap;
    
    let top;
    if (spaceAbove >= panelHeight) {
      top = rect.top - panelHeight - gap;
    } else if (spaceBelow >= panelHeight) {
      top = rect.bottom + gap;
    } else {
      top = padding;
    }
    
    top = Math.max(padding, Math.min(top, maxTop));
    
    return { left, top };
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  _debounce(fn, delay) {
    let timeoutId;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
  }
}

// Export
if (typeof window !== 'undefined') {
  window.InlineTranslator = InlineTranslator;
}
