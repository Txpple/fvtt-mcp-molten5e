// Live verification: 2024 Weapon Mastery support — updateActor's weaponMasteries group
// (src/page/actors.ts) + the getCharacterInfo payload the get-actor read side consumes.
//
// Claims under test:
//   1. getCharacterInfo carries system.traits.weaponProf.mastery.value (the actor-side unlock)
//      and system.mastery on weapon items (the per-weapon property) through the sanitizer.
//   2. weaponMasteries replace overwrites the whole Set; add/remove merge with the live Set.
//   3. Friendly forms normalize to the id shape ("Great Sword" → "greatsword").
//   4. An unknown weapon kind warns (soft validation) but still writes.
//   5. weaponMasteries is PC-only: on an NPC it is skipped with a warning.
//   6. The prototype consumer: Morgash the Gravemaker's live selection re-applies through the
//      tool path and reads back unchanged (greatsword / maul / battleaxe).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixture actors,
// cleaned in finally; Morgash is only touched by re-applying his existing selection.
// Build first: npm run build. Run: node scripts/verify-weapon-mastery.mjs
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

const TAG = 'ZZ-MASTERYTEST';
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
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let pcId;
let npcId;

const liveMastery = id =>
  f.evaluate(
    aid => Array.from(game.actors.get(aid)?.system?.traits?.weaponProf?.mastery?.value ?? []),
    id
  );

try {
  console.log('[verify-mastery] connecting…');
  await f.connect();
  console.log('[verify-mastery] connected\n');

  console.log('# setup fixtures (throwaway PC with a weapon, throwaway NPC)');
  ({ pcId, npcId } = await f.evaluate(async tag => {
    const pc = await Actor.create({
      name: tag,
      type: 'character',
      items: [
        {
          name: `${tag} Maul`,
          type: 'weapon',
          system: { type: { value: 'martialM', baseItem: 'maul' }, mastery: 'topple' },
        },
      ],
    });
    const npc = await Actor.create({ name: `${tag}-NPC`, type: 'npc' });
    return { pcId: pc.id, npcId: npc.id };
  }, TAG));
  console.log(`  pc ${pcId} · npc ${npcId}\n`);

  console.log('# 1) read path — mastery trait + per-weapon mastery survive getCharacterInfo');
  const info = await f.call('getCharacterInfo', { characterName: pcId });
  const traitRead = info?.system?.traits?.weaponProf?.mastery?.value;
  assert(Array.isArray(traitRead), 'traits.weaponProf.mastery.value is an array in the payload');
  const weaponRead = (info?.items ?? []).find(i => i.type === 'weapon');
  assert(weaponRead?.system?.mastery === 'topple', 'weapon item carries system.mastery');

  console.log('\n# 2) replace / add / remove');
  const r1 = await f.call('updateActor', {
    actorIdentifier: pcId,
    weaponMasteries: { mode: 'replace', values: ['greatsword', 'maul'] },
  });
  assert(r1.applied?.includes('weaponMasteries'), 'replace reports applied');
  assert(same(await liveMastery(pcId), ['greatsword', 'maul']), 'replace overwrites the Set');
  await f.call('updateActor', {
    actorIdentifier: pcId,
    weaponMasteries: { mode: 'add', values: ['battleaxe'] },
  });
  assert(
    same(await liveMastery(pcId), ['greatsword', 'maul', 'battleaxe']),
    'add merges with the live Set'
  );
  await f.call('updateActor', {
    actorIdentifier: pcId,
    weaponMasteries: { mode: 'remove', values: ['maul'] },
  });
  assert(
    same(await liveMastery(pcId), ['greatsword', 'battleaxe']),
    'remove drops only the named kind'
  );

  console.log('\n# 3) normalization — friendly names → id shape');
  await f.call('updateActor', {
    actorIdentifier: pcId,
    weaponMasteries: { mode: 'replace', values: ['Great Sword', 'Longbow', 'hand-crossbow'] },
  });
  assert(
    same(await liveMastery(pcId), ['greatsword', 'longbow', 'handcrossbow']),
    'friendly forms normalize to CONFIG.DND5E.weaponIds keys'
  );

  console.log('\n# 4) unknown kind — warns but still writes (soft validation)');
  const r4 = await f.call('updateActor', {
    actorIdentifier: pcId,
    weaponMasteries: { mode: 'replace', values: ['chainsaw'] },
  });
  assert(
    (r4.warnings ?? []).some(w => w.includes('chainsaw')),
    'unknown weapon kind produces a warning'
  );
  assert(same(await liveMastery(pcId), ['chainsaw']), 'soft validation: the value still writes');

  console.log('\n# 5) NPC gate — PC-only, skipped with a warning');
  let npcErr = '';
  try {
    await f.call('updateActor', {
      actorIdentifier: npcId,
      weaponMasteries: { mode: 'replace', values: ['greatsword'] },
    });
  } catch (e) {
    npcErr = String(e?.message ?? e);
  }
  assert(
    npcErr.includes('PC-only'),
    `NPC write skips with the PC-only warning (${npcErr || 'no error'})`
  );
  assert(same(await liveMastery(npcId), []), 'NPC trait untouched');

  console.log('\n# 6) prototype consumer — Morgash re-applies through the tool path');
  const morgashId = await f.evaluate(
    () => Array.from(game.actors).find(a => a.name.startsWith('Morgash'))?.id
  );
  const before = await liveMastery(morgashId);
  assert(
    same(before, ['greatsword', 'maul', 'battleaxe']),
    `Morgash's live selection is greatsword/maul/battleaxe (${before.join(', ')})`
  );
  const r6 = await f.call('updateActor', {
    actorIdentifier: 'Morgash the Gravemaker',
    weaponMasteries: { mode: 'replace', values: ['greatsword', 'maul', 'battleaxe'] },
  });
  assert(r6.applied?.includes('weaponMasteries'), 'tool path applies on the real PC');
  const after = await liveMastery(morgashId);
  assert(same(after, before), 'Morgash reads back unchanged');

  console.log(`\n[verify-mastery] ${passes} passed, ${fails} failed`);
} finally {
  try {
    await f.evaluate(async ids => {
      for (const id of ids) {
        const a = game.actors.get(id);
        if (a) await a.delete();
      }
    }, [pcId, npcId].filter(Boolean));
  } catch (e) {
    console.error('[verify-mastery] cleanup failed:', e?.message ?? e);
  }
  await f.disconnect?.();
  process.exit(fails === 0 ? 0 : 1);
}
