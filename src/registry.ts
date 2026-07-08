// The tool registry: the single place tool names, definitions, and handlers are wired together.
//
// Previously index.ts kept TWO hand-maintained lists — an `allTools` registration array and a
// ~180-line `switch (name)` dispatcher — cross-checked only by a source-scraping drift test. Here
// the `handlers` map is the single source of truth and the advertised `tools` list is DERIVED from
// it, so the two can't drift apart. Pure construction (no I/O, no server), so it imports and
// unit-tests cleanly (registry.test.ts) without starting the stdio process the way index.ts does.

import type { FoundryBridge } from './foundry.js';
import { Logger } from './logger.js';

import { ActorTools } from './tools/actor.js';
import { ItemTools } from './tools/items.js';
import { CompendiumTools } from './tools/compendium.js';
import { SceneTools } from './tools/scene.js';
import { ActorCreationTools } from './tools/actor-creation.js';
import { PlaceableTools } from './tools/placeables/index.js';
import { JournalTools } from './tools/journal.js';
import { OwnershipTools } from './tools/ownership.js';

import { DnD5eAddFeatureTool } from './tools/dnd5e/add-feature.js';
import { DnD5eNpcTools } from './tools/dnd5e/npc.js';
import { DnD5ePcTools } from './tools/dnd5e/pc.js';
import { DnD5eFeaturesFromCompendiumTools } from './tools/dnd5e/features.js';
import { DnD5eUpdateActorTool } from './tools/dnd5e/update-actor.js';
import { DnD5eUpdateActorItemTool } from './tools/dnd5e/update-actor-item.js';
import { DnD5eManageActivityTool } from './tools/dnd5e/manage-activity.js';
import { DnD5eFreeCastTool } from './tools/dnd5e/free-cast.js';
import { DnD5eManageEffectTool } from './tools/dnd5e/manage-effect.js';
import { DnD5eConditionTool } from './tools/dnd5e/conditions.js';
import { DnD5eAddItemTool } from './tools/dnd5e/add-item.js';
import { DnD5eImportItemTool } from './tools/dnd5e/import-item.js';
import { DnD5eContentAuditTool } from './tools/dnd5e/content-audit.js';
import { DnD5eDdbImportTools } from './tools/dnd5e/ddb-import.js';
import { buildAddFeatureTool } from './tools/dnd5e/grant-to-actor.js';

import { MoltenTools } from './tools/molten/index.js';
import { AssetBridgeTools } from './tools/asset-bridge.js';
import { PlaylistTools } from './tools/playlist.js';
import { TableTools } from './tools/tables.js';
import { CardsTools } from './tools/cards.js';
import { ChatTools } from './tools/chat.js';
import { UserTools } from './tools/users.js';
import { MacroTools } from './tools/macros.js';
import { CombatTrackerTools } from './tools/combat-tracker.js';
import { OrganizationTools } from './tools/organization.js';
import { PackReaderTools } from './tools/pack-reader.js';

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

  const actorTools = new ActorTools({ foundry, logger });
  const itemTools = new ItemTools({ foundry, logger });
  const compendiumTools = new CompendiumTools({ foundry, logger });
  const sceneTools = new SceneTools({ foundry, logger });
  const placeableTools = new PlaceableTools({ foundry, logger });
  const actorCreationTools = new ActorCreationTools({ foundry, logger });

  const dnd5eAddFeatureTool = new DnD5eAddFeatureTool({ foundry, logger });
  const dnd5eNpcTools = new DnD5eNpcTools({ foundry, logger });
  const dnd5ePcTools = new DnD5ePcTools({ foundry, logger });
  const dnd5eFeaturesFromCompendiumTools = new DnD5eFeaturesFromCompendiumTools({
    foundry,
    logger,
  });
  const dnd5eUpdateActorTool = new DnD5eUpdateActorTool({ foundry, logger });
  const dnd5eUpdateActorItemTool = new DnD5eUpdateActorItemTool({ foundry, logger });
  const dnd5eManageActivityTool = new DnD5eManageActivityTool({ foundry, logger });
  const dnd5eFreeCastTool = new DnD5eFreeCastTool({ foundry, logger });
  const dnd5eManageEffectTool = new DnD5eManageEffectTool({ foundry, logger });
  const dnd5eConditionTool = new DnD5eConditionTool({ foundry, logger });
  const dnd5eAddItemTool = new DnD5eAddItemTool({ foundry, logger });
  const dnd5eImportItemTool = new DnD5eImportItemTool({ foundry, logger });
  const dnd5eContentAuditTool = new DnD5eContentAuditTool({ foundry, logger });
  // DDB import: a Node-only tool (no Foundry — it fetches a public character or parses pasted JSON).
  const dnd5eDdbImportTools = new DnD5eDdbImportTools({ logger });

  const journalTools = new JournalTools({ foundry, logger });
  const ownershipTools = new OwnershipTools({ foundry, logger });

  // Plane-B Molten file tools (WebDAV). `foundry` lets the destructive ones consult
  // find-asset-references before acting.
  const moltenTools = new MoltenTools({ logger, foundry });
  const assetBridgeTools = new AssetBridgeTools({ foundry, logger });
  const playlistTools = new PlaylistTools({ foundry, logger });
  const tableTools = new TableTools({ foundry, logger });
  const cardsTools = new CardsTools({ foundry, logger });
  const chatTools = new ChatTools({ foundry, logger });
  const userTools = new UserTools({ foundry, logger });
  const macroTools = new MacroTools({ foundry, logger });
  const combatTrackerTools = new CombatTrackerTools({ foundry, logger });
  const organizationTools = new OrganizationTools({ foundry, logger });

  // read-pack: a Node-only tool (no Foundry) — it reads a scene-pack MODULE off disk via the
  // foundryvtt-cli child process. Seeds the tom-cartos-import skill (docs/tom-cartos-import-plan.md).
  const packReaderTools = new PackReaderTools({ logger });

  // Unified add-feature tool: composes the three mode schemas (feature / compendium-features /
  // items) — each generated from the owning handler's zod — into a single-entry `add-feature`.
  const addFeatureTool = buildAddFeatureTool();

  // Collect every advertised definition into a name -> definition lookup.
  const defByName = new Map<string, any>();
  for (const def of [
    ...actorTools.getToolDefinitions(),
    ...itemTools.getToolDefinitions(),
    ...compendiumTools.getToolDefinitions(),
    ...sceneTools.getToolDefinitions(),
    ...placeableTools.getToolDefinitions(),
    ...actorCreationTools.getToolDefinitions(),
    ...dnd5eNpcTools.getToolDefinitions(),
    ...dnd5ePcTools.getToolDefinitions(),
    ...dnd5eUpdateActorTool.getToolDefinitions(),
    ...dnd5eUpdateActorItemTool.getToolDefinitions(),
    ...dnd5eManageActivityTool.getToolDefinitions(),
    ...dnd5eFreeCastTool.getToolDefinitions(),
    ...dnd5eManageEffectTool.getToolDefinitions(),
    ...dnd5eConditionTool.getToolDefinitions(),
    ...dnd5eAddItemTool.getToolDefinitions(),
    ...dnd5eImportItemTool.getToolDefinitions(),
    ...dnd5eContentAuditTool.getToolDefinitions(),
    ...dnd5eDdbImportTools.getToolDefinitions(),
    addFeatureTool,
    ...journalTools.getToolDefinitions(),
    ...ownershipTools.getToolDefinitions(),
    ...moltenTools.getToolDefinitions(),
    ...assetBridgeTools.getToolDefinitions(),
    ...playlistTools.getToolDefinitions(),
    ...tableTools.getToolDefinitions(),
    ...cardsTools.getToolDefinitions(),
    ...chatTools.getToolDefinitions(),
    ...userTools.getToolDefinitions(),
    ...macroTools.getToolDefinitions(),
    ...combatTrackerTools.getToolDefinitions(),
    ...organizationTools.getToolDefinitions(),
    ...packReaderTools.getToolDefinitions(),
  ]) {
    defByName.set(def.name, def);
  }

  const handlers: Record<string, (args: any) => Promise<any>> = {
    // Actor reads (ActorTools)
    'get-actor': args => actorTools.handleGetCharacter(args),
    'list-actors': args => actorTools.handleListCharacters(args),
    'get-actor-entity': args => actorTools.handleGetCharacterEntity(args),
    'search-actor-contents': args => actorTools.handleSearchCharacterItems(args),

    // World-item lifecycle (ItemTools): CRUD on sidebar Items + remove-from-actor. Each name routes
    // through the handleManageWorldItems dispatcher with a pre-stamped `action`.
    'create-item': args => itemTools.handleManageWorldItems({ ...args, action: 'create' }),
    'list-items': args => itemTools.handleManageWorldItems({ ...args, action: 'list' }),
    'get-item': args => itemTools.handleManageWorldItems({ ...args, action: 'get' }),
    'update-item': args => itemTools.handleManageWorldItems({ ...args, action: 'update' }),
    'delete-item': args => itemTools.handleManageWorldItems({ ...args, action: 'delete' }),
    'remove-from-actor': args =>
      itemTools.handleManageWorldItems({ ...args, action: 'remove-from-actor' }),

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

    // Actor creation — two product-aligned tools: create-actor-from-compendium (copy a pack entry,
    // the default §6 path) and author-npc (hand-authored stat block, last resort). author-npc takes
    // FLAT stat-block args.
    'create-actor-from-compendium': args =>
      actorCreationTools.handleCreateActorFromCompendium(args),
    'author-npc': args => dnd5eNpcTools.handleCreateNpc(args),
    // PC authoring (design.md §7 — siblings to author-npc, NEVER fused into createNpc):
    // create-pc (type:character + advancement → @scale resolves) + inspect-pc-advancement (read-only)
    // + level-up-pc (add a class level: single-class level-up or multiclass) + create-pc-from-prefab
    // (copy a premium pregen, the PC analog of create-actor-from-compendium).
    'create-pc': args => dnd5ePcTools.handleCreatePc(args),
    'inspect-pc-advancement': args => dnd5ePcTools.handleInspectPcAdvancement(args),
    'level-up-pc': args => dnd5ePcTools.handleLevelUpPc(args),
    'create-pc-from-prefab': args => dnd5ePcTools.handleCreatePcFromPrefab(args),
    'delete-actor': args => actorCreationTools.handleDeleteActor(args),
    'delete-folder': args => actorCreationTools.handleDeleteFolder(args),
    'update-actor': args => dnd5eUpdateActorTool.handleUpdateActor(args),
    'update-actor-item': args => dnd5eUpdateActorItemTool.handleUpdateActorItem(args),
    'manage-activity': args => dnd5eManageActivityTool.handleManageActivity(args),
    'add-free-cast': args => dnd5eFreeCastTool.handleAddFreeCast(args),
    'manage-effect': args => dnd5eManageEffectTool.handleManageEffect(args),
    'apply-condition': args => dnd5eConditionTool.handleApplyCondition(args),
    'add-item': args => dnd5eAddItemTool.handleAddItem(args),
    'import-item': args => dnd5eImportItemTool.handleImportItem(args),
    'content-audit': args => dnd5eContentAuditTool.handleContentAudit(args),
    // DDB import (design.md §7): parse a D&D Beyond character → a normalized plan for the ddb-import
    // skill. Pure + Node-only (public fetch or pasted JSON); the skill does canonicalization + build.
    'parse-ddb-character': args => dnd5eDdbImportTools.handleParseDdbCharacter(args),

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
        return itemTools.handleManageWorldItems({
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
    'create-quest-journal': args => journalTools.handleCreateQuestJournal(args),
    'link-quest-to-npc': args => journalTools.handleLinkQuestToNPC(args),
    'update-quest-journal': args => journalTools.handleUpdateQuestJournal(args),
    'list-journals': args => journalTools.handleListJournals(args),
    'search-journals': args => journalTools.handleSearchJournals(args),
    'create-journal': args => journalTools.handleCreateJournal(args),
    'update-journal': args => journalTools.handleUpdateJournal(args),
    'set-journal-page-visibility': args => journalTools.handleSetJournalPageVisibility(args),
    'delete-journal-page': args => journalTools.handleDeleteJournalPage(args),
    'delete-journal': args => journalTools.handleDeleteJournal(args),

    // Ownership
    'set-actor-ownership': args => ownershipTools.handleToolCall('set-actor-ownership', args),
    'list-actor-ownership': args => ownershipTools.handleToolCall('list-actor-ownership', args),

    // Plane-B Molten file tools
    'list-assets': args => moltenTools.handleListAssets(args),
    'asset-info': args => moltenTools.handleAssetInfo(args),
    'download-asset': args => moltenTools.handleDownloadAsset(args),
    'upload-asset': args => moltenTools.handleUploadAsset(args),
    'upload-asset-tree': args => moltenTools.handleUploadAssetTree(args),
    'create-asset-folder': args => moltenTools.handleCreateAssetFolder(args),
    'delete-asset': args => moltenTools.handleDeleteAsset(args),
    'move-asset': args => moltenTools.handleMoveAsset(args),
    'copy-asset': args => moltenTools.handleCopyAsset(args),
    'asset-url': args => moltenTools.handleAssetUrl(args),

    // Asset composition + reference integrity (Plane A)
    'find-asset-references': args => assetBridgeTools.handleFindAssetReferences(args),
    'relink-asset': args => assetBridgeTools.handleRelinkAsset(args),
    'set-actor-art': args => assetBridgeTools.handleSetActorArt(args),
    'add-journal-image': args => assetBridgeTools.handleAddJournalImage(args),

    // Scene-pack module import (Node-only, off-line): read a Tom-Cartos-style module's packs off disk
    'read-pack': args => packReaderTools.handleReadPack(args),

    // Scenes (authoring) — scene-DOCUMENT tools only; placeables are the block below
    'create-scene': args => sceneTools.handleCreateScene(args),
    'list-scenes': args => sceneTools.handleListScenes(args),
    'update-scene': args => sceneTools.handleUpdateScene(args),
    'delete-scene': args => sceneTools.handleDeleteScene(args),
    'get-scene-dimensions': args => sceneTools.handleGetSceneDimensions(args),
    'screenshot-scene': args => sceneTools.handleScreenshotScene(args),

    // Scene placeables — the per-type CRUD library over the shared kernel
    // (src/page/_placeables.ts + src/page/placeables/** + src/tools/placeables/**)
    'create-tiles': args => placeableTools.handle('create-tiles', args),
    'list-tiles': args => placeableTools.handle('list-tiles', args),
    'update-tiles': args => placeableTools.handle('update-tiles', args),
    'delete-tiles': args => placeableTools.handle('delete-tiles', args),
    'create-lights': args => placeableTools.handle('create-lights', args),
    'list-lights': args => placeableTools.handle('list-lights', args),
    'update-lights': args => placeableTools.handle('update-lights', args),
    'delete-lights': args => placeableTools.handle('delete-lights', args),
    'create-sounds': args => placeableTools.handle('create-sounds', args),
    'list-sounds': args => placeableTools.handle('list-sounds', args),
    'update-sounds': args => placeableTools.handle('update-sounds', args),
    'delete-sounds': args => placeableTools.handle('delete-sounds', args),
    'create-drawings': args => placeableTools.handle('create-drawings', args),
    'list-drawings': args => placeableTools.handle('list-drawings', args),
    'update-drawings': args => placeableTools.handle('update-drawings', args),
    'delete-drawings': args => placeableTools.handle('delete-drawings', args),
    'create-walls': args => placeableTools.handle('create-walls', args),
    'list-walls': args => placeableTools.handle('list-walls', args),
    'update-walls': args => placeableTools.handle('update-walls', args),
    'delete-walls': args => placeableTools.handle('delete-walls', args),
    'list-tokens': args => placeableTools.handle('list-tokens', args),
    'place-tokens': args => placeableTools.handle('place-tokens', args),
    'update-token': args => placeableTools.handle('update-token', args),
    'delete-tokens': args => placeableTools.handle('delete-tokens', args),
    'create-scene-notes': args => placeableTools.handle('create-scene-notes', args),
    'list-notes': args => placeableTools.handle('list-notes', args),
    'update-note': args => placeableTools.handle('update-note', args),
    'delete-note': args => placeableTools.handle('delete-note', args),
    'create-region': args => placeableTools.handle('create-region', args),
    'list-regions': args => placeableTools.handle('list-regions', args),
    'update-region': args => placeableTools.handle('update-region', args),
    'delete-region': args => placeableTools.handle('delete-region', args),
    'create-teleporter': args => placeableTools.handle('create-teleporter', args),
    'add-region-behavior': args => placeableTools.handle('add-region-behavior', args),
    'remap-teleporters': args => placeableTools.handle('remap-teleporters', args),

    // Playlists
    'create-playlist': args => playlistTools.handleCreatePlaylist(args),
    'list-playlists': args => playlistTools.handleListPlaylists(args),
    'update-playlist': args => playlistTools.handleUpdatePlaylist(args),
    'delete-playlist': args => playlistTools.handleDeletePlaylist(args),

    // Roll tables
    'create-rolltable': args => tableTools.handleCreateRollTable(args),
    'import-rolltable': args => tableTools.handleImportRollTable(args),
    'list-rolltables': args => tableTools.handleListRollTables(args),
    'update-rolltable': args => tableTools.handleUpdateRollTable(args),
    'roll-on-table': args => tableTools.handleRollOnTable(args),
    'get-rolltable': args => tableTools.handleGetRollTable(args),
    'delete-rolltable': args => tableTools.handleDeleteRollTable(args),

    // Cards
    'create-cards': args => cardsTools.handleCreateCards(args),
    'import-cards': args => cardsTools.handleImportCards(args),
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
    'list-users': args => userTools.handleListUsers(args),
    'update-user': args => userTools.handleUpdateUser(args),
    'set-user-avatar': args => userTools.handleSetUserAvatar(args),

    // Macros (world Macro documents + user hotbar pins)
    'create-macro': args => macroTools.handleCreateMacro(args),
    'list-macros': args => macroTools.handleListMacros(args),
    'delete-macro': args => macroTools.handleDeleteMacros(args),

    // Combat tracker (the core.combatTrackerConfig world setting — custom turn marker etc.)
    'configure-combat-tracker': args => combatTrackerTools.handleConfigureCombatTracker(args),

    // Organization & batch
    'list-folders': args => organizationTools.handleListFolders(args),
    'create-folder': args => organizationTools.handleCreateFolder(args),
    'update-folder': args => organizationTools.handleUpdateFolder(args),
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
