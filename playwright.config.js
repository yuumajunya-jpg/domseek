import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const installedBrowser = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    headless: true,
    launchOptions: installedBrowser ? { executablePath: installedBrowser } : {},
  },
});
