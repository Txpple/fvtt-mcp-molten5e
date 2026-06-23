// Phase-1 spike: prove the headless-Chromium premise end to end.
//   wake (Magic URL) -> /join as passwordless Claude user -> game.ready -> one real round-trip.
// Standalone, no project deps: parses .env by hand, uses only `playwright`.
// Run: node scripts/spike-headless.mjs
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
const shot = async (page, name) => {
  try {
    await page.screenshot({ path: join(__dirname, `spike-${name}.png`), fullPage: false });
    log(`screenshot -> scripts/spike-${name}.png`);
  } catch {}
};

const browser = await chromium.launch({ headless: true });
// Foundry requires >= 1366x768; give it a comfortable desktop viewport.
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.setDefaultTimeout(120_000);
let ok = false;

try {
  // 1) Wake the (possibly sleeping) Molten box via the Magic URL, then give it a beat.
  if (MAGIC) {
    log('waking via Magic URL...');
    await page
      .goto(MAGIC, { waitUntil: 'domcontentloaded' })
      .catch(e => log('magic nav note:', e.message));
  }

  // 2) Poll /join until the Foundry login form appears (cold start can take a while).
  log('navigating to /join ...');
  let joined = false;
  for (let attempt = 1; attempt <= 12 && !joined; attempt++) {
    await page.goto(`${BASE}/join`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    log(`  attempt ${attempt}: url=${page.url()} title="${await page.title().catch(() => '?')}"`);
    const hasForm = await page
      .locator('select[name="userid"]')
      .count()
      .catch(() => 0);
    if (hasForm) {
      joined = true;
      break;
    }
    await page.waitForTimeout(5000);
  }

  await shot(page, 'join');

  // Diagnostic dump so we can adapt selectors if v14 markup differs.
  const diag = await page
    .evaluate(() => {
      const sel = document.querySelector('select[name="userid"]');
      return {
        hasUserSelect: !!sel,
        options: sel
          ? [...sel.options].map(o => ({
              text: o.textContent?.trim(),
              value: o.value,
              disabled: o.disabled,
            }))
          : [],
        hasPassword: !!document.querySelector('input[name="password"]'),
        buttons: [...document.querySelectorAll('button')]
          .map(b => (b.textContent || '').trim())
          .filter(Boolean),
        bodyClass: document.body?.className || '',
      };
    })
    .catch(e => ({ error: e.message }));
  log('join page diag:', JSON.stringify(diag));

  if (!diag.hasUserSelect) {
    throw new Error(
      'No user-select on /join — world may not be active (check /setup) or markup differs. See screenshot.'
    );
  }
  const target = diag.options.find(o => o.text === USER);
  if (!target) {
    throw new Error(
      `User "${USER}" not in dropdown. Available: ${JSON.stringify(diag.options.map(o => o.text))}`
    );
  }
  if (target.disabled)
    log(`NOTE: option "${USER}" is DISABLED (likely flagged active/logged-in) — forcing.`);

  // 3) Select the user (force-enable the option if Foundry disabled it) and join.
  log(`selecting user "${USER}" and joining...`);
  await page.evaluate(label => {
    const sel = document.querySelector('select[name="userid"]');
    const opt = [...sel.options].find(o => o.textContent?.trim() === label);
    if (!opt) throw new Error('option vanished');
    opt.disabled = false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, USER);
  // Password left blank (passwordless). Submit the join form.
  const joinBtn = page.locator('button[name="join"], button[type="submit"]').first();
  await joinBtn.click();

  // 4) Wait for game.ready — or surface a join error (e.g. "already logged in").
  log('waiting for game.ready ...');
  const ready = await Promise.race([
    page
      .waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120_000 })
      .then(() => 'ready'),
    (async () => {
      for (let i = 0; i < 60; i++) {
        const errs = await page
          .evaluate(() =>
            [...document.querySelectorAll('.notification.error, p.error')]
              .map(e => e.textContent?.trim())
              .filter(Boolean)
          )
          .catch(() => []);
        if (errs.length) return 'error:' + errs.join(' | ');
        await page.waitForTimeout(2000);
      }
      return 'timeout';
    })(),
  ]);
  if (ready !== 'ready') {
    await shot(page, 'fail');
    throw new Error(`Join did not reach game.ready: ${ready}`);
  }

  // 5) One real round-trip: read world/system/user facts.
  const info = await page.evaluate(() => ({
    worldId: game.world?.id,
    worldTitle: game.world?.title,
    system: game.system?.id,
    systemVersion: game.system?.version,
    foundryVersion: game.version ?? game.data?.version,
    userName: game.user?.name,
    isGM: game.user?.isGM,
    actors: game.actors?.size,
    packs: game.packs?.size,
  }));
  log('ROUND-TRIP OK:', JSON.stringify(info, null, 2));
  await shot(page, 'ready');
  ok = true;
} catch (err) {
  log('SPIKE FAILED:', err?.message || err);
  await shot(page, 'fail');
} finally {
  await browser.close();
  log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}
