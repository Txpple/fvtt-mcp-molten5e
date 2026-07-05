// Live verification: the dnd5e identity mask made visible — `trueName` on item reads/echoes.
//
// dnd5e masks item.name with system.unidentified.name on EVERY read while
// system.identified === false (even GM-side), so a rename of an unidentified item used to
// read back as a silent no-op (the write hit _source.name; every echo showed the mask).
//
// Claims under test (page-side unmaskedName + wiring, src/page/_shared.ts / items.ts / actors.ts):
//   1. createWorldItems echo of an unidentified item carries trueName (the source name).
//   2. getWorldItem: name = the mask, trueName = the source name.
//   3. listWorldItems summary carries trueName for the masked item.
//   4. updateWorldItems RENAME of an unidentified item applies to the source name and the
//      echo PROVES it: name stays the mask, trueName = the new name.
//   5. Identified items keep their exact old shapes — no trueName key anywhere.
//   6. Actor path: updateActorItem echo + getCharacterEntity both surface trueName.
//   7. deleteWorldItems echo carries trueName.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixtures,
// cleaned in finally. Build first: npm run build. Run: node scripts/verify-unidentified-truename.mjs
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

const TAG = 'ZZ-TRUENAME';
const MASK = `${TAG} Mystery Blade`;
const REAL = `${TAG} Dawnthorn`;
const RENAMED = `${TAG} Duskthorn`;

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

let itemId; // masked world item
let plainId; // identified control item
let actorId; // fixture NPC

try {
  console.log('[verify-truename] connecting…');
  await f.connect();
  console.log('[verify-truename] connected\n');

  console.log('# 1) createWorldItems — unidentified item echoes trueName');
  const created = await f.call('createWorldItems', {
    items: [
      {
        name: REAL,
        type: 'weapon',
        system: { identified: false, unidentified: { name: MASK } },
      },
      { name: `${TAG} Plain Sword`, type: 'weapon' },
    ],
  });
  itemId = created.created[0].id;
  plainId = created.created[1].id;
  assert(
    created.created[0].name === MASK,
    `create echo name is the mask ("${created.created[0].name}")`
  );
  assert(
    created.created[0].trueName === REAL,
    `create echo trueName = source ("${created.created[0].trueName}")`
  );
  assert(!('trueName' in created.created[1]), 'identified item create echo has NO trueName key');

  console.log('# 2) getWorldItem — mask + trueName');
  const got = await f.call('getWorldItem', { identifier: itemId });
  assert(got.name === MASK, `get name is the mask ("${got.name}")`);
  assert(got.trueName === REAL, `get trueName = source ("${got.trueName}")`);
  const gotPlain = await f.call('getWorldItem', { identifier: plainId });
  assert(!('trueName' in gotPlain), 'identified item get has NO trueName key');

  console.log('# 3) listWorldItems — summary carries trueName');
  const listed = await f.call('listWorldItems', { nameFilter: TAG });
  const sumMasked = listed.find(i => i.id === itemId);
  const sumPlain = listed.find(i => i.id === plainId);
  assert(sumMasked?.trueName === REAL, `list summary trueName = source ("${sumMasked?.trueName}")`);
  assert(sumPlain && !('trueName' in sumPlain), 'identified item summary has NO trueName key');

  console.log('# 4) updateWorldItems — rename of a MASKED item is visible in the echo');
  const upd = await f.call('updateWorldItems', {
    updates: [{ id: itemId, name: RENAMED }],
  });
  assert(upd.updated.length === 1, 'rename was NOT a silent no-op (updated non-empty)');
  assert(
    upd.updated[0]?.name === MASK,
    `update echo name stays the mask ("${upd.updated[0]?.name}")`
  );
  assert(
    upd.updated[0]?.trueName === RENAMED,
    `update echo trueName = new name ("${upd.updated[0]?.trueName}")`
  );
  const srcName = await f.evaluate(id => game.items.get(id)._source.name, itemId);
  assert(srcName === RENAMED, `_source.name actually renamed ("${srcName}")`);

  console.log('# 5) actor path — updateActorItem echo + getCharacterEntity');
  actorId = await f.evaluate(async tag => {
    const a = await Actor.create({ name: `${tag} Host`, type: 'npc' });
    return a.id;
  }, TAG);
  const embeddedId = await f.evaluate(
    async ({ actorId, itemId }) => {
      const actor = game.actors.get(actorId);
      const data = game.items.get(itemId).toObject();
      delete data._id;
      const [doc] = await actor.createEmbeddedDocuments('Item', [data]);
      return doc.id;
    },
    { actorId, itemId }
  );
  const aUpd = await f.call('updateActorItem', {
    actorIdentifier: actorId,
    itemIdentifier: embeddedId,
    patch: { 'system.weight.value': 4 },
  });
  assert(aUpd.item?.name === MASK, `updateActorItem echo name is the mask ("${aUpd.item?.name}")`);
  assert(
    aUpd.item?.trueName === RENAMED,
    `updateActorItem echo trueName ("${aUpd.item?.trueName}")`
  );
  const ent = await f.call('getCharacterEntity', {
    characterIdentifier: actorId,
    entityIdentifier: embeddedId,
  });
  assert(ent.entity?.name === MASK, `getCharacterEntity name is the mask ("${ent.entity?.name}")`);
  assert(
    ent.entity?.trueName === RENAMED,
    `getCharacterEntity trueName ("${ent.entity?.trueName}")`
  );

  console.log('# 6) deleteWorldItems — echo carries trueName');
  const del = await f.call('deleteWorldItems', { identifiers: [itemId] });
  assert(
    del.deleted[0]?.trueName === RENAMED,
    `delete echo trueName ("${del.deleted[0]?.trueName}")`
  );
  itemId = null; // already gone — skip cleanup
} finally {
  await f
    .evaluate(
      async ({ itemId, plainId, actorId }) => {
        if (itemId) await game.items.get(itemId)?.delete();
        if (plainId) await game.items.get(plainId)?.delete();
        if (actorId) await game.actors.get(actorId)?.delete();
      },
      { itemId, plainId, actorId }
    )
    .catch(() => {});
  console.log('\n[verify-truename] fixtures cleaned');
  await f.dispose?.();
}

console.log(`\n[verify-truename] ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
