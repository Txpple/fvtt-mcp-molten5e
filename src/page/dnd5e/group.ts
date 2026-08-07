// Page-side: dnd5e GROUP actors (type:"group") — the shared party stash / travel group.
//
// Ground truth (probed live 2026-08-07, Foundry 14.364 / dnd5e 5.3.3, actor m2iibo7g0b1YFFjQ):
//   • system model = GroupData; schema fields: currency{pp,gp,ep,sp,cp}, description{full,summary},
//     attributes{travel}, details{xp{value}}, members[{actor: id}], primaryVehicle. There is NO
//     party/encounter subtype field in 5.3.3 (CONFIG.DND5E.groupTypes is vestigial UI labels), so
//     these tools do not advertise one.
//   • membership goes through the SYSTEM API, never a hand-built system.members write:
//     system.addMember(actor) rejects a group-in-group and compendium actors, silently DEDUPES via
//     members.ids, and pushes {actor: id}; system.removeMember(actorOrId) THROWS on a non-member.
//     We pre-classify both so a batch reports per-actor outcomes instead of dying mid-loop.
//   • the dnd5e "primaryParty" world setting's value is a PrimaryPartySetting data model
//     {actor: ForeignDocumentField} — read resolves to the Actor document (or null), write takes
//     game.settings.set('dnd5e', 'primaryParty', {actor: id | null}).
//
// Shared inventory/currency need no writers here: group actors take embedded physical items and
// system.currency edits through the existing add-item / import-item / update-actor paths; this
// module owns the group-shaped READ (getGroupInfo) plus create / membership / primary-party.

import { resolveActorFuzzy, getOrCreateFolder } from '../_shared.js';
import { imgResolves, badAssetWarning } from '../img-resolve.js';

const SETTING_NS = 'dnd5e';
const SETTING_KEY = 'primaryParty';

/** A member identifier resolved (or not) against the world actor directory. */
export interface MemberResolution {
  identifier: string;
  actor: { id: string; name: string; type: string } | null;
}

export interface SkippedMember {
  identifier: string;
  reason: 'not-found' | 'group-actor' | 'already-member' | 'not-a-member' | 'duplicate-request';
}

/**
 * PURE: classify requested ADDITIONS against the group's current member ids.
 * Mirrors addMember's own guards (dedupe, no group-in-group) so every skip is REPORTED with a
 * reason instead of addMember silently no-opping (dup) or throwing mid-batch (group actor).
 */
export function planMemberAdds(
  currentIds: string[],
  resolutions: MemberResolution[]
): { add: Array<{ id: string; name: string; type: string }>; skipped: SkippedMember[] } {
  const current = new Set(currentIds);
  const queued = new Set<string>();
  const add: Array<{ id: string; name: string; type: string }> = [];
  const skipped: SkippedMember[] = [];

  for (const { identifier, actor } of resolutions) {
    if (!actor) {
      skipped.push({ identifier, reason: 'not-found' });
    } else if (actor.type === 'group') {
      skipped.push({ identifier, reason: 'group-actor' });
    } else if (current.has(actor.id)) {
      skipped.push({ identifier, reason: 'already-member' });
    } else if (queued.has(actor.id)) {
      skipped.push({ identifier, reason: 'duplicate-request' });
    } else {
      queued.add(actor.id);
      add.push(actor);
    }
  }
  return { add, skipped };
}

/**
 * PURE: classify requested REMOVALS against the group's current member ids.
 * An identifier that resolves to no world actor but IS literally a current member id still
 * removes — that is exactly the dangling-member case (the actor was deleted after joining).
 */
export function planMemberRemovals(
  currentIds: string[],
  resolutions: MemberResolution[]
): { remove: Array<{ id: string; name: string | null }>; skipped: SkippedMember[] } {
  const current = new Set(currentIds);
  const queued = new Set<string>();
  const remove: Array<{ id: string; name: string | null }> = [];
  const skipped: SkippedMember[] = [];

  for (const { identifier, actor } of resolutions) {
    const id = actor?.id ?? (current.has(identifier) ? identifier : null);
    if (!id) {
      skipped.push({ identifier, reason: actor ? 'not-a-member' : 'not-found' });
    } else if (!current.has(id)) {
      skipped.push({ identifier, reason: 'not-a-member' });
    } else if (queued.has(id)) {
      skipped.push({ identifier, reason: 'duplicate-request' });
    } else {
      queued.add(id);
      remove.push({ id, name: actor?.name ?? null });
    }
  }
  return { remove, skipped };
}

/**
 * PURE: fail-closed member validation for CREATE. Unlike the incremental add path (which
 * reports and continues), creating a group with a misspelled member is a half-built stash —
 * so any unresolved or group-typed member REJECTS the whole create with everything listed.
 * Duplicates within the request collapse silently (asking twice is not an error at create).
 */
export function assertCreatableMembers(
  resolutions: MemberResolution[]
): Array<{ id: string; name: string; type: string }> {
  const notFound = resolutions.filter(r => !r.actor).map(r => `"${r.identifier}"`);
  const groups = resolutions.filter(r => r.actor?.type === 'group').map(r => `"${r.identifier}"`);
  const problems: string[] = [];
  if (notFound.length) problems.push(`not found in this world: ${notFound.join(', ')}`);
  if (groups.length) {
    problems.push(`group actors cannot be members of a group: ${groups.join(', ')}`);
  }
  if (problems.length) {
    throw new Error(`create-group: nothing was created — ${problems.join('; ')}`);
  }

  const seen = new Set<string>();
  const members: Array<{ id: string; name: string; type: string }> = [];
  for (const { actor } of resolutions) {
    if (actor && !seen.has(actor.id)) {
      seen.add(actor.id);
      members.push(actor);
    }
  }
  return members;
}

/** Raw member ids straight from the group's source data (never the prepared/derived view). */
function currentMemberIds(group: any): string[] {
  const members = group.system?.toObject?.()?.members ?? [];
  return members.map((m: any) => m?.actor).filter(Boolean);
}

/** Resolve each identifier against the world (fuzzy: id, exact name, substring). */
function resolveMembers(identifiers: string[]): MemberResolution[] {
  return identifiers.map(identifier => {
    const actor = resolveActorFuzzy(identifier);
    return {
      identifier,
      actor: actor ? { id: actor.id, name: actor.name, type: actor.type } : null,
    };
  });
}

/** Resolve an identifier that must be a GROUP actor, with a type-naming error otherwise. */
function resolveGroupStrict(identifier: string): any {
  const actor = resolveActorFuzzy(identifier);
  if (!actor) {
    throw new Error(`No actor matches "${identifier}"`);
  }
  if (actor.type !== 'group') {
    throw new Error(
      `"${actor.name}" (${actor.id}) is type "${actor.type}", not a group actor — ` +
        `list-actors shows which actors are groups`
    );
  }
  return actor;
}

/** The current primary party as {id, name} | null (the setting resolves its own Actor). */
function currentPrimaryParty(): { id: string; name: string } | null {
  const actor = game.settings.get(SETTING_NS, SETTING_KEY)?.actor;
  return actor ? { id: actor.id, name: actor.name } : null;
}

const OWNERSHIP_LEVELS: Record<string, number> = { none: 0, limited: 1, observer: 2, owner: 3 };
const LEVEL_NAMES: Record<number, string> = {
  0: 'NONE',
  1: 'LIMITED',
  2: 'OBSERVER',
  3: 'OWNER',
};

export interface CreateGroupArgs {
  name: string;
  members?: string[];
  description?: string;
  summary?: string;
  img?: string;
  folderName?: string;
  defaultOwnership?: 'none' | 'limited' | 'observer' | 'owner';
  currency?: { pp?: number; gp?: number; ep?: number; sp?: number; cp?: number };
  makePrimaryParty?: boolean;
}

/**
 * Create a dnd5e group actor. Members are resolved and validated FIRST (fail closed — a
 * misspelled member creates nothing), the actor is created, then each member joins through
 * system.addMember. defaultOwnership writes ownership.default, the one knob that grants every
 * player at once — the party-stash case; per-user grants stay with set-actor-ownership.
 */
export async function createGroupActor(args: CreateGroupArgs): Promise<unknown> {
  const warnings: string[] = [];

  const resolutions = resolveMembers(args.members ?? []);
  const members = assertCreatableMembers(resolutions);

  const data: any = { name: args.name, type: 'group', system: {} };

  if (args.description !== undefined || args.summary !== undefined) {
    data.system.description = {};
    if (args.description !== undefined) data.system.description.full = args.description;
    if (args.summary !== undefined) data.system.description.summary = args.summary;
  }
  if (args.currency) {
    data.system.currency = {};
    for (const coin of ['pp', 'gp', 'ep', 'sp', 'cp'] as const) {
      const v = args.currency[coin];
      if (v !== undefined) data.system.currency[coin] = v;
    }
  }
  if (args.defaultOwnership !== undefined) {
    data.ownership = { default: OWNERSHIP_LEVELS[args.defaultOwnership] };
  }
  if (args.img) {
    if (await imgResolves(args.img)) {
      data.img = args.img;
    } else {
      // Group A policy (portrait site): drop the 404 path — dnd5e stamps its own group art.
      warnings.push(badAssetWarning('img', args.img, true));
    }
  }
  if (args.folderName?.trim()) {
    data.folder = await getOrCreateFolder(args.folderName.trim(), 'Actor');
  }

  const ActorClass = (globalThis as any).Actor;
  const group = await ActorClass.create(data);
  if (!group) {
    throw new Error(`Actor.create returned nothing for group "${args.name}"`);
  }

  for (const member of members) {
    await group.system.addMember(game.actors.get(member.id));
  }

  let primaryParty: { previous: { id: string; name: string } | null } | undefined;
  if (args.makePrimaryParty) {
    const previous = currentPrimaryParty();
    await game.settings.set(SETTING_NS, SETTING_KEY, { actor: group.id });
    primaryParty = { previous };
  }

  return {
    success: true,
    group: {
      id: group.id,
      name: group.name,
      img: group.img,
      folderId: group.folder?.id ?? null,
      defaultOwnership: LEVEL_NAMES[group.ownership?.default ?? 0],
    },
    members: currentMemberIds(group).map(id => {
      const actor = game.actors.get(id);
      return { id, name: actor?.name ?? null, type: actor?.type ?? null };
    }),
    ...(primaryParty ? { primaryParty } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export interface ManageGroupMembersArgs {
  groupIdentifier: string;
  add?: string[];
  remove?: string[];
}

/**
 * Add/remove members on an existing group through system.addMember / system.removeMember.
 * Every requested identifier gets a per-actor outcome (added / removed / skipped+reason) —
 * the batch never dies mid-loop on a guard the system API would have thrown.
 */
export async function manageGroupMembers(args: ManageGroupMembersArgs): Promise<unknown> {
  const group = resolveGroupStrict(args.groupIdentifier);

  const removals = planMemberRemovals(currentMemberIds(group), resolveMembers(args.remove ?? []));
  for (const { id } of removals.remove) {
    await group.system.removeMember(id);
  }

  // Adds are planned AFTER removals land so remove+add of the same actor in one call re-adds.
  const adds = planMemberAdds(currentMemberIds(group), resolveMembers(args.add ?? []));
  for (const { id } of adds.add) {
    await group.system.addMember(game.actors.get(id));
  }

  return {
    success: true,
    group: { id: group.id, name: group.name },
    added: adds.add,
    removed: removals.remove,
    skipped: [...adds.skipped, ...removals.skipped],
    members: currentMemberIds(group).map(id => {
      const actor = game.actors.get(id);
      return { id, name: actor?.name ?? null, type: actor?.type ?? null };
    }),
  };
}

/**
 * The group-shaped read: members (with a dangling flag for deleted actors), shared currency,
 * shared inventory (the embedded items ARE the stash), ownership, and the primary-party flag.
 * get-actor's character-shaped read returns an empty husk for groups — this is the contract.
 */
export function getGroupInfo(args: { groupIdentifier: string }): unknown {
  const group = resolveGroupStrict(args.groupIdentifier);
  const source = group.system.toObject();

  const users = (game.users?.contents ?? []).filter((u: any) => !u.isGM);
  const ownership = group.ownership ?? {};

  return {
    id: group.id,
    name: group.name,
    img: group.img,
    folder: group.folder ? { id: group.folder.id, name: group.folder.name } : null,
    isPrimaryParty: currentPrimaryParty()?.id === group.id,
    description: {
      full: source.description?.full ?? '',
      summary: source.description?.summary ?? '',
    },
    members: (source.members ?? []).map((m: any) => {
      const actor = game.actors.get(m.actor);
      return actor
        ? { id: m.actor, name: actor.name, type: actor.type }
        : { id: m.actor, name: null, type: null, dangling: true };
    }),
    currency: source.currency ?? {},
    inventory: (group.items?.contents ?? []).map((i: any) => ({
      id: i.id,
      name: i.name,
      type: i.type,
      quantity: i.system?.quantity ?? 1,
    })),
    ownership: {
      default: LEVEL_NAMES[ownership.default ?? 0],
      users: users
        .filter((u: any) => ownership[u.id] !== undefined)
        .map((u: any) => ({
          id: u.id,
          name: u.name,
          level: LEVEL_NAMES[ownership[u.id]] ?? String(ownership[u.id]),
        })),
    },
  };
}

export interface ConfigurePrimaryPartyArgs {
  groupIdentifier?: string;
  clear?: boolean;
}

/**
 * Read or set the dnd5e primaryParty world setting. No arguments → read. groupIdentifier →
 * point it at that group. clear → unset. Setting the current value is a clean no-op
 * (changed: false), mirroring configure-combat-tracker.
 */
export async function configurePrimaryParty(
  args: ConfigurePrimaryPartyArgs = {}
): Promise<unknown> {
  if (args.groupIdentifier && args.clear) {
    throw new Error('set-primary-party: pass groupIdentifier OR clear, not both');
  }

  const previous = currentPrimaryParty();

  if (args.clear) {
    if (!previous) {
      return { success: true, changed: false, current: null };
    }
    await game.settings.set(SETTING_NS, SETTING_KEY, { actor: null });
    return { success: true, changed: true, previous, current: currentPrimaryParty() };
  }

  if (args.groupIdentifier) {
    const group = resolveGroupStrict(args.groupIdentifier);
    if (previous?.id === group.id) {
      return { success: true, changed: false, current: previous };
    }
    await game.settings.set(SETTING_NS, SETTING_KEY, { actor: group.id });
    return { success: true, changed: true, previous, current: currentPrimaryParty() };
  }

  return { success: true, changed: false, current: previous };
}
