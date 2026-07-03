// Page-side shared CRUD kernel for scene PLACEABLES (embedded documents). Runs inside the Foundry page.
//
// Removes the copy-pasted skeleton every per-type write path repeats (createSceneNotes /
// createSceneRegions / deleteSceneNotes / deleteSceneRegions / updateSceneRegion all re-implement it):
// resolve the scene strict → short-circuit {notFound} → per-item build/validate with error isolation →
// ONE batched {create,update,delete}EmbeddedDocuments call → a uniform result shape. A per-type
// DESCRIPTOR injects only the type-specific bits (which embedded collection, how to build a create-doc,
// how to build an update patch, how to serialize a doc for read-back). Descriptors are OPT-IN: a type
// that doesn't fit an op simply omits that hook — e.g. Token/Note provide only `dump` (list is the sole
// kernel op they use; their mutation stays in the bespoke update-token / *-note tools). The kernel never
// grows a type-specific branch.
//
// All type-specific correctness (field paths, nested TextureData/config dot-paths, asset-404 policy,
// name→id resolution, the coordinate anchor) lives in the descriptor, NOT here — same "tools own
// correctness" rule as the rest of src/page.

import { resolveSceneStrict } from './scenes.js';

/** One create-doc result: the built document, OR a per-item error (isolated), plus any warnings. */
export interface CreateDocResult {
  doc?: Record<string, unknown>;
  error?: string;
  warnings?: string[];
}

/** One update-patch result: the dot-path patch to apply, whether anything changed, plus any warnings. */
export interface PatchResult {
  patch?: Record<string, unknown>;
  warnings?: string[];
  changed: boolean;
}

/**
 * The type-specific half of placeable CRUD. `docName` is the embedded document name Foundry batches on
 * (`scene.createEmbeddedDocuments(docName, …)`). `collection(scene)` returns the scene's embedded
 * collection (e.g. `s => s.tiles`). `dump` serializes ONE live doc to a compact read-back (ids + salient
 * fields only — never a whole document, so a 645-wall list stays under the MCP response cap). `toCreateDoc`
 * / `buildPatch` are omitted by list-only types.
 */
export interface PlaceableDescriptor {
  docName: string;
  collection: (scene: any) => any;
  dump: (doc: any) => Record<string, unknown>;
  toCreateDoc?: (input: any) => Promise<CreateDocResult> | CreateDocResult;
  buildPatch?: (existing: any, patch: any) => Promise<PatchResult> | PatchResult;
}

/** Iterate an embedded collection as an array whether it exposes `.contents` or is already iterable. */
function toArray(coll: any): any[] {
  if (!coll) return [];
  if (Array.isArray(coll.contents)) return coll.contents;
  if (typeof coll.map === 'function' && typeof coll.filter === 'function') return [...coll];
  return [];
}

export interface CrudCreateResult {
  success: true;
  sceneId?: string;
  sceneName?: string;
  notFound?: string;
  created: number;
  items?: Array<Record<string, unknown>>;
  errors?: string[];
  warnings?: string[];
}

/**
 * Create N placeables of one type on a scene. Per-item error isolation: a bad item is recorded and
 * skipped (never voids the good ones), then the good docs are created in ONE batched call. Mirrors
 * importScenePlaceables / createSceneNotes exactly.
 */
export async function crudCreate(
  desc: PlaceableDescriptor,
  args: { sceneIdentifier: string; items: any[] }
): Promise<CrudCreateResult> {
  if (!desc.toCreateDoc) throw new Error(`${desc.docName}: create is not supported`);
  if (!args?.sceneIdentifier) throw new Error('sceneIdentifier is required');
  if (!Array.isArray(args.items) || args.items.length === 0) {
    throw new Error('items array is required and must contain at least one entry');
  }
  const scene = resolveSceneStrict(args.sceneIdentifier);
  if (!scene) return { success: true, created: 0, notFound: args.sceneIdentifier };

  const data: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < args.items.length; i++) {
    try {
      const r = await desc.toCreateDoc(args.items[i]);
      if (r.warnings?.length) warnings.push(...r.warnings);
      if (r.error) errors.push(`${desc.docName} ${i}: ${r.error}`);
      else if (r.doc) data.push(r.doc);
    } catch (e) {
      errors.push(`${desc.docName} ${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let created = 0;
  let made: any[] = [];
  if (data.length > 0) {
    try {
      made = (await scene.createEmbeddedDocuments(desc.docName, data)) ?? [];
      created = made.length;
    } catch (e) {
      errors.push(`${desc.docName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    success: true,
    sceneId: scene.id,
    sceneName: scene.name,
    created,
    ...(made.length > 0 ? { items: made.map(d => desc.dump(d)) } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export interface CrudListResult {
  found: boolean;
  notFound?: string;
  sceneId?: string;
  sceneName?: string;
  count?: number;
  items?: Array<Record<string, unknown>>;
}

/** List every placeable of one type on a scene (id + salient fields via `dump`). Read-only. */
export function crudList(
  desc: PlaceableDescriptor,
  args: { sceneIdentifier: string }
): CrudListResult {
  if (!args?.sceneIdentifier) throw new Error('sceneIdentifier is required');
  const scene = resolveSceneStrict(args.sceneIdentifier);
  if (!scene) return { found: false, notFound: args.sceneIdentifier };
  const items = toArray(desc.collection(scene)).map(d => desc.dump(d));
  return { found: true, sceneId: scene.id, sceneName: scene.name, count: items.length, items };
}

export interface CrudUpdateResult {
  success: true;
  sceneId?: string;
  sceneName?: string;
  notFound?: string;
  matched: number;
  updated: number;
  items?: Array<Record<string, unknown>>;
  notFoundIds?: string[];
  warnings?: string[];
}

/**
 * Update N placeables of one type by id. Each patch is validated/built FIRST (drop-and-report the
 * unresolved ids + collect warnings), then the changed patches go out in ONE batched call —
 * updateEmbeddedDocuments is all-or-nothing per call, so validation happens before the batch.
 */
export async function crudUpdate<P extends { id: string }>(
  desc: PlaceableDescriptor,
  args: { sceneIdentifier: string; patches: P[] }
): Promise<CrudUpdateResult> {
  if (!desc.buildPatch) throw new Error(`${desc.docName}: update is not supported`);
  if (!args?.sceneIdentifier) throw new Error('sceneIdentifier is required');
  if (!Array.isArray(args.patches) || args.patches.length === 0) {
    throw new Error('patches array is required and must contain at least one entry');
  }
  const scene = resolveSceneStrict(args.sceneIdentifier);
  if (!scene) return { success: true, matched: 0, updated: 0, notFound: args.sceneIdentifier };
  const coll = desc.collection(scene);

  const updates: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const notFoundIds: string[] = [];
  let matched = 0;
  for (const p of args.patches) {
    const doc = coll?.get?.(p.id);
    if (!doc) {
      notFoundIds.push(p.id);
      continue;
    }
    matched++;
    const { patch, warnings: w, changed } = await desc.buildPatch(doc, p);
    if (w?.length) warnings.push(...w);
    if (changed && patch) updates.push({ _id: doc.id, ...patch });
  }

  if (updates.length > 0) await scene.updateEmbeddedDocuments(desc.docName, updates);

  return {
    success: true,
    sceneId: scene.id,
    sceneName: scene.name,
    matched,
    updated: updates.length,
    ...(matched > 0
      ? {
          items: args.patches
            .map(p => coll?.get?.(p.id))
            .filter(Boolean)
            .map((d: any) => desc.dump(d)),
        }
      : {}),
    ...(notFoundIds.length > 0 ? { notFoundIds } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export interface CrudDeleteResult {
  success: true;
  sceneId?: string;
  sceneName?: string;
  notFound?: string;
  deleted: number;
  notFoundIds?: string[];
}

/** Delete N placeables of one type by id. Partitions present vs notFoundIds, one batched call. */
export async function crudDelete(
  desc: PlaceableDescriptor,
  args: { sceneIdentifier: string; ids: string[] }
): Promise<CrudDeleteResult> {
  if (!args?.sceneIdentifier) throw new Error('sceneIdentifier is required');
  if (!Array.isArray(args.ids) || args.ids.length === 0) {
    throw new Error('ids array is required and must contain at least one entry');
  }
  const scene = resolveSceneStrict(args.sceneIdentifier);
  if (!scene) return { success: true, deleted: 0, notFound: args.sceneIdentifier };
  const coll = desc.collection(scene);

  const present = args.ids.filter(id => coll?.get?.(id));
  const notFoundIds = args.ids.filter(id => !coll?.get?.(id));
  let deleted = 0;
  if (present.length > 0) {
    const made = await scene.deleteEmbeddedDocuments(desc.docName, present);
    deleted = made?.length ?? present.length;
  }
  return {
    success: true,
    sceneId: scene.id,
    sceneName: scene.name,
    deleted,
    ...(notFoundIds.length > 0 ? { notFoundIds } : {}),
  };
}
