// Phase-5 PC v2 spike: prove MULTI-LEVEL leveling (1→N) before extending the engine.
//
// v1 ships a complete LEVEL-1 PC. v2 widens to level 1→N. The engine already loops levelsUpTo(level)
// and routes Subclass/ASI, but three things are UNPROVEN past level 1 — this spike nails them live so
// the engine is changed against real behaviour, not guessed:
//   (a) MULTI-LEVEL HP. HitPointsAdvancement.apply({initial:true}) only sets HP at L1 (and L2+ only if
//       the prior level was "avg"). So L2+ needs explicit data {[level]: "avg"|"max"|<rolled>}.
//   (b) SUBCLASS at L3. Does the class's Subclass advancement apply(3,{uuid}) EMBED the subclass item
//       AND run its own advancements (subclass features at 3/7/…), or must the engine separately embed
//       + advance the subclass item?
//   (c) ASI/FEAT at L4. The data shape for AbilityScoreImprovement — ability path (we SKIP it; the
//       skill bakes increases into final scores) vs FEAT path (grant a feat). Discover the apply shape.
//   + confirm @scale + spell slots scale with character level, and the subclass pack ids.
//
// Each eval is isolated + node-timeout-bounded; small finders are inlined per eval (page.evaluate runs
// a fresh function body, no Node closure). Temp actors are TAG-namespaced and deleted in `finally`.
//
// Build first: npm run build. Run: node scripts/spike-pc-level.mjs
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

const TAG = 'ZZ-PCV2-SPIKE';
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
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const createdIds = [];

try {
  console.log('[spike-lvl] connecting to sandbox (cold-start can take minutes)…');
  await f.connect();
  console.log('[spike-lvl] connected\n');

  // ===== EVAL A — DISCOVERY: subclass packs, Fighter/Wizard/Champion maps, ASI/Subclass/HP sources =
  const evalA = await withNodeTimeout(
    f.evaluate(async () => {
      const PREMIUM =
        /^(dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide|dnd-heroes-faerun|dnd-ravenloft-horrors-within)\./;
      const game = globalThis.game;
      const findByType = async (typeName, name) => {
        for (const pack of game.packs) {
          if (pack.documentName !== 'Item' || !PREMIUM.test(pack.metadata.id)) continue;
          const idx = await pack.getIndex({ fields: ['type'] });
          const hit = idx.find(e => e.type === typeName && (name ? e.name === name : true));
          if (hit) return { doc: await pack.getDocument(hit._id), packId: pack.metadata.id };
        }
        return null;
      };
      const normLevels = a =>
        (a.levels ?? (a.level != null ? [a.level] : []))
          .map(Number)
          .filter(n => Number.isFinite(n));
      const dump = item => {
        const out = [];
        const byType = item.advancement?.byType || {};
        for (const [t, arr] of Object.entries(byType)) {
          for (const a of arr) {
            const cfg = a.configuration || {};
            const row = { type: t, title: a.title, levels: normLevels(a), id: a.id };
            if (t === 'AbilityScoreImprovement') {
              row.points = cfg.points;
              row.allowFeat = a.allowFeat;
              row.fixed = cfg.fixed;
            }
            if (t === 'ScaleValue') row.identifier = cfg.identifier;
            out.push(row);
          }
        }
        return out
          .filter(r => (r.levels[0] ?? 0) <= 5)
          .sort((x, y) => (x.levels[0] ?? 0) - (y.levels[0] ?? 0));
      };
      const out = {
        subclassPack: null,
        subclasses: {},
        fighter: [],
        wizard: [],
        champion: [],
        asiSrc: null,
        subclassSrc: null,
        hpSrc: null,
        errors: [],
      };
      const note = (w, e) => out.errors.push(`${w}: ${e?.message || e}`);
      try {
        const reg = globalThis.dnd5e?.documents?.advancement || {};
        out.asiSrc =
          reg.AbilityScoreImprovementAdvancement?.prototype?.apply?.toString?.().slice(0, 1400) ??
          null;
        out.subclassSrc =
          reg.SubclassAdvancement?.prototype?.apply?.toString?.().slice(0, 700) ?? null;
        out.hpSrc = reg.HitPointsAdvancement?.prototype?.apply?.toString?.().slice(0, 700) ?? null;
      } catch (e) {
        note('reg', e);
      }
      try {
        for (const pack of game.packs) {
          if (pack.documentName !== 'Item' || !PREMIUM.test(pack.metadata.id)) continue;
          const idx = await pack.getIndex({ fields: ['type'] });
          const subs = idx.filter(e => e.type === 'subclass');
          if (!subs.length) continue;
          out.subclassPack = out.subclassPack ?? pack.metadata.id;
          for (const want of ['Champion', 'Evoker', 'Evocation']) {
            if (out.subclasses[want]) continue;
            const hit = subs.find(s => new RegExp(want, 'i').test(s.name));
            if (hit)
              out.subclasses[want] = {
                name: hit.name,
                uuid: `Compendium.${pack.metadata.id}.Item.${hit._id}`,
              };
          }
        }
      } catch (e) {
        note('subclassScan', e);
      }
      try {
        const fighter = await findByType('class', 'Fighter');
        if (fighter) out.fighter = dump(fighter.doc);
        const wizard = await findByType('class', 'Wizard');
        if (wizard) out.wizard = dump(wizard.doc);
        const champ = await findByType('subclass', 'Champion');
        if (champ) out.champion = dump(champ.doc);
      } catch (e) {
        note('dump', e);
      }
      return out;
    }, {}),
    120_000,
    'evalA'
  );
  console.log(
    '\n===== EVAL A — subclass packs + Fighter/Wizard/Champion maps + apply sources ====='
  );
  console.log(JSON.stringify(evalA, null, 2));
  console.log(
    '===================================================================================\n'
  );

  // ===== EVAL B — build a LEVEL-5 Fighter (Champion@3, ASI@4 feat-path probe) → persist → verify =====
  const championUuid = evalA?.subclasses?.Champion?.uuid ?? null;
  const evalB = await withNodeTimeout(
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
        const normLevels = a =>
          (a.levels ?? (a.level != null ? [a.level] : []))
            .map(Number)
            .filter(n => Number.isFinite(n));
        const advAt = (item, lvl) => {
          const out = [];
          const byType = item.advancement?.byType || {};
          for (const [t, arr] of Object.entries(byType))
            for (const a of arr) if (normLevels(a).includes(lvl)) out.push({ a, t });
          return out;
        };
        const out = {
          tempId: null,
          builtId: null,
          steps: [],
          subclass: {},
          inMemoryHp: null,
          persisted: {},
          errors: [],
        };
        const note = (w, e) => out.errors.push(`${w}: ${e?.message || e}`);
        try {
          const fighter = await findClass('Fighter');
          if (!fighter) return note('find', new Error('no Fighter')), out;
          const before = game.settings.get('dnd5e', 'disableAdvancements');
          await game.settings.set('dnd5e', 'disableAdvancements', true);
          const tmp = await globalThis.Actor.create({ name: `${arg.tag} L5`, type: 'character' });
          out.tempId = tmp.id;
          const cdata = fighter.toObject();
          delete cdata._id;
          cdata.system = cdata.system || {};
          cdata.system.levels = 5;
          const [cls] = await tmp.createEmbeddedDocuments('Item', [cdata]);
          tmp.updateSource({ 'system.details.originalClass': cls.id });
          const liveCls = () => tmp.items.get(cls.id);

          for (let lvl = 1; lvl <= 5; lvl++) {
            for (const { a, t } of advAt(liveCls(), lvl)) {
              const rec = { lvl, type: t, title: a.title };
              try {
                if (t === 'HitPoints') {
                  const mode = lvl === 1 ? 'max' : 'avg';
                  await a.apply(lvl, { [lvl]: mode });
                  rec.result = `hp:${mode}`;
                } else if (t === 'Subclass') {
                  await a.apply(lvl, { uuid: arg.championUuid });
                  rec.result = 'subclass-applied';
                } else if (t === 'AbilityScoreImprovement') {
                  rec.fixed = JSON.stringify(a.configuration?.fixed ?? {});
                  rec.allowFeat = a.allowFeat;
                  // probe the FEAT path shape (best-effort; we read the result, not assert it)
                  try {
                    await a.apply(lvl, { type: 'feat' }, { initial: false });
                    rec.result = 'asi-feat-attempted';
                  } catch (e2) {
                    rec.result = `asi-feat-ERR: ${(e2?.message || e2).toString().slice(0, 160)}`;
                  }
                } else if (t === 'Trait') {
                  await a.apply(lvl, {}, { initial: true });
                  if (lvl === 1 && /skill/i.test(a.title)) {
                    const grp = a.configuration?.choices?.[0];
                    const pool = grp?.pool ? Array.from(grp.pool) : [];
                    const picks = pool
                      .filter(k => !String(k).includes('*'))
                      .slice(0, grp?.count ?? 0);
                    if (picks.length) await a.apply(lvl, { chosen: picks });
                  }
                  rec.result = 'trait';
                } else if (t === 'ItemChoice') {
                  const cfg = a.configuration || {};
                  const count = cfg.choices?.[lvl]?.count ?? cfg.choices?.[String(lvl)]?.count ?? 1;
                  const pool = (cfg.pool || [])
                    .map(p => p.uuid)
                    .filter(Boolean)
                    .slice(0, count);
                  if (pool.length) {
                    await a.apply(lvl, { selected: pool });
                    rec.result = 'itemchoice';
                  } else {
                    await a.apply(lvl, {}, { initial: true });
                    rec.result = 'itemchoice-empty';
                  }
                } else {
                  await a.apply(lvl, {}, { initial: true });
                  rec.result = 'forced';
                }
              } catch (e) {
                rec.result = `ERR: ${(e?.message || e).toString().slice(0, 160)}`;
              }
              out.steps.push(rec);
            }
          }

          tmp.reset?.();
          const subItem = tmp.items.find(i => i.type === 'subclass');
          out.subclass.present = !!subItem;
          if (subItem) {
            out.subclass.name = subItem.name;
            out.subclass.featCountBefore = tmp.items.filter(i => i.type === 'feat').length;
            // run the subclass item's OWN advancements at levels 0..5 (subclass features)
            for (let lvl = 0; lvl <= 5; lvl++) {
              for (const { a } of advAt(tmp.items.get(subItem.id), lvl)) {
                try {
                  await a.apply(lvl, {}, { initial: true });
                } catch (e) {
                  note(`subadv:${a.title}`, e);
                }
              }
            }
            tmp.reset?.();
            out.subclass.featCountAfter = tmp.items.filter(i => i.type === 'feat').length;
            out.subclass.feats = tmp.items.filter(i => i.type === 'feat').map(i => i.name);
          }
          out.inMemoryHp = tmp.system?.attributes?.hp?.max;

          const built = tmp.toObject();
          delete built._id;
          built.name = `${arg.tag} L5 BUILT`;
          const real = await globalThis.Actor.create(built);
          out.builtId = real.id;
          const fresh = game.actors.get(real.id);
          fresh.reset?.();
          out.persisted.hp = fresh.system?.attributes?.hp?.max;
          out.persisted.level = fresh.system?.details?.level;
          out.persisted.feats = fresh.items.filter(i => i.type === 'feat').map(i => i.name);
          out.persisted.hasSubclass = fresh.items.some(i => i.type === 'subclass');
          const rd = fresh.getRollData();
          out.persisted.scaleKeys = Object.keys(rd?.scale || {});
          out.persisted.secondWind = globalThis.Roll.replaceFormulaData(
            '@scale.fighter.second-wind',
            rd,
            { missing: '0', warn: false }
          );
          await game.settings.set('dnd5e', 'disableAdvancements', before);
        } catch (e) {
          note('buildB', e);
        }
        return out;
      },
      { tag: TAG, championUuid }
    ),
    240_000,
    'evalB'
  );
  if (evalB?.tempId) createdIds.push(evalB.tempId);
  if (evalB?.builtId) createdIds.push(evalB.builtId);
  console.log('\n===== EVAL B — Level-5 Fighter (Champion@3, ASI@4) =====');
  console.log(JSON.stringify(evalB, null, 2));
  console.log('=======================================================\n');

  // ===== EVAL C — Wizard level 3 (caster slots scale + subclass) =====
  const evokerUuid = evalA?.subclasses?.Evoker?.uuid ?? evalA?.subclasses?.Evocation?.uuid ?? null;
  const evalC = await withNodeTimeout(
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
        const normLevels = a =>
          (a.levels ?? (a.level != null ? [a.level] : []))
            .map(Number)
            .filter(n => Number.isFinite(n));
        const advAt = (item, lvl) => {
          const out = [];
          const byType = item.advancement?.byType || {};
          for (const [t, arr] of Object.entries(byType))
            for (const a of arr) if (normLevels(a).includes(lvl)) out.push({ a, t });
          return out;
        };
        const out = {
          tempId: null,
          builtId: null,
          slots: {},
          hasSubclass: null,
          hp: null,
          errors: [],
        };
        const note = (w, e) => out.errors.push(`${w}: ${e?.message || e}`);
        try {
          const wiz = await findClass('Wizard');
          if (!wiz) return note('find', new Error('no Wizard')), out;
          const before = game.settings.get('dnd5e', 'disableAdvancements');
          await game.settings.set('dnd5e', 'disableAdvancements', true);
          const tmp = await globalThis.Actor.create({ name: `${arg.tag} WIZ3`, type: 'character' });
          out.tempId = tmp.id;
          const cdata = wiz.toObject();
          delete cdata._id;
          cdata.system = cdata.system || {};
          cdata.system.levels = 3;
          const [cls] = await tmp.createEmbeddedDocuments('Item', [cdata]);
          tmp.updateSource({ 'system.details.originalClass': cls.id });
          for (let lvl = 1; lvl <= 3; lvl++) {
            for (const { a, t } of advAt(tmp.items.get(cls.id), lvl)) {
              try {
                if (t === 'HitPoints') await a.apply(lvl, { [lvl]: lvl === 1 ? 'max' : 'avg' });
                else if (t === 'Subclass' && arg.evokerUuid)
                  await a.apply(lvl, { uuid: arg.evokerUuid });
                else await a.apply(lvl, {}, { initial: true });
              } catch (e) {
                note(`adv:${a.title}`, e);
              }
            }
          }
          const built = tmp.toObject();
          delete built._id;
          built.name = `${arg.tag} WIZ3 BUILT`;
          const real = await globalThis.Actor.create(built);
          out.builtId = real.id;
          const fresh = game.actors.get(real.id);
          fresh.reset?.();
          const sp = fresh.system?.spells || {};
          out.slots = {
            spell1: sp.spell1?.max,
            spell2: sp.spell2?.max,
            ability: fresh.system?.attributes?.spellcasting,
          };
          out.hasSubclass = fresh.items.some(i => i.type === 'subclass');
          out.hp = fresh.system?.attributes?.hp?.max;
          await game.settings.set('dnd5e', 'disableAdvancements', before);
        } catch (e) {
          note('buildC', e);
        }
        return out;
      },
      { tag: TAG, evokerUuid }
    ),
    180_000,
    'evalC'
  );
  if (evalC?.tempId) createdIds.push(evalC.tempId);
  if (evalC?.builtId) createdIds.push(evalC.builtId);
  console.log('\n===== EVAL C — Wizard level 3 =====');
  console.log(JSON.stringify(evalC, null, 2));
  console.log('===================================\n');

  // --- Assertions ---
  assert(!!evalA?.subclassPack, `subclass pack discovered: ${evalA?.subclassPack}`);
  assert(
    !!championUuid,
    `Champion subclass resolved: ${JSON.stringify(evalA?.subclasses?.Champion)}`
  );
  // (a) multi-level HP: Fighter L5, CON default 10 (+0): 10 + 4×6 = 34
  assert(
    evalB?.persisted?.hp === 34,
    `(a) multi-level HP: Fighter L5 (d10 max + 4×avg6, CON+0) = 34 (got ${evalB?.persisted?.hp})`
  );
  // (b) subclass present + its features
  assert(evalB?.persisted?.hasSubclass === true, '(b) subclass item PERSISTED on the L5 Fighter');
  assert(
    (evalB?.subclass?.featCountAfter ?? 0) > (evalB?.subclass?.featCountBefore ?? 0),
    `(b) subclass features granted by running the subclass item's OWN advancements (${evalB?.subclass?.featCountBefore}→${evalB?.subclass?.featCountAfter}: ${(evalB?.subclass?.feats || []).join(', ')})`
  );
  // (c) ASI shape discovered
  const asiStep = (evalB?.steps || []).find(s => s.type === 'AbilityScoreImprovement');
  assert(
    !!asiStep,
    `(c) ASI advancement encountered at L4 (fixed=${asiStep?.fixed}, allowFeat=${asiStep?.allowFeat}, result=${asiStep?.result})`
  );
  // (d) caster slots scale: Wizard L3 → spell1.max 4, spell2.max 2
  assert(
    evalC?.slots?.spell1 === 4 && evalC?.slots?.spell2 === 2,
    `(d) Wizard L3 slots scale (spell1=${evalC?.slots?.spell1} spell2=${evalC?.slots?.spell2}; expect 4/2)`
  );
  assert(evalC?.hasSubclass === true, '(d) Wizard L3 subclass present');
} catch (e) {
  fails++;
  console.log(`\n[spike-lvl] FATAL: ${e?.message || String(e)}`);
} finally {
  const ids = [...createdIds, `${TAG} L5`, `${TAG} L5 BUILT`, `${TAG} WIZ3`, `${TAG} WIZ3 BUILT`];
  try {
    await withNodeTimeout(
      f.call('deleteActor', { identifiers: ids, removeEmptyFolder: true }),
      30_000,
      'cleanup'
    );
    console.log('[spike-lvl] cleanup attempted');
  } catch (e) {
    console.log(`[spike-lvl] cleanup note: ${e?.message || e}`);
  }
  await f.dispose?.();
}

console.log(`\n==== PC v2 leveling spike: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
