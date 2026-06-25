// Live verification for Phase 3.1a — RollTable results: v14-correct + compendium-referencing.
//
// Drives a real headless Foundry session through the foundry.call seam (bypassing the MCP process, so
// it exercises the freshly-built dist/page.bundle.js WITHOUT a Claude Code restart). Against the live
// `sandbox` world it proves the de-leak + the compendium-first result model:
//   * results store the v14 `description` field (the old `text` key is dropped by v14) — proven by
//     rolling a single-entry table and reading the drawn result back (an empty description would mean
//     we still wrote the dead `text` field);
//   * a `uuid` result renders the book-style @UUID[uuid]{Name} enricher (name auto-resolved);
//   * `text` + `uuid` combine via a {{link}} placeholder (mixed loot);
//   * roll-on-table surfaces the @UUID links as importable (uuid + label);
//   * GUARDS (correctness, design.md §2.3/§2.4): an SRD uuid is refused, an unresolvable premium uuid
//     is refused, and a result with neither text nor uuid is refused.
//   * import-rolltable (Phase 3.1b): copy a published DMG magic-item table into the world, confirm it
//     keeps its formula + results, roll it (world-only) and confirm drawn results are importable @UUID
//     item links; an SRD pack is refused.
// A single-entry table (formula 1d1) always draws its one entry, so every assertion is deterministic.
// Everything created is cleaned up.
//
// Build first: npm run build. Run: node scripts/verify-table-tooling.mjs
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

const TAG = 'ZZ-TABLE-IT';

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
      console.log(`  PASS  ${label} — threw ${JSON.stringify(m.slice(0, 90))}`);
    } else {
      fails++;
      console.log(`  FAIL  ${label} — threw but message didn't match ${re}: ${m.slice(0, 140)}`);
    }
  }
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const createdTableIds = [];
async function makeTable(name, results) {
  const r = await f.call('createRollTable', { name: `${TAG} ${name}`, results });
  if (r?.tableId) createdTableIds.push(r.tableId);
  return r;
}
async function rollOnce(tableId) {
  const r = await f.call('rollOnTable', { identifier: tableId });
  return r?.results?.[0] ?? {};
}

try {
  console.log('[verify-table] connecting to sandbox…');
  await f.connect();
  console.log('[verify-table] connected — exercising RollTable result model\n');

  // --- Find two REAL premium-book items to link (mix-and-match loot) ---
  const gear = await f.call('searchCompendiumFaceted', { documentType: 'gear', limit: 25 });
  const items = (Array.isArray(gear) ? gear : []).filter(i => i?.uuid && i?.name);
  assert(items.length >= 2, `found real premium items to link (${items.length})`);
  const itemA = items[0];
  const itemB = items[1] ?? items[0];
  console.log(`  using: A="${itemA?.name}" (${itemA?.uuid})`);
  console.log(`         B="${itemB?.name}" (${itemB?.uuid})\n`);

  // --- 1. TEXT result: stored in the v14 `description` field (regression: not the dead `text`) ---
  console.log('# text result -> v14 description field');
  const t1 = await makeTable('Coins', [{ text: 'A scattering of coins — 2d6 × 10 gp' }]);
  assert(t1?.resultCount === 1, 'text table created with 1 result');
  const r1 = await rollOnce(t1.tableId);
  assert(
    r1.description === 'A scattering of coins — 2d6 × 10 gp',
    `drawn description is the literal text (v14 field populated) — got ${JSON.stringify(r1.description)}`
  );
  assert((r1.links ?? []).length === 0, 'plain text result surfaces no importable links');

  // --- 2. UUID result: book-style @UUID enricher, name auto-resolved ---
  console.log('\n# uuid result -> @UUID enricher (name resolved) + importable link');
  const t2 = await makeTable('Single Item', [{ uuid: itemA.uuid }]);
  const r2 = await rollOnce(t2.tableId);
  assert(
    r2.description === `@UUID[${itemA.uuid}]{${itemA.name}}`,
    `uuid rendered as @UUID[uuid]{ResolvedName} — got ${JSON.stringify(r2.description)}`
  );
  assert(
    r2.links?.length === 1 && r2.links[0].uuid === itemA.uuid && r2.links[0].label === itemA.name,
    'roll surfaces the item as importable (uuid + label)'
  );

  // --- 3. UUID + explicit name override ---
  console.log('\n# uuid result -> explicit name label override');
  const t3 = await makeTable('Named Item', [{ uuid: itemA.uuid, name: 'Mysterious Trinket' }]);
  const r3 = await rollOnce(t3.tableId);
  assert(
    r3.description === `@UUID[${itemA.uuid}]{Mysterious Trinket}`,
    `explicit name used as the link label — got ${JSON.stringify(r3.description)}`
  );

  // --- 4. MIXED loot: text + uuid via {{link}} placeholder ---
  console.log('\n# mixed loot -> {{link}} placeholder substitution');
  const t4 = await makeTable('Mixed Loot', [
    { text: 'A pouch holding {{link}} and 2d6 gp', uuid: itemB.uuid },
  ]);
  const r4 = await rollOnce(t4.tableId);
  assert(
    r4.description === `A pouch holding @UUID[${itemB.uuid}]{${itemB.name}} and 2d6 gp`,
    `{{link}} replaced by the enricher inside the prose — got ${JSON.stringify(r4.description)}`
  );
  assert(
    r4.links?.length === 1 && r4.links[0].uuid === itemB.uuid,
    'mixed result still importable'
  );

  // --- 5. weights auto-assign sequential ranges (a real multi-entry table) ---
  console.log('\n# weights -> auto-assigned ranges + 1d<total> formula');
  const t5 = await makeTable('Weighted', [
    { text: 'Common', weight: 3 },
    { uuid: itemA.uuid, weight: 1 },
  ]);
  assert(
    t5?.resultCount === 2 && t5?.formula === '1d4',
    `weighted table formula 1d4 (${t5?.formula})`
  );

  // --- GUARDS: correctness enforced at the seam (design.md §2.3/§2.4) ---
  console.log('\n# guards');
  await expectThrow(
    'create(SRD uuid result -> refused)',
    () =>
      f.call('createRollTable', {
        name: `${TAG} SRD`,
        results: [{ uuid: 'Compendium.dnd5e.equipment24.Item.deadbeefdeadbeef' }],
      }),
    /SRD/
  );
  await expectThrow(
    "create(unresolvable premium uuid -> refused, ask-don't-invent)",
    () =>
      f.call('createRollTable', {
        name: `${TAG} Ghost`,
        results: [{ uuid: 'Compendium.dnd-dungeon-masters-guide.equipment.Item.nonexistent0000' }],
      }),
    /could not resolve/
  );
  await expectThrow(
    'create(result with neither text nor uuid -> refused)',
    () => f.call('createRollTable', { name: `${TAG} Empty`, results: [{ weight: 2 }] }),
    /either "text" or "uuid"/
  );

  // --- import-rolltable: copy a published DMG magic-item table into the world, then roll it ---
  console.log('\n# import-rolltable (copy a published DMG table, then roll it)');
  const imp = await f.call('importRollTable', {
    packId: 'dnd-dungeon-masters-guide.tables',
    itemId: 'dmgArcanaCommon0', // "Arcana - Common" — a 1d100 magic-item table of @UUID item links
    folderName: `${TAG} DMG Treasure`,
  });
  if (imp?.tableId) createdTableIds.push(imp.tableId);
  assert(Boolean(imp?.tableId), `imported a world copy of the DMG table (${imp?.tableName})`);
  assert(imp?.formula === '1d100', `imported table keeps its formula 1d100 (${imp?.formula})`);
  assert(imp?.resultCount > 0, `imported table carries its results (${imp?.resultCount})`);

  // The imported world table is now rollable (roll-on-table is world-only) and its results carry
  // the real @UUID item links — importable straight into the world (the treasure-table workflow).
  const drawnImported = await rollOnce(imp.tableId);
  assert(
    /^@UUID\[Compendium\.dnd-dungeon-masters-guide\.equipment\.Item\./.test(
      drawnImported.description ?? ''
    ),
    `drawn DMG result is a real item @UUID link — got ${JSON.stringify((drawnImported.description ?? '').slice(0, 80))}`
  );
  assert(
    drawnImported.links?.length === 1 && /equipment\.Item\./.test(drawnImported.links[0].uuid),
    'drawn DMG result surfaces the item as importable (uuid + label)'
  );

  await expectThrow(
    'import-rolltable(SRD pack -> refused)',
    () => f.call('importRollTable', { packId: 'dnd5e.tables', itemId: 'whatever00000000' }),
    /SRD/
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-table] FATAL: ${e?.message || String(e)}`);
} finally {
  if (createdTableIds.length > 0) {
    try {
      await f.call('deleteRollTables', { identifiers: createdTableIds });
      console.log(`\n[verify-table] cleaned up ${createdTableIds.length} table(s)`);
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== table-tooling verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
