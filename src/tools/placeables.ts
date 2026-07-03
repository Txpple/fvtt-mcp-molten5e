import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import {
  formatCreatePlaceables,
  formatDeletePlaceables,
  formatListPlaceables,
  formatUpdatePlaceables,
} from '../utils/placeable-format.js';
import { toInputSchema } from '../utils/schema.js';

// Scene PLACEABLE editing tools — per-type CRUD over the shared page-side kernel (src/page/_placeables.ts).
//
// Split OUT of src/tools/scene.ts (which owns scene-DOCUMENT tools) so scene-document editing and
// placeable editing stay separate concerns. Each per-type tool is a thin descriptor over the kernel:
// the zod schema (the LLM-facing contract) lives here, correctness lives in the page-side descriptor,
// and the four output renderers come from utils/placeable-format.ts. Focus set: Tile (full CRUD),
// AmbientLight (full CRUD), plus read-only list-tokens / list-notes (the inspect layer that makes the
// existing update-token / *-note editing loops usable — you can't edit what you can't get ids for).

export interface PlaceableToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

// --- shared bases (one source of truth; create + update compose them) --------
const sceneTarget = z.string().min(1).describe('Scene id or exact name holding the placeables.');

// The editable Tile fields shared by create-tiles and update-tiles. A tile's on-map SIZE is
// width/height (px) — that is the "scale" you resize a prop with; texture.scaleX/scaleY instead
// zoom the image WITHIN that frame. x/y are absolute canvas pixels (see get-scene-dimensions for the
// padding-aware cell→px math).
const tileFields = {
  rotation: z.number().optional().describe('Rotation in degrees (0–359).'),
  alpha: z.number().min(0).max(1).optional().describe('Opacity 0–1 (default 1).'),
  elevation: z.number().optional().describe('Elevation in grid-distance units (stacking/height).'),
  sort: z.number().int().optional().describe('Z-sort within the elevation band (higher = on top).'),
  scaleX: z
    .number()
    .positive()
    .optional()
    .describe(
      'Texture scale X — zooms the IMAGE inside the width/height frame (NOT the tile size).'
    ),
  scaleY: z
    .number()
    .positive()
    .optional()
    .describe('Texture scale Y (image zoom within the frame).'),
  tint: z.string().optional().describe('Texture tint hex, e.g. "#ffffff" (no tint).'),
  fit: z
    .enum(['fill', 'contain', 'cover', 'width', 'height'])
    .optional()
    .describe('How the image fits its width/height frame (default "fill").'),
  occlusionMode: z
    .number()
    .int()
    .optional()
    .describe(
      'Roof/overhead occlusion mode (TILE_OCCLUSION_MODES): 0 none, 1 fade, 2 surface, 4 radial, ' +
        '8 vision. Use 1/4 for a roof that fades when a token walks under it.'
    ),
  occlusionAlpha: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Alpha the tile fades TO when occluding (0 = fully transparent).'),
  restrictLight: z.boolean().optional().describe('Block light from passing through this tile.'),
  restrictWeather: z.boolean().optional().describe('Block weather from showing over this tile.'),
  videoLoop: z.boolean().optional().describe('For a video tile: loop playback.'),
  videoAutoplay: z.boolean().optional().describe('For a video tile: autoplay.'),
  videoVolume: z.number().min(0).max(1).optional().describe('For a video tile: volume 0–1.'),
  hidden: z.boolean().optional().describe('Hide the tile from players (GM-only visible).'),
  locked: z.boolean().optional().describe('Lock the tile against accidental drag/edit in-app.'),
};

const CreateTilesSchema = z.object({
  sceneIdentifier: sceneTarget,
  tiles: z
    .array(
      z.object({
        src: z
          .string()
          .min(1)
          .describe('Data-relative image (or video) path for the tile texture.'),
        x: z.number().describe('Top-left X in absolute canvas pixels.'),
        y: z.number().describe('Top-left Y in absolute canvas pixels.'),
        width: z.number().positive().describe('Tile width in canvas pixels (its on-map size).'),
        height: z.number().positive().describe('Tile height in canvas pixels (its on-map size).'),
        ...tileFields,
      })
    )
    .min(1)
    .describe('One or more tiles (props/roofs/overlays) to place on the scene.'),
});

const ListTilesSchema = z.object({ sceneIdentifier: sceneTarget });

const UpdateTileSchema = z
  .object({
    id: z.string().min(1).describe('Tile id (from list-tiles).'),
    x: z.number().optional().describe('New top-left X in canvas pixels.'),
    y: z.number().optional().describe('New top-left Y in canvas pixels.'),
    width: z.number().positive().optional().describe('New width in px (resize the tile).'),
    height: z.number().positive().optional().describe('New height in px (resize the tile).'),
    src: z.string().min(1).optional().describe('Swap the texture (Data-relative path).'),
    ...tileFields,
  })
  .refine(v => Object.keys(v).some(k => k !== 'id' && (v as any)[k] !== undefined), {
    message: 'Provide at least one field to change besides id.',
  });

const UpdateTilesSchema = z.object({
  sceneIdentifier: sceneTarget,
  tiles: z
    .array(UpdateTileSchema)
    .min(1)
    .describe('The tile patches to apply (each targets one id).'),
});

const DeleteTilesSchema = z.object({
  sceneIdentifier: sceneTarget,
  tileIds: z.array(z.string().min(1)).min(1).describe('Tile ids to delete (from list-tiles).'),
});

// --- AmbientLight ------------------------------------------------------------
// Emission nests under `config{}` page-side; these flat inputs are folded in there. dim/bright are
// radii in grid-distance units (feet), NOT pixels. x/y are the light CENTER in absolute canvas pixels.
const lightFields = {
  rotation: z.number().optional().describe('Emission-cone rotation in degrees.'),
  walls: z.boolean().optional().describe('Confine the light within walls (default true).'),
  vision: z.boolean().optional().describe('This light provides vision (default false).'),
  hidden: z.boolean().optional().describe('Hide the light from players (GM-only).'),
  elevation: z.number().optional().describe('Light elevation in grid-distance units.'),
  dim: z.number().optional().describe('Dim radius in grid-distance units (e.g. ft).'),
  bright: z.number().optional().describe('Bright radius in grid-distance units (e.g. ft).'),
  color: z.string().optional().describe('Tint color hex, e.g. "#fcd674" (warm torch).'),
  alpha: z.number().min(0).max(1).optional().describe('Tint intensity 0–1 (default ~0.3).'),
  angle: z.number().optional().describe('Emission cone angle in degrees (360 = full circle).'),
  luminosity: z
    .number()
    .optional()
    .describe('Luminosity -1..1 (0.5 default; lower = softer glow).'),
  attenuation: z.number().min(0).max(1).optional().describe('Falloff 0–1 (higher = softer edge).'),
  animationType: z
    .string()
    .optional()
    .describe('Animation key, e.g. "torch", "flame", "pulse", "" for none (steady).'),
  animationSpeed: z.number().int().min(0).max(10).optional().describe('Animation speed 0–10.'),
  animationIntensity: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Animation intensity 0–10.'),
  darknessMin: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Only emit when scene darkness ≥ this (0–1). Use ~0.1 for a torch that lights at dusk.'
    ),
  darknessMax: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Only emit when scene darkness ≤ this (0–1).'),
};

const CreateLightsSchema = z.object({
  sceneIdentifier: sceneTarget,
  lights: z
    .array(
      z.object({
        x: z.number().describe('Light center X in absolute canvas pixels.'),
        y: z.number().describe('Light center Y in absolute canvas pixels.'),
        ...lightFields,
      })
    )
    .min(1)
    .describe('One or more ambient lights (torches, glows, magical light) to place.'),
});

const ListLightsSchema = z.object({ sceneIdentifier: sceneTarget });

const UpdateLightSchema = z
  .object({
    id: z.string().min(1).describe('AmbientLight id (from list-lights).'),
    x: z.number().optional().describe('New center X in canvas pixels.'),
    y: z.number().optional().describe('New center Y in canvas pixels.'),
    ...lightFields,
  })
  .refine(v => Object.keys(v).some(k => k !== 'id' && (v as any)[k] !== undefined), {
    message: 'Provide at least one field to change besides id.',
  });

const UpdateLightsSchema = z.object({
  sceneIdentifier: sceneTarget,
  lights: z
    .array(UpdateLightSchema)
    .min(1)
    .describe('The light patches to apply (each targets one id).'),
});

const DeleteLightsSchema = z.object({
  sceneIdentifier: sceneTarget,
  lightIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('AmbientLight ids to delete (from list-lights).'),
});

// --- read-only inspect layer for Token / Note (mutation stays in their own tools) ---
const ListTokensSchema = z.object({ sceneIdentifier: sceneTarget });
const ListNotesSchema = z.object({ sceneIdentifier: sceneTarget });

export class PlaceableTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: PlaceableToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'PlaceableTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-tiles',
        description:
          'Place one or more TILES (props, roof/overhead pieces, decals, video overlays) on a scene ' +
          "from Data-relative image paths. A tile's on-map SIZE is width/height in canvas pixels; " +
          'x/y are the absolute-canvas-pixel top-left (see get-scene-dimensions for padding-aware ' +
          'cell→px math). Optionally set rotation, alpha, elevation, sort, texture tint/fit/scale, ' +
          'roof occlusion (occlusionMode: 1 fade / 4 radial so it fades when a token walks under), ' +
          'light/weather restrictions, video loop/autoplay/volume, hidden, locked. Per-tile error ' +
          'isolation; a 404 texture keeps the path but warns. Returns created ids. GM-only.',
        inputSchema: toInputSchema(CreateTilesSchema),
      },
      {
        name: 'list-tiles',
        description:
          'List every Tile on a scene — id, position (x/y), size (width/height), rotation, elevation, ' +
          'sort, texture src, image scale, hidden/locked. Read-only; the inspect step before ' +
          'update-tiles / delete-tiles (you need the ids + current values to edit).',
        inputSchema: toInputSchema(ListTilesSchema),
      },
      {
        name: 'update-tiles',
        description:
          "Edit one or more placed TILES by id (from list-tiles). RESIZE via width/height (the tile's " +
          'on-map size — this is "tile scale"); MOVE via x/y; also rotation, alpha, elevation, sort, ' +
          'texture src/tint/fit/scaleX/scaleY (image zoom within the frame), occlusion, light/weather ' +
          'restrictions, video, hidden, locked. Patches only the fields you pass; unresolved ids are ' +
          'reported, not fatal. GM-only.',
        inputSchema: toInputSchema(UpdateTilesSchema),
      },
      {
        name: 'delete-tiles',
        description:
          'Delete one or more Tiles from a scene by id (from list-tiles). Missing ids are reported, ' +
          'never fatal. GM-only.',
        inputSchema: toInputSchema(DeleteTilesSchema),
      },
      {
        name: 'create-lights',
        description:
          'Place one or more AMBIENT LIGHTS (torches, braziers, magical glows) on a scene. x/y are ' +
          'the light CENTER in absolute canvas pixels; dim/bright are radii in grid-distance units ' +
          '(feet), NOT pixels. Set color, alpha (tint intensity), angle (cone), luminosity, ' +
          'attenuation (edge softness), an animation (animationType "torch"/"flame"/"pulse" + ' +
          'speed/intensity for flicker), and a darkness activation range (darknessMin ~0.1 so a torch ' +
          'only lights once the scene dims). walls confines it, vision lets it grant sight. Per-light ' +
          'error isolation. Returns created ids. GM-only.',
        inputSchema: toInputSchema(CreateLightsSchema),
      },
      {
        name: 'list-lights',
        description:
          'List every AmbientLight on a scene — id, center (x/y), rotation, dim/bright radii, color, ' +
          'cone angle, animation type, hidden, walls/vision. Read-only; the inspect step before ' +
          'update-lights / delete-lights.',
        inputSchema: toInputSchema(ListLightsSchema),
      },
      {
        name: 'update-lights',
        description:
          'Edit one or more placed AMBIENT LIGHTS by id (from list-lights): MOVE via x/y, change ' +
          'dim/bright radii, color, alpha, angle, luminosity, attenuation, the animation ' +
          '(animationType/Speed/Intensity — e.g. add torch flicker), the darkness activation range, ' +
          'walls/vision, hidden. Emission fields nest under config internally — patches only the ' +
          'fields you pass, so a partial change never wipes the rest. Unresolved ids reported. GM-only.',
        inputSchema: toInputSchema(UpdateLightsSchema),
      },
      {
        name: 'delete-lights',
        description:
          'Delete one or more AmbientLights from a scene by id (from list-lights). Missing ids are ' +
          'reported, never fatal. GM-only.',
        inputSchema: toInputSchema(DeleteLightsSchema),
      },
      {
        name: 'list-tokens',
        description:
          'List every PLACED TOKEN on a scene (by id or exact name — any scene, not just the active ' +
          'one) — id, name, position (x/y), size, rotation, elevation, hidden, disposition, actorId, ' +
          'art src + scale, lockRotation. Read-only; the inspect step that feeds update-token (which ' +
          "needs token ids). Token create/delete are the actor's lifecycle, not a scene edit.",
        inputSchema: toInputSchema(ListTokensSchema),
      },
      {
        name: 'list-notes',
        description:
          'List every MAP-NOTE PIN on a scene — id, position (x/y), label text, linked journal ' +
          'entryId/pageId, icon src + size, fog `global`, font. Read-only; the inspect step that feeds ' +
          'update-note / delete-note (create-scene-notes places them).',
        inputSchema: toInputSchema(ListNotesSchema),
      },
    ];
  }

  async handleCreateTiles(args: any): Promise<string> {
    const { sceneIdentifier, tiles } = CreateTilesSchema.parse(args ?? {});
    const result = await this.foundry.call('createSceneTiles', { sceneIdentifier, items: tiles });
    return formatCreatePlaceables(result, 'tile');
  }

  async handleListTiles(args: any): Promise<unknown> {
    const parsed = ListTilesSchema.parse(args ?? {});
    const result = await this.foundry.call('listSceneTiles', parsed);
    return formatListPlaceables(result, 'tile');
  }

  async handleUpdateTiles(args: any): Promise<string> {
    const { sceneIdentifier, tiles } = UpdateTilesSchema.parse(args ?? {});
    const result = await this.foundry.call('updateSceneTiles', { sceneIdentifier, patches: tiles });
    return formatUpdatePlaceables(result, 'tile');
  }

  async handleDeleteTiles(args: any): Promise<string> {
    const { sceneIdentifier, tileIds } = DeleteTilesSchema.parse(args ?? {});
    const result = await this.foundry.call('deleteSceneTiles', { sceneIdentifier, ids: tileIds });
    return formatDeletePlaceables(result, 'tile');
  }

  async handleCreateLights(args: any): Promise<string> {
    const { sceneIdentifier, lights } = CreateLightsSchema.parse(args ?? {});
    const result = await this.foundry.call('createSceneLights', { sceneIdentifier, items: lights });
    return formatCreatePlaceables(result, 'light');
  }

  async handleListLights(args: any): Promise<unknown> {
    const parsed = ListLightsSchema.parse(args ?? {});
    const result = await this.foundry.call('listSceneLights', parsed);
    return formatListPlaceables(result, 'light');
  }

  async handleUpdateLights(args: any): Promise<string> {
    const { sceneIdentifier, lights } = UpdateLightsSchema.parse(args ?? {});
    const result = await this.foundry.call('updateSceneLights', {
      sceneIdentifier,
      patches: lights,
    });
    return formatUpdatePlaceables(result, 'light');
  }

  async handleDeleteLights(args: any): Promise<string> {
    const { sceneIdentifier, lightIds } = DeleteLightsSchema.parse(args ?? {});
    const result = await this.foundry.call('deleteSceneLights', { sceneIdentifier, ids: lightIds });
    return formatDeletePlaceables(result, 'light');
  }

  async handleListTokens(args: any): Promise<unknown> {
    const parsed = ListTokensSchema.parse(args ?? {});
    const result = await this.foundry.call('listSceneTokens', parsed);
    return formatListPlaceables(result, 'token');
  }

  async handleListNotes(args: any): Promise<unknown> {
    const parsed = ListNotesSchema.parse(args ?? {});
    const result = await this.foundry.call('listSceneNotes', parsed);
    return formatListPlaceables(result, 'note');
  }
}
