// Phase-5 spike run 4 (Eval D — GATING the PC engine): prove the REMAINING v1 surface.
//
// Runs 2 + 3 proved the make-or-break unknowns: @scale resolves via embed-only (no Manager), and
// advancement.apply(level, data, {initial:true}) drives advancement headlessly (defaulted, single-
// class, level-1, NO choice, NO species, NO background). The plan (~/.claude/plans/tingly-painting-
// pony.md) GATES v1 behind ONE more spike that proves what those left untouched, so the engine is
// written against PROVEN live behaviour — not statically-read apply() source. This is that spike.
//
// FINDINGS from run 4-iter-1 baked in here (the why behind the build sequence below):
//   • Trait choices are CLOBBERED by {initial:true}: TraitAdvancement.apply does
//       `if (options.initial) data = await this.automaticApplicationValue(...)` — overwriting our
//       data.chosen with only the AUTOMATIC (forced) traits. So we apply each Trait TWICE: once with
//       {initial:true} (forced grants: saves, forced profs) and, if the player picked, AGAIN with
//       {chosen:[keys]} and NO initial (the picks).
//   • Species + background creation features live at advancement LEVEL 0 (e.g. Soldier's
//       "Background Feat" ItemGrant is levels:[0]); class features at level 1. A level-1-only pass
//       missed every racial/background feature (→ no Dragonborn breath weapon → no racial @scale).
//       So we apply the union of levels {0,1}.
//   • ItemGrant/ItemChoice take {selected:[uuids]} (not {uuid:true}); Fighter's Fighting Style is a
//       granted ItemGrant feat, not an L1 ItemChoice — L1 player choices are Trait-based.
//   • Persist is naive-safe: toObject()→Actor.create preserves embedded item _ids, so originalClass
//       stays valid and HP is correct without keepEmbeddedIds. (Defensive re-set kept as insurance.)
//   • Wizard L1 slots auto-derive from class spellcasting progression — no manual slot setup.
//
// Each eval is isolated + node-timeout-bounded so a hang in one never costs the others (page.evaluate
// has NO timeout). Temp actors are TAG-namespaced and deleted in `finally`. disableAdvancements is
// set true for the build (prevents the auto-AdvancementManager render on class embed) and RESTORED.
//
// Build first: npm run build. Run: node scripts/spike-pc-build.mjs
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

const TAG = 'ZZ-PC-SPIKE';
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

const createdActorIds = [];

try {
  console.log('[spike-pc] connecting to sandbox (cold-start can take minutes)…');
  await f.connect();
  console.log('[spike-pc] connected\n');

  // ===== EVAL A — DISCOVERY: confirm apply contract key + dump Dragonborn/Soldier advancement maps =
  const evalA = await withNodeTimeout(
    f.evaluate(async () => {
      const out = { applyKeys: [], itemChoiceSrc: null, configs: {}, errors: [] };
      const note = (w, e) => out.errors.push(`${w}: ${e?.message || e}`);
      const game = globalThis.game;
      try {
        const reg = globalThis.dnd5e?.documents?.advancement || {};
        out.applyKeys = Object.keys(reg);
        out.itemChoiceSrc =
          reg.ItemChoiceAdvancement?.prototype?.apply?.toString?.().slice(0, 300) ?? null;
      } catch (e) {
        note('reg', e);
      }
      const PREMIUM =
        /^(dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide|dnd-heroes-faerun|dnd-ravenloft-horrors-within)\./;
      const findByType = async (typeName, name) => {
        for (const pack of game.packs) {
          if (pack.documentName !== 'Item' || !PREMIUM.test(pack.metadata.id)) continue;
          const idx = await pack.getIndex({ fields: ['type'] });
          const hit = idx.find(e => e.type === typeName && e.name === name);
          if (hit) return { doc: await pack.getDocument(hit._id), packId: pack.metadata.id };
        }
        return null;
      };
      const dumpAdv = doc => {
        const byType = doc.advancement?.byType || {};
        const rows = [];
        for (const [t, arr] of Object.entries(byType)) {
          for (const a of arr) {
            const cfg = a.configuration || {};
            const row = {
              type: t,
              title: a.title,
              levels: a.levels ?? (a.level != null ? [a.level] : []),
            };
            if (t === 'Trait') {
              row.grants = Array.from(cfg.grants || []);
              row.choices = (cfg.choices || []).map(c => ({
                count: c.count,
                pool: Array.from(c.pool || []).slice(0, 12),
              }));
            }
            if (t === 'ScaleValue') {
              row.identifier = cfg.identifier;
              row.scaleType = cfg.type;
            }
            if (t === 'AbilityScoreImprovement') row.asi = true;
            rows.push(row);
          }
        }
        return rows;
      };
      try {
        for (const [key, [typeName, name]] of Object.entries({
          dragonborn: ['race', 'Dragonborn'],
          soldier: ['background', 'Soldier'],
        })) {
          const hit = await findByType(typeName, name);
          out.configs[key] = hit
            ? { packId: hit.packId, identifier: hit.doc.system?.identifier, adv: dumpAdv(hit.doc) }
            : null;
        }
      } catch (e) {
        note('dump', e);
      }
      return out;
    }, {}),
    90_000,
    'evalA(discovery)'
  );
  console.log('\n===== EVAL A — apply registry keys + Dragonborn/Soldier advancement maps =====');
  console.log(JSON.stringify(evalA, null, 2));
  console.log('=============================================================================\n');

  // ===== EVAL B — full v1 build (class+species+background+CHOICES) → persist → verify ============
  const evalB = await withNodeTimeout(
    f.evaluate(
      async arg => {
        const out = {
          tempId: null,
          builtId: null,
          steps: [],
          inMemory: {},
          persisted: {},
          scale: {},
          breath: {},
          disableAdv: {},
          errors: [],
        };
        const note = (w, e) => out.errors.push(`${w}: ${e?.message || e}`);
        const game = globalThis.game;
        const PREMIUM =
          /^(dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide|dnd-heroes-faerun|dnd-ravenloft-horrors-within)\./;
        const findByType = async (typeName, name) => {
          for (const pack of game.packs) {
            if (pack.documentName !== 'Item' || !PREMIUM.test(pack.metadata.id)) continue;
            const idx = await pack.getIndex({ fields: ['type'] });
            const hit = idx.find(e => e.type === typeName && e.name === name);
            if (hit) return await pack.getDocument(hit._id);
          }
          return null;
        };
        const skillProfs = sk =>
          Object.entries(sk || {})
            .filter(([, v]) => (v?.value ?? 0) > 0)
            .map(([k]) => k);

        // Apply one item's advancements across the union of levels {0,1}, feeding choice data.
        // Two-call pattern for Trait: {initial} applies forced grants; a no-initial call applies picks.
        // ItemChoice (e.g. Draconic Ancestry) is applied with {selected:[uuids]}, no initial.
        // NOTE: advancement levels can be STRINGS ("0" for Dragonborn's ancestry) — coerce to Number.
        const normLevels = a => (a.levels ?? (a.level != null ? [a.level] : [])).map(Number);
        const applyItem = async (item, tag, choiceMap) => {
          const byType = item.advancement?.byType || {};
          const todo = [];
          for (const [t, arr] of Object.entries(byType)) {
            for (const a of arr) {
              const levels = normLevels(a);
              for (const lvl of [0, 1]) {
                if (levels.includes(lvl)) todo.push({ a, t, lvl });
              }
            }
          }
          // stable order: level asc
          todo.sort((x, y) => x.lvl - y.lvl);
          for (const { a, t, lvl } of todo) {
            const rec = { tag, type: t, title: a.title, level: lvl };
            try {
              // Skip background/species ASI — the skill owns final ability scores (design.md §2.1).
              if (t === 'AbilityScoreImprovement' && tag !== 'class') {
                rec.result = 'skipped (skill owns scores)';
                out.steps.push(rec);
                continue;
              }
              // 1) forced/automatic grants
              await a.apply(lvl, {}, { initial: true });
              // 2a) Trait player picks — NO initial (initial would clobber data.chosen)
              if (t === 'Trait') {
                const picks = choiceMap?.[a.title];
                if (picks?.length) {
                  await a.apply(lvl, { chosen: picks });
                  rec.chosen = picks;
                }
              }
              // 2b) ItemChoice player picks (selected:[uuids]) — pool uuids, count from config
              if (t === 'ItemChoice') {
                const cfg = a.configuration || {};
                const count = cfg.choices?.[lvl]?.count ?? cfg.choices?.[String(lvl)]?.count ?? 1;
                const pool = (cfg.pool || []).map(p => p.uuid).filter(Boolean);
                const override = choiceMap?.[a.title];
                const picks = (override?.length ? override : pool).slice(0, count);
                if (picks.length) {
                  await a.apply(lvl, { selected: picks });
                  rec.selected = picks;
                } else {
                  rec.note = 'empty pool';
                }
              }
              rec.result = 'applied';
            } catch (e) {
              rec.result = `ERROR: ${(e?.message || e).toString().slice(0, 200)}`;
            }
            out.steps.push(rec);
          }
        };
        // Scan every item on an actor for @scale.* tokens and resolve each against rollData.
        const scanScale = actor => {
          const rd = actor.getRollData();
          const found = [];
          for (const it of actor.items) {
            const src = JSON.stringify(it.toObject());
            const re = /@scale\.[a-z0-9_.-]+/gi;
            const seen = new Set();
            let m;
            while ((m = re.exec(src))) {
              if (seen.has(m[0])) continue;
              seen.add(m[0]);
              found.push({
                item: it.name,
                token: m[0],
                resolved: globalThis.Roll.replaceFormulaData(m[0], rd, {
                  missing: '0',
                  warn: false,
                }),
              });
            }
          }
          return found;
        };

        try {
          const fighter = await findByType('class', arg.className);
          const species = await findByType('race', arg.speciesName);
          const background = await findByType('background', arg.backgroundName);
          if (!fighter) return note('find', new Error(`no class ${arg.className}`)), out;

          // (f) set disableAdvancements true for the build, remember prior, restore at the end.
          try {
            out.disableAdv.before = game.settings.get('dnd5e', 'disableAdvancements');
            await game.settings.set('dnd5e', 'disableAdvancements', true);
          } catch (e) {
            note('setSetting', e);
          }

          const tmp = await globalThis.Actor.create({
            name: `${arg.tag} BUILD`,
            type: 'character',
          });
          out.tempId = tmp.id;

          // class embed at levels=1 + flag original BEFORE applying HitPoints.
          const cdata = fighter.toObject();
          delete cdata._id;
          cdata.system = cdata.system || {};
          cdata.system.levels = 1;
          const [cls] = await tmp.createEmbeddedDocuments('Item', [cdata]);
          tmp.updateSource({ 'system.details.originalClass': cls.id });
          out.classIdentifier = cls.system?.identifier;
          await applyItem(tmp.items.get(cls.id), 'class', {
            // class skill choice (2 of the Fighter list) — concrete skill keys from the pool
            'Skill Proficiencies': ['skills:acr', 'skills:ath'],
          });

          // species embed + advancement (level-0 racial features → breath weapon → racial @scale)
          if (species) {
            const sdata = species.toObject();
            delete sdata._id;
            const [sp] = await tmp.createEmbeddedDocuments('Item', [sdata]);
            out.speciesItemId = sp.id;
            await applyItem(tmp.items.get(sp.id), 'species', {});
          } else out.errors.push('species not found');

          // background embed + advancement (level-0 feat + skill/tool/language traits)
          if (background) {
            const bdata = background.toObject();
            delete bdata._id;
            const [bg] = await tmp.createEmbeddedDocuments('Item', [bdata]);
            out.backgroundItemId = bg.id;
            await applyItem(tmp.items.get(bg.id), 'background', {});
          } else out.errors.push('background not found');

          tmp.reset?.();
          out.inMemory = {
            itemCount: tmp.items.size,
            feats: tmp.items.filter(i => i.type === 'feat').map(i => i.name),
            hp: tmp.system?.attributes?.hp?.max,
            skills: skillProfs(tmp.system?.skills),
          };

          // ---- @scale diagnostic on the built actor: every @scale token across items + resolution ----
          const dumpScaleNs = actor => {
            const scale = actor.getRollData()?.scale || {};
            const flat = {};
            for (const ns of Object.keys(scale)) {
              for (const k of Object.keys(scale[ns] || {})) {
                const v = scale[ns][k];
                flat[`${ns}.${k}`] =
                  v && typeof v === 'object' ? (v.value ?? v.number ?? v.formula ?? String(v)) : v;
              }
            }
            return { keys: Object.keys(scale), flat };
          };
          out.scale = dumpScaleNs(tmp);
          out.scaleTokens = scanScale(tmp);
          out.breath = scanScale(tmp).filter(
            x => /breath/i.test(x.token) || /breath/i.test(x.item)
          );

          // ---- PERSIST (naive) + defensive originalClass re-set, then verify on the FRESH actor ----
          const built = tmp.toObject();
          delete built._id;
          built.name = `${arg.tag} BUILT`;
          const real = await globalThis.Actor.create(built);
          out.builtId = real.id;
          {
            let fresh = game.actors.get(real.id);
            fresh.reset?.();
            let clsItem = fresh.items.find(i => i.type === 'class');
            // defensive: if embedded ids drifted, re-anchor originalClass by the class item id
            if (clsItem && fresh.system?.details?.originalClass !== clsItem.id) {
              await fresh.update({ 'system.details.originalClass': clsItem.id });
              fresh = game.actors.get(real.id);
              fresh.reset?.();
              clsItem = fresh.items.find(i => i.type === 'class');
            }
            out.persisted = {
              hp: fresh.system?.attributes?.hp?.max,
              originalClassMatches: clsItem
                ? fresh.system?.details?.originalClass === clsItem.id
                : false,
              feats: fresh.items.filter(i => i.type === 'feat').map(i => i.name),
              skills: skillProfs(fresh.system?.skills),
              scale: dumpScaleNs(fresh),
            };
            out.persisted.breath = scanScale(fresh).filter(
              x => /breath/i.test(x.token) || /breath/i.test(x.item)
            );
          }
        } catch (e) {
          note('buildB', e);
        } finally {
          // (f) restore the original setting
          try {
            if (out.disableAdv.before !== undefined) {
              await game.settings.set('dnd5e', 'disableAdvancements', out.disableAdv.before);
              out.disableAdv.restored = true;
            }
          } catch (e) {
            note('restoreSetting', e);
          }
        }
        return out;
      },
      { tag: TAG, className: 'Fighter', speciesName: 'Dragonborn', backgroundName: 'Soldier' }
    ),
    180_000,
    'evalB(build+persist)'
  );
  for (const id of [evalB?.tempId, evalB?.builtId]) if (id) createdActorIds.push(id);
  console.log('\n===== EVAL B — full v1 build → persist (with choices, levels 0+1) =====');
  console.log(JSON.stringify(evalB, null, 2));
  console.log('======================================================================\n');

  // ===== EVAL D — Wizard caster: L1 slots auto-derive + addSpellsToActor cantrips ================
  const evalD = await withNodeTimeout(
    f.evaluate(
      async arg => {
        const out = { builtId: null, persistedId: null, autoSlots: {}, errors: [] };
        const note = (w, e) => out.errors.push(`${w}: ${e?.message || e}`);
        const game = globalThis.game;
        const PREMIUM =
          /^(dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide|dnd-heroes-faerun|dnd-ravenloft-horrors-within)\./;
        const findByType = async (typeName, name) => {
          for (const pack of game.packs) {
            if (pack.documentName !== 'Item' || !PREMIUM.test(pack.metadata.id)) continue;
            const idx = await pack.getIndex({ fields: ['type'] });
            const hit = idx.find(e => e.type === typeName && e.name === name);
            if (hit) return await pack.getDocument(hit._id);
          }
          return null;
        };
        try {
          const wiz = await findByType('class', 'Wizard');
          if (!wiz) return note('find', new Error('no Wizard')), out;
          const before = game.settings.get('dnd5e', 'disableAdvancements');
          await game.settings.set('dnd5e', 'disableAdvancements', true);
          const tmp = await globalThis.Actor.create({ name: `${arg.tag} WIZ`, type: 'character' });
          out.builtId = tmp.id;
          const cdata = wiz.toObject();
          delete cdata._id;
          cdata.system = cdata.system || {};
          cdata.system.levels = 1;
          const [cls] = await tmp.createEmbeddedDocuments('Item', [cdata]);
          tmp.updateSource({ 'system.details.originalClass': cls.id });
          const byType = tmp.items.get(cls.id).advancement?.byType || {};
          for (const [, arr] of Object.entries(byType)) {
            for (const a of arr) {
              const levels = a.levels ?? (a.level != null ? [a.level] : []);
              if (levels.includes(1)) {
                try {
                  await a.apply(1, {}, { initial: true });
                } catch (e) {
                  note(`apply:${a.title}`, e);
                }
              }
            }
          }
          const built = tmp.toObject();
          delete built._id;
          built.name = `${arg.tag} WIZ-BUILT`;
          const real = await globalThis.Actor.create(built);
          out.persistedId = real.id;
          const fresh = game.actors.get(real.id);
          fresh.reset?.();
          const spells = fresh.system?.spells || {};
          out.autoSlots = {
            spell1max: spells.spell1?.max,
            castingAbility: fresh.system?.attributes?.spellcasting,
            progression: fresh.items.find(i => i.type === 'class')?.system?.spellcasting
              ?.progression,
          };
          await game.settings.set('dnd5e', 'disableAdvancements', before);
        } catch (e) {
          note('buildD', e);
        }
        return out;
      },
      { tag: TAG }
    ),
    150_000,
    'evalD(wizard)'
  );
  for (const id of [evalD?.builtId, evalD?.persistedId]) if (id) createdActorIds.push(id);
  console.log('\n===== EVAL D — Wizard caster L1 spell slots =====');
  console.log(JSON.stringify(evalD, null, 2));
  console.log('=================================================\n');

  // --- Assertions -------------------------------------------------------------------------------
  assert(
    evalA?.applyKeys?.includes('ItemChoiceAdvancement') && !!evalA?.itemChoiceSrc,
    'ItemChoiceAdvancement.apply() contract captured (selected:[uuids] shape)'
  );
  assert(
    !!evalA?.configs?.dragonborn?.adv?.some(a => a.type === 'ItemChoice'),
    `Dragonborn racial @scale comes from a Draconic Ancestry ItemChoice (level "0"): ${JSON.stringify(evalA?.configs?.dragonborn?.adv?.filter(a => a.type === 'ItemChoice'))}`
  );

  // (e) HP correct on persisted Fighter (d10 + 0 CON = 10) + originalClass anchored
  assert(
    evalB?.persisted?.hp === 10,
    `(e) persisted Fighter L1 HP=10 (got ${evalB?.persisted?.hp})`
  );
  assert(
    evalB?.persisted?.originalClassMatches === true,
    '(e) persisted originalClass points at the live class item'
  );

  // (a) Trait skill choices land + persist
  const skills = evalB?.persisted?.skills || [];
  assert(
    skills.includes('acr') && skills.includes('ath'),
    `(a) Trait skill choices PERSISTED as proficiencies (got ${skills.join(', ') || 'NONE'})`
  );
  const feats = evalB?.persisted?.feats || [];
  assert(
    feats.length >= 4,
    `(a)+(c) class + species + background features PERSISTED (${feats.length}: ${feats.join(', ')})`
  );

  // (b) racial @scale resolves on persisted PC (real token discovered live via the ancestry pick)
  const breathTok = evalB?.breath?.[0]?.token ?? null;
  assert(
    !!breathTok,
    `(b) breath-weapon @scale token discovered: ${breathTok} (all: ${JSON.stringify(evalB?.scaleTokens?.map(x => x.token))})`
  );
  const br = evalB?.persisted?.breath?.[0]?.resolved;
  assert(
    br != null && String(br) !== '0' && !/@scale/.test(String(br)),
    `(b) racial @scale resolves on persisted PC (${evalB?.persisted?.breath?.[0]?.token} -> ${JSON.stringify(br)})`
  );

  // (c) background feat granted (level-0 ItemGrant)
  assert(
    (evalB?.steps || []).some(s => s.tag === 'background' && s.result === 'applied'),
    '(c) background level-0 advancement applied'
  );

  // (d) Wizard L1 spell slots auto-derive
  assert(
    evalD?.autoSlots?.spell1max >= 2,
    `(d) Wizard L1 spell slots auto-derive (spell1.max=${evalD?.autoSlots?.spell1max}, ability=${evalD?.autoSlots?.castingAbility})`
  );

  // (f) disableAdvancements set + restored
  assert(
    evalB?.disableAdv?.restored === true,
    `(f) disableAdvancements toggled for build + restored (before=${JSON.stringify(evalB?.disableAdv?.before)})`
  );
} catch (e) {
  fails++;
  console.log(`\n[spike-pc] FATAL: ${e?.message || String(e)}`);
} finally {
  const ids = [
    ...createdActorIds,
    `${TAG} BUILD`,
    `${TAG} BUILT`,
    `${TAG} WIZ`,
    `${TAG} WIZ-BUILT`,
  ];
  try {
    await withNodeTimeout(
      f.call('deleteActor', { identifiers: ids, removeEmptyFolder: true }),
      30_000,
      'cleanup'
    );
    console.log('[spike-pc] cleanup attempted');
  } catch (e) {
    console.log(`[spike-pc] cleanup note: ${e?.message || e}`);
  }
  await f.dispose?.();
}

console.log(`\n==== PC-build spike (Eval D): ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
