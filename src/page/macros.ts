// Page-side: Macro tools. Runs inside the Foundry page.
//
// createMacro authors a world Macro (script or chat) and can grant a player OWNER access and pin
// it to their hotbar in one call — the "hand a player a one-click button" op. The bridge user is
// the macro's author, so player access is granted through explicit ownership levels, mirroring
// what dnd5e's own drag-to-hotbar flow produces (where the player is the author).
//
// listMacros is the namespace read: every macro with type/author/command preview plus every user
// hotbar slot it is pinned to. deleteMacros removes macros AND scrubs any user hotbar slots that
// referenced them, so no dead buttons are left behind.

import { imgResolves, badAssetWarning } from './img-resolve.js';
import { resolveUser } from './users.js';

/** Foundry's stock macro icon — the fallback when no (or a broken) img is supplied. */
const DEFAULT_MACRO_IMG = 'icons/svg/dice-target.svg';

/** CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER */
const OWNER = 3;

/** Hotbar slots are 1–50 (5 pages × 10). */
const HOTBAR_SLOTS = 50;

function resolveUserOrThrow(identifier: string): any {
  const user = resolveUser(identifier);
  if (!user) {
    const names = (game.users?.contents ?? []).map((u: any) => u.name).join(', ');
    throw new Error(`user "${identifier}" not found. Users in this world: ${names}`);
  }
  return user;
}

/** One macro's listing shape — shared by createMacro's echo, listMacros, and deleteMacros. */
function describeMacro(macro: any): Record<string, unknown> {
  const command: string = macro.command ?? '';
  return {
    id: macro.id,
    name: macro.name,
    type: macro.type,
    author: macro.author?.name ?? null,
    img: macro.img ?? null,
    commandPreview: command.length > 120 ? `${command.slice(0, 120)}…` : command,
  };
}

/** Invert every user's hotbar into macroId -> [{userId, userName, slot}]. */
function hotbarAssignments(): Map<
  string,
  Array<{ userId: string; userName: string; slot: number }>
> {
  const map = new Map<string, Array<{ userId: string; userName: string; slot: number }>>();
  for (const user of game.users?.contents ?? []) {
    for (const [slot, macroId] of Object.entries(user.hotbar ?? {})) {
      if (!macroId) continue;
      const pins = map.get(macroId as string) ?? [];
      pins.push({ userId: user.id, userName: user.name, slot: Number(slot) });
      map.set(macroId as string, pins);
    }
  }
  return map;
}

function firstFreeSlot(user: any): number {
  const hotbar = user.hotbar ?? {};
  for (let slot = 1; slot <= HOTBAR_SLOTS; slot++) {
    if (!hotbar[slot]) return slot;
  }
  throw new Error(`no free hotbar slot on "${user.name}" — all ${HOTBAR_SLOTS} are occupied`);
}

export async function createMacro(args: {
  name: string;
  command: string;
  type?: 'script' | 'chat';
  img?: string;
  owner?: string;
  hotbarUser?: string;
  hotbarSlot?: number;
}): Promise<unknown> {
  if (!args?.name) throw new Error('name is required');
  if (!args?.command) throw new Error('command is required');
  if (args.hotbarSlot !== undefined && !args.hotbarUser) {
    throw new Error(
      'hotbarSlot requires hotbarUser — a slot number means nothing without a hotbar'
    );
  }
  const type = args.type === 'chat' ? 'chat' : 'script';
  const warnings: string[] = [];

  // Resolve every named user BEFORE creating anything — a bad identifier must not orphan a macro.
  const grantees: any[] = [];
  const hotbarUser = args.hotbarUser ? resolveUserOrThrow(args.hotbarUser) : null;
  if (hotbarUser) grantees.push(hotbarUser);
  if (args.owner) {
    const owner = resolveUserOrThrow(args.owner);
    if (!grantees.some(u => u.id === owner.id)) grantees.push(owner);
  }

  // Script macros only execute for roles the world's "Use Script Macros" permission covers.
  // Ownership can't override that, so warn (don't block) when a grantee's role is outside it.
  if (type === 'script') {
    const allowedRoles: number[] = game.permissions?.MACRO_SCRIPT ?? [];
    for (const u of grantees) {
      if (!u.isGM && !allowedRoles.includes(u.role)) {
        warnings.push(
          `"${u.name}" (role ${u.role}) cannot run script macros under this world's "Use Script ` +
            'Macros" permission — the button will error for them until a GM raises that permission.'
        );
      }
    }
  }

  // Rule 8 — never write a broken icon. A supplied img is honored only if it resolves on the
  // static server; otherwise warn and fall back to Foundry's stock macro icon.
  let img = args.img;
  if (img && !(await imgResolves(img))) {
    warnings.push(badAssetWarning('img', img, true));
    img = undefined;
  }

  const ownership: Record<string, number> = { default: 0 };
  for (const u of grantees) ownership[u.id] = OWNER;

  const macro = await game.macros.documentClass.create({
    name: args.name,
    type,
    command: args.command,
    img: img ?? DEFAULT_MACRO_IMG,
    ownership,
  });

  let hotbar: { userId: string; userName: string; slot: number } | null = null;
  if (hotbarUser) {
    const slot = args.hotbarSlot ?? firstFreeSlot(hotbarUser);
    const previous = hotbarUser.hotbar?.[slot];
    if (previous && previous !== macro.id) {
      const previousMacro = game.macros?.get(previous);
      warnings.push(
        `hotbar slot ${slot} on "${hotbarUser.name}" held "${previousMacro?.name ?? previous}" — replaced.`
      );
    }
    await hotbarUser.assignHotbarMacro(macro, slot);
    hotbar = { userId: hotbarUser.id, userName: hotbarUser.name, slot };
  }

  return {
    success: true,
    macro: describeMacro(macro),
    ...(hotbar ? { hotbar } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export function listMacros(): unknown {
  const assignments = hotbarAssignments();
  const macros = (game.macros?.contents ?? [])
    .map((m: any) => ({ ...describeMacro(m), hotbar: assignments.get(m.id) ?? [] }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  return { success: true, count: macros.length, macros };
}

export async function deleteMacros(args: { macros: string[] }): Promise<unknown> {
  if (!Array.isArray(args?.macros) || args.macros.length === 0) {
    throw new Error('macros is required — an array of macro ids or exact names');
  }
  const resolved: any[] = [];
  const missing: string[] = [];
  for (const identifier of args.macros) {
    const macro =
      game.macros?.get(identifier) ||
      game.macros?.getName?.(identifier) ||
      game.macros?.find?.((m: any) => m.name?.toLowerCase() === identifier.toLowerCase());
    if (!macro) {
      missing.push(identifier);
    } else if (!resolved.some(m => m.id === macro.id)) {
      resolved.push(macro);
    }
  }
  if (resolved.length === 0) {
    const names = (game.macros?.contents ?? []).map((m: any) => m.name).join(', ');
    throw new Error(
      `no macros matched ${JSON.stringify(args.macros)}. Macros in this world: ${names || '(none)'}`
    );
  }

  // Scrub hotbar references BEFORE deleting so no user is left with a dead button.
  const ids = new Set(resolved.map(m => m.id));
  const scrubbed: Array<{ userId: string; userName: string; slot: number }> = [];
  for (const user of game.users?.contents ?? []) {
    const dead = Object.entries(user.hotbar ?? {}).filter(([, id]) => ids.has(id as string));
    if (dead.length === 0) continue;
    const update: Record<string, null> = {};
    for (const [slot] of dead) update[`hotbar.-=${slot}`] = null;
    await user.update(update);
    for (const [slot] of dead) {
      scrubbed.push({ userId: user.id, userName: user.name, slot: Number(slot) });
    }
  }

  const deleted = resolved.map(describeMacro);
  await game.macros.documentClass.deleteDocuments(resolved.map(m => m.id));
  return {
    success: true,
    deleted,
    ...(scrubbed.length ? { scrubbedHotbarSlots: scrubbed } : {}),
    ...(missing.length ? { missing } : {}),
  };
}
