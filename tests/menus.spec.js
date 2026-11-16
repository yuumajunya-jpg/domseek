import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

let helpers;
test.beforeAll(async () => {
  const result = await build({ entryPoints: ['src/menus.js'], bundle: true, write: false, format: 'iife', globalName: 'menuHelpers' });
  helpers = result.outputFiles[0].text;
});

async function fixture(page, { delay = 0, closeOnEscape = true, stealFocus = false } = {}) {
  await page.setContent(`
    <button id="picker" aria-haspopup="menu" aria-label="Auto、モデル セレクター">Auto</button>
    <button id="ordinary">普通のボタン</button>
    <button id="disabled" disabled aria-haspopup="menu">無効</button>
    <a href="https://example.com/" aria-haspopup="menu">リンク</a>
    <input id="original">
    <script>
      window.opens = 0; window.executions = 0; window.ordinaryClicks = 0;
      document.querySelector('#ordinary').onclick = () => window.ordinaryClicks++;
      document.querySelector('#picker').onclick = () => {
        const old = document.querySelector('[role="menu"]');
        if (old) { old.remove(); return; }
        window.opens++;
        setTimeout(() => {
          const menu = document.createElement('div');
          menu.setAttribute('role', 'menu');
          menu.setAttribute('aria-labelledby', 'picker');
          for (const name of ['Auto', 'Quick Response', 'Think Deeper']) {
            const item = document.createElement('div');
            item.setAttribute('role', 'menuitemradio'); item.textContent = name; item.tabIndex = -1;
            item.onclick = () => { window.executions++; document.body.dataset.chosen = name; menu.remove(); };
            menu.append(item);
          }
          menu.addEventListener('keydown', e => {
            if (${closeOnEscape} && e.key === 'Escape') {
              menu.remove();
              if (${stealFocus}) document.querySelector('#picker').focus();
            }
          });
          document.body.append(menu);
          if (${stealFocus}) {
            // Typical menu libraries focus the first item, sometimes after an animation.
            menu.firstElementChild.focus();
            setTimeout(() => { if (menu.isConnected) menu.firstElementChild.focus(); }, 40);
          }
        }, ${delay});
      };
    </script>`);
  await page.addScriptTag({ content: helpers });
}

async function open(page) {
  await page.addScriptTag({ path: 'dist/content.js' });
  return page.locator('[data-domseek-panel]').getByRole('combobox');
}

test('discovers unmounted portal items without selecting them, then resolves a fresh item', async ({ page }) => {
  await fixture(page, { delay: 60 });
  const found = await page.evaluate(async () => {
    window.found = await menuHelpers.discoverMenus();
    return window.found.map(({ name, context, element }) => ({ name, context, connected: element.isConnected }));
  });
  expect(found.map(({ name }) => name)).toEqual(['Auto', 'Quick Response', 'Think Deeper']);
  expect(found.every(({ connected, context }) => !connected && context === 'Auto、モデル セレクター')).toBe(true);
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  expect(await page.evaluate(() => [window.opens, window.executions, window.ordinaryClicks])).toEqual([1, 0, 0]);
  await page.evaluate(async () => {
    const fresh = await menuHelpers.resolveMenuCandidate(window.found.find(({ name }) => name === 'Think Deeper'));
    fresh.element.click();
  });
  await expect(page.locator('body')).toHaveAttribute('data-chosen', 'Think Deeper');
  expect(await page.evaluate(() => [window.opens, window.executions])).toEqual([2, 1]);
});

test('falls back to toggling the trigger if synthetic Escape is not handled', async ({ page }) => {
  await fixture(page, { closeOnEscape: false });
  expect(await page.evaluate(async () => (await menuHelpers.discoverMenus()).length)).toBe(3);
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.executions)).toBe(0);
});

test('cancelling discovery cleans up a menu that mounts asynchronously', async ({ page }) => {
  await fixture(page, { delay: 100 });
  await page.evaluate(async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await menuHelpers.discoverMenus({ signal: controller.signal });
  });
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  expect(await page.evaluate(() => [window.opens, window.executions])).toEqual([1, 0]);
});

test('keeps an initially open menu open during collection', async ({ page }) => {
  await fixture(page);
  await page.locator('#picker').click();
  await expect(page.locator('[role="menu"]')).toHaveCount(1);
  expect(await page.evaluate(async () => (await menuHelpers.discoverMenus()).length)).toBe(3);
  await expect(page.locator('[role="menu"]')).toHaveCount(1);
  expect(await page.evaluate(() => [window.opens, window.executions])).toEqual([1, 0]);
});

test('panel searches and executes an initially ungenerated model, preserving Fuse ranking', async ({ page }) => {
  await fixture(page, { delay: 80 });
  const input = await open(page);
  await input.fill('Think');
  await expect(page.getByRole('option').first()).toContainText('Think Deeper');
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-chosen', 'Think Deeper');
  await expect(input).toHaveCount(0);
});

test('Escape cancels collection, cleans up, and restores the original focus', async ({ page }) => {
  await fixture(page, { delay: 150 });
  await page.locator('#original').focus();
  const input = await open(page);
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.locator('#original')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.opens)).toBe(1);
  // Wait for pending menu mount and cleanup; ensure it does not appear later.
  await page.waitForTimeout(500);
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.executions)).toBe(0);
});

test('changed menu content produces an error without executing another item', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => { window.found = await menuHelpers.discoverMenus(); });
  await page.evaluate(() => {
    document.querySelector('#picker').onclick = () => {
      const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-labelledby', 'picker');
      menu.innerHTML = '<div role="menuitemradio">Different model</div>';
      menu.addEventListener('keydown', () => menu.remove()); document.body.append(menu);
    };
  });
  const error = await page.evaluate(async () => {
    try { await menuHelpers.resolveMenuCandidate(window.found.find(({ name }) => name === 'Think Deeper')); }
    catch (error) { return error.message; }
  });
  expect(error).toContain('項目が変更');
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.executions)).toBe(0);
});

test('real keyboard typing stays in the search input while menu scripts move focus', async ({ page }) => {
  await fixture(page, { delay: 200, stealFocus: true });
  const input = await open(page);
  await expect(input).toBeFocused();
  // Use the keyboard directly: locator.fill() would hide the bug by refocusing the input.
  await page.keyboard.type('Think Deeper', { delay: 50 });
  await expect(input).toHaveValue('Think Deeper');
  await expect(input).toBeFocused();
  await expect(page.getByRole('option').first()).toContainText('Think Deeper');
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.executions)).toBe(0);
});
