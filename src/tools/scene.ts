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
          'distance/units/color/alpha, token vision, fog mode, lighting (darkness, global light), ' +
          'weather, a linked playlist/journal, padding, and activate it. Can also IMPORT walls + ' +
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
          'units)/padding, token vision, fog mode, lighting (darkness, global light), weather, or the ' +
          'linked playlist/journal ("" clears a link). Scene-document only: never touches placeables ' +
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
    ];
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
