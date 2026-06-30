// Page-side: User account tweaks. Runs inside the Foundry page.
//
// setUserAvatar sets a User's avatar image — the portrait Foundry shows next to that user's chat
// messages (OOC / no-actor-speaker messages). Defaults to the current bridge user (game.user, the
// GM "MCP-Claude"). The avatar value is any path/URL Foundry can load: a Data-relative asset path
// (e.g. "assets/mcp/mcp-claude.jpg"), an https URL, or a built-in icon path. Upload local files with
// the upload-asset tool first.

import { imgResolves, badAssetWarning } from './img-resolve.js';
import { resolveCreatureIcon } from './dnd5e/icons.js';

/** Resolve a user by exact id or exact name; falls back to the current bridge user. */
function resolveUser(identifier?: string): any {
  if (!identifier) return game.user;
  return (
    game.users?.get(identifier) ||
    game.users?.getName?.(identifier) ||
    game.users?.find?.((u: any) => u.name === identifier) ||
    null
  );
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
