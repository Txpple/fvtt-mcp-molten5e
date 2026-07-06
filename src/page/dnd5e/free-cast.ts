// Page-side: dnd5e feature-granted FREE CASTING — the native Cast-activity shape.
//
// House rule (owner, 2026-07-05 — SUPERSEDES the earlier forward-on-the-spell shape): when a
// feature grants "cast X without a spell slot, N per rest" (Magic Initiate, Favored Enemy, a
// lineage grant, a magic item's 1/day), the sheet gets TWO entries:
//
//   1. The REPERTOIRE copy — the spell as a normal, ALWAYS-PREPARED entry (prepared: 2; the 2024
//      wording is "you always have that spell prepared"), castable with slots like any other spell.
//      NO pools, NO forward activities, no use-dialog. Imported from the compendium if missing.
//   2. The FREE CAST — a `cast` activity ON THE GRANTING FEATURE, linking the compendium spell,
//      with its own uses pool on the activity (activityUses, default 1/long rest), casting at base
//      level with no slot. `spell.spellbook: true` makes dnd5e project a cached spell item into the
//      sheet's NATIVE "Additional Spells" spellbook section (DND5E.CAST.SECTIONS.Spellbook) whose
//      row counter reads the activity pool. The cached copy is titled `<Spell> - <Feature>`.
//
// Anything still carrying the OLD shape (a use pool + `forward` activity on the repertoire spell —
// including the premium Hunter's Mark's native forward) is MIGRATED off it in the same call.
//
// buildFreeCastActivityPlan() / buildRepertoireCleanup() are PURE (no Foundry globals) so they
// unit-test offline in free-cast.test.ts; addFreeCast() is the live orchestrator (verify-script
// covered, the page convention), composing the shared cast-spells plumbing: resolveCastSpell (the
// premium-only spell-link resolver) and settleCachedSpellCopies (the deterministic dedupe of the
// system's async — and under v14, multi-firing — cached-copy mint).

import { resolveActorFuzzy, resolveActorItem, toSource } from '../_shared.js';
import { buildActivity } from './activities.js';
import {
  resolveCastSpell,
  resolveSpellUuidByName,
  settleCachedSpellCopies,
  type CastSpellFacts,
} from './cast-spells.js';

/** Recovery periods a feature-granted free cast can meaningfully use (dnd5e 5.3 uses.recovery). */
const RECOVERY_PERIODS = new Set(['lr', 'sr', 'day', 'dawn', 'dusk']);

export interface FreeCastPlanOpts {
  /** Free casts per recovery period — a number or a formula ("@scale.ranger.favored-enemy"). */
  uses?: string | number | undefined;
  /** dnd5e recovery period key. Default "lr" (the 2024 wording for feat-granted casts). */
  recoveryPeriod?: string | undefined;
}

export interface FreeCastActivityPlan {
  /** Dot-path update to apply to the FEATURE item (without _id). */
  update: Record<string, unknown>;
  activityId: string;
  activityName: string;
  /** True when the feature already had a cast activity for this spell and it was rebuilt in place. */
  reused: boolean;
  warnings: string[];
}

/**
 * Plan the free-cast `cast` activity on the granting FEATURE (pure; `feature` is item.toObject()).
 * Idempotent: an existing cast activity linking the same spell uuid is rebuilt under its own id,
 * preserving spent uses. Throws on a spell-type "feature" or an unknown recovery period.
 */
export function buildFreeCastActivityPlan(
  feature: { name?: string; type?: string; system?: any },
  spell: Pick<CastSpellFacts, 'uuid' | 'name' | 'level' | 'properties' | 'activationType'>,
  opts: FreeCastPlanOpts,
  newId: string
): FreeCastActivityPlan {
  if (!feature || feature.type === 'spell') {
    throw new Error(
      'The free cast lands ON the granting FEATURE (a feat/feature/item), not on a spell — pass ' +
        'the feature that grants it (e.g. "Magic Initiate", "Favored Enemy") as grantedBy.'
    );
  }
  const period = opts.recoveryPeriod ?? 'lr';
  if (!RECOVERY_PERIODS.has(period)) {
    throw new Error(
      `Unknown recoveryPeriod "${period}" — expected one of: ${[...RECOVERY_PERIODS].join(', ')}`
    );
  }
  const usesMax = String(opts.uses ?? '1');
  const warnings: string[] = [];

  // Idempotence: a cast activity already linking this spell is patched in place, not duplicated.
  const activities: Record<string, any> = feature.system?.activities ?? {};
  const existing = Object.entries(activities).find(
    ([, a]) => a?.type === 'cast' && a?.spell?.uuid === spell.uuid
  );
  const activityId = existing ? existing[0] : newId;
  const reused = Boolean(existing);
  const activityName = `${spell.name} - ${feature.name}`;

  let update: Record<string, unknown>;
  if (reused) {
    // Patch SUB-PATHS only, and never resend spell.uuid: dnd5e's preUpdateActivities treats a
    // spell.uuid in the changed payload as "the linked spell changed" and DELETES + re-mints the
    // cached spellbook copy — a race that orphans the entry. Spent uses survive by omission.
    const base = `system.activities.${activityId}`;
    update = {
      [`${base}.name`]: activityName,
      [`${base}.uses.max`]: usesMax,
      [`${base}.uses.recovery`]: [{ period, type: 'recoverAll' }],
      [`${base}.consumption.spellSlot`]: false,
      [`${base}.consumption.targets`]: [
        { type: 'activityUses', value: '1', target: '', scaling: { mode: '', formula: '' } },
      ],
    };
    warnings.push(
      `"${feature.name}" already had a free-cast activity for this spell ` +
        `("${existing![1]?.name || activityId}") — updated it in place`
    );
  } else {
    const activity = buildActivity('cast', {
      id: activityId,
      name: activityName,
      // The cast inherits the SPELL's own casting time (Healing Word stays a bonus action).
      activationType: spell.activationType,
      spellUuid: spell.uuid,
      level: spell.level,
      spellProperties: spell.properties,
      charges: usesMax,
      usesOn: 'activity',
      recoveryPeriod: period,
    });
    update = { [`system.activities.${activityId}`]: activity };
  }

  return { update, activityId, activityName, reused, warnings };
}

export interface RepertoireCleanup {
  /** Dot-path update for the repertoire spell, or null when it is already clean. */
  update: Record<string, unknown> | null;
  /** Forward activities stripped (the OLD free-cast shape, incl. the premium Hunter's Mark's). */
  removedForwardIds: string[];
  clearedPool: boolean;
  /** True when prepared was raised to 2 (always prepared — the 2024 feat wording + house rule). */
  raisedPrepared: boolean;
  warnings: string[];
}

/**
 * Plan the migration of a repertoire spell OFF the old free-cast shape (pure): strip `forward`
 * activities and the on-spell use pool, and raise preparation to ALWAYS PREPARED. Returns
 * update: null when the spell is already clean.
 */
export function buildRepertoireCleanup(spell: {
  name?: string;
  type?: string;
  system?: any;
}): RepertoireCleanup {
  if (spell?.type !== 'spell') {
    throw new Error(`Repertoire cleanup applies to spells only — got item type "${spell?.type}"`);
  }
  const update: Record<string, unknown> = {};
  const warnings: string[] = [];

  const activities: Record<string, any> = spell.system?.activities ?? {};
  const removedForwardIds = Object.entries(activities)
    .filter(([, a]) => a?.type === 'forward')
    .map(([id]) => id);
  for (const id of removedForwardIds) {
    update[`system.activities.-=${id}`] = null;
  }
  if (removedForwardIds.length > 0) {
    warnings.push(
      `Stripped ${removedForwardIds.length} old-shape forward activit` +
        `${removedForwardIds.length === 1 ? 'y' : 'ies'} off "${spell.name}"`
    );
  }

  const existingMax = spell.system?.uses?.max;
  const clearedPool = typeof existingMax === 'string' && existingMax !== '';
  if (clearedPool) {
    update['system.uses'] = { max: '', spent: 0, recovery: [] };
    warnings.push(`Cleared the old on-spell use pool (was "${existingMax}") off "${spell.name}"`);
  }

  const raisedPrepared = (spell.system?.prepared ?? 0) < 2;
  if (raisedPrepared) update['system.prepared'] = 2;

  return {
    update: Object.keys(update).length > 0 ? update : null,
    removedForwardIds,
    clearedPool,
    raisedPrepared,
    warnings,
  };
}

/**
 * Grant a feature-granted free cast the native way: ensure the always-prepared repertoire copy
 * (importing it from the compendium if absent), migrate any old shape off it, wire the cast
 * activity onto the granting feature, and settle the "Additional Spells" cached copy.
 */
export async function addFreeCast(params: {
  actorIdentifier: string;
  spellIdentifier: string;
  grantedBy: string;
  uses?: string | number;
  recoveryPeriod?: string;
}): Promise<unknown> {
  const { actorIdentifier, spellIdentifier, grantedBy } = params ?? ({} as any);
  if (!actorIdentifier) throw new Error('actorIdentifier is required');
  if (!spellIdentifier) throw new Error('spellIdentifier is required');
  if (!grantedBy || !String(grantedBy).trim()) {
    throw new Error('grantedBy is required — the feature ITEM on the actor that grants the cast');
  }

  const actor = resolveActorFuzzy(actorIdentifier);
  if (!actor) throw new Error(`Actor not found: ${actorIdentifier}`);

  // The granting feature must be a real item on the actor — the cast activity lives ON it.
  const feature = resolveActorItem(actor, grantedBy);
  if (!feature || feature.type === 'spell') {
    const candidates = (actor.items as any[])
      .filter((i: any) => i.type === 'feat')
      .slice(0, 12)
      .map((i: any) => i.name)
      .join(', ');
    throw new Error(
      `Granting feature "${grantedBy}" not found on "${actor.name}" (or it resolved to a spell). ` +
        `Pass the feat/feature ITEM that grants the cast. Feats on this actor: ${candidates || '(none)'}`
    );
  }

  // Resolve the spell: an embedded repertoire copy (its compendium source is the link — falling
  // back to a premium-pack name lookup, since raw toObject() imports carry no compendiumSource),
  // or a premium compendium uuid directly (the repertoire copy is then imported).
  const embedded = resolveActorItem(actor, spellIdentifier, 'spell');
  let uuid: string | null = embedded
    ? ((toSource(embedded) as any)?._stats?.compendiumSource ?? null)
    : String(spellIdentifier).startsWith('Compendium.')
      ? String(spellIdentifier)
      : null;
  if (!uuid && embedded) uuid = await resolveSpellUuidByName(embedded.name);
  if (!uuid) {
    throw new Error(
      embedded
        ? `Spell "${embedded.name}" on "${actor.name}" has no compendium source and no premium-pack ` +
            'name match to link — pass the premium compendium uuid ' +
            '(e.g. "Compendium.dnd-players-handbook.spells.Item.…") as spellIdentifier instead.'
        : `Spell "${spellIdentifier}" not found on "${actor.name}" — pass an embedded spell ` +
            '(name/id) or a premium compendium uuid to import it into the repertoire.'
    );
  }
  const facts = await resolveCastSpell(uuid);
  const warnings: string[] = [];

  // 1. The repertoire copy: import it if missing (always prepared), else migrate the old shape off.
  let repertoire: { id: string; name: string; imported: boolean; migrated: boolean };
  if (!embedded) {
    const data = (game as any).items.fromCompendium(facts.doc);
    foundry.utils.setProperty(data, 'system.prepared', 2);
    const [created] = (await actor.createEmbeddedDocuments('Item', [data])) as any[];
    repertoire = { id: created.id, name: created.name, imported: true, migrated: false };
  } else {
    const cleanup = buildRepertoireCleanup(toSource(embedded) as any);
    if (cleanup.update) {
      await actor.updateEmbeddedDocuments('Item', [{ _id: embedded.id, ...cleanup.update }]);
    }
    warnings.push(...cleanup.warnings);
    repertoire = {
      id: embedded.id,
      name: embedded.name,
      imported: false,
      migrated: cleanup.update !== null,
    };
  }

  // 2. The cast activity on the granting feature.
  const plan = buildFreeCastActivityPlan(
    toSource(feature) as any,
    facts,
    { uses: params.uses, recoveryPeriod: params.recoveryPeriod },
    (globalThis as any).foundry.utils.randomID(16)
  );
  warnings.push(...plan.warnings);
  await actor.updateEmbeddedDocuments('Item', [{ _id: feature.id, ...plan.update }]);

  // 3. Settle the "Additional Spells" cached copy (dedupe the v14 multi-mint, apply the name).
  const liveFeature = actor.items?.get?.(feature.id) ?? feature;
  const persisted = liveFeature.toObject()?.system?.activities?.[plan.activityId];
  if (persisted?.type !== 'cast') {
    throw new Error(`Free-cast activity did not persist on "${liveFeature.name}"`);
  }
  const settled = await settleCachedSpellCopies(
    actor,
    liveFeature,
    plan.activityId,
    plan.activityName
  );
  warnings.push(...settled.warnings);

  return {
    success: true,
    actor: { id: actor.id, name: actor.name },
    feature: { id: liveFeature.id, name: liveFeature.name },
    spell: { uuid: facts.uuid, name: facts.name, level: facts.level },
    repertoire,
    activity: {
      id: plan.activityId,
      name: plan.activityName,
      reused: plan.reused,
      uses: { max: persisted.uses?.max, recovery: persisted.uses?.recovery },
      activationType: persisted.activation?.type,
    },
    additionalSpells: {
      cachedId: settled.cachedId,
      name: settled.cachedName,
      mintedBy: settled.mintedBy,
      removedDuplicates: settled.removedDuplicates,
    },
    warnings,
  };
}
