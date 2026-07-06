// Live verification: add-free-cast — the native Cast-activity free-cast shape (owner-approved
// 2026-07-05, supersedes the forward-on-the-spell shape).
//
// Claims under test (page-side addFreeCast, src/page/dnd5e/free-cast.ts):
//   1. MIGRATION: a repertoire spell carrying the OLD shape (on-spell use pool + `forward`
//      activity) is stripped clean and raised to always-prepared (prepared: 2).
//   2. The granting FEATURE gains a `cast` activity: links the premium spell, pool ON the activity
//      (activityUses, default 1/lr), spellbook: true, activation inherited from the spell.
//   3. The "Additional Spells" cached copy settles to EXACTLY ONE item (the v14 multi-mint is
//      deduped), titled "<Spell> - <Feature>".
//   4. Idempotent re-run: same activity id, pool re-pointed, spent uses survive, still one copy.
//   5. Compendium-uuid path: the repertoire copy is IMPORTED (always prepared) when absent; a
//      bonus-action spell (Healing Word) yields a bonus-action cast activity.
//   6. Errors are clean: unknown granting feature (lists the actor's feats); unknown spell.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixture PC,
// cleaned in finally. Build first: npm run build. Run: node scripts/verify-free-cast.mjs
//
// With --jetten it ALSO performs the real conversion of Jetten Elisedil's two free casts
// (Healing Word ← Magic Initiate, Hunter's Mark ← Favored Enemy) — a live mutation, no cleanup.
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

const TAG = 'ZZ-FREECAST';
const RUN_JETTEN = process.argv.includes('--jetten');
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

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

// Raw source reads straight off the live docs — the ground truth the tool must match.
const SPELL_RAW = (actorId, spellName) =>
  f.evaluate(
    ({ id, name }) => {
      const item = game.actors.get(id)?.items.find(i => i.name === name && i.type === 'spell');
      if (!item) return null;
      const src = item.toObject();
      return {
        id: item.id,
        prepared: src.system.prepared,
        uses: src.system.uses,
        activities: src.system.activities,
        cachedFor: src.flags?.dnd5e?.cachedFor ?? null,
      };
    },
    { id: actorId, name: spellName }
  );

const FEATURE_ACTIVITY = (actorId, featureName, activityId) =>
  f.evaluate(
    ({ id, name, actId }) => {
      const item = game.actors.get(id)?.items.find(i => i.name === name && i.type !== 'spell');
      if (!item) return null;
      return { featureId: item.id, activity: item.toObject().system.activities?.[actId] ?? null };
    },
    { id: actorId, name: featureName, actId: activityId }
  );

// All cached "Additional Spells" copies for one activity (flag dnd5e.cachedFor === relativeUUID).
const CACHED_COPIES = (actorId, featureId, activityId) =>
  f.evaluate(
    ({ id, fid, aid }) => {
      const rel = `.Item.${fid}.Activity.${aid}`;
      return (
        game.actors
          .get(id)
          ?.items.filter(i => i.type === 'spell' && i.getFlag('dnd5e', 'cachedFor') === rel)
          .map(i => ({ id: i.id, name: i.name })) ?? []
      );
    },
    { id: actorId, fid: featureId, aid: activityId }
  );

let actorId;

try {
  console.log('[verify-freecast] connecting…');
  await f.connect();
  console.log('[verify-freecast] connected\n');

  console.log('# setup fixture — scratch PC + a premium Bless copy + a Magic Initiate feat');
  actorId = await f.evaluate(async tag => {
    const a = await Actor.create({ name: `${tag} Caster`, type: 'character' });
    await a.createEmbeddedDocuments('Item', [{ name: 'Magic Initiate', type: 'feat' }]);
    return a.id;
  }, TAG);
  await f.call('addSpellsToActor', { actorIdentifier: actorId, spellNames: ['Bless'] });
  let bless = await SPELL_RAW(actorId, 'Bless');
  assert(bless?.id, `fixture ${actorId} carries a Bless copy (${bless?.id})`);

  // Recreate the OLD shape by hand so migration has something to strip.
  await f.evaluate(
    ({ id, itemId }) =>
      game.actors
        .get(id)
        .items.get(itemId)
        .update({
          'system.uses': { max: '1', spent: 0, recovery: [{ period: 'lr', type: 'recoverAll' }] },
          'system.prepared': 1,
          'system.activities.oldForward000000': {
            _id: 'oldForward000000',
            type: 'forward',
            name: 'Bless - Magic Initiate',
            activity: { id: 'dnd5eactivity000' },
            consumption: {
              targets: [{ type: 'itemUses', target: '', value: '1', scaling: {} }],
              scaling: { allowed: false },
              spellSlot: true,
            },
          },
        }),
    { id: actorId, itemId: bless.id }
  );

  console.log('\n# 1) addFreeCast migrates the old shape + wires the feature cast activity');
  const r1 = await f.call('addFreeCast', {
    actorIdentifier: actorId,
    spellIdentifier: 'Bless',
    grantedBy: 'Magic Initiate',
  });
  assert(r1.success === true, 'call succeeds');
  assert(r1.activity?.name === 'Bless - Magic Initiate', `activity name "${r1.activity?.name}"`);
  assert(r1.repertoire?.migrated === true, 'repertoire reported migrated');
  bless = await SPELL_RAW(actorId, 'Bless');
  const forwards = Object.values(bless.activities ?? {}).filter(a => a?.type === 'forward');
  assert(forwards.length === 0, `old forward stripped (${forwards.length} left)`);
  assert(bless.uses?.max === '', `on-spell pool cleared (max="${bless.uses?.max}")`);
  assert(bless.prepared === 2, `repertoire spell always-prepared (prepared=${bless.prepared})`);

  const fa1 = await FEATURE_ACTIVITY(actorId, 'Magic Initiate', r1.activity?.id);
  assert(fa1?.activity?.type === 'cast', 'cast activity persisted on the feature');
  assert(fa1?.activity?.spell?.spellbook === true, 'spellbook: true (Additional Spells section)');
  assert(fa1?.activity?.uses?.max === '1', `activity pool max "${fa1?.activity?.uses?.max}"`);
  assert(
    fa1?.activity?.uses?.recovery?.[0]?.period === 'lr',
    'activity pool recovers on long rest'
  );
  assert(
    fa1?.activity?.consumption?.targets?.[0]?.type === 'activityUses',
    'consumes activityUses (not a slot, not item uses)'
  );
  assert(fa1?.activity?.consumption?.spellSlot === false, 'spellSlot consumption off');
  assert(fa1?.activity?.activation?.type === 'action', 'activation inherited (Bless = action)');

  let copies = await CACHED_COPIES(actorId, fa1.featureId, r1.activity.id);
  assert(copies.length === 1, `exactly ONE cached Additional-Spells copy (${copies.length})`);
  assert(copies[0]?.name === 'Bless - Magic Initiate', `cached copy titled "${copies[0]?.name}"`);

  console.log('\n# 2) idempotent re-run — same activity, pool re-pointed, spent survives');
  await f.evaluate(
    ({ id, fid, aid }) =>
      game.actors
        .get(id)
        .items.get(fid)
        .update({ [`system.activities.${aid}.uses.spent`]: 1 }),
    { id: actorId, fid: fa1.featureId, aid: r1.activity.id }
  );
  const r2 = await f.call('addFreeCast', {
    actorIdentifier: actorId,
    spellIdentifier: 'Bless',
    grantedBy: 'Magic Initiate',
    uses: 2,
  });
  assert(r2.activity?.reused === true, 're-run reuses the existing cast activity');
  assert(r2.activity?.id === r1.activity?.id, 'same activity id (no duplicate)');
  const fa2 = await FEATURE_ACTIVITY(actorId, 'Magic Initiate', r1.activity.id);
  assert(fa2?.activity?.uses?.max === '2', `pool re-pointed (max="${fa2?.activity?.uses?.max}")`);
  assert(fa2?.activity?.uses?.spent === 1, 'spent free cast survives the re-run');
  copies = await CACHED_COPIES(actorId, fa1.featureId, r1.activity.id);
  assert(copies.length === 1, `still exactly one cached copy (${copies.length})`);

  console.log('\n# 3) compendium-uuid path — repertoire imported, bonus action inherited');
  const hwUuid = await f.evaluate(async () => {
    const pack = game.packs.get('dnd-players-handbook.spells');
    if (!pack.indexed) await pack.getIndex({});
    const e = [...pack.index.values()].find(x => x.name === 'Healing Word');
    return e ? `Compendium.dnd-players-handbook.spells.Item.${e._id}` : null;
  });
  assert(hwUuid, `Healing Word uuid resolved (${hwUuid})`);
  const r3 = await f.call('addFreeCast', {
    actorIdentifier: actorId,
    spellIdentifier: hwUuid,
    grantedBy: 'Magic Initiate',
  });
  assert(r3.repertoire?.imported === true, 'repertoire copy imported');
  const hw = await SPELL_RAW(actorId, 'Healing Word');
  assert(hw?.prepared === 2, `imported repertoire copy always-prepared (prepared=${hw?.prepared})`);
  const fa3 = await FEATURE_ACTIVITY(actorId, 'Magic Initiate', r3.activity?.id);
  assert(
    fa3?.activity?.activation?.type === 'bonus',
    `activation inherited (Healing Word = "${fa3?.activity?.activation?.type}")`
  );
  copies = await CACHED_COPIES(actorId, fa3.featureId, r3.activity.id);
  assert(
    copies.length === 1 && copies[0]?.name === 'Healing Word - Magic Initiate',
    `one cached copy titled "${copies[0]?.name}"`
  );

  console.log('\n# 4) errors are clean');
  let threw = false;
  try {
    await f.call('addFreeCast', {
      actorIdentifier: actorId,
      spellIdentifier: 'Bless',
      grantedBy: 'No Such Feature',
    });
  } catch (e) {
    threw = /not found on/i.test(e?.message || '') && /Magic Initiate/.test(e?.message || '');
  }
  assert(threw, 'unknown granting feature rejected, listing the actor feats');
  threw = false;
  try {
    await f.call('addFreeCast', {
      actorIdentifier: actorId,
      spellIdentifier: 'Nonexistent Spell',
      grantedBy: 'Magic Initiate',
    });
  } catch (e) {
    threw = /not found/i.test(e?.message || '');
  }
  assert(threw, 'unknown spell rejected');
} finally {
  if (actorId) {
    await f.evaluate(async id => {
      await game.actors.get(id)?.delete();
    }, actorId);
    console.log('\n[verify-freecast] fixture cleaned');
  }
  if (!RUN_JETTEN) await f.dispose?.();
}

if (RUN_JETTEN) {
  console.log('\n# --jetten: REAL conversion of Jetten Elisedil (no cleanup — this is the task)');
  try {
    const rHW = await f.call('addFreeCast', {
      actorIdentifier: 'Jetten',
      spellIdentifier: 'Healing Word',
      grantedBy: 'Magic Initiate',
    });
    assert(rHW.success === true, 'Jetten Healing Word ← Magic Initiate succeeded');
    console.log(
      `    repertoire migrated=${rHW.repertoire?.migrated}; warnings: ${(rHW.warnings ?? []).join(' | ') || '(none)'}`
    );
    let jc = await CACHED_COPIES('ynipTDamO8lCYI80', rHW.feature.id, rHW.activity.id);
    assert(
      jc.length === 1 && jc[0]?.name === 'Healing Word - Magic Initiate',
      `Jetten Additional-Spells entry "${jc[0]?.name}" (${jc.length} copy)`
    );

    const hasFE = await f.evaluate(() =>
      Boolean(
        game.actors
          .getName('Jetten Elisedil')
          ?.items.find(i => i.name === 'Favored Enemy' && i.type !== 'spell')
      )
    );
    if (hasFE) {
      const rHM = await f.call('addFreeCast', {
        actorIdentifier: 'Jetten',
        spellIdentifier: "Hunter's Mark",
        grantedBy: 'Favored Enemy',
        uses: '@scale.ranger.favored-enemy',
      });
      assert(rHM.success === true, "Jetten Hunter's Mark ← Favored Enemy succeeded");
      console.log(
        `    repertoire migrated=${rHM.repertoire?.migrated}; warnings: ${(rHM.warnings ?? []).join(' | ') || '(none)'}`
      );
      jc = await CACHED_COPIES('ynipTDamO8lCYI80', rHM.feature.id, rHM.activity.id);
      assert(
        jc.length === 1 && jc[0]?.name === "Hunter's Mark - Favored Enemy",
        `Jetten Additional-Spells entry "${jc[0]?.name}" (${jc.length} copy)`
      );
      const hm = await SPELL_RAW('ynipTDamO8lCYI80', "Hunter's Mark");
      const hmForwards = Object.values(hm?.activities ?? {}).filter(a => a?.type === 'forward');
      assert(
        hmForwards.length === 0 && hm?.uses?.max === '',
        "Hunter's Mark repertoire copy clean (premium forward + pool stripped)"
      );
    } else {
      console.log('  SKIP  Jetten has no "Favored Enemy" feature item — Hunter\'s Mark untouched');
    }
  } finally {
    await f.dispose?.();
  }
}

console.log(`\n[verify-freecast] ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
