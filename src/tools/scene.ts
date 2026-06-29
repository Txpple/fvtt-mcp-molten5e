import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { formatDeletionResult } from '../utils/format.js';
import { toInputSchema } from '../utils/schema.js';

export interface SceneToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

// Single source of truth for each tool's input contract: the handler parses with these
// schemas and getToolDefinitions() advertises toInputSchema(...) of the same schema.
const GetCurrentSceneSchema = z.object({
  includeTokens: z
    .boolean()
    .default(true)
    .describe('Whether to include detailed token information (default: true)'),
  includeHidden: z
    .boolean()
    .default(false)
    .describe('Whether to include hidden tokens and elements (default: false)'),
});

const GetWorldInfoSchema = z.object({});

// --- Scene authoring (create/list/update/delete) ----------------------------------------------
// Moved here from the old AssetBridgeTools so all scene tools live in one domain class (mirrors the
// page-side scenes.ts). Paths are Data-relative (what upload-asset returns); the page side validates
// `weather` against the live CONFIG.weatherEffects and resolves playlist/journal name→id.

// Cross-cutting scene fields shared by create-scene and update-scene (one source of truth).
const sceneCommonFields = {
  gridDistance: z
    .number()
    .positive()
    .optional()
    .describe('Real-world distance per grid cell (dnd5e default 5).'),
  gridUnits: z
    .string()
    .optional()
    .describe('Distance unit label per cell, e.g. "ft" (dnd5e default).'),
  gridColor: z.string().optional().describe('Grid line color as a hex string, e.g. "#000000".'),
  gridAlpha: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Grid line opacity 0–1 (e.g. 0.2 for a faint grid).'),
  tokenVision: z
    .boolean()
    .optional()
    .describe(
      'Require token line-of-sight to see the scene. Turn OFF for overland/illustration maps.'
    ),
  fogMode: z
    .enum(['disabled', 'individual', 'shared'])
    .optional()
    .describe('Fog of war: disabled | individual (classic per-player) | shared (party-wide).'),
  darkness: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Darkness/day-night level: 0 = full daylight, 1 = full night.'),
  globalLight: z
    .boolean()
    .optional()
    .describe('Globally illuminate the whole scene (turn the lights on).'),
  weather: z
    .string()
    .optional()
    .describe('Weather effect key (e.g. rain, snow, fog, leaves, rainStorm, blizzard). "" = none.'),
  playlist: z
    .string()
    .optional()
    .describe('Playlist id or exact name to auto-play on scene activation. "" clears it.'),
  journal: z
    .string()
    .optional()
    .describe('JournalEntry id or exact name to attach as scene notes. "" clears it.'),
  thumb: z
    .string()
    .optional()
    .describe(
      'Data-relative path to a pre-rendered navigation thumbnail (e.g. an uploaded ' +
        '<id>-thumb.webp shipped by a map pack). Foundry may regenerate it on a later in-app edit, ' +
        'so treat it as a nice-to-have, not load-bearing.'
    ),
};

// A wall placeable from a map sidecar JSON. Accepts the LEGACY Foundry shape OR the v14 shape; the
// page side normalizes either to the v14 WallDocument. `c` is [x0,y0,x1,y1] in ABSOLUTE canvas pixels.
const SidecarWallSchema = z
  .object({
    c: z.array(z.number()).length(4).describe('Endpoint coords [x0,y0,x1,y1] in canvas pixels.'),
    move: z.number().optional().describe('Movement restriction (legacy 1 or v14 20).'),
    sense: z.number().optional().describe('Legacy sight restriction (→ v14 sight+light).'),
    sight: z.number().optional().describe('v14 sight restriction.'),
    sound: z.number().optional().describe('Sound restriction.'),
    light: z.number().optional().describe('v14 light restriction.'),
    door: z.number().optional().describe('Door type (0 none, 1 door, 2 secret).'),
    ds: z.number().optional().describe('Door state (0 closed, 1 open, 2 locked).'),
    dir: z.number().optional().describe('Wall direction (0 both, 1 left, 2 right).'),
  })
  .passthrough();

// An ambient-light placeable from a map sidecar JSON. Accepts the LEGACY flat shape OR the v14
// shape (`config{}`); the page side nests emission props under `config`. x/y are absolute canvas pixels.
const SidecarLightSchema = z
  .object({
    x: z.number().describe('Light center X in canvas pixels.'),
    y: z.number().describe('Light center Y in canvas pixels.'),
    dim: z.number().optional().describe('Dim radius in grid-distance units (e.g. ft).'),
    bright: z.number().optional().describe('Bright radius in grid-distance units (e.g. ft).'),
    tintColor: z.string().optional().describe('Legacy tint color hex (→ config.color).'),
    tintAlpha: z.number().optional().describe('Legacy tint opacity 0–1 (→ config.alpha).'),
    color: z.string().optional().describe('v14 tint color hex.'),
    alpha: z.number().optional().describe('v14 tint opacity 0–1.'),
    rotation: z.number().optional().describe('Light rotation in degrees.'),
    angle: z.number().optional().describe('Emission cone angle in degrees (360 = full).'),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "A v10+ light's full `config` object, carried VERBATIM (merged over the flat fields): " +
          'luminosity, attenuation, coloration, saturation, contrast, shadows, ' +
          'animation {type,speed,intensity}, darkness {min,max}, plus dim/bright/color/alpha/angle. ' +
          'PREFER passing this whole — flattening to just dim/bright/color/alpha lets Foundry default ' +
          'the rest BRIGHTER/harsher (luminosity 0.5, attenuation 0.5, no flicker), which blows out and ' +
          'over-saturates a torch-lit scene.'
      ),
  })
  .passthrough();

// A region placeable (v12+ RegionDocument) from a scene-pack payload, carried WHOLE (typed minimal
// + .passthrough(), NOT z.any() — keeps the generated JSON schema useful). The page side strips the
// source/cli ids, stamps the source `_id` as a provenance flag, and creates it; cross-scene
// teleporter destinations are rewritten afterward by remap-teleporters (the ids are minted fresh).
const RegionSidecarSchema = z
  .object({
    name: z.string().optional().describe('Region label.'),
    color: z.string().optional().describe('Region tint hex.'),
    shapes: z
      .array(z.object({ type: z.string().optional() }).passthrough())
      .optional()
      .describe('Region shape definitions (polygon/rectangle/ellipse), carried whole.'),
    elevation: z
      .object({
        bottom: z.number().nullable().optional(),
        top: z.number().nullable().optional(),
      })
      .passthrough()
      .optional()
      .describe('Region elevation band {bottom,top}.'),
    visibility: z.number().optional().describe('Region visibility mode.'),
    behaviors: z
      .array(
        z
          .object({
            type: z.string().optional(),
            system: z.object({}).passthrough().optional(),
          })
          .passthrough()
      )
      .optional()
      .describe(
        'Region behaviors carried whole — incl. teleportToken whose system.destination ' +
          '(Scene.<id>.Region.<id>) is rewritten post-import by remap-teleporters.'
      ),
    _id: z
      .string()
      .optional()
      .describe('Source region id (stamped as a provenance flag for remap).'),
  })
  .passthrough();

// Modern-pack scene MOOD objects, carried mostly-whole (typed minimal + .passthrough()) so a v12+
// scene's full environment/fog and saved camera round-trip — not just the scalar knobs in
// sceneCommonFields. Minimal typing (not z.any()) keeps the generated JSON schema useful.
const SceneEnvironmentSchema = z
  .object({
    darknessLevel: z.number().min(0).max(1).optional(),
    globalLight: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
    cycle: z.boolean().optional(),
  })
  .passthrough();
const SceneFogSchema = z
  .object({
    exploration: z.boolean().optional(),
    overlay: z.string().nullable().optional(),
  })
  .passthrough();
const SceneInitialSchema = z
  .object({
    x: z.number().optional(),
    y: z.number().optional(),
    scale: z.number().optional(),
  })
  .passthrough();

const CreateSceneSchema = z.object({
  name: z.string().min(1).describe('Scene name.'),
  backgroundPath: z.string().min(1).describe('Data-relative path to the background/map image.'),
  walls: z
    .array(SidecarWallSchema)
    .optional()
    .describe(
      'Walls to import from a map sidecar JSON (the `walls` array of a Foundry scene-export ' +
        'sidecar that ships next to a map). Created after the scene exists; coordinates are ' +
        'absolute canvas pixels, so pass the sidecar width/height/gridSize/padding too.'
    ),
  lights: z
    .array(SidecarLightSchema)
    .optional()
    .describe('Ambient lights to import from a map sidecar JSON (the `lights` array).'),
  regions: z
    .array(RegionSidecarSchema)
    .optional()
    .describe(
      'Regions (v12+ RegionDocument incl. teleporters) to import from a scene-pack payload. Created ' +
        'after the scene exists; each is stamped with its source id, and cross-scene teleporter ' +
        'destinations are rewritten afterward by a single remap-teleporters call.'
    ),
  placeablesPath: z
    .string()
    .optional()
    .describe(
      'Server-local path to a JSON file of {walls,lights,regions} to place (as written by read-pack ' +
        'for a scene-pack import). Read SERVER-SIDE and merged with any inline placeables — this routes ' +
        "a pack's hundreds of walls/lights/regions tool→tool without passing them through the agent (the " +
        'MCP response cap makes inline placeables infeasible at scene scale).'
    ),
  width: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Scene width in pixels (optional — auto-detected from the image when omitted).'),
  height: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Scene height in pixels (optional — auto-detected from the image when omitted).'),
  gridSize: z.number().int().positive().optional().describe('Grid size in pixels (default 100).'),
  gridType: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Foundry grid type (0 gridless, 1 square, 2+ hex). Default 1.'),
  padding: z.number().min(0).max(0.5).optional().describe('Scene padding fraction (optional).'),
  activate: z.boolean().default(false).describe('Activate the scene after creating it.'),
  flags: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Document flags to stamp on the new scene, namespaced by scope — e.g. ' +
        '{"tom-cartos-import":{sourceModule,sourceId}} for import provenance/dedup. Merged verbatim.'
    ),
  environment: SceneEnvironmentSchema.optional().describe(
    "A v12+ scene's full environment{} mood object, carried whole (darknessLevel, globalLight{...}, " +
      'cycle, base, dark{hue,luminosity}…). Prefer this over the flat darkness/globalLight knobs when ' +
      'importing a pack so the authored day/night mood round-trips.'
  ),
  fog: SceneFogSchema.optional().describe(
    "A v12+ scene's full fog{} object (exploration, overlay, colors), carried whole."
  ),
  initial: SceneInitialSchema.optional().describe(
    'The saved initial camera view {x,y,scale} to restore on scene load.'
  ),
  ...sceneCommonFields,
});

const ListScenesSchema = z.object({
  filter: z.string().optional().describe('Case-insensitive substring match on scene name.'),
  includeActiveOnly: z
    .boolean()
    .optional()
    .describe('Return only the currently active scene (default false).'),
});

const UpdateSceneSchema = z.object({
  sceneIdentifier: z.string().min(1).describe('Scene id or exact name.'),
  name: z.string().min(1).optional().describe('New scene name.'),
  navName: z.string().optional().describe('Navigation label shown in the scene nav bar.'),
  navigation: z.boolean().optional().describe('Whether the scene appears in the navigation bar.'),
  backgroundPath: z
    .string()
    .min(1)
    .optional()
    .describe('Data-relative path to a new background/map image.'),
  width: z.number().int().positive().optional().describe('Scene width in pixels.'),
  height: z.number().int().positive().optional().describe('Scene height in pixels.'),
  gridSize: z.number().int().positive().optional().describe('Grid size in pixels.'),
  gridType: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Foundry grid type (0 gridless, 1 square, 2+ hex).'),
  padding: z.number().min(0).max(0.5).optional().describe('Scene padding fraction (0–0.5).'),
  ...sceneCommonFields,
});

const DeleteSceneSchema = z.object({
  identifiers: z
    .array(z.string().min(1))
    .min(1)
    .describe('Exact ids (preferred) or exact names of scenes to delete.'),
});

const RemapTeleportersSchema = z.object({
  sourceModule: z
    .string()
    .min(1)
    .describe(
      'The module id stamped in flags["tom-cartos-import"].sourceModule on the imported scenes ' +
        '(e.g. the read-pack module.id). All scenes carrying it are scanned together.'
    ),
});

const GetSceneDimensionsSchema = z.object({
  sceneIdentifier: z.string().min(1).describe('Scene id or exact name.'),
});

const CreateSceneNotesSchema = z.object({
  sceneIdentifier: z.string().min(1).describe('Scene id or exact name to place the notes on.'),
  notes: z
    .array(
      z.object({
        journal: z
          .string()
          .min(1)
          .describe('JournalEntry id or exact name the pin links to (strict resolve).'),
        page: z
          .string()
          .optional()
          .describe('Page id or exact name within that entry to open (strict resolve).'),
        x: z.number().describe('Pin X in absolute canvas pixels.'),
        y: z.number().describe('Pin Y in absolute canvas pixels.'),
        label: z
          .string()
          .optional()
          .describe('Text shown on the pin (e.g. "12 — Throne Room"); defaults to the entry name.'),
        icon: z
          .string()
          .optional()
          .describe("Data-relative icon image src; omit for Foundry's default note pin."),
        iconSize: z.number().int().positive().optional().describe('Icon size in px (min 32).'),
        global: z
          .boolean()
          .optional()
          .describe(
            'Render the pin through fog/vision occlusion. NOT a permission control — GM-only ' +
              "secrecy comes from the linked journal's ownership (default 0)."
          ),
      })
    )
    .min(1)
    .describe('The map-note pins to create.'),
});

const UpdateNoteSchema = z
  .object({
    sceneIdentifier: z.string().min(1).describe('Scene id or exact name holding the pin.'),
    noteId: z.string().min(1).describe('The Note id to update (from create-scene-notes).'),
    x: z.number().optional().describe('New pin X in absolute canvas pixels.'),
    y: z.number().optional().describe('New pin Y in absolute canvas pixels.'),
    label: z.string().optional().describe('New text shown on the pin.'),
    iconSize: z.number().int().positive().optional().describe('New icon size in px (min 32).'),
    global: z
      .boolean()
      .optional()
      .describe('Render the pin through fog/vision occlusion (NOT a permission control).'),
    icon: z.string().optional().describe('New Data-relative icon image src.'),
    journal: z
      .string()
      .optional()
      .describe('Re-point the pin to a different JournalEntry (id or exact name, strict resolve).'),
    page: z
      .string()
      .optional()
      .describe('Page id or exact name within the (re-pointed) journal; only used with `journal`.'),
  })
  .refine(
    v =>
      v.x !== undefined ||
      v.y !== undefined ||
      v.label !== undefined ||
      v.iconSize !== undefined ||
      v.global !== undefined ||
      v.icon !== undefined ||
      v.journal !== undefined,
    {
      message:
        'Provide at least one field to update (x, y, label, iconSize, global, icon, or journal).',
    }
  );

const DeleteNoteSchema = z.object({
  sceneIdentifier: z.string().min(1).describe('Scene id or exact name holding the pins.'),
  noteIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('Note ids to delete (from create-scene-notes).'),
});

const ScreenshotSceneSchema = z.object({
  sceneIdentifier: z.string().min(1).describe('Scene id or exact name to screenshot.'),
  outputPath: z
    .string()
    .optional()
    .describe('Absolute local path to write the PNG to. Default: a temp file (path returned).'),
  fit: z
    .boolean()
    .default(true)
    .describe(
      'Fit the whole scene into the viewport (default). false keeps the saved camera view.'
    ),
  mark: z
    .boolean()
    .default(false)
    .describe(
      'Draw a transient numbered marker over each map-note pin (QA for legend-pin placement). ' +
        'No document changes — the overlay is view-only.'
    ),
});

export class SceneTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: SceneToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'SceneTools' });
  }

  /**
   * Tool definitions for scene operations
   */
  getToolDefinitions() {
    return [
      {
        name: 'get-current-scene',
        description:
          'Get information about the currently active scene, including tokens and layout',
        inputSchema: toInputSchema(GetCurrentSceneSchema),
      },
      {
        name: 'get-world-info',
        description: 'Get basic information about the Foundry world and system',
        inputSchema: toInputSchema(GetWorldInfoSchema),
      },
      {
        name: 'create-scene',
        description:
          'Create a Foundry Scene from a Data-relative background image path (e.g. an uploaded map). ' +
          'Width/height auto-detect from the image when omitted. Optionally set grid size/type/' +
          'distance/units/color/alpha, token vision, fog mode, lighting (darkness, global light, or a ' +
          'whole environment{}/fog{} mood object + saved camera for pack imports), weather, a linked ' +
          'playlist/journal, a nav thumbnail, padding, provenance flags, and ' +
          'activate it. Can also IMPORT walls + ' +
          'ambient lights from a map sidecar JSON (the `walls`/`lights` arrays many battlemaps ship ' +
          'alongside the image): pass them and they are placed on the new scene (legacy or v14 shapes ' +
          'both accepted, normalized to v14). GM-only.',
        inputSchema: toInputSchema(CreateSceneSchema),
      },
      {
        name: 'list-scenes',
        description:
          'List Scene documents with id, name, active flag, dimensions, grid size, and background ' +
          'path. Optionally filter by name substring or show only the active scene.',
        inputSchema: toInputSchema(ListScenesSchema),
      },
      {
        name: 'update-scene',
        description:
          'Update an existing Scene document — rename, swap its background image (Data-relative path), ' +
          'toggle navigation, set the navigation label, change dimensions/grid (size/type/distance/' +
          'units)/padding, token vision, fog mode, lighting (darkness, global light), weather, a nav ' +
          'thumbnail, or the linked playlist/journal ("" clears a link). Scene-document only: never ' +
          'touches placeables ' +
          '(walls/lights/tokens) and never activates the scene. GM-only.',
        inputSchema: toInputSchema(UpdateSceneSchema),
      },
      {
        name: 'delete-scene',
        description:
          'Permanently delete one or more Scene documents by exact id or exact name. STRICT ' +
          'resolution — no fuzzy/substring matching. GM-only.',
        inputSchema: toInputSchema(DeleteSceneSchema),
      },
      {
        name: 'remap-teleporters',
        description:
          'Second pass of a scene-pack import: rewrite cross-scene teleporter destinations after the ' +
          'scenes + regions have been created. A pack teleporter points at Scene.<id>.Region.<id>, but ' +
          'the import mints FRESH ids, so every destination is stale until remapped. Pass the import ' +
          'sourceModule; this reconstructs the old→new scene/region id maps from the provenance flags ' +
          'the scenes + regions carry and rewrites every teleportToken destination. Idempotent (safe to ' +
          're-run), and reports destinations that point outside the import (e.g. a variant you skipped) ' +
          'rather than dropping them silently. Call it ONCE after all chosen scenes are imported. GM-only.',
        inputSchema: toInputSchema(RemapTeleportersSchema),
      },
      {
        name: 'get-scene-dimensions',
        description:
          "Read a scene's live PADDED-CANVAS geometry (by id or exact name): total width/height, the " +
          'background rect within the padding (sceneX/sceneY/sceneWidth/sceneHeight), grid size/distance, ' +
          "and rows/columns. A scene insets its background by a padding border, so a placeable's canvas " +
          'pixel is NOT just gridCell×size — use sceneX/sceneY to offset. Feeds the legend→pins cell→px ' +
          'math. Works on any scene (no need to activate it).',
        inputSchema: toInputSchema(GetSceneDimensionsSchema),
      },
      {
        name: 'create-scene-notes',
        description:
          'Place map-note PINS on a scene, each linked to a JournalEntry (and optionally a specific ' +
          'page) — the deterministic half of the legend→GM-room-pins feature. Pass absolute canvas ' +
          'pixel x/y (see get-scene-dimensions for the padding-aware math), an optional label/icon/size, ' +
          'and the journal id|name. Per-note error isolation: a pin whose journal does not resolve is ' +
          "reported and skipped, not fatal. GM-only secrecy is the linked journal's ownership, not the " +
          'pin; `global` only controls fog occlusion. Returns each created note id (for update-note/' +
          'delete-note). GM-only.',
        inputSchema: toInputSchema(CreateSceneNotesSchema),
      },
      {
        name: 'update-note',
        description:
          'Nudge ONE existing map-note pin by id (the legend→pins review loop): move it (x/y), ' +
          'relabel it, resize/restyle its icon, toggle fog `global`, or re-point it to a different ' +
          'journal/page. Patches only the fields you pass; at least one is required. Strict scene + ' +
          'note-id resolution. GM-only.',
        inputSchema: toInputSchema(UpdateNoteSchema),
      },
      {
        name: 'delete-note',
        description:
          'Remove one or more map-note pins from a scene by note id (from create-scene-notes). ' +
          'Missing ids are reported, never fatal. GM-only.',
        inputSchema: toInputSchema(DeleteNoteSchema),
      },
      {
        name: 'screenshot-scene',
        description:
          'Render a scene in the headless bridge and capture a PNG to a local file — visual QA for ' +
          'imports/maps. Views the scene, waits for the WebGL canvas to draw, fits the whole map ' +
          'into the viewport (or keeps the saved camera with fit:false), and optionally draws ' +
          'numbered markers over each map-note pin (mark:true) to check legend-pin placement (a ' +
          'view-only overlay, no document changes). Returns the file path + scene metadata; ' +
          'open/read that file to view the image. GM-only.',
        inputSchema: toInputSchema(ScreenshotSceneSchema),
      },
    ];
  }

  async handleCreateScene(args: any): Promise<string> {
    const parsed = CreateSceneSchema.parse(args ?? {});
    const callArgs: any = { ...parsed };
    // Pull walls/lights from a read-pack payload file SERVER-SIDE (they never transit the agent).
    if (callArgs.placeablesPath) {
      let payload: any;
      try {
        payload = JSON.parse(readFileSync(callArgs.placeablesPath, 'utf8'));
      } catch (err) {
        throw new Error(
          `create-scene: could not read placeablesPath "${callArgs.placeablesPath}": ${(err as Error).message}`
        );
      }
      if (Array.isArray(payload?.walls))
        callArgs.walls = [...(callArgs.walls ?? []), ...payload.walls];
      if (Array.isArray(payload?.lights))
        callArgs.lights = [...(callArgs.lights ?? []), ...payload.lights];
      if (Array.isArray(payload?.regions))
        callArgs.regions = [...(callArgs.regions ?? []), ...payload.regions];
      delete callArgs.placeablesPath; // page-side createScene doesn't know this field
    }
    const result = await this.foundry.call('createScene', callArgs);
    const dims =
      result?.width && result?.height
        ? `\n  dimensions: ${result.width}×${result.height}px${result.autoSized ? ' (auto from image)' : ''}`
        : '';
    const placeables: string[] = [];
    if (typeof result?.wallsCreated === 'number') placeables.push(`${result.wallsCreated} wall(s)`);
    if (typeof result?.lightsCreated === 'number')
      placeables.push(`${result.lightsCreated} light(s)`);
    if (typeof result?.regionsCreated === 'number')
      placeables.push(`${result.regionsCreated} region(s)`);
    const placeableLine = placeables.length ? `\n  imported: ${placeables.join(', ')}` : '';
    // Regions can hold cross-scene teleporters whose destinations need a post-import remap pass.
    const teleportHint =
      result?.regionsCreated > 0
        ? '\n  ↪ regions imported — run remap-teleporters once after all scenes to link teleporters'
        : '';
    const placeableErrs = Array.isArray(result?.placeableErrors)
      ? result.placeableErrors.map((e: string) => `\n  ⚠ ${e}`).join('')
      : '';
    return (
      `Created scene "${result?.sceneName}" (${result?.sceneId})` +
      `${result?.active ? ' [active]' : ''}\n  background: ${result?.background}` +
      dims +
      placeableLine +
      teleportHint +
      placeableErrs +
      formatSceneSettings(result?.settings)
    );
  }

  async handleRemapTeleporters(args: any): Promise<string> {
    const parsed = RemapTeleportersSchema.parse(args ?? {});
    const result = await this.foundry.call('remapSceneTeleporters', parsed);
    const unresolved: string[] = Array.isArray(result?.unresolved) ? result.unresolved : [];
    const lines = [
      `Teleporter remap for "${result?.sourceModule}":`,
      `  scenes scanned: ${result?.scenesScanned ?? 0}`,
      `  teleporters rewritten: ${result?.rewritten ?? 0}` +
        (result?.unchanged ? ` (${result.unchanged} already correct)` : ''),
    ];
    if (unresolved.length > 0) {
      lines.push(
        `  ⚠ ${unresolved.length} destination(s) point outside this import (not rewritten):`
      );
      for (const u of unresolved.slice(0, 20)) lines.push(`      - ${u}`);
      if (unresolved.length > 20) lines.push(`      …and ${unresolved.length - 20} more`);
    }
    return lines.join('\n');
  }

  async handleGetSceneDimensions(args: any): Promise<any> {
    const parsed = GetSceneDimensionsSchema.parse(args ?? {});
    const result = await this.foundry.call('getSceneDimensions', parsed);
    if (result?.found === false) {
      return `Scene not found: "${result?.notFound ?? parsed.sceneIdentifier}".`;
    }
    return result;
  }

  async handleCreateSceneNotes(args: any): Promise<string> {
    const parsed = CreateSceneNotesSchema.parse(args ?? {});
    const result = await this.foundry.call('createSceneNotes', parsed);
    if (result?.notFound) {
      return `Scene not found: "${result.notFound}". No notes placed.`;
    }
    const errs = Array.isArray(result?.errors)
      ? result.errors.map((e: string) => `\n  ⚠ ${e}`).join('')
      : '';
    // Surface each created note id so the GM (or a follow-up call) can nudge/remove pins.
    const noteLines = Array.isArray(result?.notes)
      ? result.notes.map((n: any) => `\n  • ${n.id}${n.label ? ` — ${n.label}` : ''}`).join('')
      : '';
    return (
      `Placed ${result?.created ?? 0} map-note pin(s) on "${result?.sceneName}" (${result?.sceneId})` +
      noteLines +
      errs
    );
  }

  async handleUpdateNote(args: any): Promise<string> {
    const parsed = UpdateNoteSchema.parse(args ?? {});
    const result = await this.foundry.call('updateSceneNote', parsed);
    if (result?.updated === false) {
      return `Note not found: "${result?.notFound ?? parsed.noteId}". Nothing changed.`;
    }
    return `Updated note ${result?.noteId} on "${result?.sceneName}" (${result?.sceneId}).`;
  }

  async handleDeleteNote(args: any): Promise<string> {
    const parsed = DeleteNoteSchema.parse(args ?? {});
    const result = await this.foundry.call('deleteSceneNotes', parsed);
    if (result?.notFound) {
      return `Scene not found: "${result.notFound}". Nothing deleted.`;
    }
    const missing =
      Array.isArray(result?.notFoundIds) && result.notFoundIds.length > 0
        ? ` (${result.notFoundIds.length} id(s) not found: ${result.notFoundIds.join(', ')})`
        : '';
    return `Deleted ${result?.deleted ?? 0} note(s) from "${result?.sceneName}" (${result?.sceneId})${missing}.`;
  }

  async handleScreenshotScene(args: any): Promise<string> {
    const parsed = ScreenshotSceneSchema.parse(args ?? {});
    // Page-side: view + fit + (optional) marker overlay, returning scene metadata.
    const meta = await this.foundry.call('prepareSceneShot', {
      sceneIdentifier: parsed.sceneIdentifier,
      fit: parsed.fit,
      mark: parsed.mark,
    });
    if (!meta?.found) {
      return `Scene not found: "${meta?.notFound ?? parsed.sceneIdentifier}". Nothing captured.`;
    }
    // Bridge-side (Playwright): capture the rendered page to a file. Default to a temp path.
    const safeId = String(meta.sceneId ?? 'scene').replace(/[^a-zA-Z0-9_-]/g, '');
    const outPath = parsed.outputPath || join(tmpdir(), `fvtt-scene-${safeId}.png`);
    await this.foundry.screenshot(outPath);
    const dims = meta.dimensions
      ? `\n  canvas: ${meta.dimensions.width}×${meta.dimensions.height}px (renderer ${meta.renderer ?? '?'})`
      : '';
    return (
      `Captured "${meta.sceneName}" (${meta.sceneId}) → ${outPath}` +
      (parsed.mark ? `\n  marked ${meta.noteCount ?? 0} note pin(s)` : '') +
      dims +
      '\n  (open or Read the file to view the image)'
    );
  }

  async handleListScenes(args: any): Promise<string> {
    const parsed = ListScenesSchema.parse(args ?? {});
    const scenes = (await this.foundry.call('listScenes', parsed)) ?? [];
    if (!Array.isArray(scenes) || scenes.length === 0) {
      return 'No scenes found.';
    }
    const lines = scenes.map((s: any) => {
      const dims = s.dimensions ? `${s.dimensions.width}×${s.dimensions.height}` : '?';
      return (
        `  - "${s.name}" (${s.id})${s.active ? ' [active]' : ''} — ${dims}px, grid ${s.gridSize}` +
        `${s.background ? `\n      background: ${s.background}` : ''}`
      );
    });
    return `Scenes (${scenes.length}):\n${lines.join('\n')}`;
  }

  async handleUpdateScene(args: any): Promise<string> {
    const parsed = UpdateSceneSchema.parse(args ?? {});
    const result = await this.foundry.call('updateScene', parsed);
    if (result?.updated === false) {
      return `Scene not found: "${result?.notFound ?? parsed.sceneIdentifier}". Nothing changed.`;
    }
    return (
      `Updated scene "${result?.sceneName}" (${result?.sceneId})\n  background: ${result?.background}` +
      formatSceneSettings(result?.settings)
    );
  }

  async handleDeleteScene(args: any): Promise<string> {
    const { identifiers } = DeleteSceneSchema.parse(args ?? {});
    const result = await this.foundry.call('deleteScenes', { identifiers });
    return formatDeletionResult(result, 'scene(s)');
  }

  async handleGetCurrentScene(args: any): Promise<any> {
    const { includeTokens, includeHidden } = GetCurrentSceneSchema.parse(args);

    this.logger.info('Getting current scene information', { includeTokens, includeHidden });

    try {
      const sceneData = await this.foundry.call('getActiveScene');

      this.logger.debug('Successfully retrieved scene data', {
        sceneId: sceneData.id,
        sceneName: sceneData.name,
        tokenCount: sceneData.tokens?.length || 0,
      });

      return this.formatSceneResponse(sceneData, includeTokens, includeHidden);
    } catch (error) {
      this.logger.error('Failed to get current scene', error);
      throw new Error(
        `Failed to get current scene: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleGetWorldInfo(_args: any): Promise<any> {
    this.logger.info('Getting world information');

    try {
      const worldData = await this.foundry.call('getWorldInfo');

      this.logger.debug('Successfully retrieved world data', {
        worldId: worldData.id,
        system: worldData.system,
      });

      return this.formatWorldResponse(worldData);
    } catch (error) {
      this.logger.error('Failed to get world information', error);
      throw new Error(
        `Failed to get world information: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private formatSceneResponse(sceneData: any, includeTokens: boolean, includeHidden: boolean): any {
    const response: any = {
      id: sceneData.id,
      name: sceneData.name,
      active: sceneData.active,
      dimensions: {
        width: sceneData.width,
        height: sceneData.height,
        padding: sceneData.padding,
      },
      hasBackground: !!sceneData.background,
      navigation: sceneData.navigation,
      elements: {
        walls: sceneData.walls || 0,
        lights: sceneData.lights || 0,
        sounds: sceneData.sounds || 0,
        notes: sceneData.notes?.length || 0,
      },
    };

    if (includeTokens && sceneData.tokens) {
      response.tokens = this.formatTokens(sceneData.tokens, includeHidden);
      response.tokenSummary = this.createTokenSummary(sceneData.tokens, includeHidden);
    }

    if (sceneData.notes && sceneData.notes.length > 0) {
      response.notes = sceneData.notes.map((note: any) => ({
        id: note.id,
        text: this.truncateText(note.text, 100),
        position: { x: note.x, y: note.y },
      }));
    }

    return response;
  }

  private formatTokens(tokens: any[], includeHidden: boolean): any[] {
    return tokens
      .filter(token => includeHidden || !token.hidden)
      .map(token => ({
        id: token.id,
        name: token.name,
        position: {
          x: token.x,
          y: token.y,
        },
        size: {
          width: token.width,
          height: token.height,
        },
        actorId: token.actorId,
        disposition: this.getDispositionName(token.disposition),
        hidden: token.hidden,
        hasImage: !!token.img,
      }));
  }

  private createTokenSummary(tokens: any[], includeHidden: boolean): any {
    const visibleTokens = includeHidden ? tokens : tokens.filter(t => !t.hidden);

    const summary = {
      total: visibleTokens.length,
      byDisposition: {
        friendly: 0,
        neutral: 0,
        hostile: 0,
        unknown: 0,
      },
      hasActors: 0,
      withoutActors: 0,
    };

    visibleTokens.forEach(token => {
      // Count by disposition
      const disposition = this.getDispositionName(token.disposition);
      if (disposition in summary.byDisposition) {
        summary.byDisposition[disposition as keyof typeof summary.byDisposition]++;
      } else {
        summary.byDisposition.unknown++;
      }

      // Count actor association
      if (token.actorId) {
        summary.hasActors++;
      } else {
        summary.withoutActors++;
      }
    });

    return summary;
  }

  private formatWorldResponse(worldData: any): any {
    return {
      id: worldData.id,
      title: worldData.title,
      system: {
        id: worldData.system,
        version: worldData.systemVersion,
      },
      foundry: {
        version: worldData.foundryVersion,
      },
      users: {
        total: worldData.users?.length || 0,
        active: worldData.users?.filter((u: any) => u.active).length || 0,
        gms: worldData.users?.filter((u: any) => u.isGM).length || 0,
        players: worldData.users?.filter((u: any) => !u.isGM).length || 0,
      },
      activeUsers:
        worldData.users
          ?.filter((u: any) => u.active)
          .map((u: any) => ({
            id: u.id,
            name: u.name,
            isGM: u.isGM,
          })) || [],
    };
  }

  private getDispositionName(disposition: number): string {
    switch (disposition) {
      case -1:
        return 'hostile';
      case 0:
        return 'neutral';
      case 1:
        return 'friendly';
      default:
        return 'unknown';
    }
  }

  private truncateText(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) {
      return text;
    }
    return `${text.substring(0, maxLength - 3)}...`;
  }
}

/**
 * Compact one-line summary of a scene's effective settings for tool output.
 * Grid/vision/fog are always shown (always relevant); darkness, global light,
 * weather, and links appear only when non-default/set, to keep the line short.
 * Returns '' when there are no settings to report (keeps legacy output stable).
 */
function formatSceneSettings(s: any): string {
  if (!s || typeof s !== 'object') return '';
  const parts: string[] = [];
  const g = s.grid ?? {};
  if (g.size != null || g.distance != null) {
    parts.push(`grid ${g.size ?? '?'}px = ${g.distance ?? '?'}${g.units ? ` ${g.units}` : ''}`);
  }
  if (s.tokenVision != null) parts.push(`vision ${s.tokenVision ? 'on' : 'off'}`);
  if (s.fogMode) parts.push(`fog ${s.fogMode}`);
  if (typeof s.darkness === 'number' && s.darkness > 0) parts.push(`darkness ${s.darkness}`);
  if (s.globalLight === true) parts.push('global light on');
  if (s.weather) parts.push(`weather ${s.weather}`);
  if (s.playlist) parts.push(`playlist ${s.playlist}`);
  if (s.journal) parts.push(`journal ${s.journal}`);
  return parts.length ? `\n  settings: ${parts.join(', ')}` : '';
}
