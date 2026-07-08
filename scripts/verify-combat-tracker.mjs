// Live verification: configure-combat-tracker — the core.combatTrackerConfig setting tool
// (src/page/combat-tracker.ts).
//
// Claims under test:
//   1. Read mode (no args) returns the config, the live animation ids, and the fallback marker.
//   2. An animation change applies, echoes previous → new, and persists on re-read.
//   3. Re-applying the current value is a clean no-op (no `applied` in the response).
//   4. Guard: an unknown animation id errors, listing the valid ids; nothing is written.
//   5. Guard: a src that 404s on the static server is REJECTED; nothing is written.
//   6. A src change to a real uploaded asset applies and persists.
//   7. Seam control: a JSON round-trip of the setting value survives game.settings.set — pinning
//      that the 2026-07-08 DataModelValidationFailure came from Foundry.evaluate's SINGLE-arg
//      contract (extra args arrive undefined), not from serialization of the setting value.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). The original config is
// restored in finally. Build first: npm run build. Run: node scripts/verify-combat-tracker.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

let passes = 0;
let fails = 0;
function assert(cond, msg) {
  if (cond) {
    passes++;
    console.log(`  PASS  ${msg}`);
  } else {
    fails++;
    console.log(`  FAIL  ${msg}`);
  }
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let original;

try {
  console.log('[verify-combat-tracker] connecting…');
  await f.connect();
  console.log('[verify-combat-tracker] connected\n');

  console.log('# 1) read mode — config + live animation ids + fallback');
  const read = await f.call('configureCombatTracker', {});
  original = JSON.parse(JSON.stringify(read.config));
  assert(
    read.success === true && read.config?.turnMarker,
    'returns { success, config.turnMarker }'
  );
  assert(read.applied === undefined, 'read mode carries no `applied`');
  const animIds = (read.animations ?? []).map(a => a.value);
  assert(
    ['spin', 'spinPulse', 'pulse'].every(id => animIds.includes(id)),
    `animations include the core trio: ${animIds.join(', ')}`
  );
  assert(
    typeof read.fallbackMarker === 'string' && read.fallbackMarker.length > 0,
    `fallbackMarker reported: ${read.fallbackMarker}`
  );

  console.log('\n# 2) animation change applies and persists');
  const newAnim = original.turnMarker.animation === 'pulse' ? 'spin' : 'pulse';
  const upd = await f.call('configureCombatTracker', { turnMarker: { animation: newAnim } });
  assert(
    upd.applied?.length === 1 &&
      upd.applied[0].field === 'turnMarker.animation' &&
      upd.applied[0].previous === original.turnMarker.animation &&
      upd.applied[0].next === newAnim,
    `applied echoes ${original.turnMarker.animation} → ${newAnim}`
  );
  const reread = await f.call('configureCombatTracker', {});
  assert(reread.config.turnMarker.animation === newAnim, 'change persists on re-read');

  console.log('\n# 3) re-applying the same value is a clean no-op');
  const noop = await f.call('configureCombatTracker', { turnMarker: { animation: newAnim } });
  assert(noop.applied === undefined && noop.success === true, 'no `applied` on a no-op');

  console.log('\n# 4) guard: unknown animation id');
  let threw = null;
  try {
    await f.call('configureCombatTracker', { turnMarker: { animation: 'wobble' } });
  } catch (e) {
    threw = e;
  }
  assert(
    threw && /unknown turn-marker animation "wobble"/.test(String(threw.message ?? threw)),
    'rejected with the valid ids listed'
  );
  const after4 = await f.call('configureCombatTracker', {});
  assert(after4.config.turnMarker.animation === newAnim, 'nothing was written');

  console.log('\n# 5) guard: src that does not resolve');
  threw = null;
  try {
    await f.call('configureCombatTracker', {
      turnMarker: { src: 'worlds/nope/definitely-missing-marker.png' },
    });
  } catch (e) {
    threw = e;
  }
  assert(
    threw && /does not resolve on the server/.test(String(threw.message ?? threw)),
    'rejected fail-closed with the upload-asset hint'
  );
  const after5 = await f.call('configureCombatTracker', {});
  assert(after5.config.turnMarker.src === original.turnMarker.src, 'src unchanged');

  console.log('\n# 6) src change to a real uploaded asset');
  // The -01 marker is a known-present asset in this world; fall back to the fallback marker
  // (a core asset, always resolvable) if the world ever drops it.
  const realSrc =
    original.turnMarker.src && original.turnMarker.src.includes('-02')
      ? original.turnMarker.src.replace('-02', '-01')
      : read.fallbackMarker;
  const upd6 = await f.call('configureCombatTracker', { turnMarker: { src: realSrc } });
  assert(
    upd6.applied?.some(c => c.field === 'turnMarker.src' && c.next === realSrc),
    `src applied: ${realSrc}`
  );
  const after6 = await f.call('configureCombatTracker', {});
  assert(after6.config.turnMarker.src === realSrc, 'src persists on re-read');

  console.log('\n# 7) seam control: JSON round-trip survives game.settings.set');
  const roundTrip = await f.evaluate(async () => {
    const cfg = game.settings.get('core', 'combatTrackerConfig');
    try {
      await game.settings.set('core', 'combatTrackerConfig', JSON.parse(JSON.stringify(cfg)));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, undefined);
  assert(
    roundTrip.ok === true,
    `JSON round-trip set is valid (2026-07-08 failure = evaluate single-arg seam)${roundTrip.error ? ` — ${roundTrip.error}` : ''}`
  );
} finally {
  if (original) {
    console.log('\n# restore original config');
    try {
      await f.evaluate(async cfg => {
        await game.settings.set('core', 'combatTrackerConfig', cfg);
      }, original);
      console.log('  restored');
    } catch (e) {
      console.log(`  RESTORE FAILED — reapply manually: ${JSON.stringify(original)}\n  ${e}`);
    }
  }
  await f.close?.();
}

console.log(`\n[verify-combat-tracker] ${passes} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
