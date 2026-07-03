// Region tools — create/list/update/delete-region over the page-side Region descriptor
// (src/page/placeables/region.ts), plus the two NAMED SPECIAL OPS outside generic CRUD:
// create-teleporter (two cross-linked regions in one call) and remap-teleporters (post-import
// destination repair). update-region stays SINGLE-target by schema; it rides the kernel batch
// machinery underneath.

import { z } from 'zod';
import { toInputSchema } from '../../utils/schema.js';
import {
  formatCreatePlaceables,
  formatDeletePlaceables,
  formatListPlaceables,
} from '../../utils/placeable-format.js';
import { type PlaceableModuleFactory } from './_module.js';

const RegionShapeSchema = z.object({ type: z.string().optional() }).passthrough();
const RegionBehaviorSchema = z
  .object({ type: z.string().optional(), system: z.object({}).passthrough().optional() })
  .passthrough();

const CreateRegionSchema = z.object({
  sceneIdentifier: z.string().min(1).describe('Scene id or exact name to add the region(s) to.'),
  regions: z
    .array(
      z.object({
        name: z.string().optional().describe('Region label.'),
        color: z.string().optional().describe('Region tint hex, e.g. "#3fb0ff".'),
        visibility: z
          .number()
          .optional()
          .describe(
            'Region visibility: 0 layer (GM-only overlay, the default), 1 gamemaster, 2 always.'
          ),
        shapes: z
          .array(RegionShapeSchema)
          .min(1)
          .describe(
            'v14 region shapes in canvas px, carried whole — rectangle {type:"rectangle",x,y,width,' +
              'height,rotation,hole}, ellipse {type:"ellipse",x,y,radiusX,radiusY,rotation,hole}, or ' +
              'polygon {type:"polygon",points:[x1,y1,...],hole}.'
          ),
        behaviors: z
          .array(RegionBehaviorSchema)
          .optional()
          .describe(
            'Region behaviors carried whole. A teleportToken here needs system.destinations already an ' +
              'array of "Scene.<id>.Region.<id>" UUIDs — for a two-NEW-region teleporter use create-teleporter.'
          ),
      })
    )
    .min(1)
    .describe('One or more regions to create.'),
});

const ListRegionsSchema = z.object({
  sceneIdentifier: z.string().min(1).describe('Scene id or exact name.'),
});

const UpdateRegionSchema = z
  .object({
    sceneIdentifier: z.string().min(1).describe('Scene id or exact name holding the region.'),
    regionId: z
      .string()
      .min(1)
      .describe('Region id (from create-region / create-teleporter / list-regions).'),
    name: z.string().optional().describe('New region label.'),
    color: z.string().optional().describe('New region tint hex.'),
    visibility: z
      .number()
      .optional()
      .describe('New visibility mode (0 layer / 1 gamemaster / 2 always).'),
    shapes: z
      .array(RegionShapeSchema)
      .optional()
      .describe('Replace the region shapes whole (v14 shapes in canvas px).'),
    rect: z
      .object({
        x: z.number().describe('Rectangle CENTER x in canvas px.'),
        y: z.number().describe('Rectangle CENTER y in canvas px.'),
        widthCells: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Width in grid cells (default 1).'),
        heightCells: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Height in grid cells (default 1).'),
        snapToGrid: z.boolean().optional().describe('Snap to the grid (default true).'),
      })
      .optional()
      .describe(
        'Convenience: reshape to ONE grid rectangle centered at (x,y), sized in cells, grid-snapped ' +
          'by default (the move/resize the review loop wants). Ignored if `shapes` is given.'
      ),
  })
  .refine(
    v =>
      v.name !== undefined ||
      v.color !== undefined ||
      v.visibility !== undefined ||
      v.shapes !== undefined ||
      v.rect !== undefined,
    { message: 'Provide at least one field to update (name, color, visibility, shapes, or rect).' }
  );

const DeleteRegionSchema = z.object({
  sceneIdentifier: z.string().min(1).describe('Scene id or exact name holding the region(s).'),
  regionIds: z.array(z.string().min(1)).min(1).describe('Region ids to delete.'),
});

const TeleporterEndpointSchema = z.object({
  sceneIdentifier: z.string().min(1).describe('Scene id or exact name.'),
  x: z
    .number()
    .describe(
      'Trigger CENTER x in canvas px (see get-scene-dimensions for the padding-aware math).'
    ),
  y: z.number().describe('Trigger CENTER y in canvas px.'),
});

const CreateTeleporterSchema = z.object({
  from: TeleporterEndpointSchema.describe('The first endpoint.'),
  to: TeleporterEndpointSchema.describe('The second endpoint (may be the same scene).'),
  twoWay: z
    .boolean()
    .default(true)
    .describe('Wire the return teleporter too (default true). false = one-way from→to.'),
  widthCells: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe('Trigger width in whole grid cells, applied to both ends. Default 1.'),
  heightCells: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe('Trigger height in whole grid cells. Default 1.'),
  snapToGrid: z
    .boolean()
    .default(true)
    .describe('Snap each trigger rectangle to the grid cell(s) under its center (default true).'),
  fromName: z.string().optional().describe('Name for the from-side region.'),
  toName: z.string().optional().describe('Name for the to-side region.'),
  color: z.string().optional().describe('Region tint hex (default "#3fb0ff").'),
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

export const regionToolModule: PlaceableModuleFactory = foundry => ({
  defs: [
    {
      name: 'create-region',
      description:
        'Create one or more Regions on an EXISTING scene (the general primitive behind create-' +
        'teleporter). Each region carries its v14 `shapes` whole (rectangle/ellipse/polygon in canvas ' +
        'px) plus optional color/visibility/behaviors. Behaviors pass through verbatim: a teleportToken ' +
        'here must already have system.destinations = ["Scene.<id>.Region.<id>"] (use create-teleporter ' +
        'for the two-new-region convenience). Returns the created region ids. GM-only.',
      inputSchema: toInputSchema(CreateRegionSchema),
    },
    {
      name: 'list-regions',
      description:
        "List every Region on a scene — id, name, each shape's bounds, and any teleporter " +
        'destinations. Read-only; use it to find region ids for update-region / delete-region.',
      inputSchema: toInputSchema(ListRegionsSchema),
    },
    {
      name: 'update-region',
      description:
        'Update ONE region by id: rename, recolor, change visibility, replace its `shapes` whole, or ' +
        'reshape to a single grid rectangle via the `rect` convenience (center px + cells + snap — the ' +
        "move/resize you'd do reviewing a teleporter). Patches only what you pass; behaviors are left " +
        'untouched. GM-only.',
      inputSchema: toInputSchema(UpdateRegionSchema),
    },
    {
      name: 'delete-region',
      description:
        'Delete one or more Regions from a scene by id. Missing ids are reported, never fatal — and ' +
        'if a surviving teleporter elsewhere still points at a deleted region, that orphan is warned. ' +
        'GM-only.',
      inputSchema: toInputSchema(DeleteRegionSchema),
    },
    {
      name: 'create-teleporter',
      description:
        'Create a two-way (or one-way) region TELEPORTER between two points on existing scenes — the ' +
        'thing create-scene can only do at import time. Give a CENTER point (canvas px) on each scene ' +
        '(`from`/`to`, may be the same scene); a rectangle trigger is placed at each (sized in whole ' +
        'grid cells, grid-snapped by default) and a teleportToken behavior on each points at the OTHER ' +
        '— so a token that walks onto one is sent to the other. Both regions are created before either ' +
        'link is wired (the destination-UUID chicken-and-egg). twoWay:false makes it one-directional. ' +
        'Regions default to GM/Regions-layer visibility (no player-visible overlay). GM-only.',
      inputSchema: toInputSchema(CreateTeleporterSchema),
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
  ],
  handlers: {
    'create-region': async args => {
      const { sceneIdentifier, regions } = CreateRegionSchema.parse(args ?? {});
      const result = await foundry.call('createSceneRegions', { sceneIdentifier, items: regions });
      return formatCreatePlaceables(result, 'region');
    },
    'list-regions': async args => {
      const parsed = ListRegionsSchema.parse(args ?? {});
      const result = await foundry.call('listSceneRegions', parsed);
      return formatListPlaceables(result, 'region');
    },
    'update-region': async args => {
      const { sceneIdentifier, regionId, ...fields } = UpdateRegionSchema.parse(args ?? {});
      const result = await foundry.call('updateSceneRegions', {
        sceneIdentifier,
        patches: [{ id: regionId, ...fields }],
      });
      if (result?.notFound) return `Scene not found: "${result.notFound}". Nothing changed.`;
      if ((result?.matched ?? 0) === 0) {
        return `Region not found: "${regionId}". Nothing changed.`;
      }
      const region: any = result?.items?.[0];
      const shape = region?.shapes?.[0];
      const shapeStr = shape
        ? ` — ${shape.type}${shape.width !== undefined ? ` ${shape.width}×${shape.height}px @ (${shape.x},${shape.y})` : ''}`
        : '';
      return `Updated region ${region?.id ?? regionId} on "${result?.sceneName}" (${result?.sceneId})${shapeStr}.`;
    },
    'delete-region': async args => {
      const { sceneIdentifier, regionIds } = DeleteRegionSchema.parse(args ?? {});
      const result = await foundry.call('deleteSceneRegions', { sceneIdentifier, ids: regionIds });
      return formatDeletePlaceables(result, 'region');
    },
    'create-teleporter': async args => {
      const parsed = CreateTeleporterSchema.parse(args ?? {});
      const result = await foundry.call('createSceneTeleporter', parsed);
      if (result?.notFound) {
        return `Scene not found: "${result.notFound}". No teleporter created.`;
      }
      const dest = (r: any) =>
        r?.behaviors?.find((b: any) => b.destinations?.length)?.destinations?.[0] ?? '(none)';
      const dir = result?.twoWay ? '⇄' : '→';
      return (
        `Created ${result?.twoWay ? 'two-way' : 'one-way'} teleporter:\n` +
        `  • ${result?.from?.sceneName} region ${result?.from?.id} (${result?.from?.name}) ${dir} ${result?.to?.sceneName}\n` +
        `      → ${dest(result?.from)}\n` +
        `  • ${result?.to?.sceneName} region ${result?.to?.id} (${result?.to?.name})` +
        (result?.twoWay ? `\n      → ${dest(result?.to)}` : ' (no return link)')
      );
    },
    'remap-teleporters': async args => {
      const parsed = RemapTeleportersSchema.parse(args ?? {});
      const result = await foundry.call('remapSceneTeleporters', parsed);
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
    },
  },
});
