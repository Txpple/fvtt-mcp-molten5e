// Page-side: dnd5e feature-granted FREE CASTING — put "cast without a spell slot, N/rest" ON the
// spell itself, never on a separate Features-tab tracker feat.
//
// The shape is copied from the premium PHB Hunter's Mark (Favored Enemy), which ships this natively:
// the spell carries its own use pool (`system.uses`, e.g. max "@scale.ranger.favored-enemy",
// long-rest recovery) plus a `forward` activity that re-triggers the spell's real cast activity
// while consuming 1 item use instead of a slot. One Spells-tab entry, two cast options in the row.
//
// Naming convention (house rule): the forward activity is `<Spell Name> - <granting feature>`,
// e.g. "Bless - Magic Initiate", "Hunter's Mark - Favored Enemy".
//
// buildFreeCastUpdate() is PURE (no Foundry globals) so it unit-tests offline in free-cast.test.ts;
// addFreeCast() resolves the actor (fuzzy; placed-token ids reach that token's delta) and the
// embedded spell, applies the update, and reads the result back.

import { resolveActorFuzzy, resolveActorItem } from '../_shared.js';

/** Recovery periods a feature-granted free cast can meaningfully use (dnd5e 5.3 uses.recovery). */
const RECOVERY_PERIODS = new Set(['lr', 'sr', 'day', 'dawn', 'dusk']);

export interface FreeCastOpts {
  /** Feature/feat that grants the free casting — becomes the activity name suffix. */
  grantedBy: string;
  /** Use-pool max. A number or a formula string (e.g. "@scale.ranger.favored-enemy"). Default "1". */
  uses?: string | number;
  /** dnd5e recovery period key. Default "lr" (the 2024 wording for feat-granted casts). */
  recoveryPeriod?: string;
  /** Explicit cast activity to forward to; default = the spell's slot-consuming cast activity. */
  activityId?: string;
}

export interface FreeCastUpdate {
  /** Dot-path update to apply via updateEmbeddedDocuments (without _id). */
  update: Record<string, unknown>;
  /** Id of the forward activity written (a fresh id, or the reused existing forward's id). */
  activityId: string;
  activityName: string;
  /** The cast activity the forward re-triggers. */
  targetActivityId: string;
  /** True when an existing forward already pointed at the target and was updated in place. */
  reused: boolean;
  warnings: string[];
}

/** Numeric sort with a stable fallback so Object.entries order can't flip the pick. */
function sortOf(activity: any): number {
  return typeof activity?.sort === 'number' ? activity.sort : Number.MAX_SAFE_INTEGER;
}

/**
 * Build the item update that wires a free cast onto a spell (pure; `spell` is item.toObject()).
 * Throws on a non-spell item, an unknown recovery period, a missing explicit activity, or a spell
 * with no slot-consuming cast activity to forward to.
 */
export function buildFreeCastUpdate(
  spell: { name?: string; type?: string; system?: any },
  opts: FreeCastOpts,
  newId: string
): FreeCastUpdate {
  if (spell?.type !== 'spell') {
    throw new Error(`Free casting applies to spells only — got item type "${spell?.type}"`);
  }
  const grantedBy = String(opts.grantedBy ?? '').trim();
  if (!grantedBy) throw new Error('grantedBy is required (e.g. "Magic Initiate")');

  const period = opts.recoveryPeriod ?? 'lr';
  if (!RECOVERY_PERIODS.has(period)) {
    throw new Error(
      `Unknown recoveryPeriod "${period}" — expected one of: ${[...RECOVERY_PERIODS].join(', ')}`
    );
  }

  const activities: Record<string, any> = spell.system?.activities ?? {};
  const warnings: string[] = [];

  // Pick the cast activity the forward re-triggers.
  let targetActivityId: string;
  if (opts.activityId) {
    const explicit = activities[opts.activityId];
    if (!explicit) throw new Error(`Activity "${opts.activityId}" not found on "${spell.name}"`);
    if (explicit.type === 'forward') {
      throw new Error(`Activity "${opts.activityId}" is itself a forward — target a cast activity`);
    }
    targetActivityId = opts.activityId;
  } else {
    const castable = Object.entries(activities)
      .filter(([, a]) => a?.type !== 'forward' && a?.consumption?.spellSlot === true)
      .sort(([, a], [, b]) => sortOf(a) - sortOf(b));
    if (castable.length === 0) {
      throw new Error(
        `"${spell.name}" has no slot-consuming cast activity to forward to — pass activityId explicitly`
      );
    }
    targetActivityId = castable[0]![0];
  }
  const target = activities[targetActivityId];

  // Idempotence: a forward already re-triggering this activity is updated in place, not duplicated.
  const existingForward = Object.entries(activities).find(
    ([, a]) => a?.type === 'forward' && a?.activity?.id === targetActivityId
  );
  const activityId = existingForward ? existingForward[0] : newId;
  const reused = Boolean(existingForward);
  if (reused) {
    warnings.push(
      `Spell already had a free-cast forward ("${existingForward![1]?.name || existingForward![0]}") — updated it in place`
    );
  }

  // The spell's own use pool. Preserve spent uses on a re-run; warn when changing an existing max.
  const usesMax = String(opts.uses ?? '1');
  const existingUses = spell.system?.uses ?? {};
  const existingMax = typeof existingUses.max === 'string' ? existingUses.max : '';
  if (existingMax && existingMax !== usesMax) {
    warnings.push(`Spell uses.max was "${existingMax}" — overwritten with "${usesMax}"`);
  }
  const spent = typeof existingUses.spent === 'number' ? existingUses.spent : 0;

  const activityName = `${spell.name} - ${grantedBy}`;
  const update: Record<string, unknown> = {
    'system.uses': {
      max: usesMax,
      spent,
      recovery: [{ period, type: 'recoverAll' }],
    },
    [`system.activities.${activityId}`]: {
      _id: activityId,
      type: 'forward',
      name: activityName,
      sort: 100001,
      activity: { id: targetActivityId },
      // Mirrors the premium Hunter's Mark forward byte-for-byte: itemUses consumption replaces the
      // slot spend (spellSlot stays true on the shape; the forward's own consumption wins).
      consumption: {
        targets: [{ type: 'itemUses', target: '', value: '1', scaling: {} }],
        scaling: { allowed: false },
        spellSlot: true,
      },
      img: null,
      activation: { type: target?.activation?.type ?? 'action', override: false },
      description: {},
      flags: {},
      uses: { spent: 0, recovery: [] },
      visibility: {
        level: {},
        requireAttunement: false,
        requireIdentification: false,
        requireMagic: false,
      },
    },
  };

  return { update, activityId, activityName, targetActivityId, reused, warnings };
}

/** Wire a feature-granted free cast onto a spell embedded on an actor. */
export async function addFreeCast(params: {
  actorIdentifier: string;
  spellIdentifier: string;
  grantedBy: string;
  uses?: string | number;
  recoveryPeriod?: string;
  activityId?: string;
}): Promise<unknown> {
  const { actorIdentifier, spellIdentifier } = params ?? ({} as any);
  if (!actorIdentifier) throw new Error('actorIdentifier is required');
  if (!spellIdentifier) throw new Error('spellIdentifier is required');

  const actor = resolveActorFuzzy(actorIdentifier);
  if (!actor) throw new Error(`Actor not found: ${actorIdentifier}`);
  const item = resolveActorItem(actor, spellIdentifier, 'spell');
  if (!item) throw new Error(`Spell "${spellIdentifier}" not found on actor "${actor.name}"`);

  const built = buildFreeCastUpdate(
    item.toObject(),
    params,
    (globalThis as any).foundry.utils.randomID(16)
  );
  await actor.updateEmbeddedDocuments('Item', [{ _id: item.id, ...built.update }]);

  // Read back off the live doc's source so the report reflects what actually persisted.
  const updated = actor.items?.get?.(item.id) ?? item;
  const persisted = updated.toObject()?.system ?? {};
  const forward = persisted.activities?.[built.activityId];
  if (forward?.type !== 'forward') {
    throw new Error(`Free-cast forward did not persist on "${updated.name}"`);
  }

  return {
    success: true,
    actor: { id: actor.id, name: actor.name },
    item: { id: updated.id, name: updated.name, type: updated.type },
    activity: {
      id: built.activityId,
      name: forward.name,
      targetActivityId: built.targetActivityId,
      reused: built.reused,
    },
    uses: { max: persisted.uses?.max, recovery: persisted.uses?.recovery },
    warnings: built.warnings,
  };
}
