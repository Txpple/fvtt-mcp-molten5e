// Live acceptance for the COMPLETE-NPC inventory build: add-item (structured physical-item builder)
// across every itemType + the update-actor currency group. Exercises the page-side write/read seams
// against the live Molten world; unit tests mock the seam, so this is the real correctness gate. Test
// docs are tagged ZZ-MCP-ITEM and cleaned up in a finally.
//
// Build first: npm run build. Run: node scripts/verify-item-tooling.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const txt = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const foundry = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const results = [];
const pass = (n, s) => {
  results.push({ n, ok: true });
  console.log(`PASS  ${n}${s ? ` -> ${s}` : ''}`);
};
const fail = (n, e) => {
  results.push({ n, ok: false });
  console.log(`FAIL  ${n} -> ${e}`);
};
const tempActorIds = [];
const tempWorldItemIds = [];

async function makeTempNpc(name) {
  const r = await foundry.evaluate(async n => {
    const a = await globalThis.Actor.create({ name: n, type: 'npc' });
    return { id: a.id, name: a.name };
  }, name);
  tempActorIds.push(r.id);
  return r;
}
const ent = (actorId, name) =>
  foundry.call('getCharacterEntity', { characterIdentifier: actorId, entityIdentifier: name });

try {
  const npc = await makeTempNpc('ZZ-MCP-ITEM NPC');

  // ── 1. Magic weapon the creature fights with (mgc + magicalBonus + attunement + attack) ──
  {
    const r = await foundry.call('addItem', {
      itemType: 'weapon',
      actorIdentifier: npc.id,
      name: '+1 Longsword',
      weaponClass: 'martialM',
      baseItem: 'longsword',
      damage: { number: 1, denomination: 8, types: ['slashing'] },
      attackType: 'melee',
      magicalBonus: 1,
      rarity: 'rare',
      attunement: 'required',
      attuned: true,
      properties: ['ver'],
      price: { value: 5000, denomination: 'gp' },
      weight: { value: 3 },
      withAttack: true,
    });
    const e = (await ent(npc.id, '+1 Longsword'))?.entity;
    const s = e?.system;
    const acts = Object.values(s?.activities ?? {});
    const ok =
      e?.type === 'weapon' &&
      s?.magicalBonus === '1' &&
      [...(s?.properties ?? [])].includes('mgc') &&
      [...(s?.properties ?? [])].includes('ver') &&
      s?.attunement === 'required' &&
      s?.equipped === true &&
      s?.rarity === 'rare' &&
      s?.damage?.base?.denomination === 8 &&
      acts.some(a => a.type === 'attack');
    ok
      ? pass('weapon: +1 magic longsword + attack', `mgc/+1/${s.attunement}/act=${acts.length}`)
      : fail(
          'weapon: +1 magic longsword',
          JSON.stringify({
            id: r?.item?.id,
            mb: s?.magicalBonus,
            props: s?.properties,
            att: s?.attunement,
            acts: acts.map(a => a.type),
          })
        );
  }

  // ── 2. Worn armor + wireAc (actor AC switches to default/armor-derived) ──
  {
    await foundry.call('addItem', {
      itemType: 'armor',
      actorIdentifier: npc.id,
      name: 'Chain Mail',
      armorType: 'heavy',
      armorValue: 16,
      dex: 0,
      strength: 13,
      proficient: 1,
      wireAc: true,
    });
    const e = (await ent(npc.id, 'Chain Mail'))?.entity;
    const info = await foundry.call('getCharacterInfo', { characterName: npc.id });
    const ok =
      e?.system?.armor?.value === 16 &&
      e?.system?.type?.value === 'heavy' &&
      info?.system?.attributes?.ac?.calc === 'default';
    ok
      ? pass(
          'armor: chain mail + wireAc',
          `armor=16, ac.calc=${info?.system?.attributes?.ac?.calc}`
        )
      : fail(
          'armor: chain mail + wireAc',
          JSON.stringify({ armor: e?.system?.armor, calc: info?.system?.attributes?.ac?.calc })
        );
  }

  // ── 3. Shield (defaults to +2, type.value shield) ──
  {
    await foundry.call('addItem', { itemType: 'shield', actorIdentifier: npc.id, name: 'Shield' });
    const e = (await ent(npc.id, 'Shield'))?.entity;
    e?.system?.type?.value === 'shield' && e?.system?.armor?.value === 2
      ? pass('shield: +2 AC', `value=${e.system.armor.value}`)
      : fail('shield', JSON.stringify(e?.system?.armor));
  }

  // ── 3b. wireAc on a SHIELD must NOT clobber an authored natural AC (the HIGH review fix) ──
  {
    const npc2 = await makeTempNpc('ZZ-MCP-ITEM ShieldGuard');
    await foundry.call('updateActor', {
      actorIdentifier: npc2.id,
      ac: { calc: 'natural', flat: 17 },
    });
    await foundry.call('addItem', {
      itemType: 'shield',
      actorIdentifier: npc2.id,
      name: 'Tower Shield',
      wireAc: true, // must be a no-op for a shield — calc stays 'natural'
    });
    const info = await foundry.call('getCharacterInfo', { characterName: npc2.id });
    info?.system?.attributes?.ac?.calc === 'natural'
      ? pass('shield + wireAc leaves natural AC intact', `calc=${info.system.attributes.ac.calc}`)
      : fail(
          'shield + wireAc clobbered AC',
          `calc=${info?.system?.attributes?.ac?.calc} (expected natural)`
        );
  }

  // ── 4. Consumable potion (uses + autoDestroy) ──
  {
    await foundry.call('addItem', {
      itemType: 'consumable',
      actorIdentifier: npc.id,
      name: 'Potion of Healing',
      consumableType: 'potion',
      rarity: 'common',
      uses: { max: 1, autoDestroy: true },
      price: { value: 50, denomination: 'gp' },
    });
    const e = (await ent(npc.id, 'Potion of Healing'))?.entity;
    const s = e?.system;
    e?.type === 'consumable' &&
    s?.type?.value === 'potion' &&
    String(s?.uses?.max) === '1' &&
    s?.uses?.autoDestroy === true
      ? pass(
          'consumable: potion of healing',
          `uses.max=${s.uses.max}, autoDestroy=${s.uses.autoDestroy}`
        )
      : fail('consumable: potion', JSON.stringify({ type: e?.type, t: s?.type, uses: s?.uses }));
  }

  // ── 5. Ammunition stack (quantity + base damage) ──
  {
    await foundry.call('addItem', {
      itemType: 'consumable',
      actorIdentifier: npc.id,
      name: 'Arrows',
      consumableType: 'ammo',
      subtype: 'arrow',
      quantity: 20,
      damage: { number: 1, denomination: 6, types: ['piercing'] },
    });
    const e = (await ent(npc.id, 'Arrows'))?.entity;
    const s = e?.system;
    s?.type?.value === 'ammo' && s?.quantity === 20 && s?.damage?.base?.denomination === 6
      ? pass('consumable: 20 arrows', `qty=${s.quantity}`)
      : fail(
          'consumable: arrows',
          JSON.stringify({ t: s?.type, qty: s?.quantity, dmg: s?.damage })
        );
  }

  // ── 6. Loot gem (priced, not equippable) ──
  {
    await foundry.call('addItem', {
      itemType: 'loot',
      actorIdentifier: npc.id,
      name: 'Ruby',
      lootType: 'gem',
      price: { value: 50, denomination: 'gp' },
    });
    const e = (await ent(npc.id, 'Ruby'))?.entity;
    const s = e?.system;
    e?.type === 'loot' &&
    s?.type?.value === 'gem' &&
    s?.price?.value === 50 &&
    s?.equipped === undefined
      ? pass('loot: ruby (50gp, not equippable)', `price=${s.price.value}`)
      : fail(
          'loot: ruby',
          JSON.stringify({ type: e?.type, t: s?.type, price: s?.price, equipped: s?.equipped })
        );
  }

  // ── 7. Container + nesting (child.system.container = container id) ──
  {
    const pouch = await foundry.call('addItem', {
      itemType: 'container',
      actorIdentifier: npc.id,
      name: 'Belt Pouch',
      capacity: { weight: { value: 6, units: 'lb' } },
    });
    const pouchId = pouch?.item?.id;
    await foundry.call('addItem', {
      itemType: 'loot',
      actorIdentifier: npc.id,
      name: 'Old Key',
      lootType: 'junk',
      container: 'Belt Pouch',
    });
    const key = (await ent(npc.id, 'Old Key'))?.entity;
    pouchId && key?.system?.container === pouchId
      ? pass('container: nest item via container name', `key.container=${key.system.container}`)
      : fail(
          'container: nesting',
          JSON.stringify({ pouchId, keyContainer: key?.system?.container })
        );
  }

  // ── 8. Actor currency (set then relative add) ──
  {
    const setR = await foundry.call('updateActor', {
      actorIdentifier: npc.id,
      currency: { gp: 30, sp: 5 },
    });
    const i1 = await foundry.call('getCharacterInfo', { characterName: npc.id });
    const okSet =
      (setR?.applied ?? []).includes('currency') &&
      i1?.system?.currency?.gp === 30 &&
      i1?.system?.currency?.sp === 5;
    okSet
      ? pass('currency: set 30gp/5sp', 'gp=30,sp=5')
      : fail('currency: set', JSON.stringify(i1?.system?.currency));

    await foundry.call('updateActor', {
      actorIdentifier: npc.id,
      currency: { mode: 'add', gp: -10 },
    });
    const i2 = await foundry.call('getCharacterInfo', { characterName: npc.id });
    i2?.system?.currency?.gp === 20
      ? pass('currency: add -10gp', `gp=${i2.system.currency.gp}`)
      : fail('currency: add', JSON.stringify(i2?.system?.currency));
  }

  // ── 9. World Items sidebar path (no actorIdentifier) ──
  {
    const r = await foundry.call('addItem', {
      itemType: 'wondrous',
      name: 'ZZ-MCP-ITEM Cloak of Protection',
      equipmentType: 'trinket',
      magical: true,
      rarity: 'uncommon',
      attunement: 'required',
      folder: 'ZZ-MCP-ITEM Loot',
    });
    const wid = r?.item?.id;
    if (wid) tempWorldItemIds.push(wid);
    const gi = await foundry.call('getWorldItem', { identifier: wid });
    gi?.type === 'equipment' &&
    [...(gi?.system?.properties ?? [])].includes('mgc') &&
    gi?.system?.attunement === 'required'
      ? pass('world item: wondrous (mgc + attunement)', `id=${wid}`)
      : fail(
          'world item: wondrous',
          JSON.stringify({
            type: gi?.type,
            props: gi?.system?.properties,
            att: gi?.system?.attunement,
          })
        );
  }
} catch (e) {
  fail('SUITE', e?.message || String(e));
} finally {
  if (tempWorldItemIds.length) {
    try {
      await foundry.call('deleteWorldItems', { identifiers: tempWorldItemIds });
    } catch (e) {
      console.log(`world-item cleanup FAILED: ${e?.message || e}`);
    }
  }
  if (tempActorIds.length) {
    try {
      const del = await foundry.call('deleteActor', { identifiers: tempActorIds });
      console.log(`cleanup -> deleted ${del?.deletedCount ?? 0} temp actor(s)`);
    } catch (e) {
      console.log(`cleanup FAILED: ${e?.message || e}`);
    }
  }
  await foundry.dispose?.();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}
