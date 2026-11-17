import { allRoots, collectCandidates, isDisabled, isHiddenStyle, label } from './candidates.js';

export const internalMenuEvent = Symbol('DomSeek menu event');
const TRIGGER = 'button[aria-haspopup="menu"],button[aria-haspopup="true"],[role="button"][aria-haspopup="menu"],[role="button"][aria-haspopup="true"]';
const ITEM = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

function visible(element) {
  if (!element?.isConnected || !element.getClientRects().length || getComputedStyle(element).visibility !== 'visible') return false;
  for (let node = element; node; node = node.parentElement || node.getRootNode().host) {
    if (isHiddenStyle(node) || node.inert) return false;
  }
  return true;
}

function menus(doc) {
  return allRoots(doc).flatMap((root) => [...root.querySelectorAll('[role="menu"]')]).filter(visible);
}

function linkedMenu(trigger, doc, available = menus(doc)) {
  const ids = (trigger.getAttribute('aria-controls') || '').split(/\s+/);
  return available.find((menu) => menu.getRootNode() === trigger.getRootNode() &&
    ((menu.id && ids.includes(menu.id)) || (trigger.id &&
      (menu.getAttribute('aria-labelledby') || '').split(/\s+/).includes(trigger.id))));
}

function waitFor(read, signal, timeout = 800) {
  if (signal?.aborted) return Promise.resolve(null);
  const initial = read();
  if (initial) return Promise.resolve(initial);
  return new Promise((resolve, reject) => {
    let observer, poll, deadline, settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearInterval(poll);
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(null);
    const check = () => {
      try {
        if (signal?.aborted) finish(null);
        else { const value = read(); if (value) finish(value); }
      } catch (error) { finish(null, error); }
    };
    // React and similar frameworks often mount/unmount after click() returns.
    // Observe that update immediately, retaining polling for CSS-only changes
    // and shadow roots attached after observation started.
    observer = new MutationObserver(check);
    for (const root of allRoots(document)) {
      if (root.host?.hasAttribute('data-domseek-panel')) continue;
      observer.observe(root, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['role', 'id', 'aria-labelledby', 'aria-controls', 'hidden', 'inert', 'class', 'style'] });
    }
    signal?.addEventListener('abort', abort, { once: true });
    poll = setInterval(check, 25);
    deadline = setTimeout(() => { check(); finish(null); }, timeout);
    check();
  });
}

function emitEscape(target, type) {
  const event = new KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true, composed: true, cancelable: true });
  event[internalMenuEvent] = true;
  target.dispatchEvent(event);
}

async function closeMenu(trigger, menu, doc) {
  if (!visible(menu)) return true;
  emitEscape(menu, 'keydown');
  emitEscape(menu, 'keyup');
  if (await waitFor(() => !visible(menu), undefined, 150)) return true;
  // A trigger toggle is a fallback for sites that do not handle synthetic Escape.
  if (trigger.isConnected && !isDisabled(trigger)) trigger.click();
  return Boolean(await waitFor(() => !visible(menu) && !linkedMenu(trigger, doc), undefined, 400));
}

async function openMenu(trigger, doc, signal) {
  const existing = linkedMenu(trigger, doc);
  if (existing) return { menu: existing, opened: false };
  if (!visible(trigger) || isDisabled(trigger)) return null;
  const before = new Set(menus(doc));
  trigger.click();
  const menu = await waitFor(() => {
    const available = menus(doc);
    const linked = linkedMenu(trigger, doc, available);
    const added = available.filter((candidate) => !before.has(candidate));
    const found = linked || (added.length === 1 ? added[0] : null);
    return found?.querySelector(ITEM) ? found : null;
  }, signal);
  if (menu) return { menu, opened: true };
  // Cancellation can occur after the click but before the asynchronous mount.
  const pending = await waitFor(() => linkedMenu(trigger, doc) || menus(doc).find((candidate) => !before.has(candidate)), undefined, 200);
  if (pending) await closeMenu(trigger, pending, doc);
  return null;
}

function signature(element) {
  return JSON.stringify([element.getAttribute('role'), label(element), element.getAttribute('href') || '']);
}

function waitForMenuContents(menu, signal) {
  // Collect once the menu itself stops changing, rather than delaying every
  // menu by 100 ms. Respect explicit loading indicators for slower menus.
  return new Promise((resolve) => {
    let quietTimer, timeout, observer;
    const finish = (ready) => {
      clearTimeout(quietTimer);
      clearTimeout(timeout);
      observer?.disconnect();
      signal?.removeEventListener('abort', abort);
      resolve(ready);
    };
    const abort = () => finish(false);
    const loading = () => Boolean(menu.closest('[aria-busy="true"]') || menu.querySelector('[aria-busy="true"]'));
    const ready = () => !loading() && [...menu.querySelectorAll(ITEM)].some(visible);
    const changed = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (ready()) finish(true);
        else changed();
      }, 24);
    };
    if (signal?.aborted) { finish(false); return; }
    observer = new MutationObserver(changed);
    observer.observe(menu, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['aria-busy', 'role', 'hidden', 'class', 'style'] });
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => finish(ready()), 800);
    changed();
  });
}

/** Explore only explicit top-level menu buttons; never activate an item during discovery. */
export async function discoverMenus({ doc = document, excludedHost, signal, onUpdate = () => {}, onProgress = () => {}, restoreFocus = () => {} } = {}) {
  const found = [];
  const triggers = allRoots(doc).flatMap((root) => [...root.querySelectorAll(TRIGGER)])
    .filter((trigger) => !trigger.closest('[role="menu"]') && (!excludedHost || trigger.getRootNode().host !== excludedHost) &&
      !isDisabled(trigger) && visible(trigger)).slice(0, 12);
  for (let index = 0; index < triggers.length && !signal?.aborted; index++) {
    const trigger = triggers[index];
    const previousFocus = doc.activeElement;
    const scrollX = doc.defaultView.scrollX;
    const scrollY = doc.defaultView.scrollY;
    onProgress(index + 1, triggers.length);
    let opened;
    let closed = true;
    try {
      opened = await openMenu(trigger, doc, signal);
      if (!opened || signal?.aborted) continue;
      if (!await waitForMenuContents(opened.menu, signal) || signal?.aborted) continue;
      const { menu } = opened;
      const candidates = collectCandidates(menu, excludedHost).filter(({ element }) => element.closest('[role="menu"]') === menu);
      const occurrences = new Map();
      for (const candidate of candidates) {
        // Submenu triggers need a multi-step route; leave those to normal searching for now.
        if (candidate.element.hasAttribute('aria-haspopup')) continue;
        const key = signature(candidate.element);
        const occurrence = occurrences.get(key) || 0;
        occurrences.set(key, occurrence + 1);
        found.push({ ...candidate, context: label(trigger),
          menuRoute: { trigger, key, occurrence, doc },
        });
      }
      onUpdate([...found]);
    } finally {
      if (opened?.opened) closed = await closeMenu(trigger, opened.menu, doc);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      doc.defaultView.scrollTo(scrollX, scrollY);
      if (!signal?.aborted) restoreFocus();
    }
    // Stop if restoring the page failed, rather than opening more menus on top.
    if (!closed) {
      onProgress(index + 1, triggers.length, 'メニューを閉じられなかったため収集を停止しました');
      break;
    }
  }
  return found;
}

/** Locate a fresh item after reopening: captured DOM nodes may have been unmounted. */
export async function resolveMenuCandidate(candidate) {
  const { trigger, key, occurrence, doc } = candidate.menuRoute;
  if (!trigger.isConnected) throw new Error('メニューのボタンが変更されました。DomSeekを開き直してください。');
  const opened = await openMenu(trigger, doc);
  if (!opened) throw new Error('メニューを開けませんでした。開き直して検索してください。');
  const fresh = await waitFor(() => {
    const matches = collectCandidates(opened.menu).filter(({ element }) =>
      element.closest('[role="menu"]') === opened.menu && signature(element) === key);
    return matches[occurrence];
  });
  if (!fresh) {
    if (opened.opened) await closeMenu(trigger, opened.menu, doc);
    throw new Error('メニューの項目が変更されました。DomSeekを開き直してください。');
  }
  return fresh;
}
