import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const saved = 'node_modules/.cache/domseek/menu-baseline.js';
const bundled = await build({ entryPoints: ['src/menus.js'], bundle: true, write: false, format: 'iife', globalName: 'menuHelpers' });
const current = bundled.outputFiles[0].text;
const mountDelay = Number(process.argv.find((arg) => arg.startsWith('--mount-delay='))?.split('=')[1] || 0);
if (process.argv.includes('--save-baseline')) {
  await mkdir('node_modules/.cache/domseek', { recursive: true });
  await writeFile(saved, current);
}
const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const versions = existsSync(saved) ? [['baseline', await readFile(saved, 'utf8')], ['current', current]] : [['current', current]];
  for (const [version, source] of versions) {
    const times = [];
    for (let run = 0; run < 3; run++) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      await page.evaluate((mountDelay) => {
        const main = document.querySelector('main');
        for (let index = 0; index < 500; index++) {
          const button = document.createElement('button'); button.textContent = `Action ${index}`; main.append(button);
        }
        for (let index = 0; index < 6; index++) {
          const button = document.createElement('button'); button.textContent = `Menu ${index}`;
          button.id = `menu-${index}`; button.setAttribute('aria-haspopup', 'menu');
          button.onclick = () => {
            const old = document.querySelector('[role="menu"]');
            if (old) { old.remove(); return; }
            const mount = () => {
              const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-labelledby', button.id);
              menu.innerHTML = '<div role="menuitem">First</div><div role="menuitemradio">Second</div><div role="menuitem">Third</div>';
              menu.onkeydown = (event) => { if (event.key === 'Escape') menu.remove(); };
              document.body.append(menu);
            };
            if (mountDelay) setTimeout(mount, mountDelay); else mount();
          };
          main.append(button);
        }
      }, mountDelay);
      await page.addScriptTag({ content: source });
      const result = await page.evaluate(async () => {
        const started = performance.now();
        const found = await menuHelpers.discoverMenus();
        return { ms: performance.now() - started, items: found.length };
      });
      if (result.items !== 18) throw new Error(`Expected 18 items, got ${result.items}`);
      times.push(Math.round(result.ms));
      await page.close();
    }
    console.log(JSON.stringify({ version, scenario: '6 menus, 500 unrelated buttons, 18 menu items', mountDelayMs: mountDelay, runsMs: times, medianMs: [...times].sort((a, b) => a - b)[1] }));
  }
} finally {
  await browser.close();
}
