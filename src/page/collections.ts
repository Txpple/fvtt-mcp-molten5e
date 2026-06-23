// Page-side: world collection reads + writes (playlists, roll tables, cards) + table rolls.
// Runs INSIDE the headless Foundry page. Reads/rolls are pure against game.* collections;
// writes (create/update/delete) perform awaited Foundry document mutations and are best-effort
// (no rollback). No permission/transaction/settings scaffolding — the bridge is always GM.
// Return shapes match the Node tools' existing contract (see
// src/tools/{tables,cards,asset-bridge}.ts + their tests).

import { normalizeAssetPath, basename, getOrCreateFolder } from './_shared.js';

// Foundry document classes (Playlist, RollTable, Cards) and CONST live in the page
// global scope but are not declared in foundry-globals.d.ts; reach them off globalThis (loosely
// typed). Mirrors the pattern in src/page/items.ts.
const PlaylistClass: any = (globalThis as any).Playlist;
const RollTableClass: any = (globalThis as any).RollTable;
const CardsClass: any = (globalThis as any).Cards;
const CONST_: any = (globalThis as any).CONST;

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
    results: (results ?? []).map((r: any) => ({
      id: r.id,
      text: r.text ?? r.description ?? '',
      range: r.range,
    })),
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

// Build TableResult child data from the input results, auto-assigning sequential
// ranges from weights when explicit ranges are omitted so the table is
// immediately rollable. Throws on an empty/missing result text.
function buildTableResults(
  results: Array<{ text: string; weight?: number; range?: [number, number] }>
): Array<{ type: string; text: string; weight: number; range: [number, number]; drawn: boolean }> {
  let cursor = 1;
  return results.map((r, idx) => {
    if (!r || typeof r.text !== 'string' || r.text.trim().length === 0) {
      throw new Error(`results[${idx}]: "text" is required and must be a non-empty string`);
    }
    const weight = typeof r.weight === 'number' && r.weight > 0 ? Math.floor(r.weight) : 1;
    let range: [number, number];
    if (Array.isArray(r.range) && r.range.length === 2) {
      range = [r.range[0], r.range[1]];
      cursor = Math.max(cursor, r.range[1] + 1);
    } else {
      range = [cursor, cursor + weight - 1];
      cursor += weight;
    }
    return { type: 'text', text: r.text, weight, range, drawn: false };
  });
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
  results: Array<{ text: string; weight?: number; range?: [number, number] }>;
}): Promise<unknown> {
  if (!args?.name || args.name.trim().length === 0) {
    throw new Error('name is required and must be a non-empty string');
  }
  if (!Array.isArray(args.results) || args.results.length === 0) {
    throw new Error('results array is required and must contain at least one entry');
  }

  const results = buildTableResults(args.results);
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
  results?: Array<{ text: string; weight?: number; range?: [number, number] }>;
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
    const newResults = buildTableResults(args.results!);
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

// --- cards writes ---

// Create a Cards stack (deck/hand/pile) with optional initial cards. Each card
// with a Data-relative img gets a single face built from the normalized path.
export async function createCards(args: {
  name: string;
  type?: string;
  description?: string;
  folderName?: string;
  cards?: Array<{ name: string; description?: string; img?: string }>;
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
        if (typeof c.img === 'string' && c.img.length > 0) {
          const src = normalizeAssetPath(c.img);
          card.faces = [{ name: c.name, img: src }];
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

// Delete one or more Cards stacks by exact id/name. Best-effort.
export async function deleteCards(args: { identifiers: string[] }): Promise<unknown> {
  return deleteByResolver(args.identifiers, id => resolveStrict(game.cards, id));
}
