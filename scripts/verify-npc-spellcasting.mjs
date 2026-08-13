// Live verification: NPC spellcasting support — updateActor's `spellcasting` group
// (src/page/actors.ts): caster level + casting ability.
//
// Background: dnd5e RECOMPUTES system.spells.spellN.max every prepareDerivedData cycle, so a tool
// that writes .max directly does not stick — the pool reads back "<value>/0" and a long rest
// restores it to 0. The NPC sheet's "Spellcasting Level" (system.attributes.spell.level) is what
// the max actually derives from. This script proves that end to end against a live world.
//
// Claims under test:
//   1. spellcasting.level writes system.attributes.spell.level on an NPC.
//   2. Setting it makes the DERIVED slot max REAL (the whole point): a level-3 NPC caster reads
//      back spell1.max 4 / spell2.max 2 off the full-caster table — not 0.
//   3. spellcasting.ability writes system.attributes.spellcasting AND moves the derived
//      attributes.spell.dc (8 + prof + mod), so an INT 16 NPC reads DC 13 instead of DC 10.
//   4. level 0 clears slot casting (the 2024-MM default, where monsters use 1/Day free casts).
//   5. The group is NPC-only: on a player character it is skipped with a warning and writes nothing.
//   6. Regression on the bug that motivated this: writing .max directly does NOT survive
//      derivation, but the caster level does.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixture actors,
// cleaned in finally.
// Build first: npm run build. Run: node scripts/verify-npc-spellcasting.mjs
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

const TAG = 'ZZ-NPCCASTTEST';
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

let npcId;
let pcId;

// Read the LIVE (derived) casting state, not source data — that is the whole point of the test.
const liveCasting = id =>
  f.evaluate(aid => {
    const a = game.actors.get(aid);
    const s = a?.system;
    return {
      level: s?.attributes?.spell?.level ?? null,
      ability: s?.attributes?.spellcasting ?? null,
      dc: s?.attributes?.spell?.dc ?? null,
      slot1max: s?.spells?.spell1?.max ?? null,
      slot2max: s?.spells?.spell2?.max ?? null,
      slot3max: s?.spells?.spell3?.max ?? null,
    };
  }, id);

try {
  console.log('[verify-npc-spellcasting] connecting…');
  await f.connect();
  console.log('[verify-npc-spellcasting] connected\n');

  console.log('# setup fixtures (throwaway NPC with INT 16, throwaway PC)');
  ({ npcId, pcId } = await f.evaluate(async tag => {
    const npc = await Actor.create({
      name: tag,
      type: 'npc',
      system: { abilities: { int: { value: 16 } }, details: { cr: 3 } },
    });
    const pc = await Actor.create({ name: `${tag}-PC`, type: 'character' });
    return { npcId: npc.id, pcId: pc.id };
  }, TAG));
  console.log(`  npc ${npcId} · pc ${pcId}\n`);

  console.log('# 0) baseline — a fresh NPC is not a slot caster');
  const base = await liveCasting(npcId);
  console.log(`  baseline: ${JSON.stringify(base)}`);
  assert(!base.level, 'baseline caster level is 0/unset');
  assert(!base.slot1max, 'baseline spell1.max is 0 — no derived pool');

  console.log('\n# 6) REGRESSION: writing spells.spellN.max directly does NOT survive derivation');
  await f.evaluate(async aid => {
    await game.actors.get(aid).update({ 'system.spells.spell1.max': 4 });
  }, npcId);
  const afterRawMax = await liveCasting(npcId);
  assert(
    !afterRawMax.slot1max,
    `a directly-written .max is clobbered by prepareDerivedData (reads ${afterRawMax.slot1max}) — this is the bug the tool fixes`
  );

  console.log('\n# 1+2) spellcasting.level writes attributes.spell.level AND derives real slots');
  const r1 = await f.call('updateActor', {
    actorIdentifier: npcId,
    spellcasting: { level: 3 },
  });
  assert(r1.applied?.includes('spellcasting.level'), 'reports spellcasting.level applied');
  const lvl3 = await liveCasting(npcId);
  console.log(`  after level 3: ${JSON.stringify(lvl3)}`);
  assert(lvl3.level === 3, `attributes.spell.level is 3 (got ${lvl3.level})`);
  assert(lvl3.slot1max === 4, `spell1.max DERIVES to 4 (got ${lvl3.slot1max})`);
  assert(lvl3.slot2max === 2, `spell2.max DERIVES to 2 (got ${lvl3.slot2max})`);
  assert(!lvl3.slot3max, `spell3.max stays 0 at caster level 3 (got ${lvl3.slot3max})`);

  console.log('\n# 3) spellcasting.ability writes the ability AND moves the derived save DC');
  const dcBefore = lvl3.dc;
  const r3 = await f.call('updateActor', {
    actorIdentifier: npcId,
    spellcasting: { ability: 'int' },
  });
  assert(r3.applied?.includes('spellcasting.ability'), 'reports spellcasting.ability applied');
  const withAbility = await liveCasting(npcId);
  console.log(`  after ability=int: ${JSON.stringify(withAbility)}`);
  assert(withAbility.ability === 'int', `attributes.spellcasting is "int" (got ${withAbility.ability})`);
  assert(
    withAbility.dc === 13,
    `derived spell DC is 13 for an INT 16 / prof +2 NPC (was ${dcBefore}, got ${withAbility.dc})`
  );

  console.log('\n# 4) level 0 clears slot casting (the 2024-MM free-cast default)');
  await f.call('updateActor', { actorIdentifier: npcId, spellcasting: { level: 0 } });
  const cleared = await liveCasting(npcId);
  assert(cleared.level === 0, `caster level back to 0 (got ${cleared.level})`);
  assert(!cleared.slot1max, `slot pools collapse to 0 (got ${cleared.slot1max})`);

  console.log('\n# 5) PC gate — NPC-only, skipped with a warning, writes nothing');
  let pcWarn = '';
  try {
    const rpc = await f.call('updateActor', {
      actorIdentifier: pcId,
      spellcasting: { level: 5, ability: 'wis' },
    });
    pcWarn = (rpc.warnings ?? []).join(' | ');
    assert(
      !(rpc.applied ?? []).some(a => a.startsWith('spellcasting')),
      'nothing from the spellcasting group is reported applied on a PC'
    );
  } catch (e) {
    pcWarn = String(e?.message ?? e);
  }
  assert(pcWarn.includes('NPC-only'), `PC write skips with an NPC-only warning (${pcWarn || 'none'})`);
  const pcState = await liveCasting(pcId);
  assert(pcState.ability !== 'wis', `PC casting ability untouched (got ${pcState.ability})`);

  console.log(`\n[verify-npc-spellcasting] ${passes} passed, ${fails} failed`);
} finally {
  try {
    await f.evaluate(async ids => {
      for (const id of ids) {
        const a = game.actors.get(id);
        if (a) await a.delete();
      }
    }, [npcId, pcId].filter(Boolean));
  } catch (e) {
    console.error('[verify-npc-spellcasting] cleanup failed:', e?.message ?? e);
  }
  await f.disconnect?.();
  process.exit(fails === 0 ? 0 : 1);
}
