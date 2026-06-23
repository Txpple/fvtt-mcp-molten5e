#!/usr/bin/env node

// The MCP server entry point. A single stdio process: it registers the tool
// surface and dispatches callTool directly against the tool classes, which talk
// to the live Foundry world through the `foundry.call(name, args)` seam
// (src/foundry.ts — the only Playwright-aware file). No TCP wrapper, no spawned
// backend, no lock dance: the inherited WebRTC transport is gone.
//
// The headless Foundry client connects lazily — the first tool call wakes the
// Molten box and joins the world; tools/list responds without touching Foundry.

import * as os from 'node:os';
import * as path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { config } from './config.js';
import { Logger } from './logger.js';
import { Foundry } from './foundry.js';

import { CharacterTools } from './tools/character.js';
import { CompendiumTools } from './tools/compendium.js';
import { SceneTools } from './tools/scene.js';
import { ActorCreationTools } from './tools/actor-creation.js';
import { QuestCreationTools } from './tools/quest-creation.js';
import { OwnershipTools } from './tools/ownership.js';

import { DnD5eAddFeatureTool } from './tools/dnd5e/add-feature.js';
import { DnD5eNpcTools } from './tools/dnd5e/npc.js';
import { DnD5eFeaturesFromCompendiumTools } from './tools/dnd5e/features.js';
import { buildGrantToActorTool } from './tools/dnd5e/grant-to-actor.js';

import { MoltenTools } from './tools/molten/index.js';
import { AssetBridgeTools } from './tools/asset-bridge.js';
import { TableTools } from './tools/tables.js';
import { CardsTools } from './tools/cards.js';
import { OrganizationTools } from './tools/organization.js';

async function main(): Promise<void> {
  // File-only logging: stdout is the JSON-RPC channel and must stay clean.
  const logger = new Logger({
    level: config.logLevel,
    format: config.logFormat,
    enableConsole: false,
    enableFile: true,
    filePath: path.join(os.tmpdir(), 'foundry-mcp-server', 'mcp-server.log'),
  });

  logger.info('Starting Foundry MCP server (headless)', {
    version: config.server.version,
    serverUrl: config.molten.serverUrl,
    user: config.molten.user,
  });

  // The live bridge. Lazy: it connects (wake -> /join -> game.ready -> inject)
  // on the first foundry.call(). Its own diagnostics go to stderr.
  const foundry = new Foundry({
    serverUrl: config.molten.serverUrl,
    user: config.molten.user,
    ...(config.molten.magicUrl ? { magicUrl: config.molten.magicUrl } : {}),
    // Admin-key + world-id enable remote world-launch when a cold box is up but no world is active.
    ...(config.molten.adminKey ? { adminKey: config.molten.adminKey } : {}),
    ...(config.molten.worldId ? { worldId: config.molten.worldId } : {}),
  });

  const characterTools = new CharacterTools({ foundry, logger });
  const compendiumTools = new CompendiumTools({ foundry, logger });
  const sceneTools = new SceneTools({ foundry, logger });
  const actorCreationTools = new ActorCreationTools({ foundry, logger });

  const dnd5eAddFeatureTool = new DnD5eAddFeatureTool({ foundry, logger });
  const dnd5eNpcTools = new DnD5eNpcTools({ foundry, logger });
  const dnd5eFeaturesFromCompendiumTools = new DnD5eFeaturesFromCompendiumTools({
    foundry,
    logger,
  });

  const questCreationTools = new QuestCreationTools({ foundry, logger });
  const ownershipTools = new OwnershipTools({ foundry, logger });

  // Plane-B Molten file tools (WebDAV direct). `foundry` lets the destructive ones
  // (delete/move-asset) consult find-asset-references before acting.
  const moltenTools = new MoltenTools({ logger, foundry });

  // Asset-management bridge tools (Groups C/D — reference integrity + Foundry composition).
  const assetBridgeTools = new AssetBridgeTools({ foundry, logger });

  // Net-new document types for adventure creation.
  const tableTools = new TableTools({ foundry, logger });
  const cardsTools = new CardsTools({ foundry, logger });

  // Organization & batch (folders, moves, bulk delete) across all collections.
  const organizationTools = new OrganizationTools({ foundry, logger });

  // Unified actor-granting tool. Composes the feature-authoring and compendium-feature mode schemas
  // (each sourced via the owning tool's getInputSchema()) so the surface stays single-entry
  // (grant-to-actor) while keeping each mode's full parameter guidance. Dispatch is in the switch below.
  const grantToActorTool = buildGrantToActorTool(
    dnd5eAddFeatureTool.getInputSchema(),
    dnd5eFeaturesFromCompendiumTools.getInputSchema()
  );

  const allTools = [
    ...characterTools.getToolDefinitions(),
    ...compendiumTools.getToolDefinitions(),
    ...sceneTools.getToolDefinitions(),
    ...actorCreationTools.getToolDefinitions(),
    grantToActorTool,
    ...questCreationTools.getToolDefinitions(),
    ...ownershipTools.getToolDefinitions(),
    ...moltenTools.getToolDefinitions(),
    ...assetBridgeTools.getToolDefinitions(),
    ...tableTools.getToolDefinitions(),
    ...cardsTools.getToolDefinitions(),
    ...organizationTools.getToolDefinitions(),
  ];

  async function dispatch(name: string, args: any): Promise<any> {
    switch (name) {
      // Character tools
      case 'get-actor':
        return characterTools.handleGetCharacter(args);
      case 'list-actors':
        return characterTools.handleListCharacters(args);
      case 'get-actor-entity':
        return characterTools.handleGetCharacterEntity(args);
      case 'search-actor-contents':
        return characterTools.handleSearchCharacterItems(args);
      case 'create-item':
        return characterTools.handleManageWorldItems({ ...args, action: 'create' });
      case 'list-items':
        return characterTools.handleManageWorldItems({ ...args, action: 'list' });
      case 'get-item':
        return characterTools.handleManageWorldItems({ ...args, action: 'get' });
      case 'update-item':
        return characterTools.handleManageWorldItems({ ...args, action: 'update' });
      case 'delete-item':
        return characterTools.handleManageWorldItems({ ...args, action: 'delete' });
      case 'remove-from-actor':
        return characterTools.handleManageWorldItems({ ...args, action: 'remove-from-actor' });

      // Compendium tools
      case 'search-compendium':
        return compendiumTools.handleSearchCompendium(args);
      case 'get-compendium-entry':
        return compendiumTools.handleGetCompendiumItem(args);
      case 'search-compendium-creatures':
        return compendiumTools.handleListCreaturesByCriteria(args);
      case 'list-compendium-packs':
        return compendiumTools.handleListCompendiumPacks(args);

      // Scene tools
      case 'get-current-scene':
        return sceneTools.handleGetCurrentScene(args);
      case 'get-world-info':
        return sceneTools.handleGetWorldInfo(args);

      // Actor creation tools
      case 'create-actor': {
        const source = args?.source ?? 'compendium';
        return source === 'authored'
          ? dnd5eNpcTools.handleCreateNpc(args?.statBlock ?? {})
          : actorCreationTools.handleCreateActorFromCompendium(args);
      }
      case 'delete-actor':
        return actorCreationTools.handleDeleteActor(args);
      case 'delete-folder':
        return actorCreationTools.handleDeleteFolder(args);

      // Actor authoring — unified grant entry (composes feature / compendium / items modes)
      case 'grant-to-actor': {
        const a = args ?? {};
        const actorIdentifier = a.actorIdentifier;
        if (a.mode === 'feature') {
          return dnd5eAddFeatureTool.handleAddFeature({
            actorIdentifier,
            ...(a.feature ?? {}),
          });
        }
        if (a.mode === 'compendium-features') {
          return dnd5eFeaturesFromCompendiumTools.handleAddFeaturesFromCompendium({
            actorIdentifier,
            ...(a.compendiumFeatures ?? {}),
          });
        }
        if (a.mode === 'items') {
          return characterTools.handleManageWorldItems({
            action: 'add-to-actor',
            actorIdentifier,
            items: a.items,
          });
        }
        throw new Error(
          `grant-to-actor: unknown mode "${a.mode}" — use "compendium-features", "feature", or "items"`
        );
      }

      // Quest creation tools
      case 'create-quest-journal':
        return questCreationTools.handleCreateQuestJournal(args);
      case 'link-quest-to-npc':
        return questCreationTools.handleLinkQuestToNPC(args);
      case 'update-quest-journal':
        return questCreationTools.handleUpdateQuestJournal(args);
      case 'list-journals':
        return questCreationTools.handleListJournals(args);
      case 'search-journals':
        return questCreationTools.handleSearchJournals(args);
      case 'create-journal':
        return questCreationTools.handleCreateJournal(args);
      case 'update-journal':
        return questCreationTools.handleUpdateJournal(args);
      case 'delete-journal':
        return questCreationTools.handleDeleteJournal(args);

      // Ownership tools
      case 'set-actor-ownership':
        return ownershipTools.handleToolCall('set-actor-ownership', args);
      case 'list-actor-ownership':
        return ownershipTools.handleToolCall('list-actor-ownership', args);

      // Plane-B Molten file tools (asset-management library, Groups A/B)
      case 'list-assets':
        return moltenTools.handleListAssets(args);
      case 'asset-info':
        return moltenTools.handleAssetInfo(args);
      case 'download-asset':
        return moltenTools.handleDownloadAsset(args);
      case 'upload-asset':
        return moltenTools.handleUploadAsset(args);
      case 'create-asset-folder':
        return moltenTools.handleCreateAssetFolder(args);
      case 'delete-asset':
        return moltenTools.handleDeleteAsset(args);
      case 'move-asset':
        return moltenTools.handleMoveAsset(args);
      case 'copy-asset':
        return moltenTools.handleCopyAsset(args);
      case 'asset-url':
        return moltenTools.handleAssetUrl(args);

      // Asset-management bridge tools (Groups C/D)
      case 'find-asset-references':
        return assetBridgeTools.handleFindAssetReferences(args);
      case 'relink-asset':
        return assetBridgeTools.handleRelinkAsset(args);
      case 'create-playlist':
        return assetBridgeTools.handleCreatePlaylist(args);
      case 'create-scene':
        return assetBridgeTools.handleCreateScene(args);
      case 'set-actor-art':
        return assetBridgeTools.handleSetActorArt(args);
      case 'add-journal-image':
        return assetBridgeTools.handleAddJournalImage(args);
      case 'list-scenes':
        return assetBridgeTools.handleListScenes(args);
      case 'update-scene':
        return assetBridgeTools.handleUpdateScene(args);
      case 'delete-scene':
        return assetBridgeTools.handleDeleteScene(args);

      // Playlists (list/update/delete; create-playlist above)
      case 'list-playlists':
        return assetBridgeTools.handleListPlaylists(args);
      case 'update-playlist':
        return assetBridgeTools.handleUpdatePlaylist(args);
      case 'delete-playlist':
        return assetBridgeTools.handleDeletePlaylist(args);

      // Roll tables
      case 'create-rolltable':
        return tableTools.handleCreateRollTable(args);
      case 'list-rolltables':
        return tableTools.handleListRollTables(args);
      case 'update-rolltable':
        return tableTools.handleUpdateRollTable(args);
      case 'roll-on-table':
        return tableTools.handleRollOnTable(args);
      case 'delete-rolltable':
        return tableTools.handleDeleteRollTable(args);

      // Cards
      case 'create-cards':
        return cardsTools.handleCreateCards(args);
      case 'list-cards':
        return cardsTools.handleListCards(args);
      case 'delete-cards':
        return cardsTools.handleDeleteCards(args);

      // Organization & batch
      case 'create-folder':
        return organizationTools.handleCreateFolder(args);
      case 'move-documents':
        return organizationTools.handleMoveDocuments(args);
      case 'bulk-delete':
        return organizationTools.handleBulkDelete(args);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  const mcp = new Server(
    { name: config.server.name, version: config.server.version },
    { capabilities: { tools: {} } }
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params as any;
    try {
      const result = await dispatch(name, args ?? {});
      return {
        content: [
          { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
        ],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error occurred';
      logger.error('Tool call failed', { name, error: message });
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const shutdown = (): void => {
    void foundry.dispose().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info('MCP server connected over stdio');
}

main().catch(err => {
  console.error('Foundry MCP server failed to start:', err);
  process.exit(1);
});
