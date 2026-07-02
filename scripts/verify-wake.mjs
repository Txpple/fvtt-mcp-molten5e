// Live acceptance: prove the bridge auto-recovers a COLD box end to end.
//   Phase 1: take the world DOWN (GM game.shutDown) to create the cold "no world" state.
//   Phase 2: a fresh bridge.connect() must, with NO human steps, wake the box -> detect
//            'no world active' -> launch the world via admin /setup (game.post) -> join ->
//            game.ready, then round-trip getWorldInfo.
// Needs .env with MOLTEN_* and FOUNDRY_USER as a GM. Run: node scripts/verify-wake.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const txt = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const cfg = {
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
};
const base = cfg.serverUrl.replace(/\/$/, '');
const stamp = () => new Date().toISOString().slice(11, 19);
const log = {
  debug: m => console.log(`    ${stamp()} [foundry] ${m}`),
  info: m => console.log(`    ${stamp()} [foundry] ${m}`),
  warn: m => console.log(`    ${stamp()} [foundry] WARN: ${m}`),
  error: m => console.log(`    ${stamp()} [foundry] ERR: ${m}`),
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function isDown() {
  try {
    const t = await (await fetch(`${base}/join`, { redirect: 'follow' })).text();
    return /no active game session/i.test(t);
  } catch {
    return false;
  }
}

// ---- Phase 1: take the world down ---------------------------------------------------------
console.log('PHASE 1 — take the running world down to create the cold state');
const shutter = new Foundry(cfg, log);
await shutter.connect();
const probe = await shutter.evaluate(() => {
  const g = globalThis.game;
  const has = n => typeof g?.[n] === 'function';
  return { isGM: g?.user?.isGM ?? false, shutDown: has('shutDown'), logOut: has('logOut') };
}, null);
console.log(
  '  bridge user:',
  cfg.user,
  '| isGM:',
  probe.isGM,
  '| has game.shutDown:',
  probe.shutDown
);
if (!probe.isGM || !probe.shutDown) {
  console.log(
    '  ABORT (safe): need a GM with game.shutDown(). Click "Return to Setup" manually, then re-run.'
  );
  await shutter.dispose();
  process.exit(2);
}
console.log('  firing game.shutDown() (returns the world to setup) ...');
await shutter.evaluate(() => globalThis.game.shutDown(), null).catch(() => {});
await shutter.dispose();

let down = false;
for (let i = 0; i < 36 && !down; i++) {
  await sleep(5000);
  if (await isDown()) {
    down = true;
    console.log(`  world is DOWN ("no active game session") after ~${(i + 1) * 5}s`);
  }
}
if (!down) {
  console.log('  ABORT (safe): world did not reach the "no world" state within ~3 min.');
  process.exit(3);
}

// ---- Phase 2: cold bring-up entirely via the bridge ---------------------------------------
console.log('\nPHASE 2 — COLD bring-up via the bridge (wake -> detect no-world -> launch -> join)');
const t0 = Date.now();
const bridge = new Foundry(cfg, log);
await bridge.connect();
const info = await bridge.call('getWorldInfo');
const players = await bridge.call('getConnectedPlayers').catch(() => null);
const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n✅ COLD BRING-UP OK in ${secs}s`);
console.log(`   world="${info?.title ?? info?.worldId}"  system="${info?.system ?? '?'}"`);
console.log(
  `   connected as "${cfg.user}"; getConnectedPlayers -> ${JSON.stringify(players)?.slice(0, 120)}`
);
await bridge.dispose();
process.exit(0);
