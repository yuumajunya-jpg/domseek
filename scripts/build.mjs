import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/content.js', 'src/background.js'],
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  loader: { '.css': 'text' },
  sourcemap: true,
});
await copyFile('extension/manifest.json', 'dist/manifest.json');
await copyFile('node_modules/fuse.js/LICENSE', 'dist/FUSE-LICENSE.txt');
