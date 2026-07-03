// Page-side Wall descriptor for the placeable CRUD kernel (_placeables.ts).
//
// v14.364 Wall schema (live-dumped): c[x0,y0,x1,y1], move(0|20), light/sight/sound(0|10|20|30|40),
// dir(0 both/1 left/2 right), door(0 none/1 door/2 secret), ds(0 closed/1 open/2 locked), doorSound,
// threshold{light,sight,sound: number|null, attenuation: bool}, animation{...} (door swing).
//
// CORRECTNESS TRAPS this owns:
//  - Position is a SEGMENT `c:[x0,y0,x1,y1]` in absolute canvas pixels — the ONLY placeable with no
//    x/y point. `wallSegment` is the one normalizer ({x0..y1} | {c:[…]} → [4 numbers] | null); a
//    partial segment on update is dropped-and-warned, never half-applied.
//  - Restriction channels are STRICT v14 enums here (0/10/20/30/40; move only 0/20) — this is a
//    fresh authoring path, so an off-enum value is an ERROR, not a silent coercion (the legacy
//    coercion lives in sidecarWallToV14 for pack imports only).
//  - `threshold` nests → `threshold.light` etc. dot-paths on update (proximity doors).
//  - Foundry defaults an omitted sight/move/light/sound to 20 (blocking) — the normal solid wall.

import {
  crudCreate,
  crudDelete,
  crudList,
  crudUpdate,
  type CreateDocResult,
  type PatchResult,
  type PlaceableDescriptor,
} from '../_placeables.js';

const SENSE_VALUES = new Set([0, 10, 20, 30, 40]); // WALL_SENSE_TYPES
const MOVE_VALUES = new Set([0, 20]); // WALL_MOVEMENT_TYPES
const DIR_VALUES = new Set([0, 1, 2]); // WALL_DIRECTIONS
const DOOR_VALUES = new Set([0, 1, 2]); // WALL_DOOR_TYPES
const DS_VALUES = new Set([0, 1, 2]); // WALL_DOOR_STATES

export interface WallInput {
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  c?: number[];
  move?: number;
  light?: number;
  sight?: number;
  sound?: number;
  dir?: number;
  door?: number;
  ds?: number;
  doorSound?: string;
  thresholdLight?: number | null;
  thresholdSight?: number | null;
  thresholdSound?: number | null;
  thresholdAttenuation?: boolean;
}

/**
 * PURE: normalize a wall segment given as {x0,y0,x1,y1} or c:[x0,y0,x1,y1] into the canonical
 * 4-number array. Returns null when neither form yields 4 finite numbers (callers decide whether
 * that's an error — create — or a dropped field — update). Exported for unit testing.
 */
export function wallSegment(
  input: Pick<WallInput, 'x0' | 'y0' | 'x1' | 'y1' | 'c'>
): [number, number, number, number] | null {
  if (Array.isArray(input?.c)) {
    const c = input.c.map(Number);
    if (c.length === 4 && c.every(n => Number.isFinite(n)))
      return [c[0], c[1], c[2], c[3]] as [number, number, number, number];
    return null;
  }
  const parts = [input?.x0, input?.y0, input?.x1, input?.y1];
  if (parts.every(n => typeof n === 'number' && Number.isFinite(n)))
    return parts as [number, number, number, number];
  return null;
}

/**
 * PURE: validate the enum channels of one wall input against the strict v14 sets. Returns the
 * first violation as an error string, or null when everything supplied is in range.
 */
export function wallEnumError(w: WallInput): string | null {
  const checks: Array<[string, number | undefined, Set<number>, string]> = [
    ['move', w.move, MOVE_VALUES, '0 (pass) or 20 (block)'],
    ['light', w.light, SENSE_VALUES, '0/10/20/30/40'],
    ['sight', w.sight, SENSE_VALUES, '0/10/20/30/40'],
    ['sound', w.sound, SENSE_VALUES, '0/10/20/30/40'],
    ['dir', w.dir, DIR_VALUES, '0 (both) / 1 (left) / 2 (right)'],
    ['door', w.door, DOOR_VALUES, '0 (none) / 1 (door) / 2 (secret)'],
    ['ds', w.ds, DS_VALUES, '0 (closed) / 1 (open) / 2 (locked)'],
  ];
  for (const [name, value, allowed, hint] of checks) {
    if (value !== undefined && !allowed.has(value)) {
      return `${name} must be one of ${hint} (got ${value})`;
    }
  }
  return null;
}

/** Fold the supplied enum/door/threshold fields of one input into a doc/patch (shared shape). */
function foldWallFields(w: WallInput, out: Record<string, unknown>, dotPaths: boolean): void {
  for (const k of ['move', 'light', 'sight', 'sound', 'dir', 'door', 'ds'] as const) {
    if (typeof w[k] === 'number') out[k] = w[k];
  }
  if (typeof w.doorSound === 'string') out.doorSound = w.doorSound;
  const th: Array<['light' | 'sight' | 'sound', number | null | undefined]> = [
    ['light', w.thresholdLight],
    ['sight', w.thresholdSight],
    ['sound', w.thresholdSound],
  ];
  if (dotPaths) {
    for (const [k, v] of th) if (v !== undefined) out[`threshold.${k}`] = v;
    if (typeof w.thresholdAttenuation === 'boolean')
      out['threshold.attenuation'] = w.thresholdAttenuation;
  } else {
    const threshold: Record<string, unknown> = {};
    for (const [k, v] of th) if (v !== undefined) threshold[k] = v;
    if (typeof w.thresholdAttenuation === 'boolean') threshold.attenuation = w.thresholdAttenuation;
    if (Object.keys(threshold).length > 0) out.threshold = threshold;
  }
}

function toCreateDoc(input: WallInput): CreateDocResult {
  const c = wallSegment(input);
  if (!c) return { error: 'a segment is required: x0,y0,x1,y1 (or c:[x0,y0,x1,y1])' };
  const enumErr = wallEnumError(input);
  if (enumErr) return { error: enumErr };
  const doc: Record<string, unknown> = { c };
  foldWallFields(input, doc, false);
  return { doc };
}

function buildPatch(_existing: any, p: WallInput & { id: string }): PatchResult {
  const warnings: string[] = [];
  const enumErr = wallEnumError(p);
  if (enumErr) return { warnings: [`${p.id}: ${enumErr} — patch skipped`], changed: false };
  const patch: Record<string, unknown> = {};
  const wantsSegment =
    p.c !== undefined ||
    p.x0 !== undefined ||
    p.y0 !== undefined ||
    p.x1 !== undefined ||
    p.y1 !== undefined;
  if (wantsSegment) {
    const c = wallSegment(p);
    if (c) patch.c = c;
    else
      warnings.push(
        `${p.id}: segment ignored — provide ALL of x0,y0,x1,y1 (or c:[4]), a wall can't half-move`
      );
  }
  foldWallFields(p, patch, true);
  return { patch, warnings, changed: Object.keys(patch).length > 0 };
}

function dump(doc: any): Record<string, unknown> {
  return {
    id: doc.id,
    c: Array.isArray(doc.c) ? doc.c : [],
    move: doc.move,
    sight: doc.sight,
    light: doc.light,
    sound: doc.sound,
    dir: doc.dir,
    door: doc.door,
    ds: doc.ds,
    ...(doc.doorSound ? { doorSound: doc.doorSound } : {}),
  };
}

export const wallDescriptor: PlaceableDescriptor = {
  docName: 'Wall',
  collection: (scene: any) => scene.walls,
  dump,
  toCreateDoc,
  buildPatch,
};

// --- bridge page functions (registered in src/page/index.ts) -----------------
export const createSceneWalls = (args: { sceneIdentifier: string; items: WallInput[] }) =>
  crudCreate(wallDescriptor, args);
/**
 * List walls with an optional door filter. A populated scene carries hundreds of walls (the live
 * Cave has 645) and the real edit loop is DOORS (open/lock/secret) — `doorsOnly` keeps the response
 * inspectable instead of a wall-of-JSON.
 */
export const listSceneWalls = (args: { sceneIdentifier: string; doorsOnly?: boolean }) => {
  const r = crudList(wallDescriptor, { sceneIdentifier: args.sceneIdentifier });
  if (!args?.doorsOnly || !r.items) return r;
  const doors = r.items.filter(w => typeof w.door === 'number' && w.door > 0);
  return { ...r, count: doors.length, totalWalls: r.count, items: doors };
};
export const updateSceneWalls = (args: {
  sceneIdentifier: string;
  patches: Array<{ id: string } & WallInput>;
}) => crudUpdate(wallDescriptor, args);
export const deleteSceneWalls = (args: { sceneIdentifier: string; ids: string[] }) =>
  crudDelete(wallDescriptor, args);
