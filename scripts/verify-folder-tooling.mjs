// Live verification for list-folders — the folder-tree read/inspect step.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart): builds a small colored
// folder tree (parent + child + a doc inside the child), then proves listFolders reads it back —
// tree order + depth + path, the hex color, parent linkage, direct document/subfolder counts, and
// the type filter. Everything created is deleted in `finally`.
//
// Build first: npm run build.  Run: node scripts/verify-folder-tooling.mjs
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

const TAG = 'ZZ-FOLDER-IT';
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

let parentId;
let tableId;

try {
  console.log('[verify-folders] connecting…');
  await f.connect();
  console.log('[verify-folders] connected\n');

  // Fixture: RollTable folders (a quiet corner of the sidebar) — parent (colored) > child, with
  // one table inside the child.
  const parent = await f.call('createFolder', {
    name: `${TAG} Parent`,
    type: 'RollTable',
    color: '#7c4dff',
  });
  parentId = parent?.folderId;
  const child = await f.call('createFolder', {
    name: `${TAG} Child`,
    type: 'RollTable',
    parentFolder: parentId,
  });
  const made = await f.call('createRollTable', {
    name: `${TAG} Table`,
    folderName: `${TAG} Child`,
    results: [{ text: 'probe entry' }],
  });
  tableId = made?.tableId;

  console.log('# list-folders (all types)');
  const all = await f.call('listFolders', {});
  assert(all?.success === true && all?.total >= 2, `lists the sidebar (${all?.total} folders)`);
  const p = (all?.folders ?? []).find(x => x.id === parentId);
  const c = (all?.folders ?? []).find(x => x.id === child?.folderId);
  assert(!!p && !!c, 'both fixture folders appear');
  assert(p?.depth === 0 && c?.depth === 1, `tree depth read back (parent 0, child ${c?.depth})`);
  assert(
    c?.path === `${TAG} Parent/${TAG} Child` && c?.parentId === parentId,
    `child carries its /-joined path + parent link ("${c?.path}")`
  );
  assert(
    (all?.folders ?? []).indexOf(p) < (all?.folders ?? []).indexOf(c),
    'DFS order — the parent line precedes its child'
  );
  assert(
    typeof p?.color === 'string' && p.color.toLowerCase() === '#7c4dff',
    `the folder COLOR reads back as hex (${p?.color})`
  );
  assert(
    p?.subfolderCount === 1 && p?.documentCount === 0,
    `parent counts its subfolder (${p?.subfolderCount}) and no direct docs`
  );
  assert(c?.documentCount === 1, `child counts its 1 direct document (${c?.documentCount})`);

  console.log('\n# list-folders (type filter)');
  const filtered = await f.call('listFolders', { type: 'RollTable' });
  assert(
    (filtered?.folders ?? []).every(x => x.type === 'RollTable'),
    'type filter returns only RollTable folders'
  );
  assert(
    (filtered?.folders ?? []).some(x => x.id === parentId),
    'filtered list still contains the fixture'
  );
  const actorsOnly = await f.call('listFolders', { type: 'Actor' });
  assert(
    (actorsOnly?.folders ?? []).every(x => x.type === 'Actor'),
    'an Actor filter excludes the RollTable fixture'
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-folders] FATAL: ${e?.stack || e?.message || String(e)}`);
} finally {
  try {
    if (tableId) await f.call('deleteRollTables', { identifiers: [tableId] });
    if (parentId) {
      await f.call('deleteFolder', {
        identifier: parentId,
        type: 'RollTable',
        deleteContents: true,
      });
    }
    console.log('\n[verify-folders] cleaned up fixture folders + table');
  } catch (e) {
    console.log(`\n[verify-folders] cleanup note: ${e?.message || e}`);
  }
  await f.dispose?.();
}

console.log(`\n==== folder-tooling verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
