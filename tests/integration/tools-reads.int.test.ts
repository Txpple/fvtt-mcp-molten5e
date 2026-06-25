// Read-tool spine (live). Ports scripts/verify-read-tools.mjs: drives the REWIRED Node
// tool classes end-to-end against the live world. Unlike reads.int (which hits the page
// seam directly), this proves the whole tool spine — zod parse -> foundry.call seam ->
// page lib -> shaped response — for the read handlers.
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Foundry } from '../../dist/foundry.js';
import { SceneTools } from '../../dist/tools/scene.js';
import { ActorTools } from '../../dist/tools/actor.js';
import { CompendiumTools } from '../../dist/tools/compendium.js';
import { QuestCreationTools } from '../../dist/tools/quest-creation.js';
import { AssetBridgeTools } from '../../dist/tools/asset-bridge.js';
import { LIVE, foundryConfig, noopLogger, CONNECT_TIMEOUT_MS } from './setup.js';

describe.skipIf(!LIVE)('read-tool spine (live)', () => {
  let foundry: Foundry;
  let scene: SceneTools;
  let character: ActorTools;
  let compendium: CompendiumTools;
  let quest: QuestCreationTools;
  let asset: AssetBridgeTools;
  let firstActorName: string | undefined;

  beforeAll(async () => {
    foundry = new Foundry(foundryConfig(), noopLogger);
    await foundry.connect();

    scene = new SceneTools({ foundry, logger: noopLogger });
    character = new ActorTools({ foundry, logger: noopLogger });
    compendium = new CompendiumTools({ foundry, logger: noopLogger });
    quest = new QuestCreationTools({ foundry, logger: noopLogger });
    asset = new AssetBridgeTools({ foundry, logger: noopLogger });

    const list = await character.handleListCharacters({});
    firstActorName = list?.characters?.[0]?.name;
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await foundry?.dispose();
  });

  it('get-world-info returns a shaped world object', async () => {
    const out = await scene.handleGetWorldInfo({});
    expect(out).toBeTruthy();
    expect(out.system ?? out.worldId ?? out.title).toBeTruthy();
  });

  it('list-actors returns { characters: [] }', async () => {
    const out = await character.handleListCharacters({});
    expect(Array.isArray(out?.characters)).toBe(true);
  });

  it('get-actor for the first character', async ctx => {
    if (!firstActorName) return ctx.skip();
    const out = await character.handleGetCharacter({ identifier: firstActorName });
    expect(out?.name).toBeTruthy();
  });

  it('search-compendium(goblin)', async () => {
    await expect(compendium.handleSearchCompendium({ query: 'goblin' })).resolves.not.toBeNull();
  });

  it('list-scenes', async () => {
    await expect(asset.handleListScenes({})).resolves.toBeDefined();
  });

  it('list-journals', async () => {
    await expect(quest.handleListJournals({})).resolves.not.toBeNull();
  });

  it('list-playlists', async () => {
    await expect(asset.handleListPlaylists({})).resolves.toBeDefined();
  });
});
