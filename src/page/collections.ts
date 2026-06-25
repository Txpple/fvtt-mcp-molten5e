// Page-side: world collection reads + writes (playlists, roll tables, cards) + table rolls.
// Runs INSIDE the headless Foundry page. Reads/rolls are pure against game.* collections;
// writes (create/update/delete) perform awaited Foundry document mutations and are best-effort
// (no rollback). No permission/transaction/settings scaffolding — the bridge is always GM.
// Return shapes match the Node tools' existing contract (see
// src/tools/{tables,cards,asset-bridge}.ts + their tests).

import { assertNoSrdPacks, isSrdPack } from '../utils/compendium-sources.js';
import {
  basename,
  getOrCreateFolder,
  importFromCompendium,
  normalizeAssetPath,
} from './_shared.js';

// Foundry document classes (Playlist, RollTable, Cards) and CONST live in the page
// global scope but are not declared in foundry-globals.d.ts; reach them off globalThis (loosely
// typed). Mirrors the pattern in src/page/items.ts.
const PlaylistClass: any = (globalThis as any).Playlist;
const RollTableClass: any = (globalThis as any).RollTable;
const CardsClass: any = (globalThis as any).Cards;
const CONST_: any = (globalThis as any).CONST;
// Foundry's global UUID resolver — async, resolves compendium AND world documents.
const fromUuid_: (uuid: string) => Promise<any> = (globalThis as any).fromUuid;

// --- local helpers (sharedHelpersNeeded: a generic id/name document resolver) ---

// Strict resolution: exact id, then exact name. No fuzzy/substring matching.
function resolveStrict(collection: any, identifier: string): any {
  return (
    collection?.get(identifier) ||
    collection?.getName?.(identifier) ||
    collection?.find?.((d: any) => d.name === identifier) ||
    null
  );
}

// Shared strict-delete helper for top-level world documents. Resolves each
// identifier via the supplied strict resolver (exact id/name), deletes it, and
// reports deleted + notFound. Best-effort (no rollback).
async function deleteByResolver(
  identifiers: string[],
  resolver: (id: string) => any
): Promise<{
  success: boolean;
  deletedCount: number;
  deleted: Array<{ id: string; name: string }>;
  notFound?: string[];
}> {
  if (!Array.isArray(identifiers) || identifiers.length === 0) {
    throw new Error('identifiers array is required and must contain at least one entry');
  }

  const deleted: Array<{ id: string; name: string }> = [];
  const notFound: string[] = [];

  for (const identifier of identifiers) {
    const doc = resolver(identifier);
    if (doc) {
      const info = { id: doc.id ?? identifier, name: doc.name ?? '' };
      await doc.delete();
      deleted.push(info);
    } else {
      notFound.push(identifier);
    }
  }

  return {
    success: true,
    deletedCount: deleted.length,
    deleted,
    ...(notFound.length > 0 ? { notFound } : {}),
  };
}

// --- collection lists ---

export function listPlaylists(): unknown {
  return (game.playlists?.contents ?? []).map((p: any) => ({
    id: p.id ?? '',
    name: p.name ?? '',
    mode: p.mode ?? 0,
    soundCount: p.sounds?.size ?? 0,
    playing: p.playing ?? false,
  }));
}

export function listRollTables(): unknown {
  return (game.tables?.contents ?? []).map((t: any) => ({
    id: t.id ?? '',
    name: t.name ?? '',
    formula: t.formula ?? '',
    resultCount: t.results?.size ?? 0,
    description: t.description ?? '',
  }));
}

export function listCards(): unknown {
  return (game.cards?.contents ?? []).map((c: any) => ({
    id: c.id ?? '',
    name: c.name ?? '',
    type: c.type ?? '',
    cardCount: c.cards?.size ?? 0,
  }));
}

// --- table rolls ---

// Roll on a RollTable, evaluating without marking results drawn or posting to chat.
export async function rollOnTable(args: { identifier: string }): Promise<unknown> {
  const identifier = args?.identifier;
  const table = resolveStrict(game.tables, identifier);
  if (!table) {
    return { success: true, rolled: false, notFound: identifier };
  }

  // roll() evaluates without marking results drawn or posting to chat.
  const { roll, results } = await table.roll();
  return {
    success: true,
    rolled: true,
    tableId: table.id,
    tableName: table.name,
    total: roll?.total,
    formula: roll?.formula ?? table.formula,
    results: (results ?? []).map((r: any) => {
      // v14 canonical field is `description`; `text` is a deprecation getter. Surface any
      // @UUID enricher links so a skill can import the real items a drawn loot entry references.
      const description = r.description ?? r.text ?? '';
      return {
        id: r.id,
        text: description,
        description,
        range: r.range,
        links: parseUuidLinks(description),
      };
    }),
  };
}

// --- playlist writes ---

// Default Foundry playlist-mode constants if CONST.PLAYLIST_MODES is unavailable.
const PLAYLIST_MODE_FALLBACK = {
  DISABLED: -1,
  SEQUENTIAL: 0,
  SHUFFLE: 1,
  SIMULTANEOUS: 2,
  SOUNDBOARD: 3,
};

function playlistModeMap(): Record<string, number> {
  const PM = CONST_?.PLAYLIST_MODES || PLAYLIST_MODE_FALLBACK;
  return {
    sequential: PM.SEQUENTIAL,
    shuffle: PM.SHUFFLE,
    simultaneous: PM.SIMULTANEOUS,
    soundboard: PM.SOUNDBOARD,
    disabled: PM.DISABLED,
  };
}

// Create a Playlist from Data-relative sound paths, building one PlaylistSound
// child per path (name from basename, normalized path, shared volume/repeat).
export async function createPlaylist(args: {
  name: string;
  soundPaths: string[];
  mode?: string;
  fade?: number;
  defaultVolume?: number;
  repeat?: boolean;
}): Promise<unknown> {
  if (!args?.name || typeof args.name !== 'string') {
    throw new Error('name is required');
  }
  const soundPaths = Array.isArray(args.soundPaths)
    ? args.soundPaths.filter((p: any) => typeof p === 'string' && p.length > 0)
    : [];
  if (soundPaths.length === 0) {
    throw new Error('soundPaths array is required and must contain at least one path');
  }

  const PM = CONST_?.PLAYLIST_MODES || PLAYLIST_MODE_FALLBACK;
  const modeMap = playlistModeMap();
  const mode = modeMap[(args.mode || 'sequential').toLowerCase()] ?? PM.SEQUENTIAL;
  const volume = typeof args.defaultVolume === 'number' ? args.defaultVolume : 0.5;
  const repeat = args.repeat === true;

  const sounds = soundPaths.map((p: string) => ({
    name: basename(normalizeAssetPath(p)),
    path: normalizeAssetPath(p),
    volume,
    repeat,
  }));
  const playlistData: any = { name: args.name, mode, sounds };
  if (typeof args.fade === 'number') playlistData.fade = args.fade;

  const playlist = await PlaylistClass.create(playlistData);
  return {
    success: true,
    playlistId: playlist?.id,
    playlistName: playlist?.name,
    mode: args.mode || 'sequential',
    soundCount: playlist?.sounds?.size ?? sounds.length,
    sounds: Array.from(playlist?.sounds || []).map((s: any) => ({
      id: s.id,
      name: s.name,
      path: s.path,
    })),
  };
}

// Update a Playlist's document fields (name, mode, fade). Does not add/remove
// tracks. Returns updated:false / notFound when the identifier doesn't resolve.
export async function updatePlaylist(args: {
  identifier: string;
  name?: string;
  mode?: string;
  fade?: number;
}): Promise<unknown> {
  const playlist = resolveStrict(game.playlists, args.identifier);
  if (!playlist) {
    return { success: true, updated: false, notFound: args.identifier };
  }

  const modeMap = playlistModeMap();
  const update: any = {};
  if (typeof args.name === 'string' && args.name.trim().length > 0) update.name = args.name.trim();
  if (typeof args.mode === 'string') {
    const m = modeMap[args.mode.toLowerCase()];
    if (m === undefined) throw new Error(`Unknown playlist mode "${args.mode}"`);
    update.mode = m;
  }
  if (typeof args.fade === 'number') update.fade = args.fade;

  if (Object.keys(update).length === 0) {
    throw new Error('Provide at least one field to update (name, mode, fade)');
  }

  await playlist.update(update);
  return { success: true, updated: true, playlistId: playlist.id, playlistName: playlist.name };
}

// Delete one or more Playlist documents by exact id/name. Best-effort.
export async function deletePlaylists(args: { identifiers: string[] }): Promise<unknown> {
  return deleteByResolver(args.identifiers, id => resolveStrict(game.playlists, id));
}

// --- roll table writes ---

// Input shape for one table entry (Node-validated by tables.ts; mirrored here).
interface RollTableResultInput {
  text?: string;
  uuid?: string;
  name?: string;
  weight?: number;
  range?: [number, number];
}

// Parse the pack id from a Compendium UUID: "Compendium.<scope>.<pack>.<Type>.<id>" -> "<scope>.<pack>".
// Returns null for a world UUID ("Actor.<id>", "Item.<id>") — those carry no pack to SRD-check.
function packIdFromUuid(uuid: string): string | null {
  const parts = (uuid || '').split('.');
  return parts[0] === 'Compendium' && parts.length >= 3 ? `${parts[1]}.${parts[2]}` : null;
}

// Extract @UUID[uuid]{label} enricher links from a result description (for roll-on-table to surface
// the real items a drawn loot entry references, so a skill can import them).
function parseUuidLinks(text: string): Array<{ uuid: string; label: string }> {
  const out: Array<{ uuid: string; label: string }> = [];
  const re = /@UUID\[([^\]]+)\]\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec iteration
  while ((m = re.exec(text || '')) !== null) out.push({ uuid: m[1], label: m[2] });
  return out;
}

// Build the v14 TableResult `description` (HTMLField — the canonical result text; v14 dropped the
// old `text` field) for ONE input entry. Correctness only (design.md §2.1):
//   - a `uuid` is validated (compendium UUIDs must be premium-book, never SRD — §2.3) and resolved
//     (refused if it doesn't exist — §2.4 ask-don't-invent), then rendered as a book-style
//     `@UUID[uuid]{name}` enricher — exactly how the published loot tables link items;
//   - literal `text` is used as-is, but any hand-written SRD `@UUID` link in it is refused, so
//     "never SRD" holds by construction even for prose results;
//   - `text` + `uuid` combine: a `{{link}}` placeholder in `text` is replaced by the link (mixed
//     loot like "a pouch holding {{link}} and 2d6 gp"); otherwise the link is appended.
async function buildResultDescription(r: RollTableResultInput): Promise<string> {
  const text = typeof r.text === 'string' ? r.text : '';
  const uuid = typeof r.uuid === 'string' ? r.uuid.trim() : '';

  if (uuid) {
    const packId = packIdFromUuid(uuid);
    if (packId && isSrdPack(packId)) {
      throw new Error(
        `refusing to reference SRD pack "${packId}" in a table result (design.md §2.3): link the ` +
          'premium-book item instead (dnd-monster-manual.*, dnd-players-handbook.*, dnd-dungeon-masters-guide.*).'
      );
    }
    const doc = typeof fromUuid_ === 'function' ? await fromUuid_(uuid) : null;
    if (!doc) {
      throw new Error(
        `could not resolve uuid "${uuid}" — use search-compendium / get-compendium-entry to find a ` +
          "real premium-book item (design.md §2.4: ask, don't invent)."
      );
    }
    const label =
      typeof r.name === 'string' && r.name.trim().length > 0 ? r.name.trim() : (doc.name ?? uuid);
    const link = `@UUID[${uuid}]{${label}}`;
    if (text.trim().length > 0) {
      return text.includes('{{link}}') ? text.split('{{link}}').join(link) : `${text} ${link}`;
    }
    return link;
  }

  if (text.trim().length === 0) {
    throw new Error('each result needs either "text" or "uuid"');
  }
  // Never emit an SRD reference, even from hand-written enricher text (design.md §2.3).
  for (const lnk of parseUuidLinks(text)) {
    const linkPackId = packIdFromUuid(lnk.uuid);
    if (linkPackId && isSrdPack(linkPackId)) {
      throw new Error(
        `refusing an SRD @UUID reference to "${linkPackId}" in result text (design.md §2.3): ` +
          'use the premium-book equivalent.'
      );
    }
  }
  return text;
}

// Build TableResult child data from the input results, auto-assigning sequential ranges from
// weights when explicit ranges are omitted so the table is immediately rollable. Each entry's
// `description` is built (and compendium links validated) by buildResultDescription. Async because
// resolving a `uuid` to its document name is async; the range cursor is sequential so this stays a
// for-loop (not Promise.all). Throws (prefixed with the entry index) on an empty/invalid entry.
async function buildTableResults(results: RollTableResultInput[]): Promise<
  Array<{
    type: string;
    description: string;
    weight: number;
    range: [number, number];
    drawn: boolean;
  }>
> {
  const TEXT = CONST_?.TABLE_RESULT_TYPES?.TEXT ?? 'text';
  const out: Array<{
    type: string;
    description: string;
    weight: number;
    range: [number, number];
    drawn: boolean;
  }> = [];
  let cursor = 1;
  for (let idx = 0; idx < results.length; idx++) {
    const r = results[idx];
    let description: string;
    try {
      description = await buildResultDescription(r ?? {});
    } catch (e: any) {
      throw new Error(`results[${idx}]: ${e?.message ?? e}`);
    }
    const weight = typeof r?.weight === 'number' && r.weight > 0 ? Math.floor(r.weight) : 1;
    let range: [number, number];
    if (Array.isArray(r?.range) && r.range.length === 2) {
      range = [r.range[0], r.range[1]];
      cursor = Math.max(cursor, r.range[1] + 1);
    } else {
      range = [cursor, cursor + weight - 1];
      cursor += weight;
    }
    out.push({ type: TEXT, description, weight, range, drawn: false });
  }
  return out;
}

// Create a RollTable from text results. Ranges auto-assign from weights and the
// formula defaults to 1d<maxRange> unless an explicit formula is supplied.
export async function createRollTable(args: {
  name: string;
  description?: string;
  formula?: string;
  replacement?: boolean;
  displayRoll?: boolean;
  folderName?: string;
  results: RollTableResultInput[];
}): Promise<unknown> {
  if (!args?.name || args.name.trim().length === 0) {
    throw new Error('name is required and must be a non-empty string');
  }
  if (!Array.isArray(args.results) || args.results.length === 0) {
    throw new Error('results array is required and must contain at least one entry');
  }

  const results = await buildTableResults(args.results);
  const maxRange = results.reduce((m, r) => Math.max(m, r.range[1]), 0);
  const formula =
    typeof args.formula === 'string' && args.formula.trim().length > 0
      ? args.formula.trim()
      : `1d${maxRange}`;

  const tableData: any = {
    name: args.name,
    description: args.description ?? '',
    formula,
    replacement: args.replacement !== false,
    displayRoll: args.displayRoll !== false,
    results,
  };
  if (args.folderName && args.folderName.trim().length > 0) {
    tableData.folder = await getOrCreateFolder(args.folderName.trim(), 'RollTable');
  }

  const table = await RollTableClass.create(tableData);
  return {
    success: true,
    tableId: table?.id,
    tableName: table?.name,
    formula: table?.formula ?? formula,
    resultCount: table?.results?.size ?? results.length,
  };
}

// Update a RollTable's fields and/or replace its entire result set. Supplying
// results deletes existing TableResult children and recreates them with
// auto-assigned ranges. Returns updated:false / notFound when unresolved.
export async function updateRollTable(args: {
  identifier: string;
  name?: string;
  description?: string;
  formula?: string;
  replacement?: boolean;
  displayRoll?: boolean;
  results?: RollTableResultInput[];
}): Promise<unknown> {
  const table = resolveStrict(game.tables, args.identifier);
  if (!table) {
    return { success: true, updated: false, notFound: args.identifier };
  }

  const update: any = {};
  if (typeof args.name === 'string' && args.name.trim().length > 0) update.name = args.name.trim();
  if (typeof args.description === 'string') update.description = args.description;
  if (typeof args.formula === 'string' && args.formula.trim().length > 0)
    update.formula = args.formula.trim();
  if (typeof args.replacement === 'boolean') update.replacement = args.replacement;
  if (typeof args.displayRoll === 'boolean') update.displayRoll = args.displayRoll;

  const replacingResults = Array.isArray(args.results) && args.results.length > 0;
  if (Object.keys(update).length === 0 && !replacingResults) {
    throw new Error(
      'Provide at least one field to update (name, description, formula, replacement, displayRoll, results)'
    );
  }

  if (Object.keys(update).length > 0) await table.update(update);

  // Replace the full result set when results are supplied.
  if (replacingResults) {
    const existingIds = (table.results?.contents ?? []).map((r: any) => r.id);
    if (existingIds.length > 0) {
      await table.deleteEmbeddedDocuments('TableResult', existingIds);
    }
    const newResults = await buildTableResults(args.results!);
    await table.createEmbeddedDocuments('TableResult', newResults);
  }

  return {
    success: true,
    updated: true,
    tableId: table.id,
    tableName: table.name,
    resultCount: table.results?.size ?? 0,
  };
}

// Delete one or more RollTable documents by exact id/name. Best-effort.
export async function deleteRollTables(args: { identifiers: string[] }): Promise<unknown> {
  return deleteByResolver(args.identifiers, id => resolveStrict(game.tables, id));
}

// Copy a whole RollTable from a compendium pack into the world (the table-level analog of
// import-item / create-actor-from-compendium). RollTables are world-only at roll time, so a
// published table (e.g. the DMG treasure / magic-item tables) must be brought into the world before
// it can be rolled. Routes through the one copy primitive (importFromCompendium — design.md §0.2):
// whole-document toObject() with a fresh top-level id; the embedded TableResult children (and the
// @UUID item links in their descriptions) come along intact. Premium-book sources only — an SRD pack
// is refused by construction (design.md §2.3).
export async function importRollTable(args: {
  packId: string;
  itemId: string;
  folderName?: string;
}): Promise<unknown> {
  if (!args?.packId || !args?.itemId) {
    throw new Error('Both packId and itemId are required');
  }
  assertNoSrdPacks(args.packId, 'import-rolltable');

  const { data } = await importFromCompendium(args.packId, args.itemId, {
    requirePackType: 'RollTable',
  });
  if (args.folderName && args.folderName.trim().length > 0) {
    data.folder = await getOrCreateFolder(args.folderName.trim(), 'RollTable');
  }

  const table = await RollTableClass.create(data);
  return {
    success: true,
    tableId: table?.id,
    tableName: table?.name,
    formula: table?.formula ?? data.formula,
    resultCount: table?.results?.size ?? (Array.isArray(data.results) ? data.results.length : 0),
  };
}

// --- cards writes ---

// Create a Cards stack (deck/hand/pile) with optional initial cards. Each card carries one face
// (v14 face shape: { name, text?, img? }) so a card can show ART (a Data-relative img), effect TEXT
// (HTML — e.g. a Deck of Many Things outcome), or both; a card with neither gets no face (a plain
// named card). The card-level `description` is GM/meta text (distinct from the face `text` shown on
// the card).
export async function createCards(args: {
  name: string;
  type?: string;
  description?: string;
  folderName?: string;
  cards?: Array<{ name: string; description?: string; text?: string; img?: string }>;
}): Promise<unknown> {
  if (!args?.name || args.name.trim().length === 0) {
    throw new Error('name is required and must be a non-empty string');
  }

  const cardsDocTypes = game.system?.documentTypes?.Cards;
  const validTypes: string[] =
    cardsDocTypes && typeof cardsDocTypes === 'object'
      ? Object.keys(cardsDocTypes)
      : ['deck', 'hand', 'pile'];
  const type = args.type && validTypes.includes(args.type) ? args.type : 'deck';

  const cards = Array.isArray(args.cards)
    ? args.cards.map((c, idx) => {
        if (!c || typeof c.name !== 'string' || c.name.trim().length === 0) {
          throw new Error(`cards[${idx}]: "name" is required and must be a non-empty string`);
        }
        const card: any = { name: c.name, type: 'base' };
        if (typeof c.description === 'string') card.description = c.description;
        const hasImg = typeof c.img === 'string' && c.img.length > 0;
        const hasText = typeof c.text === 'string' && c.text.trim().length > 0;
        if (hasImg || hasText) {
          const face: any = { name: c.name };
          if (hasImg) face.img = normalizeAssetPath(c.img as string);
          if (hasText) face.text = c.text;
          card.faces = [face];
          card.face = 0;
        }
        return card;
      })
    : [];

  const cardsData: any = { name: args.name, type, description: args.description ?? '' };
  if (cards.length > 0) cardsData.cards = cards;
  if (args.folderName && args.folderName.trim().length > 0) {
    cardsData.folder = await getOrCreateFolder(args.folderName.trim(), 'Cards');
  }

  const doc = await CardsClass.create(cardsData);
  return {
    success: true,
    cardsId: doc?.id,
    cardsName: doc?.name,
    type: doc?.type ?? type,
    cardCount: doc?.cards?.size ?? cards.length,
  };
}

// Instantiate a core Foundry PRESET deck into the world (e.g. a standard 52-card poker deck). Cards
// have no premium-book compendium (design.md §2.3 compendium-first is N/A — decks are asset-driven,
// like scenes), but core ships preset decks in CONFIG.Cards.presets; this is the sanctioned "import a
// ready-made deck" path. Mirrors Foundry's own preset loader: fetch the preset JSON, then create.
export async function importCardsPreset(args: {
  preset: string;
  name?: string;
  folderName?: string;
}): Promise<unknown> {
  const presets = (globalThis as any).CONFIG?.Cards?.presets ?? {};
  const preset = presets[args?.preset ?? ''];
  if (!preset) {
    const available = Object.keys(presets).join(', ') || '(none)';
    throw new Error(`Unknown card preset "${args?.preset}". Available presets: ${available}.`);
  }
  const fetchJson = (globalThis as any).foundry?.utils?.fetchJsonWithTimeout;
  const data =
    typeof fetchJson === 'function'
      ? await fetchJson(preset.src)
      : await fetch(preset.src).then((r: any) => r.json());
  if (!data || typeof data !== 'object') {
    throw new Error(`Preset "${args.preset}" did not load a deck (src: ${preset.src}).`);
  }
  if (args.name && args.name.trim().length > 0) data.name = args.name.trim();
  if (args.folderName && args.folderName.trim().length > 0) {
    data.folder = await getOrCreateFolder(args.folderName.trim(), 'Cards');
  }
  delete data._id; // fresh local id

  const doc = await CardsClass.create(data);
  return {
    success: true,
    cardsId: doc?.id,
    cardsName: doc?.name,
    type: doc?.type ?? data.type,
    cardCount: doc?.cards?.size ?? (Array.isArray(data.cards) ? data.cards.length : 0),
    preset: args.preset,
  };
}

// Delete one or more Cards stacks by exact id/name. Best-effort.
export async function deleteCards(args: { identifiers: string[] }): Promise<unknown> {
  return deleteByResolver(args.identifiers, id => resolveStrict(game.cards, id));
}
