// Page-side: dnd5e Activity CRUD — runs INSIDE the headless Foundry page. The live orchestrator that
// adds / edits / removes / lists the rollable "activities" on an item, embedded on an actor or world-
// level. The byte-for-byte activity SHAPES live in the pure ./activities.js builder (unit-tested
// offline); this file owns the live document resolution + mutation, so it touches Foundry globals and
// is covered by the verify scripts, not unit tests (the page convention).
//
// Relocated here from actors.ts: activities are a dnd5e concept, so the orchestrator belongs in the
// dnd5e domain next to its builder — not in the system-agnostic actor reads/writes file. It depends
// only on the shared resolution helpers (_shared) + the pure builder (activities) + the
// premium/SRD source policy (compendium-sources); no actors.ts coupling, no import cycle.

import { isSrdPack } from '../../utils/compendium-sources.js';
import {
  resolveActorFuzzy as resolveActor,
  resolveActorItem,
  resolveWorldItem,
  toDeletionKey,
  toSource,
} from '../_shared.js';
import { buildActivity } from './activities.js';

/**
 * Resolve a spell uuid for a `cast` activity (the activity LINKS a real compendium spell — design.md
 * §2.3 / authoring-policy: an item's referenced spell is reached by COPYING a book spell, never by
 * hand-rolling a fake save/damage activity). Validates the link and returns the facts the pure
 * buildCastActivity needs (level / V·S·M components / name); it NEVER invents — an off-book or SRD
 * spell throws so the skill STOPs and ASKs instead of fabricating.
 */
async function resolveCastSpell(
  spellUuid: string | undefined
): Promise<{ uuid: string; level: number; properties: string[]; name: string }> {
  if (!spellUuid) {
    throw new Error(
      'A cast activity requires `spellUuid` — the Compendium uuid of the spell to link ' +
        '(e.g. "Compendium.dnd-players-handbook.spells.Item.phbsplFireball00").'
    );
  }
  const spell: any = await fromUuid(spellUuid);
  if (!spell) {
    throw new Error(
      `Spell not found for uuid "${spellUuid}". A cast activity must LINK a real compendium spell ` +
        '(mirror the Wand of Fireballs). If the spell is not in the premium books, STOP and ASK — ' +
        'substitute a book spell, drop it, or get explicit homebrew permission; do not hand-roll a ' +
        'fake save/damage activity to simulate an off-book spell (design.md §2.3).'
    );
  }
  if (spell.documentName !== 'Item' || spell.type !== 'spell') {
    throw new Error(
      `uuid "${spellUuid}" resolves to a ${spell.documentName}/${spell.type ?? '?'}, not a spell.`
    );
  }
  const packId: string = spell.pack ?? '';
  if (isSrdPack(packId)) {
    throw new Error(
      `Refusing to link an SRD spell (pack "${packId}") into a cast activity — author from the ` +
        'premium books only (design.md §2.3). Use the dnd-players-handbook.spells equivalent.'
    );
  }
  const src = toSource(spell);
  const rawProps = src?.system?.properties;
  const allProps: string[] = Array.isArray(rawProps) ? rawProps : Array.from(rawProps ?? []);
  // The cast activity carries only the V/S/M casting COMPONENTS (not concentration/ritual/etc).
  const COMPONENTS = new Set(['vocal', 'somatic', 'material']);
  const properties = allProps.filter(p => COMPONENTS.has(p));
  return {
    uuid: spellUuid,
    level: typeof src?.system?.level === 'number' ? src.system.level : 0,
    properties,
    name: spell.name ?? 'Spell',
  };
}

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
  let actorRef: { id: string; name: string } | null = null;
  let applyUpdate: (data: Record<string, any>) => Promise<any>;
  if (params.actorIdentifier) {
    const actor = resolveActor(params.actorIdentifier);
    if (!actor) throw new Error(`Actor not found: ${params.actorIdentifier}`);
    item = resolveActorItem(actor, itemIdentifier);
    if (!item) throw new Error(`Item "${itemIdentifier}" not found on actor "${actor.name}"`);
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
      // then fill the facts the pure builder needs (cast level default, V/S/M components, name).
      if (type === 'cast') {
        const spell = await resolveCastSpell(rest.spellUuid);
        if (rest.level === undefined || rest.level === null) rest.level = spell.level;
        rest.spellProperties = spell.properties;
        if (!rest.name) rest.name = `Cast ${spell.name}`;
      }
      const act = buildActivity(type, { id, ...rest });
      await applyUpdate({ [`system.activities.${id}`]: act });
      return {
        ...base,
        action: 'add',
        activityId: id,
        type,
        ...(type === 'cast' ? { spell: rest.spellUuid } : {}),
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
