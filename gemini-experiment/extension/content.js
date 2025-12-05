(function() {
  if (window.pageTranslatorRunning) return;
  window.pageTranslatorRunning = true;

  // Configuration
  const EXCLUDED_TAGS = ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'IFRAME', 'SVG'];
  const INLINE_TAGS = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'SPAN', 'A', 'FONT', 'SMALL', 'BIG', 'SUB', 'SUP', 'BR', 'IMG', 'CODE']);
  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'DD', 'DT', 'CAPTION']);
  const STATUS_ID = 'page-translator-status';
  const BATCH_SIZE = 20;
  const CONCURRENCY = 2;
  const CACHE_MAX_SIZE = 500;
  const MUTATION_DEBOUNCE_MS = 300;

  const processedNodes = new WeakSet();
  const translationCache = new Map();
  let pendingMutationNodes = [];
  let mutationDebounceTimer = null;

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

  function deduplicateBatch(nodes) {
    const textToIndices = new Map();
    const uniqueTexts = [];
    
    nodes.forEach((nodeInfo, index) => {
      const text = nodeInfo.content;
      if (!textToIndices.has(text)) {
        textToIndices.set(text, []);
        uniqueTexts.push(text);
      }
      textToIndices.get(text).push(index);
    });
    
    return { uniqueTexts, textToIndices };
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

        if (BLOCK_TAGS.has(element.tagName) && shouldTranslateAsHTML(element)) {
          const html = element.innerHTML.trim();
          if (html) {
            nodes.push({ type: 'HTML', content: html, node: element });
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
      nodeInfo.node.innerHTML = translated;
    } else {
      nodeInfo.node.textContent = nodeInfo.leadingSpace + translated + nodeInfo.trailingSpace;
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

  async function translateBatch(texts, batchIndex) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'translate', batch: texts });
      if (response?.translations) {
        return { success: true, translations: response.translations, batchIndex };
      }
      return { success: false, error: response?.error, batchIndex };
    } catch (error) {
      return { success: false, error: error.message, batchIndex };
    }
  }

  async function processNodes(nodes) {
    if (!nodes.length) return;

    // Separate cached vs uncached
    const uncachedNodes = [];
    nodes.forEach((nodeInfo, index) => {
      const cached = getCached(nodeInfo.content);
      if (cached) {
        updateDOM(nodeInfo, cached);
      } else {
        uncachedNodes.push({ ...nodeInfo, originalIndex: index });
      }
    });

    if (!uncachedNodes.length) return;

    // Deduplicate
    const { uniqueTexts, textToIndices } = deduplicateBatch(uncachedNodes);
    const batches = batchArray(uniqueTexts, BATCH_SIZE);

    createStatusIndicator();

    let errors = 0;
    let completed = 0;
    const allTranslations = [];

    // Process with concurrency
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const promises = [];
      for (let j = 0; j < CONCURRENCY && i + j < batches.length; j++) {
        promises.push(translateBatch(batches[i + j], i + j));
      }

      const results = await Promise.all(promises);
      
      for (const result of results) {
        completed++;
        updateStatus(completed, batches.length);

        if (result.success) {
          const startIdx = result.batchIndex * BATCH_SIZE;
          result.translations.forEach((t, idx) => {
            allTranslations[startIdx + idx] = t;
          });
        } else {
          errors++;
        }
      }
    }

    // Cache and apply
    uniqueTexts.forEach((text, i) => {
      if (allTranslations[i]) setCache(text, allTranslations[i]);
    });

    uncachedNodes.forEach((nodeInfo) => {
      const idx = uniqueTexts.indexOf(nodeInfo.content);
      if (allTranslations[idx]) updateDOM(nodeInfo, allTranslations[idx]);
    });

    showComplete(errors === 0, errors === 0 ? 'Translation complete!' : `Done with ${errors} error(s)`);
  }

  // ============================================================================
  // MUTATION OBSERVER
  // ============================================================================

  function observeMutations() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
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
    await processNodes(extractTextNodes());
    observeMutations();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', translatePage);
  } else {
    translatePage();
  }
})();
