// Live verification for the new `cast` activity (manage-activity type:"cast") — the MCP fix that lets
// an item LINK a real compendium spell in one validated call instead of hand-written JSON.
//
// Drives a real headless Foundry session through the foundry.call seam (bypassing the MCP process, so
// it exercises the freshly-built dist/page.bundle.js WITHOUT a Claude Code restart). Against the live
// `sandbox` world it asserts that adding a cast activity:
//   * deep-merges (a weapon's pre-existing base Attack activity is preserved alongside the cast),
//   * RESOLVES the linked spell from its uuid — auto-filling the cast level (when omitted) + the
//     spell's V/S/M components + a "Cast <name>" default name,
//   * builds the right challenge: saveDC -> override:true/attack:null · attackBonus -> {attack:N,
//     override:true} · neither -> {attack:null, override:false} (defer to the caster),
//   * models an item correctly: spellSlot:false + an itemUses charge target (or empty targets at-will),
//     and a MINIMAL target.template with override:false so the SPELL owns the measured template,
//   * REFUSES a bad / non-spell / missing uuid (ask-don't-invent enforced at the seam).
// NOTE: the page sanitizer strips `save` tree-wide, so a fixed save DC is correct-but-invisible on
// read-back (proven instead by the offline buildActivity unit test). Everything created is cleaned up.
//
// Build first: npm run build. Run: node scripts/verify-cast-activity.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const TAG = 'ZZ-CAST-IT';
const PHB = 'Compendium.dnd-players-handbook.spells.Item';
const FIREBALL = `${PHB}.phbsplFireball00`; // save spell (DEX), V/S/M, base level 3
const WITCH_BOLT = `${PHB}.phbsplWitchBolt0`; // spell-attack, base level 1
const MAGIC_MISSILE = `${PHB}.phbsplMagicMissi`; // auto-hit (defer), V/S (no material), base level 1
const WAND_EQUIP = 'Compendium.dnd-dungeon-masters-guide.equipment.Item.dmgWandOfFirebal'; // an Item, NOT a spell

let passes = 0;
let fails = 0;
function assert(cond, msg) {
  if (cond) {
    passes++;
    console.log(`  PASS  ${msg}`);
  } else {
    fails++;
    console.log(`  FAIL  ${msg}`);
  }
}
async function expectThrow(label, fn, re) {
  try {
    await fn();
    fails++;
    console.log(`  FAIL  ${label} — expected a throw, none thrown`);
  } catch (e) {
    const m = e?.message || String(e);
    if (re.test(m)) {
      passes++;
      console.log(`  PASS  ${label} — threw ${JSON.stringify(m.slice(0, 90))}`);
    } else {
      fails++;
      console.log(`  FAIL  ${label} — threw but message didn't match ${re}: ${m.slice(0, 140)}`);
    }
  }
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let worldItemId; // created world item (cleaned up in finally)

try {
  console.log('[verify-cast] connecting to sandbox…');
  await f.connect();
  console.log('[verify-cast] connected — exercising manage-activity type:"cast"\n');

  // --- Base item: a real weapon (carries a base Attack activity) copied to the world ---
  const weapons = await f.call('searchCompendiumFaceted', { documentType: 'weapon', limit: 12 });
  const list = Array.isArray(weapons) ? weapons : [];
  const wHit = list.find(w => /quarterstaff|staff|mace|club/i.test(w.name)) || list[0];
  assert(Boolean(wHit?.pack && wHit?.id), `found a base weapon: ${wHit?.name} (${wHit?.pack})`);
  if (!wHit?.pack) throw new Error('could not resolve a base weapon hit');

  const imp = await f.call('importItemFromCompendium', {
    packId: wHit.pack,
    itemId: wHit.id,
    name: `${TAG} Caster Staff`,
  });
  worldItemId = imp?.item?.id;
  assert(Boolean(worldItemId), 'base weapon copied to the world');

  const before = await f.call('getWorldItem', { identifier: worldItemId });
  const baseActIds = Object.keys(before?.system?.activities ?? {});
  assert(
    baseActIds.length >= 1,
    `base weapon carries a pre-existing activity (${baseActIds.length})`
  );

  // --- 1. SAVE cast (Fireball, fixed DC 15, 1 charge, explicit level 3) ---
  console.log('\n# add cast: Fireball (save, charged)');
  const c1 = await f.call('manageActivity', {
    action: 'add',
    itemIdentifier: worldItemId,
    activity: { type: 'cast', spellUuid: FIREBALL, saveDC: 15, charges: 1, level: 3 },
  });
  assert(c1?.action === 'add' && c1?.type === 'cast', 'fireball cast added');
  assert(c1?.spell === FIREBALL, 'result reports the linked spell uuid');

  // --- 2. ATTACK cast (Witch Bolt, fixed +5, 1 charge, level OMITTED -> defaults from spell) ---
  console.log('\n# add cast: Witch Bolt (attack, level defaulted)');
  await f.call('manageActivity', {
    action: 'add',
    itemIdentifier: worldItemId,
    activity: { type: 'cast', spellUuid: WITCH_BOLT, attackBonus: 5, charges: 1 },
  });

  // --- 3. DEFER + AT-WILL (Magic Missile, no DC/bonus, no charges) ---
  console.log('\n# add cast: Magic Missile (defer to caster, at-will)');
  await f.call('manageActivity', {
    action: 'add',
    itemIdentifier: worldItemId,
    activity: { type: 'cast', spellUuid: MAGIC_MISSILE },
  });

  // --- Read back + assert the persisted shapes ---
  console.log('\n# read-back assertions');
  const after = await f.call('getWorldItem', { identifier: worldItemId });
  const acts = after?.system?.activities ?? {};
  for (const id of baseActIds)
    assert(Boolean(acts[id]), `base activity ${id} preserved (deep-merge)`);

  const casts = Object.values(acts).filter(a => a?.type === 'cast');
  assert(casts.length === 3, `3 cast activities present (${casts.length})`);
  const fb = casts.find(a => /Fireball/i.test(a?.spell?.uuid ?? ''));
  const wb = casts.find(a => /WitchBolt/i.test(a?.spell?.uuid ?? ''));
  const mm = casts.find(a => /MagicMissi/i.test(a?.spell?.uuid ?? ''));

  // Fireball (save spell)
  assert(fb?.spell?.level === 3, 'fireball cast level = 3');
  assert(
    Boolean(fb?.spell?.properties?.includes('material')),
    'fireball pulled V/S/M (has material)'
  );
  assert(
    fb?.spell?.challenge?.override === true && fb?.spell?.challenge?.attack === null,
    'fireball challenge override:true, attack:null (save spell; save DC is sanitized from read-back)'
  );
  assert(
    fb?.consumption?.spellSlot === false,
    'fireball spellSlot:false (item, not a caster slot)'
  );
  assert(
    fb?.consumption?.targets?.[0]?.type === 'itemUses' &&
      fb?.consumption?.targets?.[0]?.value === '1',
    'fireball consumes 1 itemUses charge'
  );
  assert(
    fb?.target?.override === false,
    'fireball target.override:false (spell owns the template)'
  );
  assert(
    fb?.target?.template?.size === undefined,
    'fireball target.template is MINIMAL (no size override)'
  );
  assert(fb?.name === 'Cast Fireball', 'fireball default name "Cast Fireball"');

  // Witch Bolt (spell-attack, level defaulted)
  assert(wb?.spell?.level === 1, 'witch bolt level defaulted to 1 from the spell');
  assert(
    wb?.spell?.challenge?.attack === 5 && wb?.spell?.challenge?.override === true,
    'witch bolt fixed spell-attack +5, override:true'
  );
  assert(wb?.name === 'Cast Witch Bolt', 'witch bolt default name "Cast Witch Bolt"');

  // Magic Missile (defer + at-will + V/S component resolution)
  assert(mm?.spell?.level === 1, 'magic missile level defaulted to 1');
  assert(
    mm?.spell?.challenge?.attack === null && mm?.spell?.challenge?.override === false,
    'magic missile defers DC/attack to the caster (override:false)'
  );
  assert(
    Array.isArray(mm?.consumption?.targets) && mm.consumption.targets.length === 0,
    'magic missile is at-will (empty consumption targets)'
  );
  assert(
    Boolean(mm?.spell?.properties?.includes('vocal')) &&
      !mm?.spell?.properties?.includes('material'),
    'magic missile components resolved to V/S (no material)'
  );

  // --- Guards: ask-don't-invent enforced at the seam ---
  console.log('\n# guards');
  await expectThrow(
    'cast(missing spellUuid)',
    () =>
      f.call('manageActivity', {
        action: 'add',
        itemIdentifier: worldItemId,
        activity: { type: 'cast' },
      }),
    /requires `spellUuid`/
  );
  await expectThrow(
    'cast(bad/off-book uuid -> STOP and ASK)',
    () =>
      f.call('manageActivity', {
        action: 'add',
        itemIdentifier: worldItemId,
        activity: { type: 'cast', spellUuid: `${PHB}.phbsplNoSuchSpell` },
      }),
    /not found|STOP and ASK/
  );
  await expectThrow(
    'cast(uuid resolves to a non-spell Item)',
    () =>
      f.call('manageActivity', {
        action: 'add',
        itemIdentifier: worldItemId,
        activity: { type: 'cast', spellUuid: WAND_EQUIP },
      }),
    /not a spell/
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-cast] FATAL: ${e?.message || String(e)}`);
} finally {
  if (worldItemId) {
    try {
      await f.call('deleteWorldItems', { identifiers: [worldItemId] });
      console.log('\n[verify-cast] cleaned up world item');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== cast-activity verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
