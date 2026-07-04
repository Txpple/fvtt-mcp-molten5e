// Placed-token tools — list / place / update / delete a token INSTANCE on a scene.
//
// The lifecycle split this module documents: PLACE copies the actor's prototype token onto the map
// (batch encounter prep — the GM usually just drags); UPDATE is the bespoke actor→all-copies editor
// with the lockRotation gotcha; DELETE removes the placed instance only (the sidebar actor is
// delete-actor's job). Page-side correctness lives in src/page/placeables/token.ts.

import { z } from 'zod';
import { toInputSchema } from '../../utils/schema.js';
import {
  formatCreatePlaceables,
  formatDeletePlaceables,
  formatListPlaceables,
} from '../../utils/placeable-format.js';
import { sceneTarget, type PlaceableModuleFactory } from './_module.js';

const ListTokensSchema = z.object({ sceneIdentifier: sceneTarget });

const PlaceTokensSchema = z.object({
  sceneIdentifier: sceneTarget,
  tokens: z
    .array(
      z.object({
        actor: z.string().min(1).describe('Actor id or EXACT name whose prototype token to place.'),
        x: z.number().describe('Token X in absolute canvas pixels (top-left of its space).'),
        y: z.number().describe('Token Y in absolute canvas pixels.'),
        hidden: z.boolean().optional().describe('Place hidden from players (GM reveal later).'),
        elevation: z.number().optional().describe('Elevation in grid-distance units.'),
        rotation: z.number().optional().describe('Facing in degrees (0–359).'),
        name: z.string().optional().describe('Nameplate override (default: the prototype name).'),
        disposition: z
          .enum(['friendly', 'neutral', 'hostile', 'secret'])
          .optional()
          .describe('Override the prototype disposition for THIS placed copy.'),
      })
    )
    .min(1)
    .describe('The tokens to place (one per entry — repeat an actor to place several copies).'),
});

const DeleteTokensSchema = z.object({
  sceneIdentifier: sceneTarget,
  tokenIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('Placed-token ids to remove (from list-tokens). The sidebar actor is untouched.'),
});

// --- update-token (bespoke — actor→all-copies matching + the lockRotation gotcha) ---
const UpdateTokenSchema = z
  .object({
    sceneIdentifier: z
      .string()
      .min(1)
      .optional()
      .describe('Scene id or exact name holding the token(s). Omit to use the ACTIVE scene.'),
    tokenIds: z
      .array(z.string().min(1))
      .optional()
      .describe('Placed-token ids to update (from list-tokens). Combined (union) with actorIds.'),
    actorIds: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Actor id OR exact actor name — updates ALL placed copies of each (e.g. every "Dead Guard" ' +
          'token on the map). Combined (union) with tokenIds.'
      ),
    rotation: z
      .number()
      .optional()
      .describe('Facing in degrees (0–359), applied to every matched token.'),
    randomizeRotation: z
      .boolean()
      .optional()
      .describe(
        'Give each matched token its OWN random angle (0–359) instead of one shared `rotation` — ' +
          'e.g. to strew corpses naturally. Overrides `rotation` when true.'
      ),
    scale: z
      .number()
      .positive()
      .optional()
      .describe(
        'Token ART scale (sets texture.scaleX and scaleY together). 1 = normal, 1.5 = 50% larger.'
      ),
    elevation: z
      .number()
      .optional()
      .describe('Token elevation in grid-distance units (e.g. feet).'),
    hidden: z
      .boolean()
      .optional()
      .describe('Hide (true) or reveal (false) the token from players.'),
    lockRotation: z
      .boolean()
      .optional()
      .describe(
        'Lock the token art from rotating. NOTE: lockRotation:true HIDES any `rotation` you set, so ' +
          'when you rotate a locked token and omit this, the tool AUTO-UNLOCKS it (and warns) so the ' +
          'angle is visible.'
      ),
    x: z.number().optional().describe('New token X in absolute canvas pixels.'),
    y: z.number().optional().describe('New token Y in absolute canvas pixels.'),
    name: z.string().min(1).optional().describe('Rename the placed token (its nameplate).'),
    displayName: z
      .enum(['none', 'control', 'owner-hover', 'hover', 'owner', 'always'])
      .optional()
      .describe(
        'Nameplate visibility: none | control (only when selected) | owner-hover | hover | ' +
          'owner (always, to owners) | always (always, to everyone).'
      ),
    displayBars: z
      .enum(['none', 'control', 'owner-hover', 'hover', 'owner', 'always'])
      .optional()
      .describe(
        'Resource (health) bar visibility, same modes as displayName: none | control | ' +
          'owner-hover | hover | owner | always.'
      ),
    bar1: z
      .string()
      .optional()
      .describe('Bar 1 resource attribute path (health bar is "attributes.hp"); "" clears it.'),
    bar2: z
      .string()
      .optional()
      .describe('Bar 2 resource attribute path (e.g. "attributes.hp"); "" clears it.'),
    ring: z
      .boolean()
      .optional()
      .describe(
        'Dynamic token ring: false = plain token (the house default), true = ring on. ' +
          'Sets ring.enabled on the placed token.'
      ),
    hp: z
      .object({
        value: z.number().int().optional().describe('Current hit points.'),
        max: z.number().int().optional().describe('Max hit points.'),
        temp: z.number().int().optional().describe('Temporary hit points.'),
        tempmax: z.number().int().optional().describe('Max-HP modifier (system.attributes.hp.tempmax).'),
      })
      .optional()
      .describe(
        "Set THIS placed token's hit points on its own actor — PER-TOKEN, so two copies of the same " +
          'actor can differ (e.g. a band wounded to different HP). Writes system.attributes.hp.* on the ' +
          "token's (unlinked) delta, NOT the prototype/statblock — the right home for a token's current " +
          'HP. For a linked token it writes the shared base actor. Only the sub-fields you pass change; ' +
          '0 is valid (a downed creature).'
      ),
  })
  .refine(v => (v.tokenIds?.length ?? 0) > 0 || (v.actorIds?.length ?? 0) > 0, {
    message: 'Provide at least one target: tokenIds and/or actorIds.',
  })
  .refine(
    v =>
      v.rotation !== undefined ||
      v.randomizeRotation === true ||
      v.scale !== undefined ||
      v.elevation !== undefined ||
      v.hidden !== undefined ||
      v.lockRotation !== undefined ||
      v.x !== undefined ||
      v.y !== undefined ||
      v.name !== undefined ||
      v.displayName !== undefined ||
      v.displayBars !== undefined ||
      v.bar1 !== undefined ||
      v.bar2 !== undefined ||
      v.ring !== undefined ||
      v.hp !== undefined,
    {
      message:
        'Provide at least one field to change (rotation, randomizeRotation, scale, elevation, hidden, lockRotation, x, y, name, displayName, displayBars, bar1, bar2, ring, or hp).',
    }
  );

export const tokenToolModule: PlaceableModuleFactory = foundry => ({
  defs: [
    {
      name: 'list-tokens',
      description:
        'List every PLACED TOKEN on a scene (by id or exact name — any scene, not just the active ' +
        'one) — id, name, position (x/y), size, rotation, elevation, hidden, disposition, actorId, ' +
        'art src + scale, lockRotation. Read-only; the inspect step that feeds update-token / ' +
        'delete-tokens. The token ids also work as the actorIdentifier of the actor tools (get-actor, ' +
        'update-actor, update-actor-item, remove-from-actor, add-item/add-feature, import-item, ' +
        "manage-activity/-effect, apply-condition) — targeting a token id edits THAT instance's own " +
        'delta, the way to re-gear/wound ONE placed copy of an unlinked NPC (base-actor edits never ' +
        'reach tokens already on a scene).',
      inputSchema: toInputSchema(ListTokensSchema),
    },
    {
      name: 'place-tokens',
      description:
        "Place one or more actors' tokens on a scene (batch encounter prep — e.g. drop the whole " +
        'hobgoblin band on the bridge). Each entry names an actor (id or EXACT name) + an absolute ' +
        "canvas-pixel x/y; the token is built from the actor's PROTOTYPE (so the house token " +
        'defaults — auto-rotate, ring, disposition — carry over), with optional per-copy hidden/' +
        'elevation/rotation/name/disposition overrides. Repeat an actor for several copies. The GM ' +
        'can always drag tokens in the app instead — this is for scripted/batch placement. GM-only.',
      inputSchema: toInputSchema(PlaceTokensSchema),
    },
    {
      name: 'update-token',
      description:
        'Edit one or more PLACED tokens on a scene — a token INSTANCE already dropped on the map, NOT ' +
        "the actor's prototype token (that's update-actor). Resolve the scene by id/exact name " +
        '(default: the ACTIVE scene), then target tokens by `tokenIds` and/or `actorIds` (an actor id ' +
        'OR exact name — updates EVERY placed copy of that actor, e.g. all "Dead Guard" corpses). Patch ' +
        'any of: `rotation` (or `randomizeRotation` for an independent per-token angle), `scale` (token ' +
        'art size — sets texture.scaleX/scaleY together), `elevation`, `hidden`, `lockRotation`, `x`/`y`, ' +
        '`name`, `displayName` (nameplate visibility), `displayBars` (resource-bar visibility), `bar1`/`bar2` ' +
        '(which resource each bar tracks — the health bar is bar1 = attributes.hp), `ring` (dynamic token ' +
        "ring on/off), and `hp` (this token's CURRENT hit points, per-token on its own delta — so two copies " +
        'of one actor can be wounded differently, which update-actor cannot do) — all matched tokens update in ' +
        'one batch. GOTCHA handled for you: a token whose actor had ' +
        'auto-rotate OFF carries lockRotation:true, which HIDES a set rotation — so when you rotate a ' +
        'locked token the tool auto-unlocks it and warns. Reports matched/updated counts + any ' +
        'unresolved ids. GM-only.',
      inputSchema: toInputSchema(UpdateTokenSchema),
    },
    {
      name: 'delete-tokens',
      description:
        'Remove one or more PLACED tokens from a scene by token id (from list-tokens) — clears the ' +
        'map instance only; the sidebar actor survives (delete-actor removes that). Missing ids are ' +
        'reported, never fatal. GM-only.',
      inputSchema: toInputSchema(DeleteTokensSchema),
    },
  ],
  handlers: {
    'list-tokens': async args => {
      const parsed = ListTokensSchema.parse(args ?? {});
      const result = await foundry.call('listSceneTokens', parsed);
      return formatListPlaceables(result, 'token');
    },
    'place-tokens': async args => {
      const { sceneIdentifier, tokens } = PlaceTokensSchema.parse(args ?? {});
      const result = await foundry.call('placeSceneTokens', { sceneIdentifier, items: tokens });
      return formatCreatePlaceables(result, 'token');
    },
    'update-token': async args => {
      const parsed = UpdateTokenSchema.parse(args ?? {});
      const result = await foundry.call('updateSceneTokens', parsed);
      if (result?.notFound) {
        return `Scene not found: "${result.notFound}". Nothing changed.`;
      }
      const um = result?.unmatched ?? {};
      const umBits = [
        ...(um.tokenIds?.length ? [`token ${um.tokenIds.join(', ')}`] : []),
        ...(um.actorIds?.length ? [`actor ${um.actorIds.join(', ')}`] : []),
      ];
      if ((result?.matched ?? 0) === 0) {
        return (
          `No tokens matched on "${result?.sceneName}" (${result?.sceneId})` +
          (umBits.length ? ` — unresolved ${umBits.join('; ')}` : '') +
          '.'
        );
      }
      const rows = Array.isArray(result?.tokens)
        ? result.tokens
            .map(
              (t: any) =>
                `\n  • ${t.name} (${t.id}) — rot ${t.rotation}°, scale ${t.scale}, elev ${t.elevation}` +
                `${t.hidden ? ', hidden' : ''}, name ${t.displayName}, bars ${t.displayBars}` +
                `${t.bar1 ? ` (${t.bar1})` : ''}, ring ${t.ring ? 'on' : 'off'}` +
                `${t.hp ? `, hp ${t.hp.value}/${t.hp.max}` : ''}`
            )
            .join('')
        : '';
      const warns = Array.isArray(result?.warnings) ? result.warnings : [];
      const warnLine = warns.length
        ? `\n\n⚠️ ${warns.length} note(s):\n${warns.map((w: string) => `- ${w}`).join('\n')}`
        : '';
      const umLine = umBits.length ? `\n  (unresolved: ${umBits.join('; ')})` : '';
      return (
        `Updated ${result?.updated ?? 0} of ${result?.matched ?? 0} matched token(s) on ` +
        `"${result?.sceneName}" (${result?.sceneId})` +
        rows +
        umLine +
        warnLine
      );
    },
    'delete-tokens': async args => {
      const { sceneIdentifier, tokenIds } = DeleteTokensSchema.parse(args ?? {});
      const result = await foundry.call('deleteSceneTokens', { sceneIdentifier, ids: tokenIds });
      return formatDeletePlaceables(result, 'token');
    },
  },
});
