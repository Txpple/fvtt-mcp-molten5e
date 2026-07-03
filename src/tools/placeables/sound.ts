// AmbientSound CRUD tools — positional scene audio (a crackling hearth, a waterfall, dungeon drips)
// over the page-side Sound descriptor (src/page/placeables/sound.ts). Composes with playlist-builder:
// a playlist is scene-wide music; an AmbientSound is a POINT emitter with a radius the players walk
// into. x/y are the emitter CENTER in absolute canvas pixels; radius is grid-distance units (feet).

import { z } from 'zod';
import { toInputSchema } from '../../utils/schema.js';
import {
  formatCreatePlaceables,
  formatDeletePlaceables,
  formatListPlaceables,
  formatUpdatePlaceables,
} from '../../utils/placeable-format.js';
import { sceneTarget, type PlaceableModuleFactory } from './_module.js';

const soundFields = {
  name: z.string().optional().describe('Label shown in the sounds layer (e.g. "Waterfall").'),
  repeat: z.boolean().optional().describe('Loop the track when it ends (default false).'),
  volume: z.number().min(0).max(1).optional().describe('Playback volume 0–1 (default 0.5).'),
  walls: z.boolean().optional().describe('Muffle/block the sound through walls (default true).'),
  easing: z
    .boolean()
    .optional()
    .describe('Fade volume by distance from the emitter (default true).'),
  hidden: z.boolean().optional().describe('Disable the emitter without deleting it (GM toggle).'),
  elevation: z.number().optional().describe('Emitter elevation in grid-distance units.'),
  darknessMin: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Only play when scene darkness ≥ this (0–1) — e.g. night-only crickets.'),
  darknessMax: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Only play when scene darkness ≤ this (0–1).'),
  baseEffect: z
    .string()
    .optional()
    .describe('Audio effect key applied to listeners in range, e.g. "lowpass" / "highpass".'),
  baseEffectIntensity: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Effect intensity 1–10.'),
  muffledEffect: z
    .string()
    .optional()
    .describe('Effect when the listener is behind a wall (walls:true), e.g. "lowpass".'),
  muffledEffectIntensity: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Muffled-effect intensity 1–10.'),
};

const CreateSoundsSchema = z.object({
  sceneIdentifier: sceneTarget,
  sounds: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .describe('Data-relative audio file path (upload-asset first if needed).'),
        x: z.number().describe('Emitter center X in absolute canvas pixels.'),
        y: z.number().describe('Emitter center Y in absolute canvas pixels.'),
        radius: z
          .number()
          .positive()
          .describe('Audible radius in grid-DISTANCE units (e.g. feet), NOT pixels.'),
        ...soundFields,
      })
    )
    .min(1)
    .describe('One or more positional ambient sounds to place.'),
});

const ListSoundsSchema = z.object({ sceneIdentifier: sceneTarget });

const UpdateSoundSchema = z
  .object({
    id: z.string().min(1).describe('AmbientSound id (from list-sounds).'),
    x: z.number().optional().describe('New center X in canvas pixels.'),
    y: z.number().optional().describe('New center Y in canvas pixels.'),
    radius: z.number().positive().optional().describe('New audible radius in grid-distance units.'),
    path: z.string().min(1).optional().describe('Swap the audio track (Data-relative path).'),
    ...soundFields,
  })
  .refine(v => Object.keys(v).some(k => k !== 'id' && (v as any)[k] !== undefined), {
    message: 'Provide at least one field to change besides id.',
  });

const UpdateSoundsSchema = z.object({
  sceneIdentifier: sceneTarget,
  sounds: z
    .array(UpdateSoundSchema)
    .min(1)
    .describe('The sound patches to apply (each targets one id).'),
});

const DeleteSoundsSchema = z.object({
  sceneIdentifier: sceneTarget,
  soundIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('AmbientSound ids to delete (from list-sounds).'),
});

export const soundToolModule: PlaceableModuleFactory = foundry => ({
  defs: [
    {
      name: 'create-sounds',
      description:
        'Place one or more positional AMBIENT SOUNDS on a scene (a crackling hearth, a waterfall, ' +
        'dripping cave water) from Data-relative audio paths. x/y are the emitter CENTER in absolute ' +
        'canvas pixels; radius is in grid-DISTANCE units (feet), NOT pixels. Optionally set volume, ' +
        'repeat (loop), walls (muffle through walls), easing (fade by distance), a darkness ' +
        'activation range (night-only sounds), and listener effects (baseEffect/muffledEffect, e.g. ' +
        '"lowpass"). A 404 audio path keeps the path but warns. Distinct from a scene playlist: this ' +
        'is a point emitter players walk into. Returns created ids. GM-only.',
      inputSchema: toInputSchema(CreateSoundsSchema),
    },
    {
      name: 'list-sounds',
      description:
        'List every AmbientSound on a scene — id, name, center (x/y), radius, audio path, volume, ' +
        'repeat/walls/easing flags, darkness range, base effect. Read-only; the inspect step before ' +
        'update-sounds / delete-sounds.',
      inputSchema: toInputSchema(ListSoundsSchema),
    },
    {
      name: 'update-sounds',
      description:
        'Edit one or more placed AMBIENT SOUNDS by id (from list-sounds): MOVE via x/y, resize the ' +
        'audible radius, swap the track (path), change volume/repeat/walls/easing, the darkness ' +
        'activation range, or the listener effects. Patches only the fields you pass. Unresolved ids ' +
        'reported, never fatal. GM-only.',
      inputSchema: toInputSchema(UpdateSoundsSchema),
    },
    {
      name: 'delete-sounds',
      description:
        'Delete one or more AmbientSounds from a scene by id (from list-sounds). Missing ids are ' +
        'reported, never fatal. GM-only.',
      inputSchema: toInputSchema(DeleteSoundsSchema),
    },
  ],
  handlers: {
    'create-sounds': async args => {
      const { sceneIdentifier, sounds } = CreateSoundsSchema.parse(args ?? {});
      const result = await foundry.call('createSceneSounds', { sceneIdentifier, items: sounds });
      return formatCreatePlaceables(result, 'sound');
    },
    'list-sounds': async args => {
      const parsed = ListSoundsSchema.parse(args ?? {});
      const result = await foundry.call('listSceneSounds', parsed);
      return formatListPlaceables(result, 'sound');
    },
    'update-sounds': async args => {
      const { sceneIdentifier, sounds } = UpdateSoundsSchema.parse(args ?? {});
      const result = await foundry.call('updateSceneSounds', { sceneIdentifier, patches: sounds });
      return formatUpdatePlaceables(result, 'sound');
    },
    'delete-sounds': async args => {
      const { sceneIdentifier, soundIds } = DeleteSoundsSchema.parse(args ?? {});
      const result = await foundry.call('deleteSceneSounds', { sceneIdentifier, ids: soundIds });
      return formatDeletePlaceables(result, 'sound');
    },
  },
});
