const SELECTOR = 'a[href],area[href],button,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"],summary,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[onclick]';

function ancestors(element) {
  const result = [];
  for (let node = element; node; node = node.parentElement || node.getRootNode().host) result.push(node);
  return result;
}

function allRoots(root) {
  const roots = [root];
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) roots.push(...allRoots(element.shadowRoot));
  }
  return roots;
}

function label(element) {
  const root = element.getRootNode();
  const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
    .map((id) => root.getElementById?.(id)?.textContent || '').join(' ').trim();
  return labelled || element.getAttribute('aria-label')?.trim() ||
    element.textContent?.replace(/\s+/g, ' ').trim() ||
    element.getAttribute('alt')?.trim() || element.value?.trim() || element.title?.trim() || '';
}

function isDisabled(element) {
  return element.matches(':disabled') || ancestors(element).some((node) => node.getAttribute('aria-disabled') === 'true');
}

function firstSummary(details) {
  return [...details.children].find((child) => child.tagName === 'SUMMARY');
}

function isHiddenStyle(element) {
  const style = getComputedStyle(element);
  return element.hidden || style.display === 'none' || style.contentVisibility === 'hidden' || style.opacity === '0';
}

export function collectCandidates(doc = document, excludedHost) {
  const result = [];
  for (const root of allRoots(doc)) {
    const controls = new Map();
    for (const controller of root.querySelectorAll('[aria-controls], [aria-expanded][id]')) {
      if (excludedHost && ancestors(controller).includes(excludedHost)) continue;
      for (const id of (controller.getAttribute('aria-controls') || '').split(/\s+/)) {
        const panel = root.getElementById?.(id);
        if (panel && !panel.contains(controller) && !controls.has(panel)) controls.set(panel, controller);
      }
      if (controller.id) {
        for (const panel of root.querySelectorAll('[aria-labelledby]')) {
          if ((panel.getAttribute('aria-labelledby') || '').split(/\s+/).includes(controller.id) &&
              !panel.contains(controller) && !controls.has(panel)) controls.set(panel, controller);
        }
      }
    }

    for (const element of root.querySelectorAll(SELECTOR)) {
      const chain = ancestors(element);
      if (excludedHost && chain.includes(excludedHost)) continue;
      if (isDisabled(element) || chain.some((node) => node.matches('template,[data-domseek-ignore]'))) continue;
      // Nested semantic wrappers should not produce the same action twice.
      if (chain.slice(1).some((node) => node.matches(SELECTOR))) continue;
      const name = label(element);
      if (!name) continue;
      const reveal = [];
      let invalid = false;
      for (const node of [...chain].reverse()) {
        if (node.tagName === 'DETAILS' && node !== element) {
          const summary = firstSummary(node);
          if (summary && !summary.contains(element)) reveal.push({ type: 'details', panel: node, controller: summary });
        }
        const controller = controls.get(node);
        if (controller) reveal.push({ type: 'controlled', panel: node, controller });
        // Only the identified panel itself may be hidden, not arbitrary descendants.
        if ((isHiddenStyle(node) || node.inert) && !controls.has(node)) invalid = true;
      }
      const style = getComputedStyle(element);
      if ((style.visibility === 'hidden' || style.visibility === 'collapse') &&
          !reveal.some(({ panel }) => getComputedStyle(panel).visibility === style.visibility)) invalid = true;
      if (invalid || reveal.some(({ controller }) => isDisabled(controller))) continue;
      const context = reveal.map(({ controller }) => label(controller)).filter(Boolean).join(' › ');
      const href = element.matches('a[href],area[href]') ? element.href : '';
      result.push({
        element, name, context, href, reveal,
        aliases: [element.getAttribute('aria-label') || '', element.title || '', element.getAttribute('alt') || ''].filter(Boolean),
        kind: href ? 'リンク' : element.tagName === 'SUMMARY' ? '折りたたみ' : 'ボタン',
      });
    }
  }
  return result;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function activateCandidate(candidate) {
  const { element, reveal } = candidate;
  if (!element.isConnected) throw new Error('対象がページから削除されました。検索し直してください。');
  if (isDisabled(element)) throw new Error('この操作は現在無効です。');
  for (const { type, panel, controller } of reveal) {
    if (type === 'details') {
      if (!panel.open) { panel.open = true; await delay(0); }
    } else if (controller.getAttribute('aria-expanded') === 'false' || isHiddenStyle(panel) || panel.inert || getComputedStyle(panel).visibility === 'hidden') {
      if (!controller.isConnected || isDisabled(controller)) throw new Error('親メニューを開けませんでした。');
      controller.click();
      // Allow site event handlers and animations to update the existing panel.
      for (let attempt = 0; attempt < 20; attempt++) {
        await delay(25);
        if (!isHiddenStyle(panel) && !panel.inert && getComputedStyle(panel).visibility === 'visible' &&
            controller.getAttribute('aria-expanded') !== 'false') break;
      }
    }
  }
  const chain = ancestors(element);
  if (!element.isConnected || isDisabled(element) || chain.some((node) => isHiddenStyle(node) || node.inert) ||
      getComputedStyle(element).visibility !== 'visible' || !element.getClientRects().length) {
    throw new Error('対象を実行できませんでした。メニューを開いてから検索し直してください。');
  }
  element.click();
}
