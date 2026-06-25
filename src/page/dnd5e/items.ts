// Page-side: dnd5e 5.3.3 physical-item (loot/gear) authoring. Runs INSIDE the headless Foundry page.
//
// Builds structured weapon / equipment (armor·shield·wondrous) / consumable / tool / loot / container
// Items — the inventory counterpart to attacks.ts (which authors combat-mechanics weapon/feat items).
// buildPhysicalItemData() is PURE (no Foundry globals) so it unit-tests offline in items.test.ts; the
// addItem() handler resolves the target (an actor's embedded inventory OR the world Items sidebar),
// resolves an optional container, optionally attaches a weapon attack activity through the SAME shared
// buildActivity, and creates the document. dnd5e's DataModel fills every field we don't set on create,
// so the constructed `system` objects are LEAN — only the loot fields a GM authors are set explicitly.
//
// Schema ground truth (dnd5e 5.3.3, live-verified): attunement is a STRING (''/required/optional) with
// a separate `attuned` boolean; a magic item needs BOTH the 'mgc' property AND a numeric magicalBonus
// (a deterministic FormulaField stored as a STRING); weapon base damage lives in system.damage.base;
// container membership is stored on the CHILD (child.system.container = container _id).

import { resolveActorFuzzy, importFromCompendium } from '../_shared.js';
import { buildActivity } from './activities.js';
import { createWorldItems } from '../items.js';

// itemType (tool-facing) -> Foundry Item document type.
const DOC_TYPE: Record<string, string> = {
  weapon: 'weapon',
  armor: 'equipment',
  shield: 'equipment',
  wondrous: 'equipment',
  consumable: 'consumable',
  tool: 'tool',
  loot: 'loot',
  container: 'container',
};

// Document types that carry the dnd5e EquippableItemTemplate (equipped / attunement / attuned).
const EQUIPPABLE_DOC = new Set(['weapon', 'equipment', 'consumable', 'tool']);

export interface PhysicalItemOpts {
  itemType: string;
  name: string;
  img?: string;
  description?: string;
  // PhysicalItemTemplate (cross-cutting)
  quantity?: number;
  price?: { value?: number; denomination?: string };
  weight?: { value?: number; units?: string };
  rarity?: string;
  identified?: boolean;
  containerId?: string | null;
  // Equippable + magical
  equipped?: boolean;
  attunement?: string;
  attuned?: boolean;
  magical?: boolean;
  magicalBonus?: number | null;
  properties?: string[];
  // weapon
  weaponClass?: string;
  baseItem?: string;
  damage?: { number: number; denomination: number; types: string[] };
  versatile?: { number: number; denomination: number; types: string[] };
  rangeObj?:
    | { value: number | null; long: number | null; reach?: number | null; units: string }
    | undefined;
  proficient?: number;
  activities?: Record<string, any> | undefined;
  // equipment (armor / shield / wondrous)
  armorType?: string;
  armorValue?: number;
  dex?: number | null;
  strength?: number;
  equipmentType?: string;
  // consumable
  consumableType?: string;
  subtype?: string;
  uses?: { spent?: number; max?: number | string; recovery?: any[]; autoDestroy?: boolean };
  ammoReplace?: boolean;
  // tool
  toolType?: string;
  ability?: string;
  toolBonus?: string;
  // loot
  lootType?: string;
  // container
  capacity?: {
    count?: number | null;
    weight?: { value: number | null; units: string };
    volume?: { value: number | null; units: string };
  };
  currency?: Record<string, number>;
}

/** Build the dnd5e weapon/ammo base-damage object from a simple {number,denomination,types}. */
function damageBase(d: { number: number; denomination: number; types: string[] }) {
  return {
    number: d.number,
    denomination: d.denomination,
    types: d.types,
    bonus: '',
    scaling: { mode: '', number: 1 },
    custom: { enabled: false },
  };
}

/**
 * Build a dnd5e physical-item document `{ name, type, img?, system }` from normalized options.
 * PURE — no Foundry globals — so it unit-tests offline. Only the loot-relevant fields are set; the
 * DataModel fills activation/target/duration/uses-defaults/etc. on create.
 */
export function buildPhysicalItemData(opts: PhysicalItemOpts): {
  name: string;
  type: string;
  img?: string;
  system: Record<string, any>;
} {
  const docType = DOC_TYPE[opts.itemType];
  if (!docType) {
    throw new Error(
      `Unknown itemType "${opts.itemType}". Use weapon, armor, shield, wondrous, consumable, tool, loot, or container.`
    );
  }

  // Magic flag: a non-zero numeric bonus OR an explicit magical:true forces the 'mgc' property.
  // A +0 is treated as no bonus (not magical); a negative (cursed) bonus stays magical.
  const hasBonus = opts.magicalBonus != null && opts.magicalBonus !== 0;
  const magicalBonusStr = hasBonus ? String(opts.magicalBonus) : null;
  const isMagic = opts.magical === true || hasBonus;
  const properties = [...(opts.properties ?? [])];
  if (isMagic && !properties.includes('mgc')) properties.push('mgc');

  const system: Record<string, any> = {
    description: { value: opts.description ?? '' },
  };

  // PhysicalItemTemplate — present on every type here.
  system.quantity = opts.itemType === 'container' ? 1 : (opts.quantity ?? 1);
  system.price = {
    value: opts.price?.value ?? 0,
    denomination: opts.price?.denomination ?? 'gp',
  };
  system.weight = { value: opts.weight?.value ?? 0, units: opts.weight?.units ?? 'lb' };
  system.rarity = opts.rarity ?? '';
  system.identified = opts.identified ?? true;
  if (opts.containerId) system.container = opts.containerId;

  // EquippableItemTemplate. Default to equipped for NPC gear, but NOT for something stowed in a
  // container (an item inside a bag/chest shouldn't read as worn/wielded).
  if (EQUIPPABLE_DOC.has(docType)) {
    system.equipped = opts.equipped ?? !opts.containerId;
    system.attunement = opts.attunement ?? '';
    system.attuned = opts.attuned ?? false;
  }

  // The 'mgc'/properties Set exists on every physical type except container.
  if (opts.itemType !== 'container') system.properties = properties;

  switch (opts.itemType) {
    case 'weapon': {
      system.type = { value: opts.weaponClass ?? 'natural', baseItem: opts.baseItem ?? '' };
      if (opts.damage) {
        system.damage = { base: damageBase(opts.damage) };
        if (opts.versatile) system.damage.versatile = damageBase(opts.versatile);
      }
      system.magicalBonus = magicalBonusStr;
      if (opts.proficient != null) system.proficient = opts.proficient;
      if (opts.rangeObj) system.range = opts.rangeObj;
      if (opts.activities) system.activities = opts.activities;
      break;
    }
    case 'armor':
    case 'shield': {
      const isShield = opts.itemType === 'shield';
      // Default base AC by armor weight class (light 11 / medium 14 / heavy 16) so the value matches
      // the declared armorType when armorValue is omitted; a shield defaults to a +2 bonus.
      const armorTypeDefault =
        { light: 11, medium: 14, heavy: 16 }[opts.armorType ?? 'medium'] ?? 14;
      system.type = {
        value: isShield ? 'shield' : (opts.armorType ?? 'medium'),
        baseItem: opts.baseItem ?? '',
      };
      system.armor = {
        value: opts.armorValue ?? (isShield ? 2 : armorTypeDefault),
        dex: isShield ? null : (opts.dex ?? null),
        magicalBonus: magicalBonusStr,
      };
      if (opts.strength != null) system.strength = opts.strength;
      if (opts.proficient != null) system.proficient = opts.proficient;
      break;
    }
    case 'wondrous': {
      // Wondrous items (rings/cloaks/etc.) are equipment with no armor block; magic is the 'mgc' flag.
      system.type = { value: opts.equipmentType ?? 'trinket', baseItem: opts.baseItem ?? '' };
      break;
    }
    case 'consumable': {
      system.type = { value: opts.consumableType ?? 'potion', subtype: opts.subtype ?? '' };
      if (opts.uses) {
        system.uses = {
          spent: opts.uses.spent ?? 0,
          max: opts.uses.max != null ? String(opts.uses.max) : '',
          recovery: opts.uses.recovery ?? [],
          autoDestroy: opts.uses.autoDestroy ?? false,
        };
      }
      if (opts.consumableType === 'ammo' && opts.damage) {
        system.damage = { base: damageBase(opts.damage), replace: opts.ammoReplace ?? false };
        system.magicalBonus = magicalBonusStr;
      }
      break;
    }
    case 'tool': {
      system.type = { value: opts.toolType ?? '', baseItem: opts.baseItem ?? '' };
      if (opts.ability) system.ability = opts.ability;
      if (opts.proficient != null) system.proficient = opts.proficient;
      if (opts.toolBonus) system.bonus = opts.toolBonus;
      break;
    }
    case 'loot': {
      system.type = { value: opts.lootType ?? 'gear', subtype: opts.subtype ?? '' };
      break;
    }
    case 'container': {
      if (opts.capacity) system.capacity = opts.capacity;
      if (opts.currency) system.currency = opts.currency;
      break;
    }
  }

  const doc: { name: string; type: string; img?: string; system: Record<string, any> } = {
    name: opts.name,
    type: docType,
    system,
  };
  if (opts.img) doc.img = opts.img;
  return doc;
}

/** Resolve a container item (by id or case-insensitive name) within a collection of items. Throws on
 * an ambiguous name (multiple containers share it) so the caller disambiguates by id. */
function findContainer(items: any, identifier: string): any {
  if (!items) return undefined;
  const byId = items.get?.(identifier) ?? items.find?.((i: any) => i.id === identifier);
  if (byId && byId.type === 'container') return byId;
  const lower = identifier.toLowerCase();
  const matches =
    items.filter?.((i: any) => i.type === 'container' && i.name?.toLowerCase() === lower) ?? [];
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous container name "${identifier}" (${matches.length} matches). Pass the id instead: ${matches
        .map((c: any) => `${c.name} (${c.id})`)
        .join(', ')}.`
    );
  }
  return matches[0];
}

/**
 * Create a structured physical item on an actor (embedded inventory) or in the world Items sidebar.
 * data is the normalized object the add-item tool sends. Returns { success, target, item }.
 */
export async function addItem(data: any): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error('addItem requires the dnd5e game system');
  }

  // Optional weapon attack activity — built through the shared buildActivity (no drift with
  // add-feature / manage-activity). Base damage stays in system.damage.base (includeBase:true), so
  // the activity carries no extra parts for a plain weapon.
  let activities: Record<string, any> | undefined;
  if (data.itemType === 'weapon' && data.withAttack && data.damage) {
    const id = foundry.utils.randomID(16);
    const sourceRules: string = data.sourceRules ?? '2024';
    activities = {
      [id]: buildActivity('attack', {
        id,
        activationType: 'action',
        attackType: data.attackType ?? 'melee',
        attackBonus: data.attackBonus,
        classification: sourceRules === '2014' ? 'weapon' : '',
        ...(sourceRules === '2024' && data.abilityModifier
          ? { ability: data.abilityModifier }
          : {}),
        includeBase: true,
        damageParts: [],
      }),
    };
  }

  // System-level range/reach for a weapon (melee → reach, ranged → value/long).
  let rangeObj: PhysicalItemOpts['rangeObj'];
  if (data.itemType === 'weapon' && (data.attackType || data.reachFt || data.rangeFt)) {
    rangeObj =
      (data.attackType ?? 'melee') === 'melee'
        ? { value: data.reachFt ?? 5, long: null, units: 'ft' }
        : { value: data.rangeFt ?? null, long: data.longRangeFt ?? null, units: 'ft' };
  }

  const baseOpts: PhysicalItemOpts = {
    itemType: data.itemType,
    name: data.name,
    img: data.img,
    description: data.description,
    quantity: data.quantity,
    price: data.price,
    weight: data.weight,
    rarity: data.rarity,
    identified: data.identified,
    equipped: data.equipped,
    attunement: data.attunement,
    attuned: data.attuned,
    magical: data.magical,
    magicalBonus: data.magicalBonus,
    properties: data.properties,
    weaponClass: data.weaponClass,
    baseItem: data.baseItem,
    damage: data.damage,
    versatile: data.versatile,
    rangeObj,
    proficient: data.proficient,
    activities,
    armorType: data.armorType,
    armorValue: data.armorValue,
    dex: data.dex,
    strength: data.strength,
    equipmentType: data.equipmentType,
    consumableType: data.consumableType,
    subtype: data.subtype,
    uses: data.uses,
    ammoReplace: data.ammoReplace,
    toolType: data.toolType,
    ability: data.ability,
    toolBonus: data.toolBonus,
    lootType: data.lootType,
    capacity: data.capacity,
    currency: data.currency,
  };

  // --- Target: actor (embedded) vs world (sidebar) ---
  if (data.actorIdentifier) {
    const actor = resolveActorFuzzy(data.actorIdentifier);
    if (!actor) throw new Error(`Actor not found: "${data.actorIdentifier}"`);

    let containerId: string | null = null;
    if (data.container) {
      const c = findContainer(actor.items, String(data.container));
      if (!c) {
        throw new Error(
          `Container not found on "${actor.name}": "${data.container}". Add the container item first.`
        );
      }
      containerId = c.id;
    }

    const doc = buildPhysicalItemData({ ...baseOpts, containerId });
    const created = (await actor.createEmbeddedDocuments('Item', [doc]))[0];
    if (!created) {
      throw new Error(`Failed to create item "${data.name}" on actor "${actor.name}"`);
    }

    // Optional armor→AC wiring: switch the actor to the default (armor-derived) AC calc so worn
    // BODY armor actually changes AC. Opt-in (GM's call — an NPC may use natural-armor AC). A shield
    // is excluded: its +2 already applies under any calc, so switching calc would only clobber an
    // authored natural/flat AC.
    if (data.wireAc && data.itemType === 'armor' && doc.system.equipped !== false) {
      await actor.update({ 'system.attributes.ac.calc': 'default' });
    }

    return {
      success: true,
      target: { type: 'actor', id: actor.id, name: actor.name },
      item: { id: created.id, name: created.name, type: created.type },
    };
  }

  // World Items sidebar.
  let containerId: string | null = null;
  if (data.container) {
    const c = findContainer(game.items, String(data.container));
    if (!c) {
      throw new Error(
        `Container world-item not found: "${data.container}". Create the container first.`
      );
    }
    containerId = c.id;
  }

  const doc = buildPhysicalItemData({ ...baseOpts, containerId });
  const res: any = await createWorldItems({ items: [doc], folder: data.folder });
  const created = res?.created?.[0];
  if (!created) throw new Error(`Failed to create world item "${data.name}"`);

  return {
    success: true,
    target: { type: 'world', folderId: res.folderId, folderName: res.folderName },
    item: created,
  };
}

/**
 * Copy an item from a compendium pack onto an actor's inventory (or into the world Items sidebar),
 * preserving its art, system data, and activities. This is the COMPENDIUM-FIRST counterpart to addItem:
 * the policy is to grab the real PHB/DMG entry (correct stats + graphic) and then tweak it with
 * update-actor-item / manage-activity / manage-effect, rather than author gear from scratch. A handful
 * of immediate overrides (rename, quantity, equipped, identified, container) are applied on the copy so
 * the common "drop in a copy, ready to use" case is one call. Returns { success, target, item }.
 */
export async function importItemFromCompendium(data: any): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error(`importItemFromCompendium requires D&D 5e (current: "${game.system.id}").`);
  }

  // Fetch + copy-prep through the shared whole-document copy primitive (validates
  // inputs, enforces an Item pack, fetches the document, strips the source _id).
  const { data: doc } = await importFromCompendium(data.packId, data.itemId, {
    requirePackType: 'Item',
  });
  const sourceName = doc.name;
  doc.system = doc.system ?? {};
  if (data.name) doc.name = data.name; // rename (the base for a custom variant)
  if (typeof data.quantity === 'number') doc.system.quantity = data.quantity;
  if (typeof data.identified === 'boolean') doc.system.identified = data.identified;
  if (typeof data.equipped === 'boolean' && EQUIPPABLE_DOC.has(doc.type)) {
    doc.system.equipped = data.equipped;
  }

  // --- Target: actor (embedded) vs world (sidebar) ---
  if (data.actorIdentifier) {
    const actor = resolveActorFuzzy(data.actorIdentifier);
    if (!actor) throw new Error(`Actor not found: "${data.actorIdentifier}"`);

    if (data.container) {
      const c = findContainer(actor.items, String(data.container));
      if (!c) {
        throw new Error(
          `Container not found on "${actor.name}": "${data.container}". Add the container item first.`
        );
      }
      doc.system.container = c.id;
    }

    const created = (await actor.createEmbeddedDocuments('Item', [doc]))[0];
    if (!created) {
      throw new Error(`Failed to copy item "${doc.name}" onto actor "${actor.name}"`);
    }
    return {
      success: true,
      source: { packId: data.packId, itemId: data.itemId, name: sourceName },
      target: { type: 'actor', id: actor.id, name: actor.name },
      item: { id: created.id, name: created.name, type: created.type },
    };
  }

  if (data.container) {
    const c = findContainer(game.items, String(data.container));
    if (!c) {
      throw new Error(
        `Container world-item not found: "${data.container}". Create the container first.`
      );
    }
    doc.system.container = c.id;
  }

  const res: any = await createWorldItems({ items: [doc], folder: data.folder });
  const created = res?.created?.[0];
  if (!created) throw new Error(`Failed to copy world item "${doc.name}"`);

  return {
    success: true,
    source: { packId: data.packId, itemId: data.itemId, name: sourceName },
    target: { type: 'world', folderId: res.folderId, folderName: res.folderName },
    item: created,
  };
}
