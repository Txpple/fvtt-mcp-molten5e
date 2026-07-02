// Live verification for alignment-plan 1.1 — the "prefab-as-base bridge".
//
// create-actor-from-compendium can now layer update-actor-shaped `modifications` onto the
// instantiated WORLD COPY in one call — the §6 step-2 bridge from rung 1 (pure prefab copy) to a
// customized NPC. This drives a real headless Foundry session through the foundry.call seam
// (exercising the freshly-built dist/page.bundle.js without a Claude Code restart) and asserts,
// against the live `sandbox` world, the P1d acceptance criterion:
//   * the requested edits LAND on the world copy (cr / hp / biography read back changed),
//   * the SOURCE compendium entry is NEVER written (its cr is identical before and after),
//   * the tool REPORTS what it applied (actors[].modifications.applied),
//   * a soft-validation warning still surfaces (update-actor's warn-not-block contract is preserved).
// The host actor is namespaced with TAG and cleaned up in `finally`.
//
// Build first: npm run build. Run: node scripts/verify-prefab-bridge.mjs
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

const TAG = 'ZZ-BRIDGE-IT';
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
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let actorId;

try {
  console.log('[verify-bridge] connecting to sandbox…');
  await f.connect();
  console.log('[verify-bridge] connected\n');

  // --- Pick an MM creature + record the SOURCE cr BEFORE we copy ---
  const creatures = await f.call('searchCompendiumFaceted', { documentType: 'creature', limit: 1 });
  const cHit = (Array.isArray(creatures) ? creatures : [])[0];
  if (!cHit?.pack) throw new Error('could not resolve a source creature');
  const srcBefore = await f.call('getCompendiumDocumentFull', {
    packId: cHit.pack,
    documentId: cHit.id,
  });
  const srcCr = Number(srcBefore?.system?.details?.cr ?? 0);
  console.log(`# base prefab: ${cHit.name} (${cHit.pack}) — source CR ${srcCr}`);

  // Targets chosen to DIFFER from the source so the assertions are meaningful.
  const newCr = srcCr + 7;
  const bio = `${TAG} customized from ${cHit.name}`;

  // --- 1. Prefab-as-base: copy + layer modifications in one call ---
  console.log('\n# create-actor-from-compendium + modifications');
  const out = await f.call('createActorFromCompendium', {
    packId: cHit.pack,
    itemId: cHit.id,
    customNames: [`${TAG} Captain`],
    quantity: 1,
    addToScene: false,
    modifications: {
      cr: newCr,
      hp: { value: 199, max: 199 },
      biography: bio,
      damageResistances: { values: ['fire', 'notarealtype'] }, // last one should warn, not block
    },
  });
  actorId = out?.actors?.[0]?.id;
  assert(Boolean(actorId), `world copy created (${out?.actors?.[0]?.name})`);
  const applied = out?.actors?.[0]?.modifications?.applied ?? [];
  assert(
    applied.includes('cr') && applied.includes('hp'),
    `report lists applied edits: ${applied.join(', ')}`
  );
  const warns = out?.actors?.[0]?.modifications?.warnings ?? [];
  assert(
    warns.some(w => /notarealtype/.test(w)),
    'soft-validation warning surfaced (warn, not block)'
  );

  // --- 2. The edits LANDED on the world copy ---
  console.log('\n# edits landed on the world copy');
  if (actorId) {
    const info = await f.call('getCharacterInfo', { characterId: actorId });
    assert(Number(info?.system?.details?.cr) === newCr, `copy CR is the modified ${newCr}`);
    assert(Number(info?.system?.attributes?.hp?.max) === 199, 'copy HP max is the modified 199');
    assert(
      String(info?.system?.details?.biography?.value || '').includes(TAG),
      'copy biography carries the modification'
    );
  }

  // --- 3. The SOURCE compendium entry was NEVER written (P1d) ---
  console.log('\n# source compendium entry untouched');
  const srcAfter = await f.call('getCompendiumDocumentFull', {
    packId: cHit.pack,
    documentId: cHit.id,
  });
  const srcCrAfter = Number(srcAfter?.system?.details?.cr ?? 0);
  assert(srcCrAfter === srcCr, `source CR unchanged (${srcCr}) — modifications hit the copy only`);
  assert(srcCr !== newCr, 'sanity: the modified CR genuinely differs from the source CR');
} catch (e) {
  fails++;
  console.log(`\n[verify-bridge] FATAL: ${e?.message || String(e)}`);
} finally {
  if (actorId) {
    try {
      await f.call('deleteActor', { identifiers: [actorId], removeEmptyFolder: true });
      console.log('[verify-bridge] cleaned up host NPC');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== prefab-as-base bridge verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
