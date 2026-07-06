// Page-side: dnd5e Activity CRUD — runs INSIDE the headless Foundry page. The live orchestrator that
// adds / edits / removes / lists the rollable "activities" on an item, embedded on an actor or world-
// level. The byte-for-byte activity SHAPES live in the pure ./activities.js builder (unit-tested
// offline); this file owns the live document resolution + mutation, so it touches Foundry globals and
// is covered by the verify scripts, not unit tests (the page convention).
//
// Relocated here from actors.ts: activities are a dnd5e concept, so the orchestrator belongs in the
// dnd5e domain next to its builder — not in the system-agnostic actor reads/writes file. It depends
// only on the shared resolution helpers (_shared) + the pure builder (activities) + the shared cast
// plumbing (cast-spells: premium-only spell-link resolver + cached-copy settler); no actors.ts
// coupling, no import cycle.

import {
  resolveActorFuzzy as resolveActor,
  resolveActorItem,
  resolveWorldItem,
  toDeletionKey,
  toSource,
} from '../_shared.js';
import { buildActivity } from './activities.js';
import { resolveCastSpell, settleCachedSpellCopies } from './cast-spells.js';

/**
 * Add / edit / remove / list dnd5e Activities on an item — embedded on an actor (pass
 * actorIdentifier) OR a world Item (omit it). Activities live in system.activities keyed by id.
 *  - list:   return [{ id, type, name }]
 *  - add:    build the activity via the shared buildActivity(type, opts) and set it under a fresh id
 *  - edit:   apply a dot-path `patch` (relative to the activity root) and/or rename it
 *  - remove: delete the activity by id (via the `-=` form)
 * This is the dnd5e-aware activity authoring keystone (e.g. a Multiattack = a feat with a utility
 * activity). It edits document data; it does not run combat.
 */
export async function manageActivity(params: {
  action: 'add' | 'edit' | 'remove' | 'list';
  itemIdentifier: string;
  actorIdentifier?: string;
  activityId?: string;
  activity?: Record<string, any>;
  patch?: Record<string, any>;
}): Promise<unknown> {
  const { action, itemIdentifier } = params ?? ({} as any);
  if (!itemIdentifier) throw new Error('itemIdentifier is required');

  // Resolve the item (embedded on an actor, or world-level) + the matching write path.
  let item: any;
  let actorDoc: any = null;
  let actorRef: { id: string; name: string } | null = null;
  let applyUpdate: (data: Record<string, any>) => Promise<any>;
  if (params.actorIdentifier) {
    const actor = resolveActor(params.actorIdentifier);
    if (!actor) throw new Error(`Actor not found: ${params.actorIdentifier}`);
    item = resolveActorItem(actor, itemIdentifier);
    if (!item) throw new Error(`Item "${itemIdentifier}" not found on actor "${actor.name}"`);
    actorDoc = actor;
    actorRef = { id: actor.id, name: actor.name };
    applyUpdate = data => actor.updateEmbeddedDocuments('Item', [{ _id: item.id, ...data }]);
  } else {
    item = resolveWorldItem(itemIdentifier);
    if (!item) throw new Error(`World Item "${itemIdentifier}" not found`);
    applyUpdate = data => item.update(data);
  }

  const activities: Record<string, any> = toSource(item).system?.activities ?? {};
  const itemRef = { id: item.id, name: item.name, type: item.type };
  const base = { success: true, item: itemRef, ...(actorRef ? { actor: actorRef } : {}) };

  switch (action) {
    case 'list':
      return {
        ...base,
        activities: Object.values(activities).map((a: any) => ({
          id: a._id,
          type: a.type,
          name: a.name ?? '',
        })),
      };

    case 'add': {
      const type = params.activity?.type;
      if (!type) throw new Error('activity.type is required to add an activity.');
      const id = foundry.utils.randomID(16);
      const { type: _t, ...rest } = params.activity ?? {};
      // A cast activity LINKS a real compendium spell: resolve+validate it (off-book/SRD throws),
      // then fill the facts the pure builder needs (cast level default, V/S/M components, name,
      // the spell's own casting time). With charges on an item that has NO uses pool of its own
      // (e.g. a feature), the pool goes ON the activity — an itemUses target pointing at an empty
      // pool would silently never cast.
      if (type === 'cast') {
        const spell = await resolveCastSpell(rest.spellUuid);
        if (rest.level === undefined || rest.level === null) rest.level = spell.level;
        rest.spellProperties = spell.properties;
        if (!rest.name) rest.name = `Cast ${spell.name}`;
        if (!rest.activationType) rest.activationType = spell.activationType;
        if (rest.charges !== undefined && rest.charges !== null && !rest.usesOn) {
          const parentMax = toSource(item).system?.uses?.max;
          rest.usesOn = typeof parentMax === 'string' && parentMax !== '' ? 'item' : 'activity';
        }
      }
      const act = buildActivity(type, { id, ...rest });
      await applyUpdate({ [`system.activities.${id}`]: act });
      // Embedded cast: dnd5e async-mints the "Additional Spells" cached copy (and multi-mints
      // under v14) — settle it to exactly one deterministically.
      let cachedSpell: unknown;
      if (type === 'cast' && actorDoc) {
        const liveItem = actorDoc.items?.get?.(item.id) ?? item;
        cachedSpell = await settleCachedSpellCopies(actorDoc, liveItem, id);
      }
      return {
        ...base,
        action: 'add',
        activityId: id,
        type,
        ...(type === 'cast' ? { spell: rest.spellUuid } : {}),
        ...(cachedSpell ? { cachedSpell } : {}),
      };
    }

    case 'edit': {
      const id = params.activityId;
      if (!id) throw new Error('activityId is required to edit an activity.');
      if (!activities[id]) throw new Error(`Activity "${id}" not found on item "${item.name}".`);
      const data: Record<string, any> = {};
      if (typeof params.activity?.name === 'string') {
        data[`system.activities.${id}.name`] = params.activity.name;
      }
      for (const [k, v] of Object.entries(params.patch ?? {})) {
        data[`system.activities.${id}.${k}`] = v;
      }
      if (Object.keys(data).length === 0) {
        throw new Error('Provide a `patch` (and/or activity.name) to edit.');
      }
      await applyUpdate(data);
      return { ...base, action: 'edit', activityId: id, editedKeys: Object.keys(data) };
    }

    case 'remove': {
      const id = params.activityId;
      if (!id) throw new Error('activityId is required to remove an activity.');
      if (!activities[id]) throw new Error(`Activity "${id}" not found on item "${item.name}".`);
      await applyUpdate({ [toDeletionKey(`system.activities.${id}`)]: null });
      return { ...base, action: 'remove', activityId: id };
    }

    default:
      throw new Error(`Unknown action "${action}". Use add, edit, remove, or list.`);
  }
}
