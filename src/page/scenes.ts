// Page-side: scene reads + writes. Runs inside the Foundry page.
//
// Reads are pure against game.scenes. Writes (create/update/delete) perform
// awaited Foundry document mutations and are best-effort (no rollback). No
// permission/transaction/audit scaffolding — the bridge is always GM. The
// Node-side tools (src/tools/scene.ts, src/tools/asset-bridge.ts) own all output
// shaping; these functions return the raw structured values those tools (and
// their tests) expect.
//
// v14 schema facts (live-verified against Foundry 14.364 / dnd5e 5.3.3):
//  - There is NO top-level Scene.background. The map image lives on the scene's
//    initial Level: levels[<initialLevel>].background.src. Scene.create() auto-
//    seeds a default Level (id "defaultLevel0000") that already has a background
//    TextureData, so applySceneBackground's levels[] branch always hits on v14.
//  - Lighting/darkness live under the `environment` data model
//    (environment.darknessLevel 0–1, environment.globalLight.enabled). The old
//    top-level globalLight/darkness fields are gone in v14.
//  - Fog is a 3-mode enum: fog.mode 0 DISABLED / 1 INDIVIDUAL / 2 SHARED
//    (fog.exploration boolean and fog.overlay are gone in v14).
//  - grid is a data model: grid.{type,size,distance,units,...}.
//  - weather is a top-level StringField keyed into CONFIG.weatherEffects.
//  - playlist / journal are top-level ForeignDocumentField id strings.

import { normalizeAssetPath } from './_shared.js';

// Foundry document class (Scene) and CONST live in the page global scope but are
// not declared in foundry-globals.d.ts; reach them off globalThis (loosely typed).
const SceneClass: any = (globalThis as any).Scene;
const CONST_: any = (globalThis as any).CONST;
const foundryUtils: any = (globalThis as any).foundry?.utils;

// --- pure helpers (unit-tested in scenes.test.ts; no page globals) -----------

/** Fog-of-war mode names ↔ the numeric `fog.mode` the v14 schema stores. */
export const FOG_MODE_TO_NUMBER: Record<string, number> = {
  disabled: 0,
  individual: 1,
  shared: 2,
};
const FOG_NUMBER_TO_NAME: Record<number, string> = { 0: 'disabled', 1: 'individual', 2: 'shared' };

/** Map a fogMode name to the numeric `fog.mode`. Throws on an unknown name. */
export function fogModeToNumber(mode: string): number {
  const n = FOG_MODE_TO_NUMBER[mode];
  if (n === undefined) {
    throw new Error(`Invalid fogMode "${mode}". Use one of: disabled, individual, shared.`);
  }
  return n;
}

/** Map a numeric `fog.mode` back to its name (for output). Unknown → String(n). */
export function fogModeToName(n: unknown): string {
  return typeof n === 'number' && FOG_NUMBER_TO_NAME[n] ? FOG_NUMBER_TO_NAME[n] : String(n ?? '');
}

/**
 * Normalize a weather key against the set of registered keys: exact match first,
 * then case-insensitive (returns the canonical key). Empty/nullish → "" (clear).
 * Throws a listing error on an unknown key. Pure — the page-side wrapper supplies
 * `availableKeys` from CONFIG.weatherEffects.
 */
export function normalizeWeatherKey(input: unknown, availableKeys: string[]): string {
  if (input === '' || input === null || input === undefined) return '';
  const s = String(input);
  if (availableKeys.includes(s)) return s;
  const ci = availableKeys.find(k => k.toLowerCase() === s.toLowerCase());
  if (ci) return ci;
  throw new Error(
    `Unknown weather "${s}". Available: ${availableKeys.join(', ') || '(none registered)'}, or "" for none.`
  );
}

// --- legacy scene-sidecar placeable conversion (walls + lights) --------------
//
// Map-pack sidecars (a map.jpg + map.json sitting next to it) ship walls/lights
// in Foundry's LEGACY (pre-v10) flat shape, and the automatic migration shim was
// REMOVED in Foundry v11/v12 — so we MUST translate to the v14 document shape
// ourselves (live-verified against Foundry 14.364):
//  - Wall restriction enums: legacy used small ints {0 NONE, 1 NORMAL, 2 LIMITED};
//    v14 CONST.WALL_SENSE_TYPES is spaced {NONE 0, LIMITED 10, NORMAL 20,
//    PROXIMITY 30, DISTANCE 40}. Values already in the v14 set pass through.
//  - The legacy `sense` key was renamed to `sight` in v10 AND split to also drive
//    `light`, so a legacy `sense` populates BOTH sight and light here.
//  - `door` uses CONST.WALL_DOOR_TYPES {NONE 0, DOOR 1, SECRET 2} — identical
//    across versions, so it passes through unchanged.
//  - Lights moved from flat {dim,bright,tintColor,tintAlpha} onto a nested
//    `config` data model: dim->config.dim, bright->config.bright,
//    tintColor->config.color, tintAlpha->config.alpha. dim/bright are radii in
//    grid-distance units (ft) in BOTH the legacy and v14 shapes → verbatim.
// Wall `c` and light x/y are ABSOLUTE canvas pixels already (unlike UVTT grid
// units), so coordinates are written verbatim — the scene is (re)created with the
// sidecar's own width/height/grid/padding so that canvas space is reproduced 1:1.

/** v14 CONST.WALL_SENSE_TYPES values — used for sight/sound/light/move channels. */
const V14_WALL_RESTRICTION_VALUES = new Set([0, 10, 20, 30, 40]);
/** Legacy small-int restriction code -> v14 WALL_SENSE_TYPES value. */
const LEGACY_WALL_RESTRICTION_TO_V14: Record<number, number> = {
  1: 20, // NORMAL
  2: 10, // LIMITED
  3: 30, // PROXIMITY
  4: 40, // DISTANCE (reverse proximity)
};

/**
 * Normalize a wall restriction code to the v14 WALL_SENSE_TYPES integer. Accepts
 * either a legacy small int (1=NORMAL, 2=LIMITED, …) or a value already in the v14
 * set (0/10/20/30/40, passed through). Non-positive / non-finite → 0 (NONE);
 * unknown positive → 20 (NORMAL).
 */
export function toV14WallRestriction(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0; // NONE
  if (V14_WALL_RESTRICTION_VALUES.has(n)) return n; // already v14
  return LEGACY_WALL_RESTRICTION_TO_V14[n] ?? 20; // unknown positive → NORMAL
}

interface SidecarWall {
  c?: number[];
  move?: number;
  sense?: number; // legacy
  sight?: number; // v14
  sound?: number;
  light?: number;
  door?: number;
  ds?: number;
  dir?: number;
}

/**
 * Convert one sidecar wall (legacy `{c,move,sense,sound,door}` OR v14
 * `{c,move,sight,sound,light,door}`) to a v14 WallDocument create object.
 * Coordinates are written verbatim (absolute canvas pixels). Returns null when
 * `c` is not a usable 4-number segment.
 */
export function sidecarWallToV14(w: SidecarWall): Record<string, unknown> | null {
  const c = Array.isArray(w?.c) ? w.c.map(Number) : [];
  if (c.length < 4 || c.some(n => !Number.isFinite(n))) return null;

  // Pass the wall WHOLE — preserve every authored field (threshold, animation, flags, …); only the
  // restriction channels + cleaned coords are overlaid below. Drop the legacy `sense` key (folded
  // into sight/light) and any source/cli ids (the create path mints fresh ones without keepId).
  const rest: Record<string, unknown> = { ...(w as Record<string, unknown>) };
  for (const k of ['sense', '_id', '_key', '_stats']) delete rest[k];
  const doc: Record<string, unknown> = { ...rest, c: [c[0], c[1], c[2], c[3]] };

  // sight: explicit v14 `sight` wins, else the legacy `sense` key.
  const sightSrc = w.sight ?? w.sense;
  if (sightSrc !== undefined) doc.sight = toV14WallRestriction(sightSrc);
  // light: explicit `light`, else mirror legacy `sense` (v10 split sense→sight+light).
  if (w.light !== undefined) doc.light = toV14WallRestriction(w.light);
  else if (w.sight === undefined && w.sense !== undefined)
    doc.light = toV14WallRestriction(w.sense);
  if (w.move !== undefined) doc.move = toV14WallRestriction(w.move);
  if (w.sound !== undefined) doc.sound = toV14WallRestriction(w.sound);
  if (w.door !== undefined) doc.door = Number(w.door); // WALL_DOOR_TYPES — same across versions
  if (w.ds !== undefined) doc.ds = Number(w.ds);
  if (w.dir !== undefined) doc.dir = Number(w.dir);
  return doc;
}

/**
 * Count walls that will SILENTLY DEFAULT their sight channel — the signature of a
 * dropped field on import. A wall that declares other restriction channels
 * (`light`/`move`/`sound`) but omits BOTH the v14 `sight` and the legacy `sense`
 * almost certainly lost its sight value in transit: Foundry defaults a wall with
 * no `sight` to NORMAL (vision-blocking), so EVERY such wall blocks line of sight —
 * turning limited/none walls (statues, railings, low tombs, see-through props) into
 * solid silhouettes the players can't see past. We cannot recover the intended
 * value here (the caller never sent it), but we surface the count as a warning so
 * a lossy import is caught instead of shipping a scene where nothing is see-through.
 * (v10/v11 scene + compendium-pack data uses split `sight`/`light`/`move`/`sound`
 * fields, NOT the pre-v10 single `sense` — remap helpers that copy `sense` silently
 * drop sight on this data; that is exactly the case this catches.) Pure/exported for
 * unit testing.
 */
export function countWallsMissingSight(walls: SidecarWall[] | undefined): number {
  if (!Array.isArray(walls)) return 0;
  return walls.filter(w => {
    const c = Array.isArray(w?.c) ? w.c.map(Number) : [];
    const usableSegment = c.length >= 4 && c.slice(0, 4).every(n => Number.isFinite(n));
    const declaresOtherChannel =
      w.light !== undefined || w.move !== undefined || w.sound !== undefined;
    const sightOmitted = w.sight === undefined && w.sense === undefined;
    return usableSegment && declaresOtherChannel && sightOmitted;
  }).length;
}

interface SidecarLight {
  x?: number;
  y?: number;
  dim?: number;
  bright?: number;
  tintColor?: string; // legacy
  tintAlpha?: number; // legacy
  color?: string; // v14
  alpha?: number; // v14
  rotation?: number;
  angle?: number;
  lightAnimation?: Record<string, unknown>; // legacy → config.animation
  darkness?: Record<string, unknown>; // legacy per-light {min,max} → config.darkness
  darknessThreshold?: number; // legacy — no v14 top-level equivalent
  t?: string; // legacy type marker ("l")
  config?: Record<string, unknown>;
}

/**
 * Convert one sidecar light (legacy flat `{x,y,dim,bright,tintColor,tintAlpha,lightAnimation,
 * darkness}` OR v14 `{x,y,config}`) to a v14 AmbientLightDocument create object. x/y are top-level
 * absolute pixels; all emission props nest under `config`. The legacy→v14 nesting is the full set
 * the v8/v9-era flat shape needs: emission radii/tint, the torch/pulse `lightAnimation`, and the
 * per-light `darkness`{min,max} activation range — dropping any of these silently loses the
 * authored mood (flat torch flicker → a dead steady glow). An explicit `config` (v10+) wins.
 */
export function sidecarLightToV14(l: SidecarLight): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (typeof l.dim === 'number') config.dim = l.dim;
  if (typeof l.bright === 'number') config.bright = l.bright;
  const color = l.tintColor ?? l.color;
  if (typeof color === 'string' && color.trim() !== '') config.color = color;
  const alpha = l.tintAlpha ?? l.alpha;
  if (typeof alpha === 'number') config.alpha = alpha;
  if (typeof l.angle === 'number') config.angle = l.angle;
  // Legacy flat animation/darkness → nested config (v10+ moved them under config).
  if (l.lightAnimation && typeof l.lightAnimation === 'object') config.animation = l.lightAnimation;
  if (l.darkness && typeof l.darkness === 'object') config.darkness = l.darkness;
  if (l.config && typeof l.config === 'object') Object.assign(config, l.config); // explicit v10+ wins

  // Pass the light WHOLE — preserve authored top-level fields (walls, vision, hidden, elevation,
  // flags, …). x/y/rotation/config are set explicitly; the flat emission inputs fold into config;
  // legacy-only markers (`t`, `darknessThreshold`) and source/cli ids are dropped.
  const rest: Record<string, unknown> = { ...(l as Record<string, unknown>) };
  for (const k of [
    'dim',
    'bright',
    'tintColor',
    'tintAlpha',
    'color',
    'alpha',
    'angle',
    'rotation',
    'config',
    'lightAnimation',
    'darkness',
    'darknessThreshold',
    't',
    'x',
    'y',
    '_id',
    '_key',
    '_stats',
  ])
    delete rest[k];

  const doc: Record<string, unknown> = {
    ...rest,
    x: Number(l.x ?? 0),
    y: Number(l.y ?? 0),
    config,
  };
  if (typeof l.rotation === 'number') doc.rotation = l.rotation;
  return doc;
}

// --- regions / teleporters (tom-cartos-import M3) ----------------------------
//
// A scene-pack module's scenes carry `regions[]` — the v12+ RegionDocument, whose
// `teleportToken` behaviors point at another region via a UUID string
// `Scene.<sceneId>.Region.<regionId>`. Because the import mints FRESH ids (no
// keepId on either SceneClass.create or createEmbeddedDocuments), BOTH ids in that
// destination change, so every cross-scene teleporter must be rewritten AFTER all
// scenes + regions exist (a teleporter can point at a scene created later in the
// run — the forward-reference problem). We solve this without shuttling 16-char
// ids back through the agent: each created region is stamped with its SOURCE id in
// a provenance flag, and remapSceneTeleporters reconstructs the origId→newId maps
// from world state (scenes already carry the same flag from the M2 import), then
// rewrites every teleport destination. Robust across resumed/partial imports too.

/** Flag scope stamped on imported scenes + regions for provenance / dedup / remap. */
export const TOM_CARTOS_FLAG_SCOPE = 'tom-cartos-import';

/** A teleporter destination UUID: Scene.<sceneId>.Region.<regionId> (ids have no dots). */
const TELEPORT_DEST_RE = /^Scene\.([^.]+)\.Region\.([^.]+)$/;

/**
 * Convert one pack region to a Region create object: pass it WHOLE (shapes,
 * elevation, visibility, behaviors — same "don't cherry-pick" rule as walls/lights),
 * strip the source/cli ids (`_id`/`_key`/`_stats` — the create path mints fresh ids),
 * and stamp the source `_id` into `flags[TOM_CARTOS_FLAG_SCOPE].sourceId` so the
 * teleporter remap can later map this region's old id → its new id. Pure/exported
 * for unit testing. Returns null only for a non-object input.
 */
export function sidecarRegionToV14(r: Record<string, unknown>): Record<string, unknown> | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const sourceId = typeof r._id === 'string' ? r._id : undefined;
  const rest: Record<string, unknown> = { ...r };
  for (const k of ['_id', '_key', '_stats']) delete rest[k];
  if (sourceId) {
    const flags: Record<string, any> =
      rest.flags && typeof rest.flags === 'object' ? { ...(rest.flags as object) } : {};
    flags[TOM_CARTOS_FLAG_SCOPE] = { ...(flags[TOM_CARTOS_FLAG_SCOPE] ?? {}), sourceId };
    rest.flags = flags;
  }
  return rest;
}

export type RemapStatus = 'rewritten' | 'unchanged' | 'no-match' | 'unresolved';

/**
 * Compute the rewritten teleporter destination for one behavior's `system.destination`.
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
  if (!newScene || !newRegion) return { status: 'unresolved', reason: dest };
  const newDest = `Scene.${newScene}.Region.${newRegion}`;
  return newDest === dest ? { status: 'unchanged', dest } : { status: 'rewritten', dest: newDest };
}

/**
 * Map a token's disposition to a number. Foundry stores it as a number already;
 * anything else falls back to neutral (0). The Node tool maps the number to a
 * name (-1 hostile / 0 neutral / 1 friendly).
 */
function tokenDisposition(disposition: unknown): number {
  if (typeof disposition === 'number') {
    return disposition;
  }
  return 0; // neutral
}

// --- reads -------------------------------------------------------------------

/**
 * Information about the currently active scene, including tokens, notes and
 * element counts. Mirrors the old data-access.getActiveScene shape.
 * Throws if there is no active scene.
 */
export function getActiveScene(): unknown {
  const scene = game.scenes?.current;
  if (!scene) {
    throw new Error('Scene not found');
  }

  return {
    id: scene.id,
    name: scene.name,
    img: scene.img || undefined,
    background: readSceneBackground(scene),
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    active: scene.active,
    navigation: scene.navigation,
    tokens: scene.tokens.map((token: any) => ({
      id: token.id,
      name: token.name,
      x: token.x,
      y: token.y,
      width: token.width,
      height: token.height,
      actorId: token.actorId || undefined,
      img: token.texture?.src || '',
      hidden: token.hidden,
      disposition: tokenDisposition(token.disposition),
    })),
    walls: scene.walls.size,
    lights: scene.lights.size,
    sounds: scene.sounds.size,
    notes: scene.notes.map((note: any) => ({
      id: note.id,
      text: note.text || '',
      x: note.x,
      y: note.y,
    })),
  };
}

/**
 * List scenes in the world, optionally filtered by name substring or to active
 * scenes only. Each entry carries id, name, active flag, dimensions, grid size,
 * background and element counts. Mirrors the old data-access.listScenes shape.
 */
export function listScenes(args?: { filter?: string; includeActiveOnly?: boolean }): unknown {
  let scenes: any[] = game.scenes?.contents || [];

  if (args?.includeActiveOnly) {
    scenes = scenes.filter((scene: any) => scene.active);
  }

  if (args?.filter) {
    const filterLower = args.filter.toLowerCase();
    scenes = scenes.filter((scene: any) => scene.name.toLowerCase().includes(filterLower));
  }

  return scenes.map((scene: any) => ({
    id: scene.id,
    name: scene.name,
    active: scene.active,
    dimensions: {
      width: scene.dimensions?.width || scene.width || 0,
      height: scene.dimensions?.height || scene.height || 0,
    },
    gridSize: scene.grid?.size || 100,
    background: readSceneBackground(scene) || '',
    walls: scene.walls?.size || 0,
    tokens: scene.tokens?.size || 0,
    lighting: scene.lights?.size || 0,
    sounds: scene.sounds?.size || 0,
    navigation: scene.navigation || false,
  }));
}

/**
 * Live padded-canvas geometry for one scene (by id or exact name). Foundry insets the
 * background inside a padding border, so a placeable's canvas pixel is NOT just
 * `gridCell * size` — it is offset by `sceneX`/`sceneY` (the background's top-left
 * within the padded canvas). The legend→pins pipeline needs this to convert a room's
 * grid cell to a Note's x/y. `scene.dimensions` computes from the document (no active
 * canvas required). Returns `found:false` when the scene doesn't resolve.
 */
export function getSceneDimensions(args: { sceneIdentifier: string }): unknown {
  if (!args?.sceneIdentifier) throw new Error('sceneIdentifier is required');
  const scene = resolveSceneStrict(args.sceneIdentifier);
  if (!scene) return { found: false, notFound: args.sceneIdentifier };
  const d: any = scene.dimensions ?? {};
  return {
    found: true,
    sceneId: scene.id,
    sceneName: scene.name,
    // total padded canvas
    width: d.width ?? scene.width,
    height: d.height ?? scene.height,
    // background rect within the padded canvas (the padding offset lives here)
    sceneX: d.sceneX,
    sceneY: d.sceneY,
    sceneWidth: d.sceneWidth ?? scene.width,
    sceneHeight: d.sceneHeight ?? scene.height,
    // grid
    size: d.size ?? scene.grid?.size,
    distance: d.distance ?? scene.grid?.distance,
    rows: d.rows,
    columns: d.columns,
    padding: scene.padding,
  };
}

// --- writes ------------------------------------------------------------------

/** Shape of the optional cross-cutting scene fields shared by create + update. */
interface SceneFieldArgs {
  gridDistance?: number;
  gridUnits?: string;
  gridColor?: string;
  gridAlpha?: number;
  tokenVision?: boolean;
  fogMode?: string;
  darkness?: number;
  globalLight?: boolean;
  weather?: string;
  playlist?: string;
  journal?: string;
  thumb?: string;
}

/**
 * Create a new Scene from a name + background image path. The renderable
 * background lives on the scene's initial level in v14 (levels[].background.src),
 * so we create the document then set the background there. When width/height are
 * omitted, the background image's natural pixel size is probed page-side and used
 * (the single biggest QOL win — no dimension math in the caller). Applies the
 * shared scene fields (grid scale, vision, fog, lighting, weather, links),
 * optionally imports walls/lights from a map sidecar, and optionally activates
 * the new scene.
 */
export async function createScene(
  args: {
    name: string;
    backgroundPath: string;
    width?: number;
    height?: number;
    gridSize?: number;
    gridType?: number;
    padding?: number;
    activate?: boolean;
    walls?: SidecarWall[];
    lights?: SidecarLight[];
    regions?: Record<string, unknown>[];
    flags?: Record<string, unknown>;
    environment?: Record<string, unknown>;
    fog?: Record<string, unknown>;
    initial?: Record<string, unknown>;
  } & SceneFieldArgs
): Promise<unknown> {
  if (!args.name || !args.backgroundPath) {
    throw new Error('name and backgroundPath are both required');
  }

  try {
    const src = normalizeAssetPath(args.backgroundPath);
    const sceneData: any = {
      name: args.name,
      grid: {
        size: typeof args.gridSize === 'number' ? args.gridSize : 100,
        type: typeof args.gridType === 'number' ? args.gridType : (CONST_?.GRID_TYPES?.SQUARE ?? 1),
      },
    };
    if (typeof args.padding === 'number') sceneData.padding = args.padding;

    // Auto-size from the image when either dimension is missing.
    let autoSized = false;
    let width = args.width;
    let height = args.height;
    if (width === undefined || height === undefined) {
      const dim = await probeImageSize(src);
      if (dim && dim.width > 0 && dim.height > 0) {
        if (width === undefined) width = dim.width;
        if (height === undefined) height = dim.height;
        autoSized = true;
      }
    }
    if (typeof width === 'number') sceneData.width = width;
    if (typeof height === 'number') sceneData.height = height;

    // Fold in the shared fields (grid scale / vision / fog / lighting / weather / links).
    const flat = buildSceneFields(args);
    if (Object.keys(flat).length > 0 && foundryUtils?.expandObject && foundryUtils?.mergeObject) {
      foundryUtils.mergeObject(sceneData, foundryUtils.expandObject(flat));
    }

    // Modern-pack mood objects (environment/fog) + saved camera (initial), merged WHOLE (deep) so a
    // v12+ scene's full authored mood round-trips, layering over any flat scalar knobs set above.
    for (const key of ['environment', 'fog', 'initial'] as const) {
      const v = args[key];
      if (v && typeof v === 'object') {
        if (foundryUtils?.mergeObject) foundryUtils.mergeObject(sceneData, { [key]: v });
        else sceneData[key] = { ...(sceneData[key] ?? {}), ...v };
      }
    }

    // Provenance/dedup flags, namespaced by scope (e.g. {"tom-cartos-import":{sourceModule,sourceId}}).
    if (args.flags && typeof args.flags === 'object') {
      sceneData.flags = { ...(sceneData.flags ?? {}), ...args.flags };
    }

    const scene = await SceneClass.create(sceneData);
    // v14: the renderable background lives on the scene's initial level — set it there.
    await applySceneBackground(scene, src);

    // Import walls/lights/regions from a map sidecar or pack payload, if supplied.
    // These are embedded documents, so the scene must already exist. Best-effort +
    // per-kind isolated: a failure to place one kind never voids the scene or the others.
    const placeables = await importScenePlaceables(scene, args.walls, args.lights, args.regions);

    if (args.activate && scene) await scene.activate();

    return {
      success: true,
      sceneId: scene?.id,
      sceneName: scene?.name,
      active: scene?.active ?? false,
      background: readSceneBackground(scene),
      width: scene?.width,
      height: scene?.height,
      autoSized,
      settings: summarizeSceneSettings(scene),
      ...placeables,
    };
  } catch (error) {
    throw new Error(
      `Failed to create scene: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Update an existing Scene's document fields. Folds in the background swap plus
 * the common scene-document properties: name, navigation label/flag, dimensions,
 * grid (size/type/distance/units), token vision, fog mode, lighting (darkness /
 * global light), weather, and playlist/journal links. STRICT resolution
 * (resolveSceneStrict) — no fuzzy matching. Scene-document only; never touches
 * placeables (walls/lights/tokens) or activates the scene.
 */
export async function updateScene(
  args: {
    sceneIdentifier: string;
    name?: string;
    navName?: string;
    navigation?: boolean;
    backgroundPath?: string;
    width?: number;
    height?: number;
    gridSize?: number;
    gridType?: number;
    padding?: number;
  } & SceneFieldArgs
): Promise<unknown> {
  if (!args?.sceneIdentifier) {
    throw new Error('sceneIdentifier is required');
  }

  const scene = resolveSceneStrict(args.sceneIdentifier);
  if (!scene) {
    return { success: true, updated: false, notFound: args.sceneIdentifier };
  }

  const update: any = {};
  if (typeof args.name === 'string' && args.name.trim().length > 0) update.name = args.name.trim();
  if (typeof args.navName === 'string') update.navName = args.navName;
  if (typeof args.navigation === 'boolean') update.navigation = args.navigation;
  if (typeof args.width === 'number') update.width = args.width;
  if (typeof args.height === 'number') update.height = args.height;
  if (typeof args.padding === 'number') update.padding = args.padding;
  if (typeof args.gridSize === 'number') update['grid.size'] = args.gridSize;
  if (typeof args.gridType === 'number') update['grid.type'] = args.gridType;

  // Shared fields (dot-paths apply directly to scene.update()).
  Object.assign(update, buildSceneFields(args));

  const hasDocUpdate = Object.keys(update).length > 0;
  const hasBackground =
    typeof args.backgroundPath === 'string' && args.backgroundPath.trim().length > 0;

  if (!hasDocUpdate && !hasBackground) {
    throw new Error(
      'Provide at least one field to update (name, navName, navigation, backgroundPath, width, ' +
        'height, gridSize, gridType, gridDistance, gridUnits, padding, tokenVision, fogMode, ' +
        'darkness, globalLight, weather, playlist, journal)'
    );
  }

  try {
    if (hasDocUpdate) await scene.update(update);
    if (hasBackground) {
      await applySceneBackground(scene, normalizeAssetPath(args.backgroundPath!));
    }

    return {
      success: true,
      updated: true,
      sceneId: scene.id,
      sceneName: scene.name,
      background: readSceneBackground(scene),
      settings: summarizeSceneSettings(scene),
    };
  } catch (error) {
    throw new Error(
      `Failed to update scene: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Permanently delete one or more Scene documents by exact id or exact name.
 * STRICT resolution (resolveSceneStrict) — no fuzzy matching. Deleting the
 * active scene is allowed; Foundry handles deactivation. Mirrors the old
 * data-access.deleteScenes shape.
 */
export async function deleteScenes(args: { identifiers: string[] }): Promise<{
  success: boolean;
  deletedCount: number;
  deleted: Array<{ id: string; name: string }>;
  notFound?: string[];
}> {
  if (!Array.isArray(args?.identifiers) || args.identifiers.length === 0) {
    throw new Error('identifiers array is required and must contain at least one entry');
  }

  try {
    const deleted: Array<{ id: string; name: string }> = [];
    const notFound: string[] = [];

    for (const identifier of args.identifiers) {
      const scene = resolveSceneStrict(identifier);
      if (scene) {
        const info = { id: scene.id ?? identifier, name: scene.name ?? '' };
        await scene.delete();
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
    throw new Error(
      `Failed to delete scene(s): ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

interface SceneNoteInput {
  journal: string; // JournalEntry id or exact name (strict)
  page?: string; // page id or exact name within that entry (strict)
  x: number;
  y: number;
  label?: string; // override text shown on the pin
  icon?: string; // Data-relative icon src (→ v14 texture.src); omit for Foundry's default pin
  iconSize?: number; // displayed icon size in px (Foundry min 32)
  global?: boolean; // render through fog/vision occlusion (NOT a permission control)
}

/**
 * Create map-note pins on a scene, each linked to a JournalEntry (and optionally a
 * specific page) — the deterministic half of the legend→pins feature. Journal/page
 * names resolve STRICT (id → exact name; ambiguity throws). Per-note error isolation
 * mirrors importScenePlaceables: a bad note (e.g. an unresolved journal) is recorded
 * and skipped, never voiding the rest. GM-only secrecy is a property of the linked
 * journal's ownership (default 0), NOT of the note — `global` only controls fog
 * occlusion. Coordinates are absolute canvas pixels (use getSceneDimensions for the
 * padding-aware cell→px math).
 */
export async function createSceneNotes(args: {
  sceneIdentifier: string;
  notes: SceneNoteInput[];
}): Promise<{
  success: boolean;
  sceneId?: string;
  sceneName?: string;
  notFound?: string;
  created: number;
  errors?: string[];
}> {
  if (!args?.sceneIdentifier) throw new Error('sceneIdentifier is required');
  if (!Array.isArray(args.notes) || args.notes.length === 0) {
    throw new Error('notes array is required and must contain at least one entry');
  }
  const scene = resolveSceneStrict(args.sceneIdentifier);
  if (!scene) return { success: true, created: 0, notFound: args.sceneIdentifier };

  const data: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (let i = 0; i < args.notes.length; i++) {
    const n = args.notes[i];
    try {
      const { entryId, pageId } = resolveNoteTarget(n.journal, n.page);
      const doc: Record<string, unknown> = { entryId, x: Number(n.x), y: Number(n.y) };
      if (pageId) doc.pageId = pageId;
      if (typeof n.label === 'string' && n.label.trim() !== '') doc.text = n.label;
      if (typeof n.iconSize === 'number') doc.iconSize = n.iconSize;
      if (typeof n.global === 'boolean') doc.global = n.global;
      if (typeof n.icon === 'string' && n.icon.trim() !== '')
        doc.texture = { src: normalizeAssetPath(n.icon) };
      data.push(doc);
    } catch (e) {
      errors.push(`note ${i} (${n.journal}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let created = 0;
  if (data.length > 0) {
    try {
      const made = await scene.createEmbeddedDocuments('Note', data);
      created = made?.length ?? 0;
    } catch (e) {
      errors.push(`notes: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    success: true,
    sceneId: scene.id,
    sceneName: scene.name,
    created,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// --- local helpers (page-coupled) --------------------------------------------

/**
 * Resolve a Note's journal target: a JournalEntry by id|exact-name (strict, ambiguity
 * throws) and, optionally, a page within it by id|exact-name. Throws on no match.
 */
function resolveNoteTarget(journal: string, page?: string): { entryId: string; pageId?: string } {
  const coll: any = game.journal;
  const entry =
    coll?.get?.(journal) ??
    (() => {
      const m = Array.from(coll ?? []).filter((d: any) => d?.name === journal);
      if (m.length > 1)
        throw new Error(`Ambiguous journal name "${journal}" (${m.length}). Pass the id.`);
      return m[0];
    })();
  if (!entry) throw new Error(`No journal found matching "${journal}" (by id or exact name).`);

  let pageId: string | undefined;
  if (typeof page === 'string' && page.trim() !== '') {
    const pages: any = entry.pages;
    const p =
      pages?.get?.(page) ??
      (() => {
        const m = Array.from(pages ?? []).filter((x: any) => x?.name === page);
        if (m.length > 1)
          throw new Error(`Ambiguous page name "${page}" in "${entry.name}" (${m.length}).`);
        return m[0];
      })();
    if (!p) throw new Error(`No page "${page}" in journal "${entry.name}".`);
    pageId = p.id;
  }
  // Omit pageId entirely when absent (exactOptionalPropertyTypes — no explicit undefined).
  return pageId ? { entryId: entry.id, pageId } : { entryId: entry.id };
}

/**
 * Build the flat dot-path map of the shared scene fields, doing the page-side
 * validation/resolution that zod can't: weather is normalized against the live
 * CONFIG.weatherEffects keys, and playlist/journal names are resolved to ids
 * (strict, ambiguity-erroring). create() expands this; update() applies it as-is.
 */
function buildSceneFields(args: SceneFieldArgs): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  if (typeof args.gridDistance === 'number') flat['grid.distance'] = args.gridDistance;
  if (typeof args.gridUnits === 'string') flat['grid.units'] = args.gridUnits;
  if (typeof args.gridColor === 'string') flat['grid.color'] = args.gridColor;
  if (typeof args.gridAlpha === 'number') flat['grid.alpha'] = args.gridAlpha;
  if (typeof args.tokenVision === 'boolean') flat.tokenVision = args.tokenVision;
  if (typeof args.fogMode === 'string') flat['fog.mode'] = fogModeToNumber(args.fogMode);
  if (typeof args.darkness === 'number') {
    flat['environment.darknessLevel'] = Math.max(0, Math.min(1, args.darkness));
  }
  if (typeof args.globalLight === 'boolean')
    flat['environment.globalLight.enabled'] = args.globalLight;
  if (typeof args.weather === 'string') flat.weather = validateWeather(args.weather);
  if (typeof args.playlist === 'string')
    flat.playlist = resolveSceneLink('playlist', args.playlist);
  if (typeof args.journal === 'string') flat.journal = resolveSceneLink('journal', args.journal);
  if (typeof args.thumb === 'string' && args.thumb.trim().length > 0)
    flat.thumb = normalizeAssetPath(args.thumb);
  return flat;
}

/** Normalize a weather key against the live CONFIG.weatherEffects registry. */
function validateWeather(key: string): string {
  const keys = Object.keys((globalThis as any).CONFIG?.weatherEffects ?? {});
  return normalizeWeatherKey(key, keys);
}

/**
 * Resolve a Playlist/JournalEntry reference (id OR exact name) to its id. Empty
 * string clears the link (returns null). Throws on no match or on an ambiguous
 * name (multiple docs share it) — never guesses.
 */
function resolveSceneLink(kind: 'playlist' | 'journal', idOrName: string): string | null {
  const trimmed = idOrName.trim();
  if (trimmed === '') return null; // clear the link
  const coll: any = kind === 'playlist' ? game.playlists : game.journal;
  const byId = coll?.get?.(trimmed);
  if (byId) return byId.id;
  const matches = Array.from(coll ?? []).filter((d: any) => d?.name === trimmed);
  if (matches.length === 1) return (matches[0] as any).id;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ${kind} name "${trimmed}" (${matches.length} matches). Pass the id instead.`
    );
  }
  throw new Error(`No ${kind} found matching "${trimmed}" (by id or exact name).`);
}

/** Resolve a scene by exact id, then exact name; null when neither matches. */
function resolveSceneStrict(identifier: string): any {
  return (
    game.scenes?.get(identifier) || game.scenes?.find((s: any) => s.name === identifier) || null
  );
}

/**
 * Probe an image's natural pixel size from inside the authenticated Foundry page
 * (no separate WebDAV fetch / auth dance — the page can already load any
 * Data-relative asset). Resolves null on any failure (caller falls back to
 * Foundry's default dimensions). Images only; a video background won't report a
 * naturalWidth and yields null.
 */
async function probeImageSize(
  normalizedSrc: string
): Promise<{ width: number; height: number } | null> {
  try {
    const url = new URL(normalizedSrc, (globalThis as any).location?.origin).href;
    return await new Promise(resolve => {
      const img = new (globalThis as any).Image();
      img.onload = () => resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
      img.onerror = () => resolve(null);
      img.src = url;
    });
  } catch {
    return null;
  }
}

/**
 * Create Wall / AmbientLight embedded documents on a freshly-created scene from
 * the sidecar arrays. Each placeable kind is converted to the v14 shape and
 * created in one batch with per-kind error isolation, so a bad lights array
 * can't lose the walls (or the scene). Returns counts + any per-kind errors;
 * returns nothing extra when no sidecar arrays were supplied.
 */
async function importScenePlaceables(
  scene: any,
  walls?: SidecarWall[],
  lights?: SidecarLight[],
  regions?: Record<string, unknown>[]
): Promise<{
  wallsCreated?: number;
  lightsCreated?: number;
  regionsCreated?: number;
  regionIdMap?: Record<string, string>;
  placeableErrors?: string[];
}> {
  if (!scene) return {};
  const hasWalls = Array.isArray(walls) && walls.length > 0;
  const hasLights = Array.isArray(lights) && lights.length > 0;
  const hasRegions = Array.isArray(regions) && regions.length > 0;
  if (!hasWalls && !hasLights && !hasRegions) return {};

  const out: {
    wallsCreated?: number;
    lightsCreated?: number;
    regionsCreated?: number;
    regionIdMap?: Record<string, string>;
    placeableErrors?: string[];
  } = {};
  const errors: string[] = [];

  if (hasWalls) {
    try {
      const data = (walls as SidecarWall[])
        .map(sidecarWallToV14)
        .filter((w): w is Record<string, unknown> => w !== null);
      const skipped = (walls as SidecarWall[]).length - data.length;
      if (skipped > 0) errors.push(`${skipped} wall(s) skipped (missing/invalid coordinates)`);
      const defaultedSight = countWallsMissingSight(walls as SidecarWall[]);
      if (defaultedSight > 0)
        errors.push(
          `${defaultedSight} wall(s) declared light/move/sound but no sight — sight DEFAULTED to ` +
            `NORMAL (vision-blocking). Importing v10+ scene/.db data? pass each wall's \`sight\` ` +
            `(0=none, 10=limited, 20=normal); dropping it makes every wall block line-of-sight, so ` +
            `statues/railings/props stop being see-through.`
        );
      if (data.length > 0) {
        const created = await scene.createEmbeddedDocuments('Wall', data);
        out.wallsCreated = created?.length ?? 0;
      } else {
        out.wallsCreated = 0;
      }
    } catch (e) {
      out.wallsCreated = 0;
      errors.push(`walls: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (hasLights) {
    try {
      const data = (lights as SidecarLight[]).map(sidecarLightToV14);
      const created = await scene.createEmbeddedDocuments('AmbientLight', data);
      out.lightsCreated = created?.length ?? 0;
    } catch (e) {
      out.lightsCreated = 0;
      errors.push(`lights: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (hasRegions) {
    try {
      // Keep source-id ↔ create-doc alignment through the (rare) null filter so the
      // origRegionId → newRegionId zip below is correct even if a region drops out.
      const prepared = (regions as Record<string, unknown>[])
        .map(r => ({
          sourceId: typeof r?._id === 'string' ? (r._id as string) : undefined,
          doc: sidecarRegionToV14(r),
        }))
        .filter(
          (p): p is { sourceId: string | undefined; doc: Record<string, unknown> } => p.doc !== null
        );
      const created =
        (await scene.createEmbeddedDocuments(
          'Region',
          prepared.map(p => p.doc)
        )) ?? [];
      out.regionsCreated = created.length;
      const map: Record<string, string> = {};
      for (let i = 0; i < created.length; i++) {
        const sid = prepared[i]?.sourceId;
        if (sid && created[i]?.id) map[sid] = created[i].id;
      }
      if (Object.keys(map).length > 0) out.regionIdMap = map;
    } catch (e) {
      out.regionsCreated = 0;
      errors.push(`regions: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (errors.length > 0) out.placeableErrors = errors;
  return out;
}

/**
 * Rewrite cross-scene teleporter destinations after a scene-pack import (M3 pass 2).
 * The import creates scenes + regions with FRESH ids, so each `teleportToken`
 * behavior's `system.destination` (Scene.<old>.Region.<old>) is stale. This pass
 * reconstructs origId→newId maps from the provenance flags both carry
 * (flags[TOM_CARTOS_FLAG_SCOPE].{sourceModule,sourceId}), then updates every
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
  const flagOf = (doc: any, key: string): string | undefined => {
    const v = doc?.flags?.[scope]?.[key] ?? doc?.getFlag?.(scope, key);
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

  // Pass 2 — rewrite + persist each teleport destination.
  let rewritten = 0;
  let unchanged = 0;
  const unresolved: string[] = [];
  let behaviorsScanned = 0;
  for (const s of scenes) {
    for (const region of s.regions ?? []) {
      const updates: Array<Record<string, unknown>> = [];
      for (const behavior of region.behaviors ?? []) {
        behaviorsScanned++;
        const res = remapTeleportDestination(
          behavior?.system?.destination,
          sceneIdMap,
          regionIdMap
        );
        if (res.status === 'rewritten')
          updates.push({ _id: behavior.id, 'system.destination': res.dest });
        else if (res.status === 'unchanged') unchanged++;
        else if (res.status === 'unresolved') unresolved.push(`${s.name}: ${res.reason}`);
      }
      if (updates.length > 0) {
        await region.updateEmbeddedDocuments('RegionBehavior', updates);
        rewritten += updates.length;
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

/**
 * Set a scene's renderable background. v14 stores it on the initial level
 * (levels[].background.src); fall back to the legacy top-level background.src
 * for Foundry < 14. Mirrors the old data-access.applySceneBackground.
 */
async function applySceneBackground(scene: any, src: string): Promise<void> {
  const o = scene.toObject();
  const levels: any[] = Array.isArray(o.levels) ? o.levels : [];
  if (levels.length) {
    let idx = levels.findIndex((l: any) => l._id === o.initialLevel);
    if (idx < 0) idx = 0;
    if (levels[idx]?.background) {
      levels[idx].background.src = src;
      await scene.update({ levels });
      return;
    }
  }
  await scene.update({ 'background.src': src }); // Foundry < 14
}

/** Read a scene's renderable background `src` (v14 level first, then legacy top-level). */
function readSceneBackground(scene: any): string | undefined {
  const o: any = scene._source || scene.toObject?.() || {};
  const levels: any[] = Array.isArray(o.levels) ? o.levels : [];
  if (levels.length) {
    const lvl = levels.find((l: any) => l._id === o.initialLevel) || levels[0];
    if (lvl?.background?.src) return lvl.background.src;
  }
  return o.background?.src || undefined;
}

/**
 * Compact, output-friendly snapshot of the scene's settable fields so the Node
 * tool can report what's in effect after a create/update. Reads from toObject()
 * so nested data models flatten cleanly.
 */
function summarizeSceneSettings(scene: any): Record<string, unknown> {
  const o: any = scene?.toObject?.() ?? scene?._source ?? {};
  const grid = o.grid ?? {};
  return {
    grid: { size: grid.size, type: grid.type, distance: grid.distance, units: grid.units },
    tokenVision: o.tokenVision,
    fogMode: fogModeToName(o.fog?.mode),
    darkness: o.environment?.darknessLevel,
    globalLight: o.environment?.globalLight?.enabled,
    weather: o.weather ?? '',
    playlist: o.playlist ?? null,
    journal: o.journal ?? null,
  };
}
