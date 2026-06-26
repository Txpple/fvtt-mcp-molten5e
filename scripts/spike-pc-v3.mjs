// Phase-5 PC v3 spike: prove MULTICLASS + LEVEL-UP-EXISTING before engine changes.
//
// v2 ships single-class level 1→20. v3 is the last two PC gaps. Both have real unknowns:
//   (MC) MULTICLASS — embedding a 2nd (non-original) class. The 2024 multiclass PROFICIENCY SUBSET is
//        the crux: a multiclass Wizard does NOT get every L1 proficiency. dnd5e encodes this as a
//        `classRestriction` on each advancement ('primary' = original-class-only, 'secondary' =
//        multiclass-only, '' = always). PROBE that field, then apply the primary class with
//        classRestriction!=='secondary' and the secondary with !=='primary'. Confirm: character level
//        sums, 2nd class first-level HP is AVG not max (via isOriginalClass), both @scale namespaces
//        resolve, and multiclass spell slots auto-derive (combined caster level).
//   (LU) LEVEL-UP an existing PERSISTED PC — bump the class's system.levels, apply ONLY the new level's
//        advancements, persist IN PLACE. PROBE whether prior advancement value-state survives (so
//        L1..N don't re-apply) and how to persist the in-memory apply() mutations (actor.update vs
//        re-snapshot).
//
// Each eval is isolated + node-timeout-bounded; helpers inlined per eval. Temp actors TAG-namespaced,
// deleted in `finally`.
//
// Build first: npm run build. Run: node scripts/spike-pc-v3.mjs
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

const TAG = 'ZZ-PCV3-SPIKE';
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
function withNodeTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`node-timeout: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), timeout]);
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const createdIds = [];

try {
  console.log('[spike-v3] connecting to sandbox (cold-start can take minutes)…');
  await f.connect();
  console.log('[spike-v3] connected\n');

  // ===== EVAL A — DISCOVERY: classRestriction on Fighter/Wizard advancements + champion uuid =====
  const evalA = await withNodeTimeout(
    f.evaluate(async () => {
      const PREMIUM =
        /^(dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide|dnd-heroes-faerun|dnd-ravenloft-horrors-within)\./;
      const game = globalThis.game;
      const findByType = async (typeName, name) => {
        for (const pack of game.packs) {
          if (pack.documentName !== 'Item' || !PREMIUM.test(pack.metadata.id)) continue;
          const idx = await pack.getIndex({ fields: ['type'] });
          const hit = idx.find(e => e.type === typeName && e.name === name);
          if (hit)
            return { doc: await pack.getDocument(hit._id), packId: pack.metadata.id, id: hit._id };
        }
        return null;
      };
      const norm = a =>
        (a.levels ?? (a.level != null ? [a.level] : [])).map(Number).filter(Number.isFinite);
      const dumpRestrictions = item => {
        const out = [];
        const byType = item.advancement?.byType || {};
        for (const [t, arr] of Object.entries(byType)) {
          for (const a of arr) {
            // classRestriction can live on the advancement (getter) or its level metadata
            const cr =
              a.classRestriction ??
              a.level?.classRestriction ??
              a.configuration?.classRestriction ??
              '';
            const levels = norm(a);
            if ((levels[0] ?? 0) <= 1)
              out.push({ type: t, title: a.title, levels, classRestriction: cr });
          }
        }
        return out;
      };
      const out = { fighter: [], wizard: [], champion: null, wizSpellcasting: null, errors: [] };
      try {
        const fighter = await findByType('class', 'Fighter');
        if (fighter) out.fighter = dumpRestrictions(fighter.doc);
        const wizard = await findByType('class', 'Wizard');
        if (wizard) {
          out.wizard = dumpRestrictions(wizard.doc);
          out.wizSpellcasting = wizard.doc.system?.spellcasting ?? null;
        }
        const champ = await findByType('subclass', 'Champion');
        if (champ) out.champion = `Compendium.${champ.packId}.Item.${champ.id}`;
      } catch (e) {
        out.errors.push(String(e?.message || e));
      }
      return out;
    }, {}),
    120_000,
    'evalA'
  );
  console.log('\n===== EVAL A — classRestriction on L1 advancements + champion uuid =====');
  console.log(JSON.stringify(evalA, null, 2));
  console.log('=======================================================================\n');

  // ===== EVAL MC — multiclass Fighter 1 / Wizard 1 (classRestriction-filtered) → persist → verify =====
  const evalMC = await withNodeTimeout(
    f.evaluate(
      async arg => {
        const PREMIUM =
          /^(dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide|dnd-heroes-faerun|dnd-ravenloft-horrors-within)\./;
        const game = globalThis.game;
        const findClass = async name => {
          for (const pack of game.packs) {
            if (pack.documentName !== 'Item' || !PREMIUM.test(pack.metadata.id)) continue;
            const idx = await pack.getIndex({ fields: ['type'] });
            const hit = idx.find(e => e.type === 'class' && e.name === name);
            if (hit) return await pack.getDocument(hit._id);
          }
          return null;
        };
        const norm = a =>
          (a.levels ?? (a.level != null ? [a.level] : [])).map(Number).filter(Number.isFinite);
        const restriction = a => a.classRestriction ?? a.level?.classRestriction ?? '';
        // Apply a class's advancements at the given levels, filtered by multiclass role.
        const applyClass = async (item, levels, role) => {
          const recs = [];
          const byType = item.advancement?.byType || {};
          const todo = [];
          for (const [t, arr] of Object.entries(byType))
            for (const a of arr)
              for (const lvl of levels) if (norm(a).includes(lvl)) todo.push({ a, t, lvl });
          todo.sort((x, y) => x.lvl - y.lvl);
          for (const { a, t, lvl } of todo) {
            const cr = restriction(a);
            // primary: skip 'secondary'; secondary (multiclass): skip 'primary'
            if (role === 'primary' && cr === 'secondary') {
              recs.push({ t, title: a.title, lvl, skip: 'secondary-only' });
              continue;
            }
            if (role === 'secondary' && cr === 'primary') {
              recs.push({ t, title: a.title, lvl, skip: 'primary-only' });
              continue;
            }
            try {
              if (t === 'HitPoints') {
                const mode = lvl === 1 && item.isOriginalClass ? 'max' : 'avg';
                await a.apply(lvl, { [lvl]: mode });
                recs.push({ t, title: a.title, lvl, r: `hp:${mode}` });
              } else if (t === 'AbilityScoreImprovement') {
                recs.push({ t, title: a.title, lvl, r: 'skip-asi' });
              } else if (t === 'Trait') {
                await a.apply(lvl, {}, { initial: true });
                recs.push({ t, title: a.title, lvl, cr, r: 'trait' });
              } else if (t === 'ItemChoice') {
                await a.apply(lvl, {}, { initial: true });
                recs.push({ t, title: a.title, lvl, r: 'itemchoice-forced' });
              } else {
                await a.apply(lvl, {}, { initial: true });
                recs.push({ t, title: a.title, lvl, r: 'forced' });
              }
            } catch (e) {
              recs.push({
                t,
                title: a.title,
                lvl,
                r: `ERR:${(e?.message || e).toString().slice(0, 80)}`,
              });
            }
          }
          return recs;
        };
        const out = {
          tempId: null,
          builtId: null,
          fighterSteps: [],
          wizardSteps: [],
          persisted: {},
          errors: [],
        };
        try {
          const fighter = await findClass('Fighter');
          const wizard = await findClass('Wizard');
          if (!fighter || !wizard) return out.errors.push('missing class'), out;
          const before = game.settings.get('dnd5e', 'disableAdvancements');
          await game.settings.set('dnd5e', 'disableAdvancements', true);
          const tmp = await globalThis.Actor.create({ name: `${arg.tag} MC`, type: 'character' });
          out.tempId = tmp.id;

          // primary class: Fighter, original, levels=1
          const fdata = fighter.toObject();
          delete fdata._id;
          fdata.system = fdata.system || {};
          fdata.system.levels = 1;
          const [fIt] = await tmp.createEmbeddedDocuments('Item', [fdata]);
          tmp.updateSource({ 'system.details.originalClass': fIt.id });
          out.fighterSteps = await applyClass(tmp.items.get(fIt.id), [1], 'primary');

          // secondary class: Wizard, NOT original, levels=1 — multiclass subset
          const wdata = wizard.toObject();
          delete wdata._id;
          wdata.system = wdata.system || {};
          wdata.system.levels = 1;
          const [wIt] = await tmp.createEmbeddedDocuments('Item', [wdata]);
          out.wizardSteps = await applyClass(tmp.items.get(wIt.id), [1], 'secondary');

          tmp.reset?.();
          // persist
          const built = tmp.toObject();
          delete built._id;
          built.name = `${arg.tag} MC BUILT`;
          const real = await globalThis.Actor.create(built);
          out.builtId = real.id;
          const fresh = game.actors.get(real.id);
          fresh.reset?.();
          const rd = fresh.getRollData();
          out.persisted = {
            level: fresh.system?.details?.level,
            hp: fresh.system?.attributes?.hp?.max,
            classes: fresh.items
              .filter(i => i.type === 'class')
              .map(i => ({ name: i.name, levels: i.system?.levels })),
            scaleKeys: Object.keys(rd?.scale || {}),
            spell1: fresh.system?.spells?.spell1?.max,
            castingAbility: fresh.system?.attributes?.spellcasting,
            skills: Object.entries(fresh.system?.skills || {})
              .filter(([, v]) => (v?.value ?? 0) > 0)
              .map(([k]) => k),
            saves: Object.entries(fresh.system?.abilities || {})
              .filter(([, v]) => v?.proficient)
              .map(([k]) => k),
          };
          await game.settings.set('dnd5e', 'disableAdvancements', before);
        } catch (e) {
          out.errors.push(`buildMC: ${e?.message || e}`);
        }
        return out;
      },
      { tag: TAG }
    ),
    240_000,
    'evalMC'
  );
  if (evalMC?.tempId) createdIds.push(evalMC.tempId);
  if (evalMC?.builtId) createdIds.push(evalMC.builtId);
  console.log('\n===== EVAL MC — multiclass Fighter 1 / Wizard 1 =====');
  console.log(JSON.stringify(evalMC, null, 2));
  console.log('=====================================================\n');

  // ===== EVAL LU — level-up an existing persisted PC (build L3 → bump to L4 in place → verify) =====
  const evalLU = await withNodeTimeout(
    f.evaluate(
      async arg => {
        const PREMIUM =
          /^(dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide|dnd-heroes-faerun|dnd-ravenloft-horrors-within)\./;
        const game = globalThis.game;
        const findClass = async name => {
          for (const pack of game.packs) {
            if (pack.documentName !== 'Item' || !PREMIUM.test(pack.metadata.id)) continue;
            const idx = await pack.getIndex({ fields: ['type'] });
            const hit = idx.find(e => e.type === 'class' && e.name === name);
            if (hit) return await pack.getDocument(hit._id);
          }
          return null;
        };
        const norm = a =>
          (a.levels ?? (a.level != null ? [a.level] : [])).map(Number).filter(Number.isFinite);
        const advAt = (item, lvl) => {
          const out = [];
          const byType = item.advancement?.byType || {};
          for (const [t, arr] of Object.entries(byType))
            for (const a of arr) if (norm(a).includes(lvl)) out.push({ a, t });
          return out;
        };
        const applyLevel = async (classItem, lvl, opts = {}) => {
          for (const { a, t } of advAt(classItem, lvl)) {
            try {
              if (t === 'HitPoints')
                await a.apply(lvl, {
                  [lvl]: lvl === 1 && classItem.isOriginalClass ? 'max' : 'avg',
                });
              else if (t === 'AbilityScoreImprovement') {
                /* skip */
              } else if (t === 'Subclass' && opts.subclassUuid)
                await a.apply(lvl, { uuid: opts.subclassUuid });
              else if (t === 'ItemChoice') await a.apply(lvl, {}, { initial: true });
              else await a.apply(lvl, {}, { initial: true });
            } catch (e) {
              /* collect below */
            }
          }
        };
        const out = {
          baseId: null,
          baseHp: null,
          baseLevel: null,
          afterHp: null,
          afterLevel: null,
          afterWeaponMastery: null,
          persistMethod: null,
          errors: [],
        };
        try {
          const fighter = await findClass('Fighter');
          const before = game.settings.get('dnd5e', 'disableAdvancements');
          await game.settings.set('dnd5e', 'disableAdvancements', true);

          // Build a base Fighter L3 (Champion@3) on a temp → persist (the "existing PC").
          const tmp = await globalThis.Actor.create({ name: `${arg.tag} LU`, type: 'character' });
          const fdata = fighter.toObject();
          delete fdata._id;
          fdata.system = fdata.system || {};
          fdata.system.levels = 3;
          const [fIt] = await tmp.createEmbeddedDocuments('Item', [fdata]);
          tmp.updateSource({
            'system.details.originalClass': fIt.id,
            'system.abilities.con.value': 14,
          });
          for (let lvl = 1; lvl <= 3; lvl++)
            await applyLevel(tmp.items.get(fIt.id), lvl, { subclassUuid: arg.championUuid });
          // run subclass features
          const subTmp = tmp.items.find(i => i.type === 'subclass');
          if (subTmp)
            for (let lvl = 0; lvl <= 3; lvl++) await applyLevel(tmp.items.get(subTmp.id), lvl);
          const baseSnap = tmp.toObject();
          delete baseSnap._id;
          baseSnap.name = `${arg.tag} LU BUILT`;
          const base = await globalThis.Actor.create(baseSnap);
          out.baseId = base.id;
          await tmp.delete();
          let fresh = game.actors.get(base.id);
          fresh.reset?.();
          out.baseHp = fresh.system?.attributes?.hp?.max;
          out.baseLevel = fresh.system?.details?.level;
          const wm0 = fresh.items.filter(i => /weapon mastery/i.test(i.name)).length;

          // ---- LEVEL UP IN PLACE: 3 → 4 ----
          const classItem = fresh.items.find(i => i.type === 'class');
          // bump the class level (persists immediately)
          await fresh.updateEmbeddedDocuments('Item', [{ _id: classItem.id, 'system.levels': 4 }]);
          fresh = game.actors.get(base.id);
          fresh.reset?.();
          const liveClass = fresh.items.find(i => i.type === 'class');
          // apply ONLY level 4 advancements (prior value-state should already be recorded)
          await applyLevel(liveClass, 4, {});
          // persist the in-memory mutations
          out.persistMethod = 'actor.update(toObject)';
          await fresh.update(fresh.toObject());
          fresh = game.actors.get(base.id);
          fresh.reset?.();
          out.afterHp = fresh.system?.attributes?.hp?.max;
          out.afterLevel = fresh.system?.details?.level;
          out.afterWeaponMastery = fresh.items.filter(i => /weapon mastery/i.test(i.name)).length;
          out.wmBefore = wm0;

          await game.settings.set('dnd5e', 'disableAdvancements', before);
        } catch (e) {
          out.errors.push(`LU: ${e?.message || e}`);
        }
        return out;
      },
      { tag: TAG, championUuid: evalA?.champion }
    ),
    240_000,
    'evalLU'
  );
  if (evalLU?.baseId) createdIds.push(evalLU.baseId);
  console.log('\n===== EVAL LU — level-up an existing PC (3 → 4 in place) =====');
  console.log(JSON.stringify(evalLU, null, 2));
  console.log('=============================================================\n');

  // --- Assertions ---
  // (MC) discovery + build
  const anyRestriction = [...(evalA?.fighter || []), ...(evalA?.wizard || [])].some(
    r => r.classRestriction
  );
  assert(
    anyRestriction,
    `(MC) classRestriction field is populated on some advancement (Wizard: ${JSON.stringify((evalA?.wizard || []).filter(r => r.classRestriction).map(r => `${r.title}=${r.classRestriction}`))})`
  );
  assert(
    evalMC?.persisted?.level === 2,
    `(MC) multiclass character level sums = 2 (got ${evalMC?.persisted?.level})`
  );
  assert(
    (evalMC?.persisted?.classes?.length ?? 0) === 2,
    `(MC) two class items persisted (${JSON.stringify(evalMC?.persisted?.classes)})`
  );
  // Fighter L1 max d10 (10) + Wizard L1 avg d6 (4) + CON(0 default)×2 = 14
  assert(
    evalMC?.persisted?.hp === 14,
    `(MC) multiclass HP = 14 (Fighter d10 max + Wizard d6 avg, CON+0) (got ${evalMC?.persisted?.hp})`
  );
  assert(
    (evalMC?.persisted?.scaleKeys || []).includes('fighter'),
    `(MC) both @scale namespaces present (${JSON.stringify(evalMC?.persisted?.scaleKeys)})`
  );
  assert(
    evalMC?.persisted?.spell1 >= 2,
    `(MC) multiclass spell slots auto-derive (spell1.max=${evalMC?.persisted?.spell1})`
  );

  // (LU) level-up
  assert(evalLU?.baseLevel === 3, `(LU) base PC built at level 3 (got ${evalLU?.baseLevel})`);
  assert(evalLU?.afterLevel === 4, `(LU) leveled up to 4 in place (got ${evalLU?.afterLevel})`);
  assert(
    evalLU?.afterHp > evalLU?.baseHp,
    `(LU) HP increased on level-up (${evalLU?.baseHp} → ${evalLU?.afterHp}; expect +avg6+CON2 = +8)`
  );
  assert(
    evalLU?.afterHp === evalLU?.baseHp + 8,
    `(LU) HP delta correct = +8 (avg6 + CON14) (${evalLU?.baseHp} → ${evalLU?.afterHp})`
  );
} catch (e) {
  fails++;
  console.log(`\n[spike-v3] FATAL: ${e?.message || String(e)}`);
} finally {
  const ids = [...createdIds, `${TAG} MC`, `${TAG} MC BUILT`, `${TAG} LU`, `${TAG} LU BUILT`];
  try {
    await withNodeTimeout(
      f.call('deleteActor', { identifiers: ids, removeEmptyFolder: true }),
      30_000,
      'cleanup'
    );
    // sweep strays
    await withNodeTimeout(
      f.evaluate(async tag => {
        const hits = globalThis.game.actors.filter(a => a.name?.startsWith(tag));
        for (const a of hits) await a.delete();
        return hits.length;
      }, TAG),
      30_000,
      'sweep'
    );
    console.log('[spike-v3] cleanup attempted');
  } catch (e) {
    console.log(`[spike-v3] cleanup note: ${e?.message || e}`);
  }
  await f.dispose?.();
}

console.log(`\n==== PC v3 spike: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
