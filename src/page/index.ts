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
import { getActiveScene, listScenes, createScene, updateScene, deleteScenes } from './scenes.js';
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
} from './actors.js';
import { searchCompendium, getAvailablePacks, getCompendiumDocumentFull } from './compendium.js';
import {
  listJournals,
  getJournalContent,
  getJournalPageContent,
  createJournalEntry,
  createJournal,
  updateJournalContent,
  updateJournal,
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
  listCards,
  rollOnTable,
  createPlaylist,
  updatePlaylist,
  deletePlaylists,
  createRollTable,
  updateRollTable,
  deleteRollTables,
  createCards,
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
import { createFolder, moveDocuments, bulkDelete, deleteFolder } from './organization.js';
import { findAssetReferences, relinkAsset, setActorArt, addJournalImage } from './assets.js';
import { getEnhancedCreatureIndex, listCreaturesByCriteria } from './creature-index.js';
import { createNpcActor } from './dnd5e/npc.js';
import { addSaveFeatureToActor, addPassiveFeatureToActor } from './dnd5e/features.js';
import { addAttackToActor, addAuraToActor, addAttackWithSaveToActor } from './dnd5e/attacks.js';
import { setActorSpellcasting, addSpellsToActor } from './dnd5e/spells.js';
import { addFeaturesFromCompendium } from './dnd5e/compendium-features.js';

const api: Window['__fvtt'] = {
  // world / scene
  getWorldInfo,
  getActiveScene,
  listScenes,
  createScene,
  updateScene,
  deleteScenes,
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
  // compendium
  searchCompendium,
  getAvailablePacks,
  getCompendiumDocumentFull,
  getEnhancedCreatureIndex,
  listCreaturesByCriteria,
  // journals
  listJournals,
  getJournalContent,
  getJournalPageContent,
  createJournalEntry,
  createJournal,
  updateJournalContent,
  updateJournal,
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
  listCards,
  rollOnTable,
  createPlaylist,
  updatePlaylist,
  deletePlaylists,
  createRollTable,
  updateRollTable,
  deleteRollTables,
  createCards,
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
  moveDocuments,
  bulkDelete,
  deleteFolder,
  // assets (reference integrity + art/image composition)
  findAssetReferences,
  relinkAsset,
  setActorArt,
  addJournalImage,
  // dnd5e actor authoring (npc creation, feature/attack/aura/spell authoring, compendium import)
  createNpcActor,
  addPassiveFeatureToActor,
  addSaveFeatureToActor,
  addAttackToActor,
  addAttackWithSaveToActor,
  addAuraToActor,
  setActorSpellcasting,
  addSpellsToActor,
  addFeaturesFromCompendium,
};

window.__fvtt = api;
