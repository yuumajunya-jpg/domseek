import { collectCandidates, activateCandidate } from './candidates.js';
import { createSearch } from './search.js';
import { discoverMenus, resolveMenuCandidate, internalMenuEvent } from './menus.js';
import styles from './panel.css';

const INSTANCE = '__domseek_panel_v2__';

function createPanel() {
  let host, shadow, input, list, status, observer, previousFocus;
  let results = [], selected = 0, search, timer, busy = false, composing = false;
  let discovered = [], scanController, scanTask = Promise.resolve(), scanningText = '';
  let liveCandidates = [];
  const isOpen = () => Boolean(host?.isConnected);

  function close(restoreFocus = true) {
    scanController?.abort();
    observer?.disconnect();
    clearTimeout(timer);
    document.removeEventListener('keydown', onDocumentKey, true);
    host?.remove();
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }

  function select(index) {
    selected = index;
    [...list.children].forEach((row, i) => row.setAttribute('aria-selected', String(i === index)));
    if (results[index]) {
      input.setAttribute('aria-activedescendant', `domseek-option-${index}`);
      list.children[index].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function render() {
    const oldElement = results[selected]?.element;
    results = search(input.value);
    list.replaceChildren();
    results.forEach((candidate, index) => {
      const row = document.createElement('li');
      row.id = `domseek-option-${index}`;
      row.setAttribute('role', 'option');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = candidate.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = [candidate.kind, candidate.context, candidate.href].filter(Boolean).join(' · ');
      row.append(name, meta);
      row.addEventListener('pointermove', () => select(index));
      row.addEventListener('mousedown', (event) => event.preventDefault());
      row.addEventListener('click', () => { select(index); execute(); });
      list.append(row);
    });
    const retained = results.findIndex(({ element }) => element === oldElement);
    select(retained < 0 ? 0 : retained);
    const message = !input.value.trim() ? '検索ワードを入力してください' :
      results.length ? `${results.length}件の候補` : '一致する操作がありません';
    status.textContent = [message, scanningText].filter(Boolean).join(' · ');
  }

  function updateSearch() {
    if (!isOpen() || busy) return;
    const cached = discovered.filter(({ menuRoute }) => menuRoute.trigger.isConnected);
    const cachedElements = new Set(cached.map(({ element }) => element));
    const live = liveCandidates.filter(({ element }) => element.isConnected && !cachedElements.has(element));
    search = createSearch([...live, ...cached]);
    render();
  }

  function refresh() {
    if (!isOpen() || busy) return;
    liveCandidates = collectCandidates(document, host);
    updateSearch();
  }

  async function execute() {
    const candidate = results[selected];
    if (!candidate || busy) return;
    busy = true;
    clearTimeout(timer);
    observer.disconnect();
    input.disabled = true;
    status.textContent = '実行中…';
    try {
      scanController?.abort();
      await scanTask;
      await activateCandidate(candidate.menuRoute ? await resolveMenuCandidate(candidate) : candidate);
      close(false);
    } catch (error) {
      status.textContent = error.message;
      input.disabled = false;
      input.focus({ preventScroll: true });
      observe();
    } finally {
      busy = false;
    }
  }

  function onDocumentKey(event) {
    if (event[internalMenuEvent]) return;
    if (busy) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (event.isComposing || composing || event.keyCode === 229) {
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (results.length) select((selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopImmediatePropagation(); execute();
    } else if (event.key === 'Tab') {
      event.preventDefault(); event.stopImmediatePropagation(); input.focus({ preventScroll: true });
    } else {
      // Don't let page shortcuts handle typing in the search panel.
      event.stopImmediatePropagation();
    }
  }

  function protectSearchFocus(signal) {
    const searchInput = input;
    const searchRoot = shadow;
    const types = ['focus', 'focusin', 'blur', 'focusout'];
    function guard(event) {
      if (signal.aborted || !isOpen() || busy || !(event.target instanceof Node)) return;
      // Menu libraries focus items on mount and focus their trigger on dismissal.
      // Intercept before their focus traps, including blur handlers that would
      // dismiss the menu when focus is returned to our input.
      event.stopImmediatePropagation();
      if ((event.type === 'focus' || event.type === 'focusin') && searchRoot.activeElement !== searchInput) {
        searchInput.focus({ preventScroll: true });
      }
    }
    const cleanup = () => {
      for (const type of types) window.removeEventListener(type, guard, true);
    };
    for (const type of types) window.addEventListener(type, guard, true);
    signal.addEventListener('abort', cleanup, { once: true });
    return () => { cleanup(); signal.removeEventListener('abort', cleanup); };
  }

  function observe() {
    const options = { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'inert', 'open', 'disabled', 'aria-disabled', 'aria-expanded', 'aria-controls', 'aria-label', 'aria-labelledby', 'role', 'href', 'title', 'onclick', 'value', 'alt', 'type'] };
    observer.observe(document.documentElement, options);
    const visit = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element !== host && element.shadowRoot) { observer.observe(element.shadowRoot, options); visit(element.shadowRoot); }
      }
    };
    visit(document);
  }

  function open() {
    composing = false;
    results = [];
    selected = 0;
    discovered = [];
    scanningText = '';
    previousFocus = document.activeElement;
    while (previousFocus?.shadowRoot?.activeElement) previousFocus = previousFocus.shadowRoot.activeElement;
    host = document.createElement('div');
    host.setAttribute('data-domseek-panel', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${styles}</style>
      <div class="backdrop">
        <section role="dialog" aria-modal="true" aria-label="DomSeek 操作を検索" class="panel">
          <header><span class="brand">DomSeek</span><span class="hint">ページの操作を検索</span><button type="button" aria-label="閉じる">Esc</button></header>
          <input type="text" role="combobox" aria-label="検索ワード" aria-autocomplete="list" aria-expanded="true" aria-controls="domseek-results" autocomplete="off" spellcheck="false" placeholder="リンクやボタンの名前を入力…">
          <ul id="domseek-results" role="listbox" aria-label="検索候補"></ul>
          <footer><span role="status" aria-live="polite"></span><span>↑↓ 選択　↵ 実行</span></footer>
        </section>
      </div>`;
    input = shadow.querySelector('input');
    list = shadow.querySelector('ul');
    status = shadow.querySelector('[role="status"]');
    shadow.querySelector('button').addEventListener('click', () => { if (!busy) close(); });
    shadow.querySelector('.backdrop').addEventListener('click', (event) => {
      if (!busy && event.target.classList.contains('backdrop')) close();
    });
    input.addEventListener('input', () => { if (!composing) { selected = 0; results = []; render(); } });
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; selected = 0; results = []; render(); });
    // Keep key releases and legacy keypress shortcuts out of the page as well.
    for (const type of ['keyup', 'keypress']) host.addEventListener(type, (event) => event.stopPropagation());
    document.documentElement.append(host);
    refresh();
    observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { observe(); refresh(); }, 100);
    });
    observe();
    document.addEventListener('keydown', onDocumentKey, true);
    input.focus({ preventScroll: true });
    const controller = new AbortController();
    scanController = controller;
    const releaseFocus = protectSearchFocus(controller.signal);
    const current = () => scanController === controller && isOpen();
    scanTask = discoverMenus({
      excludedHost: host,
      signal: controller.signal,
      onUpdate(items) { if (current()) { discovered = items; updateSearch(); } },
      onProgress(index, count, error) {
        if (current()) { scanningText = error || `メニュー収集中 ${index}/${count}`; render(); }
      },
      restoreFocus() { if (current() && !busy) input.focus({ preventScroll: true }); },
    }).then(() => {
      if (current() && !busy) { scanningText = ''; refresh(); }
    }).catch((error) => {
      console.warn('DomSeek menu discovery stopped.', error);
      if (current() && !busy) { scanningText = '一部のメニューを収集できませんでした'; refresh(); }
    }).finally(releaseFocus);
  }

  return { async toggle() { if (busy) return; if (isOpen()) close(); else { await scanTask; open(); } } };
}

globalThis[INSTANCE] ??= createPanel();
globalThis[INSTANCE].toggle();
