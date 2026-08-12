// Page-side: actor ownership / player reads + writes. Runs inside the Foundry page.
//
// Reads against game.* collections; the write (setActorOwnership) updates the
// actor's ownership map. No permission/transaction/settings scaffolding — the
// headless page IS the GM, so it reads and mutates ownership directly.

// Foundry token disposition constant for FRIENDLY (CONST.TOKEN_DISPOSITIONS.FRIENDLY).
const FRIENDLY_DISPOSITION = 1;

const PERMISSION_NAMES: Record<number, string> = {
  0: 'NONE',
  1: 'LIMITED',
  2: 'OBSERVER',
  3: 'OWNER',
};

/**
 * Resolve a world actor by id, exact name, or partial (case-insensitive) name
 * match. Falls back to a scene token id (returning that token's synthetic actor)
 * so an unlinked token on a map can be addressed individually.
 */
function findActorByIdentifier(identifier: string): any {
  const worldActor =
    game.actors?.get(identifier) ||
    game.actors?.getName(identifier) ||
    game.actors?.contents.find((a: any) =>
      a.name?.toLowerCase().includes(identifier.toLowerCase())
    );
  if (worldActor) return worldActor;

  for (const scene of game.scenes?.contents ?? []) {
    const token = scene.tokens?.get(identifier);
    if (token?.actor) return token.actor;
  }
  return undefined;
}

/**
 * List ownership permissions per actor/player. Optionally narrow to a single
 * actor (or "all"), and/or a single player. GM users are always excluded.
 */
export function getActorOwnership(args?: {
  actorIdentifier?: string;
  playerIdentifier?: string;
}): unknown {
  const actorIdentifier = args?.actorIdentifier;
  const playerIdentifier = args?.playerIdentifier;

  const actors: any[] = actorIdentifier
    ? actorIdentifier === 'all'
      ? (game.actors?.contents ?? [])
      : [findActorByIdentifier(actorIdentifier)].filter(Boolean)
    : (game.actors?.contents ?? []);

  const users: any[] = playerIdentifier
    ? [game.users?.getName(playerIdentifier) || game.users?.get(playerIdentifier)].filter(Boolean)
    : (game.users?.contents ?? []);

  const ownershipInfo: any[] = [];

  for (const actor of actors) {
    const actorInfo: any = {
      id: actor.id,
      name: actor.name,
      type: actor.type,
      ownership: [],
    };

    for (const user of users.filter((u: any) => u && !u.isGM)) {
      const permission = actor.testUserPermission(user, 'OWNER')
        ? 3
        : actor.testUserPermission(user, 'OBSERVER')
          ? 2
          : actor.testUserPermission(user, 'LIMITED')
            ? 1
            : 0;

      actorInfo.ownership.push({
        userId: user.id,
        userName: user.name,
        permission: PERMISSION_NAMES[permission],
        numericPermission: permission,
      });
    }

    ownershipInfo.push(actorInfo);
  }

  return ownershipInfo;
}

/**
 * Set a single user's ownership permission on an actor, or (permission === null)
 * remove the user's entry so the actor's `ownership.default` applies again.
 *
 * The distinction matters: an explicit 0 is NOT the same as an absent key. On an
 * actor whose default is permissive (a shared party stash defaulting to OWNER),
 * storing 0 actively DENIES the user, and only deleting the key restores the
 * inherited level.
 *
 * Both paths write the whole ownership object with `{ diff: false, recursive: false }`.
 * That is load-bearing for the delete: the `{"ownership.-=<id>": null}` deletion idiom
 * SILENTLY NO-OPS on this field (verified live 2026-08-12 — it left 14 stale entries
 * across three actors; see scripts/clean-stale-ownership.mjs), and a recursive update
 * would merge the removed key straight back in.
 *
 * Best-effort: returns a { success, message, error? } result rather than throwing.
 */
export async function setActorOwnership(args: {
  actorId: string;
  userId: string;
  permission: number | null;
}): Promise<{ success: boolean; message: string; error?: string }> {
  try {
    const actor = game.actors?.get(args.actorId);
    if (!actor) {
      return { success: false, error: `Actor not found: ${args.actorId}`, message: '' };
    }

    const user = game.users?.get(args.userId);
    if (!user) {
      return { success: false, error: `User not found: ${args.userId}`, message: '' };
    }

    const currentOwnership: Record<string, number> = actor.ownership || {};

    // INHERIT: rebuild the map WITHOUT this user's key.
    if (args.permission === null) {
      const hadEntry = Object.hasOwn(currentOwnership, args.userId);
      const next: Record<string, number> = {};
      for (const [id, level] of Object.entries(currentOwnership)) {
        if (id !== args.userId) next[id] = level;
      }

      await actor.update({ ownership: next }, { diff: false, recursive: false });

      const defaultLevel = next.default ?? 0;
      const inherited = PERMISSION_NAMES[defaultLevel] ?? String(defaultLevel);
      return {
        success: true,
        message: hadEntry
          ? `Removed ${user.name}'s explicit ownership entry on ${actor.name} — now inherits the actor default (${inherited})`
          : `${user.name} had no explicit ownership entry on ${actor.name} — already inheriting the actor default (${inherited})`,
      };
    }

    // Merge the new permission into the actor's existing ownership map.
    const newOwnership = { ...currentOwnership, [args.userId]: args.permission };

    await actor.update({ ownership: newOwnership }, { diff: false, recursive: false });

    const permissionName = PERMISSION_NAMES[args.permission] ?? args.permission.toString();

    return {
      success: true,
      message:
        `Set ${actor.name} ownership to ${permissionName} for ${user.name}` +
        (args.permission === 0
          ? ` (explicit deny — overrides the actor default; use INHERIT to fall back to it)`
          : ''),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: '',
    };
  }
}

/**
 * Friendly-disposition tokens on the active scene, as { id, name }. Prefers the
 * token's underlying actor id; falls back to the token id.
 */
export function getFriendlyNPCs(): unknown {
  const scene = game.scenes?.find((s: any) => s.active);
  if (!scene) return [];

  return scene.tokens
    .filter((token: any) => token.disposition === FRIENDLY_DISPOSITION)
    .map((token: any) => ({
      id: token.actor?.id || token.id || '',
      name: token.name || token.actor?.name || 'Unknown',
    }))
    .filter((t: any) => t.id);
}

/**
 * Player-owned character actors (the party), as { id, name }.
 */
export function getPartyCharacters(): unknown {
  return (game.actors?.contents ?? [])
    .filter((actor: any) => actor.hasPlayerOwner && actor.type === 'character')
    .map((actor: any) => ({
      id: actor.id || '',
      name: actor.name || 'Unknown',
    }))
    .filter((c: any) => c.id);
}

/**
 * Connected (active) non-GM users, as { id, name }.
 */
export function getConnectedPlayers(): unknown {
  return (game.users?.contents ?? [])
    .filter((user: any) => user.active && !user.isGM)
    .map((user: any) => ({
      id: user.id || '',
      name: user.name || 'Unknown',
    }))
    .filter((u: any) => u.id);
}

/**
 * Find player users matching an identifier. Matches non-GM user names directly
 * (exact, or partial when allowPartialMatch). If none match and
 * includeCharacterOwners is set, falls back to matching character actor names
 * and returning their owning player. Returns { id, name }[].
 */
export function findPlayers(args: {
  identifier: string;
  allowPartialMatch?: boolean;
  includeCharacterOwners?: boolean;
}): unknown {
  const { identifier, allowPartialMatch = true, includeCharacterOwners = true } = args;
  const searchTerm = identifier.toLowerCase();
  const players: Array<{ id: string; name: string }> = [];

  // Direct user-name matching (excluding GMs).
  for (const user of game.users?.contents ?? []) {
    if (user.isGM) continue;

    const userName = user.name?.toLowerCase() || '';
    if (userName === searchTerm || (allowPartialMatch && userName.includes(searchTerm))) {
      players.push({ id: user.id || '', name: user.name || 'Unknown' });
    }
  }

  // Character-name fallback: resolve to the character's owning player.
  if (includeCharacterOwners && players.length === 0) {
    for (const actor of game.actors?.contents ?? []) {
      if (actor.type !== 'character') continue;

      const actorName = actor.name?.toLowerCase() || '';
      if (actorName === searchTerm || (allowPartialMatch && actorName.includes(searchTerm))) {
        const owner = game.users?.contents.find(
          (user: any) => actor.testUserPermission(user, 'OWNER') && !user.isGM
        );

        if (owner && !players.some(p => p.id === owner.id)) {
          players.push({ id: owner.id || '', name: owner.name || 'Unknown' });
        }
      }
    }
  }

  return players.filter(p => p.id);
}
