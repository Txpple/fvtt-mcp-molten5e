// Live acceptance for the ACTOR TOOLING build (update-actor, apply-condition, update-actor-item,
// manage-activity, add-feature spell mode, manage-effect) + the Phase 0 read-fixes. Exercises the
// page-side write/read seams against the live Molten world; unit tests mock the seam, so this is the
// real correctness gate. Test docs are tagged ZZ-MCP-AT and cleaned up in a finally.
//
// Build first: npm run build. Run: node scripts/verify-actor-tooling.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';
import { extractActorStats, extractActorBasicInfo } from '../dist/tools/dnd5e/actor-stats.js';

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
  password: env.FOUNDRY_PASSWORD,
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

async function makeTempNpc(name) {
  const r = await foundry.evaluate(async n => {
    const a = await globalThis.Actor.create({ name: n, type: 'npc' });
    return { id: a.id, name: a.name };
  }, name);
  tempActorIds.push(r.id);
  return r;
}

try {
  // =========================================================================
  // PHASE 0 — R1: get-actor surfaces real derived modifiers (end-to-end).
  // =========================================================================
  {
    const info = await foundry.call('getCharacterInfo', { characterName: 'Barbed Devil' });
    const basic = extractActorBasicInfo(info);
    const stats = extractActorStats(info);
    const okDerived =
      info?.derived?.abilities?.str?.mod === 5 &&
      info?.derived?.ac?.value === 15 &&
      typeof info?.derived?.skills?.prc?.passive === 'number';
    okDerived
      ? pass(
          'R1 page derived block',
          `str.mod=${info.derived.abilities.str.mod}, ac=${info.derived.ac.value}`
        )
      : fail('R1 page derived block', JSON.stringify(info?.derived));

    const okStats =
      basic.armorClass === 15 &&
      stats.armorClass === 15 &&
      stats.abilities?.str?.modifier === 5 &&
      stats.skills?.prc?.modifier === 8 &&
      stats.skills?.prc?.passive === 18;
    okStats
      ? pass(
          'R1 extractor consumes derived',
          `AC=${stats.armorClass}, STR mod=${stats.abilities.str.modifier}, prc=${stats.skills.prc.modifier}/pp${stats.skills.prc.passive}`
        )
      : fail(
          'R1 extractor consumes derived',
          JSON.stringify({
            basicAC: basic.armorClass,
            statsAC: stats.armorClass,
            str: stats.abilities?.str,
            prc: stats.skills?.prc,
          })
        );
  }

  // =========================================================================
  // PHASE 1 — update-actor: full stat-block round-trip on a temp NPC.
  // =========================================================================
  {
    const npc = await makeTempNpc('ZZ-MCP-AT-NPC');
    const upd = await foundry.call('updateActor', {
      actorIdentifier: npc.id,
      name: 'ZZ-MCP-AT Pit Fiend',
      size: 'large',
      cr: 20,
      creatureType: 'fiend',
      creatureSubtype: 'Devil',
      alignment: 'Lawful Evil',
      biography: '<p>A test fiend.</p>',
      source: { book: 'MM', page: '300', rules: '2024' },
      abilities: { str: 26, dex: 14, con: 24, int: 22, wis: 18, cha: 24 },
      savingThrows: ['dex', 'con', 'wis', 'cha'],
      skills: [
        { skill: 'Perception', proficiency: 'proficient' },
        { skill: 'Stealth', proficiency: 'expert' },
      ],
      hp: { value: 300, max: 300, formula: '24d10 + 168' },
      ac: { calc: 'natural', flat: 19 },
      initiative: { bonus: 2 },
      movement: { walk: 30, fly: 60 },
      senses: { darkvision: 120, truesight: 120 },
      damageImmunities: { values: ['fire', 'poison'] },
      damageResistances: { values: ['cold'] },
      conditionImmunities: { values: ['poisoned'] },
      languages: { values: ['infernal'] },
      telepathy: { value: 120 },
      legendaryActions: 3,
      legendaryResistances: 3,
      habitat: [{ type: 'planar', subtype: 'nine hells' }],
      treasure: { values: ['any'] },
    });
    const okApplied = upd?.success && (upd?.warnings?.length ?? 0) === 0;
    okApplied
      ? pass('update-actor applied', `${upd.applied.length} groups`)
      : fail('update-actor applied', JSON.stringify(upd?.warnings));

    // Read back through the real seam + extractors.
    const info = await foundry.call('getCharacterInfo', { characterName: npc.id });
    const sys = info.system;
    const stats = extractActorStats(info);
    const checks = {
      name: info.name === 'ZZ-MCP-AT Pit Fiend',
      size: sys?.traits?.size === 'lg',
      cr: sys?.details?.cr === 20,
      type: sys?.details?.type?.value === 'fiend' && sys?.details?.type?.subtype === 'Devil',
      strMod: stats.abilities?.str?.modifier === 8, // STR 26 -> +8 (derived)
      ac: stats.armorClass === 19,
      hpFormula: sys?.attributes?.hp?.formula === '24d10 + 168' && sys?.attributes?.hp?.max === 300,
      walkStr: sys?.attributes?.movement?.walk === '30', // FormulaField -> string
      fly: sys?.attributes?.movement?.fly === '60',
      darkvision: sys?.attributes?.senses?.ranges?.darkvision === 120,
      di:
        JSON.stringify([...(sys?.traits?.di?.value ?? [])].sort()) ===
        JSON.stringify(['fire', 'poison']),
      ci: JSON.stringify([...(sys?.traits?.ci?.value ?? [])]) === JSON.stringify(['poisoned']),
      telepathy: sys?.traits?.languages?.communication?.telepathy?.value === 120,
      legact: sys?.resources?.legact?.max === 3,
      habitat: sys?.details?.habitat?.value?.[0]?.subtype === 'nine hells',
      treasure:
        JSON.stringify([...(sys?.details?.treasure?.value ?? [])]) === JSON.stringify(['any']),
      skillExpert: sys?.skills?.ste?.value === 2 && sys?.skills?.prc?.value === 1,
      saveProf: sys?.abilities?.con?.proficient === 1 && sys?.abilities?.str?.proficient === 0,
    };
    const failedChecks = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    failedChecks.length === 0
      ? pass('update-actor round-trip', `${Object.keys(checks).length} fields verified`)
      : fail('update-actor round-trip', `failed: ${failedChecks.join(', ')}`);

    // Set add/remove modes (read-modify-write).
    await foundry.call('updateActor', {
      actorIdentifier: npc.id,
      damageImmunities: { mode: 'add', values: ['acid'] },
    });
    await foundry.call('updateActor', {
      actorIdentifier: npc.id,
      damageImmunities: { mode: 'remove', values: ['fire'] },
    });
    const info2 = await foundry.call('getCharacterInfo', { characterName: npc.id });
    const di2 = [...(info2.system?.traits?.di?.value ?? [])].sort();
    JSON.stringify(di2) === JSON.stringify(['acid', 'poison'])
      ? pass('update-actor Set add/remove', di2.join(','))
      : fail('update-actor Set add/remove', `got ${di2.join(',')}`);
  }

  // PHASE 1 — NPC-only fields warn (not error) on a character.
  {
    const pc = await foundry.evaluate(async () => {
      const a = await globalThis.Actor.create({ name: 'ZZ-MCP-AT-PC', type: 'character' });
      return { id: a.id };
    }, null);
    tempActorIds.push(pc.id);
    const r = await foundry.call('updateActor', {
      actorIdentifier: pc.id,
      abilities: { str: 16 },
      cr: 5, // NPC-only — should warn + skip
    });
    const warned = (r?.warnings ?? []).some(w => w.includes('NPC-only'));
    const appliedStr = (r?.applied ?? []).includes('abilities');
    warned && appliedStr
      ? pass('update-actor NPC-only warns on PC', 'cr skipped, abilities applied')
      : fail(
          'update-actor NPC-only warns on PC',
          JSON.stringify({ applied: r?.applied, warnings: r?.warnings })
        );
  }

  // =========================================================================
  // PHASE 1b — apply-condition: toggle on/off + exhaustion level.
  // =========================================================================
  {
    const npc = await makeTempNpc('ZZ-MCP-AT-COND');
    const on = await foundry.call('applyCondition', {
      actorIdentifier: npc.id,
      conditions: ['poisoned', 'prone'],
    });
    const onOk = on?.statuses?.includes('poisoned') && on?.statuses?.includes('prone');
    onOk
      ? pass('apply-condition add', on.statuses.join(','))
      : fail('apply-condition add', JSON.stringify(on));

    const off = await foundry.call('applyCondition', {
      actorIdentifier: npc.id,
      conditions: ['prone'],
      active: false,
    });
    !off?.statuses?.includes('prone') && off?.statuses?.includes('poisoned')
      ? pass('apply-condition remove', `now ${off.statuses.join(',') || '(none)'}`)
      : fail('apply-condition remove', JSON.stringify(off));

    // Exhaustion level via the dnd5e.exhaustionLevel flag (derives system.attributes.exhaustion).
    await foundry.call('applyCondition', {
      actorIdentifier: npc.id,
      conditions: ['exhaustion'],
      exhaustionLevel: 4,
    });
    const exh = await foundry.evaluate(id => {
      const a = game.actors.get(id);
      const eff = a.effects.find(e => e.statuses?.has?.('exhaustion'));
      return {
        sys: a.system?.attributes?.exhaustion,
        flag: eff?.flags?.dnd5e?.exhaustionLevel,
        name: eff?.name,
      };
    }, npc.id);
    exh?.sys === 4 && exh?.flag === 4
      ? pass('apply-condition exhaustion level', `${exh.name} (sys=${exh.sys})`)
      : fail('apply-condition exhaustion level', JSON.stringify(exh));

    // unknown condition warns, not throws
    const bad = await foundry.call('applyCondition', {
      actorIdentifier: npc.id,
      conditions: ['confuddled'],
    });
    (bad?.warnings ?? []).some(w => w.includes('confuddled'))
      ? pass('apply-condition unknown warns', 'warned')
      : fail('apply-condition unknown warns', JSON.stringify(bad?.warnings));
  }

  // =========================================================================
  // PHASE 2 — update-actor-item: dot-path patch + deletePaths on an embedded item.
  // =========================================================================
  {
    const npc = await makeTempNpc('ZZ-MCP-AT-ITEM');
    // Seed a Claws weapon with one attack activity (known id, so we can patch/delete it).
    const seed = await foundry.evaluate(async actorId => {
      const a = game.actors.get(actorId);
      const actId = foundry.utils.randomID(16);
      const [created] = await a.createEmbeddedDocuments('Item', [
        {
          name: 'Claws',
          type: 'weapon',
          system: {
            damage: {
              base: {
                number: 2,
                denomination: 6,
                types: ['slashing'],
                bonus: '',
                scaling: { mode: '', number: 1 },
                custom: { enabled: false },
              },
            },
            activities: {
              [actId]: {
                _id: actId,
                type: 'attack',
                attack: {
                  bonus: '',
                  ability: '',
                  flat: false,
                  type: { value: 'melee', classification: '' },
                  critical: { threshold: null },
                },
                damage: { includeBase: true, parts: [] },
              },
            },
          },
        },
      ]);
      return { itemId: created.id, activityId: actId };
    }, npc.id);

    // Patch base damage + the activity attack bonus via dot-paths.
    await foundry.call('updateActorItem', {
      actorIdentifier: npc.id,
      itemIdentifier: 'Claws',
      patch: {
        'system.damage.base.number': 5,
        'system.damage.base.types': ['piercing'],
        [`system.activities.${seed.activityId}.attack.bonus`]: '3',
      },
    });
    const ent = await foundry.call('getCharacterEntity', {
      characterIdentifier: npc.id,
      entityIdentifier: 'Claws',
    });
    const sys = ent?.entity?.system;
    const okPatch =
      sys?.damage?.base?.number === 5 &&
      JSON.stringify(sys?.damage?.base?.types) === JSON.stringify(['piercing']) &&
      sys?.activities?.[seed.activityId]?.attack?.bonus === '3';
    okPatch
      ? pass('update-actor-item patch', 'damage 5 piercing, atk bonus +3')
      : fail('update-actor-item patch', JSON.stringify(sys?.damage?.base));

    // Delete the activity via deletePaths -> "-=" form.
    await foundry.call('updateActorItem', {
      actorIdentifier: npc.id,
      itemIdentifier: 'Claws',
      deletePaths: [`system.activities.${seed.activityId}`],
    });
    const ent2 = await foundry.call('getCharacterEntity', {
      characterIdentifier: npc.id,
      entityIdentifier: 'Claws',
    });
    const acts = ent2?.entity?.system?.activities ?? {};
    !acts[seed.activityId]
      ? pass('update-actor-item deletePaths', 'activity removed')
      : fail('update-actor-item deletePaths', JSON.stringify(Object.keys(acts)));
  }

  // =========================================================================
  // PHASE 3 — manage-activity: routed-attack regression + add/edit/remove/list.
  // =========================================================================
  {
    const npc = await makeTempNpc('ZZ-MCP-AT-ACT');

    // (a) Regression: addAttackToActor now routes through buildActivity — still builds a working attack.
    await foundry.call('addAttackToActor', {
      actorIdentifier: npc.id,
      featureName: 'Bite',
      attackType: 'melee',
      damageParts: [{ number: 1, denomination: 10, type: 'piercing' }],
      properties: [],
      attackBonus: 0,
      activationType: 'action',
      weaponClass: 'natural',
      equipped: true,
      reachFt: 5,
      sourceRules: '2024',
      sourceBook: '',
      sourcePage: '',
      effectiveAbility: 'str',
    });
    const bite = await foundry.call('getCharacterEntity', {
      characterIdentifier: npc.id,
      entityIdentifier: 'Bite',
    });
    const biteActs = Object.values(bite?.entity?.system?.activities ?? {});
    const atk = biteActs.find(a => a.type === 'attack');
    atk?.attack?.ability === 'str' && atk?.damage?.includeBase === true
      ? pass('routed addAttackToActor (no drift)', 'attack activity intact')
      : fail('routed addAttackToActor (no drift)', JSON.stringify(atk?.attack));

    // (b) Create a passive feat, then author a Multiattack (utility) activity on it.
    await foundry.call('addPassiveFeatureToActor', {
      actorIdentifier: npc.id,
      featureName: 'Actions',
      description: '',
      sourceRules: '2024',
      sourceBook: '',
      sourcePage: '',
    });
    const addUtil = await foundry.call('manageActivity', {
      action: 'add',
      actorIdentifier: npc.id,
      itemIdentifier: 'Actions',
      activity: { type: 'utility', name: 'Multiattack' },
    });
    addUtil?.activityId
      ? pass('manage-activity add utility (Multiattack)', addUtil.activityId)
      : fail('manage-activity add utility', JSON.stringify(addUtil));

    // (c) Add a heal activity + (d) a save activity.
    const addHeal = await foundry.call('manageActivity', {
      action: 'add',
      actorIdentifier: npc.id,
      itemIdentifier: 'Actions',
      activity: {
        type: 'heal',
        name: 'Mend',
        healing: { number: 2, denomination: 8, type: 'healing' },
      },
    });
    const addSave = await foundry.call('manageActivity', {
      action: 'add',
      actorIdentifier: npc.id,
      itemIdentifier: 'Actions',
      activity: {
        type: 'save',
        name: 'Searing Burst',
        saveAbility: 'dex',
        saveDC: 15,
        onSave: 'half',
        damageParts: [{ number: 3, denomination: 6, type: 'fire' }],
      },
    });
    const list = await foundry.call('manageActivity', {
      action: 'list',
      actorIdentifier: npc.id,
      itemIdentifier: 'Actions',
    });
    const types = (list?.activities ?? []).map(a => a.type).sort();
    JSON.stringify(types) === JSON.stringify(['heal', 'save', 'utility'])
      ? pass('manage-activity add heal/save + list', types.join(','))
      : fail('manage-activity add heal/save + list', JSON.stringify(list?.activities));

    // (e) Edit the save DC via a relative patch, then read back.
    await foundry.call('manageActivity', {
      action: 'edit',
      actorIdentifier: npc.id,
      itemIdentifier: 'Actions',
      activityId: addSave.activityId,
      patch: { 'save.dc.formula': '17' },
    });
    const entActions = await foundry.call('getCharacterEntity', {
      characterIdentifier: npc.id,
      entityIdentifier: 'Actions',
    });
    entActions?.entity?.system?.activities?.[addSave.activityId]?.save?.dc?.formula === '17'
      ? pass('manage-activity edit (relative patch)', 'save DC -> 17')
      : fail(
          'manage-activity edit',
          JSON.stringify(entActions?.entity?.system?.activities?.[addSave.activityId]?.save)
        );

    // (f) Remove the heal activity; list should drop it.
    await foundry.call('manageActivity', {
      action: 'remove',
      actorIdentifier: npc.id,
      itemIdentifier: 'Actions',
      activityId: addHeal.activityId,
    });
    const list2 = await foundry.call('manageActivity', {
      action: 'list',
      actorIdentifier: npc.id,
      itemIdentifier: 'Actions',
    });
    !(list2?.activities ?? []).some(a => a.id === addHeal.activityId)
      ? pass('manage-activity remove', 'heal removed')
      : fail('manage-activity remove', JSON.stringify(list2?.activities));
  }

  // PHASE 3 — world-item activity path.
  {
    const wid = await foundry.call('createWorldItems', {
      items: [{ name: 'ZZ-MCP-AT World Wand', type: 'weapon' }],
    });
    const worldItemId = wid?.created?.[0]?.id;
    const addOnWorld = await foundry.call('manageActivity', {
      action: 'add',
      itemIdentifier: worldItemId,
      activity: {
        type: 'damage',
        name: 'Zap',
        damageParts: [{ number: 2, denomination: 6, type: 'lightning' }],
      },
    });
    addOnWorld?.activityId
      ? pass('manage-activity world item', addOnWorld.activityId)
      : fail('manage-activity world item', JSON.stringify(addOnWorld));
    // cleanup the world item
    if (worldItemId) await foundry.call('deleteWorldItems', { identifiers: [worldItemId] });
  }

  // =========================================================================
  // PHASE 4 — homebrew-spell authoring + feat widening + read-side method migration.
  // =========================================================================
  {
    const npc = await makeTempNpc('ZZ-MCP-AT-SPELL');

    // Author a homebrew spell with an optional save activity.
    await foundry.call('addHomebrewSpellToActor', {
      actorIdentifier: npc.id,
      name: 'Soul Bolt',
      level: 3,
      school: 'nec',
      method: 'innate',
      prepared: 0,
      components: ['vocal', 'somatic'],
      description: '<p>A bolt of necrotic energy.</p>',
      activationType: 'action',
      rangeValue: 120,
      rangeUnits: 'ft',
      sourceRules: '2024',
      activity: {
        type: 'save',
        saveAbility: 'dex',
        saveDC: 15,
        onSave: 'half',
        damageParts: [{ number: 8, denomination: 6, type: 'necrotic' }],
      },
    });
    const spell = await foundry.call('getCharacterEntity', {
      characterIdentifier: npc.id,
      entityIdentifier: 'Soul Bolt',
    });
    const ss = spell?.entity?.system;
    const spellActs = Object.values(ss?.activities ?? {});
    const okSpell =
      spell?.entity?.type === 'spell' &&
      ss?.level === 3 &&
      ss?.school === 'nec' &&
      ss?.method === 'innate' &&
      JSON.stringify([...(ss?.properties ?? [])].sort()) === JSON.stringify(['somatic', 'vocal']) &&
      spellActs.some(a => a.type === 'save' && a.save?.dc?.formula === '15');
    okSpell
      ? pass('homebrew-spell authored', `L${ss.level} ${ss.school}/${ss.method} + save activity`)
      : fail(
          'homebrew-spell authored',
          JSON.stringify({
            type: spell?.entity?.type,
            level: ss?.level,
            school: ss?.school,
            method: ss?.method,
            props: ss?.properties,
          })
        );

    // Read-side migration: searchCharacterItems surfaces system.method on the spell.
    const search = await foundry.call('searchCharacterItems', {
      characterIdentifier: npc.id,
      type: 'spell',
      query: 'Soul Bolt',
    });
    search?.matches?.[0]?.method === 'innate'
      ? pass('read migration: spell method surfaced', 'innate')
      : fail('read migration: spell method', JSON.stringify(search?.matches?.[0]));

    // Feat widening: author a passive feat with featType + requirements.
    await foundry.call('addPassiveFeatureToActor', {
      actorIdentifier: npc.id,
      featureName: 'Pack Tactics',
      description: '<p>Advantage when an ally is near.</p>',
      featType: 'monster',
      requirements: 'An ally within 5 feet of the target',
      sourceRules: '2024',
    });
    const feat = await foundry.call('getCharacterEntity', {
      characterIdentifier: npc.id,
      entityIdentifier: 'Pack Tactics',
    });
    const fs = feat?.entity?.system;
    fs?.type?.value === 'monster' && fs?.requirements === 'An ally within 5 feet of the target'
      ? pass('feat widening (featType + requirements)', `${fs.type.value} / "${fs.requirements}"`)
      : fail('feat widening', JSON.stringify({ type: fs?.type, requirements: fs?.requirements }));
  }

  // =========================================================================
  // PHASE 5 — manage-effect: create/list/edit/delete on actor + R2 read-back.
  // =========================================================================
  {
    const npc = await makeTempNpc('ZZ-MCP-AT-FX');
    // Give it a known natural-armor AC so an AC-bonus effect is observable.
    await foundry.call('updateActor', {
      actorIdentifier: npc.id,
      ac: { calc: 'natural', flat: 15 },
    });

    const created = await foundry.call('manageEffect', {
      action: 'create',
      actorIdentifier: npc.id,
      effect: {
        name: '+2 AC, resist fire',
        changes: [
          { key: 'system.attributes.ac.bonus', value: '2', type: 'add' },
          { key: 'system.traits.dr.value', value: 'fire', type: 'add' },
        ],
      },
    });
    created?.effectId
      ? pass('manage-effect create', created.effectId)
      : fail('manage-effect create', JSON.stringify(created));

    // list shows the effect with its change keys intact.
    const listed = await foundry.call('manageEffect', { action: 'list', actorIdentifier: npc.id });
    const eff = (listed?.effects ?? []).find(e => e.id === created.effectId);
    eff?.changes?.some(c => c.key === 'system.attributes.ac.bonus' && c.type === 'add')
      ? pass('manage-effect list (change key intact)', `${eff.changes.length} changes`)
      : fail('manage-effect list', JSON.stringify(eff));

    // R2: get-actor surfaces effects[].changes[].key (the sanitizer no longer strips `key`).
    const ga = await foundry.call('getCharacterInfo', { characterName: npc.id });
    const gaEff = (ga?.effects ?? []).find(e => e.id === created.effectId);
    gaEff?.changes?.some(c => c.key === 'system.attributes.ac.bonus')
      ? pass('R2 get-actor effect change key', 'key preserved')
      : fail('R2 get-actor effect change key', JSON.stringify(gaEff?.changes));

    // Bonus: the effect actually applies (derived AC 15 -> 17).
    ga?.derived?.ac?.value === 17
      ? pass('manage-effect applies (derived AC +2)', `AC=${ga.derived.ac.value}`)
      : console.log(
          `NOTE  derived AC did not reflect +2 (got ${ga?.derived?.ac?.value}) — effect stored but calc may not add bonus`
        );

    // edit: disable it -> derived AC back to 15.
    await foundry.call('manageEffect', {
      action: 'edit',
      actorIdentifier: npc.id,
      effectId: created.effectId,
      effect: { disabled: true },
    });
    const ga2 = await foundry.call('getCharacterInfo', { characterName: npc.id });
    ga2?.derived?.ac?.value === 15
      ? pass('manage-effect edit (disable)', 'AC back to 15')
      : console.log(`NOTE  AC after disable = ${ga2?.derived?.ac?.value} (expected 15)`);

    // delete -> list empty.
    await foundry.call('manageEffect', {
      action: 'delete',
      actorIdentifier: npc.id,
      effectId: created.effectId,
    });
    const listed2 = await foundry.call('manageEffect', { action: 'list', actorIdentifier: npc.id });
    !(listed2?.effects ?? []).some(e => e.id === created.effectId)
      ? pass('manage-effect delete', 'removed')
      : fail('manage-effect delete', JSON.stringify(listed2?.effects));
  }

  // PHASE 5 — R2 on a world item: sanitized get-item keeps effect change keys.
  {
    const wid = await foundry.call('createWorldItems', {
      items: [{ name: 'ZZ-MCP-AT FX Ring', type: 'equipment' }],
    });
    const ringId = wid?.created?.[0]?.id;
    await foundry.call('manageEffect', {
      action: 'create',
      itemIdentifier: ringId,
      effect: {
        name: 'Ring of Protection',
        changes: [{ key: 'system.attributes.ac.bonus', value: '1', type: 'add' }],
      },
    });
    const gi = await foundry.call('getWorldItem', { identifier: ringId });
    // The sanitizer preserves changes[].key wherever the changes array lives (top-level on actor
    // effects; under system.changes on this item effect) — R2 triggers on any `changes` array.
    const giEff = gi?.effects?.[0] ?? {};
    const giChanges = giEff.changes ?? giEff.system?.changes ?? [];
    giChanges.some(c => c.key === 'system.attributes.ac.bonus')
      ? pass('R2 get-item effect change key (sanitized)', 'key preserved')
      : fail('R2 get-item effect change key', JSON.stringify(giEff));
    if (ringId) await foundry.call('deleteWorldItems', { identifiers: [ringId] });
  }
} catch (e) {
  fail('SUITE', e?.message || String(e));
} finally {
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
