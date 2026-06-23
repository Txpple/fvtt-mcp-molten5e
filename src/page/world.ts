// Page-side: world/system facts. Runs inside the Foundry page.
//
// Rewritten from scratch for the headless migration. Oracle: the old
// data-access.ts getWorldInfo (commit 6f9612e). Pure reads against game.*;
// no permission/transaction/settings scaffolding.

interface WorldUser {
  id: string;
  name: string;
  active: boolean;
  isGM: boolean;
}

interface WorldInfo {
  id: string;
  title: string;
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
