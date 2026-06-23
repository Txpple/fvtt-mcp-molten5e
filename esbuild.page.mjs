// Bundle the page-side domain library (src/page/**) into a single IIFE that
// src/foundry.ts injects into the headless Foundry page. Output: dist/page.bundle.js.
// Pass --watch to rebuild on change (used by `npm run dev:page` — edits under src/page/**
// don't reach the running server until this bundle is rebuilt).
import { build, context } from 'esbuild';

const options = {
  entryPoints: ['src/page/index.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/page.bundle.js',
  legalComments: 'none',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.error('[esbuild] watching src/page/** → dist/page.bundle.js');
} else {
  await build(options);
}
