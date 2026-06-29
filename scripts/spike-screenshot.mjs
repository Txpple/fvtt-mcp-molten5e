// Verify the SHIPPED screenshot-scene path against the live world via dist/ (no CC restart):
//   foundry.call('prepareSceneShot', {sceneIdentifier, fit, mark})  (page-side view+fit+overlay)
//   -> foundry.screenshot(outPath)                                  (bridge-side page.screenshot)
// Proves the headless WebGL canvas renders + the new bridge seam method + the page fn end to end.
// Also the driver for the legend-pin nudge pass (mark:true draws numbered markers on the pins).
// Requires a build first (dist/). Run: node scripts/spike-screenshot.mjs <sceneId> <outPath> [nomark]
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
const sceneId = process.argv[2] || 'bGQhm7np8dckuxYv'; // Storage Cave
const outPath = process.argv[3] || join(__dirname, 'spike-shot.png');
const mark = process.argv[4] !== 'nomark'; // default: draw pin markers

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let ok = false;
try {
  await f.connect();
  // SHIPPED page fn: view + fit + (optional) numbered marker overlay on the note pins.
  const meta = await f.call('prepareSceneShot', { sceneIdentifier: sceneId, fit: true, mark });
  console.log('[shot] prepareSceneShot:', JSON.stringify(meta));
  if (!meta?.found) throw new Error(`scene not found: ${sceneId}`);
  // SHIPPED bridge seam method: Playwright page.screenshot to a file.
  await f.screenshot(outPath);
  console.log('[shot] wrote', outPath);
  ok = meta.renderer === 'WebGL';
} catch (e) {
  console.error('[shot] ERROR:', e?.stack || e?.message || e);
} finally {
  await f.dispose();
  console.log(ok ? '[shot] RESULT: rendered (WebGL)' : '[shot] RESULT: see above');
  process.exit(ok ? 0 : 1);
}
