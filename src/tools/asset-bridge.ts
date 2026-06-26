import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { formatDeletionResult } from '../utils/format.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * Asset-management bridge tools (Phase 2) — Group C (reference integrity) + Group D (Foundry
 * composition). Unlike the WebDAV file tools in tools/molten, these run OVER THE BRIDGE: they
 * manipulate live Foundry documents (playlists, scenes, actors, journals) via foundry.call,
 * so they need the world loaded and the headless Foundry client connected.
 *
 * Paths are Data-relative (the same vocabulary upload-asset returns), which is exactly what Foundry
 * stores in src/img fields — so an uploaded asset path chains straight into create-playlist /
 * set-actor-art / create-scene with no conversion. That chaining is the whole point: "upload these
 * tracks and make a tavern playlist" becomes upload-asset×N → create-playlist.
 */

// Single source of truth for each tool's input contract: the handler parses with these
// schemas and getToolDefinitions() advertises toInputSchema(...) of the same schema.
const FindAssetReferencesSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'One or more Data-relative asset paths to look up, e.g. ' +
        '["worlds/your-world/assets/maps/cavern.webp"].'
    ),
});

const RelinkAssetSchema = z.object({
  oldPath: z.string().min(1).describe('Current Data-relative path being referenced.'),
  newPath: z.string().min(1).describe('New Data-relative path to point references at.'),
  dryRun: z.boolean().default(false).describe('Report what would change without writing.'),
});

const CreatePlaylistSchema = z.object({
  name: z.string().min(1).describe('Playlist name.'),
  soundPaths: z
    .array(z.string().min(1))
    .min(1)
    .describe('Data-relative paths to the sound files, in order.'),
  mode: z
    .enum(['sequential', 'shuffle', 'simultaneous', 'soundboard', 'disabled'])
    .default('sequential')
    .describe('Playback mode (default sequential).'),
  defaultVolume: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Volume 0–1 applied to each track (default 0.5).'),
  repeat: z.boolean().default(false).describe('Whether each track loops (default false).'),
  fade: z.number().min(0).optional().describe('Crossfade duration in milliseconds (optional).'),
});

const ListPlaylistsSchema = z.object({});

const UpdatePlaylistSchema = z.object({
  identifier: z.string().min(1).describe('Playlist id or exact name.'),
  name: z.string().min(1).optional().describe('New playlist name.'),
  mode: z
    .enum(['sequential', 'shuffle', 'simultaneous', 'soundboard', 'disabled'])
    .optional()
    .describe('New playback mode.'),
  fade: z.number().min(0).optional().describe('Crossfade duration in milliseconds.'),
});

const DeletePlaylistSchema = z.object({
  identifiers: z
    .array(z.string().min(1))
    .min(1)
    .describe('Exact ids (preferred) or exact names of playlists to delete.'),
});

// Cross-cutting scene fields shared by create-scene and update-scene. Spread into
// both schemas so there's one source of truth. Page-side validates `weather`
// against the live CONFIG.weatherEffects and resolves playlist/journal name→id.
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
};

// A wall placeable from a map sidecar JSON. Accepts the LEGACY Foundry shape
// (`sense`, small-int enums) OR the v14 shape (`sight`/`light`, spaced enums);
// the page side normalizes either to the v14 WallDocument. `c` is [x0,y0,x1,y1]
// in ABSOLUTE canvas pixels. Passthrough so unknown keys (flags, etc.) survive.
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

// An ambient-light placeable from a map sidecar JSON. Accepts the LEGACY flat
// shape (`dim/bright/tintColor/tintAlpha`) OR the v14 shape (`config{}`); the
// page side nests emission props under `config`. x/y are absolute canvas pixels.
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
  ...sceneCommonFields,
});

const SetActorArtSchema = z.object({
  actorIdentifier: z.string().min(1).describe('Actor id or exact name.'),
  imagePath: z.string().min(1).describe('Data-relative path to the image.'),
  applyToToken: z
    .boolean()
    .default(true)
    .describe('Also set the prototype token texture (default true).'),
});

const AddJournalImageSchema = z.object({
  journalIdentifier: z.string().min(1).describe('Journal id or exact name.'),
  imagePath: z.string().min(1).describe('Data-relative path to the image.'),
  pageName: z.string().optional().describe('Page title (defaults to the file name).'),
  caption: z.string().optional().describe('Optional image caption.'),
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

export interface AssetBridgeToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class AssetBridgeTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: AssetBridgeToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'AssetBridgeTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'find-asset-references',
        description:
          'Bridge (reference integrity). Find every world document (scenes, actors, items, journals, ' +
          'playlists, macros, roll tables) that references a given asset path under `Data/`. Use this ' +
          'BEFORE deleting or moving a file to see what would break. Read-only.',
        inputSchema: toInputSchema(FindAssetReferencesSchema),
      },
      {
        name: 'relink-asset',
        description:
          'Bridge (reference integrity). Rewrite every reference from one asset path to another ' +
          '(e.g. after moving/renaming a file) so nothing breaks. Pass dryRun:true to preview the ' +
          'documents that would change without writing. GM-only.',
        inputSchema: toInputSchema(RelinkAssetSchema),
      },
      {
        name: 'create-playlist',
        description:
          'Bridge (composition) — FLAGSHIP. Create a Foundry Playlist from a list of Data-relative ' +
          'sound paths (e.g. ones just returned by upload-asset). Modes: sequential, shuffle, ' +
          'simultaneous, soundboard. GM-only.',
        inputSchema: toInputSchema(CreatePlaylistSchema),
      },
      {
        name: 'list-playlists',
        description:
          'List Playlist documents with id, name, mode, track count, and whether each is currently ' +
          'playing.',
        inputSchema: toInputSchema(ListPlaylistsSchema),
      },
      {
        name: 'update-playlist',
        description:
          "Update a Playlist's document fields: rename, change playback mode, or set the crossfade " +
          'duration. Does not add/remove tracks. GM-only.',
        inputSchema: toInputSchema(UpdatePlaylistSchema),
      },
      {
        name: 'delete-playlist',
        description:
          'Permanently delete one or more Playlist documents by exact id or exact name. STRICT ' +
          'resolution — no fuzzy/substring matching. GM-only.',
        inputSchema: toInputSchema(DeletePlaylistSchema),
      },
      {
        name: 'create-scene',
        description:
          'Bridge (composition). Create a Foundry Scene from a Data-relative background image path ' +
          '(e.g. an uploaded map). Width/height auto-detect from the image when omitted. Optionally ' +
          'set grid size/type/distance/units/color/alpha, token vision, fog mode, lighting ' +
          '(darkness, global light), weather, a linked playlist/journal, padding, and activate it. ' +
          'Can also IMPORT walls + ambient lights from a map sidecar JSON (the `walls`/`lights` ' +
          'arrays many battlemaps ship alongside the image): pass them and they are placed on the ' +
          'new scene (legacy or v14 shapes both accepted, normalized to v14). GM-only.',
        inputSchema: toInputSchema(CreateSceneSchema),
      },
      {
        name: 'set-actor-art',
        description:
          "Bridge (composition). Set an actor's portrait image, and by default its prototype token " +
          'art too, from a Data-relative image path. GM-only.',
        inputSchema: toInputSchema(SetActorArtSchema),
      },
      {
        name: 'add-journal-image',
        description:
          'Bridge (composition). Append an image page to a journal entry from a Data-relative image ' +
          'path. GM-only.',
        inputSchema: toInputSchema(AddJournalImageSchema),
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
          'units)/padding, token vision, fog mode, lighting (darkness, global light), weather, or the ' +
          'linked playlist/journal ("" clears a link). Supersedes the old set-scene-background tool ' +
          '(pass backgroundPath). Scene-document only: never touches placeables (walls/lights/tokens) ' +
          'and never activates the scene. GM-only.',
        inputSchema: toInputSchema(UpdateSceneSchema),
      },
      {
        name: 'delete-scene',
        description:
          'Permanently delete one or more Scene documents by exact id or exact name. STRICT ' +
          'resolution — no fuzzy/substring matching. GM-only.',
        inputSchema: toInputSchema(DeleteSceneSchema),
      },
    ];
  }

  // --- handlers -------------------------------------------------------------

  async handleFindAssetReferences(args: any): Promise<string> {
    const { paths } = FindAssetReferencesSchema.parse(args ?? {});
    const result = await this.foundry.call('findAssetReferences', { paths });
    const refs = result?.references ?? {};
    const lines: string[] = [];
    for (const path of paths) {
      const hits = refs[path] ?? [];
      if (hits.length === 0) {
        lines.push(`• ${path} — no references found (safe to delete/move).`);
      } else {
        lines.push(`• ${path} — ${hits.length} reference(s):`);
        for (const h of hits) {
          lines.push(`    - ${h.documentType} "${h.documentName}" (${h.documentId}) :: ${h.field}`);
        }
      }
    }
    return `Asset references (${result?.totalReferences ?? 0} total):\n${lines.join('\n')}`;
  }

  async handleRelinkAsset(args: any): Promise<string> {
    const { oldPath, newPath, dryRun } = RelinkAssetSchema.parse(args ?? {});
    const result = await this.foundry.call('relinkAsset', {
      oldPath,
      newPath,
      dryRun,
    });
    const changed = result?.changed ?? [];
    const verb = result?.dryRun ? 'Would rewrite' : 'Rewrote';
    const header = `${verb} ${result?.changedCount ?? changed.length} reference(s): ${oldPath} → ${newPath}`;
    if (changed.length === 0) return `${header} (nothing referenced the old path).`;
    const lines = changed.map(
      (c: any) => `  - ${c.documentType} "${c.documentName}" (${c.documentId}) :: ${c.field}`
    );
    return `${header}\n${lines.join('\n')}`;
  }

  async handleCreatePlaylist(args: any): Promise<string> {
    const parsed = CreatePlaylistSchema.parse(args ?? {});
    const result = await this.foundry.call('createPlaylist', parsed);
    const sounds = result?.sounds ?? [];
    const lines = sounds.map((s: any) => `    - ${s.name}  (${s.path})`);
    return (
      `Created playlist "${result?.playlistName}" (${result?.playlistId}) — mode ${result?.mode}, ` +
      `${result?.soundCount} track(s):\n${lines.join('\n')}`
    );
  }

  async handleListPlaylists(_args: any): Promise<string> {
    const playlists = (await this.foundry.call('listPlaylists', {})) ?? [];
    if (!Array.isArray(playlists) || playlists.length === 0) return 'No playlists found.';
    const lines = playlists.map(
      (p: any) =>
        `  - "${p.name}" (${p.id}) — mode ${p.mode}, ${p.soundCount} track(s)${p.playing ? ' [playing]' : ''}`
    );
    return `Playlists (${playlists.length}):\n${lines.join('\n')}`;
  }

  async handleUpdatePlaylist(args: any): Promise<string> {
    const parsed = UpdatePlaylistSchema.parse(args ?? {});
    const result = await this.foundry.call('updatePlaylist', parsed);
    if (result?.updated === false) {
      return `Playlist not found: "${result?.notFound ?? parsed.identifier}". Nothing changed.`;
    }
    return `Updated playlist "${result?.playlistName}" (${result?.playlistId}).`;
  }

  async handleDeletePlaylist(args: any): Promise<string> {
    const { identifiers } = DeletePlaylistSchema.parse(args ?? {});
    const result = await this.foundry.call('deletePlaylists', { identifiers });
    return formatDeletionResult(result, 'playlist(s)');
  }

  async handleCreateScene(args: any): Promise<string> {
    const parsed = CreateSceneSchema.parse(args ?? {});
    const result = await this.foundry.call('createScene', parsed);
    const dims =
      result?.width && result?.height
        ? `\n  dimensions: ${result.width}×${result.height}px${result.autoSized ? ' (auto from image)' : ''}`
        : '';
    const placeables: string[] = [];
    if (typeof result?.wallsCreated === 'number') placeables.push(`${result.wallsCreated} wall(s)`);
    if (typeof result?.lightsCreated === 'number')
      placeables.push(`${result.lightsCreated} light(s)`);
    const placeableLine = placeables.length ? `\n  imported: ${placeables.join(', ')}` : '';
    const placeableErrs = Array.isArray(result?.placeableErrors)
      ? result.placeableErrors.map((e: string) => `\n  ⚠ ${e}`).join('')
      : '';
    return (
      `Created scene "${result?.sceneName}" (${result?.sceneId})` +
      `${result?.active ? ' [active]' : ''}\n  background: ${result?.background}` +
      dims +
      placeableLine +
      placeableErrs +
      formatSceneSettings(result?.settings)
    );
  }

  async handleSetActorArt(args: any): Promise<string> {
    const parsed = SetActorArtSchema.parse(args ?? {});
    const result = await this.foundry.call('setActorArt', parsed);
    if (result?.updated === false) {
      return `Actor not found: "${result?.notFound ?? parsed.actorIdentifier}". Nothing changed.`;
    }
    return (
      `Set art for actor "${result?.actorName}" (${result?.actorId}) → ${result?.img}` +
      `${result?.appliedToToken ? ' (portrait + prototype token)' : ' (portrait only)'}.`
    );
  }

  async handleAddJournalImage(args: any): Promise<string> {
    const parsed = AddJournalImageSchema.parse(args ?? {});
    const result = await this.foundry.call('addJournalImage', parsed);
    if (result?.updated === false) {
      return `Journal not found: "${result?.notFound ?? parsed.journalIdentifier}". Nothing changed.`;
    }
    return (
      `Added image page "${result?.pageName}" (${result?.pageId}) to journal ` +
      `"${result?.journalName}" (${result?.journalId}) → ${result?.src}.`
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
