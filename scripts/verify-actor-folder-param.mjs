// Live verification: create-actor-from-compendium `folder` — file the copies in ONE call.
//
// Claims under test (page-side createActorFromCompendium, src/page/actors.ts):
//   1. No folder → the default "Foundry MCP Creatures" folder, echoed in result.folder.
//   2. folder by NEW name → the Actor folder is created and the copy filed under it.
//   3. folder by the SAME name again → the existing folder is REUSED (no duplicate).
//   4. folder by ID → resolved directly and used.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixtures,
// cleaned in finally. Build first: npm run build. Run: node scripts/verify-actor-folder-param.mjs
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

const TAG = 'ZZ-FOLDERPARAM';
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

const actorIds = [];
const folderIds = new Set();

const actorFolder = actorId =>
  f.evaluate(id => {
    const a = game.actors.get(id);
    return { folderId: a.folder?.id ?? null, folderName: a.folder?.name ?? null };
  }, actorId);

try {
  console.log('[verify-folderparam] connecting…');
  await f.connect();
  console.log('[verify-folderparam] connected\n');

  console.log('# setup — pick a Monster Manual entry to copy');
  const src = await f.evaluate(async () => {
    const pack = game.packs.get('dnd-monster-manual.actors');
    const e = pack.index.contents[0];
    return { packId: pack.collection, itemId: e._id, name: e.name };
  });
  console.log(`  source: "${src.name}" (${src.packId} / ${src.itemId})\n`);

  console.log('# 1) no folder — default "Foundry MCP Creatures", echoed back');
  const r1 = await f.call('createActorFromCompendium', {
    packId: src.packId,
    itemId: src.itemId,
    customNames: [`${TAG} Default`],
    quantity: 1,
  });
  actorIds.push(r1.actors[0].id);
  assert(r1.folder?.name === 'Foundry MCP Creatures', `result.folder = "${r1.folder?.name}"`);
  let loc = await actorFolder(r1.actors[0].id);
  assert(loc.folderName === 'Foundry MCP Creatures', `actor filed under "${loc.folderName}"`);

  console.log('# 2) folder by NEW name — created and used');
  const r2 = await f.call('createActorFromCompendium', {
    packId: src.packId,
    itemId: src.itemId,
    customNames: [`${TAG} Custom A`],
    quantity: 1,
    folder: `${TAG} Folder`,
  });
  actorIds.push(r2.actors[0].id);
  assert(r2.folder?.name === `${TAG} Folder`, `result.folder = "${r2.folder?.name}"`);
  folderIds.add(r2.folder?.id);
  loc = await actorFolder(r2.actors[0].id);
  assert(loc.folderName === `${TAG} Folder`, `actor filed under "${loc.folderName}"`);
  assert(!r2.errors, 'no errors reported');

  console.log('# 3) folder by the SAME name — reused, no duplicate');
  const r3 = await f.call('createActorFromCompendium', {
    packId: src.packId,
    itemId: src.itemId,
    customNames: [`${TAG} Custom B`],
    quantity: 1,
    folder: `${TAG} Folder`,
  });
  actorIds.push(r3.actors[0].id);
  assert(r3.folder?.id === r2.folder?.id, 'same folder id as run 2');
  const dupes = await f.evaluate(
    name => game.folders.filter(x => x.name === name && x.type === 'Actor').length,
    `${TAG} Folder`
  );
  assert(dupes === 1, `exactly one "${TAG} Folder" Actor folder exists (${dupes})`);

  console.log('# 4) folder by ID — resolved directly');
  const r4 = await f.call('createActorFromCompendium', {
    packId: src.packId,
    itemId: src.itemId,
    customNames: [`${TAG} Custom C`],
    quantity: 1,
    folder: r2.folder.id,
  });
  actorIds.push(r4.actors[0].id);
  assert(r4.folder?.id === r2.folder?.id, 'folder id passthrough resolved');
  loc = await actorFolder(r4.actors[0].id);
  assert(loc.folderId === r2.folder?.id, 'actor filed under the id-addressed folder');
} finally {
  await f.evaluate(
    async ({ actors, folders }) => {
      for (const id of actors) await game.actors.get(id)?.delete();
      for (const id of folders) await game.folders.get(id)?.delete();
    },
    { actors: actorIds, folders: [...folderIds].filter(Boolean) }
  );
  console.log('\n[verify-folderparam] fixtures cleaned');
  await f.dispose?.();
}

console.log(`\n[verify-folderparam] ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
