(function() {
  if (window.pageTranslatorRunning) return;
  window.pageTranslatorRunning = true;

  // ============================================================================
  // RIGHT-CLICK BYPASS
  // ============================================================================

  function enableRightClick() {
    document.oncontextmenu = null;
    if (document.body) document.body.oncontextmenu = null;
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
  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'DD', 'DT', 'CAPTION']);
  const STATUS_ID = 'page-translator-status', TOOLTIP_ID = 'page-translator-tooltip';
  const CONCURRENCY = 2, CACHE_MAX = 500, DEBOUNCE_MS = 300, MAX_BATCH = 100, MAX_CHARS = 5000;

  const LANG_MAP = { 'ja': 'Japanese', 'en': 'English', 'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', 'ko': 'Korean', 'vi': 'Vietnamese' };
  const LANG_REVERSE = Object.fromEntries(Object.entries(LANG_MAP).map(([k, v]) => [v, k]));

  const processed = new WeakSet();
  const cache = new Map();
  let pendingNodes = [], debounceTimer = null;

  // ============================================================================
  // STYLES
  // ============================================================================

  function injectStyles() {
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
      #page-translator-tooltip { position: fixed !important; max-width: 350px !important; min-width: 200px !important; padding: 0 !important; background: #fff !important; color: #333 !important; font-size: 14px !important; line-height: 1.5 !important; border-radius: 8px !important; box-shadow: 0 6px 32px rgba(0, 0, 0, 0.18) !important; z-index: 2147483647 !important; opacity: 0; transform: translateY(4px); transition: opacity 0.15s ease, transform 0.15s ease !important; overflow: hidden !important; }
      #page-translator-tooltip.visible { opacity: 1 !important; transform: translateY(0) !important; }
      #page-translator-tooltip .pt-tooltip-header { display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 8px 12px !important; background: linear-gradient(135deg, #4285f4, #34a853) !important; }
      #page-translator-tooltip .pt-tooltip-label { font-size: 11px !important; font-weight: 600 !important; color: white !important; text-transform: uppercase !important; }
      #page-translator-tooltip .pt-copy-btn { width: 24px !important; height: 24px !important; padding: 0 !important; background: rgba(255, 255, 255, 0.2) !important; border: none !important; border-radius: 50% !important; cursor: pointer !important; color: white !important; }
      #page-translator-tooltip .pt-copy-btn:hover { background: rgba(255, 255, 255, 0.3) !important; }
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

  const scheduleHide = (delay = 150) => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!hoveringTooltip) hideTooltip(); }, delay); };
  const escapeHtml = t => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

  function showTooltip(el, original) {
    const t = createTooltip();
    t.innerHTML = `<div class="pt-tooltip-header"><span class="pt-tooltip-label">Original</span><button class="pt-copy-btn" title="Copy">${COPY_ICON}</button></div><span class="pt-tooltip-text">${escapeHtml(original)}</span>`;
    const btn = t.querySelector('.pt-copy-btn');
    btn.onclick = e => {
      e.stopPropagation();
      navigator.clipboard.writeText(original).then(() => {
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => btn.innerHTML = COPY_ICON, 1500);
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
    clearTimeout(hideTimer);
  }

  function setupTooltip() {
    document.addEventListener('mouseover', e => {
      if (hoveringTooltip) return;
      const target = e.target.closest('.pt-translated, .pt-translated-block');
      if (target && target !== hoveredEl) {
        clearTimeout(hideTimer);
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
    document.addEventListener('scroll', hideTooltip, true);
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

  function createStatus() {
    if (document.getElementById(STATUS_ID)) return;
    const el = document.createElement('div');
    el.id = STATUS_ID;
    el.style.cssText = 'position:fixed;top:20px;right:20px;background:linear-gradient(135deg,#4285f4,#34a853);color:white;padding:12px 20px;border-radius:24px;font-family:-apple-system,sans-serif;font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(66,133,244,0.4);z-index:2147483647;display:flex;align-items:center;gap:10px;';
    el.innerHTML = '<div style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.8s linear infinite;"></div><span class="status-text">Initializing...</span>';
    const style = document.createElement('style');
    style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
    document.body.appendChild(el);
  }

  const updateStatus = (cur, total) => { const el = document.getElementById(STATUS_ID); if (el) el.querySelector('.status-text').textContent = `Translating ${cur}/${total}...`; };

  function showComplete(success, msg) {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    el.style.background = success ? 'linear-gradient(135deg,#34a853,#0f9d58)' : 'linear-gradient(135deg,#ea4335,#c5221f)';
    const spinner = el.querySelector('div');
    if (spinner) spinner.style.display = 'none';
    el.querySelector('.status-text').textContent = msg || (success ? 'Done!' : 'Failed');
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

  function hasOnlyInline(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (BLOCK.has(child.tagName) || EXCLUDED.includes(child.tagName)) return false;
        if (INLINE.has(child.tagName) && !hasOnlyInline(child)) return false;
        if (!INLINE.has(child.tagName)) return false;
      }
    }
    return true;
  }

  function markProcessed(el) {
    processed.add(el);
    if (el.nodeType === Node.ELEMENT_NODE) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL);
      let n;
      while ((n = walker.nextNode())) processed.add(n);
    }
  }

  function extractNodes(root = document.documentElement) {
    const nodes = [];

    function processText(node) {
      if (processed.has(node) || isInFooter(node)) return;
      const orig = node.textContent, trimmed = orig.trim();
      if (!trimmed || !/\p{L}/u.test(trimmed)) return;
      const idx = orig.indexOf(trimmed);
      nodes.push({ type: 'TEXT', content: trimmed, node, lead: orig.substring(0, idx), trail: orig.substring(idx + trimmed.length) });
      processed.add(node);
    }

    function traverse(el) {
      if (processed.has(el)) return;
      if (el.nodeType === Node.ELEMENT_NODE) {
        if (EXCLUDED.includes(el.tagName) || el.id === TOOLTIP_ID || el.id === STATUS_ID) return;
        if (el.classList?.contains('pt-translated') || el.classList?.contains('pt-translated-block')) return;
        if (isInFooter(el) || isExcluded(el)) return;
        if (BLOCK.has(el.tagName) && el.textContent.trim() && /\p{L}/u.test(el.textContent) && hasOnlyInline(el)) {
          const html = el.innerHTML.trim();
          if (html) { nodes.push({ type: 'HTML', content: html, plainText: el.textContent.trim(), node: el }); markProcessed(el); return; }
        }
        for (const child of el.childNodes) traverse(child);
      } else if (el.nodeType === Node.TEXT_NODE) {
        processText(el);
      }
    }

    root.nodeType === Node.TEXT_NODE ? processText(root) : traverse(root);
    return nodes;
  }

  // ============================================================================
  // DOM UPDATE
  // ============================================================================

  function updateDOM(info, trans) {
    if (!trans || (info.type === 'TEXT' && !info.node.parentNode)) return;
    if (info.type === 'HTML') {
      info.node.innerHTML = trans;
      info.node.classList.add('pt-translated-block');
      info.node.dataset.ptOriginal = info.plainText || info.node.textContent.trim();
    } else {
      const wrapper = document.createElement('span');
      wrapper.className = 'pt-translated';
      wrapper.dataset.ptOriginal = info.content;
      wrapper.textContent = trans;
      const parent = info.node.parentNode;
      if (parent) {
        if (info.lead) parent.insertBefore(document.createTextNode(info.lead), info.node);
        parent.insertBefore(wrapper, info.node);
        if (info.trail) parent.insertBefore(document.createTextNode(info.trail), info.node);
        parent.removeChild(info.node);
      }
    }
  }

  // ============================================================================
  // BATCH PROCESSING
  // ============================================================================

  function translateBatch(texts, onTrans) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'translate-stream' });
      port.onMessage.addListener(msg => {
        if (msg.type === 'translation') onTrans(msg.index, msg.translation);
        else if (msg.type === 'done') { port.disconnect(); resolve(); }
        else if (msg.type === 'error') { port.disconnect(); reject(new Error(msg.error)); }
      });
      port.onDisconnect.addListener(() => { if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); });
      port.postMessage({ type: 'translate', batch: texts });
    });
  }

  async function processNodes(nodes) {
    if (!nodes.length) return;

    const uncached = [];
    for (const info of nodes) {
      const cached = getCached(info.content);
      cached ? updateDOM(info, cached) : uncached.push(info);
    }
    if (!uncached.length) return;

    const seen = new Set(), unique = [];
    for (const n of uncached) {
      if (!seen.has(n.content)) { seen.add(n.content); unique.push(n.content); }
    }

    const batches = [];
    let batch = [], chars = 0;
    for (const text of unique) {
      if (batch.length >= MAX_BATCH || (chars + text.length > MAX_CHARS && batch.length > 0)) {
        batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(text);
      chars += text.length;
    }
    if (batch.length) batches.push(batch);

    createStatus();
    let errors = 0, count = 0;
    const total = unique.length;

    const textToIdx = new Map();
    uncached.forEach((n, i) => {
      if (!textToIdx.has(n.content)) textToIdx.set(n.content, []);
      textToIdx.get(n.content).push(i);
    });

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const promises = [];
      for (let j = 0; j < CONCURRENCY && i + j < batches.length; j++) {
        const b = batches[i + j];
        promises.push(
          translateBatch(b, (idx, trans) => {
            const orig = b[idx];
            if (orig) {
              setCache(orig, trans);
              textToIdx.get(orig)?.forEach(k => updateDOM(uncached[k], trans));
            }
            count++;
            updateStatus(count, total);
          }).catch(e => { errors++; console.error('Translation error:', e); })
        );
      }
      await Promise.all(promises);
    }

    showComplete(errors === 0, errors === 0 ? 'Translation complete!' : `Done with ${errors} error(s)`);
  }

  // ============================================================================
  // MUTATION OBSERVER
  // ============================================================================

  function isOwnEl(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if ([TOOLTIP_ID, STATUS_ID, 'page-translator-styles', 'inline-translator-host'].includes(node.id)) return true;
      if (node.classList?.contains('pt-translated') || node.classList?.contains('pt-translated-block')) return true;
    }
    return node.parentElement?.id === TOOLTIP_ID || node.parentElement?.id === STATUS_ID || node.parentElement?.id === 'inline-translator-host';
  }

  function observeMutations() {
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (isOwnEl(node)) continue;
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            pendingNodes.push(...extractNodes(node));
          }
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
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ============================================================================
  // MAIN
  // ============================================================================

  async function translatePage() {
    injectStyles();
    setupTooltip();
    await processNodes(extractNodes());
    observeMutations();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'translate') {
      translatePage().then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });

  // ============================================================================
  // INLINE TRANSLATOR
  // ============================================================================

  let inlineTranslator = null;

  async function loadInlineSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get({ recentLanguages: ['Japanese', 'English', 'Vietnamese'], textTargetLang: 'English' }, result => {
        const codes = result.recentLanguages.map(n => LANG_REVERSE[n] || n).filter(c => c);
        const defaultLang = LANG_REVERSE[result.textTargetLang] || 'en';
        resolve({ recentLanguages: codes, defaultLang });
      });
    });
  }

  async function addToHistory(src, trans, langCode) {
    const langName = LANG_MAP[langCode] || langCode;
    return new Promise(resolve => {
      chrome.storage.local.get({ translationHistory: [] }, result => {
        const history = [{ id: Date.now(), source: src.substring(0, 200), translation: trans.substring(0, 200), targetLang: langName, timestamp: new Date().toISOString() }, ...(result.translationHistory || [])].slice(0, 20);
        chrome.storage.local.set({ translationHistory: history }, resolve);
      });
    });
  }

  async function updateRecentLangs(langCode) {
    const langName = LANG_MAP[langCode] || langCode;
    return new Promise(resolve => {
      chrome.storage.local.get({ recentLanguages: [] }, result => {
        let recent = [langName, ...result.recentLanguages.filter(l => l !== langName)].slice(0, 4);
        chrome.storage.local.set({ recentLanguages: recent }, () => {
          if (inlineTranslator) inlineTranslator.updateRecentLanguages(recent.map(n => LANG_REVERSE[n] || n));
          resolve(recent);
        });
      });
    });
  }

  async function initInline() {
    if (typeof InlineTranslator === 'undefined') return;
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
        { code: 'ja', name: 'Japanese', native: '日本語' },
        { code: 'en', name: 'English', native: 'English' },
        { code: 'zh-CN', name: 'Chinese Simplified', native: '简体中文' },
        { code: 'zh-TW', name: 'Chinese Traditional', native: '繁體中文' },
        { code: 'ko', name: 'Korean', native: '한국어' },
        { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
      ],
      iconUrl: chrome.runtime?.getURL ? chrome.runtime.getURL('images/icon16.png') : null,
      onHistoryAdd: addToHistory
    });

    inlineTranslator.init();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !inlineTranslator) return;
      if (changes.recentLanguages) {
        const codes = (changes.recentLanguages.newValue || []).map(n => LANG_REVERSE[n] || n);
        inlineTranslator.updateRecentLanguages(codes);
      }
    });
  }

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', initInline) : initInline();
})();
