// Page-side Token placeable functions: LIST + PLACE + DELETE over the kernel, UPDATE bespoke.
//
// A placed token is an actor INSTANCE on a scene. The lifecycle rules this file owns:
//  - PLACE (create) goes through the actor's prototype token via `actor.getTokenDocument()` — the
//    same machinery a GM drag uses — so the house token defaults baked into the prototype at actor
//    creation (auto-rotate, ring, disposition) carry onto the map. Placement is skeletal by design:
//    the GM drags tokens in the app; this exists for batch encounter prep ("place the hobgoblin band").
//  - UPDATE stays the bespoke `updateSceneTokens` (update-token tool): its actor→ALL-copies matching
//    and the lockRotation auto-unlock gotcha don't fit the kernel's generic id-keyed patch.
//  - DELETE removes the placed instance only — the sidebar actor is untouched (that's delete-actor).

import {
  crudCreate,
  crudDelete,
  crudList,
  type CreateDocResult,
  type PlaceableDescriptor,
} from '../_placeables.js';
import { resolveSceneStrict } from '../scenes.js';

const DISPOSITION_NAME: Record<number, string> = {
  [-2]: 'secret',
  [-1]: 'hostile',
  0: 'neutral',
  1: 'friendly',
};
const DISPOSITION_NUMBER: Record<string, number> = {
  secret: -2,
  hostile: -1,
  neutral: 0,
  friendly: 1,
};

// Nameplate / resource-bar visibility (CONST.TOKEN_DISPLAY_MODES). Friendly key ↔ Foundry number.
const DISPLAY_MODES: Record<string, number> = {
  none: 0,
  control: 10,
  'owner-hover': 20,
  hover: 30,
  owner: 40,
  always: 50,
};
const DISPLAY_MODE_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(DISPLAY_MODES).map(([k, v]) => [v, k])
);

export interface TokenPlaceInput {
  actor?: string;
  x?: number;
  y?: number;
  hidden?: boolean;
  elevation?: number;
  rotation?: number;
  name?: string;
  disposition?: string;
}

/**
 * PURE: build the override object layered onto the actor's prototype token for one placement.
 * Only supplied fields override the prototype (so house defaults survive); `disposition` maps the
 * friendly name to the CONST number. Returns an error for an unknown disposition instead of
 * writing a NaN. Exported for unit testing.
 */
export function tokenPlacementOverrides(input: TokenPlaceInput): {
  overrides?: Record<string, unknown>;
  error?: string;
} {
  for (const k of ['x', 'y'] as const) {
    if (typeof input[k] !== 'number') return { error: `${k} is required (a number)` };
  }
  const overrides: Record<string, unknown> = { x: input.x, y: input.y };
  if (typeof input.hidden === 'boolean') overrides.hidden = input.hidden;
  if (typeof input.elevation === 'number') overrides.elevation = input.elevation;
  if (typeof input.rotation === 'number') overrides.rotation = input.rotation;
  if (typeof input.name === 'string' && input.name.trim() !== '')
    overrides.name = input.name.trim();
  if (input.disposition !== undefined) {
    const d = DISPOSITION_NUMBER[String(input.disposition).toLowerCase()];
    if (d === undefined) {
      return {
        error: `unknown disposition "${input.disposition}" (friendly, neutral, hostile, or secret)`,
      };
    }
    overrides.disposition = d;
  }
  return { overrides };
}

/**
 * Resolve the actor (id or EXACT name) and build the token create-doc from its prototype with the
 * placement overrides applied. Prefers `actor.getTokenDocument()` (core's own drag-drop machinery —
 * handles wildcard art and prototype merge); falls back to a manual prototype spread if a future
 * core drops it.
 */
async function toCreateDoc(input: TokenPlaceInput): Promise<CreateDocResult> {
  if (!input?.actor || typeof input.actor !== 'string') {
    return { error: 'actor is required (actor id or exact name)' };
  }
  const actor =
    game.actors?.get(input.actor) ?? game.actors?.find((a: any) => a.name === input.actor);
  if (!actor) return { error: `actor not found: "${input.actor}" (id or exact name)` };

  const { overrides, error } = tokenPlacementOverrides(input);
  if (error) return { error };

  let doc: Record<string, unknown>;
  if (typeof (actor as any).getTokenDocument === 'function') {
    const td = await (actor as any).getTokenDocument(overrides);
    doc = td.toObject();
    delete doc._id; // the create path mints a fresh id
  } else {
    doc = { ...(actor as any).prototypeToken.toObject(), actorId: actor.id, ...overrides };
    delete doc.randomImg; // prototype-only field — not part of the TokenDocument schema
  }
  return { doc };
}

function dump(doc: any): Record<string, unknown> {
  return {
    id: doc.id,
    name: doc.name,
    x: doc.x,
    y: doc.y,
    width: doc.width,
    height: doc.height,
    rotation: doc.rotation,
    elevation: doc.elevation,
    hidden: doc.hidden,
    lockRotation: doc.lockRotation,
    disposition: DISPOSITION_NAME[doc.disposition] ?? doc.disposition,
    actorId: doc.actorId || null,
    src: doc.texture?.src,
    scale: doc.texture?.scaleX,
    sort: doc.sort,
  };
}

export const tokenDescriptor: PlaceableDescriptor = {
  docName: 'Token',
  collection: (scene: any) => scene.tokens,
  dump,
  toCreateDoc,
  // NO buildPatch — placed-token mutation stays in the bespoke updateSceneTokens below.
};

// --- bespoke placed-token UPDATE (the update-token tool) ----------------------

/** The current-state token fields buildTokenUpdate reads (a minimal, testable slice of TokenDocument). */
export interface TokenLike {
  id: string;
  name?: string;
  lockRotation?: boolean;
}

/** The mutations update-token can apply to a placed token. */
export interface TokenPatchArgs {
  rotation?: number;
  randomizeRotation?: boolean;
  scale?: number;
  elevation?: number;
  hidden?: boolean;
  lockRotation?: boolean;
  x?: number;
  y?: number;
  name?: string;
  displayName?: string; // nameplate visibility mode key (DISPLAY_MODES)
  displayBars?: string; // resource-bar visibility mode key (DISPLAY_MODES)
  bar1?: string; // bar1 resource attribute (e.g. "attributes.hp"); "" clears it
  bar2?: string; // bar2 resource attribute; "" clears it
  ring?: boolean; // dynamic token ring on/off (ring.enabled)
  hp?: TokenHpArgs; // per-token hit points, written to the token's OWN actor (delta) — see buildHpPatch
}

/** The hit-point sub-fields update-token can set on a placed token's own actor. */
export interface TokenHpArgs {
  value?: number; // current HP
  max?: number; // max HP
  temp?: number; // temporary HP
  tempmax?: number; // max-HP modifier (system.attributes.hp.tempmax)
}

/**
 * PURE: build the `updateEmbeddedDocuments("Token", …)` patch for ONE token, plus any warnings, from
 * the token's current state and the requested changes. Extracted from updateSceneTokens so the tricky
 * bits are unit-testable without a live game.
 *
 * The baked-in GOTCHA: a token whose prototype had auto-rotate OFF carries `lockRotation:true`, which
 * makes Foundry IGNORE the token's `rotation` visually. So when a rotation is applied to a
 * lockRotation:true token and the caller did NOT explicitly pass `lockRotation`, we AUTO-UNLOCK it (and
 * warn) so the angle actually shows. If the caller explicitly keeps lockRotation:true while setting a
 * rotation, we keep their choice but warn the rotation won't be visible. `randomFn` is injected
 * (defaults to Math.random) so tests are deterministic.
 */
export function buildTokenUpdate(
  token: TokenLike,
  args: TokenPatchArgs,
  randomFn: () => number = Math.random
): { update: Record<string, unknown>; warnings: string[]; changed: boolean } {
  const update: Record<string, unknown> = { _id: token.id };
  const warnings: string[] = [];
  const label = `"${token.name ?? token.id}" (${token.id})`;

  let rotationApplied = false;
  if (args.randomizeRotation === true) {
    update.rotation = Math.floor(randomFn() * 360); // 0..359
    rotationApplied = true;
  } else if (typeof args.rotation === 'number') {
    update.rotation = args.rotation;
    rotationApplied = true;
  }

  // lockRotation: an explicit value wins; otherwise auto-unlock a locked token that's getting a rotation.
  if (typeof args.lockRotation === 'boolean') {
    update.lockRotation = args.lockRotation;
    if (args.lockRotation === true && rotationApplied) {
      warnings.push(`${label}: rotation set but lockRotation:true will hide it visually.`);
    }
  } else if (rotationApplied && token.lockRotation === true) {
    update.lockRotation = false;
    warnings.push(
      `${label}: auto-unlocked rotation (lockRotation was true, which would have hidden the angle).`
    );
  }

  if (typeof args.scale === 'number') {
    update['texture.scaleX'] = args.scale;
    update['texture.scaleY'] = args.scale;
  }
  if (typeof args.elevation === 'number') update.elevation = args.elevation;
  if (typeof args.hidden === 'boolean') update.hidden = args.hidden;
  if (typeof args.x === 'number') update.x = args.x;
  if (typeof args.y === 'number') update.y = args.y;
  if (typeof args.name === 'string' && args.name.trim() !== '') update.name = args.name.trim();

  // Nameplate / resource-bar visibility (map friendly key → CONST.TOKEN_DISPLAY_MODES number).
  if (typeof args.displayName === 'string') {
    const m = DISPLAY_MODES[args.displayName];
    if (m === undefined) warnings.push(`${label}: unknown displayName mode "${args.displayName}".`);
    else update.displayName = m;
  }
  if (typeof args.displayBars === 'string') {
    const m = DISPLAY_MODES[args.displayBars];
    if (m === undefined) warnings.push(`${label}: unknown displayBars mode "${args.displayBars}".`);
    else update.displayBars = m;
  }
  // Which actor resource each bar tracks ("" → clear the bar). The health bar is bar1 = attributes.hp.
  if (typeof args.bar1 === 'string') update['bar1.attribute'] = args.bar1.trim() || null;
  if (typeof args.bar2 === 'string') update['bar2.attribute'] = args.bar2.trim() || null;
  // Dynamic token ring on/off (the house default is OFF — a plain token).
  if (typeof args.ring === 'boolean') update['ring.enabled'] = args.ring;

  const changed = Object.keys(update).length > 1; // more than just _id
  return { update, warnings, changed };
}

/**
 * PURE: build the `system.attributes.hp.*` patch applied to a placed token's OWN actor. This is what
 * makes token HP per-instance: for an UNLINKED token, `token.actor.update(patch)` writes the token's
 * ActorDelta, so two copies of the same base actor (e.g. two "Hobgoblin Archer" tokens) can hold
 * DIFFERENT current HP — the thing update-actor cannot do. For a LINKED token the same call writes
 * the shared base actor, which is the correct semantics there. Returns null when nothing HP-related
 * was supplied (so callers can treat "no HP change" cleanly). Only the sub-fields present are written,
 * and 0 is a legitimate value (a downed creature), so we test types, not truthiness.
 */
export function buildHpPatch(hp?: TokenHpArgs): Record<string, number> | null {
  if (!hp) return null;
  const patch: Record<string, number> = {};
  if (typeof hp.value === 'number') patch['system.attributes.hp.value'] = hp.value;
  if (typeof hp.max === 'number') patch['system.attributes.hp.max'] = hp.max;
  if (typeof hp.temp === 'number') patch['system.attributes.hp.temp'] = hp.temp;
  if (typeof hp.tempmax === 'number') patch['system.attributes.hp.tempmax'] = hp.tempmax;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Update one or more PLACED tokens on a scene — a token INSTANCE, NOT the actor's prototype token
 * (that's update-actor). Resolve the scene by id/exact-name (default: the active scene), then target
 * tokens by token id(s) and/or by actor (id OR exact name — matches ALL placed copies of that actor,
 * e.g. every "Dead Guard" on the map). Patch any of: rotation (or `randomizeRotation` for an
 * independent per-token angle), art scale (texture.scaleX/scaleY together), elevation, hidden,
 * lockRotation, x/y, name — batched into ONE updateEmbeddedDocuments call. buildTokenUpdate owns the
 * lockRotation gotcha (auto-unlock so a set rotation is visible). HP is applied separately, per token,
 * on the token's own actor (buildHpPatch) so unlinked copies of one prototype can hold different HP.
 */
export async function updateSceneTokens(
  args: {
    sceneIdentifier?: string;
    tokenIds?: string[];
    actorIds?: string[];
  } & TokenPatchArgs
): Promise<{
  success: boolean;
  matched: number;
  updated: number;
  notFound?: string;
  sceneId?: string;
  sceneName?: string;
  tokens?: Array<Record<string, unknown>>;
  warnings?: string[];
  unmatched?: { tokenIds?: string[]; actorIds?: string[] };
}> {
  const scene = args?.sceneIdentifier
    ? resolveSceneStrict(args.sceneIdentifier)
    : (game.scenes?.current ?? null);
  if (!scene) {
    return {
      success: true,
      matched: 0,
      updated: 0,
      notFound: args?.sceneIdentifier ?? '(no active scene)',
    };
  }

  // Resolve actor targets (id or exact name) → a set of actor ids; collect names that resolved to nothing.
  const wantActorIds = new Set<string>();
  const unmatchedActorIds: string[] = [];
  for (const raw of args?.actorIds ?? []) {
    const a = game.actors?.get(raw) || game.actors?.find((x: any) => x.name === raw);
    if (a) wantActorIds.add(a.id);
    else unmatchedActorIds.push(raw);
  }
  const wantTokenIds = new Set<string>(args?.tokenIds ?? []);
  if (wantTokenIds.size === 0 && wantActorIds.size === 0) {
    throw new Error(
      'provide at least one target: tokenIds and/or actorIds (id or exact actor name)'
    );
  }

  const hpPatch = buildHpPatch(args.hp);
  const hasField =
    args.rotation !== undefined ||
    args.randomizeRotation === true ||
    args.scale !== undefined ||
    args.elevation !== undefined ||
    args.hidden !== undefined ||
    args.lockRotation !== undefined ||
    args.x !== undefined ||
    args.y !== undefined ||
    (typeof args.name === 'string' && args.name.trim() !== '') ||
    args.displayName !== undefined ||
    args.displayBars !== undefined ||
    args.bar1 !== undefined ||
    args.bar2 !== undefined ||
    args.ring !== undefined ||
    hpPatch !== null;
  if (!hasField) {
    throw new Error(
      'provide at least one field to change (rotation, randomizeRotation, scale, elevation, hidden, lockRotation, x, y, name, displayName, displayBars, bar1, bar2, ring, or hp)'
    );
  }

  const matched = scene.tokens.filter(
    (t: any) => wantTokenIds.has(t.id) || (t.actorId && wantActorIds.has(t.actorId))
  );
  const matchedTokenIds = new Set(matched.map((t: any) => t.id));
  const unmatchedTokenIds = [...wantTokenIds].filter(id => !matchedTokenIds.has(id));

  const warnings: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const updatedIds = new Set<string>(); // tokens changed by EITHER the doc patch or the HP patch
  for (const t of matched) {
    const { update, warnings: w, changed } = buildTokenUpdate(t, args);
    warnings.push(...w);
    if (changed) {
      updates.push(update);
      updatedIds.add(t.id);
    }
    // HP is not a TokenDocument field — it lives on the token's actor (the delta for an unlinked
    // token, the base actor for a linked one). Apply it per token so shared-prototype copies diverge.
    if (hpPatch) {
      const actor = (t as any).actor;
      if (actor) {
        await actor.update(hpPatch);
        updatedIds.add(t.id);
      } else {
        warnings.push(`"${t.name ?? t.id}" (${t.id}): no actor — HP not applied.`);
      }
    }
  }

  if (updates.length > 0) await scene.updateEmbeddedDocuments('Token', updates);

  const summarize = (t: any) => ({
    id: t.id,
    name: t.name,
    actorId: t.actorId || undefined,
    rotation: t.rotation,
    scale: t.texture?.scaleX,
    elevation: t.elevation,
    hidden: t.hidden,
    lockRotation: t.lockRotation,
    x: t.x,
    y: t.y,
    displayName: DISPLAY_MODE_NAME[t.displayName] ?? t.displayName,
    displayBars: DISPLAY_MODE_NAME[t.displayBars] ?? t.displayBars,
    bar1: t.bar1?.attribute ?? null,
    ring: t.ring?.enabled ?? false,
    hp: t.actor?.system?.attributes?.hp
      ? { value: t.actor.system.attributes.hp.value, max: t.actor.system.attributes.hp.max }
      : undefined,
  });

  const unmatched: { tokenIds?: string[]; actorIds?: string[] } = {};
  if (unmatchedTokenIds.length > 0) unmatched.tokenIds = unmatchedTokenIds;
  if (unmatchedActorIds.length > 0) unmatched.actorIds = unmatchedActorIds;

  return {
    success: true,
    matched: matched.length,
    updated: updatedIds.size,
    sceneId: scene.id,
    sceneName: scene.name,
    tokens: matched.map((t: any) => summarize(scene.tokens.get(t.id))),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(Object.keys(unmatched).length > 0 ? { unmatched } : {}),
  };
}

// --- bridge page functions (registered in src/page/index.ts) ------------------
export const listSceneTokens = (args: { sceneIdentifier: string }) =>
  crudList(tokenDescriptor, args);
export const placeSceneTokens = (args: { sceneIdentifier: string; items: TokenPlaceInput[] }) =>
  crudCreate(tokenDescriptor, args);
export const deleteSceneTokens = (args: { sceneIdentifier: string; ids: string[] }) =>
  crudDelete(tokenDescriptor, args);
