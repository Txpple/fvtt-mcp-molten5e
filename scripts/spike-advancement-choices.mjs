// Phase-5 spike run 3: HOW do we drive CHOICE-based advancement (subclass/ASI/feat/skill) headless?
//
// Run 2 proved @scale resolves via embed-only (no Manager). This run tackles the SEPARATE, harder
// half: the choice-bearing advancements (ItemGrant feats, AbilityScoreImprovement, Subclass, Trait
// skill/feat picks). Run 2's static dump showed AdvancementManager.forNewItem is a sync factory
// returning a Foundry *Application*; run 1 hung on its .close() (a "discard advancement?" Dialog that
// blocks headless). The Manager's stepping logic is UI-coupled (and likely #private), so the
// headless-viable mechanism is almost certainly applying each Advancement DIRECTLY —
// advancement.apply(level, choiceData) — bypassing the Manager UI entirely.
//
//   Eval A (static, SAFE): every dnd5e.documents.advancement class's apply() signature + source, and
//        a Rogue/Fighter advancement-by-level map (what each level needs + which need a choice).
//   Eval B (empirical, BOUNDED): embed a class, then manually apply() each level-1 advancement and
//        verify granted items appear + @scale still resolves — NO Manager, NO render/close.
//
// Each eval is isolated + node-timeout-bounded so a hang in one never costs the other (page.evaluate
// has no timeout — run 1 ran 30+ min). Temp actors are TAG-namespaced and deleted in `finally`.
//
// Build first: npm run build. Run: node scripts/spike-advancement-choices.mjs
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

const TAG = 'ZZ-ADV-CHOICE';
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
  console.log('[spike-adv3] connecting to sandbox…');
  await f.connect();
  console.log('[spike-adv3] connected\n');

  // ===== Eval A — static advancement API + class-by-level maps (cannot hang) =====
  const evalA = await withNodeTimeout(
    f.evaluate(
      async arg => {
        const out = { advRegistry: [], advSources: {}, classMaps: {}, errors: [] };
        const note = (w, e) => out.errors.push(`${w}: ${e?.message || e}`);
        const game = globalThis.game;
        try {
          const reg = globalThis.dnd5e?.documents?.advancement || {};
          out.advRegistry = Object.keys(reg);
          for (const [name, cls] of Object.entries(reg)) {
            if (typeof cls !== 'function') continue;
            const apply = cls.prototype?.apply;
            out.advSources[name] = {
              applyArity: apply?.length ?? null,
              applyIsAsync: apply?.constructor?.name === 'AsyncFunction',
              hasReverse: typeof cls.prototype?.reverse === 'function',
              applySrc: apply?.toString?.().slice(0, 700) ?? null,
            };
          }
        } catch (e) {
          note('registry', e);
        }
        try {
          for (const wantName of arg.classNames) {
            let doc = null;
            for (const pack of game.packs) {
              if (pack.documentName !== 'Item' || !/dnd-players-handbook/.test(pack.metadata.id))
                continue;
              const idx = await pack.getIndex({ fields: ['type'] });
              const hit = idx.find(e => e.type === 'class' && e.name === wantName);
              if (hit) {
                doc = await pack.getDocument(hit._id);
                break;
              }
            }
            if (!doc) continue;
            const byType = doc.advancement?.byType || {};
            const collected = [];
            for (const [t, arr] of Object.entries(byType)) {
              for (const a of arr) {
                collected.push({
                  type: t,
                  title: a.title,
                  levels: a.levels ?? (a.level != null ? [a.level] : []),
                  hint: a.hint ? String(a.hint).slice(0, 80) : undefined,
                  configKeys: a.configuration ? Object.keys(a.configuration) : [],
                });
              }
            }
            out.classMaps[wantName] = collected
              .filter(c => (c.levels[0] ?? 0) <= 3)
              .sort((x, y) => (x.levels[0] ?? 0) - (y.levels[0] ?? 0));
          }
        } catch (e) {
          note('classMaps', e);
        }
        return out;
      },
      { classNames: ['Rogue', 'Fighter'] }
    ),
    60_000,
    'evalA(static)'
  );
  console.log('\n===== EVAL A — advancement API + class maps =====');
  console.log(JSON.stringify(evalA, null, 2));

  // ===== Eval B — empirical manual apply() of level-1 advancements (bounded; no Manager) =====
  const evalB = await withNodeTimeout(
    f.evaluate(
      async arg => {
        const out = {
          actorId: null,
          embed: {},
          applied: [],
          grantedItems: [],
          scaleAfter: {},
          errors: [],
        };
        const note = (w, e) => out.errors.push(`${w}: ${e?.message || e}`);
        const game = globalThis.game;
        try {
          let doc = null;
          for (const pack of game.packs) {
            if (pack.documentName !== 'Item' || !/dnd-players-handbook/.test(pack.metadata.id))
              continue;
            const idx = await pack.getIndex({ fields: ['type'] });
            const hit = idx.find(e => e.type === 'class' && e.name === arg.className);
            if (hit) {
              doc = await pack.getDocument(hit._id);
              break;
            }
          }
          if (!doc) {
            note('find', new Error(`no ${arg.className} in PHB`));
            return out;
          }
          try {
            await game.settings.set('dnd5e', 'disableAdvancements', true);
          } catch {}

          const actor = await globalThis.Actor.create({
            name: `${arg.tag} APPLY`,
            type: 'character',
          });
          out.actorId = actor.id;
          const cdata = doc.toObject();
          delete cdata._id;
          cdata.system = cdata.system || {};
          cdata.system.levels = 1;
          const [cls] = await actor.createEmbeddedDocuments('Item', [cdata]);
          out.embed.classItemId = cls.id;
          out.embed.itemCountBefore = actor.items.size;

          // Collect this class item's level-1 advancements and apply each with NO choice data (default).
          const lvl = 1;
          const byType = cls.advancement?.byType || {};
          const todo = [];
          for (const [t, arr] of Object.entries(byType)) {
            for (const a of arr) {
              const levels = a.levels ?? (a.level != null ? [a.level] : []);
              if (levels.includes(lvl)) todo.push({ a, t });
            }
          }
          for (const { a, t } of todo) {
            const rec = { type: t, title: a.title, applyType: typeof a.apply };
            try {
              if (typeof a.apply === 'function') {
                await a.apply(lvl, {});
                rec.result = 'applied';
              } else {
                rec.result = 'no-apply-method';
              }
            } catch (e) {
              rec.result = `ERROR: ${(e?.message || e).toString().slice(0, 160)}`;
            }
            out.applied.push(rec);
          }

          const af = game.actors.get(actor.id);
          af.reset?.();
          out.embed.itemCountAfter = af.items.size;
          out.grantedItems = af.items
            .filter(i => i.type !== 'class')
            .map(i => ({ name: i.name, type: i.type }));
          const rd = af.getRollData();
          const scale = rd?.scale || {};
          for (const k of Object.keys(scale)) {
            out.scaleAfter[k] = {};
            for (const sk of Object.keys(scale[k] || {})) {
              const v = scale[k][sk];
              out.scaleAfter[k][sk] =
                v && typeof v === 'object' ? (v.value ?? v.number ?? v.formula) : v;
            }
          }
        } catch (e) {
          note('applyExp', e);
        }
        return out;
      },
      { tag: TAG, className: 'Rogue' }
    ),
    120_000,
    'evalB(apply)'
  );
  if (evalB?.actorId) createdActorIds.push(evalB.actorId);
  console.log('\n===== EVAL B — manual apply() of level-1 advancements =====');
  console.log(JSON.stringify(evalB, null, 2));
  console.log('==========================================================\n');

  // ===== Eval C — full headless build+persist loop (apply {initial:true} → snapshot → create) =====
  const evalC = await withNodeTimeout(
    f.evaluate(
      async arg => {
        const out = { tempId: null, builtId: null, inMemory: {}, persisted: {}, errors: [] };
        const note = (w, e) => out.errors.push(`${w}: ${e?.message || e}`);
        const game = globalThis.game;
        try {
          let doc = null;
          for (const pack of game.packs) {
            if (pack.documentName !== 'Item' || !/dnd-players-handbook/.test(pack.metadata.id))
              continue;
            const idx = await pack.getIndex({ fields: ['type'] });
            const hit = idx.find(e => e.type === 'class' && e.name === arg.className);
            if (hit) {
              doc = await pack.getDocument(hit._id);
              break;
            }
          }
          if (!doc) {
            note('find', new Error(`no ${arg.className}`));
            return out;
          }
          try {
            await game.settings.set('dnd5e', 'disableAdvancements', true);
          } catch {}

          // Build on a temp actor: embed class, flag it original (so HP applies), apply L1 advancements.
          const tmp = await globalThis.Actor.create({
            name: `${arg.tag} BUILD`,
            type: 'character',
          });
          out.tempId = tmp.id;
          const cdata = doc.toObject();
          delete cdata._id;
          cdata.system = cdata.system || {};
          cdata.system.levels = 1;
          const [cls] = await tmp.createEmbeddedDocuments('Item', [cdata]);
          tmp.updateSource({ 'system.details.originalClass': cls.id });

          const byType = cls.advancement?.byType || {};
          const todo = [];
          for (const [, arr] of Object.entries(byType)) {
            for (const a of arr) {
              const levels = a.levels ?? (a.level != null ? [a.level] : []);
              if (levels.includes(1)) todo.push(a);
            }
          }
          for (const a of todo) {
            try {
              await a.apply(1, {}, { initial: true });
            } catch (e) {
              note(`apply:${a.title}`, e);
            }
          }

          // In-memory snapshot of the fully-built actor (_source mutated by updateSource).
          out.inMemory.itemCount = tmp.items.size;
          out.inMemory.featureItems = tmp.items.filter(i => i.type === 'feat').map(i => i.name);
          out.inMemory.hp = tmp.system?.attributes?.hp?.value ?? tmp.system?.attributes?.hp?.max;

          // PERSIST: snapshot the built _source and create a real actor from it (one DB write,
          // embedded items and all — mirrors what the Manager's #complete does, sans UI).
          const built = tmp.toObject();
          delete built._id;
          built.name = `${arg.tag} BUILT`;
          const real = await globalThis.Actor.create(built);
          out.builtId = real.id;

          // Re-fetch FRESH and verify everything survived the DB round-trip.
          const fresh = game.actors.get(real.id);
          fresh.reset?.();
          out.persisted.itemCount = fresh.items.size;
          out.persisted.featureItems = fresh.items.filter(i => i.type === 'feat').map(i => i.name);
          out.persisted.hp = fresh.system?.attributes?.hp?.value;
          const rd = fresh.getRollData();
          out.persisted.sneakAttack = globalThis.Roll.replaceFormulaData(
            '@scale.rogue.sneak-attack',
            rd,
            { missing: '0', warn: false }
          );
        } catch (e) {
          note('buildC', e);
        }
        return out;
      },
      { tag: TAG, className: 'Rogue' }
    ),
    120_000,
    'evalC(build+persist)'
  );
  if (evalC?.tempId) createdActorIds.push(evalC.tempId);
  if (evalC?.builtId) createdActorIds.push(evalC.builtId);
  console.log('\n===== EVAL C — build + persist loop =====');
  console.log(JSON.stringify(evalC, null, 2));
  console.log('=========================================\n');

  // --- Assertions (intel-gathering) ---
  assert(
    (evalA?.advRegistry?.length ?? 0) > 0,
    `advancement registry discovered [${(evalA?.advRegistry || []).join(', ')}]`
  );
  assert(!!evalA?.classMaps?.Rogue, 'Rogue advancement-by-level map captured');
  assert(
    (evalB?.applied?.length ?? 0) > 0,
    `attempted apply() on ${evalB?.applied?.length ?? 0} level-1 advancement(s)`
  );
  const anyApplied = (evalB?.applied || []).some(r => r.result === 'applied');
  assert(
    anyApplied,
    `at least one advancement.apply() succeeded headless (results: ${(evalB?.applied || []).map(r => `${r.type}=${r.result}`).join(' | ')})`
  );
  const grantedN = evalC?.persisted?.featureItems?.length ?? 0;
  assert(
    grantedN > 0,
    `Eval C: class features GRANTED + PERSISTED via apply({initial:true}) + snapshot+create (${grantedN}: ${(evalC?.persisted?.featureItems || []).join(', ') || 'NONE'})`
  );
  const sa = evalC?.persisted?.sneakAttack;
  assert(
    sa != null && String(sa) !== '0' && !/@scale/.test(String(sa)),
    `Eval C: @scale resolves on the PERSISTED PC (@scale.rogue.sneak-attack -> ${JSON.stringify(sa)})`
  );
} catch (e) {
  fails++;
  console.log(`\n[spike-adv3] FATAL: ${e?.message || String(e)}`);
} finally {
  const ids = [...createdActorIds, `${TAG} APPLY`, `${TAG} BUILD`, `${TAG} BUILT`];
  try {
    await withNodeTimeout(
      f.call('deleteActor', { identifiers: ids, removeEmptyFolder: true }),
      30_000,
      'cleanup'
    );
    console.log('[spike-adv3] cleanup attempted');
  } catch (e) {
    console.log(`[spike-adv3] cleanup note: ${e?.message || e}`);
  }
  await f.dispose?.();
}

console.log(`\n==== advancement-choices spike (run 3): ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
