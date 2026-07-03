// Page-side Region domain: the kernel descriptor (create/list/update/delete), the teleport-behavior
// helpers, and the two NAMED SPECIAL OPS that live outside generic CRUD (createSceneTeleporter,
// remapSceneTeleporters) because they cross-reference minted region ids across scenes.
//
// CORRECTNESS TRAPS this owns:
//  - `behaviors[]` are embedded sub-docs; a teleport destination is a UUID cross-referencing another
//    MINTED region id. buildPatch NEVER emits a `behaviors` key — a generic "replace behaviors whole"
//    on update would orphan the cross-link. Teleporter creation/repair stay the named special ops.
//  - v14.364 stores teleport destinations in `system.destinations`, a SetField — the LIVE value is a
//    Set (an array only via toObject()), and pre-migration data used a singular `system.destination`.
//    `teleportDestinationsOf` is the ONE normalizer every read goes through.
//  - Deleting a region can orphan the OTHER end of a teleporter (its destination now points at a dead
//    id) — deleteSceneRegions scans the world afterwards and WARNS on each surviving reference.
//  - The `rect` update convenience reshapes to a grid-snapped rectangle from a CENTER point + cell
//    size (gridRectShape) — the by-hand move/resize loop the live session did.

import {
  crudCreate,
  crudDelete,
  crudList,
  crudUpdate,
  type CreateDocResult,
  type PatchResult,
  type PlaceableCtx,
  type PlaceableDescriptor,
} from '../_placeables.js';
import { gridRectShape, resolveSceneStrict, sceneGrid, TOM_CARTOS_FLAG_SCOPE } from '../scenes.js';

// --- teleport-behavior helpers (pure) -----------------------------------------

/** A teleporter destination UUID: Scene.<sceneId>.Region.<regionId> (ids have no dots). */
const TELEPORT_DEST_RE = /^Scene\.([^.]+)\.Region\.([^.]+)$/;

/** A v12+ teleporter destination UUID for a region. Pure/exported for unit testing. */
export function teleportDestUuid(sceneId: string, regionId: string): string {
  return `Scene.${sceneId}.Region.${regionId}`;
}

/**
 * Read a `teleportToken` behavior's destination UUID(s) from its `system`. Foundry v14.364's
 * `teleportToken` uses a `destinations` field holding SEVERAL endpoints (a region can offer a choice
 * when `choice:true`). It is a `SetField`, so the LIVE model value is a **Set** (an array only via
 * `toObject()`); older data used a singular `system.destination` string. This tolerates a Set, an
 * Array, OR the legacy singular, drops empty/non-string entries, and returns [] for a non-teleport
 * behavior. Pure/exported for unit testing — the ONE place that normalizes all three shapes, so every
 * read (dumpRegion, remap) goes through it.
 */
export function teleportDestinationsOf(system: any): string[] {
  const raw = system?.destinations;
  const clean = (arr: unknown[]) =>
    arr.filter((d: unknown): d is string => typeof d === 'string' && d.trim() !== '');
  if (raw instanceof Set) return clean([...raw]);
  if (Array.isArray(raw)) return clean(raw);
  const single = system?.destination;
  return typeof single === 'string' && single.trim() !== '' ? [single] : [];
}

export type RemapStatus = 'rewritten' | 'unchanged' | 'no-match' | 'unresolved';

/**
 * Compute the rewritten teleporter destination for one behavior's destination entry.
 * Pure/exported — the page write-back fn applies the result; this is the unit-tested core.
 *  - `no-match`: not a Scene.X.Region.Y string (a non-teleport behavior or an unset destination).
 *  - `unresolved`: a valid destination whose scene OR region was NOT in this import (e.g. it
 *    points at a variant the user chose not to import) — left as-is and reported, not silently dropped.
 *  - `unchanged`: maps resolve but the destination already equals the rewrite (keepId / re-run).
 *  - `rewritten`: returns the new Scene.<new>.Region.<new> destination to persist.
 */
export function remapTeleportDestination(
  dest: unknown,
  sceneIdMap: Record<string, string>,
  regionIdMap: Record<string, string>
): { status: RemapStatus; dest?: string; reason?: string } {
  if (typeof dest !== 'string' || dest.trim() === '') return { status: 'no-match' };
  const m = dest.match(TELEPORT_DEST_RE);
  if (!m) return { status: 'no-match' };
  const [, oldScene, oldRegion] = m;
  const newScene = sceneIdMap[oldScene];
  const newRegion = regionIdMap[oldRegion];
  if (newScene && newRegion) {
    const newDest = `Scene.${newScene}.Region.${newRegion}`;
    return newDest === dest
      ? { status: 'unchanged', dest }
      : { status: 'rewritten', dest: newDest };
  }
  // Re-run / resume: the destination may already hold the NEW ids (the map VALUES, not keys) from a
  // prior remap. That's done, not broken — report `unchanged`, not `unresolved`. Only a destination
  // whose scene+region is neither an old source id NOR a current in-import id truly points outside it.
  const sceneIsCurrent = Object.values(sceneIdMap).includes(oldScene);
  const regionIsCurrent = Object.values(regionIdMap).includes(oldRegion);
  if (sceneIsCurrent && regionIsCurrent) return { status: 'unchanged', dest };
  return { status: 'unresolved', reason: dest };
}

// --- the descriptor ------------------------------------------------------------

export interface RegionInput {
  name?: string;
  color?: string;
  visibility?: number;
  shapes?: Record<string, unknown>[];
  behaviors?: Record<string, unknown>[];
}

export interface RegionPatch {
  name?: string;
  color?: string;
  visibility?: number;
  shapes?: Record<string, unknown>[];
  rect?: { x: number; y: number; widthCells?: number; heightCells?: number; snapToGrid?: boolean };
}

/** Serialize a region for read-back: id, name, its shapes' bounds, and any teleport destinations. */
export function dumpRegion(region: any): Record<string, unknown> {
  return {
    id: region.id,
    name: region.name,
    shapes: (region.shapes ?? []).map((s: any) => ({
      type: s.type,
      ...(s.x !== undefined ? { x: s.x, y: s.y } : {}),
      ...(s.width !== undefined ? { width: s.width, height: s.height } : {}),
      ...(s.radiusX !== undefined ? { radiusX: s.radiusX, radiusY: s.radiusY } : {}),
    })),
    behaviors: (region.behaviors?.contents ?? region.behaviors ?? []).map((b: any) => {
      const destinations = teleportDestinationsOf(b.system);
      return { type: b.type, ...(destinations.length ? { destinations } : {}) };
    }),
  };
}

function toCreateDoc(input: RegionInput, ctx: PlaceableCtx): CreateDocResult {
  if (!Array.isArray(input?.shapes) || input.shapes.length === 0) {
    return { error: 'at least one shape is required' };
  }
  const doc: Record<string, unknown> = {
    name: input.name ?? `Region ${(ctx.index ?? 0) + 1}`,
    shapes: input.shapes,
  };
  if (typeof input.color === 'string' && input.color.trim() !== '') doc.color = input.color;
  if (typeof input.visibility === 'number') doc.visibility = input.visibility;
  // Behaviors passthrough — a teleportToken here needs system.destinations already an array of
  // "Scene.<id>.Region.<id>" UUIDs; for two NEW cross-linked regions use createSceneTeleporter.
  if (Array.isArray(input.behaviors) && input.behaviors.length > 0) doc.behaviors = input.behaviors;
  return { doc };
}

function buildPatch(
  _existing: any,
  p: RegionPatch & { id: string },
  ctx: PlaceableCtx
): PatchResult {
  const patch: Record<string, unknown> = {};
  if (typeof p.name === 'string' && p.name.trim() !== '') patch.name = p.name.trim();
  if (typeof p.color === 'string' && p.color.trim() !== '') patch.color = p.color;
  if (typeof p.visibility === 'number') patch.visibility = p.visibility;
  if (Array.isArray(p.shapes) && p.shapes.length > 0) patch.shapes = p.shapes;
  else if (p.rect) {
    patch.shapes = [
      gridRectShape(
        sceneGrid(ctx.scene),
        p.rect.x,
        p.rect.y,
        p.rect.widthCells ?? 1,
        p.rect.heightCells ?? 1,
        p.rect.snapToGrid !== false
      ),
    ];
  }
  // NEVER patch.behaviors — replacing behaviors whole would orphan teleporter cross-links.
  return { patch, changed: Object.keys(patch).length > 0 };
}

export const regionDescriptor: PlaceableDescriptor = {
  docName: 'Region',
  collection: (scene: any) => scene.regions,
  dump: dumpRegion,
  toCreateDoc,
  buildPatch,
};

// --- bridge page functions (registered in src/page/index.ts) -------------------

export const createSceneRegions = (args: { sceneIdentifier: string; items: RegionInput[] }) =>
  crudCreate(regionDescriptor, args);
export const listSceneRegions = (args: { sceneIdentifier: string }) =>
  crudList(regionDescriptor, args);
export const updateSceneRegions = (args: {
  sceneIdentifier: string;
  patches: Array<{ id: string } & RegionPatch>;
}) => crudUpdate(regionDescriptor, args);

/**
 * Delete regions, then scan EVERY scene's surviving teleport behaviors for destinations pointing at
 * a just-deleted region id — the orphaned-other-end trap. Orphans are warned, never auto-deleted
 * (the GM may be mid-rebuild).
 */
export async function deleteSceneRegions(args: { sceneIdentifier: string; ids: string[] }) {
  const result = await crudDelete(regionDescriptor, args);
  if (!result.deleted || !result.sceneId) return result;
  const deletedIds = new Set(args.ids.filter(id => !(result.notFoundIds ?? []).includes(id)));
  const warnings: string[] = [];
  for (const s of game.scenes?.contents ?? []) {
    for (const region of s.regions ?? []) {
      for (const behavior of region.behaviors ?? []) {
        for (const dest of teleportDestinationsOf(behavior?.system)) {
          const m = dest.match(TELEPORT_DEST_RE);
          if (m && deletedIds.has(m[2])) {
            warnings.push(
              `teleporter "${region.name}" on "${s.name}" still points at deleted region ${m[2]} — ` +
                `retarget or delete it too`
            );
          }
        }
      }
    }
  }
  return warnings.length > 0 ? { ...result, warnings } : result;
}

// --- named special ops (outside generic CRUD — they cross-reference minted ids) -

/**
 * Two-way (or one-way) teleporter between two points — the killer convenience. Creates a rectangle
 * region at each end (sized in whole grid cells, snapped to the grid by default) and wires a
 * `teleportToken` behavior on each pointing at the OTHER region. Both regions are created BEFORE
 * either behavior so the cross-linked destination UUIDs resolve. `from`/`to` give a CENTER point in
 * canvas px on each scene (may be the same scene). Returns both created region ids + their final
 * shapes/destinations for verification.
 */
export async function createSceneTeleporter(args: {
  from: { sceneIdentifier: string; x: number; y: number };
  to: { sceneIdentifier: string; x: number; y: number };
  widthCells?: number;
  heightCells?: number;
  twoWay?: boolean;
  snapToGrid?: boolean;
  fromName?: string;
  toName?: string;
  color?: string;
}): Promise<{
  success: boolean;
  notFound?: string;
  twoWay?: boolean;
  from?: Record<string, unknown> & { sceneId: string; sceneName: string };
  to?: Record<string, unknown> & { sceneId: string; sceneName: string };
}> {
  if (!args?.from?.sceneIdentifier || !args?.to?.sceneIdentifier) {
    throw new Error('both from.sceneIdentifier and to.sceneIdentifier are required');
  }
  const fromScene = resolveSceneStrict(args.from.sceneIdentifier);
  if (!fromScene) return { success: true, notFound: args.from.sceneIdentifier };
  const toScene = resolveSceneStrict(args.to.sceneIdentifier);
  if (!toScene) return { success: true, notFound: args.to.sceneIdentifier };

  const wc = args.widthCells ?? 1;
  const hc = args.heightCells ?? 1;
  const snap = args.snapToGrid !== false;
  const twoWay = args.twoWay !== false;
  const color = typeof args.color === 'string' && args.color.trim() !== '' ? args.color : '#3fb0ff';
  const fromShape = gridRectShape(sceneGrid(fromScene), args.from.x, args.from.y, wc, hc, snap);
  const toShape = gridRectShape(sceneGrid(toScene), args.to.x, args.to.y, wc, hc, snap);

  // 1) Create both regions first (no behaviors) so both ids exist for the cross-links.
  const [regA] = await fromScene.createEmbeddedDocuments('Region', [
    { name: args.fromName ?? `Teleporter → ${toScene.name}`, color, shapes: [fromShape] },
  ]);
  const [regB] = await toScene.createEmbeddedDocuments('Region', [
    { name: args.toName ?? `Teleporter → ${fromScene.name}`, color, shapes: [toShape] },
  ]);

  // 2) Wire the teleportToken behavior(s), each pointing at the OTHER region. v14.364 stores the
  // destination in a `destinations` ARRAY (not a singular `destination`) — a single-element array is
  // the 1:1 teleporter; the field is plural because `choice:true` teleporters offer several exits.
  await regA.createEmbeddedDocuments('RegionBehavior', [
    {
      name: `Teleport to ${toScene.name}`,
      type: 'teleportToken',
      system: { destinations: [teleportDestUuid(toScene.id, regB.id)], choice: false },
    },
  ]);
  if (twoWay) {
    await regB.createEmbeddedDocuments('RegionBehavior', [
      {
        name: `Teleport to ${fromScene.name}`,
        type: 'teleportToken',
        system: { destinations: [teleportDestUuid(fromScene.id, regA.id)], choice: false },
      },
    ]);
  }

  // Re-fetch fresh so the read-back includes the just-added behaviors.
  const freshA = fromScene.regions.get(regA.id);
  const freshB = toScene.regions.get(regB.id);
  return {
    success: true,
    twoWay,
    from: { sceneId: fromScene.id, sceneName: fromScene.name, ...dumpRegion(freshA) },
    to: { sceneId: toScene.id, sceneName: toScene.name, ...dumpRegion(freshB) },
  };
}

/**
 * Post-import teleporter repair: find every scene the given module import stamped,
 * reconstruct origId→newId maps from the provenance flags both carry
 * (flags[TOM_CARTOS_FLAG_SCOPE].{sourceModule,sourceId}), then update every
 * teleport destination via `region.updateEmbeddedDocuments('RegionBehavior', …)`.
 * Idempotent (already-correct destinations are 'unchanged'); reports destinations
 * that point outside the import ('unresolved') rather than swallowing them.
 */
export async function remapSceneTeleporters(args: { sourceModule: string }): Promise<{
  success: boolean;
  sourceModule: string;
  scenesScanned: number;
  behaviorsScanned: number;
  rewritten: number;
  unchanged: number;
  unresolved: string[];
}> {
  if (!args?.sourceModule) throw new Error('sourceModule is required');
  const scope = TOM_CARTOS_FLAG_SCOPE;
  // Read the provenance flag by DIRECT property access — never `doc.getFlag(scope, …)`, which THROWS
  // ("Flag scope is not valid or not currently active") for any document lacking the flag when `scope`
  // is not a registered module id. This filter runs over EVERY scene in the world, most of which have
  // no tom-cartos flag, so getFlag would abort the whole remap. Flags are stored under `doc.flags[scope]`
  // verbatim (that is how the import stamps them), so the direct read is both safe and sufficient.
  const flagOf = (doc: any, key: string): string | undefined => {
    const v = doc?.flags?.[scope]?.[key];
    return typeof v === 'string' ? v : undefined;
  };

  const scenes: any[] = (game.scenes?.contents || []).filter(
    (s: any) => flagOf(s, 'sourceModule') === args.sourceModule
  );

  // Pass 1 — reconstruct old→new id maps from world state (no agent id-shuttling).
  const sceneIdMap: Record<string, string> = {};
  const regionIdMap: Record<string, string> = {};
  for (const s of scenes) {
    const sid = flagOf(s, 'sourceId');
    if (sid) sceneIdMap[sid] = s.id;
    for (const region of s.regions ?? []) {
      const rid = flagOf(region, 'sourceId');
      if (rid) regionIdMap[rid] = region.id;
    }
  }

  // Pass 2 — rewrite + persist each teleport destination. v14.364 stores destinations in a
  // `system.destinations` ARRAY, so each entry is remapped independently and the whole array is written
  // back when any entry changed (per-destination counting preserves the single-destination semantics).
  let rewritten = 0;
  let unchanged = 0;
  const unresolved: string[] = [];
  let behaviorsScanned = 0;
  for (const s of scenes) {
    for (const region of s.regions ?? []) {
      const updates: Array<Record<string, unknown>> = [];
      for (const behavior of region.behaviors ?? []) {
        behaviorsScanned++;
        const dests = teleportDestinationsOf(behavior?.system);
        if (dests.length === 0) continue; // non-teleport behavior / unset destination
        let changed = false;
        const newDests = dests.map(d => {
          const res = remapTeleportDestination(d, sceneIdMap, regionIdMap);
          if (res.status === 'rewritten') {
            changed = true;
            rewritten++;
            return res.dest as string;
          }
          if (res.status === 'unchanged') unchanged++;
          else if (res.status === 'unresolved') unresolved.push(`${s.name}: ${res.reason}`);
          return d;
        });
        if (changed) updates.push({ _id: behavior.id, 'system.destinations': newDests });
      }
      if (updates.length > 0) {
        await region.updateEmbeddedDocuments('RegionBehavior', updates);
      }
    }
  }

  return {
    success: true,
    sourceModule: args.sourceModule,
    scenesScanned: scenes.length,
    behaviorsScanned,
    rewritten,
    unchanged,
    unresolved,
  };
}
