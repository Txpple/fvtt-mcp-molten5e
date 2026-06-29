// Live verification for tool-hardening ② — "NPC magic gear is lootable" (authoring rule 9).
//
// Drives a real headless Foundry session through the foundry.call seam (fresh dist/, no CC restart)
// and asserts, against the live `sandbox` world, that placing an item on an actor ALSO mints a
// matching world-Item loot twin per the rule:
//   - add-item magic (auto)      → a loot copy appears, loose (equipped:false), same +N, in the folder.
//   - add-item mundane (auto)    → NO loot copy (mundane gear needs no twin).
//   - add-item mundane lootCopy:true  → forced loot copy.
//   - add-item magic lootCopy:false   → suppressed (no copy).
//   - import-item magic (auto)   → the copied compendium item gets a loose loot twin too.
// All loot copies are routed to a TAG'd folder and torn down in `finally`.
//
// Build first: npm run build. Run: node scripts/verify-loot-copy.mjs
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

const TAG = 'ZZ-LOOT-IT';
const LOOT_FOLDER = `${TAG} Loot`;
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
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let actorId;

try {
  console.log('[verify-loot] connecting to sandbox…');
  await f.connect();
  console.log('[verify-loot] connected\n');

  const creatures = await f.call('searchCompendiumFaceted', { documentType: 'creature', limit: 1 });
  const cHit = (Array.isArray(creatures) ? creatures : [])[0];
  if (!cHit?.pack) throw new Error('could not resolve a source creature');
  const aOut = await f.call('createActorFromCompendium', {
    packId: cHit.pack,
    itemId: cHit.id,
    customNames: [`${TAG} Host`],
    quantity: 1,
    addToScene: false,
  });
  actorId = aOut?.actors?.[0]?.id;
  if (!actorId) throw new Error('host NPC not created');
  console.log(`[verify-loot] host NPC: ${aOut.actors[0].name} (${actorId})\n`);

  const addItem = extra =>
    f.call('addItem', { actorIdentifier: actorId, lootCopyFolder: LOOT_FOLDER, ...extra });

  // Case 1 — magic weapon, auto: loot twin minted, loose + same +N.
  console.log('# 1. add-item magic (auto) → loose loot twin');
  const c1 = await addItem({
    itemType: 'weapon',
    name: `${TAG} Mace +1`,
    damage: { number: 1, denomination: 6, types: ['bludgeoning'] },
    magicalBonus: 1,
  });
  assert(Boolean(c1?.lootCopy?.id), `magic weapon minted a loot copy (${c1?.lootCopy?.name})`);
  assert(c1?.lootCopy?.folderName === LOOT_FOLDER, `loot copy is in folder "${LOOT_FOLDER}"`);
  if (c1?.lootCopy?.id) {
    const w = await f.call('getWorldItem', { identifier: c1.lootCopy.id });
    assert(w?.system?.equipped === false, 'loot copy is loose (equipped:false)');
    assert(w?.system?.magicalBonus === '1', 'loot copy keeps the +1 bonus');
    assert(!/icons\/svg\//.test(w?.img ?? ''), `loot copy has a real icon (${w?.img})`);
  }

  // Case 2 — mundane weapon, auto: NO loot twin.
  console.log('\n# 2. add-item mundane (auto) → no loot twin');
  const c2 = await addItem({
    itemType: 'weapon',
    name: `${TAG} Plain Club`,
    damage: { number: 1, denomination: 4, types: ['bludgeoning'] },
  });
  assert(!c2?.lootCopy, 'mundane weapon does NOT mint a loot copy');

  // Case 3 — mundane, forced: loot twin minted.
  console.log('\n# 3. add-item mundane lootCopy:true → forced loot twin');
  const c3 = await addItem({
    itemType: 'loot',
    name: `${TAG} Trinket`,
    lootType: 'gear',
    lootCopy: true,
  });
  assert(Boolean(c3?.lootCopy?.id), 'lootCopy:true forces a loot copy for a mundane item');

  // Case 4 — magic, suppressed: NO loot twin.
  console.log('\n# 4. add-item magic lootCopy:false → suppressed');
  const c4 = await addItem({
    itemType: 'weapon',
    name: `${TAG} Hidden Blade +1`,
    damage: { number: 1, denomination: 8, types: ['slashing'] },
    magicalBonus: 1,
    lootCopy: false,
  });
  assert(!c4?.lootCopy, 'lootCopy:false suppresses the loot copy on a magic item');

  // Case 5 — import a real magic item: the copied item gets a loose loot twin.
  console.log('\n# 5. import-item magic (auto) → loose loot twin');
  const c5 = await f.call('importItemFromCompendium', {
    actorIdentifier: actorId,
    packId: 'dnd-dungeon-masters-guide.equipment',
    itemId: 'dmgAmuletOfHealt', // Amulet of Health — rare, wondrous, mgc
    lootCopyFolder: LOOT_FOLDER,
  });
  assert(
    Boolean(c5?.lootCopy?.id),
    `imported magic item minted a loot copy (${c5?.lootCopy?.name})`
  );
  if (c5?.lootCopy?.id) {
    const a = await f.call('getWorldItem', { identifier: c5.lootCopy.id });
    assert(a?.system?.equipped === false, 'imported loot copy is loose (equipped:false)');
    assert(!/icons\/svg\//.test(a?.img ?? ''), `imported loot copy keeps real art (${a?.img})`);
  }
} catch (e) {
  fails++;
  console.log(`\n[verify-loot] FATAL: ${e?.message || String(e)}`);
} finally {
  try {
    await f.call('deleteFolder', { identifier: LOOT_FOLDER, type: 'Item', deleteContents: true });
  } catch {
    /* best-effort */
  }
  if (actorId) {
    try {
      await f.call('deleteActor', { identifiers: [actorId], removeEmptyFolder: true });
    } catch {
      /* best-effort */
    }
  }
  console.log('\n[verify-loot] cleaned up host NPC + loot folder');
  await f.dispose?.();
}

console.log(`\n==== loot-copy verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
