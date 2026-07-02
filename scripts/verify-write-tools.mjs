// Phase-2 WRITE acceptance (Wave 1): exercise the NEW page-side write functions
// end-to-end against the live Molten world via the foundry.call seam. Unit tests
// mock the seam, so these live create -> verify -> delete cycles are the only real
// correctness gate for the write code. Everything is namespaced "ZZ-MCP-WT" and
// cleaned up (best-effort) in a finally block.
//
// Build first: `npm run build`. Run: node scripts/verify-write-tools.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = 'ZZ-MCP-WT';

function loadEnv() {
  const txt = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const foundry = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  password: env.FOUNDRY_PASSWORD,
});

const results = [];
const pass = (n, s) => {
  results.push({ n, ok: true });
  console.log(`PASS  ${n}${s ? ` -> ${s}` : ''}`);
};
const fail = (n, e) => {
  results.push({ n, ok: false });
  console.log(`FAIL  ${n} -> ${e}`);
};
const skip = (n, why) => {
  results.push({ n, skipped: true });
  console.log(`SKIP  ${n} -> ${why}`);
};
async function check(n, fn, ok = () => true) {
  try {
    const out = await fn();
    if (!ok(out)) {
      fail(n, `bad shape: ${JSON.stringify(out).slice(0, 200)}`);
      return undefined;
    }
    pass(n, typeof out === 'object' ? JSON.stringify(out).slice(0, 120) : String(out));
    return out;
  } catch (e) {
    fail(n, e?.message || String(e));
    return undefined;
  }
}

// cleanup trackers
const created = {
  items: [],
  journals: [],
  playlists: [],
  tables: [],
  cards: [],
  scenes: [],
  actors: [],
};

try {
  console.log('[write-acceptance] connecting…');
  await foundry.connect();
  console.log('[write-acceptance] connected — running write cycles\n');

  // --- Folders ---
  await check(
    'createFolder(Item)',
    () => foundry.call('createFolder', { name: `${TAG} Items`, type: 'Item' }),
    o => o?.success && o.folderId
  );
  await check(
    'createFolder(Item #2)',
    () => foundry.call('createFolder', { name: `${TAG} Items2`, type: 'Item' }),
    o => o?.success && o.folderId
  );

  // --- World items: create -> get -> update -> move -> bulkDelete ---
  const ci = await check(
    'createWorldItems',
    () =>
      foundry.call('createWorldItems', {
        items: [{ name: `${TAG} Sword`, type: 'weapon' }],
        folder: `${TAG} Items`,
      }),
    o => o?.created?.length === 1
  );
  const itemId = ci?.created?.[0]?.id;
  if (itemId) {
    created.items.push(itemId);
    await check(
      'getWorldItem',
      () => foundry.call('getWorldItem', { identifier: itemId }),
      o => o?.name === `${TAG} Sword`
    );
    await check(
      'updateWorldItems',
      () => foundry.call('updateWorldItems', { updates: [{ id: itemId, name: `${TAG} Sword+1` }] }),
      o => o?.updated?.length === 1
    );
    await check(
      'moveDocuments',
      () =>
        foundry.call('moveDocuments', {
          documentType: 'Item',
          identifiers: [itemId],
          targetFolder: `${TAG} Items2`,
        }),
      o => o?.movedCount === 1
    );
    const bd = await check(
      'bulkDelete(Item)',
      () => foundry.call('bulkDelete', { documentType: 'Item', identifiers: [itemId] }),
      o => o?.deletedCount === 1
    );
    if (bd?.deletedCount === 1) created.items = created.items.filter(x => x !== itemId);
  } else {
    skip('getWorldItem/update/move/bulkDelete', 'createWorldItems produced no id');
  }

  // --- Journal: create -> update -> delete ---
  const cj = await check(
    'createJournal',
    () =>
      foundry.call('createJournal', {
        name: `${TAG} Journal`,
        pages: [{ name: 'Page 1', content: '<p>hello</p>' }],
        folderName: `${TAG} Journals`,
      }),
    o => o?.id && o.pageCount >= 1
  );
  if (cj?.id) {
    created.journals.push(cj.id);
    await check(
      'updateJournal',
      () => foundry.call('updateJournal', { journalId: cj.id, content: '<p>updated</p>' }),
      o => o?.success !== false
    );
    const dj = await check(
      'deleteJournals',
      () => foundry.call('deleteJournals', { identifiers: [cj.id] }),
      o => o?.deletedCount === 1
    );
    if (dj?.deletedCount === 1) created.journals = [];
  }

  // --- Playlist: create -> delete ---
  const cp = await check(
    'createPlaylist',
    () =>
      foundry.call('createPlaylist', {
        name: `${TAG} Playlist`,
        soundPaths: ['sounds/ambient.ogg'],
        mode: 'sequential',
        repeat: false,
      }),
    o => o?.playlistId
  );
  if (cp?.playlistId) {
    created.playlists.push(cp.playlistId);
    const dp = await check(
      'deletePlaylists',
      () => foundry.call('deletePlaylists', { identifiers: [cp.playlistId] }),
      o => o?.deletedCount === 1
    );
    if (dp?.deletedCount === 1) created.playlists = [];
  }

  // --- RollTable: create -> roll -> delete ---
  const ct = await check(
    'createRollTable',
    () =>
      foundry.call('createRollTable', {
        name: `${TAG} Table`,
        results: [{ text: 'Alpha' }, { text: 'Beta' }],
      }),
    o => o?.tableId && o.resultCount === 2
  );
  if (ct?.tableId) {
    created.tables.push(ct.tableId);
    await check(
      'rollOnTable',
      () => foundry.call('rollOnTable', { identifier: ct.tableId }),
      o => o?.rolled !== false
    );
    const dt = await check(
      'deleteRollTables',
      () => foundry.call('deleteRollTables', { identifiers: [ct.tableId] }),
      o => o?.deletedCount === 1
    );
    if (dt?.deletedCount === 1) created.tables = [];
  }

  // --- Cards: create -> delete ---
  const cc = await check(
    'createCards',
    () => foundry.call('createCards', { name: `${TAG} Deck`, type: 'deck' }),
    o => o?.cardsId
  );
  if (cc?.cardsId) {
    created.cards.push(cc.cardsId);
    const dc = await check(
      'deleteCards',
      () => foundry.call('deleteCards', { identifiers: [cc.cardsId] }),
      o => o?.deletedCount === 1
    );
    if (dc?.deletedCount === 1) created.cards = [];
  }

  // --- Scene: create -> delete ---
  const cs = await check(
    'createScene',
    () =>
      foundry.call('createScene', {
        name: `${TAG} Scene`,
        backgroundPath: 'worlds/placeholder/bg.webp',
        width: 1000,
        height: 1000,
      }),
    o => o?.sceneId
  );
  if (cs?.sceneId) {
    created.scenes.push(cs.sceneId);
    const ds = await check(
      'deleteScenes',
      () => foundry.call('deleteScenes', { identifiers: [cs.sceneId] }),
      o => o?.deletedCount === 1
    );
    if (ds?.deletedCount === 1) created.scenes = [];
  }

  // --- Actor from compendium: create -> add item -> remove item -> delete (best-effort) ---
  try {
    const idx = await foundry.call('searchCompendiumFaceted', {
      documentType: 'creature',
      limit: 1,
    });
    const creatures = Array.isArray(idx) ? idx : [];
    const c = creatures?.[0];
    if (c?.pack && c?.id) {
      const ca = await check(
        `createActorFromCompendium(${c.name})`,
        () =>
          foundry.call('createActorFromCompendium', {
            packId: c.pack,
            itemId: c.id,
            customNames: [`${TAG} NPC`],
            quantity: 1,
            addToScene: false,
          }),
        o => o?.totalCreated === 1 && o.actors?.[0]?.id
      );
      const actorId = ca?.actors?.[0]?.id;
      if (actorId) {
        created.actors.push(actorId);
        await check(
          'addActorItems',
          () =>
            foundry.call('addActorItems', {
              actorIdentifier: actorId,
              items: [{ name: `${TAG} Dagger`, type: 'weapon' }],
            }),
          o => o?.created?.length === 1
        );
        await check(
          'removeActorItems',
          () =>
            foundry.call('removeActorItems', {
              actorIdentifier: actorId,
              itemNames: [`${TAG} Dagger`],
            }),
          o => o?.removed?.length === 1
        );
        const da = await check(
          'deleteActor',
          () => foundry.call('deleteActor', { identifiers: [actorId], removeEmptyFolder: true }),
          o => o?.deletedCount === 1
        );
        if (da?.deletedCount === 1) created.actors = [];
      }
    } else {
      skip(
        'createActorFromCompendium/addActorItems/removeActorItems/deleteActor',
        'no compendium creature found to clone'
      );
    }
  } catch (e) {
    fail('actor-from-compendium cycle', e?.message || String(e));
  }

  skip(
    'setActorOwnership',
    'needs a target user id; lowest-risk write (single actor.update) — verify in Wave 2'
  );
} catch (e) {
  console.error('[write-acceptance] FATAL:', e?.message || e);
} finally {
  // safety-net cleanup of anything the happy path left behind
  console.log('\n[write-acceptance] cleanup…');
  const tryDel = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      console.log(`  cleanup ${name} note: ${e?.message || e}`);
    }
  };
  if (created.items.length)
    await tryDel('items', () => foundry.call('deleteWorldItems', { identifiers: created.items }));
  if (created.journals.length)
    await tryDel('journals', () =>
      foundry.call('deleteJournals', { identifiers: created.journals })
    );
  if (created.playlists.length)
    await tryDel('playlists', () =>
      foundry.call('deletePlaylists', { identifiers: created.playlists })
    );
  if (created.tables.length)
    await tryDel('tables', () => foundry.call('deleteRollTables', { identifiers: created.tables }));
  if (created.cards.length)
    await tryDel('cards', () => foundry.call('deleteCards', { identifiers: created.cards }));
  if (created.scenes.length)
    await tryDel('scenes', () => foundry.call('deleteScenes', { identifiers: created.scenes }));
  if (created.actors.length)
    await tryDel('actors', () =>
      foundry.call('deleteActor', { identifiers: created.actors, removeEmptyFolder: true })
    );
  // delete the disposable folders (deleteContents catches any leftovers)
  await tryDel('folder Items', () =>
    foundry.call('deleteFolder', { identifier: `${TAG} Items`, type: 'Item', deleteContents: true })
  );
  await tryDel('folder Items2', () =>
    foundry.call('deleteFolder', {
      identifier: `${TAG} Items2`,
      type: 'Item',
      deleteContents: true,
    })
  );
  await tryDel('folder Journals', () =>
    foundry.call('deleteFolder', {
      identifier: `${TAG} Journals`,
      type: 'JournalEntry',
      deleteContents: true,
    })
  );

  await foundry.dispose();
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => r.ok === false).length;
  const skipped = results.filter(r => r.skipped).length;
  console.log(`\n[write-acceptance] ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}
