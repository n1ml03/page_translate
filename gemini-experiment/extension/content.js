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
      
      // Pause mutation observer if active to prevent re-triggering translation on restored nodes
      if (window.pageTranslatorObserver) window.pageTranslatorObserver.disconnect();

      // Clean up dead references and switch content
      this.translatedElements = this.translatedElements.filter(element => {
        const state = this.elementStates.get(element);
        if (!state) return false;

        if (state.type === 'TEXT') {
            // Check if wrapper is in DOM
            if (document.contains(element) && element.parentNode) {
                // Replace wrapper with original node(s)
                // For text, it's usually just one text node
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
      // Re-enable observer (captured in global var or accessible scope)
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
             // For text, we need to find the original node and replace it back with wrapper
             const originalNode = state.originalNodes[0];
             if (document.contains(originalNode) && originalNode.parentNode) {
                 originalNode.parentNode.replaceChild(element, originalNode);
                 element.textContent = state.translatedText; // Ensure text is correct
                 element.classList.add('pt-translated-text');
             } else if (document.contains(element)) {
                 // Already there?
             } else {
                 return false; // Lost reference
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

  // Right-click bypass
  function enableRightClick() {
    document.oncontextmenu = null;
    if (document.body) document.body.oncontextmenu = null;
    if (document.documentElement) document.documentElement.oncontextmenu = null;

    const blockedEvents = ['contextmenu', 'dragstart', 'selectstart', 'copy', 'cut', 'paste'];
    blockedEvents.forEach(event => document.addEventListener(event, e => e.stopPropagation(), true));

    const origAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (blockedEvents.includes(type)) return;
      return origAddEventListener.call(this, type, listener, options);
    };

    document.addEventListener('mousedown', e => { if (e.button === 2) e.stopPropagation(); }, true);

    const style = document.createElement('style');
    style.textContent = '* { -webkit-user-select: text !important; user-select: text !important; }';
    (document.head || document.documentElement).appendChild(style);
  }

  enableRightClick();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enableRightClick);

  // Configuration
  const EXCLUDED_TAGS = ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'IFRAME', 'SVG', 'FOOTER'];
  const INLINE_TAGS = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'SPAN', 'A', 'FONT', 'SMALL', 'BIG', 'SUB', 'SUP', 'BR', 'IMG', 'CODE']);
  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'DD', 'DT', 'CAPTION', 'BLOCKQUOTE', 'FIGCAPTION', 'ARTICLE', 'SECTION', 'HEADER', 'ASIDE', 'NAV', 'MAIN', 'ADDRESS']);
  const STATUS_ID = 'page-translator-status';
  const TOOLTIP_ID = 'page-translator-tooltip';
  const CONCURRENCY = 2, CACHE_MAX_SIZE = 500, MUTATION_DEBOUNCE_MS = 300;
  const MAX_BATCH_ITEMS = 100, MAX_BATCH_CHARS = 5000;

  const LANG_CODE_MAP = {
    'ja': 'Japanese', 'en': 'English', 'zh-CN': 'Chinese (Simplified)',
    'zh-TW': 'Chinese (Traditional)', 'ko': 'Korean', 'vi': 'Vietnamese'
  };
  const LANG_NAME_TO_CODE = Object.fromEntries(Object.entries(LANG_CODE_MAP).map(([k, v]) => [v, k]));

  const processedNodes = new WeakSet();
  const translationCache = new Map();
  let pendingMutationNodes = [], mutationDebounceTimer = null;

  // Translation indicator styles
  function injectTranslationStyles() {
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

  // Tooltip management
  let tooltipElement = null, currentHoveredElement = null, hideTooltipTimer = null, isHoveringTooltip = false;
  const COPY_ICON = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
  const CHECK_ICON = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

  function createTooltip() {
    if (tooltipElement) return tooltipElement;
    tooltipElement = document.createElement('div');
    tooltipElement.id = TOOLTIP_ID;
    tooltipElement.addEventListener('mouseenter', () => { isHoveringTooltip = true; clearHideTimer(); });
    tooltipElement.addEventListener('mouseleave', () => { isHoveringTooltip = false; scheduleHideTooltip(); });
    document.body.appendChild(tooltipElement);
    return tooltipElement;
  }

  function clearHideTimer() { if (hideTooltipTimer) { clearTimeout(hideTooltipTimer); hideTooltipTimer = null; } }
  function scheduleHideTooltip(delay = 150) {
    clearHideTimer();
    hideTooltipTimer = setTimeout(() => { if (!isHoveringTooltip) hideTooltip(); }, delay);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function showTooltip(element, originalText) {
    const tooltip = createTooltip();
    tooltip.innerHTML = `<div class="pt-tooltip-header"><span class="pt-tooltip-label">Original</span><button class="pt-copy-btn" title="Copy">${COPY_ICON}</button></div><span class="pt-tooltip-text">${escapeHtml(originalText)}</span>`;

    const copyBtn = tooltip.querySelector('.pt-copy-btn');
    copyBtn.onclick = e => {
      e.stopPropagation();
      navigator.clipboard.writeText(originalText).then(() => {
        copyBtn.innerHTML = CHECK_ICON;
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.innerHTML = COPY_ICON; copyBtn.classList.remove('copied'); }, 1500);
      });
    };

    const rect = element.getBoundingClientRect();
    let top = rect.top - 10, left = rect.left + rect.width / 2;
    tooltip.style.visibility = 'hidden';
    tooltip.classList.add('visible');

    requestAnimationFrame(() => {
      const tooltipRect = tooltip.getBoundingClientRect();
      top = (top - tooltipRect.height < 10) ? rect.bottom + 10 : top - tooltipRect.height;
      left = Math.max(10, Math.min(left - tooltipRect.width / 2, window.innerWidth - tooltipRect.width - 10));
      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;
      tooltip.style.visibility = 'visible';
    });
  }

  function hideTooltip() {
    if (tooltipElement) tooltipElement.classList.remove('visible');
    currentHoveredElement = null;
    isHoveringTooltip = false;
    clearHideTimer();
  }

  function setupTooltipListeners() {
    document.addEventListener('mouseover', e => {
      if (isHoveringTooltip) return;
      const target = e.target.closest('.pt-translated, .pt-translated-block');
      if (target && target !== currentHoveredElement) {
        clearHideTimer();
        currentHoveredElement = target;
        if (target.dataset.ptOriginal) showTooltip(target, target.dataset.ptOriginal);
      }
    });

    document.addEventListener('mouseout', e => {
      if (isHoveringTooltip) return;
      const target = e.target.closest('.pt-translated, .pt-translated-block');
      const tooltip = document.getElementById(TOOLTIP_ID);
      if (tooltip && (tooltip.contains(e.relatedTarget) || e.relatedTarget === tooltip)) return;
      if (target && !target.contains(e.relatedTarget)) scheduleHideTooltip(2000);
    });

    document.addEventListener('scroll', () => { clearHideTimer(); hideTooltip(); }, true);
  }

  // Cache
  const getCacheKey = text => text.trim().toLowerCase();
  const getCached = text => translationCache.get(getCacheKey(text));
  function setCache(original, translated) {
    if (translationCache.size >= CACHE_MAX_SIZE) translationCache.delete(translationCache.keys().next().value);
    translationCache.set(getCacheKey(original), translated);
  }

  // Status indicator
  function createStatusIndicator() {
    if (document.getElementById(STATUS_ID)) return;
    const indicator = document.createElement('div');
    indicator.id = STATUS_ID;
    indicator.style.cssText = 'position:fixed;top:20px;right:20px;background:linear-gradient(135deg,#4285f4,#34a853);color:white;padding:12px 20px;border-radius:24px;font-family:"Google Sans",-apple-system,sans-serif;font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(66,133,244,0.4);z-index:2147483647;display:flex;align-items:center;gap:10px;transition:opacity 0.3s;';
    indicator.innerHTML = '<div style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.8s linear infinite;"></div><span class="status-text">Initializing...</span>';
    const style = document.createElement('style');
    style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
    document.body.appendChild(indicator);
  }

  function updateStatus(current, total) {
    const el = document.getElementById(STATUS_ID);
    if (el) el.querySelector('.status-text').textContent = `Translating ${current}/${total}...`;
  }

  function showComplete(success, message) {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    
    if (success) {
      // On success, just remove the indicator immediately without showing a message
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    } else {
      // On error, show the error message
      const spinner = el.querySelector('div[style*="animation"]');
      if (spinner) {
        spinner.style.animation = 'none';
        spinner.style.border = 'none';
        spinner.textContent = '✗';
        spinner.style.fontSize = '16px';
      }
      
      el.querySelector('.status-text').textContent = message;
      el.style.background = 'linear-gradient(135deg,#ea4335,#fbbc05)';
      
      setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
      }, 4000);
    }
  }

  // Tag abstraction
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
    processedNodes.add(element);
    element.querySelectorAll('*').forEach(child => processedNodes.add(child));
  }

  // Semantic clustering
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
      if (EXCLUDED_TAGS.includes(cur.tagName)) {
        excludedCache.set(parent, true);
        return true;
      }
      cur = cur.parentElement;
    }
    excludedCache.set(parent, false);
    return false;
  }

  function shouldCluster(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (BLOCK_TAGS.has(element.tagName) && !isExcluded(element) && !isInFooter(element)) {
      let hasText = false, hasBlockChildren = false;
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) hasText = true;
        if (child.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(child.tagName)) hasBlockChildren = true;
      }
      return hasText && !hasBlockChildren;
    }
    return false;
  }

  function extractNodes(root = document.documentElement) {
    const nodes = [];

    function process(element) {
      if (processedNodes.has(element) || isExcluded(element) || isInFooter(element)) return;

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

  // DOM update
  function updateDOM(info, translation) {
    if (!translation) return;
    
    if (info.type === 'TEXT') {
      // Wrap text node in a span so we can track and toggle it
      try {
        const originalText = info.node.textContent;
        const parent = info.node.parentNode;
        if (!parent) return;
        
        // Create a wrapper span for the text node
        const wrapper = document.createElement('span');
        wrapper.className = 'pt-translated-text';
        wrapper.textContent = translation;
        wrapper.dataset.ptOriginal = originalText;
        
        // Store in TranslationStateManager for toggle functionality
        TranslationStateManager.store(
          wrapper,
          [info.node],   // originalNodes
          originalText,
          null,          // translatedHTML (not generic for text)
          translation,
          'TEXT'
        );
        
        // Replace text node with wrapper
        parent.replaceChild(wrapper, info.node);
      } catch {}
      return;
    }

    const restoredHTML = tagAbstractor.restore(translation, info.mapping);
    
    try {
      // Store the state before modifying DOM
      const originalNodes = Array.from(info.element.childNodes);
      const originalHTML = info.originalHTML;
      const temp = document.createElement('div');
      temp.innerHTML = originalHTML;
      const originalText = temp.textContent.trim();
      
      const tempTrans = document.createElement('div');
      tempTrans.innerHTML = restoredHTML;
      const translatedText = tempTrans.textContent.trim();
      
      // Store in TranslationStateManager for toggle functionality
      TranslationStateManager.store(
        info.element,
        originalNodes,
        originalText,
        restoredHTML,
        translatedText,
        'BLOCK'
      );
      
      // Update DOM
      info.element.innerHTML = restoredHTML;
      info.element.classList.add('pt-translated-block');
      info.element.dataset.ptOriginal = originalText;
      info.element.dataset.ptOriginalHtml = originalHTML;
    } catch {}
  }

  // Batch processing
  function translateBatchStreaming(texts, onTranslation, options = {}) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'translate-stream' });
      port.onMessage.addListener(msg => {
        if (msg.type === 'translation') onTranslation(msg.index, msg.translation);
        else if (msg.type === 'done') { port.disconnect(); resolve(); }
        else if (msg.type === 'error') { port.disconnect(); reject(new Error(msg.error)); }
      });
      port.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      });
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
      if (currentBatch.length >= MAX_BATCH_ITEMS || (currentBatchChars + text.length > MAX_BATCH_CHARS && currentBatch.length > 0)) {
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

    createStatusIndicator();
    let errors = 0, count = 0;
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
          translateBatchStreaming(batchInfo.texts, (idx, trans) => {
            const orig = batchInfo.texts[idx];
            if (orig) {
              setCache(orig, trans);
              textToNodes.get(orig)?.forEach(nodeInfo => updateDOM(nodeInfo, trans));
            }
            count++;
            updateStatus(count, total);
          }, { useMasking: batchInfo.useMasking }).catch(() => errors++)
        );
      }
      await Promise.all(promises);
    }

    showComplete(errors === 0, errors === 0 ? 'Translation complete!' : `Done with ${errors} error(s)`);
  }

  // Mutation observer
  function isOwnElement(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.id === TOOLTIP_ID || node.id === STATUS_ID || node.id === TOGGLE_ID || node.id === 'page-translator-styles' || node.id === 'inline-translator-host') return true;
      if (node.classList?.contains('pt-translated') || node.classList?.contains('pt-translated-block') || node.classList?.contains('pt-translated-text')) return true;
    }
    return node.parentElement?.id === TOOLTIP_ID || node.parentElement?.id === STATUS_ID || node.parentElement?.id === TOGGLE_ID || node.parentElement?.id === 'inline-translator-host';
  }

  function observeMutations() {
    if (window.pageTranslatorObserver) window.pageTranslatorObserver.disconnect();
    window.pageTranslatorObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (isOwnElement(node)) continue;
          if (node.nodeType === Node.ELEMENT_NODE) pendingMutationNodes.push(...extractNodes(node));
        }
      }
      if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = setTimeout(() => {
        if (pendingMutationNodes.length) {
          const toProcess = pendingMutationNodes;
          pendingMutationNodes = [];
          processNodes(toProcess);
        }
      }, MUTATION_DEBOUNCE_MS);
    });
    window.pageTranslatorObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Main
  async function translatePage(targetLanguage) {
    // Reset state for fresh translation
    TranslationStateManager.reset();
    hideToggleUI();
    
    injectTranslationStyles();
    setupTooltipListeners();
    
    const nodes = extractNodes(document.body);
    
    if (nodes.length === 0) {
      showComplete(false, 'No content to translate');
      return;
    }
    
    // Store target language
    if (targetLanguage) {
      TranslationStateManager.targetLanguage = targetLanguage;
    }
    
    await processNodes(nodes);
    
    // Mark translation as complete and show toggle UI
    TranslationStateManager.isTranslated = true;
    TranslationStateManager.displayMode = 'translated';
    showToggleUI();
    
    observeMutations();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'translate') {
      translatePage(message.targetLanguage).then(() => sendResponse({ success: true })).catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (message.action === 'getSelectedText') {
      sendResponse({ text: window.getSelection()?.toString().trim() || '' });
      return true;
    }
    // Toggle translation display
    if (message.action === 'toggleTranslation') {
      if (!TranslationStateManager.isTranslated) {
        sendResponse({ success: false, error: 'Page not translated yet' });
        return true;
      }
      const newMode = TranslationStateManager.toggle();
      sendResponse({ success: true, displayMode: newMode });
      return true;
    }
    // Show original text
    if (message.action === 'showOriginal') {
      if (!TranslationStateManager.isTranslated) {
        sendResponse({ success: false, error: 'Page not translated yet' });
        return true;
      }
      TranslationStateManager.showOriginal();
      sendResponse({ success: true, displayMode: 'original' });
      return true;
    }
    // Show translated text
    if (message.action === 'showTranslated') {
      if (!TranslationStateManager.isTranslated) {
        sendResponse({ success: false, error: 'Page not translated yet' });
        return true;
      }
      TranslationStateManager.showTranslated();
      sendResponse({ success: true, displayMode: 'translated' });
      return true;
    }
    // Get translation status
    if (message.action === 'getTranslationStatus') {
      sendResponse({
        success: true,
        ...TranslationStateManager.getStats()
      });
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

  // Inline translator
  let inlineTranslator = null;

  async function loadInlineSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get({ recentLanguages: ['Japanese', 'English', 'Chinese (Simplified)'], textTargetLang: 'English' }, result => {
        const recentCodes = result.recentLanguages.map(name => LANG_NAME_TO_CODE[name] || name).filter(code => code);
        resolve({ recentLanguages: recentCodes, defaultLang: LANG_NAME_TO_CODE[result.textTargetLang] || 'en' });
      });
    });
  }

  async function addToInlineHistory(sourceText, translatedText, targetLangCode) {
    const targetLangName = LANG_CODE_MAP[targetLangCode] || targetLangCode;
    return new Promise(resolve => {
      chrome.storage.local.get({ translationHistory: [] }, result => {
        const entry = {
          id: Date.now(),
          source: sourceText.substring(0, 200),
          translation: translatedText.substring(0, 200),
          targetLang: targetLangName,
          timestamp: new Date().toISOString()
        };
        chrome.storage.local.set({ translationHistory: [entry, ...(result.translationHistory || [])].slice(0, 20) }, resolve);
      });
    });
  }

  async function updateInlineRecentLanguages(langCode) {
    const langName = LANG_CODE_MAP[langCode] || langCode;
    return new Promise(resolve => {
      chrome.storage.local.get({ recentLanguages: [] }, result => {
        const recent = [langName, ...result.recentLanguages.filter(l => l !== langName)].slice(0, 4);
        chrome.storage.local.set({ recentLanguages: recent }, () => {
          if (inlineTranslator) inlineTranslator.updateRecentLanguages(recent.map(name => LANG_NAME_TO_CODE[name] || name));
          resolve(recent);
        });
      });
    });
  }

  async function initInlineTranslator() {
    if (typeof InlineTranslator === 'undefined') return;

    // Check if inline icon is enabled
    const { inlineIconEnabled } = await new Promise(resolve => 
      chrome.storage.local.get({ inlineIconEnabled: true }, resolve)
    );
    if (!inlineIconEnabled) return;

    const settings = await loadInlineSettings();
    const languages = Object.entries(LANG_CODE_MAP).map(([code, name]) => ({ code, name }));

    inlineTranslator = new InlineTranslator({
      languages,
      recentLanguages: settings.recentLanguages,
      defaultLang: settings.defaultLang,
      iconUrl: chrome.runtime?.getURL ? chrome.runtime.getURL('images/icon16.png') : null,
      onHistoryAdd: addToInlineHistory,
      translateFn: async (text, lang, signal) => {
        await updateInlineRecentLanguages(lang);
        
        return new Promise((resolve, reject) => {
          if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }

          const port = chrome.runtime.connect({ name: 'translate-stream' });
          let result = '', disconnected = false;

          const abortHandler = () => {
            if (!disconnected) { disconnected = true; port.disconnect(); reject(new DOMException('Aborted', 'AbortError')); }
          };
          signal?.addEventListener('abort', abortHandler);

          port.onMessage.addListener(msg => {
            if (disconnected) return;
            if (msg.type === 'translation') result = msg.translation;
            else if (msg.type === 'done') { disconnected = true; signal?.removeEventListener('abort', abortHandler); port.disconnect(); resolve(result); }
            else if (msg.type === 'error') { disconnected = true; signal?.removeEventListener('abort', abortHandler); port.disconnect(); reject(new Error(msg.error)); }
          });

          port.onDisconnect.addListener(() => {
            if (!disconnected) { disconnected = true; signal?.removeEventListener('abort', abortHandler); if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); }
          });

          port.postMessage({ type: 'translate', batch: [text], targetLang: lang, preserveFormat: true });
        });
      }
    });

    inlineTranslator.init();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.recentLanguages && inlineTranslator) {
        inlineTranslator.updateRecentLanguages((changes.recentLanguages.newValue || []).map(name => LANG_NAME_TO_CODE[name] || name));
      }
      // Handle inline icon enable/disable
      if (changes.inlineIconEnabled) {
        if (changes.inlineIconEnabled.newValue === false && inlineTranslator) {
          inlineTranslator.destroy();
          inlineTranslator = null;
        } else if (changes.inlineIconEnabled.newValue === true && !inlineTranslator) {
          initInlineTranslator();
        }
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initInlineTranslator);
  else initInlineTranslator();
})();
