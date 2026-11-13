import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createSearch, normalize } from '../src/search.js';
import Fuse from 'fuse.js';

let helpers;
test.beforeAll(async () => {
  const result = await build({ entryPoints: ['src/candidates.js'], bundle: true, write: false, format: 'iife', globalName: 'candidateHelpers' });
  helpers = result.outputFiles[0].text;
});

async function setup(page, html) {
  await page.setContent(html);
  await page.addScriptTag({ content: helpers });
}

async function names(page) {
  return page.evaluate(() => candidateHelpers.collectCandidates().map(({ name }) => name));
}

async function open(page) {
  await page.addScriptTag({ path: 'dist/content.js' });
  return page.locator('[data-domseek-panel]').getByRole('combobox');
}

test('normalization and ranking follow Fuse without custom sorting', () => {
  const items = ['保存する', '保存', '下書き保存', 'ＨＥＬＰ', 'ヘルプ'].map((name) => ({ name, aliases: [] }));
  const search = createSearch(items);
  const fuse = new Fuse(items.map((candidate) => ({ candidate, name: normalize(candidate.name), aliases: [] })), { keys: ['name', 'aliases'] });
  expect(search('保存')).toEqual(fuse.search('保存', { limit: 10 }).map(({ item }) => item.candidate));
  expect(search('help')[0].name).toBe('ＨＥＬＰ');
  expect(search('')).toEqual([]);
});

test('collects collapsed details and controlled menus, excludes unrelated hidden and disabled elements', async ({ page }) => {
  await setup(page, `
    <button>表示中</button>
    <details><summary>設定</summary><a href="#notification">通知設定</a>
      <span hidden><button>未使用部品</button></span></details>
    <button aria-controls="menu" aria-expanded="false">アカウント</button>
    <div id="menu" hidden inert><button>プロフィール</button></div>
    <div hidden><button>非表示</button></div>
    <div style="opacity:0"><button>透明な部品</button></div>
    <button disabled>無効</button><fieldset disabled><button>無効な子</button></fieldset>
    <div aria-disabled="true"><button>無効な領域</button></div>
    <template><button>テンプレート</button></template>
    <button aria-label="アイコン操作"><svg></svg></button>
  `);
  expect(await names(page)).toEqual(['表示中', '設定', '通知設定', 'アカウント', 'プロフィール', 'アイコン操作']);
});

test('nested closed containers open from outside and execute the selected action', async ({ page }) => {
  await setup(page, `
    <details id="outer"><summary>設定</summary>
      <button aria-controls="menu" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#menu').hidden=false;document.querySelector('#menu').inert=false">詳細</button>
      <div id="menu" hidden inert><button onclick="document.body.dataset.executed='yes'">通知設定</button></div>
    </details>`);
  await page.evaluate(async () => {
    await candidateHelpers.activateCandidate(candidateHelpers.collectCandidates().find(({ name }) => name === '通知設定'));
  });
  await expect(page.locator('body')).toHaveAttribute('data-executed', 'yes');
  await expect(page.locator('#outer')).toHaveAttribute('open', '');
});

test('does not activate a hidden item if the opener fails', async ({ page }) => {
  await setup(page, `<button aria-controls="menu" aria-expanded="false">開く</button>
    <div id="menu" hidden><button onclick="document.body.dataset.executed='yes'">実行</button></div>`);
  const error = await page.evaluate(async () => {
    try { await candidateHelpers.activateCandidate(candidateHelpers.collectCandidates().find(({ name }) => name === '実行')); }
    catch (error) { return error.message; }
  });
  expect(error).toContain('実行できません');
  await expect(page.locator('body')).not.toHaveAttribute('data-executed');
});

test('search panel supports typing, keyboard selection, execution and repeat injection', async ({ page }) => {
  await setup(page, `<button onclick="document.body.dataset.executed='save'">保存</button><a href="#help">ヘルプ</a>`);
  const input = await open(page);
  await expect(input).toBeFocused();
  await expect(page.getByRole('option')).toHaveCount(0);
  await input.fill('保存');
  await expect(page.getByRole('option')).toHaveCount(1);
  await input.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-executed', 'save');
  await expect(input).toHaveCount(0);
  await open(page);
  await page.addScriptTag({ path: 'dist/content.js' });
  await expect(page.locator('[data-domseek-panel]')).toHaveCount(0);
});

test('IME confirmation does not execute, Escape restores focus without scrolling the page', async ({ page }) => {
  await setup(page, `<input id="original"><button onclick="document.body.dataset.executed='yes'">保存</button><div style="height:3000px"></div>`);
  await page.locator('#original').focus();
  await page.evaluate(() => window.scrollTo(0, 300));
  const input = await open(page);
  await input.fill('保存');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(page.locator('body')).not.toHaveAttribute('data-executed');
  await input.press('ArrowDown');
  expect(await page.evaluate(() => window.scrollY)).toBe(300);
  await input.press('Escape');
  await expect(page.locator('#original')).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(300);
});

test('page mutations update results; ungenerated menu items are not invented', async ({ page }) => {
  await setup(page, `<button onclick="document.body.insertAdjacentHTML('beforeend','<button>追加操作</button>')">メニュー</button>`);
  const input = await open(page);
  await input.fill('追加操作');
  await expect(page.getByRole('option')).toHaveCount(0);
  await page.evaluate(() => {
    const button = document.createElement('button'); button.textContent = '追加操作'; document.body.append(button);
  });
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.evaluate(() => document.querySelector('body > button:last-child').remove());
  await expect(page.getByRole('option')).toHaveCount(0);
});

test('open shadow roots are searchable and panel contents never become candidates', async ({ page }) => {
  await setup(page, '<div id="component"></div>');
  await page.evaluate(() => {
    document.querySelector('#component').attachShadow({ mode: 'open' }).innerHTML = '<button>部品の操作</button>';
  });
  expect(await names(page)).toEqual(['部品の操作']);
  const input = await open(page);
  await input.fill('部品の操作');
  await expect(page.getByRole('option')).toHaveCount(1);
  await input.fill('閉じる');
  await expect(page.getByRole('option')).toHaveCount(0);
});
