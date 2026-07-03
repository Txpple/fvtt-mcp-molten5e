// Page-side domain library — runs INSIDE the headless Foundry page.
//
// Bundled by esbuild (esbuild.page.mjs -> dist/page.bundle.js) and injected by
// src/foundry.ts after game.ready. It attaches a flat API to window.__fvtt; Node-side
// tools invoke it through the foundry.call(name, args) seam. Nothing here imports
// Node/Playwright — only browser + Foundry globals (see foundry-globals.d.ts).
//
// The api keys ARE the bridge method names: foundry.call('getCharacterInfo', args)
// === window.__fvtt.getCharacterInfo(args). They match the legacy
// foundry-mcp-bridge.<name> methods 1:1, so the Node tools rewire mechanically.

import { getWorldInfo } from './world.js';
import {
  getActiveScene,
  listScenes,
  createScene,
  updateScene,
  deleteScenes,
  getSceneDimensions,
  prepareSceneShot,
} from './scenes.js';
import {
  createSceneTiles,
  listSceneTiles,
  updateSceneTiles,
  deleteSceneTiles,
} from './placeables/tile.js';
import {
  createSceneLights,
  listSceneLights,
  updateSceneLights,
  deleteSceneLights,
} from './placeables/light.js';
import {
  listSceneTokens,
  placeSceneTokens,
  deleteSceneTokens,
  updateSceneTokens,
} from './placeables/token.js';
import {
  createSceneNotes,
  listSceneNotes,
  updateSceneNotes,
  deleteSceneNotes,
} from './placeables/note.js';
import {
  createSceneRegions,
  listSceneRegions,
  updateSceneRegions,
  deleteSceneRegions,
  createSceneTeleporter,
  remapSceneTeleporters,
} from './placeables/region.js';
import {
  createSceneSounds,
  listSceneSounds,
  updateSceneSounds,
  deleteSceneSounds,
} from './placeables/sound.js';
import {
  createSceneDrawings,
  listSceneDrawings,
  updateSceneDrawings,
  deleteSceneDrawings,
} from './placeables/drawing.js';
import {
  createSceneWalls,
  listSceneWalls,
  updateSceneWalls,
  deleteSceneWalls,
} from './placeables/wall.js';
import {
  listActors,
  getCharacterInfo,
  getCharacterEntity,
  searchCharacterItems,
  findActor,
  createActorFromCompendium,
  deleteActor,
  addActorItems,
  removeActorItems,
  updateActor,
  updateActorItem,
} from './actors.js';
import { searchCompendium, getAvailablePacks, getCompendiumDocumentFull } from './compendium.js';
import {
  listJournals,
  getJournalContent,
  getJournalPageContent,
  createJournal,
  updateJournalContent,
  updateJournal,
  setJournalPageVisibility,
  deleteJournalPage,
  deleteJournals,
} from './journals.js';
import {
  listWorldItems,
  getWorldItem,
  createWorldItems,
  updateWorldItems,
  deleteWorldItems,
} from './items.js';
import {
  getActorOwnership,
  setActorOwnership,
  getFriendlyNPCs,
  getPartyCharacters,
  getConnectedPlayers,
  findPlayers,
} from './ownership.js';
import {
  listPlaylists,
  listRollTables,
  getRollTable,
  listCards,
  rollOnTable,
  createPlaylist,
  updatePlaylist,
  deletePlaylists,
  createRollTable,
  updateRollTable,
  deleteRollTables,
  importRollTable,
  createCards,
  importCardsPreset,
  deleteCards,
} from './collections.js';
import {
  postChatMessage,
  listChatMessages,
  deleteChatMessages,
  exportChatLog,
  postItemCard,
  requestRoll,
} from './chat.js';
import { setUserAvatar } from './users.js';
import {
  createFolder,
  updateFolder,
  moveDocuments,
  bulkDelete,
  deleteFolder,
} from './organization.js';
import { manageEffect } from './effects.js';
import { findAssetReferences, relinkAsset, setActorArt, addJournalImage } from './assets.js';
import { searchCompendiumFaceted } from './compendium-facets.js';
import { createNpcActor } from './dnd5e/npc.js';
import { applyCondition } from './dnd5e/conditions.js';
import { addSaveFeatureToActor, addPassiveFeatureToActor } from './dnd5e/features.js';
import { addAttackToActor, addAuraToActor, addAttackWithSaveToActor } from './dnd5e/attacks.js';
import { setActorSpellcasting, addSpellsToActor, addHomebrewSpellToActor } from './dnd5e/spells.js';
import { addFeaturesFromCompendium } from './dnd5e/compendium-features.js';
import { addItem, importItemFromCompendium } from './dnd5e/items.js';
import { auditContent } from './dnd5e/content-audit.js';
import { manageActivity } from './dnd5e/manage-activity.js';
import {
  createPcActor,
  createPcFromPrefab,
  inspectAdvancementChoices,
  levelUpPc,
} from './dnd5e/advancement.js';

const api = {
  // world / scene (scene-DOCUMENT ops only — placeables live below)
  getWorldInfo,
  getActiveScene,
  listScenes,
  createScene,
  updateScene,
  deleteScenes,
  getSceneDimensions,
  prepareSceneShot,
  // scene placeables (per-type CRUD over the shared kernel, src/page/placeables/**)
  createSceneTiles,
  listSceneTiles,
  updateSceneTiles,
  deleteSceneTiles,
  createSceneLights,
  listSceneLights,
  updateSceneLights,
  deleteSceneLights,
  listSceneTokens,
  placeSceneTokens,
  deleteSceneTokens,
  updateSceneTokens,
  createSceneNotes,
  listSceneNotes,
  updateSceneNotes,
  deleteSceneNotes,
  createSceneRegions,
  listSceneRegions,
  updateSceneRegions,
  deleteSceneRegions,
  createSceneTeleporter,
  remapSceneTeleporters,
  createSceneSounds,
  listSceneSounds,
  updateSceneSounds,
  deleteSceneSounds,
  createSceneDrawings,
  listSceneDrawings,
  updateSceneDrawings,
  deleteSceneDrawings,
  createSceneWalls,
  listSceneWalls,
  updateSceneWalls,
  deleteSceneWalls,
  // actors / characters
  listActors,
  getCharacterInfo,
  getCharacterEntity,
  searchCharacterItems,
  findActor,
  createActorFromCompendium,
  deleteActor,
  addActorItems,
  removeActorItems,
  updateActor,
  updateActorItem,
  // compendium
  searchCompendium,
  getAvailablePacks,
  getCompendiumDocumentFull,
  searchCompendiumFaceted,
  // journals
  listJournals,
  getJournalContent,
  getJournalPageContent,
  createJournal,
  updateJournalContent,
  updateJournal,
  setJournalPageVisibility,
  deleteJournalPage,
  deleteJournals,
  // world items
  listWorldItems,
  getWorldItem,
  createWorldItems,
  updateWorldItems,
  deleteWorldItems,
  // ownership / players
  getActorOwnership,
  setActorOwnership,
  getFriendlyNPCs,
  getPartyCharacters,
  getConnectedPlayers,
  findPlayers,
  // collections (playlists / roll tables / cards)
  listPlaylists,
  listRollTables,
  getRollTable,
  listCards,
  rollOnTable,
  createPlaylist,
  updatePlaylist,
  deletePlaylists,
  createRollTable,
  updateRollTable,
  deleteRollTables,
  importRollTable,
  createCards,
  importCardsPreset,
  deleteCards,
  // chat log (post / list / delete / export / dnd5e cards / roll requests)
  postChatMessage,
  listChatMessages,
  deleteChatMessages,
  exportChatLog,
  postItemCard,
  requestRoll,
  // users
  setUserAvatar,
  // organization (folders / move / bulk-delete)
  createFolder,
  updateFolder,
  moveDocuments,
  bulkDelete,
  deleteFolder,
  // active effects (create/edit/delete/list on actor or item)
  manageEffect,
  // assets (reference integrity + art/image composition)
  findAssetReferences,
  relinkAsset,
  setActorArt,
  addJournalImage,
  // dnd5e actor authoring (npc creation, feature/attack/aura/spell authoring, compendium import)
  createNpcActor,
  applyCondition,
  addPassiveFeatureToActor,
  addSaveFeatureToActor,
  addAttackToActor,
  addAttackWithSaveToActor,
  addAuraToActor,
  setActorSpellcasting,
  addSpellsToActor,
  addHomebrewSpellToActor,
  addFeaturesFromCompendium,
  addItem,
  importItemFromCompendium,
  auditContent,
  manageActivity,
  // dnd5e PC authoring (leveling engine: type:character + advancement → @scale resolves natively)
  createPcActor,
  createPcFromPrefab,
  inspectAdvancementChoices,
  levelUpPc,
} satisfies Record<string, (...args: any[]) => unknown>;

/**
 * The exact tool↔page contract: each key is a bridge method name and its value is the
 * page handler's signature. `FoundryBridge.call` (src/foundry.ts) narrows its `name`
 * parameter to `keyof PageApi`, so a mistyped method name is a COMPILE error caught by
 * the gate, not a runtime "Unknown page function" in a live session. Registering a
 * handler in `api` is the single step that exposes it across the seam.
 */
export type PageApi = typeof api;

window.__fvtt = api;
