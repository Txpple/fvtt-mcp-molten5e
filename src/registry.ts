// The tool registry: the single place tool names, definitions, and handlers are wired together.
//
// Previously index.ts kept TWO hand-maintained lists — an `allTools` registration array and a
// ~180-line `switch (name)` dispatcher — cross-checked only by a source-scraping drift test. Here
// the `handlers` map is the single source of truth and the advertised `tools` list is DERIVED from
// it, so the two can't drift apart. Pure construction (no I/O, no server), so it imports and
// unit-tests cleanly (registry.test.ts) without starting the stdio process the way index.ts does.

import type { FoundryBridge } from './foundry.js';
import { Logger } from './logger.js';

import { CharacterTools } from './tools/character.js';
import { CompendiumTools } from './tools/compendium.js';
import { SceneTools } from './tools/scene.js';
import { ActorCreationTools } from './tools/actor-creation.js';
import { QuestCreationTools } from './tools/quest-creation.js';
import { OwnershipTools } from './tools/ownership.js';

import { DnD5eAddFeatureTool } from './tools/dnd5e/add-feature.js';
import { DnD5eNpcTools } from './tools/dnd5e/npc.js';
import { DnD5eFeaturesFromCompendiumTools } from './tools/dnd5e/features.js';
import { DnD5eUpdateActorTool } from './tools/dnd5e/update-actor.js';
import { DnD5eUpdateActorItemTool } from './tools/dnd5e/update-actor-item.js';
import { DnD5eManageActivityTool } from './tools/dnd5e/manage-activity.js';
import { DnD5eManageEffectTool } from './tools/dnd5e/manage-effect.js';
import { DnD5eConditionTool } from './tools/dnd5e/conditions.js';
import { DnD5eAddItemTool } from './tools/dnd5e/add-item.js';
import { DnD5eImportItemTool } from './tools/dnd5e/import-item.js';
import { buildAddFeatureTool } from './tools/dnd5e/grant-to-actor.js';

import { MoltenTools } from './tools/molten/index.js';
import { AssetBridgeTools } from './tools/asset-bridge.js';
import { TableTools } from './tools/tables.js';
import { CardsTools } from './tools/cards.js';
import { ChatTools } from './tools/chat.js';
import { UserTools } from './tools/users.js';
import { OrganizationTools } from './tools/organization.js';

export interface ToolRegistry {
  /** Advertised tool definitions — one per dispatchable handler, derived from `handlers`. */
  tools: any[];
  /** Tool name -> handler. The single source of truth; `tools` is derived from its keys. */
  handlers: Record<string, (args: any) => Promise<any>>;
  /** Route a tool call to its handler (throws `Unknown tool` for an unregistered name). */
  dispatch(name: string, args: any): Promise<any>;
}

export interface ToolRegistryDeps {
  foundry: FoundryBridge;
  logger: Logger;
}

/**
 * Instantiate every tool class, wire each tool name to its handler in one map, and derive the
 * advertised definition list from that map (failing fast if a handler has no advertised
 * definition). Returns the surface index.ts serves over stdio.
 */
export function buildToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  const { foundry, logger } = deps;

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
  const dnd5eUpdateActorTool = new DnD5eUpdateActorTool({ foundry, logger });
  const dnd5eUpdateActorItemTool = new DnD5eUpdateActorItemTool({ foundry, logger });
  const dnd5eManageActivityTool = new DnD5eManageActivityTool({ foundry, logger });
  const dnd5eManageEffectTool = new DnD5eManageEffectTool({ foundry, logger });
  const dnd5eConditionTool = new DnD5eConditionTool({ foundry, logger });
  const dnd5eAddItemTool = new DnD5eAddItemTool({ foundry, logger });
  const dnd5eImportItemTool = new DnD5eImportItemTool({ foundry, logger });

  const questCreationTools = new QuestCreationTools({ foundry, logger });
  const ownershipTools = new OwnershipTools({ foundry, logger });

  // Plane-B Molten file tools (WebDAV). `foundry` lets the destructive ones consult
  // find-asset-references before acting.
  const moltenTools = new MoltenTools({ logger, foundry });
  const assetBridgeTools = new AssetBridgeTools({ foundry, logger });
  const tableTools = new TableTools({ foundry, logger });
  const cardsTools = new CardsTools({ foundry, logger });
  const chatTools = new ChatTools({ foundry, logger });
  const userTools = new UserTools({ foundry, logger });
  const organizationTools = new OrganizationTools({ foundry, logger });

  // Unified add-feature tool: composes the feature-authoring + compendium-feature mode schemas
  // (each sourced via the owning tool's getInputSchema()) into a single-entry `add-feature`.
  const addFeatureTool = buildAddFeatureTool(
    dnd5eAddFeatureTool.getInputSchema(),
    dnd5eFeaturesFromCompendiumTools.getInputSchema()
  );

  // Collect every advertised definition into a name -> definition lookup.
  const defByName = new Map<string, any>();
  for (const def of [
    ...characterTools.getToolDefinitions(),
    ...compendiumTools.getToolDefinitions(),
    ...sceneTools.getToolDefinitions(),
    ...actorCreationTools.getToolDefinitions(),
    ...dnd5eUpdateActorTool.getToolDefinitions(),
    ...dnd5eUpdateActorItemTool.getToolDefinitions(),
    ...dnd5eManageActivityTool.getToolDefinitions(),
    ...dnd5eManageEffectTool.getToolDefinitions(),
    ...dnd5eConditionTool.getToolDefinitions(),
    ...dnd5eAddItemTool.getToolDefinitions(),
    ...dnd5eImportItemTool.getToolDefinitions(),
    addFeatureTool,
    ...questCreationTools.getToolDefinitions(),
    ...ownershipTools.getToolDefinitions(),
    ...moltenTools.getToolDefinitions(),
    ...assetBridgeTools.getToolDefinitions(),
    ...tableTools.getToolDefinitions(),
    ...cardsTools.getToolDefinitions(),
    ...chatTools.getToolDefinitions(),
    ...userTools.getToolDefinitions(),
    ...organizationTools.getToolDefinitions(),
  ]) {
    defByName.set(def.name, def);
  }

  const handlers: Record<string, (args: any) => Promise<any>> = {
    // Character / world items
    'get-actor': args => characterTools.handleGetCharacter(args),
    'list-actors': args => characterTools.handleListCharacters(args),
    'get-actor-entity': args => characterTools.handleGetCharacterEntity(args),
    'search-actor-contents': args => characterTools.handleSearchCharacterItems(args),
    'create-item': args => characterTools.handleManageWorldItems({ ...args, action: 'create' }),
    'list-items': args => characterTools.handleManageWorldItems({ ...args, action: 'list' }),
    'get-item': args => characterTools.handleManageWorldItems({ ...args, action: 'get' }),
    'update-item': args => characterTools.handleManageWorldItems({ ...args, action: 'update' }),
    'delete-item': args => characterTools.handleManageWorldItems({ ...args, action: 'delete' }),
    'remove-from-actor': args =>
      characterTools.handleManageWorldItems({ ...args, action: 'remove-from-actor' }),

    // Compendium
    'search-compendium': args => compendiumTools.handleSearchCompendium(args),
    'get-compendium-entry': args => compendiumTools.handleGetCompendiumItem(args),
    'search-compendium-creatures': args => compendiumTools.handleListCreaturesByCriteria(args),
    'search-compendium-spells': args => compendiumTools.handleSearchCompendiumSpells(args),
    'search-compendium-items': args => compendiumTools.handleSearchCompendiumItems(args),
    'list-compendium-packs': args => compendiumTools.handleListCompendiumPacks(args),

    // Scene / world
    'get-current-scene': args => sceneTools.handleGetCurrentScene(args),
    'get-world-info': args => sceneTools.handleGetWorldInfo(args),

    // Actor creation (create-actor branches on source: authored stat block vs compendium pull)
    'create-actor': args => {
      const source = args?.source ?? 'compendium';
      return source === 'authored'
        ? dnd5eNpcTools.handleCreateNpc(args?.statBlock ?? {})
        : actorCreationTools.handleCreateActorFromCompendium(args);
    },
    'delete-actor': args => actorCreationTools.handleDeleteActor(args),
    'delete-folder': args => actorCreationTools.handleDeleteFolder(args),
    'update-actor': args => dnd5eUpdateActorTool.handleUpdateActor(args),
    'update-actor-item': args => dnd5eUpdateActorItemTool.handleUpdateActorItem(args),
    'manage-activity': args => dnd5eManageActivityTool.handleManageActivity(args),
    'manage-effect': args => dnd5eManageEffectTool.handleManageEffect(args),
    'apply-condition': args => dnd5eConditionTool.handleApplyCondition(args),
    'add-item': args => dnd5eAddItemTool.handleAddItem(args),
    'import-item': args => dnd5eImportItemTool.handleImportItem(args),

    // Actor authoring — unified add-feature entry (composes feature / compendium / items modes)
    'add-feature': args => {
      const a = args ?? {};
      const actorIdentifier = a.actorIdentifier;
      if (a.mode === 'feature') {
        return dnd5eAddFeatureTool.handleAddFeature({ actorIdentifier, ...(a.feature ?? {}) });
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
        `add-feature: unknown mode "${a.mode}" — use "compendium-features", "feature", or "items"`
      );
    },

    // Quests / journals
    'create-quest-journal': args => questCreationTools.handleCreateQuestJournal(args),
    'link-quest-to-npc': args => questCreationTools.handleLinkQuestToNPC(args),
    'update-quest-journal': args => questCreationTools.handleUpdateQuestJournal(args),
    'list-journals': args => questCreationTools.handleListJournals(args),
    'search-journals': args => questCreationTools.handleSearchJournals(args),
    'create-journal': args => questCreationTools.handleCreateJournal(args),
    'update-journal': args => questCreationTools.handleUpdateJournal(args),
    'delete-journal': args => questCreationTools.handleDeleteJournal(args),

    // Ownership
    'set-actor-ownership': args => ownershipTools.handleToolCall('set-actor-ownership', args),
    'list-actor-ownership': args => ownershipTools.handleToolCall('list-actor-ownership', args),

    // Plane-B Molten file tools
    'list-assets': args => moltenTools.handleListAssets(args),
    'asset-info': args => moltenTools.handleAssetInfo(args),
    'download-asset': args => moltenTools.handleDownloadAsset(args),
    'upload-asset': args => moltenTools.handleUploadAsset(args),
    'create-asset-folder': args => moltenTools.handleCreateAssetFolder(args),
    'delete-asset': args => moltenTools.handleDeleteAsset(args),
    'move-asset': args => moltenTools.handleMoveAsset(args),
    'copy-asset': args => moltenTools.handleCopyAsset(args),
    'asset-url': args => moltenTools.handleAssetUrl(args),

    // Asset composition + reference integrity (Plane A)
    'find-asset-references': args => assetBridgeTools.handleFindAssetReferences(args),
    'relink-asset': args => assetBridgeTools.handleRelinkAsset(args),
    'create-playlist': args => assetBridgeTools.handleCreatePlaylist(args),
    'create-scene': args => assetBridgeTools.handleCreateScene(args),
    'set-actor-art': args => assetBridgeTools.handleSetActorArt(args),
    'add-journal-image': args => assetBridgeTools.handleAddJournalImage(args),
    'list-scenes': args => assetBridgeTools.handleListScenes(args),
    'update-scene': args => assetBridgeTools.handleUpdateScene(args),
    'delete-scene': args => assetBridgeTools.handleDeleteScene(args),
    'list-playlists': args => assetBridgeTools.handleListPlaylists(args),
    'update-playlist': args => assetBridgeTools.handleUpdatePlaylist(args),
    'delete-playlist': args => assetBridgeTools.handleDeletePlaylist(args),

    // Roll tables
    'create-rolltable': args => tableTools.handleCreateRollTable(args),
    'list-rolltables': args => tableTools.handleListRollTables(args),
    'update-rolltable': args => tableTools.handleUpdateRollTable(args),
    'roll-on-table': args => tableTools.handleRollOnTable(args),
    'delete-rolltable': args => tableTools.handleDeleteRollTable(args),

    // Cards
    'create-cards': args => cardsTools.handleCreateCards(args),
    'list-cards': args => cardsTools.handleListCards(args),
    'delete-cards': args => cardsTools.handleDeleteCards(args),

    // Chat log
    'send-chat-message': args => chatTools.handleSendChatMessage(args),
    'list-chat-messages': args => chatTools.handleListChatMessages(args),
    'delete-chat-messages': args => chatTools.handleDeleteChatMessages(args),
    'export-chat-log': args => chatTools.handleExportChatLog(args),
    'post-item-card': args => chatTools.handlePostItemCard(args),
    'request-roll': args => chatTools.handleRequestRoll(args),

    // Users
    'set-user-avatar': args => userTools.handleSetUserAvatar(args),

    // Organization & batch
    'create-folder': args => organizationTools.handleCreateFolder(args),
    'move-documents': args => organizationTools.handleMoveDocuments(args),
    'bulk-delete': args => organizationTools.handleBulkDelete(args),
  };

  // Advertise exactly what we can dispatch; a handler with no matching definition is a wiring bug
  // that should fail loudly at startup, not ship a tool that can't describe itself.
  const tools = Object.keys(handlers).map(name => {
    const def = defByName.get(name);
    if (!def) {
      throw new Error(`Tool "${name}" has a handler but no advertised definition`);
    }
    return def;
  });

  const dispatch = async (name: string, args: any): Promise<any> => {
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return handler(args ?? {});
  };

  return { tools, handlers, dispatch };
}
