// Page-side: organization & batch writes (folders, moves, bulk delete).
// Runs INSIDE the headless Foundry page.
//
// Awaited Foundry document mutations. No Node, no Playwright, no module
// scaffolding (settings/permissions/transactions/sockets) — the bridge is
// always GM, writes are best-effort (no rollback). Shapes match the old
// data-access.ts oracle (6f9612e:packages/foundry-module/src/data-access.ts:
// deleteFolder ~4877, createFolder ~4997, moveDocuments ~5068, bulkDelete
// ~5158) and the contracts the Node tools in src/tools/organization.ts +
// src/tools/actor-creation.ts and their tests expect.

import { getOrCreateFolder as getOrCreateFolderShared, MCP_FLAG_SCOPE } from './_shared.js';

// Legacy bridge id — kept ONLY as a console log prefix. The folder flag namespace
// is MCP_FLAG_SCOPE ('world'), valid with no module installed, so deleteActor's
// auto-cleanup still recognises bridge-created folders.
const MODULE_ID = 'foundry-mcp-bridge';

// Foundry's Folder document class isn't declared in foundry-globals.d.ts, so grab
// it off globalThis (the established sibling-page-file pattern).
const FolderClass = (globalThis as any).Folder;

// World document types that have a top-level collection + folders.
const WORLD_DOC_TYPES = [
  'Actor',
  'Item',
  'JournalEntry',
  'Scene',
  'RollTable',
  'Cards',
  'Playlist',
  'Macro',
];

// ---------------------------------------------------------------------------
// Local helpers (kept in-file; consistency with sibling page files over DRY).
// ---------------------------------------------------------------------------

/** Map a document type to its world collection (game.actors, game.items, …). */
function getWorldCollection(type: string): any {
  const map: Record<string, any> = {
    Actor: game.actors,
    Item: game.items,
    JournalEntry: game.journal,
    Scene: game.scenes,
    RollTable: game.tables,
    Cards: game.cards,
    Playlist: game.playlists,
    Macro: game.macros,
  };
  return map[type] ?? null;
}

/** STRICT resolve a world document: exact id, then exact name. */
function resolveDocStrict(type: string, identifier: string): any {
  const coll = getWorldCollection(type);
  if (!coll) return null;
  return (
    coll.get?.(identifier) ||
    coll.getName?.(identifier) ||
    coll.find?.((d: any) => d.name === identifier) ||
    null
  );
}

/** Count documents + subfolders directly inside a folder (direct children only). */
function folderChildCounts(folder: any): { documents: number; subfolders: number } {
  const documents = folder?.contents?.length || 0;
  const subfolders = (game.folders?.filter((f: any) => f.folder?.id === folder.id) || []).length;
  return { documents, subfolders };
}

/**
 * Resolve an existing folder by exact name + type, or create one at root.
 * Returns the folder id, or null if creation failed (caller falls back to
 * leaving documents folderless rather than failing). Thin wrapper over the
 * shared helper that preserves this file's `[foundry-mcp-bridge]`-prefixed
 * console.warn on failure.
 */
async function getOrCreateFolder(folderName: string, type: string): Promise<string | null> {
  return getOrCreateFolderShared(folderName, type, `[${MODULE_ID}] `);
}

/**
 * Delete many world documents by exact id or exact name using a resolver.
 * STRICT resolution — no fuzzy matching. Best-effort (no rollback).
 * With `dryRun`, resolves the targets and reports what WOULD be deleted — nothing is removed.
 */
async function deleteByResolver(
  _op: string,
  identifiers: string[],
  resolver: (id: string) => any,
  opts?: { dryRun?: boolean }
): Promise<{
  success: boolean;
  deletedCount: number;
  deleted: Array<{ id: string; name: string }>;
  dryRun?: boolean;
  wouldDelete?: Array<{ id: string; name: string }>;
  notFound?: string[];
  failed?: Array<{ id: string; name: string; error: string }>;
}> {
  if (!Array.isArray(identifiers) || identifiers.length === 0) {
    throw new Error('identifiers array is required and must contain at least one entry');
  }

  // Dry-run: resolve and report the set that WOULD be destroyed, deleting nothing. Lets a caller
  // confirm exactly which documents a bulk delete will permanently remove before committing.
  if (opts?.dryRun) {
    const wouldDelete: Array<{ id: string; name: string }> = [];
    const notFoundDry: string[] = [];
    for (const identifier of identifiers) {
      const doc = resolver(identifier);
      if (!doc) {
        notFoundDry.push(identifier);
        continue;
      }
      wouldDelete.push({ id: doc.id ?? identifier, name: doc.name ?? '' });
    }
    return {
      success: true,
      dryRun: true,
      deletedCount: 0,
      deleted: [],
      wouldDelete,
      ...(notFoundDry.length > 0 ? { notFound: notFoundDry } : {}),
    };
  }

  const deleted: Array<{ id: string; name: string }> = [];
  const notFound: string[] = [];
  const failed: Array<{ id: string; name: string; error: string }> = [];

  for (const identifier of identifiers) {
    const doc = resolver(identifier);
    if (!doc) {
      notFound.push(identifier);
      continue;
    }
    const info = { id: doc.id ?? identifier, name: doc.name ?? '' };
    try {
      await doc.delete();
      deleted.push(info);
    } catch (error) {
      // Deletes are permanent and best-effort: one failure must NOT discard the documents already
      // removed (the pre-fix behavior unwound to a single catch and lost all partial progress).
      // Record it and continue so the caller can report exactly what was and wasn't deleted.
      failed.push({ ...info, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  return {
    success: failed.length === 0,
    deletedCount: deleted.length,
    deleted,
    ...(notFound.length > 0 ? { notFound } : {}),
    ...(failed.length > 0 ? { failed } : {}),
  };
}

// ---------------------------------------------------------------------------
// Exported page functions
// ---------------------------------------------------------------------------

/**
 * Read the sidebar folder TREE — the missing inspect step for the folder write tools (you can't
 * reparent/recolor/move-into what you can't see). Returns every world folder (optionally one
 * document type), DFS tree-ordered with depth + a human "/"-joined path, plus each folder's color,
 * parent, direct document count, and subfolder count. Read-only; ids feed update-folder /
 * delete-folder / move-documents / the folder params on the create tools.
 */
export function listFolders(args?: { type?: string }): unknown {
  const type = args?.type;
  if (type !== undefined && !WORLD_DOC_TYPES.includes(type)) {
    throw new Error(`Unknown folder type "${type}". Valid: ${WORLD_DOC_TYPES.join(', ')}`);
  }
  const all: any[] = (game.folders?.contents ?? []).filter(
    (f: any) => type === undefined || f.type === type
  );

  // Folder.color is a Color object in v12+ (a string in older data) — surface a plain hex or null.
  const colorOf = (f: any): string | null => {
    const c = f?.color;
    if (!c) return null;
    if (typeof c === 'string') return c;
    return typeof c.css === 'string' ? c.css : null;
  };

  // DFS per type: roots first, siblings alphabetical (deterministic regardless of the world's
  // manual-sort values), children directly under their parent so depth renders as a tree.
  const byName = (a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
  const out: Array<Record<string, unknown>> = [];
  const types = [...new Set(all.map((f: any) => String(f.type)))].sort();
  for (const t of types) {
    const ofType = all.filter((f: any) => f.type === t);
    const childrenOf = (parentId: string | null) =>
      ofType.filter((f: any) => (f.folder?.id ?? null) === parentId).sort(byName);
    const walk = (parentId: string | null, depth: number, prefix: string) => {
      for (const f of childrenOf(parentId)) {
        const path = prefix ? `${prefix}/${f.name}` : String(f.name ?? '');
        const { documents, subfolders } = folderChildCounts(f);
        out.push({
          id: f.id,
          name: f.name,
          type: f.type,
          depth,
          path,
          color: colorOf(f),
          parentId: f.folder?.id ?? null,
          parentName: f.folder?.name ?? null,
          documentCount: documents,
          subfolderCount: subfolders,
        });
        walk(f.id, depth + 1, path);
      }
    };
    walk(null, 0, '');
    // Defensive sweep: a folder whose parent reference dangles (corrupt/mid-delete data) would be
    // unreachable from the root walk — surface it flat rather than silently dropping it.
    const seen = new Set(out.map(f => f.id));
    for (const f of ofType.filter((x: any) => !seen.has(x.id)).sort(byName)) {
      const { documents, subfolders } = folderChildCounts(f);
      out.push({
        id: f.id,
        name: f.name,
        type: f.type,
        depth: 0,
        path: String(f.name ?? ''),
        color: colorOf(f),
        parentId: f.folder?.id ?? null,
        parentName: f.folder?.name ?? null,
        documentCount: documents,
        subfolderCount: subfolders,
        orphaned: true,
      });
    }
  }

  return { success: true, total: out.length, types, folders: out };
}

/**
 * Create a Folder for any world document type, optionally nested under a
 * parent folder of the same type. Flagged mcpGenerated so the auto-cleanup
 * paths (e.g. deleteActor) recognise it.
 */
export async function createFolder(data: {
  name: string;
  type: string;
  parentFolder?: string;
  color?: string;
}): Promise<unknown> {
  if (!data?.name || data.name.trim().length === 0) {
    throw new Error('name is required and must be a non-empty string');
  }
  if (!WORLD_DOC_TYPES.includes(data.type)) {
    throw new Error(`Unknown folder type "${data.type}". Valid: ${WORLD_DOC_TYPES.join(', ')}`);
  }

  // Resolve optional parent (must be a folder of the same type).
  let parentId: string | null = null;
  if (data.parentFolder && data.parentFolder.trim().length > 0) {
    const p = data.parentFolder.trim();
    const parent =
      game.folders?.get(p) || game.folders?.find((f: any) => f.name === p && f.type === data.type);
    if (!parent) {
      throw new Error(`Parent folder "${data.parentFolder}" (type ${data.type}) not found`);
    }
    parentId = parent.id;
  }

  try {
    const folder = await FolderClass.create({
      name: data.name.trim(),
      type: data.type,
      ...(data.color ? { color: data.color } : {}),
      folder: parentId,
      flags: {
        [MCP_FLAG_SCOPE]: { mcpGenerated: true, createdAt: new Date().toISOString() },
      },
    } as any);

    return {
      success: true,
      folderId: folder?.id,
      folderName: folder?.name,
      type: data.type,
      parentId,
    };
  } catch (error) {
    throw new Error(
      `Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Update a Folder's document fields: rename, recolor, and/or reparent (nest under
 * another folder of the SAME type, or move to root with an empty parentFolder).
 * STRICT resolution (exact id, or exact name within the given type). Returns
 * `updated:false` + `notFound` when the folder does not resolve — Foundry has no
 * folder-rename tool otherwise, so this closes the "rename via move+delete" dance.
 */
export async function updateFolder(data: {
  identifier: string;
  type?: string;
  name?: string;
  color?: string;
  parentFolder?: string;
}): Promise<unknown> {
  const type = data.type || 'Actor';
  const folder =
    game.folders?.get(data.identifier) ||
    game.folders?.find((f: any) => f.name === data.identifier && f.type === type);
  if (!folder) {
    return { success: true, updated: false, notFound: data.identifier };
  }

  const update: Record<string, unknown> = {};
  if (typeof data.name === 'string' && data.name.trim().length > 0) update.name = data.name.trim();
  if (typeof data.color === 'string') update.color = data.color;
  if (typeof data.parentFolder === 'string') {
    const p = data.parentFolder.trim();
    if (p === '') {
      update.folder = null; // move to root
    } else {
      const parent =
        game.folders?.get(p) ||
        game.folders?.find((f: any) => f.name === p && f.type === folder.type);
      if (!parent) {
        throw new Error(`Parent folder "${data.parentFolder}" (type ${folder.type}) not found`);
      }
      if (parent.id === folder.id) {
        throw new Error('A folder cannot be its own parent');
      }
      update.folder = parent.id;
    }
  }

  if (Object.keys(update).length === 0) {
    throw new Error('Provide at least one of: name, color, parentFolder');
  }

  try {
    await folder.update(update);
    return {
      success: true,
      updated: true,
      folder: { id: folder.id ?? data.identifier, name: folder.name ?? '', type: folder.type },
    };
  } catch (error) {
    throw new Error(
      `Failed to update folder: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Move one or more world documents of a single type into a target folder
 * (resolved by id or name; created at root if it doesn't exist). Pass an
 * empty/omitted targetFolder to move documents to the root (no folder).
 */
export async function moveDocuments(data: {
  documentType: string;
  identifiers: string[];
  targetFolder?: string;
}): Promise<unknown> {
  if (!WORLD_DOC_TYPES.includes(data.documentType)) {
    throw new Error(
      `Unknown documentType "${data.documentType}". Valid: ${WORLD_DOC_TYPES.join(', ')}`
    );
  }
  if (!Array.isArray(data?.identifiers) || data.identifiers.length === 0) {
    throw new Error('identifiers array is required and must contain at least one entry');
  }

  // Resolve / create the target folder (null = move to root).
  let folderId: string | null = null;
  let folderName: string | null = null;
  if (data.targetFolder && data.targetFolder.trim().length > 0) {
    const t = data.targetFolder.trim();
    let folder =
      game.folders?.get(t) ||
      game.folders?.find((f: any) => f.name === t && f.type === data.documentType);
    if (!folder) {
      const newId = await getOrCreateFolder(t, data.documentType);
      folder = newId ? game.folders?.get(newId) : null;
    }
    if (!folder) {
      throw new Error(`Could not resolve or create target folder "${data.targetFolder}"`);
    }
    folderId = folder.id;
    folderName = folder.name;
  }

  try {
    const moved: Array<{ id: string; name: string }> = [];
    const notFound: string[] = [];

    for (const identifier of data.identifiers) {
      const doc = resolveDocStrict(data.documentType, identifier);
      if (doc) {
        await doc.update({ folder: folderId });
        moved.push({ id: doc.id ?? identifier, name: doc.name ?? '' });
      } else {
        notFound.push(identifier);
      }
    }

    return {
      success: true,
      documentType: data.documentType,
      targetFolderId: folderId,
      targetFolderName: folderName,
      movedCount: moved.length,
      moved,
      ...(notFound.length > 0 ? { notFound } : {}),
    };
  } catch (error) {
    throw new Error(
      `Failed to move documents: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Permanently delete many world documents of a single type by exact id or
 * exact name. STRICT resolution — no fuzzy matching.
 * With `dryRun`, returns the set that WOULD be deleted without removing anything.
 */
export async function bulkDelete(data: {
  documentType: string;
  identifiers: string[];
  dryRun?: boolean;
}): Promise<unknown> {
  if (!WORLD_DOC_TYPES.includes(data.documentType)) {
    throw new Error(
      `Unknown documentType "${data.documentType}". Valid: ${WORLD_DOC_TYPES.join(', ')}`
    );
  }
  return deleteByResolver(
    `bulkDelete:${data.documentType}`,
    data.identifiers,
    id => resolveDocStrict(data.documentType, id),
    { dryRun: !!data.dryRun }
  );
}

/**
 * Permanently delete a Folder by exact id or exact name (within a document type).
 *
 * SAFETY: refuses a non-empty folder unless deleteContents is explicitly true,
 * so it cannot silently destroy actors/items nested inside. Resolution is strict
 * (exact id, or exact name+type) — no fuzzy matching.
 */
export async function deleteFolder(data: {
  identifier: string;
  type?: string;
  deleteContents?: boolean;
}): Promise<unknown> {
  const type = data.type || 'Actor';

  try {
    // STRICT resolution: exact id, or exact name within the given folder type.
    const folder =
      game.folders?.get(data.identifier) ||
      game.folders?.find((f: any) => f.name === data.identifier && f.type === type);

    if (!folder) {
      return { success: true, deleted: false, notFound: data.identifier };
    }

    const { documents, subfolders } = folderChildCounts(folder);
    const isEmpty = documents === 0 && subfolders === 0;

    if (!isEmpty && !data.deleteContents) {
      throw new Error(
        `Folder "${folder.name}" is not empty (${documents} document(s), ${subfolders} subfolder(s)). ` +
          `Pass deleteContents:true to delete the folder and everything inside it.`
      );
    }

    const folderInfo = {
      id: folder.id ?? data.identifier,
      name: folder.name ?? '',
      type: folder.type,
    };

    if (isEmpty) {
      await folder.delete();
    } else {
      await folder.delete({ deleteSubfolders: true, deleteContents: true } as any);
    }

    return {
      success: true,
      deleted: true,
      folder: folderInfo,
      deletedContents: !isEmpty,
      removedDocuments: !isEmpty ? documents : 0,
      removedSubfolders: !isEmpty ? subfolders : 0,
    };
  } catch (error) {
    throw new Error(
      `Failed to delete folder: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
