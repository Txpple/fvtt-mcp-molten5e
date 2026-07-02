// Phase-1 proof: exercise the real foundry.ts seam end to end.
//   foundry.connect() -> foundry.call('getWorldInfo') / call('listActors') against live Molten.
// Requires a build first: `npm run build` (tsc) + `node esbuild.page.mjs`.
// Run: node scripts/prove-bridge.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const txt = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  password: env.FOUNDRY_PASSWORD,
});

let ok = false;
try {
  await f.connect();
  const info = await f.call('getWorldInfo');
  console.log('[prove] getWorldInfo:', JSON.stringify(info, null, 2));
  const actors = await f.call('listActors', {});
  console.log(`[prove] listActors: ${actors.length} -> ${actors.map(a => a.name).join(', ')}`);
  ok = info?.worldId && Array.isArray(actors);
} catch (e) {
  console.error('[prove] ERROR:', e?.message || e);
} finally {
  await f.dispose();
  console.log(ok ? '[prove] RESULT: PASS' : '[prove] RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}
