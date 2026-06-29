/**
 * Unit tests for buildPhysicalItemData — the PURE dnd5e physical-item builder (no Foundry globals).
 * The async addItem handler (target resolution + document creation) is covered by the live
 * acceptance script; these pin the constructed system-data shape per item type.
 */

import { describe, it, expect } from 'vitest';
import { buildPhysicalItemData } from './items.js';
import { isPlaceholderIcon, resolveAuthoredIcon } from './icons.js';

describe('buildPhysicalItemData — cross-cutting fields', () => {
  it('sets price/weight/quantity/rarity/identified defaults', () => {
    const doc = buildPhysicalItemData({ itemType: 'loot', name: 'Rock' });
    expect(doc.type).toBe('loot');
    expect(doc.system.quantity).toBe(1);
    expect(doc.system.price).toEqual({ value: 0, denomination: 'gp' });
    expect(doc.system.weight).toEqual({ value: 0, units: 'lb' });
    expect(doc.system.rarity).toBe('');
    expect(doc.system.identified).toBe(true);
  });

  it('carries price/weight/quantity/rarity through', () => {
    const doc = buildPhysicalItemData({
      itemType: 'loot',
      name: 'Ruby',
      lootType: 'gem',
      price: { value: 50, denomination: 'gp' },
      weight: { value: 0, units: 'lb' },
      quantity: 3,
      rarity: 'rare',
    });
    expect(doc.system.price).toEqual({ value: 50, denomination: 'gp' });
    expect(doc.system.quantity).toBe(3);
    expect(doc.system.rarity).toBe('rare');
    expect(doc.system.type).toEqual({ value: 'gem', subtype: '' });
  });

  it('a magic numeric bonus auto-adds the mgc property', () => {
    const doc = buildPhysicalItemData({
      itemType: 'weapon',
      name: '+1 Longsword',
      damage: { number: 1, denomination: 8, types: ['slashing'] },
      magicalBonus: 1,
      properties: ['fin'],
    });
    expect(doc.system.properties).toEqual(expect.arrayContaining(['fin', 'mgc']));
    expect(doc.system.magicalBonus).toBe('1');
  });

  it('magical:true adds mgc with no numeric bonus', () => {
    const doc = buildPhysicalItemData({
      itemType: 'wondrous',
      name: 'Cloak of Protection',
      magical: true,
    });
    expect(doc.system.properties).toContain('mgc');
  });

  it('places an item inside a container via containerId', () => {
    const doc = buildPhysicalItemData({
      itemType: 'loot',
      name: 'Coin',
      containerId: 'CONTAINER123',
    });
    expect(doc.system.container).toBe('CONTAINER123');
  });

  it('an equippable item stowed in a container defaults to NOT equipped', () => {
    const doc = buildPhysicalItemData({
      itemType: 'weapon',
      name: 'Spare Dagger',
      damage: { number: 1, denomination: 4, types: ['piercing'] },
      containerId: 'BAG1',
    });
    expect(doc.system.equipped).toBe(false);
  });

  it('magicalBonus 0 is treated as non-magical (no mgc, null bonus)', () => {
    const doc = buildPhysicalItemData({
      itemType: 'weapon',
      name: 'Plain Sword',
      damage: { number: 1, denomination: 8, types: ['slashing'] },
      magicalBonus: 0,
    });
    expect(doc.system.properties).not.toContain('mgc');
    expect(doc.system.magicalBonus).toBeNull();
  });

  it('a negative (cursed) magicalBonus stays magical', () => {
    const doc = buildPhysicalItemData({
      itemType: 'weapon',
      name: 'Cursed Blade',
      damage: { number: 1, denomination: 8, types: ['slashing'] },
      magicalBonus: -1,
    });
    expect(doc.system.properties).toContain('mgc');
    expect(doc.system.magicalBonus).toBe('-1');
  });

  // Rule 8 — an authored item must never ship a blank icon (the DataModel default placeholder).
  it('fills a real, non-placeholder icon when none is given', () => {
    for (const itemType of [
      'weapon',
      'armor',
      'shield',
      'consumable',
      'tool',
      'loot',
      'container',
    ]) {
      const doc = buildPhysicalItemData({ itemType, name: 'X' });
      expect(doc.img, `${itemType} should get a real icon`).toBeTruthy();
      expect(isPlaceholderIcon(doc.img)).toBe(false);
    }
  });

  it('picks a subtype-specific icon for a wondrous ring vs a bare wondrous item', () => {
    const ring = buildPhysicalItemData({
      itemType: 'wondrous',
      name: 'Ring',
      equipmentType: 'ring',
    });
    const trinket = buildPhysicalItemData({ itemType: 'wondrous', name: 'Bauble' });
    expect(ring.img).toBe(resolveAuthoredIcon('wondrous', { subtype: 'ring' }));
    expect(ring.img).not.toBe(trinket.img);
  });

  it('respects an explicit img over the auto-filled default', () => {
    const doc = buildPhysicalItemData({
      itemType: 'weapon',
      name: 'Custom',
      img: 'icons/weapons/swords/sword-runed.webp',
    });
    expect(doc.img).toBe('icons/weapons/swords/sword-runed.webp');
  });
});

describe('buildPhysicalItemData — weapon', () => {
  it('builds base damage and equippable defaults', () => {
    const doc = buildPhysicalItemData({
      itemType: 'weapon',
      name: 'Scimitar',
      weaponClass: 'martialM',
      damage: { number: 1, denomination: 6, types: ['slashing'] },
    });
    expect(doc.type).toBe('weapon');
    expect(doc.system.type).toEqual({ value: 'martialM', baseItem: '' });
    expect(doc.system.damage.base).toMatchObject({
      number: 1,
      denomination: 6,
      types: ['slashing'],
    });
    expect(doc.system.equipped).toBe(true);
    expect(doc.system.attunement).toBe('');
    expect(doc.system.attuned).toBe(false);
    expect(doc.system.magicalBonus).toBeNull();
  });

  it('attaches a prebuilt activities map', () => {
    const acts = { abc: { _id: 'abc', type: 'attack' } };
    const doc = buildPhysicalItemData({
      itemType: 'weapon',
      name: 'Bite',
      damage: { number: 1, denomination: 4, types: ['piercing'] },
      activities: acts,
    });
    expect(doc.system.activities).toBe(acts);
  });
});

describe('buildPhysicalItemData — armor / shield', () => {
  it('armor sets armor.value/dex/magicalBonus and type.value', () => {
    const doc = buildPhysicalItemData({
      itemType: 'armor',
      name: 'Half Plate +1',
      armorType: 'medium',
      armorValue: 15,
      dex: 2,
      strength: 0,
      magicalBonus: 1,
    });
    expect(doc.type).toBe('equipment');
    expect(doc.system.type).toEqual({ value: 'medium', baseItem: '' });
    expect(doc.system.armor).toEqual({ value: 15, dex: 2, magicalBonus: '1' });
  });

  it('shield defaults to +2 with null dex', () => {
    const doc = buildPhysicalItemData({ itemType: 'shield', name: 'Shield' });
    expect(doc.system.type.value).toBe('shield');
    expect(doc.system.armor).toEqual({ value: 2, dex: null, magicalBonus: null });
  });

  it('armor with no armorValue defaults AC by weight class (medium=14)', () => {
    const doc = buildPhysicalItemData({ itemType: 'armor', name: 'Some Medium Armor' });
    expect(doc.system.type.value).toBe('medium');
    expect(doc.system.armor.value).toBe(14);
  });

  it('heavy armor with no armorValue defaults to 16', () => {
    const doc = buildPhysicalItemData({
      itemType: 'armor',
      name: 'Some Heavy Armor',
      armorType: 'heavy',
    });
    expect(doc.system.armor.value).toBe(16);
  });
});

describe('buildPhysicalItemData — consumable', () => {
  it('potion sets uses with autoDestroy and stringified max', () => {
    const doc = buildPhysicalItemData({
      itemType: 'consumable',
      name: 'Potion of Healing',
      consumableType: 'potion',
      uses: { max: 1, autoDestroy: true },
    });
    expect(doc.type).toBe('consumable');
    expect(doc.system.type).toEqual({ value: 'potion', subtype: '' });
    expect(doc.system.uses).toEqual({ spent: 0, max: '1', recovery: [], autoDestroy: true });
  });

  it('ammo carries base damage + replace + magic bonus', () => {
    const doc = buildPhysicalItemData({
      itemType: 'consumable',
      name: '+1 Arrow',
      consumableType: 'ammo',
      subtype: 'arrow',
      damage: { number: 1, denomination: 6, types: ['piercing'] },
      magicalBonus: 1,
      quantity: 20,
    });
    expect(doc.system.damage.base).toMatchObject({ number: 1, denomination: 6 });
    expect(doc.system.damage.replace).toBe(false);
    expect(doc.system.magicalBonus).toBe('1');
    expect(doc.system.quantity).toBe(20);
  });
});

describe('buildPhysicalItemData — tool / loot / container', () => {
  it('tool sets ability/proficient/bonus', () => {
    const doc = buildPhysicalItemData({
      itemType: 'tool',
      name: "Smith's Tools",
      toolType: 'art',
      baseItem: 'smith',
      ability: 'str',
      proficient: 1,
      toolBonus: '@prof',
    });
    expect(doc.type).toBe('tool');
    expect(doc.system.type).toEqual({ value: 'art', baseItem: 'smith' });
    expect(doc.system.ability).toBe('str');
    expect(doc.system.proficient).toBe(1);
    expect(doc.system.bonus).toBe('@prof');
  });

  it('loot is not equippable (no equipped/attunement)', () => {
    const doc = buildPhysicalItemData({ itemType: 'loot', name: 'Gold Bar', lootType: 'treasure' });
    expect(doc.system.equipped).toBeUndefined();
    expect(doc.system.attunement).toBeUndefined();
  });

  it('container forces quantity 1 and carries capacity + currency, no properties', () => {
    const doc = buildPhysicalItemData({
      itemType: 'container',
      name: 'Belt Pouch',
      quantity: 5,
      capacity: { weight: { value: 6, units: 'lb' } },
      currency: { gp: 15 },
    });
    expect(doc.type).toBe('container');
    expect(doc.system.quantity).toBe(1);
    expect(doc.system.capacity).toEqual({ weight: { value: 6, units: 'lb' } });
    expect(doc.system.currency).toEqual({ gp: 15 });
    expect(doc.system.properties).toBeUndefined();
  });
});

describe('buildPhysicalItemData — errors', () => {
  it('throws on an unknown itemType', () => {
    expect(() => buildPhysicalItemData({ itemType: 'spaceship', name: 'X' })).toThrow(
      /Unknown itemType/
    );
  });
});
