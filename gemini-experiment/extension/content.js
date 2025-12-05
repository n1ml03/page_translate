(function() {
  if (window.pageTranslatorRunning) return;
  window.pageTranslatorRunning = true;

  // Configuration
  const EXCLUDED_TAGS = ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'IFRAME', 'SVG'];
  const INLINE_TAGS = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'SPAN', 'A', 'FONT', 'SMALL', 'BIG', 'SUB', 'SUP', 'BR', 'IMG', 'CODE']);
  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'DD', 'DT', 'CAPTION']);
  const STATUS_ID = 'page-translator-status';
  const TOOLTIP_ID = 'page-translator-tooltip';
  const BATCH_SIZE = 20;
  const CONCURRENCY = 2;
  const CACHE_MAX_SIZE = 500;
  const MUTATION_DEBOUNCE_MS = 300;

  const processedNodes = new WeakSet();
  const translationCache = new Map();
  let pendingMutationNodes = [];
  let mutationDebounceTimer = null;

  // ============================================================================
  // TRANSLATION INDICATOR STYLES (inline to avoid conflicts)
  // ============================================================================

  function injectTranslationStyles() {
    if (document.getElementById('page-translator-styles')) return;

    const style = document.createElement('style');
    style.id = 'page-translator-styles';
    style.textContent = `
      .pt-translated,
      .pt-translated-block {
        cursor: help !important;
      }
      .pt-translated:hover,
      .pt-translated-block:hover {
        background-color: rgba(66, 133, 244, 0.08) !important;
        border-radius: 2px !important;
      }
      #page-translator-tooltip {
        position: fixed !important;
        max-width: 350px !important;
        padding: 8px 12px !important;
        background: #ffffff !important;
        color: #333333 !important;
        font-size: 13px !important;
        line-height: 1.4 !important;
        border-radius: 6px !important;
        border: 1px solid #e0e0e0 !important;
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15) !important;
        z-index: 2147483647 !important;
        pointer-events: auto !important;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 0.15s ease, transform 0.15s ease !important;
        word-wrap: break-word !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        box-sizing: border-box !important;
      }
      #page-translator-tooltip.visible {
        opacity: 1 !important;
        transform: translateY(0) !important;
      }
      #page-translator-tooltip .pt-tooltip-header {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        margin-bottom: 4px !important;
        padding-bottom: 4px !important;
        border-bottom: 1px solid #eeeeee !important;
      }
      #page-translator-tooltip .pt-tooltip-label {
        font-size: 10px !important;
        font-weight: 500 !important;
        color: #888888 !important;
        text-transform: uppercase !important;
        letter-spacing: 0.3px !important;
      }
      #page-translator-tooltip .pt-copy-btn {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 18px !important;
        height: 18px !important;
        padding: 0 !important;
        margin: -2px -4px -2px 8px !important;
        background: transparent !important;
        border: none !important;
        border-radius: 4px !important;
        cursor: pointer !important;
        color: #888888 !important;
        transition: color 0.15s ease, background-color 0.15s ease !important;
      }
      #page-translator-tooltip .pt-copy-btn:hover {
        color: #4285f4 !important;
        background-color: rgba(66, 133, 244, 0.1) !important;
      }
      #page-translator-tooltip .pt-copy-btn.copied {
        color: #34a853 !important;
      }
      #page-translator-tooltip .pt-copy-btn svg {
        width: 12px !important;
        height: 12px !important;
        fill: currentColor !important;
      }
      #page-translator-tooltip .pt-tooltip-text {
        display: block !important;
        color: #333333 !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ============================================================================
  // TOOLTIP MANAGEMENT
  // ============================================================================

  let tooltipElement = null;
  let currentHoveredElement = null;
  let hideTooltipTimer = null;
  let isHoveringTooltip = false;

  function createTooltip() {
    if (tooltipElement) return tooltipElement;
    
    tooltipElement = document.createElement('div');
    tooltipElement.id = TOOLTIP_ID;
    
    // Keep tooltip visible when hovering over it
    tooltipElement.addEventListener('mouseenter', () => {
      isHoveringTooltip = true;
      clearHideTimer();
    });
    
    tooltipElement.addEventListener('mouseleave', () => {
      isHoveringTooltip = false;
      scheduleHideTooltip();
    });
    
    document.body.appendChild(tooltipElement);
    return tooltipElement;
  }

  function clearHideTimer() {
    if (hideTooltipTimer) {
      clearTimeout(hideTooltipTimer);
      hideTooltipTimer = null;
    }
  }

  function scheduleHideTooltip(delay = 150) {
    clearHideTimer();
    hideTooltipTimer = setTimeout(() => {
      if (!isHoveringTooltip) {
        hideTooltip();
      }
    }, delay);
  }

  const COPY_ICON_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
  const CHECK_ICON_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

  function showTooltip(element, originalText) {
    const tooltip = createTooltip();
    tooltip.innerHTML = `
      <div class="pt-tooltip-header">
        <span class="pt-tooltip-label">Original</span>
        <button class="pt-copy-btn" title="Copy original text">${COPY_ICON_SVG}</button>
      </div>
      <span class="pt-tooltip-text">${escapeHtml(originalText)}</span>
    `;

    // Setup copy button
    const copyBtn = tooltip.querySelector('.pt-copy-btn');
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(originalText).then(() => {
        copyBtn.innerHTML = CHECK_ICON_SVG;
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerHTML = COPY_ICON_SVG;
          copyBtn.classList.remove('copied');
        }, 1500);
      });
    });

    const rect = element.getBoundingClientRect();

    // Position tooltip above the element by default
    let top = rect.top - 10;
    let left = rect.left + (rect.width / 2);

    // Show tooltip to measure its size
    tooltip.style.visibility = 'hidden';
    tooltip.classList.add('visible');

    requestAnimationFrame(() => {
      const tooltipRect = tooltip.getBoundingClientRect();

      // Adjust if tooltip would go off screen
      if (top - tooltipRect.height < 10) {
        top = rect.bottom + 10;
      } else {
        top = top - tooltipRect.height;
      }

      left = Math.max(10, Math.min(left - tooltipRect.width / 2, window.innerWidth - tooltipRect.width - 10));

      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;
      tooltip.style.visibility = 'visible';
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function hideTooltip() {
    if (tooltipElement) {
      tooltipElement.classList.remove('visible');
    }
    currentHoveredElement = null;
    isHoveringTooltip = false;
    clearHideTimer();
  }

  function setupTooltipListeners() {
    document.addEventListener('mouseover', (e) => {
      // Don't switch target while hovering on tooltip
      if (isHoveringTooltip) return;

      const target = e.target.closest('.pt-translated, .pt-translated-block');
      if (target && target !== currentHoveredElement) {
        clearHideTimer();
        currentHoveredElement = target;
        const originalText = target.dataset.ptOriginal;
        if (originalText) {
          showTooltip(target, originalText);
        }
      }
    });

    document.addEventListener('mouseout', (e) => {
      // Don't hide while hovering on tooltip
      if (isHoveringTooltip) return;

      const target = e.target.closest('.pt-translated, .pt-translated-block');
      const tooltip = document.getElementById(TOOLTIP_ID);
      
      // Don't hide if moving to the tooltip
      if (tooltip && (tooltip.contains(e.relatedTarget) || e.relatedTarget === tooltip)) {
        return;
      }
      
      if (target && !target.contains(e.relatedTarget)) {
        scheduleHideTooltip(4000);
      }
    });

    // Hide tooltip on scroll (immediate)
    document.addEventListener('scroll', () => {
      clearHideTimer();
      hideTooltip();
    }, true);
  }

  // ============================================================================
  // CACHE
  // ============================================================================

  const getCacheKey = (text) => text.trim().toLowerCase();
  const getCached = (text) => translationCache.get(getCacheKey(text));

  function setCache(original, translated) {
    if (translationCache.size >= CACHE_MAX_SIZE) {
      translationCache.delete(translationCache.keys().next().value);
    }
    translationCache.set(getCacheKey(original), translated);
  }

  // ============================================================================
  // DEDUPLICATION
  // ============================================================================

  function getUniqueTexts(nodes) {
    const seen = new Set();
    const uniqueTexts = [];
    for (const nodeInfo of nodes) {
      if (!seen.has(nodeInfo.content)) {
        seen.add(nodeInfo.content);
        uniqueTexts.push(nodeInfo.content);
      }
    }
    return uniqueTexts;
  }

  // ============================================================================
  // STATUS INDICATOR
  // ============================================================================

  function createStatusIndicator() {
    if (document.getElementById(STATUS_ID)) return;

    const indicator = document.createElement('div');
    indicator.id = STATUS_ID;
    indicator.style.cssText = `
      position:fixed;top:20px;right:20px;background:linear-gradient(135deg,#4285f4,#34a853);
      color:white;padding:12px 20px;border-radius:24px;font-family:'Google Sans',-apple-system,sans-serif;
      font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(66,133,244,0.4);z-index:2147483647;
      display:flex;align-items:center;gap:10px;transition:opacity 0.3s;
    `;

    const spinner = document.createElement('div');
    spinner.style.cssText = `
      width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);
      border-top-color:white;border-radius:50%;animation:spin 0.8s linear infinite;
    `;
    indicator.appendChild(spinner);

    const text = document.createElement('span');
    text.className = 'status-text';
    text.textContent = 'Initializing...';
    indicator.appendChild(text);

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

    el.style.background = success
      ? 'linear-gradient(135deg,#34a853,#0f9d58)'
      : 'linear-gradient(135deg,#ea4335,#c5221f)';

    const spinner = el.querySelector('div');
    if (spinner) spinner.style.display = 'none';

    el.querySelector('.status-text').textContent = message || (success ? 'Done!' : 'Failed');
    setTimeout(removeStatus, 3000);
  }

  function removeStatus() {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.parentNode && el.remove(), 300);
  }

  // ============================================================================
  // DOM EXTRACTION
  // ============================================================================

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
        if (INLINE_TAGS.has(tag)) {
          if (!hasOnlyInlineContent(child)) return false;
        } else {
          return false;
        }
      }
    }
    return true;
  }

  function shouldTranslateAsHTML(element) {
    return element.textContent.trim() && hasOnlyInlineContent(element);
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
      const original = node.textContent;
      const trimmed = original.trim();
      if (!trimmed) return;

      const idx = original.indexOf(trimmed);
      nodes.push({
        type: 'TEXT',
        content: trimmed,
        node,
        leadingSpace: original.substring(0, idx),
        trailingSpace: original.substring(idx + trimmed.length)
      });
      processedNodes.add(node);
    }

    function traverse(element) {
      if (processedNodes.has(element) || isInExcludedTag(element)) return;

      if (element.nodeType === Node.ELEMENT_NODE) {
        if (EXCLUDED_TAGS.includes(element.tagName)) return;

        // Skip our own elements
        if (element.id === TOOLTIP_ID || element.id === STATUS_ID) return;
        if (element.classList && (element.classList.contains('pt-translated') || element.classList.contains('pt-translated-block'))) return;

        if (BLOCK_TAGS.has(element.tagName) && shouldTranslateAsHTML(element)) {
          const html = element.innerHTML.trim();
          const plainText = element.textContent.trim();
          if (html) {
            nodes.push({ type: 'HTML', content: html, originalPlainText: plainText, node: element });
            markProcessed(element);
            return;
          }
        }

        for (const child of element.childNodes) traverse(child);
      } else if (element.nodeType === Node.TEXT_NODE) {
        processTextNode(element);
      }
    }

    if (root.nodeType === Node.TEXT_NODE) {
      processTextNode(root);
    } else {
      traverse(root);
    }

    return nodes;
  }

  // ============================================================================
  // DOM UPDATE
  // ============================================================================

  function updateDOM(nodeInfo, translated) {
    if (!translated) return;
    if (nodeInfo.type === 'TEXT' && !nodeInfo.node.parentNode) return;

    if (nodeInfo.type === 'HTML') {
      // For block elements, store plain text (not HTML) for tooltip
      const originalPlainText = nodeInfo.originalPlainText || nodeInfo.node.textContent.trim();
      nodeInfo.node.innerHTML = translated;
      nodeInfo.node.classList.add('pt-translated-block');
      nodeInfo.node.dataset.ptOriginal = originalPlainText;
    } else {
      // For text nodes, wrap in a span with indicator
      const wrapper = document.createElement('span');
      wrapper.className = 'pt-translated';
      wrapper.dataset.ptOriginal = nodeInfo.content;
      wrapper.textContent = translated;

      const parent = nodeInfo.node.parentNode;
      if (parent) {
        // Handle leading/trailing spaces
        if (nodeInfo.leadingSpace) {
          parent.insertBefore(document.createTextNode(nodeInfo.leadingSpace), nodeInfo.node);
        }
        parent.insertBefore(wrapper, nodeInfo.node);
        if (nodeInfo.trailingSpace) {
          parent.insertBefore(document.createTextNode(nodeInfo.trailingSpace), nodeInfo.node);
        }
        parent.removeChild(nodeInfo.node);
      }
    }
  }

  // ============================================================================
  // BATCH PROCESSING
  // ============================================================================

  function batchArray(arr, size) {
    const batches = [];
    for (let i = 0; i < arr.length; i += size) {
      batches.push(arr.slice(i, i + size));
    }
    return batches;
  }

  function translateBatchStreaming(texts, onTranslation) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'translate-stream' });

      port.onMessage.addListener((message) => {
        if (message.type === 'translation') {
          onTranslation(message.index, message.translation);
        } else if (message.type === 'done') {
          port.disconnect();
          resolve();
        } else if (message.type === 'error') {
          port.disconnect();
          reject(new Error(message.error));
        }
      });

      port.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        }
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
      if (cached) {
        updateDOM(nodeInfo, cached);
      } else {
        uncachedNodes.push(nodeInfo);
      }
    }

    if (!uncachedNodes.length) return;

    const uniqueTexts = getUniqueTexts(uncachedNodes);
    const batches = batchArray(uniqueTexts, BATCH_SIZE);

    createStatusIndicator();

    let errors = 0;
    let translatedCount = 0;
    const totalTexts = uniqueTexts.length;

    // Map text content to node indices for batch updates
    const textToNodeIndices = new Map();
    uncachedNodes.forEach((nodeInfo, idx) => {
      if (!textToNodeIndices.has(nodeInfo.content)) {
        textToNodeIndices.set(nodeInfo.content, []);
      }
      textToNodeIndices.get(nodeInfo.content).push(idx);
    });

    // Process batches with streaming
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx += CONCURRENCY) {
      const batchPromises = [];

      for (let j = 0; j < CONCURRENCY && batchIdx + j < batches.length; j++) {
        const batch = batches[batchIdx + j];

        const promise = translateBatchStreaming(batch, (indexInBatch, translation) => {
          const originalText = batch[indexInBatch];

          if (originalText) {
            setCache(originalText, translation);

            // Update all nodes with this text
            const nodeIndices = textToNodeIndices.get(originalText);
            if (nodeIndices) {
              nodeIndices.forEach(idx => updateDOM(uncachedNodes[idx], translation));
            }
          }

          translatedCount++;
          updateStatus(translatedCount, totalTexts);
        }).catch(error => {
          errors++;
          console.error('Translation batch error:', error);
        });

        batchPromises.push(promise);
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
      if (node.id === TOOLTIP_ID || node.id === STATUS_ID || node.id === 'page-translator-styles') return true;
      if (node.classList && (node.classList.contains('pt-translated') || node.classList.contains('pt-translated-block'))) return true;
    }
    if (node.parentElement) {
      if (node.parentElement.id === TOOLTIP_ID || node.parentElement.id === STATUS_ID) return true;
    }
    return false;
  }

  function observeMutations() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          // Skip our own elements (tooltip, status indicator, translated wrappers)
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', translatePage);
  } else {
    translatePage();
  }
})();
