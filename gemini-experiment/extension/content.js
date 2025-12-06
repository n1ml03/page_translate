(function() {
  if (window.pageTranslatorRunning) return;
  window.pageTranslatorRunning = true;

  // ============================================================================
  // RIGHT-CLICK BYPASS - Re-enable context menu on sites that block it
  // ============================================================================

  function enableRightClick() {
    // Override oncontextmenu handlers
    document.oncontextmenu = null;
    if (document.body) document.body.oncontextmenu = null;
    if (document.documentElement) document.documentElement.oncontextmenu = null;

    // Events to unblock
    const blockedEvents = [
      'contextmenu', // Right click
      'dragstart',   // Drag and drop
      'selectstart', // Highlight text
      'copy',        // Copy
      'cut',         // Cut
      'paste'        // Paste
    ];

    blockedEvents.forEach(event => {
      document.addEventListener(event, e => e.stopPropagation(), true);
    });

    // Block future listeners for these events
    const origAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (blockedEvents.includes(type)) return;
      return origAddEventListener.call(this, type, listener, options);
    };

    // Prevent mousedown from blocking right-click
    document.addEventListener('mousedown', e => {
      if (e.button === 2) e.stopPropagation();
    }, true);

    // Re-enable text selection
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
  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'DD', 'DT', 'CAPTION']);
  const STATUS_ID = 'page-translator-status';
  const TOOLTIP_ID = 'page-translator-tooltip';
  const CONCURRENCY = 2, CACHE_MAX_SIZE = 500, MUTATION_DEBOUNCE_MS = 300;
  const MAX_BATCH_ITEMS = 100;
  const MAX_BATCH_CHARS = 5000;

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
    // Styles matching inline-translator.js theme (#4285f4 Google blue, #34a853 Google green)
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
      #page-translator-tooltip .pt-copy-btn:focus { outline: 2px solid white !important; outline-offset: 2px !important; }
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

  function markProcessed(element) {
    processedNodes.add(element);
    if (element.nodeType === Node.ELEMENT_NODE) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL);
      let node;
      while ((node = walker.nextNode())) processedNodes.add(node);
    }
  }

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

        if (BLOCK_TAGS.has(element.tagName) && element.textContent.trim() && /\p{L}/u.test(element.textContent) && hasOnlyInlineContent(element)) {
          const html = element.innerHTML.trim();
          if (html) {
            nodes.push({ type: 'HTML', content: html, originalPlainText: element.textContent.trim(), node: element });
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

  function updateDOM(nodeInfo, translated) {
    if (!translated || (nodeInfo.type === 'TEXT' && !nodeInfo.node.parentNode)) return;

    if (nodeInfo.type === 'HTML') {
      nodeInfo.node.innerHTML = translated;
      nodeInfo.node.classList.add('pt-translated-block');
      nodeInfo.node.dataset.ptOriginal = nodeInfo.originalPlainText || nodeInfo.node.textContent.trim();
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

  function translateBatchStreaming(texts, onTranslation) {
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
      port.postMessage({ type: 'translate', batch: texts });
    });
  }

  async function processNodes(nodes) {
    if (!nodes.length) return;

    // Separate cached vs uncached
    const uncachedNodes = [];
    for (const nodeInfo of nodes) {
      const cached = getCached(nodeInfo.content);
      cached ? updateDOM(nodeInfo, cached) : uncachedNodes.push(nodeInfo);
    }
    if (!uncachedNodes.length) return;

    // Get unique texts and batch them
    const seen = new Set(), uniqueTexts = [];
    for (const n of uncachedNodes) {
      if (!seen.has(n.content)) { seen.add(n.content); uniqueTexts.push(n.content); }
    }

    const batches = [];
    let currentBatch = [];
    let currentBatchChars = 0;

    for (const text of uniqueTexts) {
      if (currentBatch.length >= MAX_BATCH_ITEMS || (currentBatchChars + text.length > MAX_BATCH_CHARS && currentBatch.length > 0)) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchChars = 0;
      }
      currentBatch.push(text);
      currentBatchChars += text.length;
    }
    if (currentBatch.length) batches.push(currentBatch);

    createStatusIndicator();
    let errors = 0, translatedCount = 0;
    const totalTexts = uniqueTexts.length;

    // Map text content to node indices
    const textToNodeIndices = new Map();
    uncachedNodes.forEach((n, idx) => {
      if (!textToNodeIndices.has(n.content)) textToNodeIndices.set(n.content, []);
      textToNodeIndices.get(n.content).push(idx);
    });

    // Process batches with streaming
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx += CONCURRENCY) {
      const batchPromises = [];
      for (let j = 0; j < CONCURRENCY && batchIdx + j < batches.length; j++) {
        const batch = batches[batchIdx + j];
        batchPromises.push(
          translateBatchStreaming(batch, (indexInBatch, translation) => {
            const originalText = batch[indexInBatch];
            if (originalText) {
              setCache(originalText, translation);
              textToNodeIndices.get(originalText)?.forEach(idx => updateDOM(uncachedNodes[idx], translation));
            }
            translatedCount++;
            updateStatus(translatedCount, totalTexts);
          }).catch(err => { errors++; console.error('Translation batch error:', err); })
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

  // Listen for message from popup/background to start translation
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'translate') {
      translatePage().then(() => sendResponse({ success: true })).catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
  });

  // ============================================================================
  // INLINE TRANSLATOR (Selection-based translation)
  // ============================================================================

  function initInlineTranslator() {
    if (typeof InlineTranslator === 'undefined') {
      console.warn('[PageTranslator] InlineTranslator not loaded');
      return;
    }

    const inlineTranslator = new InlineTranslator({
      // Use the same streaming translation API as page translation with abort support
      translateFn: async (text, lang, signal) => {
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

          // Send single text for translation with target language and preserveFormat flag
          port.postMessage({ type: 'translate', batch: [text], targetLang: lang, preserveFormat: true });
        });
      },
      defaultLang: 'en',
      languages: [
        { code: 'ja', name: 'Japanese (日本語)' },
        { code: 'en', name: 'English' },
        { code: 'zh-CN', name: 'Chinese Simplified (简体中文)' },
        { code: 'zh-TW', name: 'Chinese Traditional (繁體中文)' },
        { code: 'ko', name: 'Korean (한국어)' },
        { code: 'vi', name: 'Vietnamese (Tiếng Việt)' },
      ],
      iconUrl: chrome.runtime?.getURL ? chrome.runtime.getURL('images/icon16.png') : null
    });

    inlineTranslator.init();
  }

  // Initialize inline translator when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInlineTranslator);
  } else {
    initInlineTranslator();
  }
})();
