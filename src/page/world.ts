// Page-side: world/system facts. Runs inside the Foundry page.
//
// Rewritten from scratch for the headless migration. Oracle: the old
// data-access.ts getWorldInfo (commit 6f9612e). Pure reads against game.*;
// no permission/transaction/settings scaffolding.
//
// READ-ONLY BY DESIGN: a world-metadata WRITE (an update-world tool) was built and dropped
// 2026-07-06. v14 ground truth (probed live on 14.364): game.world.update() does not exist —
// World is a PACKAGE, and the only write path is the /setup editWorld POST the "Edit World"
// dialog uses. That route requires a server-admin session (unreachable while a world is live;
// /auth and /setup redirect to /join) or a role-4 GAMEMASTER session — the bridge user is a
// role-3 ASSISTANT and stays that way by decision. Don't rebuild this without revisiting that.

interface WorldUser {
  id: string;
  name: string;
  active: boolean;
  isGM: boolean;
}

interface WorldInfo {
  id: string;
  title: string;
  description: string;
  background: string | null;
  system: string;
  systemVersion: string;
  foundryVersion: string;
  users: WorldUser[];
}

/**
 * Basic world/system metadata.
 *
 * Shape contract (consumed by SceneTools.formatWorldResponse and
 * detectGameSystem): { id, title, system, systemVersion, foundryVersion,
 * users: [{ id, name, active, isGM }] }. `system` is the bare system id
 * string; the Node side rolls users up into counts + an activeUsers list.
 */
export function getWorldInfo(): WorldInfo {
  return {
    id: game.world.id,
    title: game.world.title,
    description: String((game.world as any).description ?? ''),
    background: (game.world as any).background || null,
    system: game.system.id,
    systemVersion: game.system.version,
    foundryVersion: game.version,
    users: game.users.map((user: any) => ({
      id: user.id || '',
      name: user.name || '',
      active: user.active,
      isGM: user.isGM,
    })),
  };
}
