/**
 * InlineTranslator - Inline translation feature for Chrome extensions
 * Uses Shadow DOM for style isolation
 */
class InlineTranslator {
  // Maximum characters allowed for translation
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
    
    // Store the selection range for inline replacement
    this.selectionRange = null;
    
    // AbortController for cancelling stale requests
    this.abortController = null;
    
    // Bound event handlers for proper cleanup
    this._boundHandleMouseUp = this._handleMouseUp.bind(this);
    this._boundHandleClickOutside = this._handleClickOutside.bind(this);
    this._boundHandleKeyDown = this._handleKeyDown.bind(this);
    this._boundHandleScroll = this._debounce(this._handleScroll.bind(this), 100);
    this._boundHandleRevertClick = this._handleRevertClick.bind(this);
    
    // Track panel-specific listeners for cleanup
    this._panelListeners = [];
  }


  // ============================================================================
  // STYLES - Responsive design with max-width instead of fixed width
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
        width: 24px;
        height: 24px;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483647;
        transition: transform 0.15s ease, opacity 0.15s ease;
        padding: 0;
        opacity: 0.85;
      }
      
      .it-icon:hover {
        transform: scale(1.15);
        opacity: 1;
      }
      
      .it-icon svg {
        width: 20px;
        height: 20px;
        fill: #4285f4;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2));
      }
      
      .it-icon img {
        width: 24px;
        height: 24px;
        object-fit: contain;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2));
      }
      
      /* Responsive panel: larger default, optimized for big screens */
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
      
      /* Large screen optimization (>1200px) */
      @media (min-width: 1200px) {
        .it-panel {
          max-width: 600px;
        }
      }
      
      /* Extra large screens (>1600px) */
      @media (min-width: 1600px) {
        .it-panel {
          max-width: 680px;
        }
      }
      
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
      .it-close-btn:focus { outline: 2px solid white; outline-offset: 2px; }
      .it-close-btn svg { width: 14px; height: 14px; fill: white; }
      
      .it-panel-body {
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      
      @media (min-width: 1200px) {
        .it-panel-body {
          padding: 16px 20px;
          gap: 12px;
        }
      }
      
      .it-lang-select {
        width: 100%;
        padding: 8px 10px;
        font-size: 13px;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        background: #f8f9fa;
        cursor: pointer;
        outline: none;
        transition: border-color 0.15s ease;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24'%3E%3Cpath fill='%23666' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 10px center;
      }
      
      .it-lang-select:focus { border-color: #4285f4; outline: 2px solid #4285f433; }
      
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
      }
      
      .it-text-box.it-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        color: #888;
      }
      
      .it-text-box.it-error {
        background: #ffebee;
        border-color: #ffcdd2;
        color: #c5221f;
      }
      
      /* Larger text boxes on big screens */
      @media (min-width: 1200px) {
        .it-text-box {
          min-height: 80px;
          max-height: 180px;
          font-size: 15px;
        }
      }
      
      @media (min-width: 1600px) {
        .it-text-box {
          min-height: 100px;
          max-height: 240px;
        }
      }
      
      .it-warning {
        font-size: 11px;
        color: #f57c00;
        padding: 4px 8px;
        background: #fff3e0;
        border-radius: 4px;
        margin-bottom: 4px;
      }
      
      .it-spinner {
        width: 20px;
        height: 20px;
        border: 2px solid #e0e0e0;
        border-top-color: #4285f4;
        border-radius: 50%;
        animation: it-spin 0.8s linear infinite;
        margin-right: 8px;
      }
      
      @keyframes it-spin { to { transform: rotate(360deg); } }
      
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
      .it-copy-btn:focus, .it-retry-btn:focus, .it-replace-btn:focus { outline: 2px solid #4285f4; outline-offset: 2px; }
      .it-copy-btn:disabled, .it-retry-btn:disabled, .it-replace-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .it-copy-btn.it-copied, .it-replace-btn.it-replaced { background: #34a853; }
      
      .it-retry-btn {
        background: #f44336;
        flex: 0 0 auto;
        padding: 8px 16px;
      }
      
      .it-retry-btn:hover { background: #d32f2f; }
      
      /* Screen reader only */
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
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
    // Cancel any pending translation
    this._cancelPendingRequest();
    
    // Remove all global listeners
    this._removeListeners();
    
    // Clean up panel-specific listeners
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
    
    // Inject styles for replaced text into the main document (not shadow DOM)
    // This is needed for ::after pseudo-element to work
    this._injectReplacedTextStyles();
  }

  /**
   * Inject styles for replaced text elements into the main document
   */
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
        font-family: sans-serif !important;
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

  /**
   * Handle Escape key to close panel (A11y)
   */
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
    
    // Focus trap: Tab key handling within panel
    if (e.key === 'Tab' && this.panelElement) {
      this._handleFocusTrap(e);
    }
  }

  /**
   * Focus trap implementation for keyboard accessibility
   */
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

  /**
   * Handle scroll events to reposition panel (debounced)
   */
  _handleScroll() {
    if (this.panelElement && this.selectionRect) {
      // Recalculate position based on current selection
      try {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          this.selectionRect = this._getMultiLineRect(range);
          
          const pos = this._calculatePanelPosition(this.selectionRect, this._getPanelWidth(), 320);
          this.panelElement.style.left = `${pos.left}px`;
          this.panelElement.style.top = `${pos.top}px`;
        }
      } catch (e) {
        // Ignore errors from cross-origin iframes
      }
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
      // Wrap in try-catch for iframe safety
      let selection, text;
      try {
        selection = window.getSelection();
        text = selection?.toString().trim();
      } catch (err) {
        // Cross-origin iframe - silently fail
        return;
      }
      
      if (!text) return;
      
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
        return;
      }
      
      try {
        const range = selection.getRangeAt(0);
        // Use improved multi-line positioning
        this.selectionRect = this._getMultiLineRect(range);
        this.selectedText = text;
        // Store the range for inline replacement
        this.selectionRange = range.cloneRange();
        
        this._hidePanel();
        this._showIcon();
      } catch (err) {
        // Handle edge cases where range is not available
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

  /**
   * Handle click on replaced text to revert to original
   */
  _handleRevertClick(e) {
    const target = e.target;
    
    // Check if clicked element is a replaced text span
    if (!target.classList?.contains('pt-inline-replaced')) return;
    
    const originalText = target.dataset.ptOriginal;
    if (!originalText) return;
    
    // Prevent triggering other click handlers
    e.preventDefault();
    e.stopPropagation();
    
    // Revert to original text - preserve line breaks
    const parent = target.parentNode;
    if (!parent) return;
    
    // Check if original text has line breaks
    if (originalText.includes('\n')) {
      // Create a span to preserve formatting
      const wrapper = document.createElement('span');
      wrapper.style.whiteSpace = 'pre-wrap';
      this._setTextWithLineBreaks(wrapper, originalText);
      parent.replaceChild(wrapper, target);
    } else {
      // Simple text node for single-line text
      const textNode = document.createTextNode(originalText);
      parent.replaceChild(textNode, target);
    }
    
    // Clear any selection that might have been made
    window.getSelection()?.removeAllRanges();
  }


  // ============================================================================
  // ICON - Sanitized iconUrl handling
  // ============================================================================

  _showIcon() {
    this._hideIcon();
    
    const icon = document.createElement('button');
    icon.className = 'it-icon';
    icon.setAttribute('aria-label', 'Translate selection');
    icon.title = 'Translate selection';
    
    // SECURITY: Use DOM APIs instead of innerHTML for iconUrl
    if (this.iconUrl) {
      const img = document.createElement('img');
      // Sanitize URL - only allow http, https, data, and chrome-extension protocols
      if (this._isValidIconUrl(this.iconUrl)) {
        img.setAttribute('src', this.iconUrl);
        img.setAttribute('alt', 'Translate');
        icon.appendChild(img);
      } else {
        // Fallback to default SVG if URL is invalid
        this._appendDefaultIcon(icon);
      }
    } else {
      this._appendDefaultIcon(icon);
    }
    
    const clickHandler = (e) => {
      e.stopPropagation();
      this._hideIcon();
      this._showPanel();
    };
    
    icon.addEventListener('click', clickHandler);
    // Track listener for cleanup
    this._panelListeners.push({ element: icon, type: 'click', handler: clickHandler });
    
    const pos = this._calculateIconPosition(this.selectionRect);
    icon.style.left = `${pos.left}px`;
    icon.style.top = `${pos.top}px`;
    
    this.iconElement = icon;
    this.shadowRoot.appendChild(icon);
  }

  /**
   * Validate icon URL to prevent XSS
   */
  _isValidIconUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return ['http:', 'https:', 'data:', 'chrome-extension:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  /**
   * Append default SVG icon using DOM APIs (no innerHTML)
   */
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
  // PANEL - With retry button and proper cleanup
  // ============================================================================

  _showPanel() {
    this._hidePanel();
    this.isTranslating = false;
    
    // Check text length limit
    const isTextTruncated = this.selectedText.length > InlineTranslator.MAX_TEXT_LENGTH;
    const displayText = isTextTruncated 
      ? this.selectedText.substring(0, InlineTranslator.MAX_TEXT_LENGTH) 
      : this.selectedText;
    
    const panel = document.createElement('div');
    panel.className = 'it-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Translation panel');
    
    // Build panel using DOM APIs for security
    this._buildPanelContent(panel, displayText, isTextTruncated);
    
    // Position panel (use responsive width based on screen size)
    const pos = this._calculatePanelPosition(this.selectionRect, this._getPanelWidth(), 320);
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;
    
    this.panelElement = panel;
    this.shadowRoot.appendChild(panel);
    
    // Set initial focus for accessibility
    const langSelect = panel.querySelector('.it-lang-select');
    if (langSelect) {
      langSelect.focus();
    }
    
    this._fetchTranslation(panel);
  }

  /**
   * Build panel content using DOM APIs (no innerHTML for dynamic content)
   */
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
    
    // Warning for truncated text
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
      if (lang.code === this.currentLang) {
        option.selected = true;
      }
      langSelect.appendChild(option);
    });
    
    const langChangeHandler = (e) => {
      e.stopPropagation();
      this.currentLang = e.target.value;
      this._fetchTranslation(panel);
    };
    langSelect.addEventListener('change', langChangeHandler);
    this._panelListeners.push({ element: langSelect, type: 'change', handler: langChangeHandler });
    
    body.appendChild(langSelect);
    
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
    // Preserve line breaks in source text display
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
    
    const spinner = document.createElement('div');
    spinner.className = 'it-spinner';
    transBox.appendChild(spinner);
    
    const loadingText = document.createElement('span');
    loadingText.textContent = 'Translating...';
    transBox.appendChild(loadingText);
    
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
    
    // Replace button - replaces original text with translation
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
    // Cancel any pending translation request
    this._cancelPendingRequest();
    
    // Clean up panel-specific listeners
    this._cleanupPanelListeners();
    
    if (this.panelElement) {
      this.panelElement.remove();
      this.panelElement = null;
    }
    this.isTranslating = false;
  }

  /**
   * Cancel pending translation request
   */
  _cancelPendingRequest() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Clean up tracked event listeners
   */
  _cleanupPanelListeners() {
    this._panelListeners.forEach(({ element, type, handler }) => {
      element.removeEventListener(type, handler);
    });
    this._panelListeners = [];
  }


  // ============================================================================
  // TRANSLATION - With AbortController and retry functionality
  // ============================================================================

  async _fetchTranslation(panel) {
    // Prevent duplicate requests
    if (this.isTranslating) {
      // Cancel existing request before starting new one
      this._cancelPendingRequest();
    }
    
    const translatedBox = panel.querySelector('.it-translated');
    const copyBtn = panel.querySelector('.it-copy-btn');
    const replaceBtn = panel.querySelector('.it-replace-btn');
    const btnRow = panel.querySelector('.it-btn-row');
    
    if (!translatedBox || !copyBtn || !btnRow) return;
    
    // Remove existing retry button if present
    const existingRetry = btnRow.querySelector('.it-retry-btn');
    if (existingRetry) {
      existingRetry.remove();
    }
    
    // Show loading state
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
    
    if (replaceBtn) {
      replaceBtn.disabled = true;
      replaceBtn.textContent = 'Replace';
      replaceBtn.classList.remove('it-replaced');
    }
    
    // Create new AbortController for this request
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    
    // Truncate text if needed
    const textToTranslate = this.selectedText.length > InlineTranslator.MAX_TEXT_LENGTH
      ? this.selectedText.substring(0, InlineTranslator.MAX_TEXT_LENGTH)
      : this.selectedText;
    
    try {
      const translation = await this.translateFn(textToTranslate, this.currentLang, signal);
      
      // Check if panel was closed during translation
      if (!this.panelElement || signal.aborted) return;
      
      translatedBox.classList.remove('it-loading');
      translatedBox.style.whiteSpace = 'pre-wrap';
      this._setTextWithLineBreaks(translatedBox, translation);
      translatedBox.dataset.translation = translation;
      copyBtn.disabled = false;
      if (replaceBtn) replaceBtn.disabled = false;
    } catch (err) {
      // Ignore abort errors (user changed language or closed panel)
      if (err.name === 'AbortError') return;
      
      // Check if panel was closed during translation
      if (!this.panelElement) return;
      
      translatedBox.classList.remove('it-loading');
      translatedBox.classList.add('it-error');
      translatedBox.textContent = `Error: ${err.message}`;
      
      // Add retry button
      this._addRetryButton(panel, btnRow);
    } finally {
      this.isTranslating = false;
      this.abortController = null;
    }
  }

  /**
   * Add retry button after translation failure
   */
  _addRetryButton(panel, btnRow) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'it-retry-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.setAttribute('aria-label', 'Retry translation');
    
    const retryHandler = () => {
      retryBtn.remove();
      this._fetchTranslation(panel);
    };
    retryBtn.addEventListener('click', retryHandler);
    this._panelListeners.push({ element: retryBtn, type: 'click', handler: retryHandler });
    
    btnRow.appendChild(retryBtn);
    retryBtn.focus();
  }

  /**
   * Copy translation with HTTPS check and fallback
   */
  _copyTranslation(panel) {
    const translatedBox = panel.querySelector('.it-translated');
    const copyBtn = panel.querySelector('.it-copy-btn');
    const translation = translatedBox?.dataset.translation;
    
    if (!translation) return;
    
    // Check if clipboard API is available (requires HTTPS or localhost)
    const isSecureContext = window.isSecureContext;
    
    if (isSecureContext && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(translation)
        .then(() => this._showCopySuccess(copyBtn))
        .catch(() => this._fallbackCopy(translation, copyBtn));
    } else {
      // Fallback for non-secure contexts
      this._fallbackCopy(translation, copyBtn);
    }
  }

  /**
   * Fallback copy method for non-secure contexts
   * Uses ClipboardItem API with blob as alternative approach
   */
  async _fallbackCopy(text, copyBtn) {
    try {
      // Try using ClipboardItem API (works in more contexts)
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const blob = new Blob([text], { type: 'text/plain' });
        const item = new ClipboardItem({ 'text/plain': blob });
        await navigator.clipboard.write([item]);
        this._showCopySuccess(copyBtn);
        return;
      }

      // Final fallback: show text in a prompt for manual copy
      this._showManualCopyDialog(text, copyBtn);
    } catch (err) {
      // Show manual copy dialog as last resort
      this._showManualCopyDialog(text, copyBtn);
    }
  }

  /**
   * Show a dialog for manual text copying when clipboard APIs fail
   */
  _showManualCopyDialog(text, copyBtn) {
    // Create a simple modal with selectable text
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#fff;padding:16px;border-radius:8px;max-width:400px;width:90%;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
    dialog.innerHTML = `
      <p style="margin:0 0 8px;font-size:14px;color:#333;">Select and copy the text below:</p>
      <textarea readonly style="width:100%;height:80px;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:13px;resize:none;">${text.replace(/</g, '&lt;')}</textarea>
      <button style="margin-top:8px;padding:8px 16px;background:#4285f4;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">Close</button>
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
    setTimeout(() => {
      if (copyBtn) copyBtn.textContent = 'Copy';
    }, 2000);
  }

  /**
   * Show copy success feedback
   */
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

  /**
   * Replace the original selected text with the translation
   */
  _replaceWithTranslation(panel) {
    const translatedBox = panel.querySelector('.it-translated');
    const replaceBtn = panel.querySelector('.it-replace-btn');
    const translation = translatedBox?.dataset.translation;
    
    if (!translation || !this.selectionRange) return;
    
    try {
      // Check if the range is still valid and in the document
      if (!this.selectionRange.commonAncestorContainer || 
          !document.contains(this.selectionRange.commonAncestorContainer)) {
        this._showReplaceError(replaceBtn, 'Selection lost');
        return;
      }
      
      // Check if we're in an editable context (input/textarea/contenteditable)
      const container = this.selectionRange.commonAncestorContainer;
      const parentElement = container.nodeType === Node.TEXT_NODE 
        ? container.parentElement 
        : container;
      
      // For contenteditable elements, use InputEvent for modern browsers
      if (parentElement?.isContentEditable) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(this.selectionRange);
        
        // Use insertText via InputEvent (modern approach with undo support)
        const inputEvent = new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: translation,
          bubbles: true,
          cancelable: true
        });
        
        // If beforeinput is supported and not cancelled, manually insert
        if (!parentElement.dispatchEvent(inputEvent)) {
          // Event was cancelled, do nothing
          return;
        }
        
        // Delete selected content and insert translation
        this.selectionRange.deleteContents();
        const textNode = document.createTextNode(translation);
        this.selectionRange.insertNode(textNode);
        
        // Dispatch input event for consistency
        parentElement.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText',
          data: translation,
          bubbles: true
        }));
      } else {
        // Check if selection spans multiple block elements
        const isMultiBlock = this._isMultiBlockSelection(this.selectionRange);
        
        if (isMultiBlock) {
          // For multi-block selections, replace text in each text node proportionally
          this._replaceMultiBlockSelection(translation);
        } else {
          // For single block/inline selections, use simple replacement
          this._replaceSingleSelection(translation);
        }
        
        // Clear the selection
        window.getSelection()?.removeAllRanges();
      }
      
      // Show success feedback
      this._showReplaceSuccess(replaceBtn);
      
      // Close the panel after a short delay
      setTimeout(() => this._hidePanel(), 800);
      
    } catch (err) {
      console.error('[InlineTranslator] Replace error:', err);
      this._showReplaceError(replaceBtn, 'Replace failed');
    }
  }

  /**
   * Check if selection spans multiple block-level elements
   */
  _isMultiBlockSelection(range) {
    const container = range.commonAncestorContainer;
    
    // If the container is a text node, it's single block
    if (container.nodeType === Node.TEXT_NODE) {
      return false;
    }
    
    // Check if start and end are in different block elements
    const startBlock = this._getBlockParent(range.startContainer);
    const endBlock = this._getBlockParent(range.endContainer);
    
    return startBlock !== endBlock;
  }

  /**
   * Get the nearest block-level parent element
   */
  _getBlockParent(node) {
    const blockTags = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'ARTICLE', 'SECTION']);
    let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    
    while (current && current !== document.body) {
      if (blockTags.has(current.tagName)) {
        return current;
      }
      current = current.parentElement;
    }
    return document.body;
  }

  /**
   * Replace text in a single block/inline selection
   */
  _replaceSingleSelection(translation) {
    const wrapper = document.createElement('span');
    wrapper.className = 'pt-inline-replaced';
    wrapper.style.whiteSpace = 'pre-wrap';
    wrapper.dataset.ptOriginal = this.selectedText;
    wrapper.title = 'Click to revert to original';
    
    // Preserve line breaks by converting \n to <br>
    this._setTextWithLineBreaks(wrapper, translation);
    
    // Delete the selected content and insert the translation
    this.selectionRange.deleteContents();
    this.selectionRange.insertNode(wrapper);
  }
  
  /**
   * Set text content while preserving line breaks
   */
  _setTextWithLineBreaks(element, text) {
    element.innerHTML = '';
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) {
        element.appendChild(document.createElement('br'));
      }
      if (line) {
        element.appendChild(document.createTextNode(line));
      }
    });
  }

  /**
   * Replace text across multiple block elements while preserving structure
   * Puts full translation in first text node, clears others
   */
  _replaceMultiBlockSelection(translation) {
    // Collect all text nodes in the selection
    const textNodes = this._getTextNodesInRange(this.selectionRange);
    
    if (textNodes.length === 0) return;
    
    // Handle the first text node - put the full translation here
    const firstNode = textNodes[0];
    const startOffset = firstNode.node === this.selectionRange.startContainer 
      ? this.selectionRange.startOffset 
      : 0;
    
    // Create wrapper for the translation
    const wrapper = document.createElement('span');
    wrapper.className = 'pt-inline-replaced';
    wrapper.style.whiteSpace = 'pre-wrap';
    wrapper.dataset.ptOriginal = this.selectedText;
    wrapper.title = 'Click to revert to original';
    
    // Preserve line breaks
    this._setTextWithLineBreaks(wrapper, translation);
    
    // Split the first text node and insert wrapper
    const beforeText = firstNode.node.textContent.substring(0, startOffset);
    
    // Process nodes in reverse order (to avoid index shifting issues)
    for (let i = textNodes.length - 1; i >= 0; i--) {
      const { node, isPartial } = textNodes[i];
      
      if (i === 0) {
        // First node: keep text before selection, add translation wrapper
        const parent = node.parentNode;
        if (!parent) continue;
        
        if (beforeText) {
          const beforeNode = document.createTextNode(beforeText);
          parent.insertBefore(beforeNode, node);
        }
        parent.insertBefore(wrapper, node);
        
        // Remove the original text node
        if (node === this.selectionRange.startContainer && node === this.selectionRange.endContainer) {
          // Selection is within single text node but crosses elements (shouldn't happen here)
          const afterText = node.textContent.substring(this.selectionRange.endOffset);
          if (afterText) {
            const afterNode = document.createTextNode(afterText);
            parent.insertBefore(afterNode, node);
          }
        }
        parent.removeChild(node);
      } else if (i === textNodes.length - 1) {
        // Last node: keep text after selection, remove selected part
        const endOffset = node === this.selectionRange.endContainer 
          ? this.selectionRange.endOffset 
          : node.textContent.length;
        const afterText = node.textContent.substring(endOffset);
        
        if (afterText) {
          node.textContent = afterText;
        } else {
          node.parentNode?.removeChild(node);
        }
      } else {
        // Middle nodes: remove entirely
        node.parentNode?.removeChild(node);
      }
    }
  }

  /**
   * Get all text nodes within a range
   */
  _getTextNodesInRange(range) {
    const textNodes = [];
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // Check if this text node is within the range
          const nodeRange = document.createRange();
          nodeRange.selectNodeContents(node);
          
          // Check if ranges intersect
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

  /**
   * Show replace success feedback
   */
  _showReplaceSuccess(replaceBtn) {
    if (!replaceBtn) return;
    replaceBtn.textContent = 'Replaced!';
    replaceBtn.classList.add('it-replaced');
    replaceBtn.disabled = true;
  }

  /**
   * Show replace error feedback
   */
  _showReplaceError(replaceBtn, message) {
    if (!replaceBtn) return;
    replaceBtn.textContent = message;
    setTimeout(() => {
      if (replaceBtn) {
        replaceBtn.textContent = 'Replace';
      }
    }, 1500);
  }

  // ============================================================================
  // POSITIONING - Improved multi-line support
  // ============================================================================

  /**
   * Get bounding rect for multi-line selections
   * Uses getClientRects() for better accuracy across multiple lines
   */
  _getMultiLineRect(range) {
    const rects = range.getClientRects();
    
    if (rects.length === 0) {
      return range.getBoundingClientRect();
    }
    
    if (rects.length === 1) {
      return rects[0];
    }
    
    // For multi-line selections, calculate encompassing rect
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    
    for (const rect of rects) {
      if (rect.width === 0 && rect.height === 0) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    
    // Return a DOMRect-like object
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      x: left,
      y: top
    };
  }

  _calculateIconPosition(rect) {
    const iconSize = 24;
    const gap = 8;
    const padding = 10;
    
    // Position icon to the right of selection end
    let left = rect.right + gap;
    let top = rect.top + (rect.height - iconSize) / 2;
    
    // If no room on right, try left of selection
    if (left + iconSize > window.innerWidth - padding) {
      left = rect.left - iconSize - gap;
    }
    
    // If still no room, position above selection center
    if (left < padding) {
      left = rect.left + rect.width / 2 - iconSize / 2;
      top = rect.top - iconSize - gap;
    }
    
    // Clamp to viewport
    left = Math.max(padding, Math.min(left, window.innerWidth - iconSize - padding));
    top = Math.max(padding, Math.min(top, window.innerHeight - iconSize - padding));
    
    return { left, top };
  }

  /**
   * Get responsive panel width based on screen size
   */
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
    
    // Responsive width calculation
    const actualPanelWidth = Math.min(panelWidth, viewW - 30);
    
    // Max bounds to ensure panel is always fully visible
    const maxLeft = viewW - actualPanelWidth - padding;
    const maxTop = viewH - panelHeight - padding;
    
    // Center horizontally relative to selection
    let left = rect.left + rect.width / 2 - actualPanelWidth / 2;
    left = Math.max(padding, Math.min(left, maxLeft));
    
    // Vertical: prefer above selection, fallback to below, then top of viewport
    const spaceAbove = rect.top - padding - gap;
    const spaceBelow = viewH - rect.bottom - padding - gap;
    
    let top;
    if (spaceAbove >= panelHeight) {
      top = rect.top - panelHeight - gap; // Above selection
    } else if (spaceBelow >= panelHeight) {
      top = rect.bottom + gap; // Below selection
    } else {
      top = padding; // Top of viewport
    }
    
    // Final clamp to ensure fully visible
    top = Math.max(padding, Math.min(top, maxTop));
    
    return { left, top };
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  /**
   * Debounce utility for scroll handler
   */
  _debounce(fn, delay) {
    let timeoutId;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
  }
}

// Export for use in content.js
if (typeof window !== 'undefined') {
  window.InlineTranslator = InlineTranslator;
}
