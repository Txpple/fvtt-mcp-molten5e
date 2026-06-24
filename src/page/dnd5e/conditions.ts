// Page-side: dnd5e condition (status-effect) authoring. Runs inside the headless Foundry page.
//
// applyCondition toggles dnd5e conditions on/off via the core Actor#toggleStatusEffect API (the
// supported way to add/remove a status effect by id). It is authoring-only: it sets a creature's
// condition state, it does NOT run combat automation (no duration tick-down, no save-ends loop).
//
// Live-verified dnd5e 5.3.3 facts:
//  - Valid ids are CONFIG.DND5E.conditionTypes keys (the 26 D&D conditions) plus the broader
//    CONFIG.statusEffects ids (cover, concentrating, dead, ...). We validate against their union.
//  - Exhaustion is the one LEVELED condition. toggleStatusEffect's `levels` option is ignored
//    (it always creates "Exhaustion 1"); the level is the `flags.dnd5e.exhaustionLevel` flag on the
//    created effect, and the derived `system.attributes.exhaustion` follows that flag. Writing
//    `system.attributes.exhaustion` directly does NOT stick. So: toggle on, then set the flag.

import { resolveActorFuzzy } from '../_shared.js';

export async function applyCondition(args: {
  actorIdentifier: string;
  conditions: string[];
  active?: boolean;
  exhaustionLevel?: number;
}): Promise<unknown> {
  const actor = resolveActorFuzzy(args?.actorIdentifier);
  if (!actor) throw new Error(`Actor not found: ${args?.actorIdentifier}`);
  if (typeof actor.toggleStatusEffect !== 'function') {
    throw new Error('This Foundry version does not support Actor#toggleStatusEffect.');
  }

  const conditions = Array.isArray(args.conditions) ? args.conditions : [];
  if (conditions.length === 0) throw new Error('Provide at least one condition.');
  const active = args.active !== false;

  const CONFIG_: any = (globalThis as any).CONFIG ?? {};
  const validIds = new Set<string>([
    ...Object.keys(CONFIG_.DND5E?.conditionTypes ?? {}),
    ...((CONFIG_.statusEffects ?? []).map((s: any) => s.id).filter(Boolean) as string[]),
  ]);

  const applied: string[] = [];
  const removed: string[] = [];
  const warnings: string[] = [];

  const hasStatus = (id: string): boolean => actor.statuses?.has?.(id) ?? false;

  for (const raw of conditions) {
    const id = String(raw).trim().toLowerCase();
    if (!validIds.has(id)) {
      warnings.push(
        `Unknown condition "${raw}" — verify it matches dnd5e conditionTypes / statusEffects`
      );
      continue;
    }

    // Exhaustion: leveled — toggle on, then set the dnd5e.exhaustionLevel flag (derives the level).
    if (id === 'exhaustion') {
      const lvl =
        typeof args.exhaustionLevel === 'number'
          ? Math.max(0, Math.min(6, Math.round(args.exhaustionLevel)))
          : active
            ? 1
            : 0;
      if (!active || lvl <= 0) {
        if (hasStatus('exhaustion'))
          await actor.toggleStatusEffect('exhaustion', { active: false });
        removed.push('exhaustion');
      } else {
        // Ensure the exhaustion effect exists, then set the level via its dnd5e.exhaustionLevel flag
        // (the derived system.attributes.exhaustion follows the flag). dnd5e initializes a freshly
        // toggled exhaustion effect to level 1 via a DEFERRED step that can land AFTER our update and
        // clobber it back to 1, so set-confirm-retry until the level sticks (it does once dnd5e's
        // init settles). Update the PERSISTED effect off actor.effects — the doc toggleStatusEffect
        // returns is transient and its update does not persist.
        if (!hasStatus('exhaustion')) {
          await actor.toggleStatusEffect('exhaustion', { active: true });
        }
        const findEff = () =>
          actor.effects.find(
            (e: any) => e.statuses?.has?.('exhaustion') || /exhaustion/i.test(e.name ?? '')
          );
        let eff = findEff();
        if (!eff) {
          warnings.push('Could not locate the exhaustion effect to set its level.');
        } else {
          const sleep = (ms: number) => new Promise(r => (globalThis as any).setTimeout(r, ms));
          for (let attempt = 0; attempt < 5; attempt++) {
            const fresh = actor.effects.get(eff._id ?? eff.id) ?? findEff();
            if (!fresh) break;
            eff = fresh;
            if (eff.flags?.dnd5e?.exhaustionLevel === lvl) break;
            await eff.update({ 'flags.dnd5e.exhaustionLevel': lvl });
            await sleep(80); // let any deferred dnd5e re-init land before we re-check
          }
        }
        applied.push(`exhaustion ${lvl}`);
      }
      continue;
    }

    await actor.toggleStatusEffect(id, { active });
    (active ? applied : removed).push(id);
  }

  return {
    success: true,
    actor: { id: actor.id, name: actor.name, type: actor.type },
    applied,
    removed,
    warnings,
    statuses: Array.from(actor.statuses ?? []),
  };
}
