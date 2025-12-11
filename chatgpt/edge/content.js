// Content Script - Handles page translation and inline translation

(function() {
  if (window.pageTranslatorRunning) return;
  window.pageTranslatorRunning = true;

  // ============================================
  // Translation State Manager - Stores original/translated content for toggle
  // ============================================
  const TranslationStateManager = {
    // Map of element -> { originalNodes, originalText, translatedHTML, translatedText, type }
    elementStates: new WeakMap(),
    // Array of translated elements (for iteration since WeakMap can't be iterated)
    translatedElements: [],
    // Current display mode: 'translated' or 'original'
    displayMode: 'translated',
    // Whether page has been translated
    isTranslated: false,
    // Target language used for translation
    targetLanguage: null,

    // Store translation state for an element
    store(element, originalNodes, originalText, translatedHTML, translatedText, type) {
      const state = { originalNodes, originalText, translatedHTML, translatedText, type };
      this.elementStates.set(element, state);
      if (!this.translatedElements.includes(element)) {
        this.translatedElements.push(element);
      }
    },

    // Get state for an element
    get(element) {
      return this.elementStates.get(element);
    },

    // Check if element has stored state
    has(element) {
      return this.elementStates.has(element);
    },

    // Switch all elements to show original text
    showOriginal() {
      if (this.displayMode === 'original') return;
      this.displayMode = 'original';
      
      // Pause mutation observer to prevent re-triggering translation
      if (window.pageTranslatorObserver) window.pageTranslatorObserver.disconnect();

      // Clean up dead references and switch content
      this.translatedElements = this.translatedElements.filter(element => {
        const state = this.elementStates.get(element);
        if (!state) return false;

        if (state.type === 'TEXT') {
          // Check if wrapper is in DOM
          if (document.contains(element) && element.parentNode) {
            // Replace wrapper with original node(s)
            const originalNode = state.originalNodes[0];
            element.parentNode.replaceChild(originalNode, element);
          }
        } else {
          // Block element
          if (document.contains(element)) {
            element.innerHTML = '';
            element.append(...state.originalNodes);
            element.classList.remove('pt-translated-block', 'pt-translated-text');
            element.classList.add('pt-original-shown');
          } else {
            return false;
          }
        }
        return true;
      });
      
      updateToggleUI();
      if (observeMutations) observeMutations();
    },

    // Switch all elements to show translated text
    showTranslated() {
      if (this.displayMode === 'translated') return;
      this.displayMode = 'translated';
      
      if (window.pageTranslatorObserver) window.pageTranslatorObserver.disconnect();

      // Clean up dead references and switch content
      this.translatedElements = this.translatedElements.filter(element => {
        const state = this.elementStates.get(element);
        if (state) {
          if (state.type === 'TEXT') {
            const originalNode = state.originalNodes[0];
            if (document.contains(originalNode) && originalNode.parentNode) {
              originalNode.parentNode.replaceChild(element, originalNode);
              element.textContent = state.translatedText;
              element.classList.add('pt-translated-text');
            } else if (document.contains(element)) {
              // Already there
            } else {
              return false;
            }
          } else {
            // Block element
            if (document.contains(element)) {
              element.innerHTML = state.translatedHTML;
              element.classList.add('pt-translated-block');
              element.classList.remove('pt-original-shown');
            } else {
              return false;
            }
          }
        }
        return true;
      });
      
      updateToggleUI();
      if (observeMutations) observeMutations();
    },

    // Toggle between original and translated
    toggle() {
      if (this.displayMode === 'translated') {
        this.showOriginal();
      } else {
        this.showTranslated();
      }
      return this.displayMode;
    },

    // Reset state (for new translation)
    reset() {
      this.translatedElements = [];
      this.elementStates = new WeakMap();
      this.displayMode = 'translated';
      this.isTranslated = false;
      this.targetLanguage = null;
    },

    // Get statistics
    getStats() {
      const validElements = this.translatedElements.filter(el => document.contains(el));
      return {
        totalElements: validElements.length,
        displayMode: this.displayMode,
        isTranslated: this.isTranslated,
        targetLanguage: this.targetLanguage
      };
    }
  };

  // ============================================
  // Floating Toggle UI
  // ============================================
  const TOGGLE_ID = 'page-translator-toggle';
  let toggleElement = null;

  function createToggleUI() {
    if (document.getElementById(TOGGLE_ID)) return;
    
    toggleElement = document.createElement('div');
    toggleElement.id = TOGGLE_ID;
    toggleElement.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #4285f4, #34a853);
      color: white;
      padding: 10px 16px;
      border-radius: 24px;
      font-family: "Google Sans", -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 4px 16px rgba(66, 133, 244, 0.4);
      z-index: 2147483646;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s ease;
      user-select: none;
    `;
    
    toggleElement.innerHTML = `
      <span class="toggle-text">Show Original</span>
      <span class="toggle-lang" style="opacity: 0.8; font-size: 11px;"></span>
    `;
    
    toggleElement.addEventListener('mouseenter', () => {
      toggleElement.style.transform = 'scale(1.05)';
      toggleElement.style.boxShadow = '0 6px 20px rgba(66, 133, 244, 0.5)';
    });
    
    toggleElement.addEventListener('mouseleave', () => {
      toggleElement.style.transform = 'scale(1)';
      toggleElement.style.boxShadow = '0 4px 16px rgba(66, 133, 244, 0.4)';
    });
    
    toggleElement.addEventListener('click', () => {
      TranslationStateManager.toggle();
    });
    
    document.body.appendChild(toggleElement);
    updateToggleUI();
  }

  function updateToggleUI() {
    const toggle = document.getElementById(TOGGLE_ID);
    if (!toggle) return;
    
    const isShowingTranslated = TranslationStateManager.displayMode === 'translated';
    const textEl = toggle.querySelector('.toggle-text');
    const langEl = toggle.querySelector('.toggle-lang');
    
    if (isShowingTranslated) {
      textEl.textContent = 'Show Original';
      toggle.style.background = 'linear-gradient(135deg, #4285f4, #34a853)';
      if (TranslationStateManager.targetLanguage) {
        langEl.textContent = `(${TranslationStateManager.targetLanguage})`;
      }
    } else {
      textEl.textContent = 'Show Translation';
      toggle.style.background = 'linear-gradient(135deg, #5f6368, #3c4043)';
      langEl.textContent = '(Original)';
    }
  }

  function showToggleUI() {
    if (!TranslationStateManager.isTranslated) return;
    createToggleUI();
    const toggle = document.getElementById(TOGGLE_ID);
    if (toggle) {
      toggle.style.display = 'flex';
      updateToggleUI();
    }
  }

  function hideToggleUI() {
    const toggle = document.getElementById(TOGGLE_ID);
    if (toggle) {
      toggle.style.display = 'none';
    }
  }

  // ============================================================================
  // RIGHT-CLICK BYPASS
  // ============================================================================

  function enableRightClick() {
    document.oncontextmenu = null;
    if (document.body) document.body.oncontextmenu = null;
    if (document.documentElement) document.documentElement.oncontextmenu = null;

    const blocked = ['contextmenu', 'dragstart', 'selectstart', 'copy', 'cut', 'paste'];
    blocked.forEach(e => document.addEventListener(e, ev => ev.stopPropagation(), true));

    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, opts) {
      if (blocked.includes(type)) return;
      return orig.call(this, type, listener, opts);
    };

    document.addEventListener('mousedown', e => { if (e.button === 2) e.stopPropagation(); }, true);

    const style = document.createElement('style');
    style.textContent = '* { -webkit-user-select: text !important; user-select: text !important; }';
    (document.head || document.documentElement).appendChild(style);
  }

  enableRightClick();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enableRightClick);

  // ============================================================================
  // CONFIG
  // ============================================================================

  const EXCLUDED = ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'IFRAME', 'SVG', 'FOOTER'];
  const INLINE = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'SPAN', 'A', 'FONT', 'SMALL', 'BIG', 'SUB', 'SUP', 'BR', 'IMG', 'CODE']);
  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'DD', 'DT', 'CAPTION', 'BLOCKQUOTE', 'FIGCAPTION', 'ARTICLE', 'SECTION', 'HEADER', 'ASIDE', 'NAV', 'MAIN', 'ADDRESS']);
  const STATUS_ID = 'page-translator-status', TOOLTIP_ID = 'page-translator-tooltip';
  const CONCURRENCY = 2, CACHE_MAX = 500, DEBOUNCE_MS = 300, MAX_BATCH = 100, MAX_CHARS = 5000;

  const LANG_CODE_MAP = {
    'ja': 'Japanese', 'en': 'English', 'zh-CN': 'Chinese (Simplified)',
    'zh-TW': 'Chinese (Traditional)', 'ko': 'Korean', 'vi': 'Vietnamese'
  };
  const LANG_NAME_TO_CODE = Object.fromEntries(Object.entries(LANG_CODE_MAP).map(([k, v]) => [v, k]));
  const toLangName = code => LANG_CODE_MAP[code] || code;

  const ERROR_MAP = {
    UNAUTHORIZED: 'Auth failed', FORBIDDEN: 'Access denied', MODEL_NOT_FOUND: 'Model not found',
    RATE_LIMIT: 'Rate limited', TIMEOUT: 'Timeout', CONTEXT_LENGTH_EXCEEDED: 'Text too long',
    BAD_REQUEST: 'Bad request', GATEWAY_ERROR: 'Server unavailable', SERVER_ERROR: 'Server error',
    UNKNOWN_ERROR: 'Unknown error', CONNECTION_ERROR: 'Connection failed', RATE_LIMITED: 'Too many requests',
    LOCKED: 'Account locked', ERROR: 'Error',
    401: 'Auth failed', 403: 'Access denied', 404: 'Not found', 429: 'Rate limited',
    500: 'Server error', 502: 'Bad gateway', 503: 'Unavailable', 504: 'Timeout'
  };

  function parsePageError(msg) {
    if (!msg) return 'Error';
    msg = String(msg);
    for (const [k, v] of Object.entries(ERROR_MAP)) {
      if (msg.includes(k) || msg.toUpperCase().includes(k)) return v;
    }
    const m = msg.match(/(\d{3})/);
    if (m && ERROR_MAP[m[1]]) return ERROR_MAP[m[1]];
    return msg.length > 40 ? msg.substring(0, 40) + '...' : msg;
  }

  const processed = new WeakSet();
  const cache = new Map();
  let pendingNodes = [], debounceTimer = null;

  // ============================================================================
  // TAG ABSTRACTION - Convert HTML tags to placeholders for translation
  // ============================================================================

  class TagAbstraction {
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

  const tagAbstractor = new TagAbstraction();
  window.PageTranslator = { TagAbstraction };

  function markProcessed(element) {
    processed.add(element);
    element.querySelectorAll('*').forEach(child => processed.add(child));
  }

  // ============================================================================
  // STYLES
  // ============================================================================

  function injectStyles() {
    if (document.getElementById('page-translator-styles')) return;
    const style = document.createElement('style');
    style.id = 'page-translator-styles';
    style.textContent = `
      .pt-translated, .pt-translated-block, .pt-translated-text, .pt-inline-replaced { cursor: help !important; }
      .pt-translated:hover, .pt-translated-block:hover, .pt-translated-text:hover { background-color: rgba(66, 133, 244, 0.08) !important; border-radius: 2px !important; }
      .pt-translated-text { display: inline !important; }
      .pt-original-shown { transition: background-color 0.2s ease !important; }
      .pt-inline-replaced { background-color: rgba(52, 168, 83, 0.15) !important; border-radius: 2px !important; cursor: pointer !important; position: relative !important; }
      .pt-inline-replaced:hover { background-color: rgba(52, 168, 83, 0.25) !important; }
      .pt-inline-replaced::after { content: '↩' !important; position: absolute !important; top: -8px !important; right: -8px !important; width: 16px !important; height: 16px !important; background: #f44336 !important; color: white !important; font-size: 10px !important; line-height: 16px !important; text-align: center !important; border-radius: 50% !important; opacity: 0 !important; transform: scale(0.8) !important; transition: opacity 0.15s ease, transform 0.15s ease !important; pointer-events: none !important; }
      .pt-inline-replaced:hover::after { opacity: 1 !important; transform: scale(1) !important; }
      #page-translator-tooltip { position: fixed !important; max-width: 350px !important; min-width: 200px !important; padding: 0 !important; background: #fff !important; color: #333 !important; font-size: 14px !important; line-height: 1.5 !important; border-radius: 8px !important; border: none !important; box-shadow: 0 6px 32px rgba(0, 0, 0, 0.18) !important; z-index: 2147483647 !important; pointer-events: auto !important; opacity: 0; transform: translateY(4px); transition: opacity 0.15s ease, transform 0.15s ease !important; word-wrap: break-word !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important; box-sizing: border-box !important; overflow: hidden !important; }
      #page-translator-tooltip.visible { opacity: 1 !important; transform: translateY(0) !important; }
      #page-translator-tooltip .pt-tooltip-header { display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 8px 12px !important; margin: 0 !important; background: linear-gradient(135deg, #4285f4, #34a853) !important; }
      #page-translator-tooltip .pt-tooltip-label { font-size: 11px !important; font-weight: 600 !important; color: white !important; text-transform: uppercase !important; letter-spacing: 0.5px !important; }
      #page-translator-tooltip .pt-copy-btn { display: flex !important; align-items: center !important; justify-content: center !important; width: 24px !important; height: 24px !important; padding: 0 !important; margin: -4px -6px -4px 8px !important; background: rgba(255, 255, 255, 0.2) !important; border: none !important; border-radius: 50% !important; cursor: pointer !important; color: white !important; transition: background-color 0.15s ease !important; }
      #page-translator-tooltip .pt-copy-btn:hover { background: rgba(255, 255, 255, 0.3) !important; }
      #page-translator-tooltip .pt-copy-btn.copied { background: rgba(255, 255, 255, 0.4) !important; }
      #page-translator-tooltip .pt-copy-btn svg { width: 12px !important; height: 12px !important; fill: currentColor !important; }
      #page-translator-tooltip .pt-tooltip-text { display: block !important; color: #333 !important; padding: 10px 14px !important; }
    `;
    document.head.appendChild(style);
  }

  // ============================================================================
  // TOOLTIP
  // ============================================================================

  let tooltip = null, hoveredEl = null, hideTimer = null, hoveringTooltip = false;
  const COPY_ICON = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
  const CHECK_ICON = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

  function createTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.id = TOOLTIP_ID;
    tooltip.addEventListener('mouseenter', () => { hoveringTooltip = true; clearTimeout(hideTimer); });
    tooltip.addEventListener('mouseleave', () => { hoveringTooltip = false; scheduleHide(); });
    document.body.appendChild(tooltip);
    return tooltip;
  }

  const clearHideTimer = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
  const scheduleHide = (delay = 150) => {
    clearHideTimer();
    hideTimer = setTimeout(() => { if (!hoveringTooltip) hideTooltip(); }, delay);
  };

  const escapeHtml = t => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

  function showTooltip(el, original) {
    const t = createTooltip();
    t.innerHTML = `<div class="pt-tooltip-header"><span class="pt-tooltip-label">Original</span><button class="pt-copy-btn" title="Copy">${COPY_ICON}</button></div><span class="pt-tooltip-text">${escapeHtml(original)}</span>`;
    
    const btn = t.querySelector('.pt-copy-btn');
    btn.onclick = e => {
      e.stopPropagation();
      navigator.clipboard.writeText(original).then(() => {
        btn.innerHTML = CHECK_ICON;
        btn.classList.add('copied');
        setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('copied'); }, 1500);
      });
    };

    const rect = el.getBoundingClientRect();
    let top = rect.top - 10, left = rect.left + rect.width / 2;
    t.style.visibility = 'hidden';
    t.classList.add('visible');

    requestAnimationFrame(() => {
      const tr = t.getBoundingClientRect();
      top = (top - tr.height < 10) ? rect.bottom + 10 : top - tr.height;
      left = Math.max(10, Math.min(left - tr.width / 2, window.innerWidth - tr.width - 10));
      t.style.top = `${top}px`;
      t.style.left = `${left}px`;
      t.style.visibility = 'visible';
    });
  }

  function hideTooltip() {
    if (tooltip) tooltip.classList.remove('visible');
    hoveredEl = null;
    hoveringTooltip = false;
    clearHideTimer();
  }

  function setupTooltip() {
    document.addEventListener('mouseover', e => {
      if (hoveringTooltip) return;
      const target = e.target.closest('.pt-translated, .pt-translated-block');
      if (target && target !== hoveredEl) {
        clearHideTimer();
        hoveredEl = target;
        if (target.dataset.ptOriginal) showTooltip(target, target.dataset.ptOriginal);
      }
    });

    document.addEventListener('mouseout', e => {
      if (hoveringTooltip) return;
      const target = e.target.closest('.pt-translated, .pt-translated-block');
      const t = document.getElementById(TOOLTIP_ID);
      if (t && (t.contains(e.relatedTarget) || e.relatedTarget === t)) return;
      if (target && !target.contains(e.relatedTarget)) scheduleHide(2000);
    });

    document.addEventListener('scroll', () => { clearHideTimer(); hideTooltip(); }, true);
  }

  // ============================================================================
  // CACHE
  // ============================================================================

  const cacheKey = t => t.trim().toLowerCase();
  const getCached = t => cache.get(cacheKey(t));
  function setCache(orig, trans) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(cacheKey(orig), trans);
  }

  // ============================================================================
  // STATUS
  // ============================================================================

  let isTranslating = false;

  function createStatus() {
    if (document.getElementById(STATUS_ID)) return;
    isTranslating = true;
    chrome.storage.local.set({ pageTranslationInProgress: true, pageTranslationStartTime: Date.now() });
    const el = document.createElement('div');
    el.id = STATUS_ID;
    el.style.cssText = 'position:fixed;top:20px;right:20px;background:linear-gradient(135deg,#4285f4,#34a853);color:white;padding:12px 20px;border-radius:24px;font-family:"Google Sans",-apple-system,sans-serif;font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(66,133,244,0.4);z-index:2147483647;display:flex;align-items:center;gap:10px;transition:opacity 0.3s;';
    el.innerHTML = '<div style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.8s linear infinite;"></div><span class="status-text">Initializing...</span>';
    const style = document.createElement('style');
    style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
    document.body.appendChild(el);
  }

  const updateStatus = (cur, total) => { 
    const el = document.getElementById(STATUS_ID); 
    if (el) el.querySelector('.status-text').textContent = `Translating ${cur}/${total}...`; 
  };

  function showComplete(success, msg, errorDetails = null) {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    
    if (success) {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
      isTranslating = false;
      chrome.storage.local.set({ pageTranslationInProgress: false });
    } else {
      const spinner = el.querySelector('div[style*="animation"]');
      if (spinner) {
        spinner.style.animation = 'none';
        spinner.style.border = 'none';
        spinner.textContent = '✗';
        spinner.style.fontSize = '16px';
      }
      
      let displayMsg = msg || 'Failed';
      if (errorDetails) displayMsg = parsePageError(errorDetails);
      el.querySelector('.status-text').textContent = displayMsg;
      el.style.background = 'linear-gradient(135deg,#ea4335,#fbbc05)';
      
      setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
        isTranslating = false;
        chrome.storage.local.set({ pageTranslationInProgress: false });
      }, 4000);
    }
  }

  // ============================================================================
  // DOM EXTRACTION
  // ============================================================================

  const footerCache = new WeakMap(), excludedCache = new WeakMap();

  function isInFooter(node) {
    let parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!parent) return false;
    if (footerCache.has(parent)) return footerCache.get(parent);
    let cur = parent;
    while (cur) {
      if (cur.tagName === 'FOOTER' || cur.id === 'footer' || cur.getAttribute?.('role') === 'contentinfo' || cur.classList?.contains('footer')) {
        footerCache.set(parent, true);
        return true;
      }
      cur = cur.parentElement;
    }
    footerCache.set(parent, false);
    return false;
  }

  function isExcluded(node) {
    let parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!parent) return false;
    if (excludedCache.has(parent)) return excludedCache.get(parent);
    let cur = parent;
    while (cur) {
      if (EXCLUDED.includes(cur.tagName)) { excludedCache.set(parent, true); return true; }
      cur = cur.parentElement;
    }
    excludedCache.set(parent, false);
    return false;
  }

  function shouldCluster(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (BLOCK.has(element.tagName) && !isExcluded(element) && !isInFooter(element)) {
      let hasText = false, hasBlockChildren = false;
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) hasText = true;
        if (child.nodeType === Node.ELEMENT_NODE && BLOCK.has(child.tagName)) hasBlockChildren = true;
      }
      return hasText && !hasBlockChildren;
    }
    return false;
  }

  function extractNodes(root = document.documentElement) {
    const nodes = [];

    function process(element) {
      if (processed.has(element) || isExcluded(element) || isInFooter(element)) return;

      if (shouldCluster(element)) {
        const originalHTML = element.innerHTML;
        const plainText = element.textContent.trim();
        
        if (plainText && /\p{L}/u.test(plainText)) {
          const { text, mapping } = tagAbstractor.abstractSmart(originalHTML);
          nodes.push({ type: 'CLUSTER', element, originalHTML, abstractedText: text, mapping });
          markProcessed(element);
          return;
        }
      }
      
      for (const child of element.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) process(child);
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim() && /\p{L}/u.test(child.textContent)) {
          nodes.push({ type: 'TEXT', content: child.textContent, node: child });
        }
      }
    }
    process(root);
    return nodes;
  }

  // ============================================================================
  // DOM UPDATE
  // ============================================================================

  function updateDOM(info, translation) {
    if (!translation) return;
    
    if (info.type === 'TEXT') {
      try {
        const originalText = info.node.textContent;
        const parent = info.node.parentNode;
        if (!parent) return;
        
        const wrapper = document.createElement('span');
        wrapper.className = 'pt-translated-text';
        wrapper.textContent = translation;
        wrapper.dataset.ptOriginal = originalText;
        
        TranslationStateManager.store(wrapper, [info.node], originalText, null, translation, 'TEXT');
        parent.replaceChild(wrapper, info.node);
      } catch {}
      return;
    }

    const restoredHTML = tagAbstractor.restore(translation, info.mapping);
    
    try {
      const originalNodes = Array.from(info.element.childNodes);
      const originalHTML = info.originalHTML;
      const temp = document.createElement('div');
      temp.innerHTML = originalHTML;
      const originalText = temp.textContent.trim();
      
      const tempTrans = document.createElement('div');
      tempTrans.innerHTML = restoredHTML;
      const translatedText = tempTrans.textContent.trim();
      
      TranslationStateManager.store(info.element, originalNodes, originalText, restoredHTML, translatedText, 'BLOCK');
      
      info.element.innerHTML = restoredHTML;
      info.element.classList.add('pt-translated-block');
      info.element.dataset.ptOriginal = originalText;
      info.element.dataset.ptOriginalHtml = originalHTML;
    } catch {}
  }

  // ============================================================================
  // BATCH PROCESSING
  // ============================================================================

  function translateBatch(texts, onTrans, options = {}) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'translate-stream' });
      port.onMessage.addListener(msg => {
        if (msg.type === 'translation') onTrans(msg.index, msg.translation);
        else if (msg.type === 'done') { port.disconnect(); resolve(); }
        else if (msg.type === 'error') { port.disconnect(); reject(new Error(msg.error)); }
      });
      port.onDisconnect.addListener(() => { if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); });
      port.postMessage({ type: 'translate', batch: texts, useMasking: options.useMasking || false });
    });
  }

  async function processNodes(nodes) {
    if (!nodes.length) return;

    const uncached = [];
    let cachedCount = 0;
    for (const info of nodes) {
      const key = info.type === 'CLUSTER' ? info.abstractedText : info.content;
      const cached = getCached(key);
      if (cached) {
        updateDOM(info, cached);
        cachedCount++;
      } else {
        uncached.push(info);
      }
    }
    
    if (!uncached.length) return;

    const seen = new Set(), uniqueItems = [];
    const maskedTexts = new Set();
    
    for (const n of uncached) {
      const key = n.type === 'CLUSTER' ? n.abstractedText : n.content;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueItems.push(key);
        if (n.type === 'CLUSTER') maskedTexts.add(key);
      }
    }

    const batches = [];
    let currentBatch = [], currentBatchChars = 0, currentBatchHasMasked = false;

    for (const text of uniqueItems) {
      if (currentBatch.length >= MAX_BATCH || (currentBatchChars + text.length > MAX_CHARS && currentBatch.length > 0)) {
        batches.push({ texts: currentBatch, useMasking: currentBatchHasMasked });
        currentBatch = [];
        currentBatchChars = 0;
        currentBatchHasMasked = false;
      }
      currentBatch.push(text);
      currentBatchChars += text.length;
      if (maskedTexts.has(text)) currentBatchHasMasked = true;
    }
    if (currentBatch.length) batches.push({ texts: currentBatch, useMasking: currentBatchHasMasked });

    createStatus();
    let errors = 0, count = 0, lastError = null;
    const total = uniqueItems.length;

    const textToNodes = new Map();
    uncached.forEach(n => {
      const key = n.type === 'CLUSTER' ? n.abstractedText : n.content;
      if (!textToNodes.has(key)) textToNodes.set(key, []);
      textToNodes.get(key).push(n);
    });

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const promises = [];
      for (let j = 0; j < CONCURRENCY && i + j < batches.length; j++) {
        const batchInfo = batches[i + j];
        promises.push(
          translateBatch(batchInfo.texts, (idx, trans) => {
            const orig = batchInfo.texts[idx];
            if (orig) {
              setCache(orig, trans);
              textToNodes.get(orig)?.forEach(nodeInfo => updateDOM(nodeInfo, trans));
            }
            count++;
            updateStatus(count, total);
          }, { useMasking: batchInfo.useMasking }).catch(e => { 
            errors++; 
            lastError = e.message || String(e);
          })
        );
      }
      await Promise.all(promises);
    }

    if (errors === 0) {
      showComplete(true, 'Translation complete!');
    } else if (count === 0) {
      showComplete(false, null, lastError);
    } else {
      showComplete(false, `${count}/${total} translated`, lastError);
    }
  }

  // ============================================================================
  // MUTATION OBSERVER
  // ============================================================================

  function isOwnEl(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if ([TOOLTIP_ID, STATUS_ID, TOGGLE_ID, 'page-translator-styles', 'inline-translator-host'].includes(node.id)) return true;
      if (node.classList?.contains('pt-translated') || node.classList?.contains('pt-translated-block') || node.classList?.contains('pt-translated-text')) return true;
    }
    return node.parentElement?.id === TOOLTIP_ID || node.parentElement?.id === STATUS_ID || node.parentElement?.id === TOGGLE_ID || node.parentElement?.id === 'inline-translator-host';
  }

  function observeMutations() {
    if (window.pageTranslatorObserver) window.pageTranslatorObserver.disconnect();
    window.pageTranslatorObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (isOwnEl(node)) continue;
          if (node.nodeType === Node.ELEMENT_NODE) pendingNodes.push(...extractNodes(node));
        }
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (pendingNodes.length) {
          const toProcess = pendingNodes;
          pendingNodes = [];
          processNodes(toProcess);
        }
      }, DEBOUNCE_MS);
    });
    window.pageTranslatorObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ============================================================================
  // MAIN
  // ============================================================================

  async function translatePage(targetLanguage) {
    TranslationStateManager.reset();
    hideToggleUI();
    
    injectStyles();
    setupTooltip();
    
    const nodes = extractNodes(document.body);
    
    if (nodes.length === 0) {
      showComplete(false, 'No content to translate');
      return;
    }
    
    if (targetLanguage) {
      TranslationStateManager.targetLanguage = targetLanguage;
    }
    
    await processNodes(nodes);
    
    TranslationStateManager.isTranslated = true;
    TranslationStateManager.displayMode = 'translated';
    showToggleUI();
    
    observeMutations();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'translate') {
      translatePage(msg.targetLanguage).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.action === 'getSelectedText') {
      sendResponse({ text: window.getSelection()?.toString().trim() || '' });
      return true;
    }
    if (msg.action === 'toggleTranslation') {
      if (!TranslationStateManager.isTranslated) {
        sendResponse({ success: false, error: 'Page not translated yet' });
        return true;
      }
      const newMode = TranslationStateManager.toggle();
      sendResponse({ success: true, displayMode: newMode });
      return true;
    }
    if (msg.action === 'showOriginal') {
      if (!TranslationStateManager.isTranslated) {
        sendResponse({ success: false, error: 'Page not translated yet' });
        return true;
      }
      TranslationStateManager.showOriginal();
      sendResponse({ success: true, displayMode: 'original' });
      return true;
    }
    if (msg.action === 'showTranslated') {
      if (!TranslationStateManager.isTranslated) {
        sendResponse({ success: false, error: 'Page not translated yet' });
        return true;
      }
      TranslationStateManager.showTranslated();
      sendResponse({ success: true, displayMode: 'translated' });
      return true;
    }
    if (msg.action === 'getTranslationStatus') {
      sendResponse({ success: true, ...TranslationStateManager.getStats() });
      return true;
    }
  });

  // Copy event listener
  document.addEventListener('copy', () => {
    setTimeout(() => {
      const text = window.getSelection()?.toString().trim();
      if (text) chrome.storage.local.set({ lastCopiedText: text, lastCopiedTimestamp: Date.now() });
    }, 10);
  });

  // ============================================================================
  // INLINE TRANSLATOR
  // ============================================================================

  let inlineTranslator = null;

  async function loadInlineSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get({ recentLanguages: ['Japanese', 'English', 'Vietnamese'], textTargetLang: 'English' }, result => {
        const recentLangs = result.recentLanguages.map(n => toLangName(n)).filter(c => c);
        const defaultLang = toLangName(result.textTargetLang);
        resolve({ recentLanguages: recentLangs, defaultLang });
      });
    });
  }

  async function addToHistory(src, trans, langCode) {
    const langName = toLangName(langCode);
    return new Promise(resolve => {
      chrome.storage.local.get({ translationHistory: [] }, result => {
        const history = [{ id: Date.now(), source: src.substring(0, 200), translation: trans.substring(0, 200), targetLang: langName, timestamp: new Date().toISOString() }, ...(result.translationHistory || [])].slice(0, 20);
        chrome.storage.local.set({ translationHistory: history }, resolve);
      });
    });
  }

  async function updateRecentLangs(langCode) {
    const langName = toLangName(langCode);
    return new Promise(resolve => {
      chrome.storage.local.get({ recentLanguages: [] }, result => {
        let recent = [langName, ...result.recentLanguages.filter(l => l !== langName)].slice(0, 4);
        chrome.storage.local.set({ recentLanguages: recent }, () => {
          if (inlineTranslator) inlineTranslator.updateRecentLanguages(recent);
          resolve(recent);
        });
      });
    });
  }

  async function initInline() {
    if (typeof InlineTranslator === 'undefined') return;
    
    const { inlineIconEnabled } = await new Promise(resolve => 
      chrome.storage.local.get({ inlineIconEnabled: true }, resolve)
    );
    if (!inlineIconEnabled) return;
    
    injectStyles();
    setupTooltip();
    
    const settings = await loadInlineSettings();

    inlineTranslator = new InlineTranslator({
      translateFn: async (text, lang, signal) => {
        await updateRecentLangs(lang);
        return new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
          const port = chrome.runtime.connect({ name: 'translate-stream' });
          let result = '', disconnected = false;
          const abort = () => { if (!disconnected) { disconnected = true; port.disconnect(); reject(new DOMException('Aborted', 'AbortError')); } };
          signal?.addEventListener('abort', abort);
          port.onMessage.addListener(msg => {
            if (disconnected) return;
            if (msg.type === 'translation') result = msg.translation;
            else if (msg.type === 'done') { disconnected = true; signal?.removeEventListener('abort', abort); port.disconnect(); resolve(result); }
            else if (msg.type === 'error') { disconnected = true; signal?.removeEventListener('abort', abort); port.disconnect(); reject(new Error(msg.error)); }
          });
          port.onDisconnect.addListener(() => { if (!disconnected) { disconnected = true; signal?.removeEventListener('abort', abort); if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); } });
          port.postMessage({ type: 'translate', batch: [text], targetLang: lang, preserveFormat: true });
        });
      },
      defaultLang: settings.defaultLang,
      recentLanguages: settings.recentLanguages,
      languages: [
        { code: 'Japanese', name: 'Japanese' },
        { code: 'English', name: 'English' },
        { code: 'Chinese (Simplified)', name: 'Chinese Simplified' },
        { code: 'Chinese (Traditional)', name: 'Chinese Traditional' },
        { code: 'Korean', name: 'Korean' },
        { code: 'Vietnamese', name: 'Vietnamese' },
      ],
      iconUrl: chrome.runtime?.getURL ? chrome.runtime.getURL('images/icon16.png') : null,
      onHistoryAdd: addToHistory
    });

    inlineTranslator.init();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.recentLanguages && inlineTranslator) {
        const langs = (changes.recentLanguages.newValue || []).map(n => toLangName(n));
        inlineTranslator.updateRecentLanguages(langs);
      }
      if (changes.inlineIconEnabled) {
        if (changes.inlineIconEnabled.newValue === false && inlineTranslator) {
          inlineTranslator.destroy();
          inlineTranslator = null;
        } else if (changes.inlineIconEnabled.newValue === true && !inlineTranslator) {
          initInline();
        }
      }
    });
  }

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', initInline) : initInline();
})();
