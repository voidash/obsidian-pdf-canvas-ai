import esbuild from 'esbuild';
import process from 'process';
import builtins from 'builtin-modules';
import { readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const prod = process.argv[2] === 'production';

const banner = `/*
  PDF Tools — Obsidian Plugin
  Built with esbuild. Source: https://github.com/voidash/obsidian-pdf-tools
*/`;

/**
 * esbuild plugin: resolves `import workerText from 'pdfjs-worker-inline'`
 * to the contents of pdf.worker.min.js as a string export.
 * This lets us create a Blob URL at runtime instead of shipping a separate file.
 */
function pdfjsWorkerInlinePlugin() {
  return {
    name: 'pdfjs-worker-inline',
    setup(build) {
      build.onResolve({ filter: /^pdfjs-worker-inline$/ }, () => ({
        path: 'pdfjs-worker-inline',
        namespace: 'pdfjs-worker',
      }));
      build.onLoad({ filter: /.*/, namespace: 'pdfjs-worker' }, () => {
        const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.min.js');
        const content = readFileSync(workerPath, 'utf8');
        return {
          contents: `module.exports = ${JSON.stringify(content)};`,
          loader: 'js',
        };
      });
    },
  };
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
    pdfjsWorkerInlinePlugin(),
  ],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
