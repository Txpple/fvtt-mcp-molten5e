// Page-side: combat tracker configuration — the core.combatTrackerConfig world setting.
//
// This is the first tool that writes a world GAME SETTING (not a document), and its scope is
// deliberately exactly this one setting, fully typed. We do NOT ship a generic
// set-world-setting(key, blob): a blob value has no typed contract (each setting's shape belongs
// to whoever registered it), which puts correctness on the caller — the opposite of the tool
// contract. The related owner decision that world METADATA is read-only over MCP covered
// game.world.update, not game settings; settings writes are in scope, one typed tool per setting.
//
// Ground truth (probed live, Foundry 14.364 / dnd5e 5.3.3):
//   • core.combatTrackerConfig — scope "world", no reload, registered as a SchemaField.
//     game.settings.get returns a PLAIN object (no toObject) — deepClone → mutate → set.
//   • shape: { resource, skipDefeated, turnMarker: { enabled, animation, src, disposition } }
//   • animation ids live in CONFIG.Combat.settings.turnMarkerAnimations ([{value,label}]) —
//     a registry modules can extend, so we validate against it live, never a hard-coded enum.
//   • src "" is valid: Foundry falls back to CONFIG.Combat.fallbackTurnMarker.

import { imgResolves } from './img-resolve.js';

const NAMESPACE = 'core';
const SETTING = 'combatTrackerConfig';

export interface CombatTrackerArgs {
  resource?: string;
  skipDefeated?: boolean;
  turnMarker?: {
    enabled?: boolean;
    animation?: string;
    src?: string;
    disposition?: boolean;
  };
}

export interface AppliedChange {
  field: string;
  previous: unknown;
  next: unknown;
}

/**
 * PURE: fold the requested changes into a copy of the current config.
 * Returns the new config plus only the fields that actually change (a requested value that
 * already matches is a clean no-op, mirroring update-user). Throws on an animation id the
 * live registry doesn't know, listing what it does.
 */
export function planCombatTrackerChanges(
  current: any,
  args: CombatTrackerArgs,
  validAnimations: Array<{ value: string; label: string }>
): { next: any; applied: AppliedChange[] } {
  const next = JSON.parse(JSON.stringify(current ?? {}));
  next.turnMarker ??= {};
  const applied: AppliedChange[] = [];

  const request = (field: string, target: any, key: string, value: unknown) => {
    if (value === undefined) return;
    if (target[key] === value) return;
    applied.push({ field, previous: target[key], next: value });
    target[key] = value;
  };

  if (args.turnMarker?.animation !== undefined) {
    const ids = validAnimations.map(a => a.value);
    if (!ids.includes(args.turnMarker.animation)) {
      throw new Error(
        `unknown turn-marker animation "${args.turnMarker.animation}" — this world knows: ` +
          `${ids.map(id => `"${id}"`).join(', ')}`
      );
    }
  }

  request('resource', next, 'resource', args.resource);
  request('skipDefeated', next, 'skipDefeated', args.skipDefeated);
  request('turnMarker.enabled', next.turnMarker, 'enabled', args.turnMarker?.enabled);
  request('turnMarker.animation', next.turnMarker, 'animation', args.turnMarker?.animation);
  request('turnMarker.src', next.turnMarker, 'src', args.turnMarker?.src);
  request('turnMarker.disposition', next.turnMarker, 'disposition', args.turnMarker?.disposition);

  return { next, applied };
}

/** The live animation registry, defensively read. */
function liveAnimations(): Array<{ value: string; label: string }> {
  const anims = CONFIG.Combat?.settings?.turnMarkerAnimations;
  if (!Array.isArray(anims)) return [];
  return anims
    .filter((a: any) => typeof a?.value === 'string')
    .map((a: any) => ({ value: a.value, label: a.label ?? a.value }));
}

/**
 * Read or update the combat tracker configuration. With no requested fields this is the read:
 * the current config plus the valid animation ids. A requested src must resolve on the static
 * server or the call is REJECTED (fail closed — writing a 404 marker path is a silent no-op in
 * play; upload-asset first). "" is the documented reset-to-stock value and skips the check.
 */
export async function configureCombatTracker(args: CombatTrackerArgs = {}): Promise<unknown> {
  const current = foundry.utils.deepClone(game.settings.get(NAMESPACE, SETTING) ?? {});
  const animations = liveAnimations();
  const fallbackMarker = CONFIG.Combat?.fallbackTurnMarker ?? null;

  const src = args?.turnMarker?.src;
  if (src && !(await imgResolves(src))) {
    throw new Error(
      `turnMarker.src "${src}" does not resolve on the server — nothing was changed. ` +
        `Upload it first (upload-asset) or correct the path; pass "" to reset to the stock marker.`
    );
  }

  const { next, applied } = planCombatTrackerChanges(current, args ?? {}, animations);

  if (applied.length === 0) {
    return { success: true, config: current, animations, fallbackMarker };
  }

  await game.settings.set(NAMESPACE, SETTING, next);
  const config = foundry.utils.deepClone(game.settings.get(NAMESPACE, SETTING));
  return { success: true, applied, config, animations, fallbackMarker };
}
