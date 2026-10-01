// ==UserScript==
// @name         GEGI AI Proofreader Bridge
// @namespace    gegi-ai-proofreader
// @version      1.0.4
// @description  Только визуальный мост Freshdesk → GEGI AI Proofreader: gutter, прокрутка и синхронизация. Текст Freshdesk не изменяет.
// @match        https://*.freshdesk.com/a/solutions/articles/*/edit*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @updateURL     https://raw.githubusercontent.com/zvukoper/tpm_gpf_script/main/gegi-proofread.user.js
// @downloadURL   https://raw.githubusercontent.com/zvukoper/tpm_gpf_script/main/gegi-proofread.user.js
// @supportURL    https://github.com/zvukoper/tpm_gpf_script
// @run-at        document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const MEDIATOR = 'http://127.0.0.1:37891';
  const CACHE_PREFIX = 'gegi.freshdesk.sync.';
  const STYLE_ID = 'gegi-proofread-bridge-style';
  const UI_ID = 'gegi-proofread-toolbar';
  const GUTTER_ID = 'gegi-proofread-gutter';
  const STATUS_ID = 'gegi-proofread-status';

  let currentArticleId = '';
  let currentChannel = '';
  let currentEditor = null;
  let currentState = null;
  let lastServerRevision = 0;
  let pollTimer = null;
  let renderFrame = 0;
  let refreshObserver = null;
  let editorObserver = null;
  let actionTimer = null;
  let toolbarRetryTimer = null;
  let proofreaderWindow = null;
  const diagnostic = {
    editor: 'проверяю',
    actions: 'проверяю',
    ui: 'не установлены',
    server: 'проверяю'
  };

  // STRICT FRESHDESK SAFETY INVARIANT:
  // This script never writes to currentEditor. It only reads text/HTML/geometry,
  // creates Range objects for coordinate calculations, and scrolls the existing
  // page. Freshdesk text can be changed only by the user through Freshdesk itself.

  const stateKey = () => CACHE_PREFIX + currentChannel;

  function isEditMode() {
    return /^\/a\/solutions\/articles\/[^/]+\/edit(?:[/?#]|$)/.test(location.pathname);
  }

  function getArticleId() {
    const match = location.pathname.match(/^\/a\/solutions\/articles\/([^/]+)\/edit(?:[/?#]|$)/);
    return match ? match[1] : '';
  }

  function getChannel() {
    return currentArticleId ? 'freshdesk:' + currentArticleId : '';
  }

  function setStatus(message, state = 'info') {
    const panel = document.getElementById(UI_ID);
    const status = panel?.querySelector('.gegi-status');
    if (!status) return;
    panel.dataset.state = state;
    status.textContent = 'GEGI AI Proofreader: ' + message;
  }

  function renderDiagnosticStatus() {
    const warning = diagnostic.actions === 'не найдены' || diagnostic.editor !== 'найден' || diagnostic.server === 'недоступен';
    const state = warning ? (diagnostic.server === 'недоступен' ? 'warn' : 'info') : 'ok';
    setStatus(
      [
        'редактор: ' + diagnostic.editor,
        'Cancel/Save: ' + diagnostic.actions,
        'UI: ' + diagnostic.ui,
        'localhost: ' + diagnostic.server
      ].join(' · '),
      state
    );
  }

  function setDiagnostic(key, value) {
    diagnostic[key] = value;
    renderDiagnosticStatus();
  }

  async function checkMediatorStatus() {
    try {
      await gmRequest({
        method: 'GET',
        url: MEDIATOR + '/api/sync/state?channel=' + encodeURIComponent(currentChannel || 'freshdesk:status')
      });
      setDiagnostic('server', 'доступен');
      return true;
    } catch {
      setDiagnostic('server', 'недоступен');
      return false;
    }
  }

  function gmRequest({ method, url, body }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        data: body === undefined ? undefined : JSON.stringify(body),
        onload: response => {
          let data = {};
          try { data = JSON.parse(response.responseText || '{}'); } catch {}
          if (response.status >= 200 && response.status < 300) resolve(data);
          else reject(new Error(data.error || 'HTTP ' + response.status));
        },
        onerror: () => reject(new Error('Не удалось подключиться к GEGI AI Proofreader на localhost:37891'))
      });
    });
  }

  function blockTag(tag) {
    return /^(P|DIV|LI|UL|OL|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|TR|TABLE|SECTION|ARTICLE)$/.test(tag);
  }

  function isEmptyStructuralBlock(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE || !blockTag(node.tagName)) return false;
    if (node.querySelector('img,video,iframe,object,embed,table')) return false;
    return !(node.textContent || '').trim();
  }

  function renderedText(node) {
    let out = '';
    function walk(n, isRoot = false) {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.nodeValue || '';
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (n.nodeType === Node.ELEMENT_NODE && /^(SCRIPT|STYLE|NOSCRIPT|IFRAME)$/.test(n.tagName)) return;
      if (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'BR') {
        if (!out.endsWith('\n')) out += '\n';
        return;
      }
      const isBlock = n.nodeType === Node.ELEMENT_NODE && blockTag(n.tagName) && !isRoot;
      if (isBlock && out && !out.endsWith('\n')) out += '\n';
      if (isBlock && isEmptyStructuralBlock(n)) {
        out += '\n';
        return;
      }
      for (const child of n.childNodes) walk(child);
      if (isBlock && out && !out.endsWith('\n')) out += '\n';
    }
    walk(node, true);
    return out;
  }

  function buildBoundaryMap(root) {
    const entries = [];
    let offset = 0;

    function separator() {
      if (offset <= 0) return;
      const last = entries.at(-1);
      if (last && last.end === offset) offset += 1;
    }

    function walk(node, isRoot = false) {
      if (node.nodeType === Node.TEXT_NODE) {
        entries.push({ node, start: offset, end: offset + node.nodeValue.length });
        offset += node.nodeValue.length;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
        separator();
        return;
      }
      const isBlock = node.nodeType === Node.ELEMENT_NODE && blockTag(node.tagName) && !isRoot;
      if (isBlock) separator();
      if (isBlock && isEmptyStructuralBlock(node)) {
        offset += 1;
        return;
      }
      for (const child of node.childNodes) walk(child);
      if (isBlock) separator();
    }

    walk(root, true);
    return { entries, length: offset };
  }

  function pointForOffset(map, target) {
    if (target <= 0) return map.entries[0] ? { node: map.entries[0].node, offset: 0 } : null;
    for (const entry of map.entries) {
      if (target >= entry.start && target <= entry.end) {
        return {
          node: entry.node,
          offset: Math.max(0, Math.min(entry.node.nodeValue.length, target - entry.start))
        };
      }
    }
    const last = map.entries.at(-1);
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  }

  function isResolvedIssue(issue) {
    return Boolean(issue?.fixed) || issue?.status === 'fixed' || issue?.status === 'ignored' || issue?.ignored;
  }

  function issueRange(issue) {
    if (!currentEditor || !issue || isResolvedIssue(issue)) return null;
    const startOffset = (Number(currentState?.sourceSelectionStart) || 0) + (Number(issue.start) || 0);
    const endOffset = (Number(currentState?.sourceSelectionStart) || 0) + (Number(issue.end) || 0);
    if (endOffset <= startOffset) return null;
    const map = buildBoundaryMap(currentEditor);
    const a = pointForOffset(map, startOffset);
    const b = pointForOffset(map, endOffset);
    if (!a || !b) return null;
    const range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      return range;
    } catch {
      return null;
    }
  }

  function findEditor() {
    const selectors = [
      '.fr-element.fr-view[contenteditable="true"]',
      '.fr-element[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]'
    ];
    const candidates = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (el.id === UI_ID || el.closest('#' + UI_ID) || el.offsetParent === null) continue;
        if (!el.isContentEditable) continue;
        const textLength = (el.textContent || '').trim().length;
        const rect = el.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 60) continue;
        candidates.push({ el, score: textLength + rect.width * rect.height / 10000 });
      }
      if (candidates.length) break;
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function findActionButton(testId, value) {
    const byTestId = document.querySelector('[data-test-id="' + testId + '"]');
    if (byTestId && (byTestId.matches('button,[role="button"]') || byTestId.querySelector('button'))) {
      return byTestId.matches('button,[role="button"]') ? byTestId : byTestId.querySelector('button');
    }

    const wanted = String(value).trim().toLowerCase();
    return [...document.querySelectorAll('button,[role="button"]')]
      .filter(button => {
        if (button.id === UI_ID || button.closest('#' + UI_ID)) return false;
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .find(button => String(button.textContent || '').trim().toLowerCase() === wanted);
  }

  function createBridgeButton(label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gegi-panel-button ' + className;
    button.textContent = label;
    return button;
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#gegi-proofread-toolbar{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;height:20px;min-height:20px;box-sizing:border-box;display:flex;align-items:center;gap:4px;padding:1px 5px;background:rgba(31,34,38,.97);border-top:1px solid rgba(255,255,255,.16);box-shadow:0 -2px 10px rgba(0,0,0,.28);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;overflow:hidden}',
      '#gegi-proofread-toolbar .gegi-status{flex:1 1 auto;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 10px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#fff}',
      '#gegi-proofread-toolbar[data-state="ok"] .gegi-status{color:#82d989}',
      '#gegi-proofread-toolbar[data-state="warn"] .gegi-status{color:#ffca6b}',
      '#gegi-proofread-toolbar[data-state="error"] .gegi-status{color:#ff7979}',
      '#gegi-proofread-toolbar[data-state="info"] .gegi-status{color:#9bb8ff}',
      '#gegi-proofread-toolbar .gegi-panel-button{height:18px;min-height:18px;padding:0 7px;border:1px solid rgba(255,255,255,.22);border-radius:2px;background:rgba(255,255,255,.09);color:#fff;font:600 10px/16px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;cursor:pointer;box-sizing:border-box;white-space:nowrap}',
      '#gegi-proofread-toolbar .gegi-panel-button:hover:not(:disabled){background:rgba(255,255,255,.16)}',
      '#gegi-proofread-toolbar .gegi-panel-button:disabled{opacity:.42;cursor:default}',
      '#gegi-proofread-toolbar .gegi-proofreader-button{border-color:rgba(94,163,255,.65)}',
      '#gegi-proofread-toolbar .gegi-prev-button,#gegi-proofread-toolbar .gegi-next-button{min-width:76px}',
      '#gegi-proofread-status{display:none}',
      '#gegi-proofread-toolbar button.gegi-sync-button{min-width:0}',
      '#gegi-proofread-gutter{position:fixed;z-index:2147483645;display:none;width:18px;background:#c9c9c9;border-right:1px solid rgba(28,32,35,.15);pointer-events:none;box-sizing:border-box}',
      '#gegi-proofread-gutter .gegi-gutter-marker{position:absolute;left:4px;width:10px;height:10px;border-radius:50%;box-sizing:border-box}',
      '#gegi-proofread-gutter .error{background:#e32929}',
      '#gegi-proofread-gutter .review{background:#d9a810}',
      '#gegi-proofread-gutter .local{background:#d900d9}',
      '#gegi-proofread-gutter .fixed{display:none}',
      '#gegi-proofread-toolbar .gegi-proofreader-button{margin-right:2px}',
      '#gegi-proofread-toolbar .gegi-prev-button,#gegi-proofread-toolbar .gegi-next-button{min-width:88px}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function removeUi() {
    document.getElementById(UI_ID)?.remove();
    document.getElementById(GUTTER_ID)?.remove();
    document.getElementById(STATUS_ID)?.remove();
    editorObserver?.disconnect();
    editorObserver = null;
    if (toolbarRetryTimer) {
      clearInterval(toolbarRetryTimer);
      toolbarRetryTimer = null;
    }
    currentEditor = null;
    currentState = null;
    lastServerRevision = 0;
  }

  function startToolbarRetry() {
    if (toolbarRetryTimer) clearInterval(toolbarRetryTimer);
    installToolbar();
    if (document.getElementById(UI_ID)) return;

    toolbarRetryTimer = setInterval(() => {
      if (!isEditMode()) {
        clearInterval(toolbarRetryTimer);
        toolbarRetryTimer = null;
        return;
      }
      installToolbar();
      if (document.getElementById(UI_ID)) {
        clearInterval(toolbarRetryTimer);
        toolbarRetryTimer = null;
      }
    }, 500);
  }

  function installToolbar() {
    if (!isEditMode()) return;
    if (document.getElementById(UI_ID)) {
      setDiagnostic('ui', 'установлены');
      return;
    }

    const toolbar = document.createElement('div');
    toolbar.id = UI_ID;
    toolbar.dataset.state = 'info';

    const status = document.createElement('span');
    status.className = 'gegi-status';
    status.textContent = 'GEGI AI Proofreader: запуск...';

    const proofreader = createBridgeButton('В GEGI Proofreader', 'gegi-proofreader-button');
    const previous = createBridgeButton('Предыдущая', 'gegi-prev-button');
    const next = createBridgeButton('Следующая', 'gegi-next-button');
    previous.disabled = true;
    next.disabled = true;

    proofreader.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void sendCurrentArticleToProofreader();
    });
    previous.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void moveActiveIssue(-1);
    });
    next.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void moveActiveIssue(1);
    });

    toolbar.append(status, proofreader, previous, next);
    document.body.appendChild(toolbar);
    setDiagnostic('ui', 'установлены');
  }

  function ensureGutter() {
    let gutter = document.getElementById(GUTTER_ID);
    if (!gutter) {
      gutter = document.createElement('div');
      gutter.id = GUTTER_ID;
      document.body.appendChild(gutter);
    }
    return gutter;
  }

  function scheduleRenderMarkers() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      renderMarkers();
    });
  }

  function renderMarkers() {
    if (!isEditMode() || !currentEditor || !currentState) {
      const gutter = document.getElementById(GUTTER_ID);
      if (gutter) gutter.style.display = 'none';
      return;
    }
    const editorRect = currentEditor.getBoundingClientRect();
    if (editorRect.width < 100 || editorRect.height < 20) {
      const gutter = document.getElementById(GUTTER_ID);
      if (gutter) gutter.style.display = 'none';
      return;
    }
    const gutter = ensureGutter();
    gutter.style.display = 'block';
    gutter.style.left = Math.max(0, Math.round(editorRect.left - 22)) + 'px';
    gutter.style.top = Math.round(editorRect.top) + 'px';
    gutter.style.height = Math.round(editorRect.height) + 'px';
    gutter.innerHTML = '';

    for (const issue of currentState.issues || []) {
      if (isResolvedIssue(issue)) continue;
      const range = issueRange(issue);
      if (!range) continue;
      const rect = [...range.getClientRects()].find(item => item.width > 0 && item.height > 0);
      if (!rect) continue;
      const marker = document.createElement('span');
      marker.className = 'gegi-gutter-marker ' + (issue.severity || 'review');
      marker.style.top = Math.max(0, Math.round(rect.top - editorRect.top + rect.height / 2 - 5)) + 'px';
      gutter.appendChild(marker);
    }
  }

  function findScrollContainer(element) {
    let node = element;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 2) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollToIssueIndex(index, behavior = 'smooth') {
    if (!currentEditor || !currentState?.issues?.[index]) return;
    const issue = currentState.issues[index];
    const range = issueRange(issue);
    if (!range) return;
    const target = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
    if (!target) return;

    const scrollBox = findScrollContainer(currentEditor);
    const box = scrollBox.getBoundingClientRect();
    const targetCenter = target.top - box.top + target.height / 2;
    const desired = scrollBox.scrollTop + targetCenter - scrollBox.clientHeight / 2;
    scrollBox.scrollTo({ top: Math.max(0, desired), behavior });
  }

  function updateToolbarState() {
    const toolbar = document.getElementById(UI_ID);
    if (!toolbar) return;
    const previous = toolbar.querySelector('.gegi-prev-button');
    const next = toolbar.querySelector('.gegi-next-button');
    const openIndexes = (currentState?.issues || [])
      .map((issue, index) => isResolvedIssue(issue) ? -1 : index)
      .filter(index => index >= 0);
    const activePosition = openIndexes.indexOf(Number.isInteger(currentState?.activeIndex) ? currentState.activeIndex : -1);
    previous.disabled = openIndexes.length < 2 || activePosition <= 0;
    next.disabled = openIndexes.length < 2 || activePosition < 0 || activePosition >= openIndexes.length - 1;
  }

  async function moveActiveIssue(delta) {
    const openIndexes = (currentState?.issues || [])
      .map((issue, index) => isResolvedIssue(issue) ? -1 : index)
      .filter(index => index >= 0);
    if (!openIndexes.length) return;

    const activePosition = openIndexes.indexOf(Number.isInteger(currentState.activeIndex) ? currentState.activeIndex : -1);
    const currentPosition = activePosition < 0 ? 0 : activePosition;
    const nextPosition = Math.max(0, Math.min(openIndexes.length - 1, currentPosition + delta));
    const next = openIndexes[nextPosition];

    currentState = { ...currentState, activeIndex: next };
    persistState();
    updateToolbarState();
    scheduleRenderMarkers();
    scrollToIssueIndex(next);
    try {
      await gmRequest({
        method: 'POST',
        url: MEDIATOR + '/api/sync/publish',
        body: {
          channel: currentChannel,
          source: 'freshdesk',
          type: 'active',
          activeIndex: next,
          sourceSelectionStart: Number(currentState.sourceSelectionStart) || 0,
          issues: currentState.issues,
          importId: ''
        }
      });
    } catch {}
  }

  function persistState() {
    if (!currentChannel || !currentState) return;
    GM_setValue(stateKey(), currentState);
  }

  async function refreshFromServer() {
    if (!currentChannel) return;
    try {
      const data = await gmRequest({
        method: 'GET',
        url: MEDIATOR + '/api/sync/state?channel=' + encodeURIComponent(currentChannel)
      });
      const state = data.state;
      if (!state) return;
      if (Number(state.revision) <= lastServerRevision) return;
      lastServerRevision = Number(state.revision);

      if (state.source === 'freshdesk') return;
      currentState = state;
      persistState();
      updateToolbarState();
      scheduleRenderMarkers();

      if (state.type === 'issues' || state.type === 'active') {
        const active = Number.isInteger(state.activeIndex) ? state.activeIndex : -1;
        if (active >= 0) scrollToIssueIndex(active);
      }
    } catch {}
  }

  async function ensureServerHasCachedState() {
    if (!currentState || !currentChannel) return;
    try {
      const data = await gmRequest({
        method: 'GET',
        url: MEDIATOR + '/api/sync/state?channel=' + encodeURIComponent(currentChannel)
      });
      if (data.state || !currentState.issues?.length) return;
      await gmRequest({
        method: 'POST',
        url: MEDIATOR + '/api/sync/publish',
        body: {
          channel: currentChannel,
          source: 'freshdesk',
          type: 'active',
          activeIndex: Number.isInteger(currentState.activeIndex) ? currentState.activeIndex : -1,
          sourceSelectionStart: Number(currentState.sourceSelectionStart) || 0,
          issues: currentState.issues,
          importId: ''
        }
      });
    } catch {}
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    void refreshFromServer();
    void ensureServerHasCachedState();
    pollTimer = setInterval(() => {
      void refreshFromServer();
      scheduleRenderMarkers();
    }, 400);
  }

  async function sendCurrentArticleToProofreader() {
    const editor = findEditor();
    if (!editor) {
      alert('Не удалось найти поле редактирования Freshdesk.');
      return;
    }
    currentEditor = editor;

    const payload = {
      source: 'freshdesk',
      text: renderedText(editor),
      html: editor.innerHTML,
      css: getComputedStyle(editor).cssText || ''
    };

    try {
      const imported = await gmRequest({
        method: 'POST',
        url: MEDIATOR + '/api/import',
        body: payload
      });

      const result = await gmRequest({
        method: 'POST',
        url: MEDIATOR + '/api/sync/publish',
        body: {
          channel: currentChannel,
          source: 'freshdesk',
          type: 'import',
          activeIndex: -1,
          sourceSelectionStart: 0,
          issues: [],
          importId: imported.importId
        }
      });

      lastServerRevision = Math.max(lastServerRevision, Number(result.state?.revision) || 0);
      currentState = result.state;
      persistState();
      updateToolbarState();
      scheduleRenderMarkers();

      const url = MEDIATOR + '/?import=' + encodeURIComponent(imported.importId) +
        '&source=freshdesk&sourceUrl=' + encodeURIComponent(location.href) +
        '&sync=' + encodeURIComponent(currentChannel);

      try {
        if (proofreaderWindow && !proofreaderWindow.closed) {
          proofreaderWindow.focus();
        } else {
          proofreaderWindow = window.open(url, 'GEGI_AI_PROOFREADER');
        }
        if (!proofreaderWindow) alert('Firefox заблокировал открытие окна GEGI AI Proofreader.');
      } catch {
        window.open(url, 'GEGI_AI_PROOFREADER');
      }
    } catch (error) {
      alert('GEGI AI Proofreader: ' + error.message);
    }
  }

  function setupEditorObserver() {
    editorObserver?.disconnect();
    if (!currentEditor) return;
    editorObserver = new MutationObserver(() => {
      if (!currentEditor?.isConnected) currentEditor = findEditor();
      scheduleRenderMarkers();
    });
    editorObserver.observe(currentEditor, { childList: true, subtree: true, characterData: true });
  }

  function refreshEditMode() {
    const edit = isEditMode();
    currentArticleId = getArticleId();
    currentChannel = getChannel();

    if (!edit || !currentChannel) {
      removeUi();
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      return;
    }

    installStyle();
    currentEditor = findEditor();
    installToolbar();
    ensureGutter();
    setupEditorObserver();

    if (!currentState) {
      currentState = GM_getValue(stateKey(), null);
      if (currentState) {
        lastServerRevision = Number(currentState.revision) || 0;
        updateToolbarState();
        scheduleRenderMarkers();
      }
    }
    startPolling();
  }

  function observePage() {
    if (refreshObserver) return;
    refreshObserver = new MutationObserver(() => {
      clearTimeout(actionTimer);
      actionTimer = setTimeout(refreshEditMode, 250);
    });
    refreshObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', refreshEditMode);
    window.addEventListener('hashchange', refreshEditMode);
    window.addEventListener('scroll', scheduleRenderMarkers, true);
    window.addEventListener('resize', scheduleRenderMarkers);
  }

  observePage();
  installStyle();
  refreshEditMode();
})();
