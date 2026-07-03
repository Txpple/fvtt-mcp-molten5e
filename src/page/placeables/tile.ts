// Page-side Tile descriptor for the placeable CRUD kernel (_placeables.ts).
//
// v14.364 Tile schema (live-dumped): texture(TextureData {src,scaleX,scaleY,tint,fit,anchorX,anchorY,
// alphaThreshold}), x, y, width, height, elevation, sort, rotation, alpha, hidden, locked,
// restrictions{light,weather}, occlusion{modes:SetField<number>, alpha}, video{loop,autoplay,volume}.
//
// CORRECTNESS TRAPS this owns (so the kernel never sees them):
//  - A tile's SIZE is `width`/`height` (canvas px), NOT `texture.scaleX` (that scales the image WITHIN
//    the frame — copying the Token idiom would silently no-op a resize). Both are exposed, distinctly.
//  - `x`/`y` are absolute canvas pixels (padding-offset). `occlusion.modes` is a SetField, so it is
//    WRITTEN as an array (Foundry coerces to a Set) — same lesson as teleporter destinations.
//  - `texture.src` is asset-checked KEEP+WARN (a map/prop tile has no sensible substitute).

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

export interface TileInput {
  src?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  alpha?: number;
  elevation?: number;
  sort?: number;
  scaleX?: number;
  scaleY?: number;
  tint?: string;
  fit?: string;
  occlusionMode?: number;
  occlusionAlpha?: number;
  restrictLight?: boolean;
  restrictWeather?: boolean;
  videoLoop?: boolean;
  videoAutoplay?: boolean;
  videoVolume?: number;
  hidden?: boolean;
  locked?: boolean;
}

/** Build the nested `texture` create object from the flat inputs (only-supplied fields). */
function textureCreate(t: TileInput, src: string): Record<string, unknown> {
  const tex: Record<string, unknown> = { src };
  if (typeof t.scaleX === 'number') tex.scaleX = t.scaleX;
  if (typeof t.scaleY === 'number') tex.scaleY = t.scaleY;
  if (typeof t.tint === 'string' && t.tint.trim() !== '') tex.tint = t.tint;
  if (typeof t.fit === 'string' && t.fit.trim() !== '') tex.fit = t.fit;
  return tex;
}

async function toCreateDoc(input: TileInput): Promise<CreateDocResult> {
  if (!input?.src || typeof input.src !== 'string')
    return { error: 'src (texture path) is required' };
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    if (typeof input[k] !== 'number') return { error: `${k} is required (a number)` };
  }
  const warnings: string[] = [];
  const src = normalizeAssetPath(input.src);
  // KEEP+WARN: a tile image has no sensible substitute — keep the path but warn on a 404.
  if (src && !(await imgResolves(src))) warnings.push(badAssetWarning('src', src, false));

  const doc: Record<string, unknown> = {
    texture: textureCreate(input, src),
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
  };
  if (typeof input.rotation === 'number') doc.rotation = input.rotation;
  if (typeof input.alpha === 'number') doc.alpha = input.alpha;
  if (typeof input.elevation === 'number') doc.elevation = input.elevation;
  if (typeof input.sort === 'number') doc.sort = input.sort;
  if (typeof input.hidden === 'boolean') doc.hidden = input.hidden;
  if (typeof input.locked === 'boolean') doc.locked = input.locked;
  // occlusion.modes is a SetField — write an ARRAY (Foundry coerces to a Set).
  if (typeof input.occlusionMode === 'number' || typeof input.occlusionAlpha === 'number') {
    const occ: Record<string, unknown> = {};
    if (typeof input.occlusionMode === 'number') occ.modes = [input.occlusionMode];
    if (typeof input.occlusionAlpha === 'number') occ.alpha = input.occlusionAlpha;
    doc.occlusion = occ;
  }
  if (typeof input.restrictLight === 'boolean' || typeof input.restrictWeather === 'boolean') {
    const r: Record<string, unknown> = {};
    if (typeof input.restrictLight === 'boolean') r.light = input.restrictLight;
    if (typeof input.restrictWeather === 'boolean') r.weather = input.restrictWeather;
    doc.restrictions = r;
  }
  if (
    typeof input.videoLoop === 'boolean' ||
    typeof input.videoAutoplay === 'boolean' ||
    typeof input.videoVolume === 'number'
  ) {
    const v: Record<string, unknown> = {};
    if (typeof input.videoLoop === 'boolean') v.loop = input.videoLoop;
    if (typeof input.videoAutoplay === 'boolean') v.autoplay = input.videoAutoplay;
    if (typeof input.videoVolume === 'number') v.volume = input.videoVolume;
    doc.video = v;
  }
  return { doc, ...(warnings.length ? { warnings } : {}) };
}

async function buildPatch(_existing: any, p: TileInput & { id: string }): Promise<PatchResult> {
  const patch: Record<string, unknown> = {};
  const warnings: string[] = [];
  if (typeof p.src === 'string' && p.src.trim() !== '') {
    const src = normalizeAssetPath(p.src);
    if (src && !(await imgResolves(src))) warnings.push(badAssetWarning('src', src, false));
    patch['texture.src'] = src;
  }
  if (typeof p.scaleX === 'number') patch['texture.scaleX'] = p.scaleX;
  if (typeof p.scaleY === 'number') patch['texture.scaleY'] = p.scaleY;
  if (typeof p.tint === 'string' && p.tint.trim() !== '') patch['texture.tint'] = p.tint;
  if (typeof p.fit === 'string' && p.fit.trim() !== '') patch['texture.fit'] = p.fit;
  for (const k of [
    'x',
    'y',
    'width',
    'height',
    'rotation',
    'alpha',
    'elevation',
    'sort',
  ] as const) {
    if (typeof p[k] === 'number') patch[k] = p[k];
  }
  if (typeof p.hidden === 'boolean') patch.hidden = p.hidden;
  if (typeof p.locked === 'boolean') patch.locked = p.locked;
  if (typeof p.occlusionMode === 'number') patch['occlusion.modes'] = [p.occlusionMode];
  if (typeof p.occlusionAlpha === 'number') patch['occlusion.alpha'] = p.occlusionAlpha;
  if (typeof p.restrictLight === 'boolean') patch['restrictions.light'] = p.restrictLight;
  if (typeof p.restrictWeather === 'boolean') patch['restrictions.weather'] = p.restrictWeather;
  if (typeof p.videoLoop === 'boolean') patch['video.loop'] = p.videoLoop;
  if (typeof p.videoAutoplay === 'boolean') patch['video.autoplay'] = p.videoAutoplay;
  if (typeof p.videoVolume === 'number') patch['video.volume'] = p.videoVolume;
  return { patch, warnings, changed: Object.keys(patch).length > 0 };
}

function dump(doc: any): Record<string, unknown> {
  return {
    id: doc.id,
    ...(doc.name ? { name: doc.name } : {}),
    x: doc.x,
    y: doc.y,
    width: doc.width,
    height: doc.height,
    rotation: doc.rotation,
    elevation: doc.elevation,
    sort: doc.sort,
    hidden: doc.hidden,
    locked: doc.locked,
    src: doc.texture?.src,
    scaleX: doc.texture?.scaleX,
    scaleY: doc.texture?.scaleY,
  };
}

export const tileDescriptor: PlaceableDescriptor = {
  docName: 'Tile',
  collection: (scene: any) => scene.tiles,
  dump,
  toCreateDoc,
  buildPatch,
};

// --- bridge page functions (registered in src/page/index.ts) -----------------
export const createSceneTiles = (args: { sceneIdentifier: string; items: TileInput[] }) =>
  crudCreate(tileDescriptor, args);
export const listSceneTiles = (args: { sceneIdentifier: string }) => crudList(tileDescriptor, args);
export const updateSceneTiles = (args: {
  sceneIdentifier: string;
  patches: Array<{ id: string } & TileInput>;
}) => crudUpdate(tileDescriptor, args);
export const deleteSceneTiles = (args: { sceneIdentifier: string; ids: string[] }) =>
  crudDelete(tileDescriptor, args);
