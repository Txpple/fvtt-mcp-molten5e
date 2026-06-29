// Live verification for tool-hardening ① — "icon auto-fill kills blank art" (authoring rule 8).
//
// Drives a real headless Foundry session through the foundry.call seam (exercising the freshly-built
// dist/page.bundle.js WITHOUT a Claude Code restart) and asserts, against the live `sandbox` world:
//   A. EXISTENCE — every curated Tier-1 icon path actually resolves on the Foundry static server
//      (best-effort raw fetch; the handoff's hard rule is "a guessed core-icon path 404s"). SKIPs
//      cleanly if static assets aren't reachable from Node.
//   B. WIRING — authoring an item / feature / attack / spell with NO img yields a real, non-placeholder
//      icon on the LIVE document (the resolver fires and Foundry persists it), and an explicit img is
//      still respected.
// Everything created is namespaced with TAG and cleaned up in `finally`.
//
// Build first: npm run build. Run: node scripts/verify-icons.mjs
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

const TAG = 'ZZ-ICON-IT';
let passes = 0;
let fails = 0;
let skips = 0;

function assert(cond, msg) {
  if (cond) {
    passes++;
    console.log(`  PASS  ${msg}`);
  } else {
    fails++;
    console.log(`  FAIL  ${msg}`);
  }
}

// All paths the resolver can hand out (same kind/subtype matrix as the unit test).
const PATHS = new Set(
  [
    ['weapon'],
    ['armor'],
    ['shield'],
    ['wondrous'],
    ['wondrous', 'ring'],
    ['wondrous', 'rod'],
    ['wondrous', 'wand'],
    ['wondrous', 'cloak'],
    ['wondrous', 'clothing'],
    ['wondrous', 'amulet'],
    ['consumable'],
    ['consumable', 'poison'],
    ['consumable', 'scroll'],
    ['consumable', 'ammo'],
    ['consumable', 'food'],
    ['tool'],
    ['loot'],
    ['loot', 'art'],
    ['loot', 'trade'],
    ['container'],
    ['passive'],
    ['save'],
    ['aura'],
    ['attack'],
    ['spell'],
  ].map(([k, sub]) => resolveAuthoredIcon(k, sub ? { subtype: sub } : {}))
);

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let actorId; // host NPC, cleaned up in finally

// Read an embedded item's img back off the live actor.
async function liveImg(itemId) {
  const ent = await f.call('getCharacterEntity', {
    characterIdentifier: actorId,
    entityIdentifier: itemId,
  });
  return ent?.entity?.img ?? ent?.img;
}

try {
  console.log('[verify-icons] connecting to sandbox…');
  await f.connect();
  console.log('[verify-icons] connected\n');

  // --- A. EXISTENCE: every curated path resolves on the static server (best-effort) ----------
  console.log(`# A. every curated Tier-1 icon path resolves (${PATHS.size} unique paths)`);
  const base = (env.MOLTEN_SERVER_URL || '').replace(/\/+$/, '');
  let probed = 0;
  let missing = [];
  for (const p of PATHS) {
    try {
      const res = await fetch(`${base}/${p}`, { method: 'HEAD' });
      probed++;
      if (!res.ok) missing.push(`${p} (HTTP ${res.status})`);
    } catch {
      /* static fetch not reachable from Node — handled below */
    }
  }
  if (probed === 0) {
    skips++;
    console.log(
      '  SKIP  static assets not reachable from Node (provenance: harvested live) — see part B'
    );
  } else {
    assert(
      missing.length === 0,
      `all ${probed} probed icon paths exist (404s: ${missing.join(', ') || 'none'})`
    );
  }

  // --- Host NPC: copy the first MM creature (a realistic prefab base) -------------------------
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
  console.log(`\n[verify-icons] host NPC: ${aOut.actors[0].name} (${actorId})`);

  // --- B. WIRING: author with NO img → real icon on the live document -------------------------
  console.log('\n# B. authored docs get a real, non-placeholder icon (no img supplied)');

  // B1. add-item (weapon) — auto-fill matches the resolver floor.
  const wpn = await f.call('addItem', {
    actorIdentifier: actorId,
    itemType: 'weapon',
    name: `${TAG} Blade`,
    damage: { number: 1, denomination: 8, types: ['slashing'] },
  });
  const wpnImg = await liveImg(wpn?.item?.id);
  assert(!isPlaceholderIcon(wpnImg), `authored weapon icon is real: ${wpnImg}`);
  assert(wpnImg === resolveAuthoredIcon('weapon'), 'weapon icon matches the resolver floor');

  // B2. add-item (loot) — different kind, different real icon.
  const loot = await f.call('addItem', {
    actorIdentifier: actorId,
    itemType: 'loot',
    name: `${TAG} Bauble`,
    lootType: 'gem',
  });
  const lootImg = await liveImg(loot?.item?.id);
  assert(!isPlaceholderIcon(lootImg), `authored loot icon is real: ${lootImg}`);

  // B3. add-item with an EXPLICIT img — must be respected, not overridden.
  const custom = await f.call('addItem', {
    actorIdentifier: actorId,
    itemType: 'weapon',
    name: `${TAG} Custom`,
    img: 'icons/weapons/swords/sword-runed.webp',
    damage: { number: 1, denomination: 6, types: ['slashing'] },
  });
  const customImg = await liveImg(custom?.item?.id);
  assert(customImg === 'icons/weapons/swords/sword-runed.webp', 'explicit img is respected');

  // B4. add-feature passive — the headline bug (was always the blank star).
  const passive = await f.call('addPassiveFeatureToActor', {
    actorIdentifier: actorId,
    featureName: `${TAG} Dark Mantle`,
    description: 'A shroud of gloom.',
  });
  const passiveImg = await liveImg(passive?.item?.id);
  assert(!isPlaceholderIcon(passiveImg), `authored passive feature icon is real: ${passiveImg}`);
  assert(passiveImg === resolveAuthoredIcon('passive'), 'passive icon matches the resolver floor');

  // B5. add-feature attack (Multiattack-style natural weapon).
  const atk = await f.call('addAttackToActor', {
    actorIdentifier: actorId,
    featureName: `${TAG} Claw`,
    attackType: 'melee',
    damageParts: [{ number: 1, denomination: 6, type: 'slashing' }],
    properties: [],
    effectiveAbility: 'str',
  });
  const atkImg = await liveImg(atk?.item?.id);
  assert(!isPlaceholderIcon(atkImg), `authored attack icon is real: ${atkImg}`);

  // B6. add-feature save (breath-weapon style).
  const save = await f.call('addSaveFeatureToActor', {
    actorIdentifier: actorId,
    featureName: `${TAG} Gloom Breath`,
    description: '',
    activationType: 'action',
    saveAbility: 'dex',
    saveDC: 14,
    damageParts: [{ number: 4, denomination: 6, type: 'necrotic' }],
    halfOnSave: true,
    areaType: 'cone',
    areaSize: 30,
    areaUnits: 'ft',
    affectsType: 'creature',
  });
  const saveImg = await liveImg(save?.item?.id);
  assert(!isPlaceholderIcon(saveImg), `authored save feature icon is real: ${saveImg}`);

  // B7. homebrew-spell — was hard-set to the icons/svg/daze.svg placeholder family.
  const spell = await f.call('addHomebrewSpellToActor', {
    actorIdentifier: actorId,
    name: `${TAG} Gloomfire`,
    level: 1,
  });
  const spellImg = await liveImg(spell?.item?.id);
  assert(!isPlaceholderIcon(spellImg), `authored spell icon is real: ${spellImg}`);
  assert(spellImg === resolveAuthoredIcon('spell'), 'spell icon matches the resolver floor');
} catch (e) {
  fails++;
  console.log(`\n[verify-icons] FATAL: ${e?.message || String(e)}`);
} finally {
  if (actorId) {
    try {
      await f.call('deleteActor', { identifiers: [actorId], removeEmptyFolder: true });
      console.log('\n[verify-icons] cleaned up host NPC');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(
  `\n==== icon auto-fill verification: ${passes} passed, ${fails} failed, ${skips} skipped ====`
);
process.exit(fails > 0 ? 1 : 0);
