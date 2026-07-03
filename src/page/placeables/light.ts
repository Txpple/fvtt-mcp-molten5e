// Page-side AmbientLight descriptor for the placeable CRUD kernel (_placeables.ts).
//
// v14.364 AmbientLight schema (live-dumped): x, y, rotation, walls(bool), vision(bool), hidden, locked,
// elevation, and the emission `config` data model: {dim, bright, color, alpha, angle, luminosity,
// attenuation, coloration, saturation, contrast, shadows, negative, priority, animation{type,speed,
// intensity,reverse}, darkness{min,max}}.
//
// CORRECTNESS TRAPS this owns:
//  - Emission + animation nest under `config{}` — a FLAT top-level `dim` on update silently no-ops.
//    Writes go to `config.*` dot-paths; the flat tool inputs are folded into config on create.
//  - x/y are the light CENTER in absolute canvas pixels (padding-offset). `dim`/`bright` are radii in
//    grid-distance units (e.g. feet), NOT pixels.

import {
  crudCreate,
  crudDelete,
  crudList,
  crudUpdate,
  type CreateDocResult,
  type PatchResult,
  type PlaceableDescriptor,
} from '../_placeables.js';

export interface LightInput {
  x?: number;
  y?: number;
  rotation?: number;
  walls?: boolean;
  vision?: boolean;
  hidden?: boolean;
  elevation?: number;
  dim?: number;
  bright?: number;
  color?: string;
  alpha?: number;
  angle?: number;
  luminosity?: number;
  attenuation?: number;
  animationType?: string;
  animationSpeed?: number;
  animationIntensity?: number;
  darknessMin?: number;
  darknessMax?: number;
}

/** Build the nested `config` emission object from the flat inputs (only-supplied fields). */
function lightConfig(l: LightInput): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (typeof l.dim === 'number') c.dim = l.dim;
  if (typeof l.bright === 'number') c.bright = l.bright;
  if (typeof l.color === 'string' && l.color.trim() !== '') c.color = l.color;
  if (typeof l.alpha === 'number') c.alpha = l.alpha;
  if (typeof l.angle === 'number') c.angle = l.angle;
  if (typeof l.luminosity === 'number') c.luminosity = l.luminosity;
  if (typeof l.attenuation === 'number') c.attenuation = l.attenuation;
  const anim: Record<string, unknown> = {};
  if (typeof l.animationType === 'string' && l.animationType.trim() !== '')
    anim.type = l.animationType;
  if (typeof l.animationSpeed === 'number') anim.speed = l.animationSpeed;
  if (typeof l.animationIntensity === 'number') anim.intensity = l.animationIntensity;
  if (Object.keys(anim).length > 0) c.animation = anim;
  const dark: Record<string, unknown> = {};
  if (typeof l.darknessMin === 'number') dark.min = l.darknessMin;
  if (typeof l.darknessMax === 'number') dark.max = l.darknessMax;
  if (Object.keys(dark).length > 0) c.darkness = dark;
  return c;
}

function toCreateDoc(input: LightInput): CreateDocResult {
  for (const k of ['x', 'y'] as const) {
    if (typeof input[k] !== 'number') return { error: `${k} is required (a number)` };
  }
  const doc: Record<string, unknown> = { x: input.x, y: input.y, config: lightConfig(input) };
  if (typeof input.rotation === 'number') doc.rotation = input.rotation;
  if (typeof input.walls === 'boolean') doc.walls = input.walls;
  if (typeof input.vision === 'boolean') doc.vision = input.vision;
  if (typeof input.hidden === 'boolean') doc.hidden = input.hidden;
  if (typeof input.elevation === 'number') doc.elevation = input.elevation;
  return { doc };
}

function buildPatch(_existing: any, p: LightInput & { id: string }): PatchResult {
  const patch: Record<string, unknown> = {};
  if (typeof p.x === 'number') patch.x = p.x;
  if (typeof p.y === 'number') patch.y = p.y;
  if (typeof p.rotation === 'number') patch.rotation = p.rotation;
  if (typeof p.walls === 'boolean') patch.walls = p.walls;
  if (typeof p.vision === 'boolean') patch.vision = p.vision;
  if (typeof p.hidden === 'boolean') patch.hidden = p.hidden;
  if (typeof p.elevation === 'number') patch.elevation = p.elevation;
  // Emission nests under config — write config.* dot-paths so a partial change never wipes the rest.
  if (typeof p.dim === 'number') patch['config.dim'] = p.dim;
  if (typeof p.bright === 'number') patch['config.bright'] = p.bright;
  if (typeof p.color === 'string' && p.color.trim() !== '') patch['config.color'] = p.color;
  if (typeof p.alpha === 'number') patch['config.alpha'] = p.alpha;
  if (typeof p.angle === 'number') patch['config.angle'] = p.angle;
  if (typeof p.luminosity === 'number') patch['config.luminosity'] = p.luminosity;
  if (typeof p.attenuation === 'number') patch['config.attenuation'] = p.attenuation;
  if (typeof p.animationType === 'string' && p.animationType.trim() !== '')
    patch['config.animation.type'] = p.animationType;
  if (typeof p.animationSpeed === 'number') patch['config.animation.speed'] = p.animationSpeed;
  if (typeof p.animationIntensity === 'number')
    patch['config.animation.intensity'] = p.animationIntensity;
  if (typeof p.darknessMin === 'number') patch['config.darkness.min'] = p.darknessMin;
  if (typeof p.darknessMax === 'number') patch['config.darkness.max'] = p.darknessMax;
  return { patch, changed: Object.keys(patch).length > 0 };
}

function dump(doc: any): Record<string, unknown> {
  const c = doc.config ?? {};
  return {
    id: doc.id,
    x: doc.x,
    y: doc.y,
    rotation: doc.rotation,
    hidden: doc.hidden,
    walls: doc.walls,
    vision: doc.vision,
    dim: c.dim,
    bright: c.bright,
    color: c.color,
    angle: c.angle,
    animation: c.animation?.type ?? null,
  };
}

export const lightDescriptor: PlaceableDescriptor = {
  docName: 'AmbientLight',
  collection: (scene: any) => scene.lights,
  dump,
  toCreateDoc,
  buildPatch,
};

// --- bridge page functions (registered in src/page/index.ts) -----------------
export const createSceneLights = (args: { sceneIdentifier: string; items: LightInput[] }) =>
  crudCreate(lightDescriptor, args);
export const listSceneLights = (args: { sceneIdentifier: string }) =>
  crudList(lightDescriptor, args);
export const updateSceneLights = (args: {
  sceneIdentifier: string;
  patches: Array<{ id: string } & LightInput>;
}) => crudUpdate(lightDescriptor, args);
export const deleteSceneLights = (args: { sceneIdentifier: string; ids: string[] }) =>
  crudDelete(lightDescriptor, args);
