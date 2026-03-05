import esbuild from 'esbuild';
import process from 'process';
import builtins from 'builtin-modules';
import { copyFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const prod = process.argv[2] === 'production';

const banner = `/*
  PDF Canvas AI — Obsidian Plugin
  Built with esbuild. Source: https://github.com/voidash/obsidian-pdf-canvas-ai
*/`;

// Copy pdfjs worker file alongside the plugin so it can be loaded as a Web Worker.
// The worker is NOT bundled into main.js to keep load times reasonable.
function copyPdfjsWorker() {
  try {
    const pdfjsPath = dirname(require.resolve('pdfjs-dist/package.json'));
    const workerSrc = resolve(pdfjsPath, 'build/pdf.worker.min.js');
    const workerDst = resolve(__dirname, 'pdf.worker.min.js');
    if (existsSync(workerSrc)) {
      copyFileSync(workerSrc, workerDst);
      console.log('[esbuild] Copied pdf.worker.min.js');
    } else {
      console.warn('[esbuild] pdf.worker.min.js not found at', workerSrc);
    }
  } catch (e) {
    console.warn('[esbuild] Could not copy pdfjs worker:', e.message);
  }
}

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  plugins: [
    {
      name: 'on-end',
      setup(build) {
        build.onEnd(() => {
          copyPdfjsWorker();
        });
      },
    },
  ],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
