// Page-side Drawing descriptor for the placeable CRUD kernel (_placeables.ts).
//
// v14.364 Drawing schema (live-dumped): name, author(auto — the creating user), x, y, elevation, sort,
// rotation, shape{type:'r'|'c'|'e'|'p', width, height, radius, points[]}, bezierFactor,
// fillType(0 none/1 solid/2 pattern), fillColor, fillAlpha(0.5), strokeWidth(8), strokeColor,
// strokeAlpha(1), texture(fill-pattern path), text, fontFamily, fontSize(48), textColor(#ffffff),
// textAlpha, hidden, locked, interface.
//
// CORRECTNESS TRAPS this owns:
//  - `shape` is a nested data model; the friendly `shapeType` names map to the one-letter enum
//    (rectangle→'r', circle→'c', ellipse→'e', polygon→'p') and each type REQUIRES its own dims:
//    r/e → width+height, c → radius, p → points (≥3 pairs, flat [x1,y1,x2,y2,…]).
//  - `shape.points` are RELATIVE to the drawing's x/y origin, not absolute canvas pixels.
//  - x/y are the drawing's top-left origin in absolute canvas pixels (padding-offset).
//  - Foundry requires SOME visible content (stroke, fill, or text); the schema defaults
//    (strokeWidth 8, strokeAlpha 1) satisfy that, so a bare shape renders as an outline.
//  - Updates write `shape.*` dot-paths so resizing never clobbers the shape type or points.

import { normalizeAssetPath } from '../_shared.js';
import { imgResolves, badAssetWarning } from '../img-resolve.js';
import {
  crudCreate,
  crudDelete,
  crudList,
  crudUpdate,
  type CreateDocResult,
  type PatchResult,
  type PlaceableDescriptor,
} from '../_placeables.js';

const SHAPE_TYPE_TO_ENUM: Record<string, string> = {
  rectangle: 'r',
  circle: 'c',
  ellipse: 'e',
  polygon: 'p',
};
const SHAPE_ENUM_TO_TYPE: Record<string, string> = {
  r: 'rectangle',
  c: 'circle',
  e: 'ellipse',
  p: 'polygon',
};

export interface DrawingInput {
  x?: number;
  y?: number;
  shapeType?: string;
  width?: number;
  height?: number;
  radius?: number;
  points?: number[];
  rotation?: number;
  elevation?: number;
  sort?: number;
  strokeWidth?: number;
  strokeColor?: string;
  strokeAlpha?: number;
  fillType?: number;
  fillColor?: string;
  fillAlpha?: number;
  fillTexture?: string;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  textAlpha?: number;
  hidden?: boolean;
  locked?: boolean;
  interface?: boolean;
}

/**
 * PURE: validate + build the nested v14 `shape` object from the flat inputs for ONE shape type.
 * Returns an error string instead of a shape when the type's required dims are missing/malformed.
 * Exported for unit testing.
 */
export function buildDrawingShape(input: DrawingInput): {
  shape?: Record<string, unknown>;
  error?: string;
} {
  const friendly = input.shapeType ?? 'rectangle';
  const type = SHAPE_TYPE_TO_ENUM[friendly];
  if (!type) {
    return { error: `unknown shapeType "${friendly}" (rectangle, circle, ellipse, or polygon)` };
  }
  if (type === 'r' || type === 'e') {
    if (
      typeof input.width !== 'number' ||
      input.width <= 0 ||
      typeof input.height !== 'number' ||
      input.height <= 0
    ) {
      return { error: `${friendly} needs width and height (px, > 0)` };
    }
    return { shape: { type, width: input.width, height: input.height } };
  }
  if (type === 'c') {
    if (typeof input.radius !== 'number' || input.radius <= 0) {
      return { error: 'circle needs radius (px, > 0)' };
    }
    return { shape: { type, radius: input.radius } };
  }
  // polygon: a flat, even-length list of ≥3 (x,y) pairs, RELATIVE to the drawing's x/y origin.
  const pts = input.points;
  if (!Array.isArray(pts) || pts.length < 6 || pts.length % 2 !== 0) {
    return { error: 'polygon needs points: a flat, even-length array of at least 3 x,y pairs' };
  }
  if (pts.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
    return { error: 'polygon points must all be finite numbers' };
  }
  return { shape: { type, points: pts } };
}

async function toCreateDoc(input: DrawingInput): Promise<CreateDocResult> {
  for (const k of ['x', 'y'] as const) {
    if (typeof input[k] !== 'number') return { error: `${k} is required (a number)` };
  }
  const { shape, error } = buildDrawingShape(input);
  if (error) return { error };

  const warnings: string[] = [];
  const doc: Record<string, unknown> = { x: input.x, y: input.y, shape };
  for (const k of [
    'rotation',
    'elevation',
    'sort',
    'strokeWidth',
    'strokeAlpha',
    'fillType',
    'fillAlpha',
    'fontSize',
    'textAlpha',
  ] as const) {
    if (typeof input[k] === 'number') doc[k] = input[k];
  }
  for (const k of ['strokeColor', 'fillColor', 'text', 'fontFamily', 'textColor'] as const) {
    if (typeof input[k] === 'string' && input[k]!.trim() !== '') doc[k] = input[k];
  }
  for (const k of ['hidden', 'locked', 'interface'] as const) {
    if (typeof input[k] === 'boolean') doc[k] = input[k];
  }
  if (typeof input.fillTexture === 'string' && input.fillTexture.trim() !== '') {
    const tex = normalizeAssetPath(input.fillTexture);
    // KEEP+WARN: a fill pattern has no sensible substitute.
    if (tex && !(await imgResolves(tex))) warnings.push(badAssetWarning('fillTexture', tex, false));
    doc.texture = tex;
  }
  return { doc, ...(warnings.length ? { warnings } : {}) };
}

async function buildPatch(_existing: any, p: DrawingInput & { id: string }): Promise<PatchResult> {
  const patch: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const k of ['x', 'y', 'rotation', 'elevation', 'sort'] as const) {
    if (typeof p[k] === 'number') patch[k] = p[k];
  }
  // shape.* dot-paths: resize without clobbering the shape type/points. Changing the TYPE of an
  // existing drawing is not supported (delete + recreate) — geometry fields patch independently.
  if (typeof p.width === 'number') patch['shape.width'] = p.width;
  if (typeof p.height === 'number') patch['shape.height'] = p.height;
  if (typeof p.radius === 'number') patch['shape.radius'] = p.radius;
  if (Array.isArray(p.points) && p.points.length >= 6 && p.points.length % 2 === 0) {
    patch['shape.points'] = p.points;
  } else if (p.points !== undefined) {
    warnings.push('points ignored: needs a flat, even-length array of at least 3 x,y pairs');
  }
  if (p.shapeType !== undefined) {
    warnings.push('shapeType cannot be changed on an existing drawing — delete and recreate');
  }
  for (const k of [
    'strokeWidth',
    'strokeAlpha',
    'fillType',
    'fillAlpha',
    'fontSize',
    'textAlpha',
  ] as const) {
    if (typeof p[k] === 'number') patch[k] = p[k];
  }
  for (const k of ['strokeColor', 'fillColor', 'fontFamily', 'textColor'] as const) {
    if (typeof p[k] === 'string' && p[k]!.trim() !== '') patch[k] = p[k];
  }
  if (typeof p.text === 'string') patch.text = p.text; // '' clears the label deliberately
  for (const k of ['hidden', 'locked', 'interface'] as const) {
    if (typeof p[k] === 'boolean') patch[k] = p[k];
  }
  if (typeof p.fillTexture === 'string' && p.fillTexture.trim() !== '') {
    const tex = normalizeAssetPath(p.fillTexture);
    if (tex && !(await imgResolves(tex))) warnings.push(badAssetWarning('fillTexture', tex, false));
    patch.texture = tex;
  }
  return { patch, warnings, changed: Object.keys(patch).length > 0 };
}

function dump(doc: any): Record<string, unknown> {
  const s = doc.shape ?? {};
  return {
    id: doc.id,
    ...(doc.name ? { name: doc.name } : {}),
    x: doc.x,
    y: doc.y,
    shapeType: SHAPE_ENUM_TO_TYPE[s.type] ?? s.type,
    ...(s.width != null ? { width: s.width, height: s.height } : {}),
    ...(s.radius != null ? { radius: s.radius } : {}),
    ...(Array.isArray(s.points) && s.points.length ? { pointCount: s.points.length / 2 } : {}),
    rotation: doc.rotation,
    elevation: doc.elevation,
    sort: doc.sort,
    ...(doc.text ? { text: doc.text } : {}),
    fillType: doc.fillType,
    strokeColor: doc.strokeColor,
    hidden: doc.hidden,
    locked: doc.locked,
    interface: doc.interface,
  };
}

export const drawingDescriptor: PlaceableDescriptor = {
  docName: 'Drawing',
  collection: (scene: any) => scene.drawings,
  dump,
  toCreateDoc,
  buildPatch,
};

// --- bridge page functions (registered in src/page/index.ts) -----------------
export const createSceneDrawings = (args: { sceneIdentifier: string; items: DrawingInput[] }) =>
  crudCreate(drawingDescriptor, args);
export const listSceneDrawings = (args: { sceneIdentifier: string }) =>
  crudList(drawingDescriptor, args);
export const updateSceneDrawings = (args: {
  sceneIdentifier: string;
  patches: Array<{ id: string } & DrawingInput>;
}) => crudUpdate(drawingDescriptor, args);
export const deleteSceneDrawings = (args: { sceneIdentifier: string; ids: string[] }) =>
  crudDelete(drawingDescriptor, args);
