// Page-side: ActiveEffect authoring. Runs inside the headless Foundry page.
//
// manageEffect creates / edits / deletes / lists ActiveEffects on an actor OR an item (embedded on
// an actor, or a world item). It authors effect DATA; it does not run combat (no duration tick-down).
//
// Live-verified dnd5e 5.3.3 / Foundry v14 facts:
//  - changes[] is a TOP-LEVEL field on the effect (effect.changes), NOT effect.system.changes.
//  - A change is { key, value, type, phase }: `type` is a STRING (override/add/multiply/upgrade/
//    downgrade/custom) — the legacy numeric `mode` is still accepted and normalized to `type`.
//    `phase` defaults to "initial". `value` is stored as a string.
//  - `transfer` (item effects) makes the effect apply to the owning actor; default true for items.

import { resolveActorFuzzy } from './_shared.js';
import { resolveActorItem, resolveWorldItem } from './actors.js';

/** Legacy numeric ActiveEffect mode → v14 string type (CONST.ACTIVE_EFFECT_MODES). */
const MODE_NUM_TO_TYPE: Record<number, string> = {
  0: 'custom',
  1: 'multiply',
  2: 'add',
  3: 'downgrade',
  4: 'upgrade',
  5: 'override',
};

/** Normalize an authored change to the v14 { key, value(string), type, phase } shape. */
function normalizeChange(c: any): Record<string, unknown> {
  const type =
    typeof c?.type === 'string'
      ? c.type
      : typeof c?.mode === 'number'
        ? (MODE_NUM_TO_TYPE[c.mode] ?? 'add')
        : 'add';
  return {
    key: String(c?.key ?? ''),
    value: c?.value === undefined || c?.value === null ? '' : String(c.value),
    type,
    phase: typeof c?.phase === 'string' ? c.phase : 'initial',
  };
}

/** Summarize an effect's changes for list/read output (surfacing type from legacy mode if needed). */
function summarizeChanges(changes: any[]): Array<Record<string, unknown>> {
  return (changes ?? []).map((c: any) => ({
    key: c?.key,
    value: c?.value,
    type: typeof c?.type === 'string' ? c.type : (MODE_NUM_TO_TYPE[c?.mode] ?? undefined),
  }));
}

export async function manageEffect(params: {
  action: 'create' | 'edit' | 'delete' | 'list';
  actorIdentifier?: string;
  itemIdentifier?: string;
  effectId?: string;
  effect?: Record<string, any>;
  patch?: Record<string, any>;
}): Promise<unknown> {
  const { action } = params ?? ({} as any);

  // Resolve the parent document (actor, embedded item, or world item) that owns the effects.
  let parent: any;
  let parentRef: Record<string, any>;
  let kind: 'actor' | 'item';
  if (params.actorIdentifier && params.itemIdentifier) {
    const actor = resolveActorFuzzy(params.actorIdentifier);
    if (!actor) throw new Error(`Actor not found: ${params.actorIdentifier}`);
    const item = resolveActorItem(actor, params.itemIdentifier);
    if (!item)
      throw new Error(`Item "${params.itemIdentifier}" not found on actor "${actor.name}"`);
    parent = item;
    kind = 'item';
    parentRef = {
      actor: { id: actor.id, name: actor.name },
      item: { id: item.id, name: item.name, type: item.type },
    };
  } else if (params.actorIdentifier) {
    const actor = resolveActorFuzzy(params.actorIdentifier);
    if (!actor) throw new Error(`Actor not found: ${params.actorIdentifier}`);
    parent = actor;
    kind = 'actor';
    parentRef = { actor: { id: actor.id, name: actor.name } };
  } else if (params.itemIdentifier) {
    const item = resolveWorldItem(params.itemIdentifier);
    if (!item) throw new Error(`World Item "${params.itemIdentifier}" not found`);
    parent = item;
    kind = 'item';
    parentRef = { item: { id: item.id, name: item.name, type: item.type } };
  } else {
    throw new Error('Provide actorIdentifier and/or itemIdentifier.');
  }

  const effectsList = Array.from(parent.effects ?? []);
  const base = { success: true, ...parentRef };

  switch (action) {
    case 'list':
      return {
        ...base,
        effects: effectsList.map((e: any) => ({
          id: e.id,
          name: e.name,
          disabled: e.disabled,
          transfer: e.transfer,
          statuses: Array.from(e.statuses ?? []),
          changes: summarizeChanges(e.changes),
        })),
      };

    case 'create': {
      const eff = params.effect ?? {};
      const data: Record<string, any> = {
        name: eff.name ?? 'Effect',
        img: eff.img ?? 'icons/svg/aura.svg',
        changes: Array.isArray(eff.changes) ? eff.changes.map(normalizeChange) : [],
        disabled: eff.disabled ?? false,
        // Item effects must transfer to apply to the owning actor; actor effects apply directly.
        transfer: eff.transfer ?? kind === 'item',
      };
      if (Array.isArray(eff.statuses)) data.statuses = eff.statuses;
      if (typeof eff.description === 'string') data.description = eff.description;
      if (eff.duration && typeof eff.duration === 'object') data.duration = eff.duration;
      const [created] = (await parent.createEmbeddedDocuments('ActiveEffect', [data])) as any[];
      if (!created) throw new Error('Failed to create the ActiveEffect.');
      return { ...base, action: 'create', effectId: created.id, name: created.name };
    }

    case 'edit': {
      const id = params.effectId;
      if (!id) throw new Error('effectId is required to edit an effect.');
      const eff = parent.effects?.get?.(id);
      if (!eff) throw new Error(`Effect "${id}" not found on "${parent.name}".`);
      const update: Record<string, any> = { _id: id };
      const e = params.effect ?? {};
      if (typeof e.name === 'string') update.name = e.name;
      if (typeof e.disabled === 'boolean') update.disabled = e.disabled;
      if (typeof e.transfer === 'boolean') update.transfer = e.transfer;
      if (Array.isArray(e.changes)) update.changes = e.changes.map(normalizeChange); // replace whole
      if (Array.isArray(e.statuses)) update.statuses = e.statuses;
      for (const [k, v] of Object.entries(params.patch ?? {})) update[k] = v;
      if (Object.keys(update).length === 1) {
        throw new Error('Provide effect fields (name/disabled/changes/...) or a patch to edit.');
      }
      await parent.updateEmbeddedDocuments('ActiveEffect', [update]);
      return {
        ...base,
        action: 'edit',
        effectId: id,
        editedKeys: Object.keys(update).filter(k => k !== '_id'),
      };
    }

    case 'delete': {
      const id = params.effectId;
      if (!id) throw new Error('effectId is required to delete an effect.');
      const eff = parent.effects?.get?.(id);
      if (!eff) throw new Error(`Effect "${id}" not found on "${parent.name}".`);
      await parent.deleteEmbeddedDocuments('ActiveEffect', [id]);
      return { ...base, action: 'delete', effectId: id };
    }

    default:
      throw new Error(`Unknown action "${action}". Use create, edit, delete, or list.`);
  }
}
