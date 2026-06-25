// Page-side: world-level Item reads + writes. Runs inside the Foundry page.
//
// Reads are pure against game.items / game.folders. Writes (create/update/
// delete) perform awaited Foundry document mutations and are best-effort (no
// rollback). No permission/transaction/audit scaffolding — the bridge is always
// GM. Return shapes match the old data-access.ts oracle (reads listWorldItems
// @3573-3637 / getWorldItem @3840-3899; writes updateWorldItems @3638-3733 /
// createWorldItems @3733-3900 / deleteWorldItems @3900-4018) exactly so the
// consuming Node tools (src/tools/actor.ts) and their tests stay green.

import { toSource, sanitizeDocData as sanitizeData } from './_shared.js';

// Foundry document classes (Item, Folder) live in the page global scope but are
// not declared in foundry-globals.d.ts; reach them off globalThis (loosely typed).
const ItemClass: any = (globalThis as any).Item;
const FolderClass: any = (globalThis as any).Folder;

interface ListWorldItemsArgs {
  type?: string;
  folder?: string;
  nameFilter?: string;
}

interface WorldItemSummary {
  id: string;
  name: string;
  type: string;
  img?: string;
  folderId: string | null;
  folderName: string | null;
}

/**
 * List world-level items, optionally filtered by type, folder (name or id),
 * and a case-insensitive substring name filter. A folder filter that resolves
 * to no matching Item folder yields an empty list.
 */
export function listWorldItems(args?: ListWorldItemsArgs): unknown {
  const { type, folder, nameFilter } = args ?? {};
  const nameLower = nameFilter ? nameFilter.toLowerCase() : null;

  // Resolve the folder filter to an id if a name or id was provided.
  let folderId: string | null = null;
  if (folder && folder.trim().length > 0) {
    const folderTrimmed = folder.trim();
    const folderDoc =
      game.folders?.find(
        (f: any) => f.type === 'Item' && (f.name === folderTrimmed || f.id === folderTrimmed)
      ) ?? null;
    if (!folderDoc) {
      return [];
    }
    folderId = folderDoc.id;
  }

  const result: WorldItemSummary[] = [];

  for (const item of game.items) {
    if (type && item.type !== type) continue;
    if (folderId && item.folder?.id !== folderId) continue;
    if (nameLower && !(item.name ?? '').toLowerCase().includes(nameLower)) continue;

    result.push({
      id: item.id ?? '',
      name: item.name ?? '',
      type: item.type,
      ...(item.img ? { img: item.img } : {}),
      folderId: item.folder?.id ?? null,
      folderName: item.folder?.name ?? null,
    });
  }

  return result;
}

interface GetWorldItemArgs {
  identifier: string;
}

/**
 * Fetch a single world-level item by exact id, then exact name, then a
 * case-insensitive exact-name fallback. Throws when the identifier is empty
 * or no item matches. Returns the full detail shape (system/effects/flags
 * sanitized of cyclic/sensitive/bloat fields).
 */
export function getWorldItem(args?: GetWorldItemArgs): unknown {
  const identifier = (args?.identifier ?? '').trim();
  if (identifier.length === 0) {
    throw new Error('identifier is required and must be a non-empty string');
  }

  const items = game.items;
  let item = items?.get(identifier) || items?.getName(identifier) || null;
  if (!item) {
    const idLower = identifier.toLowerCase();
    item = items?.find((i: any) => (i.name ?? '').toLowerCase() === idLower) ?? null;
  }
  if (!item) {
    throw new Error(`World Item "${identifier}" not found`);
  }

  const system = item.system ?? {};
  const description =
    (typeof system.description?.value === 'string' ? system.description.value : null) ??
    (typeof system.description === 'string' ? system.description : '') ??
    '';

  return {
    id: item.id ?? '',
    name: item.name ?? '',
    type: item.type,
    ...(item.img ? { img: item.img } : {}),
    folderId: item.folder?.id ?? null,
    folderName: item.folder?.name ?? null,
    description,
    // toObject() source so dnd5e activity Maps survive serialization (see toSource);
    // `description` above still reads the live system, which is fine.
    system: sanitizeData(toSource(item).system ?? {}),
    effects: (item.effects?.contents ?? item.effects ?? []).map((e: any) =>
      sanitizeData(e?.toObject ? e.toObject() : e)
    ),
    flags: item.flags ?? {},
  };
}

interface UpdateWorldItemsArgs {
  updates: Array<{
    id: string;
    name?: string;
    img?: string;
    system?: Record<string, any>;
    folder?: string;
  }>;
}

/**
 * Update one or more world-level Item documents by id. Each patch may change
 * name, img, system data, and/or folder (resolved by name or id, created when
 * absent, scoped to Item folders). Throws when the updates array is empty, an
 * entry lacks a non-empty id, or an id does not resolve to a world Item.
 */
export async function updateWorldItems(args: UpdateWorldItemsArgs): Promise<unknown> {
  const { updates } = args ?? ({} as UpdateWorldItemsArgs);

  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('updates array is required and must contain at least one entry');
  }

  // Cache folder resolutions so we only look up / create each folder once.
  const folderCache = new Map<string, string>(); // folder param → folder id

  const resolveFolderId = async (folder: string): Promise<string> => {
    if (folderCache.has(folder)) return folderCache.get(folder)!;
    const folderTrimmed = folder.trim();
    let folderDoc =
      game.folders?.find(
        (f: any) => f.type === 'Item' && (f.name === folderTrimmed || f.id === folderTrimmed)
      ) ?? null;
    if (!folderDoc) {
      folderDoc = await FolderClass.create({
        name: folderTrimmed,
        type: 'Item',
        parent: null,
      });
    }
    folderCache.set(folder, folderDoc.id);
    return folderDoc.id;
  };

  const payload: Array<Record<string, any>> = [];

  for (let idx = 0; idx < updates.length; idx++) {
    const upd = updates[idx];
    if (!upd || typeof upd.id !== 'string' || upd.id.trim().length === 0) {
      throw new Error(`updates[${idx}]: "id" is required and must be a non-empty string`);
    }

    const item = game.items?.get(upd.id);
    if (!item) {
      throw new Error(`updates[${idx}]: Item "${upd.id}" not found in world`);
    }

    const patch: Record<string, any> = { _id: upd.id };
    if (upd.name !== undefined) patch.name = upd.name;
    if (upd.img !== undefined) patch.img = upd.img;
    if (upd.system !== undefined) patch.system = upd.system;
    if (upd.folder !== undefined && upd.folder.trim().length > 0) {
      patch.folder = await resolveFolderId(upd.folder.trim());
    }

    payload.push(patch);
  }

  const updated = await ItemClass.updateDocuments(payload);

  return {
    updated: (updated || []).map((doc: any) => ({
      id: doc.id,
      name: doc.name,
      type: doc.type,
    })),
  };
}

interface CreateWorldItemsArgs {
  items: Array<{
    name: string;
    type: string;
    img?: string;
    system?: Record<string, any>;
    effects?: any[];
    flags?: Record<string, any>;
  }>;
  folder?: string;
}

/**
 * Create one or more world-level Item documents (Items sidebar, not embedded on
 * an actor). Validates each item's name/type against the system's known Item
 * types, optionally places them in a named/id-resolved Item folder (created when
 * absent), and returns { folderId, folderName, created }.
 */
export async function createWorldItems(args: CreateWorldItemsArgs): Promise<unknown> {
  const { items, folder } = args ?? ({} as CreateWorldItemsArgs);

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items array is required and must contain at least one entry');
  }

  const itemDocTypes = game.system?.documentTypes?.Item;
  const validTypes: string[] | null =
    itemDocTypes && typeof itemDocTypes === 'object' ? Object.keys(itemDocTypes) : null;

  const payload = items.map((it, idx) => {
    if (!it || typeof it.name !== 'string' || it.name.trim().length === 0) {
      throw new Error(`items[${idx}]: "name" is required and must be a non-empty string`);
    }
    if (typeof it.type !== 'string' || it.type.trim().length === 0) {
      throw new Error(`items[${idx}] ("${it.name}"): "type" is required`);
    }
    if (validTypes && !validTypes.includes(it.type)) {
      throw new Error(
        `items[${idx}] ("${it.name}"): unknown type "${it.type}" for system "${game.system?.id}". ` +
          `Valid Item types: ${validTypes.join(', ')}`
      );
    }

    const doc: Record<string, any> = { name: it.name, type: it.type };
    if (it.img) doc.img = it.img;
    if (it.system && typeof it.system === 'object') doc.system = it.system;
    if (Array.isArray((it as any).effects)) doc.effects = (it as any).effects;
    if ((it as any).flags && typeof (it as any).flags === 'object') doc.flags = (it as any).flags;
    return doc;
  });

  // Resolve or create the target folder.
  let folderDoc: any = null;
  if (folder && folder.trim().length > 0) {
    const folderTrimmed = folder.trim();
    folderDoc =
      game.folders?.find(
        (f: any) => f.type === 'Item' && (f.name === folderTrimmed || f.id === folderTrimmed)
      ) ?? null;

    if (!folderDoc) {
      folderDoc = await FolderClass.create({
        name: folderTrimmed,
        type: 'Item',
        parent: null,
      });
    }

    for (const doc of payload) {
      doc.folder = folderDoc.id;
    }
  }

  const created = await ItemClass.createDocuments(payload);

  return {
    folderId: folderDoc ? folderDoc.id : null,
    folderName: folderDoc ? folderDoc.name : null,
    created: (created || []).map((doc: any) => ({
      id: doc.id,
      name: doc.name,
      type: doc.type,
    })),
  };
}

interface DeleteWorldItemsArgs {
  identifiers: string[];
}

/**
 * Permanently delete one or more world-level Item documents by exact id or
 * exact name. SAFETY: resolution is STRICT — exact id (game.items.get) or exact
 * name (game.items.getName) only, no substring/fuzzy matching, so a destructive
 * call can never hit the wrong item. Returns { success, deletedCount, deleted,
 * notFound? }.
 */
export async function deleteWorldItems(args: DeleteWorldItemsArgs): Promise<unknown> {
  const identifiers = args?.identifiers;

  if (!Array.isArray(identifiers) || identifiers.length === 0) {
    throw new Error('identifiers array is required and must contain at least one entry');
  }

  const deleted: Array<{ id: string; name: string; type: string }> = [];
  const notFound: string[] = [];

  for (const identifier of identifiers) {
    // STRICT resolution only — exact id, then exact name.
    const item = game.items?.get(identifier) || game.items?.getName(identifier);
    if (item) {
      const info = { id: item.id ?? identifier, name: item.name ?? '', type: item.type };
      await item.delete();
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

// The document sanitizer (sanitizeData) is the shared sanitizeDocData from ./_shared.js
// (imported above) — one credential-stripping / cycle-dropping chokepoint for the page layer.
