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
 */
async function deleteByResolver(
  op: string,
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

  try {
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
  } catch (error) {
    throw new Error(`Failed to ${op}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ---------------------------------------------------------------------------
// Exported page functions
// ---------------------------------------------------------------------------

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
 */
export async function bulkDelete(data: {
  documentType: string;
  identifiers: string[];
}): Promise<unknown> {
  if (!WORLD_DOC_TYPES.includes(data.documentType)) {
    throw new Error(
      `Unknown documentType "${data.documentType}". Valid: ${WORLD_DOC_TYPES.join(', ')}`
    );
  }
  return deleteByResolver(`bulkDelete:${data.documentType}`, data.identifiers, id =>
    resolveDocStrict(data.documentType, id)
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
