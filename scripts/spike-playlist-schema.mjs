// Spike: v14 Playlist / PlaylistSound schema ground truth (READ-ONLY).
// Confirms, against the live `sandbox` world (Foundry 14.364):
//   1) Playlist document schema field keys + CONST.PLAYLIST_MODES (sequential/shuffle/etc.).
//   2) PlaylistSound (embedded) schema — is the audio file field `path` or `src` in v14? (createPlaylist
//      writes `path` — if v14 renamed it to `src`, that's a silent bug like the RollTable `text` one.)
// Standalone (no project deps): hand-parses .env, uses only playwright. Mirrors the other spikes.
// Run: node scripts/spike-playlist-schema.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const txt = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2];
  }
  return env;
}
const env = loadEnv();
const BASE = env.MOLTEN_SERVER_URL?.replace(/\/$/, '');
const MAGIC = env.MOLTEN_MAGIC_URL;
const USER = env.FOUNDRY_USER || 'Claude';
if (!BASE) throw new Error('MOLTEN_SERVER_URL missing from .env');
const log = (...a) => console.log('[spike]', ...a);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.setDefaultTimeout(120_000);
let ok = false;
try {
  if (MAGIC) {
    log('waking via Magic URL...');
    await page
      .goto(MAGIC, { waitUntil: 'domcontentloaded' })
      .catch(e => log('magic note:', e.message));
  }
  let joined = false;
  for (let attempt = 1; attempt <= 12 && !joined; attempt++) {
    await page.goto(`${BASE}/join`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const found = await page
      .waitForSelector('select[name="userid"]', { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    log(`  attempt ${attempt}: userid=${found}`);
    if (found) joined = true;
  }
  if (!joined) throw new Error('No /join userid form.');
  await page.evaluate(label => {
    const sel = document.querySelector('select[name="userid"]');
    const opt = [...sel.options].find(o => o.textContent?.trim() === label);
    if (!opt) throw new Error(`user "${label}" not in dropdown`);
    opt.disabled = false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, USER);
  await page.locator('button[name="join"], button[type="submit"]').first().click();
  const ready = await page
    .waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120_000 })
    .then(() => 'ready')
    .catch(() => 'timeout');
  if (ready !== 'ready') throw new Error(`Join did not reach game.ready: ${ready}`);
  log('game.ready — running probes...');

  const probe = await page.evaluate(async () => {
    const fieldInfo = schema => {
      const fields = schema?.fields || {};
      return Object.fromEntries(
        Object.keys(fields).map(k => [
          k,
          { type: fields[k]?.constructor?.name, required: fields[k]?.required },
        ])
      );
    };
    return {
      world: { foundry: game.version },
      PLAYLIST_MODES: CONST?.PLAYLIST_MODES,
      playlistFields: fieldInfo(CONFIG.Playlist?.documentClass?.schema),
      playlistSoundFields: fieldInfo(CONFIG.PlaylistSound?.documentClass?.schema),
    };
  });

  log('PROBE RESULT:\n' + JSON.stringify(probe, null, 2));
  ok = true;
} catch (err) {
  log('SPIKE FAILED:', err?.message || err);
} finally {
  await browser.close();
  log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}
