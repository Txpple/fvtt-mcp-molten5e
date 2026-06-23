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
 * Set a single user's ownership permission on an actor. Merges the new level
 * into the actor's existing ownership map and persists it. Best-effort: returns
 * a { success, message, error? } result rather than throwing.
 */
export async function setActorOwnership(args: {
  actorId: string;
  userId: string;
  permission: number;
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

    // Merge the new permission into the actor's existing ownership map.
    const currentOwnership = actor.ownership || {};
    const newOwnership = { ...currentOwnership, [args.userId]: args.permission };

    await actor.update({ ownership: newOwnership });

    const permissionName = PERMISSION_NAMES[args.permission] ?? args.permission.toString();

    return {
      success: true,
      message: `Set ${actor.name} ownership to ${permissionName} for ${user.name}`,
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
