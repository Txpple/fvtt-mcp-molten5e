// Register ANY house module with the RUNNING Foundry server via its own package installer.
//
// Generalized from register-partystash.mjs (2026-08-07), which proved the mechanism; the only
// difference is that the module id and manifest are arguments instead of constants.
//
//   node scripts/register-module.mjs --id fvtt-mod-lootshelf \
//     --manifest https://github.com/Txpple/fvtt-mod-lootshelf/releases/latest/download/module.json
//
// Why this exists (learned live 2026-08-07): on this box Foundry scans Data/modules at server
// PROCESS start only — WebDAV-dropping a new module + world shutDown/relaunch never registers
// it (two live attempts). The Molten panel Restart is UI-only. The sanctioned lever is
// Foundry's /setup POST {action:'installPackage'} — what the UI "Install Module" button does —
// which downloads from our GitHub manifest, extracts into Data/modules (overwriting the
// identical WebDAV copy), and updates the live package cache.
//
// HARD-WON HANG LESSON baked in here: do NOT call game.shutDown() through the bridge
// (dist/foundry.js) — its self-healing evaluate wrapper tries to recover the world you are
// deliberately killing and never settles (three multi-hour hangs on 2026-08-07). This script
// is pure Playwright: admin /setup -> shutdownWorld -> installPackage -> launchWorld, every
// remote call raced against a timeout, plus a process-level watchdog. Leaves the world UP.
//
// NOTE: installing does not ENABLE the module in the world — that is a separate
// core.moduleConfiguration write (see enable-module.mjs). Run FOREGROUND.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const MODULE_ID = arg('id');
const MANIFEST = arg('manifest');
if (!MODULE_ID || !MANIFEST) {
  console.error('usage: node scripts/register-module.mjs --id <module-id> --manifest <url>');
  process.exit(2);
}
const BASE = env.MOLTEN_SERVER_URL.replace(/\/$/, '');
console.log(`[register] module=${MODULE_ID}\n[register] manifest=${MANIFEST}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Nothing in this script may run past 4 minutes, ever.
setTimeout(() => {
  console.error('[register] WATCHDOG: 240s elapsed — hard abort');
  process.exit(3);
}, 240_000);

async function joinState() {
  try {
    const res = await fetch(`${BASE}/join`, { redirect: 'manual' });
    if (res.status >= 300) return 'redirect';
    const text = await res.text();
    if (/no active game session|Critical Failure/i.test(text)) return 'no-world';
    return 'world';
  } catch {
    return 'unreachable';
  }
}

/** Evaluate a Setup post in the page, raced against a timeout so it can never wedge us. */
async function setupPost(page, body, label, timeoutMs = 30_000) {
  const result = await page.evaluate(
    async ({ body, timeoutMs }) => {
      const timeout = new Promise(r =>
        setTimeout(() => r({ ok: false, error: 'in-page timeout' }), timeoutMs)
      );
      const post = (async () => {
        try {
          const res = await globalThis.game.post(body);
          return {
            ok: true,
            res: (() => {
              try {
                return JSON.stringify(res).slice(0, 300);
              } catch {
                return String(res);
              }
            })(),
          };
        } catch (err) {
          return { ok: false, error: String(err?.message || err) };
        }
      })();
      return Promise.race([post, timeout]);
    },
    { body, timeoutMs }
  );
  console.log(`[register] ${label}:`, JSON.stringify(result));
  return result;
}

/**
 * Get to an authenticated /setup page. Two live states (v14.364, probed 2026-08-07):
 *  - world ACTIVE: /setup redirects to /join, which carries a "Return to Setup" admin form
 *    (#join-game-setup: input[name=adminPassword] + unnamed submit button). Submitting it
 *    authenticates AND shuts the world down in one supported step.
 *  - world IDLE: /setup -> /auth with its own adminPassword form.
 */
async function ensureSetup(page) {
  await page.goto(`${BASE}/setup`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector(
    '#join-game-setup input[name="adminPassword"], input[name="adminPassword"]',
    { timeout: 60_000 }
  );
  const viaJoin = await page.$('#join-game-setup input[name="adminPassword"]');
  if (viaJoin) {
    console.log('[register] world active — submitting the join page "Return to Setup" form');
    await viaJoin.fill(env.MOLTEN_ADMIN_KEY);
    await page.click('#join-game-setup button[type="submit"]');
    // v14 pops a confirm dialog when other users are connected ("… will be disconnected.
    // Do you wish to proceed? Yes/No") — answer Yes.
    const confirmed = await page
      .waitForFunction(
        () => {
          const btn = [...document.querySelectorAll('dialog button')].find(
            b => b.textContent.trim().toLowerCase() === 'yes'
          );
          if (btn) {
            btn.click();
            return 'clicked';
          }
          return false;
        },
        null,
        { timeout: 15_000 }
      )
      .catch(() => null);
    console.log(
      `[register] disconnect-confirm dialog: ${confirmed ? 'answered Yes' : 'did not appear'}`
    );
  } else {
    console.log('[register] idle auth form — logging in');
    await page.fill('input[name="adminPassword"]', env.MOLTEN_ADMIN_KEY);
    await page.click(
      'button[name="action"], form:has(input[name="adminPassword"]) button[type="submit"]'
    );
  }
  await page.waitForURL(/\/setup/, { timeout: 90_000 });
  await page.waitForFunction(() => typeof globalThis.game?.post === 'function', null, {
    timeout: 45_000,
  });
}

const browser = await chromium.launch();
let ok = false;
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('console', msg => {
    const t = msg.text();
    if (/error|install|package|progress|vend/i.test(t)) console.log(`  [page] ${t.slice(0, 200)}`);
  });

  console.log(`[register] initial state: ${await joinState()}`);
  console.log('[register] authenticating to /setup…');
  await ensureSetup(page);
  console.log('[register] on /setup as admin');

  // --- 1. world down: the Return-to-Setup submit in ensureSetup already did it when the world
  // was active; belt-and-suspenders check that we really are idle before posting.
  {
    let state = await joinState();
    for (let i = 0; i < 10 && state === 'world'; i++) {
      await sleep(3000);
      state = await joinState();
    }
    console.log(`[register] pre-install state: ${state}`);
    if (state === 'world') throw new Error('world still active after Return to Setup');
  }

  // --- 2. installPackage -----------------------------------------------------------------------
  const install = await setupPost(
    page,
    { action: 'installPackage', type: 'module', id: MODULE_ID, manifest: MANIFEST },
    'installPackage',
    90_000
  );
  if (!install.ok) throw new Error(`installPackage failed: ${install.error}`);
  await sleep(15_000); // extraction/vend settle — house-module zips are tens of KB

  // --- 3. relaunch the world -------------------------------------------------------------------
  const launch = await setupPost(
    page,
    { action: 'launchWorld', world: env.MOLTEN_WORLD_ID },
    'launchWorld'
  );
  if (!launch.ok) throw new Error(`launchWorld failed: ${launch.error}`);

  console.log('[register] waiting for /join form…');
  await page.goto(`${BASE}/join`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('select[name="userid"]', { timeout: 150_000 });
  console.log('[register] world is up and joinable');
  ok = true;
} catch (e) {
  console.error('[register] ERROR:', e?.message || e);
} finally {
  await browser.close();
  console.log(ok ? '[register] RESULT: PASS' : '[register] RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}
