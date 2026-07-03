// Page-side AmbientSound descriptor for the placeable CRUD kernel (_placeables.ts).
//
// v14.364 AmbientSound schema (live-dumped): name, x, y, elevation, radius, path(FilePath, nullable),
// repeat, volume(Alpha, default 0.5), walls(default true), easing(default true), hidden, locked,
// darkness{min,max}, effects{base{type,intensity}, muffled{type,intensity}}.
//
// CORRECTNESS TRAPS this owns:
//  - x/y are the emitter CENTER in absolute canvas pixels (padding-offset). `radius` is in
//    grid-DISTANCE units (e.g. feet) like a light's dim/bright — NOT pixels.
//  - `darkness` and `effects` nest — updates write `darkness.min` / `effects.base.type` dot-paths so a
//    partial change never wipes the sibling fields.
//  - `path` is asset-checked KEEP+WARN (an audio track has no sensible substitute — Group B policy).

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

export interface SoundInput {
  x?: number;
  y?: number;
  path?: string;
  radius?: number;
  name?: string;
  repeat?: boolean;
  volume?: number;
  walls?: boolean;
  easing?: boolean;
  hidden?: boolean;
  elevation?: number;
  darknessMin?: number;
  darknessMax?: number;
  baseEffect?: string;
  baseEffectIntensity?: number;
  muffledEffect?: string;
  muffledEffectIntensity?: number;
}

async function toCreateDoc(input: SoundInput): Promise<CreateDocResult> {
  for (const k of ['x', 'y'] as const) {
    if (typeof input[k] !== 'number') return { error: `${k} is required (a number)` };
  }
  if (!input?.path || typeof input.path !== 'string') {
    return { error: 'path (audio file path) is required' };
  }
  if (typeof input.radius !== 'number' || input.radius <= 0) {
    return { error: 'radius is required (grid-distance units, > 0)' };
  }
  const warnings: string[] = [];
  const path = normalizeAssetPath(input.path);
  // KEEP+WARN: an audio track has no sensible substitute — keep the path but warn on a 404.
  if (path && !(await imgResolves(path))) warnings.push(badAssetWarning('path', path, false));

  const doc: Record<string, unknown> = { x: input.x, y: input.y, path, radius: input.radius };
  if (typeof input.name === 'string' && input.name.trim() !== '') doc.name = input.name.trim();
  if (typeof input.repeat === 'boolean') doc.repeat = input.repeat;
  if (typeof input.volume === 'number') doc.volume = input.volume;
  if (typeof input.walls === 'boolean') doc.walls = input.walls;
  if (typeof input.easing === 'boolean') doc.easing = input.easing;
  if (typeof input.hidden === 'boolean') doc.hidden = input.hidden;
  if (typeof input.elevation === 'number') doc.elevation = input.elevation;
  if (typeof input.darknessMin === 'number' || typeof input.darknessMax === 'number') {
    const dark: Record<string, unknown> = {};
    if (typeof input.darknessMin === 'number') dark.min = input.darknessMin;
    if (typeof input.darknessMax === 'number') dark.max = input.darknessMax;
    doc.darkness = dark;
  }
  const effects: Record<string, unknown> = {};
  if (typeof input.baseEffect === 'string' && input.baseEffect.trim() !== '') {
    effects.base = {
      type: input.baseEffect,
      ...(typeof input.baseEffectIntensity === 'number'
        ? { intensity: input.baseEffectIntensity }
        : {}),
    };
  }
  if (typeof input.muffledEffect === 'string' && input.muffledEffect.trim() !== '') {
    effects.muffled = {
      type: input.muffledEffect,
      ...(typeof input.muffledEffectIntensity === 'number'
        ? { intensity: input.muffledEffectIntensity }
        : {}),
    };
  }
  if (Object.keys(effects).length > 0) doc.effects = effects;
  return { doc, ...(warnings.length ? { warnings } : {}) };
}

async function buildPatch(_existing: any, p: SoundInput & { id: string }): Promise<PatchResult> {
  const patch: Record<string, unknown> = {};
  const warnings: string[] = [];
  if (typeof p.path === 'string' && p.path.trim() !== '') {
    const path = normalizeAssetPath(p.path);
    if (path && !(await imgResolves(path))) warnings.push(badAssetWarning('path', path, false));
    patch.path = path;
  }
  for (const k of ['x', 'y', 'radius', 'volume', 'elevation'] as const) {
    if (typeof p[k] === 'number') patch[k] = p[k];
  }
  if (typeof p.name === 'string' && p.name.trim() !== '') patch.name = p.name.trim();
  for (const k of ['repeat', 'walls', 'easing', 'hidden'] as const) {
    if (typeof p[k] === 'boolean') patch[k] = p[k];
  }
  // darkness/effects nest — dot-paths so a partial change never wipes the rest.
  if (typeof p.darknessMin === 'number') patch['darkness.min'] = p.darknessMin;
  if (typeof p.darknessMax === 'number') patch['darkness.max'] = p.darknessMax;
  if (typeof p.baseEffect === 'string') patch['effects.base.type'] = p.baseEffect;
  if (typeof p.baseEffectIntensity === 'number')
    patch['effects.base.intensity'] = p.baseEffectIntensity;
  if (typeof p.muffledEffect === 'string') patch['effects.muffled.type'] = p.muffledEffect;
  if (typeof p.muffledEffectIntensity === 'number')
    patch['effects.muffled.intensity'] = p.muffledEffectIntensity;
  return { patch, warnings, changed: Object.keys(patch).length > 0 };
}

function dump(doc: any): Record<string, unknown> {
  return {
    id: doc.id,
    ...(doc.name ? { name: doc.name } : {}),
    x: doc.x,
    y: doc.y,
    radius: doc.radius,
    path: doc.path,
    volume: doc.volume,
    repeat: doc.repeat,
    walls: doc.walls,
    easing: doc.easing,
    hidden: doc.hidden,
    elevation: doc.elevation,
    darkness: { min: doc.darkness?.min, max: doc.darkness?.max },
    baseEffect: doc.effects?.base?.type || null,
  };
}

export const soundDescriptor: PlaceableDescriptor = {
  docName: 'AmbientSound',
  collection: (scene: any) => scene.sounds,
  dump,
  toCreateDoc,
  buildPatch,
};

// --- bridge page functions (registered in src/page/index.ts) -----------------
export const createSceneSounds = (args: { sceneIdentifier: string; items: SoundInput[] }) =>
  crudCreate(soundDescriptor, args);
export const listSceneSounds = (args: { sceneIdentifier: string }) =>
  crudList(soundDescriptor, args);
export const updateSceneSounds = (args: {
  sceneIdentifier: string;
  patches: Array<{ id: string } & SoundInput>;
}) => crudUpdate(soundDescriptor, args);
export const deleteSceneSounds = (args: { sceneIdentifier: string; ids: string[] }) =>
  crudDelete(soundDescriptor, args);
