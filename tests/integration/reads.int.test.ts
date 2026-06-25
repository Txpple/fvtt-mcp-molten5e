// Read-side page library (live). Ports scripts/verify-reads.mjs: every read function is
// exercised through the foundry.call seam with args derived from REAL world data. The
// page lib (src/page/**) is bundled to the browser and is NOT unit-tested, so this is its
// only correctness gate. A read "passes" if the seam call resolves without throwing
// (matching the script's OK/FAIL-on-throw contract); data-derived steps skip when the
// world has nothing to derive from.
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Foundry } from '../../dist/foundry.js';
import { LIVE, foundryConfig, noopLogger, CONNECT_TIMEOUT_MS } from './setup.js';

describe.skipIf(!LIVE)('read-side page library (live)', () => {
  let foundry: Foundry;

  // Seed values discovered from the live world, used by data-derived reads below.
  const seed: {
    actorName?: string;
    journalId?: string;
    journalPageId?: string;
    itemId?: string;
    tableId?: string;
    compendium?: { pack: string; id: string };
  } = {};

  beforeAll(async () => {
    foundry = new Foundry(foundryConfig(), noopLogger);
    await foundry.connect();

    const actors = await foundry.call<Array<{ name?: string }>>('listActors', {});
    seed.actorName = actors?.[0]?.name;

    const journals =
      await foundry.call<Array<{ id?: string; pages?: Array<{ id?: string }> }>>('listJournals');
    seed.journalId = journals?.[0]?.id;
    seed.journalPageId = journals?.[0]?.pages?.[0]?.id;

    const items = await foundry.call<Array<{ id?: string }>>('listWorldItems', {});
    seed.itemId = items?.[0]?.id;

    const tables = await foundry.call<Array<{ id?: string }>>('listRollTables');
    seed.tableId = tables?.[0]?.id;

    const search = await foundry.call<Array<{ pack?: string; id?: string }>>('searchCompendium', {
      query: 'goblin',
    });
    const sc0 = search?.[0];
    if (sc0?.pack && sc0?.id) seed.compendium = { pack: sc0.pack, id: sc0.id };
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await foundry?.dispose();
  });

  // --- World / actors ---
  it('getWorldInfo', async () => {
    expect(await foundry.call('getWorldInfo')).toBeTruthy();
  });

  it('listActors returns an array', async () => {
    expect(Array.isArray(await foundry.call('listActors', {}))).toBe(true);
  });

  it('getCharacterInfo for the first actor', async ctx => {
    if (!seed.actorName) return ctx.skip();
    await expect(
      foundry.call('getCharacterInfo', { characterName: seed.actorName })
    ).resolves.toBeDefined();
  });

  it('searchCharacterItems for the first actor', async ctx => {
    if (!seed.actorName) return ctx.skip();
    await expect(
      foundry.call('searchCharacterItems', { characterIdentifier: seed.actorName })
    ).resolves.toBeDefined();
  });

  it('findActor by a name fragment', async () => {
    const fragment = (seed.actorName || 'a').split(' ')[0];
    await expect(foundry.call('findActor', { identifier: fragment })).resolves.toBeDefined();
  });

  // --- Scenes ---
  it('getActiveScene', async () => {
    await expect(foundry.call('getActiveScene')).resolves.toBeDefined();
  });

  it('listScenes', async () => {
    await expect(foundry.call('listScenes', {})).resolves.toBeDefined();
  });

  // --- Compendium ---
  it('getAvailablePacks', async () => {
    await expect(foundry.call('getAvailablePacks')).resolves.toBeDefined();
  });

  it('searchCompendium(goblin)', async () => {
    await expect(foundry.call('searchCompendium', { query: 'goblin' })).resolves.toBeDefined();
  });

  it('getCompendiumDocumentFull for a search hit', async ctx => {
    if (!seed.compendium) return ctx.skip();
    await expect(
      foundry.call('getCompendiumDocumentFull', {
        packId: seed.compendium.pack,
        documentId: seed.compendium.id,
      })
    ).resolves.toBeDefined();
  });

  // --- Journals ---
  it('listJournals', async () => {
    await expect(foundry.call('listJournals')).resolves.toBeDefined();
  });

  it('getJournalContent for the first journal', async ctx => {
    if (!seed.journalId) return ctx.skip();
    await expect(
      foundry.call('getJournalContent', { journalId: seed.journalId })
    ).resolves.toBeDefined();
  });

  it('getJournalPageContent for the first page', async ctx => {
    if (!seed.journalId || !seed.journalPageId) return ctx.skip();
    await expect(
      foundry.call('getJournalPageContent', {
        journalId: seed.journalId,
        pageId: seed.journalPageId,
      })
    ).resolves.toBeDefined();
  });

  // --- World items ---
  it('listWorldItems', async () => {
    await expect(foundry.call('listWorldItems', {})).resolves.toBeDefined();
  });

  it('getWorldItem for the first item', async ctx => {
    if (!seed.itemId) return ctx.skip();
    await expect(foundry.call('getWorldItem', { identifier: seed.itemId })).resolves.toBeDefined();
  });

  // --- Ownership / players ---
  it('getActorOwnership(all)', async () => {
    await expect(
      foundry.call('getActorOwnership', { actorIdentifier: 'all' })
    ).resolves.toBeDefined();
  });

  it('getFriendlyNPCs', async () => {
    await expect(foundry.call('getFriendlyNPCs')).resolves.toBeDefined();
  });

  it('getPartyCharacters', async () => {
    await expect(foundry.call('getPartyCharacters')).resolves.toBeDefined();
  });

  it('getConnectedPlayers', async () => {
    await expect(foundry.call('getConnectedPlayers')).resolves.toBeDefined();
  });

  it('findPlayers', async () => {
    await expect(foundry.call('findPlayers', { identifier: 'Player' })).resolves.toBeDefined();
  });

  // --- Playlists / tables / cards ---
  it('listPlaylists', async () => {
    await expect(foundry.call('listPlaylists')).resolves.toBeDefined();
  });

  it('listRollTables', async () => {
    await expect(foundry.call('listRollTables')).resolves.toBeDefined();
  });

  it('rollOnTable for the first table', async ctx => {
    if (!seed.tableId) return ctx.skip();
    await expect(foundry.call('rollOnTable', { identifier: seed.tableId })).resolves.toBeDefined();
  });

  it('listCards', async () => {
    await expect(foundry.call('listCards')).resolves.toBeDefined();
  });

  // --- Faceted discovery (dnd5e CompendiumBrowser.fetch; may be slow on first call) ---
  it('searchCompendiumFaceted(creature, CR 1)', async () => {
    await expect(
      foundry.call('searchCompendiumFaceted', { documentType: 'creature', challengeRating: 1 })
    ).resolves.toBeDefined();
  });
});
