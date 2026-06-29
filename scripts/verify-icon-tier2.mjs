// Live verification for tool-hardening ④ — Tier-2 icon approximation (rule 8 polish).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). When an authored item has no
// img, addItem now tries a live same-kind compendium match by name/baseItem BEFORE the generic Tier-1
// floor — so a homebrew "Mace of the Long Dark" gets a real mace icon, not the generic weapon default.
// Asserts a name match, a baseItem match, and a graceful fallback to the floor for an unmatched name.
// Cleaned up in `finally`.
//
// Build first: npm run build. Run: node scripts/verify-icon-tier2.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';
import { resolveAuthoredIcon, isPlaceholderIcon } from '../dist/page/dnd5e/icons.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const TAG = 'ZZ-TIER2-IT';
const FLOOR_WEAPON = resolveAuthoredIcon('weapon');
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

async function liveImg(itemId) {
  const ent = await f.call('getCharacterEntity', {
    characterIdentifier: actorId,
    entityIdentifier: itemId,
  });
  return ent?.entity?.img ?? ent?.img;
}

try {
  console.log('[verify-tier2] connecting to sandbox…');
  await f.connect();
  console.log(`[verify-tier2] connected (Tier-1 weapon floor = ${FLOOR_WEAPON})\n`);

  const creatures = await f.call('searchCompendiumFaceted', { documentType: 'creature', limit: 1 });
  const cHit = (Array.isArray(creatures) ? creatures : [])[0];
  const aOut = await f.call('createActorFromCompendium', {
    packId: cHit.pack,
    itemId: cHit.id,
    customNames: [`${TAG} Host`],
    quantity: 1,
    addToScene: false,
  });
  actorId = aOut?.actors?.[0]?.id;
  if (!actorId) throw new Error('host NPC not created');
  console.log(`[verify-tier2] host NPC: ${aOut.actors[0].name} (${actorId})\n`);

  // 1. Name's leading noun ("Mace") finds a real mace icon, not the generic sword floor.
  console.log('# 1. name match — "Mace of the Long Dark"');
  const m = await f.call('addItem', {
    actorIdentifier: actorId,
    itemType: 'weapon',
    name: 'Mace of the Long Dark', // no tag prefix — the leading noun must be "Mace" for the match
    damage: { number: 1, denomination: 6, types: ['bludgeoning'] },
    lootCopy: false,
  });
  const mImg = await liveImg(m?.item?.id);
  assert(!isPlaceholderIcon(mImg), `got a real icon: ${mImg}`);
  assert(mImg !== FLOOR_WEAPON, 'used a name-matched compendium icon, not the Tier-1 floor');
  assert(/mace/i.test(mImg), 'the matched icon is mace-themed');

  // 2. Explicit baseItem ("mace") drives the match even with an unrelated name.
  console.log('\n# 2. baseItem match — name "Bonker", baseItem "mace"');
  const b = await f.call('addItem', {
    actorIdentifier: actorId,
    itemType: 'weapon',
    name: 'Bonker',
    baseItem: 'mace',
    damage: { number: 1, denomination: 6, types: ['bludgeoning'] },
    lootCopy: false,
  });
  const bImg = await liveImg(b?.item?.id);
  assert(
    !isPlaceholderIcon(bImg) && bImg !== FLOOR_WEAPON,
    `baseItem matched a real icon: ${bImg}`
  );

  // 3. Unmatched name → graceful fallback to the Tier-1 floor.
  console.log('\n# 3. fallback — gibberish name has no match');
  const z = await f.call('addItem', {
    actorIdentifier: actorId,
    itemType: 'weapon',
    name: 'Zzyxqwop Thingamabob',
    damage: { number: 1, denomination: 6, types: ['slashing'] },
    lootCopy: false,
  });
  const zImg = await liveImg(z?.item?.id);
  assert(zImg === FLOOR_WEAPON, `fell back to the Tier-1 floor: ${zImg}`);
} catch (e) {
  fails++;
  console.log(`\n[verify-tier2] FATAL: ${e?.message || String(e)}`);
} finally {
  if (actorId) {
    try {
      await f.call('deleteActor', { identifiers: [actorId], removeEmptyFolder: true });
      console.log('\n[verify-tier2] cleaned up host NPC');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== icon Tier-2 verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
