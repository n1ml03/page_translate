(function() {
  if (window.pageTranslatorRunning) return;
  window.pageTranslatorRunning = true;

  // ============================================================================
  // RIGHT-CLICK BYPASS - Re-enable context menu on sites that block it
  // ============================================================================

  function enableRightClick() {
    document.oncontextmenu = null;
    if (document.body) document.body.oncontextmenu = null;
    if (document.documentElement) document.documentElement.oncontextmenu = null;

    const blockedEvents = ['contextmenu', 'dragstart', 'selectstart', 'copy', 'cut', 'paste'];

    blockedEvents.forEach(event => {
      document.addEventListener(event, e => e.stopPropagation(), true);
    });

    const origAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (blockedEvents.includes(type)) return;
      return origAddEventListener.call(this, type, listener, options);
    };

    document.addEventListener('mousedown', e => {
      if (e.button === 2) e.stopPropagation();
    }, true);

    const style = document.createElement('style');
    style.textContent = '* { -webkit-user-select: text !important; user-select: text !important; }';
    (document.head || document.documentElement).appendChild(style);
  }

  enableRightClick();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enableRightClick);
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  const EXCLUDED_TAGS = ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'IFRAME', 'SVG', 'FOOTER'];
  const INLINE_TAGS = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'SPAN', 'A', 'FONT', 'SMALL', 'BIG', 'SUB', 'SUP', 'BR', 'IMG', 'CODE']);
  // Block-level tags that can be Atomic Blocks (contain only text and inline elements)
  // Includes table cells, list items, definition list items, and captions per Requirements 1.1, 3.3
  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'DD', 'DT', 'CAPTION', 'BLOCKQUOTE', 'FIGCAPTION', 'ARTICLE', 'SECTION', 'HEADER', 'ASIDE', 'NAV', 'MAIN', 'ADDRESS']);
  const STATUS_ID = 'page-translator-status';
  const TOOLTIP_ID = 'page-translator-tooltip';
  const CONCURRENCY = 2, CACHE_MAX_SIZE = 500, MUTATION_DEBOUNCE_MS = 300;
  const MAX_BATCH_ITEMS = 100;
  const MAX_BATCH_CHARS = 5000;


  // Language code mapping (inline translator uses short codes, popup uses full names)
  const LANG_CODE_MAP = {
    'ja': 'Japanese',
    'en': 'English',
    'zh-CN': 'Chinese (Simplified)',
    'zh-TW': 'Chinese (Traditional)',
    'ko': 'Korean',
    'vi': 'Vietnamese'
  };

  const LANG_NAME_TO_CODE = Object.fromEntries(
    Object.entries(LANG_CODE_MAP).map(([k, v]) => [v, k])
  );

  const processedNodes = new WeakSet();
  const translationCache = new Map();
  let pendingMutationNodes = [], mutationDebounceTimer = null;

  // ============================================================================
  // TRANSLATION INDICATOR STYLES
  // ============================================================================

  function injectTranslationStyles() {
    if (document.getElementById('page-translator-styles')) return;
    const style = document.createElement('style');
    style.id = 'page-translator-styles';
    style.textContent = `
      .pt-translated, .pt-translated-block, .pt-inline-replaced { cursor: help !important; }
      .pt-translated:hover, .pt-translated-block:hover { background-color: rgba(66, 133, 244, 0.08) !important; border-radius: 2px !important; }
      .pt-inline-replaced { background-color: rgba(52, 168, 83, 0.15) !important; border-radius: 2px !important; cursor: pointer !important; position: relative !important; }
      .pt-inline-replaced:hover { background-color: rgba(52, 168, 83, 0.25) !important; }
      .pt-inline-replaced::after { content: '↩' !important; position: absolute !important; top: -8px !important; right: -8px !important; width: 16px !important; height: 16px !important; background: #f44336 !important; color: white !important; font-size: 10px !important; line-height: 16px !important; text-align: center !important; border-radius: 50% !important; opacity: 0 !important; transform: scale(0.8) !important; transition: opacity 0.15s ease, transform 0.15s ease !important; pointer-events: none !important; }
      .pt-inline-replaced:hover::after { opacity: 1 !important; transform: scale(1) !important; }
      #page-translator-tooltip { position: fixed !important; max-width: 350px !important; min-width: 200px !important; padding: 0 !important; background: #fff !important; color: #333 !important; font-size: 14px !important; line-height: 1.5 !important; border-radius: 8px !important; border: none !important; box-shadow: 0 6px 32px rgba(0, 0, 0, 0.18) !important; z-index: 2147483647 !important; pointer-events: auto !important; opacity: 0; transform: translateY(4px); transition: opacity 0.15s ease, transform 0.15s ease !important; word-wrap: break-word !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important; box-sizing: border-box !important; overflow: hidden !important; }
      #page-translator-tooltip.visible { opacity: 1 !important; transform: translateY(0) !important; }
      #page-translator-tooltip .pt-tooltip-header { display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 8px 12px !important; margin: 0 !important; background: linear-gradient(135deg, #4285f4, #34a853) !important; border-bottom: none !important; }
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
  // TOOLTIP MANAGEMENT
  // ============================================================================

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

  function clearHideTimer() {
    if (hideTooltipTimer) { clearTimeout(hideTooltipTimer); hideTooltipTimer = null; }
  }

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

  // ============================================================================
  // CACHE
  // ============================================================================

  const getCacheKey = text => text.trim().toLowerCase();
  const getCached = text => translationCache.get(getCacheKey(text));
  function setCache(original, translated) {
    if (translationCache.size >= CACHE_MAX_SIZE) translationCache.delete(translationCache.keys().next().value);
    translationCache.set(getCacheKey(original), translated);
  }

  // ============================================================================
  // STATUS INDICATOR
  // ============================================================================

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
    el.style.background = success ? 'linear-gradient(135deg,#34a853,#0f9d58)' : 'linear-gradient(135deg,#ea4335,#c5221f)';
    const spinner = el.querySelector('div');
    if (spinner) spinner.style.display = 'none';
    el.querySelector('.status-text').textContent = message || (success ? 'Done!' : 'Failed');
    setTimeout(removeStatus, 3000);
  }

  function removeStatus() {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }


  // ============================================================================
  // DOM EXTRACTION
  // ============================================================================

  // Import TagManager for HTML tag masking (loaded via manifest.json)
  // TagManager is expected to be available globally from tag-manager.js

  function isInFooter(node) {
    let parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (parent) {
      if (parent.tagName === 'FOOTER') return true;
      if (parent.getAttribute?.('role') === 'contentinfo') return true;
      if (parent.classList?.contains('footer') || parent.classList?.contains('site-footer') || parent.classList?.contains('page-footer')) return true;
      if (parent.id === 'footer') return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function isInExcludedTag(node) {
    let parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (parent) {
      if (EXCLUDED_TAGS.includes(parent.tagName)) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  /**
   * Checks if an element contains only text nodes and inline elements (no nested block-level children).
   * Used by isAtomicBlock() to determine if an element is suitable for tag masking.
   * @param {Node} node - The DOM node to check
   * @returns {boolean} True if the node contains only inline content
   */
  function hasOnlyInlineContent(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (BLOCK_TAGS.has(tag) || EXCLUDED_TAGS.includes(tag)) return false;
        if (INLINE_TAGS.has(tag) && !hasOnlyInlineContent(child)) return false;
        if (!INLINE_TAGS.has(tag)) return false;
      }
    }
    return true;
  }

  /**
   * AtomicBlockDetector - Identifies block-level elements suitable for translation with tag masking.
   * An Atomic Block is a block-level element that contains only text and inline elements,
   * with no nested block-level children.
   * 
   * Requirements: 1.1, 3.3
   */
  const AtomicBlockDetector = {
    /**
     * Checks if an element is an Atomic Block suitable for tag masking.
     * An element is an Atomic Block if:
     * - It is a block-level element (P, DIV, TD, TH, LI, H1-H6, DD, DT, CAPTION, etc.)
     * - It contains only text nodes and inline elements
     * - It has no nested block-level children
     * - It has meaningful text content
     * 
     * @param {Element} element - The DOM element to check
     * @returns {boolean} True if the element is an Atomic Block
     * 
     * Requirements: 1.1, 3.3
     */
    isAtomicBlock(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) {
        return false;
      }

      const tagName = element.tagName;

      // Must be a block-level tag
      if (!BLOCK_TAGS.has(tagName)) {
        return false;
      }

      // Must have text content with at least one letter
      const textContent = element.textContent.trim();
      if (!textContent || !/\p{L}/u.test(textContent)) {
        return false;
      }

      // Must contain only inline content (no nested block-level elements)
      if (!hasOnlyInlineContent(element)) {
        return false;
      }

      return true;
    },

    /**
     * Extracts all Atomic Blocks from a root element.
     * @param {Element} root - The root element to search within
     * @returns {Array<{element: Element, innerHTML: string, originalText: string}>}
     */
    extractAtomicBlocks(root) {
      const blocks = [];
      
      function traverse(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
        if (EXCLUDED_TAGS.includes(element.tagName)) return;
        
        if (AtomicBlockDetector.isAtomicBlock(element)) {
          blocks.push({
            element,
            innerHTML: element.innerHTML.trim(),
            originalText: element.textContent.trim()
          });
          return; // Don't traverse children of atomic blocks
        }
        
        for (const child of element.children) {
          traverse(child);
        }
      }
      
      traverse(root);
      return blocks;
    }
  };

  function markProcessed(element) {
    processedNodes.add(element);
    if (element.nodeType === Node.ELEMENT_NODE) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL);
      let node;
      while ((node = walker.nextNode())) processedNodes.add(node);
    }
  }

  /**
   * Extracts text nodes and atomic blocks from the DOM for translation.
   * 
   * This function traverses the DOM and identifies:
   * 1. Atomic Blocks - block-level elements with only inline content (processed as HTML)
   * 2. Text nodes - standalone text that needs translation
   * 
   * Requirements 3.1, 3.2: Processes elements regardless of CSS visibility state
   * (including display:none, visibility:hidden) to include accordion panels,
   * tabs, and other dynamically revealed content.
   * 
   * @param {Node} root - The root node to start extraction from
   * @returns {Array<{type: string, content: string, node: Node, ...}>}
   */
  function extractTextNodes(root = document.documentElement) {
    const nodes = [];

    function processTextNode(node) {
      if (processedNodes.has(node)) return;
      if (isInFooter(node)) return;
      const original = node.textContent, trimmed = original.trim();
      if (!trimmed || !/\p{L}/u.test(trimmed)) return;
      const idx = original.indexOf(trimmed);
      nodes.push({ type: 'TEXT', content: trimmed, node, leadingSpace: original.substring(0, idx), trailingSpace: original.substring(idx + trimmed.length) });
      processedNodes.add(node);
    }

    function traverse(element) {
      if (processedNodes.has(element) || isInExcludedTag(element) || isInFooter(element)) return;
      if (element.nodeType === Node.ELEMENT_NODE) {
        if (EXCLUDED_TAGS.includes(element.tagName)) return;
        if (element.id === TOOLTIP_ID || element.id === STATUS_ID) return;
        if (element.classList?.contains('pt-translated') || element.classList?.contains('pt-translated-block')) return;
        if (isInFooter(element)) return;

        // NOTE: Visibility checks intentionally removed per Requirements 3.1, 3.2
        // We process elements regardless of CSS visibility state (display:none, visibility:hidden)
        // to include accordion panels, tabs, and other dynamically revealed content.

        // Use AtomicBlockDetector to identify blocks suitable for tag masking
        if (AtomicBlockDetector.isAtomicBlock(element)) {
          const html = element.innerHTML.trim();
          if (html) {
            // Use TagManager to mask HTML tags with placeholders
            // Requirements 1.2, 6.3: Mask innerHTML before adding to batch
            const plainText = element.textContent.trim();
            
            // Check if TagManager is available (loaded from tag-manager.js)
            if (typeof TagManager !== 'undefined') {
              const { masked, tags } = TagManager.mask(html);
              // Store MaskedContent object with original, masked, tags, and plainText
              nodes.push({
                type: 'HTML',
                content: masked,           // Send masked content to translation
                original: html,            // Original innerHTML for reference
                tags: tags,                // Tag array for restoration
                plainText: plainText,      // Plain text fallback
                originalPlainText: plainText,
                node: element
              });
            } else {
              // Fallback: use original HTML if TagManager not available
              nodes.push({ type: 'HTML', content: html, originalPlainText: plainText, node: element });
            }
            markProcessed(element);
            return;
          }
        }
        for (const child of element.childNodes) traverse(child);
      } else if (element.nodeType === Node.TEXT_NODE) {
        processTextNode(element);
      }
    }

    root.nodeType === Node.TEXT_NODE ? processTextNode(root) : traverse(root);
    return nodes;
  }

  // ============================================================================
  // DOM UPDATE
  // ============================================================================

  /**
   * Updates the DOM with translated content.
   * 
   * For HTML type nodes with tag masking:
   * - Uses TagManager.unmask() to restore placeholders to original tags
   * - Validates placeholders before restoration
   * - Falls back to plain text if validation fails (Requirements 1.7, 1.8)
   * 
   * @param {Object} nodeInfo - Node information from extractTextNodes()
   * @param {string} translated - Translated text (may contain placeholders for HTML nodes)
   */
  function updateDOM(nodeInfo, translated) {
    if (!translated || (nodeInfo.type === 'TEXT' && !nodeInfo.node.parentNode)) return;

    if (nodeInfo.type === 'HTML') {
      let finalContent = translated;
      
      // Check if this node was processed with TagManager (has tags array)
      if (nodeInfo.tags && Array.isArray(nodeInfo.tags) && typeof TagManager !== 'undefined') {
        // Validate placeholders before restoration (Requirements 1.7, 1.8)
        const isValid = TagManager.validatePlaceholders(translated, nodeInfo.tags.length);
        
        if (isValid) {
          // Restore placeholders to original HTML tags
          finalContent = TagManager.unmask(translated, nodeInfo.tags);
        } else {
          // Fallback: strip all tags/placeholders and use plain text
          // This preserves readability when AI returns invalid placeholders
          console.warn('[PageTranslator] Invalid placeholders detected, falling back to plain text');
          finalContent = TagManager.stripToPlainText(translated);
        }
      }
      
      nodeInfo.node.innerHTML = finalContent;
      nodeInfo.node.classList.add('pt-translated-block');
      nodeInfo.node.dataset.ptOriginal = nodeInfo.originalPlainText || nodeInfo.plainText || nodeInfo.node.textContent.trim();
    } else {
      const wrapper = document.createElement('span');
      wrapper.className = 'pt-translated';
      wrapper.dataset.ptOriginal = nodeInfo.content;
      wrapper.textContent = translated;

      const parent = nodeInfo.node.parentNode;
      if (parent) {
        if (nodeInfo.leadingSpace) parent.insertBefore(document.createTextNode(nodeInfo.leadingSpace), nodeInfo.node);
        parent.insertBefore(wrapper, nodeInfo.node);
        if (nodeInfo.trailingSpace) parent.insertBefore(document.createTextNode(nodeInfo.trailingSpace), nodeInfo.node);
        parent.removeChild(nodeInfo.node);
      }
    }
  }

  // ============================================================================
  // BATCH PROCESSING
  // ============================================================================

  /**
   * Sends a batch of texts for translation via streaming.
   * 
   * @param {string[]} texts - Array of texts to translate
   * @param {Function} onTranslation - Callback for each translated item (index, translation)
   * @param {Object} options - Optional settings
   * @param {boolean} options.useMasking - Whether the batch contains masked HTML content
   * @returns {Promise<void>}
   * 
   * Requirements 7.1: Forward masked text batches to server with useMasking flag
   * Requirements 7.2, 7.3: Relay translated items and propagate errors
   */
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
      // Include useMasking flag when batch contains masked HTML content
      port.postMessage({ 
        type: 'translate', 
        batch: texts,
        useMasking: options.useMasking || false
      });
    });
  }

  async function processNodes(nodes) {
    if (!nodes.length) return;

    const uncachedNodes = [];
    for (const nodeInfo of nodes) {
      const cached = getCached(nodeInfo.content);
      cached ? updateDOM(nodeInfo, cached) : uncachedNodes.push(nodeInfo);
    }
    if (!uncachedNodes.length) return;

    const seen = new Set(), uniqueTexts = [];
    // Track which texts come from masked HTML nodes (Requirements 7.1)
    const maskedTexts = new Set();
    for (const n of uncachedNodes) {
      if (!seen.has(n.content)) { 
        seen.add(n.content); 
        uniqueTexts.push(n.content);
        // Mark text as masked if it comes from an HTML node with tags array
        if (n.type === 'HTML' && n.tags && Array.isArray(n.tags) && n.tags.length > 0) {
          maskedTexts.add(n.content);
        }
      }
    }

    const batches = [];
    let currentBatch = [];
    let currentBatchChars = 0;
    let currentBatchHasMasked = false;

    for (const text of uniqueTexts) {
      if (currentBatch.length >= MAX_BATCH_ITEMS || (currentBatchChars + text.length > MAX_BATCH_CHARS && currentBatch.length > 0)) {
        batches.push({ texts: currentBatch, useMasking: currentBatchHasMasked });
        currentBatch = [];
        currentBatchChars = 0;
        currentBatchHasMasked = false;
      }
      currentBatch.push(text);
      currentBatchChars += text.length;
      if (maskedTexts.has(text)) {
        currentBatchHasMasked = true;
      }
    }
    if (currentBatch.length) batches.push({ texts: currentBatch, useMasking: currentBatchHasMasked });

    createStatusIndicator();
    let errors = 0, translatedCount = 0;
    const totalTexts = uniqueTexts.length;

    const textToNodeIndices = new Map();
    uncachedNodes.forEach((n, idx) => {
      if (!textToNodeIndices.has(n.content)) textToNodeIndices.set(n.content, []);
      textToNodeIndices.get(n.content).push(idx);
    });

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx += CONCURRENCY) {
      const batchPromises = [];
      for (let j = 0; j < CONCURRENCY && batchIdx + j < batches.length; j++) {
        const batchInfo = batches[batchIdx + j];
        const batch = batchInfo.texts;
        // Requirements 7.1: Pass useMasking flag when batch contains masked HTML content
        batchPromises.push(
          translateBatchStreaming(batch, (indexInBatch, translation) => {
            const originalText = batch[indexInBatch];
            if (originalText) {
              setCache(originalText, translation);
              textToNodeIndices.get(originalText)?.forEach(idx => updateDOM(uncachedNodes[idx], translation));
            }
            translatedCount++;
            updateStatus(translatedCount, totalTexts);
          }, { useMasking: batchInfo.useMasking }).catch(err => { errors++; console.error('Translation batch error:', err); })
        );
      }
      await Promise.all(batchPromises);
    }

    showComplete(errors === 0, errors === 0 ? 'Translation complete!' : `Done with ${errors} error(s)`);
  }

  // ============================================================================
  // MUTATION OBSERVER
  // ============================================================================

  function isOwnElement(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.id === TOOLTIP_ID || node.id === STATUS_ID || node.id === 'page-translator-styles' || node.id === 'inline-translator-host') return true;
      if (node.classList?.contains('pt-translated') || node.classList?.contains('pt-translated-block')) return true;
    }
    return node.parentElement?.id === TOOLTIP_ID || node.parentElement?.id === STATUS_ID || node.parentElement?.id === 'inline-translator-host';
  }

  function observeMutations() {
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (isOwnElement(node)) continue;
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            pendingMutationNodes.push(...extractTextNodes(node));
          }
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
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ============================================================================
  // MAIN
  // ============================================================================

  async function translatePage() {
    injectTranslationStyles();
    setupTooltipListeners();
    await processNodes(extractTextNodes());
    observeMutations();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'translate') {
      translatePage().then(() => sendResponse({ success: true })).catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (message.action === 'getSelectedText') {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || '';
      sendResponse({ text });
      return true;
    }
  });

  // ============================================================================
  // COPY EVENT LISTENER - Store copied text for popup
  // ============================================================================

  document.addEventListener('copy', () => {
    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (text) {
        // Store the copied text in storage for the popup to access
        chrome.storage.local.set({ 
          lastCopiedText: text,
          lastCopiedTimestamp: Date.now()
        });
      }
    }, 10);
  });


  // ============================================================================
  // INLINE TRANSLATOR (Selection-based translation with settings sync)
  // ============================================================================

  let inlineTranslator = null;

  // Load settings from storage and convert language names to codes
  async function loadInlineSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get({
        recentLanguages: ['Japanese', 'English', 'Chinese (Simplified)'],
        textTargetLang: 'English'
      }, result => {
        // Convert full language names to short codes for inline translator
        const recentCodes = result.recentLanguages
          .map(name => LANG_NAME_TO_CODE[name] || name)
          .filter(code => code);
        const defaultLang = LANG_NAME_TO_CODE[result.textTargetLang] || 'en';
        resolve({ recentLanguages: recentCodes, defaultLang });
      });
    });
  }

  // Add translation to history (synced with popup)
  async function addToInlineHistory(sourceText, translatedText, targetLangCode) {
    const targetLangName = LANG_CODE_MAP[targetLangCode] || targetLangCode;
    
    return new Promise(resolve => {
      chrome.storage.local.get({ translationHistory: [] }, result => {
        const history = result.translationHistory || [];
        
        const entry = {
          id: Date.now(),
          source: sourceText.substring(0, 200),
          translation: translatedText.substring(0, 200),
          targetLang: targetLangName,
          timestamp: new Date().toISOString()
        };
        
        const newHistory = [entry, ...history].slice(0, 20);
        chrome.storage.local.set({ translationHistory: newHistory }, resolve);
      });
    });
  }

  // Update recent languages (synced with popup)
  async function updateInlineRecentLanguages(langCode) {
    const langName = LANG_CODE_MAP[langCode] || langCode;
    
    return new Promise(resolve => {
      chrome.storage.local.get({ recentLanguages: [] }, result => {
        let recent = result.recentLanguages || [];
        recent = [langName, ...recent.filter(l => l !== langName)].slice(0, 4);
        chrome.storage.local.set({ recentLanguages: recent }, () => {
          // Also update inline translator's recent languages
          if (inlineTranslator) {
            const recentCodes = recent.map(name => LANG_NAME_TO_CODE[name] || name);
            inlineTranslator.updateRecentLanguages(recentCodes);
          }
          resolve(recent);
        });
      });
    });
  }

  async function initInlineTranslator() {
    if (typeof InlineTranslator === 'undefined') {
      console.warn('[PageTranslator] InlineTranslator not loaded');
      return;
    }

    // Load synced settings
    const settings = await loadInlineSettings();

    inlineTranslator = new InlineTranslator({
      translateFn: async (text, lang, signal) => {
        // Update recent languages when translating
        await updateInlineRecentLanguages(lang);
        
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }

          const port = chrome.runtime.connect({ name: 'translate-stream' });
          let result = '';
          let disconnected = false;

          const abortHandler = () => {
            if (!disconnected) {
              disconnected = true;
              port.disconnect();
              reject(new DOMException('Aborted', 'AbortError'));
            }
          };
          signal?.addEventListener('abort', abortHandler);

          port.onMessage.addListener(msg => {
            if (disconnected) return;

            if (msg.type === 'translation') {
              result = msg.translation;
            } else if (msg.type === 'done') {
              disconnected = true;
              signal?.removeEventListener('abort', abortHandler);
              port.disconnect();
              resolve(result);
            } else if (msg.type === 'error') {
              disconnected = true;
              signal?.removeEventListener('abort', abortHandler);
              port.disconnect();
              reject(new Error(msg.error));
            }
          });

          port.onDisconnect.addListener(() => {
            if (!disconnected) {
              disconnected = true;
              signal?.removeEventListener('abort', abortHandler);
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              }
            }
          });

          port.postMessage({ type: 'translate', batch: [text], targetLang: lang, preserveFormat: true });
        });
      },
      defaultLang: settings.defaultLang,
      recentLanguages: settings.recentLanguages,
      languages: [
        { code: 'ja', name: 'Japanese', native: '日本語' },
        { code: 'en', name: 'English', native: 'English' },
        { code: 'zh-CN', name: 'Chinese Simplified', native: '简体中文' },
        { code: 'zh-TW', name: 'Chinese Traditional', native: '繁體中文' },
        { code: 'ko', name: 'Korean', native: '한국어' },
        { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
      ],
      iconUrl: chrome.runtime?.getURL ? chrome.runtime.getURL('images/icon16.png') : null,
      onHistoryAdd: addToInlineHistory
    });

    inlineTranslator.init();

    // Listen for storage changes to sync settings
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !inlineTranslator) return;
      
      if (changes.recentLanguages) {
        const recentCodes = (changes.recentLanguages.newValue || [])
          .map(name => LANG_NAME_TO_CODE[name] || name);
        inlineTranslator.updateRecentLanguages(recentCodes);
      }
    });
  }

  // Initialize inline translator when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInlineTranslator);
  } else {
    initInlineTranslator();
  }
})();
