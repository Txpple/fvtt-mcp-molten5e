// Wall CRUD tools — over the page-side Wall descriptor (src/page/placeables/wall.ts).
//
// Walls are normally DRAWN in the Foundry app or shipped by a map pack — bulk authoring stays there.
// These tools exist for the edit loop the app is slow at: flip a door to secret, lock/open door
// states in batch, fix a sight-blocking wall, patch a proximity threshold — plus surgical add/delete.
// A wall's position is a SEGMENT (x0,y0 → x1,y1 in absolute canvas px), the only placeable with no
// x/y point.

import { z } from 'zod';
import { toInputSchema } from '../../utils/schema.js';
import {
  formatCreatePlaceables,
  formatDeletePlaceables,
  formatListPlaceables,
  formatUpdatePlaceables,
} from '../../utils/placeable-format.js';
import { sceneTarget, type PlaceableModuleFactory } from './_module.js';

const wallChannelFields = {
  move: z
    .number()
    .int()
    .optional()
    .describe('Movement blocking: 0 pass-through, 20 block (default 20).'),
  light: z
    .number()
    .int()
    .optional()
    .describe(
      'Light blocking (WALL_SENSE_TYPES): 0 none, 10 limited, 20 normal (default), 30 proximity, ' +
        '40 distance.'
    ),
  sight: z
    .number()
    .int()
    .optional()
    .describe(
      'Vision blocking: 0 none (see-through: railings, windows), 10 limited, 20 normal (default), ' +
        '30 proximity, 40 distance.'
    ),
  sound: z
    .number()
    .int()
    .optional()
    .describe(
      'Sound blocking: 0 none, 10 limited, 20 normal (default), 30 proximity, 40 distance.'
    ),
  dir: z
    .number()
    .int()
    .optional()
    .describe('One-way direction: 0 both (default), 1 left, 2 right.'),
  door: z
    .number()
    .int()
    .optional()
    .describe('Door kind: 0 not a door (default), 1 door, 2 SECRET door.'),
  ds: z.number().int().optional().describe('Door state: 0 closed (default), 1 open, 2 LOCKED.'),
  doorSound: z
    .string()
    .optional()
    .describe('Door sound key, e.g. "woodBasic", "metal", "stoneBasic".'),
  thresholdLight: z
    .number()
    .nullable()
    .optional()
    .describe('Proximity threshold for light in grid-distance units (null clears).'),
  thresholdSight: z
    .number()
    .nullable()
    .optional()
    .describe('Proximity threshold for sight in grid-distance units (null clears).'),
  thresholdSound: z
    .number()
    .nullable()
    .optional()
    .describe('Proximity threshold for sound in grid-distance units (null clears).'),
  thresholdAttenuation: z
    .boolean()
    .optional()
    .describe('Attenuate (soften) instead of hard-cutting at the threshold.'),
};

const CreateWallsSchema = z.object({
  sceneIdentifier: sceneTarget,
  walls: z
    .array(
      z.object({
        x0: z.number().optional().describe('Segment start X in absolute canvas pixels.'),
        y0: z.number().optional().describe('Segment start Y.'),
        x1: z.number().optional().describe('Segment end X.'),
        y1: z.number().optional().describe('Segment end Y.'),
        c: z
          .array(z.number())
          .length(4)
          .optional()
          .describe('Alternative to x0..y1: the whole segment as [x0,y0,x1,y1].'),
        ...wallChannelFields,
      })
    )
    .min(1)
    .describe('One or more wall segments to create (omitted channels default to blocking).'),
});

const ListWallsSchema = z.object({
  sceneIdentifier: sceneTarget,
  doorsOnly: z
    .boolean()
    .optional()
    .describe(
      'Return only DOOR walls (door > 0) — a populated scene carries hundreds of plain walls, and ' +
        'the usual edit loop is doors. Default false (all walls).'
    ),
});

const UpdateWallSchema = z
  .object({
    id: z.string().min(1).describe('Wall id (from list-walls).'),
    x0: z.number().optional().describe('Move: new segment start X (provide ALL of x0,y0,x1,y1).'),
    y0: z.number().optional().describe('Move: new segment start Y.'),
    x1: z.number().optional().describe('Move: new segment end X.'),
    y1: z.number().optional().describe('Move: new segment end Y.'),
    c: z
      .array(z.number())
      .length(4)
      .optional()
      .describe('Move: the whole new segment as [x0,y0,x1,y1].'),
    ...wallChannelFields,
  })
  .refine(v => Object.keys(v).some(k => k !== 'id' && (v as any)[k] !== undefined), {
    message: 'Provide at least one field to change besides id.',
  });

const UpdateWallsSchema = z.object({
  sceneIdentifier: sceneTarget,
  walls: z
    .array(UpdateWallSchema)
    .min(1)
    .describe('The wall patches to apply (each targets one id).'),
});

const DeleteWallsSchema = z.object({
  sceneIdentifier: sceneTarget,
  wallIds: z.array(z.string().min(1)).min(1).describe('Wall ids to delete (from list-walls).'),
});

export const wallToolModule: PlaceableModuleFactory = foundry => ({
  defs: [
    {
      name: 'create-walls',
      description:
        'Create one or more WALL segments on a scene — surgical additions (block a corridor, add a ' +
        'door/secret door) to walls normally drawn in the app or shipped by a map pack. Each wall is ' +
        'a segment x0,y0→x1,y1 (or c:[4]) in absolute canvas pixels. Channels: move (0/20), ' +
        'light/sight/sound (0 none / 10 limited / 20 normal / 30 proximity / 40 distance — omitted ' +
        'channels default to 20 blocking), dir (one-way), door (1 door / 2 secret) + ds (state) + ' +
        'doorSound, and proximity thresholds. Per-wall error isolation. Returns created ids. GM-only.',
      inputSchema: toInputSchema(CreateWallsSchema),
    },
    {
      name: 'list-walls',
      description:
        'List walls on a scene — id, segment c:[x0,y0,x1,y1], move/sight/light/sound channels, ' +
        'one-way dir, door kind + state + sound. A populated scene carries HUNDREDS of walls: pass ' +
        'doorsOnly:true to get just the doors (the usual edit loop). Read-only; the inspect step ' +
        'before update-walls / delete-walls.',
      inputSchema: toInputSchema(ListWallsSchema),
    },
    {
      name: 'update-walls',
      description:
        'Edit one or more WALLS by id (from list-walls): flip a door to secret (door:2), open/close/' +
        'LOCK it (ds: 0/1/2), change what it blocks (move/light/sight/sound: 0 none / 10 limited / ' +
        '20 normal / 30 proximity / 40 distance), set one-way dir, doorSound, or proximity ' +
        'thresholds; MOVE by giving the full segment (all of x0,y0,x1,y1 or c:[4] — a wall never ' +
        'half-moves). Patches only the fields you pass; an off-enum value skips that patch with a ' +
        'warning. GM-only.',
      inputSchema: toInputSchema(UpdateWallsSchema),
    },
    {
      name: 'delete-walls',
      description:
        'Delete one or more Walls from a scene by id (from list-walls) — e.g. open up a sealed ' +
        'passage. Missing ids are reported, never fatal. GM-only.',
      inputSchema: toInputSchema(DeleteWallsSchema),
    },
  ],
  handlers: {
    'create-walls': async args => {
      const { sceneIdentifier, walls } = CreateWallsSchema.parse(args ?? {});
      const result = await foundry.call('createSceneWalls', { sceneIdentifier, items: walls });
      return formatCreatePlaceables(result, 'wall');
    },
    'list-walls': async args => {
      const parsed = ListWallsSchema.parse(args ?? {});
      const result = await foundry.call('listSceneWalls', parsed);
      return formatListPlaceables(result, 'wall');
    },
    'update-walls': async args => {
      const { sceneIdentifier, walls } = UpdateWallsSchema.parse(args ?? {});
      const result = await foundry.call('updateSceneWalls', { sceneIdentifier, patches: walls });
      return formatUpdatePlaceables(result, 'wall');
    },
    'delete-walls': async args => {
      const { sceneIdentifier, wallIds } = DeleteWallsSchema.parse(args ?? {});
      const result = await foundry.call('deleteSceneWalls', { sceneIdentifier, ids: wallIds });
      return formatDeletePlaceables(result, 'wall');
    },
  },
});
