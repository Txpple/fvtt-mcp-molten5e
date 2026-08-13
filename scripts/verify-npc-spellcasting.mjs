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

  console.log('\n# 4b) dropping the caster level CLAMPS remaining slots — no stale "4/0"');
  // NOTE: raising the caster level does NOT refill a pool — `value` is stored and only a rest
  // restores it. So fill it explicitly to set up the clamp case (a caster with a full pool).
  await f.call('updateActor', { actorIdentifier: npcId, spellcasting: { level: 3 } });
  await f.evaluate(
    aid => game.actors.get(aid).update({ 'system.spells.spell1.value': 4 }),
    npcId
  );
  const filled = await f.evaluate(
    aid => game.actors.get(aid).system.spells.spell1.value,
    npcId
  );
  assert(filled === 4, `a full L1 pool at caster level 3 reads 4 remaining (got ${filled})`);
  const dropped = await f.call('updateActor', {
    actorIdentifier: npcId,
    spellcasting: { level: 0 },
  });
  assert(
    dropped.applied?.includes('spellcasting.slotClamp'),
    'the clamp pass is reported in applied[]'
  );
  const afterDrop = await f.evaluate(
    aid => {
      const s = game.actors.get(aid).system.spells.spell1;
      return { value: s.value, max: s.max };
    },
    npcId
  );
  assert(
    afterDrop.value === 0 && afterDrop.max === 0,
    `pool reads 0/0, not a stale 4/0 (got ${afterDrop.value}/${afterDrop.max})`
  );

  console.log('\n# 4c) a partially-spent pool keeps its remaining slots (clamp only goes DOWN)');
  await f.call('updateActor', { actorIdentifier: npcId, spellcasting: { level: 3 } });
  await f.evaluate(
    aid => game.actors.get(aid).update({ 'system.spells.spell1.value': 1 }),
    npcId
  );
  await f.call('updateActor', { actorIdentifier: npcId, spellcasting: { level: 5 } });
  const spent = await f.evaluate(
    aid => {
      const s = game.actors.get(aid).system.spells.spell1;
      return { value: s.value, max: s.max };
    },
    npcId
  );
  assert(
    spent.value === 1 && spent.max === 4,
    `1 remaining of 4 survives a level RAISE (got ${spent.value}/${spent.max})`
  );
  await f.call('updateActor', { actorIdentifier: npcId, spellcasting: { level: 0 } });

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

  console.log('\n# 7) setActorSpellcasting (add-feature) now produces REAL pools, not "N/0"');
  await f.call('setActorSpellcasting', {
    actorIdentifier: npcId,
    spellcastingClass: 'wizard',
    spellcastingLevel: 3,
    effectiveAbility: 'int',
  });
  const wiz3 = await liveCasting(npcId);
  console.log(`  wizard 3: ${JSON.stringify(wiz3)}`);
  assert(wiz3.slot1max === 4, `spell1.max is 4, not 0 (got ${wiz3.slot1max})`);
  assert(wiz3.slot2max === 2, `spell2.max is 2, not 0 (got ${wiz3.slot2max})`);
  assert(wiz3.level === 3, `the NPC sheet's caster level reads 3 (got ${wiz3.level})`);
  assert(wiz3.dc === 13, `save DC 13 (got ${wiz3.dc})`);

  console.log('\n# 8) HALF-CASTER shape survives — override beats the full-caster-only derivation');
  await f.call('setActorSpellcasting', {
    actorIdentifier: npcId,
    spellcastingClass: 'ranger',
    spellcastingLevel: 5,
    effectiveAbility: 'wis',
  });
  const ranger5 = await liveCasting(npcId);
  console.log(`  ranger 5: ${JSON.stringify(ranger5)}`);
  // Ranger 5 = 4/2/0. A full-caster level 5 would be 4/3/2 — so slot2/slot3 discriminate.
  assert(ranger5.slot1max === 4, `spell1.max 4 (got ${ranger5.slot1max})`);
  assert(
    ranger5.slot2max === 2,
    `spell2.max is the HALF-caster 2, not the full-caster 3 (got ${ranger5.slot2max})`
  );
  assert(
    !ranger5.slot3max,
    `spell3.max is the HALF-caster 0, not the full-caster 2 (got ${ranger5.slot3max})`
  );

  console.log('\n# 9) warlock — pact pool is real and its slot LEVEL derives from caster level');
  await f.call('setActorSpellcasting', {
    actorIdentifier: npcId,
    spellcastingClass: 'warlock',
    spellcastingLevel: 5,
    effectiveAbility: 'cha',
  });
  const pact = await f.evaluate(aid => {
    const s = game.actors.get(aid)?.system;
    return {
      max: s?.spells?.pact?.max ?? null,
      level: s?.spells?.pact?.level ?? null,
      value: s?.spells?.pact?.value ?? null,
      spell1max: s?.spells?.spell1?.max ?? null,
    };
  }, npcId);
  console.log(`  warlock 5 pact: ${JSON.stringify(pact)}`);
  assert(pact.max === 2, `pact.max is 2 (got ${pact.max})`);
  assert(pact.level === 3, `pact slot LEVEL derives to 3 at caster level 5 (got ${pact.level})`);
  assert(!pact.spell1max, `regular slots pinned to 0 for a warlock (got ${pact.spell1max})`);

  console.log('\n# 10) the PC path still works (override pins slots on a character too)');
  await f.call('setActorSpellcasting', {
    actorIdentifier: pcId,
    spellcastingClass: 'cleric',
    spellcastingLevel: 4,
    effectiveAbility: 'wis',
  });
  const pcCaster = await liveCasting(pcId);
  console.log(`  PC cleric 4: ${JSON.stringify(pcCaster)}`);
  assert(pcCaster.slot1max === 4, `PC spell1.max 4 (got ${pcCaster.slot1max})`);
  assert(pcCaster.slot2max === 3, `PC spell2.max 3 (got ${pcCaster.slot2max})`);
  assert(
    !pcCaster.level,
    `the NPC-only caster level is NOT written on a PC (got ${pcCaster.level})`
  );

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
