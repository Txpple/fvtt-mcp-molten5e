// Page-side: User account tools. Runs inside the Foundry page.
//
// setUserAvatar sets a User's avatar image — the portrait Foundry shows next to that user's chat
// messages (OOC / no-actor-speaker messages). Defaults to the current bridge user (game.user, the
// GM "MCP-Claude"). The avatar value is any path/URL Foundry can load: a Data-relative asset path
// (e.g. "assets/mcp/mcp-claude.jpg"), an https URL, or a built-in icon path. Upload local files with
// the upload-asset tool first.
//
// listUsers is the namespace's read: every user account with role, connection state, color, and
// assigned character. updateUser is the GM admin write: role / name / color / pronouns / assigned
// character, with guards so the bridge can't demote itself or strand the world without a full GM.

import { imgResolves, badAssetWarning } from './img-resolve.js';
import { resolveCreatureIcon } from './dnd5e/icons.js';
import { resolveActorFuzzy } from './_shared.js';

/** Role number ↔ human label, indexed by CONST.USER_ROLES value (0–4). */
const ROLE_LABELS = ['none', 'player', 'trusted', 'assistant', 'gamemaster'] as const;

/**
 * Resolve a user by exact id, exact name, then case-insensitive exact name; falls back to the
 * current bridge user when no identifier is given.
 */
function resolveUser(identifier?: string): any {
  if (!identifier) return game.user;
  return (
    game.users?.get(identifier) ||
    game.users?.getName?.(identifier) ||
    game.users?.find?.((u: any) => u.name === identifier) ||
    game.users?.find?.((u: any) => u.name?.toLowerCase() === identifier.toLowerCase()) ||
    null
  );
}

/** One user's listing shape — shared by listUsers and updateUser's echo. */
function describeUser(user: any): Record<string, unknown> {
  const character = user.character ? { id: user.character.id, name: user.character.name } : null;
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] ?? String(user.role),
    active: !!user.active,
    isGM: !!user.isGM,
    color: user.color?.css ?? user.color ?? null,
    pronouns: user.pronouns || null,
    avatar: user.avatar ?? null,
    character,
    isBridgeUser: user.id === game.user?.id,
  };
}

export function listUsers(): unknown {
  const users = (game.users?.contents ?? [])
    .map(describeUser)
    .sort((a: any, b: any) => b.role - a.role || a.name.localeCompare(b.name));
  return { success: true, count: users.length, users };
}

export async function updateUser(args: {
  user: string;
  role?: 'none' | 'player' | 'trusted' | 'assistant' | 'gamemaster';
  name?: string;
  color?: string;
  pronouns?: string;
  character?: string;
}): Promise<unknown> {
  if (!args?.user) throw new Error('user is required (a user id or exact name)');
  const user = resolveUser(args.user);
  if (!user) {
    const names = (game.users?.contents ?? []).map((u: any) => u.name).join(', ');
    throw new Error(`user "${args.user}" not found. Users in this world: ${names}`);
  }

  const applied: string[] = [];
  const warnings: string[] = [];
  const previous: Record<string, unknown> = {};
  const update: Record<string, unknown> = {};

  if (args.role !== undefined) {
    const newRole = ROLE_LABELS.indexOf(args.role);
    if (newRole < 0) throw new Error(`unknown role "${args.role}" (${ROLE_LABELS.join(' | ')})`);
    // Guard 1: never change the bridge user's own role — dropping below ASSISTANT would sever the
    // GM permissions every other tool depends on, mid-session, with no way back from here.
    if (user.id === game.user?.id) {
      throw new Error(
        `refusing to change the bridge user's ("${user.name}") own role — that could revoke the GM ` +
          'permissions this MCP session runs on. Change it from the Foundry UI if you really mean to.'
      );
    }
    // Guard 2: never demote the world's last full GAMEMASTER — the world would be left without
    // anyone who can administer users at all.
    const GM = 4;
    if (user.role === GM && newRole < GM) {
      const otherGMs = (game.users?.contents ?? []).filter(
        (u: any) => u.role === GM && u.id !== user.id
      );
      if (otherGMs.length === 0) {
        throw new Error(
          `refusing to demote "${user.name}" — they are the world's only GAMEMASTER (role 4). ` +
            'Promote another user to gamemaster first.'
        );
      }
    }
    if (newRole !== user.role) {
      previous.role = `${user.role} (${ROLE_LABELS[user.role] ?? '?'})`;
      update.role = newRole;
      applied.push('role');
    }
  }

  if (args.name !== undefined && args.name !== user.name) {
    previous.name = user.name;
    update.name = args.name;
    applied.push('name');
  }

  if (args.color !== undefined) {
    previous.color = user.color?.css ?? user.color ?? null;
    update.color = args.color;
    applied.push('color');
  }

  if (args.pronouns !== undefined) {
    previous.pronouns = user.pronouns || null;
    update.pronouns = args.pronouns;
    applied.push('pronouns');
  }

  if (args.character !== undefined) {
    previous.character = user.character ? user.character.name : null;
    if (args.character === 'none') {
      update.character = null;
      applied.push('character');
    } else {
      const actor = resolveActorFuzzy(args.character);
      if (!actor) throw new Error(`character actor "${args.character}" not found`);
      if (actor.type !== 'character') {
        warnings.push(
          `"${actor.name}" is type "${actor.type}", not a player character (type "character") — ` +
            'assigned anyway, but the Foundry UI only offers type "character" actors here.'
        );
      }
      update.character = actor.id;
      applied.push('character');
    }
  }

  if (applied.length > 0) await user.update(update);

  const fresh = game.users?.get(user.id) ?? user;
  return {
    success: true,
    user: describeUser(fresh),
    applied,
    previous,
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function setUserAvatar(args: { user?: string; avatar: string }): Promise<unknown> {
  if (!args?.avatar || typeof args.avatar !== 'string') {
    throw new Error(
      'avatar is required and must be a non-empty string (a path or URL Foundry can load)'
    );
  }
  const user = resolveUser(args.user);
  if (!user) throw new Error(`user "${args.user}" not found`);

  const warnings: string[] = [];

  // Rule 8 — never write a broken (404) avatar. A supplied path is honored only if it resolves on the
  // static server; otherwise warn and substitute a real neutral humanoid portrait.
  let avatar = args.avatar;
  if (!(await imgResolves(avatar))) {
    warnings.push(badAssetWarning('avatar', avatar, true));
    avatar = resolveCreatureIcon('humanoid');
  }

  const previous = user.avatar ?? null;
  await user.update({ avatar });

  return {
    success: true,
    userId: user.id,
    name: user.name,
    isGM: !!user.isGM,
    avatar,
    previous,
    ...(warnings.length ? { warnings } : {}),
  };
}
