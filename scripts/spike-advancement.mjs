// Phase-5 make-or-break spike (run 2): does @scale RESOLVE natively on a headless PC?
//
// The §7 PC crux: a real PC (type:character) should resolve class `@scale.*` damage/uses NATIVELY
// (unlike an NPC, where they dangle to 0 and we hand-patch). ScaleValue advancement is DETERMINISTIC
// (level→value, no user choice), so the cheap hypothesis is:
//
//   H1 — just embed the class item + set its level (NO AdvancementManager). If getRollData().scale
//        populates and a `@scale.<class>.<key>` formula resolves to a real die, then @scale is
//        DECOUPLED from the (hard) Manager-completion problem — a major PC-builder simplification.
//
// Run-1 wedged INSIDE AdvancementManager.forNewItem(...) (its close()/render path hangs headless).
// So run 2: (a) isolate H1 in its own page-eval with a NODE-SIDE timeout backstop so the answer
// always returns; (b) do NOT invoke forNewItem — only STATICALLY inspect it (toString/arity/async),
// which cannot hang, to inform a safe completion approach later. forNewItem headless-completion is a
// SEPARATE, later concern (choice-based advancement: subclass/ASI/skills), not the @scale make-or-break.
//
// Build first: npm run build. Run: node scripts/spike-advancement.mjs
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

const TAG = 'ZZ-ADV-SPIKE';
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

// Node-side timeout backstop: page.evaluate has NO timeout, so a wedged in-page await would hang
// forever (run-1 ran 30+ min). Bound every page round-trip here instead.
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

let report = null;

try {
  console.log('[spike-adv] connecting to sandbox…');
  await f.connect();
  console.log('[spike-adv] connected\n');

  report = await withNodeTimeout(
    f.evaluate(
      async arg => {
        const out = { env: {}, classDoc: null, h1: {}, amInspect: {}, errors: [] };
        const note = (where, e) => out.errors.push(`${where}: ${e?.message || e}`);
        const game = globalThis.game;
        const dnd5e = globalThis.dnd5e;

        // --- Probe 0: env + SAFE static inspection of forNewItem (no invocation) ---
        try {
          const AM = dnd5e?.applications?.advancement?.AdvancementManager;
          out.env.dnd5eVersion = game?.system?.version;
          out.env.hasAdvancementManager = !!AM;
          out.amInspect = {
            forNewItemType: typeof AM?.forNewItem,
            forNewItemIsAsync: AM?.forNewItem?.constructor?.name === 'AsyncFunction',
            forNewItemArity: AM?.forNewItem?.length ?? null,
            forNewItemSrc: AM?.forNewItem?.toString?.().slice(0, 1500) ?? null,
            protoMethods: AM
              ? Object.getOwnPropertyNames(AM.prototype || {}).filter(n => n !== 'constructor')
              : [],
          };
        } catch (e) {
          note('probe0', e);
        }

        // Defensive: suppress the auto-advancement prompt that a class-drop can launch.
        try {
          await game.settings.set('dnd5e', 'disableAdvancements', true);
          out.env.disabledAdvancements = true;
        } catch (e) {
          out.env.disabledAdvancements = `n/a (${e?.message || e})`;
        }

        // --- Find a premium-PHB class with a level-1 @scale (Rogue=Sneak Attack is the classic) ---
        let classDoc = null;
        try {
          for (const pack of game.packs) {
            if (pack.documentName !== 'Item') continue;
            if (!/dnd-players-handbook/.test(pack.metadata.id)) continue;
            const idx = await pack.getIndex({ fields: ['type'] });
            const hit = idx.find(e => e.type === 'class' && arg.classNames.includes(e.name));
            if (hit) {
              classDoc = await pack.getDocument(hit._id);
              out.classDoc = { packId: pack.metadata.id, name: classDoc.name, id: classDoc.id };
              break;
            }
          }
          if (!classDoc) {
            note('find-class', new Error(`no class in ${arg.classNames.join('/')} in PHB packs`));
          } else {
            const adv = classDoc.advancement;
            out.classDoc.identifier = classDoc.system?.identifier;
            out.classDoc.advancementTypes = adv?.byType
              ? Object.fromEntries(Object.entries(adv.byType).map(([k, v]) => [k, v.length]))
              : null;
            out.classDoc.scaleValues = (adv?.byType?.ScaleValue ?? []).map(a => ({
              identifier: a.identifier ?? a.configuration?.identifier,
              title: a.title,
            }));
          }
        } catch (e) {
          note('find-class', e);
        }

        // --- H1: embed-only. Does @scale resolve with NO Manager run? ---
        try {
          if (classDoc) {
            const a1 = await globalThis.Actor.create({ name: `${arg.tag} H1`, type: 'character' });
            out.h1.actorId = a1.id;

            const classData = classDoc.toObject();
            delete classData._id;
            classData.system = classData.system || {};
            classData.system.levels = 1;
            const [emb] = await a1.createEmbeddedDocuments('Item', [classData]);
            out.h1.classItemId = emb?.id;
            out.h1.classLevels = emb?.system?.levels;
            out.h1.classIdentifier = emb?.system?.identifier;

            const a1f = game.actors.get(a1.id);
            a1f.reset?.(); // force a fresh prepareData so scale is current
            const rd = a1f.getRollData();
            const scale = rd?.scale || {};
            out.h1.totalLevel = rd?.details?.level ?? a1f.system?.details?.level;
            out.h1.scaleKeys = Object.keys(scale);
            out.h1.scaleDump = {};
            for (const k of out.h1.scaleKeys) {
              out.h1.scaleDump[k] = {};
              for (const sk of Object.keys(scale[k] || {})) {
                const v = scale[k][sk];
                out.h1.scaleDump[k][sk] =
                  v && typeof v === 'object'
                    ? (v.formula ?? v.number ?? v.value ?? JSON.stringify(v))
                    : v;
              }
            }
            // Resolve a @scale formula end-to-end (the make-or-break check).
            const ck = out.h1.classIdentifier || out.h1.scaleKeys[0];
            const sk = scale[ck] ? Object.keys(scale[ck])[0] : null;
            if (ck && sk) {
              const formula = `@scale.${ck}.${sk}`;
              out.h1.testFormula = formula;
              try {
                out.h1.replaced = globalThis.Roll.replaceFormulaData(formula, rd, {
                  missing: '0',
                  warn: false,
                });
              } catch (e) {
                note('h1-replace', e);
              }
            }
          }
        } catch (e) {
          note('h1', e);
        }

        // Restore the setting we toggled.
        try {
          await game.settings.set('dnd5e', 'disableAdvancements', false);
        } catch {}

        return out;
      },
      { tag: TAG, classNames: ['Rogue', 'Monk', 'Barbarian', 'Fighter'] }
    ),
    90_000,
    'H1 evaluate'
  );

  console.log('\n===== ADVANCEMENT SPIKE REPORT (run 2: H1 + static forNewItem inspect) =====');
  console.log(JSON.stringify(report, null, 2));
  console.log('===========================================================================\n');

  assert(report.env?.hasAdvancementManager === true, 'AdvancementManager namespace present');
  assert(
    !!report.classDoc,
    `found a PHB class (${report.classDoc?.name ?? '—'}, id=${report.classDoc?.identifier ?? '?'})`
  );
  assert(
    (report.classDoc?.scaleValues?.length ?? 0) > 0,
    `class carries ScaleValue advancement(s): ${(report.classDoc?.scaleValues || []).map(s => s.identifier).join(', ') || 'NONE'}`
  );
  const h1Keys = report.h1?.scaleKeys || [];
  assert(
    h1Keys.length > 0,
    `H1 embed-only: getRollData().scale populated [${h1Keys.join(', ') || 'EMPTY'}]`
  );
  const replaced = report.h1?.replaced;
  const resolved =
    replaced != null &&
    !/@scale/.test(String(replaced)) &&
    String(replaced) !== '0' &&
    String(replaced) !== '';
  assert(
    resolved,
    `H1 @scale RESOLVES headlessly: ${report.h1?.testFormula} -> ${JSON.stringify(replaced)}`
  );
} catch (e) {
  fails++;
  console.log(`\n[spike-adv] FATAL: ${e?.message || String(e)}`);
} finally {
  // Clean up by exact TAG names (covers run-1 leftovers too); tolerate not-found.
  try {
    await withNodeTimeout(
      f.call('deleteActor', { identifiers: [`${TAG} H1`, `${TAG} MGR`], removeEmptyFolder: true }),
      30_000,
      'cleanup'
    );
    console.log('[spike-adv] cleanup attempted');
  } catch (e) {
    console.log(`[spike-adv] cleanup note: ${e?.message || e}`);
  }
  await f.dispose?.();
}

console.log(`\n==== advancement spike (run 2): ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
