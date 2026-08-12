// Live verification for update-folder's `sort` param — ROUND-TRIP FIDELITY of the Folder field.
//
// ⚠️ Read the ground-truth note below before trusting `sort` to order anything: the v14 sidebar
// renders sibling FOLDERS alphabetically by name and ignores it. This drives a real headless
// session (fresh dist/, no CC restart): builds three RollTable folders, proves listFolders
// surfaces `sort`, writes a new value, and reads it back. Everything created is deleted in
// `finally`.
//
// Build first: npm run build.  Run: node scripts/verify-folder-sort.mjs
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

const TAG = 'ZZ-SORT-IT';
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

const made = [];

try {
  console.log('[verify-folder-sort] connecting…');
  await f.connect();
  console.log('[verify-folder-sort] connected\n');

  for (const n of ['A', 'B', 'C']) {
    const r = await f.call('createFolder', { name: `${TAG} ${n}`, type: 'RollTable' });
    made.push(r.folderId);
  }
  console.log(`fixture: ${made.length} RollTable folders\n`);

  const readSorts = async () => {
    const res = await f.call('listFolders', { type: 'RollTable' });
    return Object.fromEntries(
      res.folders.filter(x => x.name.startsWith(TAG)).map(x => [x.name.slice(-1), x.sort])
    );
  };

  console.log('— listFolders surfaces sort —');
  const before = await readSorts();
  console.log(`  sorts: ${JSON.stringify(before)}`);
  assert(
    ['A', 'B', 'C'].every(k => typeof before[k] === 'number'),
    'every folder reports a numeric sort'
  );
  // GROUND TRUTH: unlike documents, Folder.create does NOT space sort values — every new folder
  // lands on sort 0. And the tie is never broken by sort at all: the v14 sidebar renders sibling
  // FOLDERS alphabetically by name and IGNORES `sort` (confirmed live on the Greenrest Scene
  // folders — 100000/200000/300000 against siblings at 0 did not move them, so they were renamed
  // "99 - " instead). This script therefore proves round-trip fidelity of the field, NOT that it
  // repositions anything. Rename is the only lever on folder order.
  assert(
    Object.values(before).every(v => v === 0),
    'a freshly created folder gets sort 0 (Foundry does not auto-space folders)'
  );

  console.log('\n— update-folder writes sort —');
  const parked = Math.max(...Object.values(before)) + 100000;
  const upd = await f.call('updateFolder', {
    identifier: made[0],
    type: 'RollTable',
    sort: parked,
  });
  assert(upd.updated === true, 'update accepted a sort-only patch');
  assert(upd.folder?.sort === parked, `result echoes the new sort (${upd.folder?.sort})`);

  const after = await readSorts();
  console.log(`  sorts: ${JSON.stringify(after)}`);
  assert(after.A === parked, 'A persisted at the parked sort');
  assert(after.B === before.B && after.C === before.C, 'siblings were left untouched');

  console.log('\n— sort survives a rename in the same patch —');
  const both = await f.call('updateFolder', {
    identifier: made[1],
    type: 'RollTable',
    name: `${TAG} B2`,
    sort: parked + 100000,
  });
  assert(both.folder?.name === `${TAG} B2`, 'rename applied');
  assert(both.folder?.sort === parked + 100000, 'sort applied in the same update');
} finally {
  for (const id of made) {
    try {
      await f.call('deleteFolder', { identifier: id, type: 'RollTable', deleteContents: true });
    } catch (e) {
      console.log(`  cleanup failed for ${id}: ${e.message}`);
    }
  }
  await f.close?.();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails > 0 ? 1 : 0);
}
