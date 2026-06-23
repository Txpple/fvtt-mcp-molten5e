// Write cycles (live). Ports scripts/verify-write-tools.mjs: create -> verify -> update ->
// move -> delete round-trips through the foundry.call seam for every write-side page
// function. Unit tests MOCK the seam, so these live cycles are the only real correctness
// gate for the write code. Everything is namespaced with TAG and cleaned up best-effort in
// afterAll. Steps run in order (the suite runs single-fork, no file parallelism), and each
// step skips if a prerequisite id from an earlier step is missing.
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Foundry } from '../../dist/foundry.js';
import { LIVE, foundryConfig, noopLogger, CONNECT_TIMEOUT_MS, TAG } from './setup.js';

describe.skipIf(!LIVE)('write cycles (live)', () => {
  let foundry: Foundry;

  // Ids captured across steps; afterAll deletes anything the happy path left behind.
  const created: {
    items: string[];
    journals: string[];
    playlists: string[];
    tables: string[];
    cards: string[];
    scenes: string[];
    actors: string[];
  } = { items: [], journals: [], playlists: [], tables: [], cards: [], scenes: [], actors: [] };

  // Cross-step ids within a single lifecycle.
  const ids: {
    itemId?: string;
    journalId?: string;
    playlistId?: string;
    tableId?: string;
    cardsId?: string;
    sceneId?: string;
    actorId?: string;
  } = {};

  beforeAll(async () => {
    foundry = new Foundry(foundryConfig(), noopLogger);
    await foundry.connect();
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    const tryDel = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort cleanup */
      }
    };
    if (created.items.length)
      await tryDel(() => foundry.call('deleteWorldItems', { identifiers: created.items }));
    if (created.journals.length)
      await tryDel(() => foundry.call('deleteJournals', { identifiers: created.journals }));
    if (created.playlists.length)
      await tryDel(() => foundry.call('deletePlaylists', { identifiers: created.playlists }));
    if (created.tables.length)
      await tryDel(() => foundry.call('deleteRollTables', { identifiers: created.tables }));
    if (created.cards.length)
      await tryDel(() => foundry.call('deleteCards', { identifiers: created.cards }));
    if (created.scenes.length)
      await tryDel(() => foundry.call('deleteScenes', { identifiers: created.scenes }));
    if (created.actors.length)
      await tryDel(() =>
        foundry.call('deleteActor', { identifiers: created.actors, removeEmptyFolder: true })
      );
    // Disposable folders (deleteContents catches any leftovers).
    await tryDel(() =>
      foundry.call('deleteFolder', {
        identifier: `${TAG} Items`,
        type: 'Item',
        deleteContents: true,
      })
    );
    await tryDel(() =>
      foundry.call('deleteFolder', {
        identifier: `${TAG} Items2`,
        type: 'Item',
        deleteContents: true,
      })
    );
    await tryDel(() =>
      foundry.call('deleteFolder', {
        identifier: `${TAG} Journals`,
        type: 'JournalEntry',
        deleteContents: true,
      })
    );
    await foundry?.dispose();
  });

  // --- Folders ---
  it('createFolder(Item)', async () => {
    const out = await foundry.call<{ success?: boolean; folderId?: string }>('createFolder', {
      name: `${TAG} Items`,
      type: 'Item',
    });
    expect(out?.success && out.folderId).toBeTruthy();
  });

  it('createFolder(Item #2)', async () => {
    const out = await foundry.call<{ success?: boolean; folderId?: string }>('createFolder', {
      name: `${TAG} Items2`,
      type: 'Item',
    });
    expect(out?.success && out.folderId).toBeTruthy();
  });

  // --- World item: create -> get -> update -> move -> bulkDelete ---
  it('createWorldItems', async () => {
    const out = await foundry.call<{ created?: Array<{ id?: string }> }>('createWorldItems', {
      items: [{ name: `${TAG} Sword`, type: 'weapon' }],
      folder: `${TAG} Items`,
    });
    expect(out?.created?.length).toBe(1);
    ids.itemId = out?.created?.[0]?.id;
    if (ids.itemId) created.items.push(ids.itemId);
  });

  it('getWorldItem', async ctx => {
    if (!ids.itemId) return ctx.skip();
    const out = await foundry.call<{ name?: string }>('getWorldItem', { identifier: ids.itemId });
    expect(out?.name).toBe(`${TAG} Sword`);
  });

  it('updateWorldItems', async ctx => {
    if (!ids.itemId) return ctx.skip();
    const out = await foundry.call<{ updated?: unknown[] }>('updateWorldItems', {
      updates: [{ id: ids.itemId, name: `${TAG} Sword+1` }],
    });
    expect(out?.updated?.length).toBe(1);
  });

  it('moveDocuments', async ctx => {
    if (!ids.itemId) return ctx.skip();
    const out = await foundry.call<{ movedCount?: number }>('moveDocuments', {
      documentType: 'Item',
      identifiers: [ids.itemId],
      targetFolder: `${TAG} Items2`,
    });
    expect(out?.movedCount).toBe(1);
  });

  it('bulkDelete(Item)', async ctx => {
    if (!ids.itemId) return ctx.skip();
    const out = await foundry.call<{ deletedCount?: number }>('bulkDelete', {
      documentType: 'Item',
      identifiers: [ids.itemId],
    });
    expect(out?.deletedCount).toBe(1);
    created.items = created.items.filter(x => x !== ids.itemId);
  });

  // --- Journal: create -> update -> delete ---
  it('createJournal', async () => {
    const out = await foundry.call<{ id?: string; pageCount?: number }>('createJournal', {
      name: `${TAG} Journal`,
      pages: [{ name: 'Page 1', content: '<p>hello</p>' }],
      folderName: `${TAG} Journals`,
    });
    expect(out?.id).toBeTruthy();
    expect(out?.pageCount ?? 0).toBeGreaterThanOrEqual(1);
    ids.journalId = out?.id;
    if (ids.journalId) created.journals.push(ids.journalId);
  });

  it('updateJournal', async ctx => {
    if (!ids.journalId) return ctx.skip();
    const out = await foundry.call<{ success?: boolean }>('updateJournal', {
      journalId: ids.journalId,
      content: '<p>updated</p>',
    });
    expect(out?.success).not.toBe(false);
  });

  it('deleteJournals', async ctx => {
    if (!ids.journalId) return ctx.skip();
    const out = await foundry.call<{ deletedCount?: number }>('deleteJournals', {
      identifiers: [ids.journalId],
    });
    expect(out?.deletedCount).toBe(1);
    created.journals = [];
  });

  // --- Playlist: create -> delete ---
  it('createPlaylist', async () => {
    const out = await foundry.call<{ playlistId?: string }>('createPlaylist', {
      name: `${TAG} Playlist`,
      soundPaths: ['sounds/ambient.ogg'],
      mode: 'sequential',
      repeat: false,
    });
    expect(out?.playlistId).toBeTruthy();
    ids.playlistId = out?.playlistId;
    if (ids.playlistId) created.playlists.push(ids.playlistId);
  });

  it('deletePlaylists', async ctx => {
    if (!ids.playlistId) return ctx.skip();
    const out = await foundry.call<{ deletedCount?: number }>('deletePlaylists', {
      identifiers: [ids.playlistId],
    });
    expect(out?.deletedCount).toBe(1);
    created.playlists = [];
  });

  // --- RollTable: create -> roll -> delete ---
  it('createRollTable', async () => {
    const out = await foundry.call<{ tableId?: string; resultCount?: number }>('createRollTable', {
      name: `${TAG} Table`,
      results: [{ text: 'Alpha' }, { text: 'Beta' }],
    });
    expect(out?.tableId).toBeTruthy();
    expect(out?.resultCount).toBe(2);
    ids.tableId = out?.tableId;
    if (ids.tableId) created.tables.push(ids.tableId);
  });

  it('rollOnTable', async ctx => {
    if (!ids.tableId) return ctx.skip();
    const out = await foundry.call<{ rolled?: unknown }>('rollOnTable', {
      identifier: ids.tableId,
    });
    expect(out?.rolled).not.toBe(false);
  });

  it('deleteRollTables', async ctx => {
    if (!ids.tableId) return ctx.skip();
    const out = await foundry.call<{ deletedCount?: number }>('deleteRollTables', {
      identifiers: [ids.tableId],
    });
    expect(out?.deletedCount).toBe(1);
    created.tables = [];
  });

  // --- Cards: create -> delete ---
  it('createCards', async () => {
    const out = await foundry.call<{ cardsId?: string }>('createCards', {
      name: `${TAG} Deck`,
      type: 'deck',
    });
    expect(out?.cardsId).toBeTruthy();
    ids.cardsId = out?.cardsId;
    if (ids.cardsId) created.cards.push(ids.cardsId);
  });

  it('deleteCards', async ctx => {
    if (!ids.cardsId) return ctx.skip();
    const out = await foundry.call<{ deletedCount?: number }>('deleteCards', {
      identifiers: [ids.cardsId],
    });
    expect(out?.deletedCount).toBe(1);
    created.cards = [];
  });

  // --- Scene: create -> delete ---
  it('createScene', async () => {
    const out = await foundry.call<{ sceneId?: string }>('createScene', {
      name: `${TAG} Scene`,
      backgroundPath: 'worlds/placeholder/bg.webp',
      width: 1000,
      height: 1000,
    });
    expect(out?.sceneId).toBeTruthy();
    ids.sceneId = out?.sceneId;
    if (ids.sceneId) created.scenes.push(ids.sceneId);
  });

  it('deleteScenes', async ctx => {
    if (!ids.sceneId) return ctx.skip();
    const out = await foundry.call<{ deletedCount?: number }>('deleteScenes', {
      identifiers: [ids.sceneId],
    });
    expect(out?.deletedCount).toBe(1);
    created.scenes = [];
  });

  // --- Actor from compendium: create -> add item -> remove item -> delete ---
  it('createActorFromCompendium', async ctx => {
    const idx = await foundry.call<{
      response?: { creatures?: Array<{ pack?: string; id?: string; name?: string }> };
      creatures?: Array<{ pack?: string; id?: string; name?: string }>;
    }>('listCreaturesByCriteria', { limit: 1 });
    const creatures = idx?.response?.creatures ?? idx?.creatures ?? (Array.isArray(idx) ? idx : []);
    const c = creatures?.[0];
    if (!c?.pack || !c?.id) return ctx.skip();
    const out = await foundry.call<{ totalCreated?: number; actors?: Array<{ id?: string }> }>(
      'createActorFromCompendium',
      {
        packId: c.pack,
        itemId: c.id,
        customNames: [`${TAG} NPC`],
        quantity: 1,
        addToScene: false,
      }
    );
    expect(out?.totalCreated).toBe(1);
    ids.actorId = out?.actors?.[0]?.id;
    expect(ids.actorId).toBeTruthy();
    if (ids.actorId) created.actors.push(ids.actorId);
  });

  it('addActorItems', async ctx => {
    if (!ids.actorId) return ctx.skip();
    const out = await foundry.call<{ created?: unknown[] }>('addActorItems', {
      actorIdentifier: ids.actorId,
      items: [{ name: `${TAG} Dagger`, type: 'weapon' }],
    });
    expect(out?.created?.length).toBe(1);
  });

  it('removeActorItems', async ctx => {
    if (!ids.actorId) return ctx.skip();
    const out = await foundry.call<{ removed?: unknown[] }>('removeActorItems', {
      actorIdentifier: ids.actorId,
      itemNames: [`${TAG} Dagger`],
    });
    expect(out?.removed?.length).toBe(1);
  });

  it('deleteActor', async ctx => {
    if (!ids.actorId) return ctx.skip();
    const out = await foundry.call<{ deletedCount?: number }>('deleteActor', {
      identifiers: [ids.actorId],
      removeEmptyFolder: true,
    });
    expect(out?.deletedCount).toBe(1);
    created.actors = [];
  });
});
