// Live parity verification for the shared whole-document copy primitive
// (importFromCompendium in src/page/_shared.ts) — the sign-off for alignment-plan 0.2.
//
// 0.2 routes both WHOLE-DOCUMENT copy paths through one primitive:
//   - createActorFromCompendium  (actor copy)
//   - importItemFromCompendium   (item copy: to the world sidebar AND embedded on an actor)
// Embedded-item copy (add-feature spells / compendium-features) keeps its own hand-roll and is
// out of scope here. This script drives a real headless Foundry session through the foundry.call
// seam (bypassing the MCP process, so it exercises the freshly-built dist/page.bundle.js without a
// Claude Code restart) and asserts, against the live `sandbox` world, that each copy:
//   * succeeds end-to-end,
//   * carries the SOURCE's content + art (name/type/img/embedded-item count match getCompendiumDocumentFull),
//   * gets a FRESH local _id (never the source pack id — the `delete _id` the primitive performs),
//   * still honours the validation guards (missing pack -> throw; non-Item pack -> "expected Item").
// Everything created is namespaced with TAG and cleaned up in `finally`.
//
// Build first: npm run build. Run: node scripts/verify-copy-primitive.mjs
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

const TAG = 'ZZ-COPY-IT';
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

async function expectThrow(label, fn, re) {
  try {
    await fn();
    fails++;
    console.log(`  FAIL  ${label} — expected a throw, none thrown`);
  } catch (e) {
    const m = e?.message || String(e);
    if (re.test(m)) {
      passes++;
      console.log(`  PASS  ${label} — threw ${JSON.stringify(m.slice(0, 80))}`);
    } else {
      fails++;
      console.log(`  FAIL  ${label} — threw but message didn't match ${re}: ${m.slice(0, 120)}`);
    }
  }
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  // Allow the script to bring up a fully-cold Molten box on its own (mirrors the integration setup).
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let actorId; // created world actor (cleaned up in finally)
let worldItemId; // created world item (cleaned up in finally)

try {
  console.log('[verify-copy] connecting to sandbox…');
  await f.connect();
  console.log('[verify-copy] connected — exercising importFromCompendium\n');

  // --- Resolve a source creature + a source item, and load their full source docs ---
  const [creatures, weapons] = await Promise.all([
    f.call('searchCompendiumFaceted', { documentType: 'creature', limit: 1 }),
    f.call('searchCompendiumFaceted', { documentType: 'weapon', limit: 1 }),
  ]);
  const cHit = (Array.isArray(creatures) ? creatures : [])[0];
  const wHit = (Array.isArray(weapons) ? weapons : [])[0];
  assert(cHit?.pack && cHit?.id, `found a source creature: ${cHit?.name} (${cHit?.pack})`);
  assert(wHit?.pack && wHit?.id, `found a source weapon: ${wHit?.name} (${wHit?.pack})`);
  if (!cHit?.pack || !wHit?.pack) throw new Error('could not resolve source creature/weapon hits');

  const cSrc = await f.call('getCompendiumDocumentFull', {
    packId: cHit.pack,
    documentId: cHit.id,
  });
  const wSrc = await f.call('getCompendiumDocumentFull', {
    packId: wHit.pack,
    documentId: wHit.id,
  });
  const cSrcItemCount = Array.isArray(cSrc?.items) ? cSrc.items.length : 0;

  // --- 1. Actor whole-document copy ---------------------------------------
  console.log('\n# actor copy (createActorFromCompendium)');
  const aOut = await f.call('createActorFromCompendium', {
    packId: cHit.pack,
    itemId: cHit.id,
    customNames: [`${TAG} NPC`],
    quantity: 1,
    addToScene: false,
  });
  assert(aOut?.totalCreated === 1, 'totalCreated === 1');
  actorId = aOut?.actors?.[0]?.id;
  assert(Boolean(actorId), 'created actor has an id');
  assert(
    aOut?.actors?.[0]?.originalName === cSrc.name,
    `originalName === source name "${cSrc.name}"`
  );
  assert(actorId !== cHit.id, 'created actor _id is FRESH (not the source pack id)');

  if (actorId) {
    const info = await f.call('getCharacterInfo', { characterId: actorId });
    assert(info?.name === `${TAG} NPC`, 'custom name applied on the copy');
    assert(info?.type === cSrc.type, `type copied (${cSrc.type})`);
    assert(info?.img === cSrc.img, 'portrait img copied from source');
    assert(
      (info?.items?.length ?? 0) === cSrcItemCount,
      `embedded item count matches source (${cSrcItemCount})`
    );
  }

  // --- 2. Item whole-document copy -> WORLD (with a rename override) -------
  console.log('\n# item copy -> world (importItemFromCompendium)');
  const wOut = await f.call('importItemFromCompendium', {
    packId: wHit.pack,
    itemId: wHit.id,
    name: `${TAG} Sword`,
  });
  assert(wOut?.success === true, 'world copy success');
  worldItemId = wOut?.item?.id;
  assert(Boolean(worldItemId), 'world item has an id');
  assert(worldItemId !== wHit.id, 'world item _id is FRESH (not the source pack id)');
  if (worldItemId) {
    const wi = await f.call('getWorldItem', { identifier: worldItemId });
    assert(wi?.name === `${TAG} Sword`, 'rename override applied on copy');
    assert(wi?.type === wSrc.type, `item type copied (${wSrc.type})`);
    assert(wi?.img === wSrc.img, 'item art (img) copied from source');
    assert(wi?.system && typeof wi.system === 'object', 'system data present on the copy');
  }

  // --- 3. Item whole-document copy -> ACTOR (embedded, no rename) ----------
  console.log('\n# item copy -> actor (importItemFromCompendium, embedded)');
  if (actorId) {
    const eOut = await f.call('importItemFromCompendium', {
      packId: wHit.pack,
      itemId: wHit.id,
      actorIdentifier: actorId,
      equipped: true,
    });
    assert(
      eOut?.success === true && eOut?.target?.type === 'actor',
      'embedded copy success (target=actor)'
    );
    assert(eOut?.item?.name === wSrc.name, `embedded item keeps source name "${wSrc.name}"`);
    const info2 = await f.call('getCharacterInfo', { characterId: actorId });
    assert(
      Boolean(info2?.items?.some?.(i => i.id === eOut?.item?.id)),
      'embedded item is present on the actor'
    );
  }

  // --- 4. Validation guards still fire (parity with the pre-refactor checks) ---
  console.log('\n# guards');
  await expectThrow(
    'createActorFromCompendium(bad pack)',
    () =>
      f.call('createActorFromCompendium', {
        packId: 'no-such-pack.xyz',
        itemId: 'x',
        customNames: ['x'],
      }),
    /Compendium pack not found/
  );
  await expectThrow(
    'importItemFromCompendium(bad pack)',
    () => f.call('importItemFromCompendium', { packId: 'no-such-pack.xyz', itemId: 'x' }),
    /Compendium pack not found/
  );
  await expectThrow(
    'importItemFromCompendium(non-Item pack -> requirePackType)',
    () => f.call('importItemFromCompendium', { packId: cHit.pack, itemId: cHit.id }),
    /expected "Item"/
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-copy] FATAL: ${e?.message || String(e)}`);
} finally {
  // Best-effort cleanup of everything the happy path created.
  if (actorId) {
    try {
      await f.call('deleteActor', { identifiers: [actorId], removeEmptyFolder: true });
      console.log('[verify-copy] cleaned up actor');
    } catch {
      /* best-effort */
    }
  }
  if (worldItemId) {
    try {
      await f.call('deleteWorldItems', { identifiers: [worldItemId] });
      console.log('[verify-copy] cleaned up world item');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== copy-primitive verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
