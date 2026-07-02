// Phase-2 WRITE acceptance (Wave 2, dnd5e): drive the dnd5e actor-authoring tools
// end-to-end against the live Molten world, then INSPECT the constructed dnd5e
// system data models (activities, damage, save DCs, spell slots, embedded items)
// via the page-eval escape hatch. This is the data-model correctness gate that the
// seam-mocking unit tests cannot provide. Also verifies setActorOwnership (deferred
// from wave 1). Everything is on one disposable NPC, deleted at the end.
//
// Build first: `npm run build`. Run: node scripts/verify-dnd5e-writes.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';
import { DnD5eNpcTools } from '../dist/tools/dnd5e/npc.js';
import { DnD5eAddFeatureTool } from '../dist/tools/dnd5e/add-feature.js';
import { DnD5eFeaturesFromCompendiumTools } from '../dist/tools/dnd5e/features.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAME = 'ZZ-MCP-WT Dragon';

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
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};
const env = loadEnv();
const foundry = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  password: env.FOUNDRY_PASSWORD,
});

const npc = new DnD5eNpcTools({ foundry, logger });
const feat = new DnD5eAddFeatureTool({ foundry, logger });
const comp = new DnD5eFeaturesFromCompendiumTools({ foundry, logger });

const results = [];
const ok = n => {
  results.push({ n, ok: true });
  console.log(`PASS  ${n}`);
};
const bad = (n, e) => {
  results.push({ n, ok: false });
  console.log(`FAIL  ${n} -> ${e}`);
};
async function check(n, fn, pred = () => true) {
  try {
    const out = await fn();
    if (!pred(out)) {
      bad(n, `unexpected: ${JSON.stringify(out).slice(0, 220)}`);
      return out;
    }
    ok(n);
    return out;
  } catch (e) {
    bad(n, e?.message || String(e));
    return undefined;
  }
}

let actorId;
try {
  console.log('[dnd5e-acceptance] connecting…');
  await foundry.connect();
  console.log('[dnd5e-acceptance] connected\n');

  await check(
    'createNpcActor',
    () =>
      npc.handleCreateNpc({
        name: NAME,
        creatureType: 'dragon',
        size: 'large',
        cr: '5',
        hpAverage: 76,
        hpFormula: '9d10+27',
        acMode: 'flat',
        acValue: 18,
        abilities: { str: 19, dex: 10, con: 17, int: 14, wis: 13, cha: 15 },
        savingThrows: ['dex', 'con'],
      }),
    o => o?.success
  );

  const found = await check(
    'findActor (resolve id)',
    () => foundry.call('findActor', { identifier: NAME }),
    o => o?.id
  );
  actorId = found?.id;

  await check(
    'addPassiveFeatureToActor',
    () =>
      feat.handleAddFeature({
        featureType: 'passive',
        actorIdentifier: NAME,
        featureName: 'Legendary Resistance',
        sourceBook: 'MM',
      }),
    o => o?.success
  );
  await check(
    'addSaveFeatureToActor',
    () =>
      feat.handleAddFeature({
        featureType: 'save',
        actorIdentifier: NAME,
        featureName: 'Fire Breath',
        saveAbility: 'dex',
        saveDC: 15,
        damageParts: [{ number: 6, denomination: 6, type: 'fire' }],
        areaType: 'cone',
        areaSize: 30,
      }),
    o => o?.success
  );
  await check(
    'addAttackToActor',
    () =>
      feat.handleAddFeature({
        featureType: 'attack',
        actorIdentifier: NAME,
        featureName: 'Bite',
        attackType: 'melee',
        damageParts: [{ number: 2, denomination: 10, type: 'piercing' }],
        reachFt: 10,
      }),
    o => o?.success
  );
  await check(
    'addAttackWithSaveToActor',
    () =>
      feat.handleAddFeature({
        featureType: 'attack-with-save',
        actorIdentifier: NAME,
        featureName: 'Stinger',
        attackType: 'melee',
        damageParts: [{ number: 1, denomination: 6, type: 'piercing' }],
        saveAbility: 'con',
        saveDC: 13,
        saveDamageParts: [{ number: 4, denomination: 6, type: 'poison' }],
        saveOnSave: 'half',
      }),
    o => o?.success
  );
  await check(
    'addAuraToActor',
    () =>
      feat.handleAddFeature({
        featureType: 'aura',
        actorIdentifier: NAME,
        featureName: 'Fire Aura',
        damageParts: [{ number: 1, denomination: 10, type: 'fire' }],
        areaType: 'emanation',
        areaSize: 10,
      }),
    o => o?.success
  );
  await check(
    'setActorSpellcasting',
    () =>
      feat.handleAddFeature({
        featureType: 'spellcasting',
        actorIdentifier: NAME,
        spellcastingClass: 'wizard',
        spellcastingLevel: 5,
      }),
    o => o?.success
  );
  await check(
    'addSpellsToActor',
    () =>
      feat.handleAddFeature({
        featureType: 'spells',
        actorIdentifier: NAME,
        spellNames: ['Fireball'],
      }),
    o => o?.success
  );
  await check(
    'addFeaturesFromCompendium',
    () =>
      comp.handleAddFeaturesFromCompendium({
        actorIdentifier: NAME,
        featureNames: ['Pack Tactics'],
      }),
    o => o != null
  );

  // --- INSPECT the constructed data model directly in the page ---
  if (actorId) {
    const inspect = await foundry.evaluate(id => {
      const live = game.actors.get(id);
      if (!live) return null;
      // Read the RAW source (toObject): in dnd5e 5.x system.activities is an
      // ActivityCollection (Map-like) on the live doc, so Object.values() on the
      // live doc returns []. The source object is plain and keyed by activity id.
      const a = live.toObject();
      const items = (a.items ?? []).map(i => {
        const acts = Object.values(i.system?.activities ?? {});
        return {
          name: i.name,
          type: i.type,
          activityTypes: acts.map(act => act.type),
          hasDamage: acts.some(act => (act.damage?.parts ?? []).length > 0),
          saveDc: acts.find(act => act.type === 'save')?.save?.dc?.formula,
        };
      });
      // Spell slots: .max is DERIVED in dnd5e 5.x (computed in prepareData), so read
      // the LIVE doc for max and the SOURCE for value/override to see what was written.
      const sp = k => ({
        liveMax: live.system?.spells?.[k]?.max,
        srcValue: a.system?.spells?.[k]?.value,
        srcOverride: a.system?.spells?.[k]?.override,
      });
      return {
        cr: a.system?.details?.cr,
        hpMax: a.system?.attributes?.hp?.max,
        acFlat: a.system?.attributes?.ac?.flat,
        spellAbility: live.system?.attributes?.spellcasting ?? a.system?.attributes?.spellcasting,
        spell1: sp('spell1'),
        spell3: sp('spell3'),
        itemCount: items.length,
        items,
      };
    }, actorId);
    console.log('\n[inspect] actor data model:', JSON.stringify(inspect, null, 2), '\n');

    await check(
      'NPC system data (cr=5, hp=76, ac flat=18)',
      async () => inspect,
      o => o?.cr === 5 && o.hpMax === 76 && o.acFlat === 18
    );
    await check(
      'attack item has an attack activity',
      async () => inspect,
      o => o.items.some(i => i.activityTypes.includes('attack') && i.hasDamage)
    );
    await check(
      'save feature has a save activity',
      async () => inspect,
      o => o.items.some(i => i.activityTypes.includes('save'))
    );
    await check(
      'aura/damage activity present',
      async () => inspect,
      o => o.items.some(i => i.activityTypes.includes('damage'))
    );
    await check(
      'spellcasting wrote L3 slots (wizard L5)',
      async () => inspect,
      o =>
        (o.spell3?.liveMax ?? 0) >= 2 ||
        (o.spell3?.srcValue ?? 0) >= 2 ||
        (o.spell3?.srcOverride ?? 0) >= 2
    );

    // --- ownership (wave-1 deferred): set for the bridge's own user ---
    const userId = await foundry.evaluate(() => game.userId, null);
    await check(
      'setActorOwnership',
      () => foundry.call('setActorOwnership', { actorId, userId, permission: 3 }),
      o => o?.success
    );
  } else {
    bad('inspect/ownership', 'actorId unresolved');
  }
} catch (e) {
  console.error('[dnd5e-acceptance] FATAL:', e?.message || e);
} finally {
  console.log('\n[dnd5e-acceptance] cleanup…');
  try {
    await foundry.call('deleteActor', {
      identifiers: actorId ? [actorId] : [NAME],
      removeEmptyFolder: true,
    });
  } catch (e) {
    console.log(`  cleanup note: ${e?.message || e}`);
  }
  await foundry.dispose();
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => r.ok === false).length;
  console.log(`\n[dnd5e-acceptance] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
