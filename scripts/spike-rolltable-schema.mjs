// Spike: v14 RollTable / TableResult schema ground truth (READ-ONLY).
// Confirms, against the live `sandbox` world (Foundry 14.364, dnd5e 5.3.3):
//   1) RollTable + TableResult schema field keys -> is `text` deprecated in favour of `description`?
//   2) CONST.TABLE_RESULT_TYPES -> string vs numeric `type` enum in v14
//   3) DMG treasure/magic-item tables -> do they use NATIVE document results (documentUuid) or
//      TEXT results with an inline @UUID[...] link in the description? (decides our result model)
//   4) A live .roll() on a DMG table -> what a drawn result resolves to (text/description/documentUuid)
// Standalone (no project deps): hand-parses .env, uses only playwright. Mirrors spike-compendium-lookup.mjs.
// Run: node scripts/spike-rolltable-schema.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const txt = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const BASE = env.MOLTEN_SERVER_URL?.replace(/\/$/, '');
const MAGIC = env.MOLTEN_MAGIC_URL;
const USER = env.FOUNDRY_USER || 'Claude';
if (!BASE) throw new Error('MOLTEN_SERVER_URL missing from .env');

const log = (...a) => console.log('[spike]', ...a);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.setDefaultTimeout(120_000);
let ok = false;

try {
  if (MAGIC) {
    log('waking via Magic URL...');
    await page
      .goto(MAGIC, { waitUntil: 'domcontentloaded' })
      .catch(e => log('magic nav note:', e.message));
  }

  log('navigating to /join ...');
  let joined = false;
  for (let attempt = 1; attempt <= 12 && !joined; attempt++) {
    await page.goto(`${BASE}/join`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const found = await page
      .waitForSelector('select[name="userid"]', { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    log(`  attempt ${attempt}: url=${page.url()} userid=${found}`);
    if (found) {
      joined = true;
      break;
    }
    await page.waitForTimeout(3000);
  }
  if (!joined) throw new Error('No /join userid form.');

  log(`selecting user "${USER}" and joining...`);
  await page.evaluate(label => {
    const sel = document.querySelector('select[name="userid"]');
    const opt = [...sel.options].find(o => o.textContent?.trim() === label);
    if (!opt) throw new Error(`user "${label}" not in dropdown`);
    opt.disabled = false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, USER);
  await page.locator('button[name="join"], button[type="submit"]').first().click();

  log('waiting for game.ready ...');
  const ready = await page
    .waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120_000 })
    .then(() => 'ready')
    .catch(() => 'timeout');
  if (ready !== 'ready') throw new Error(`Join did not reach game.ready: ${ready}`);

  log('game.ready — running probes...');

  const probe = await page.evaluate(async () => {
    const out = {};
    const safe = async (name, fn) => {
      try {
        out[name] = await fn();
      } catch (e) {
        out[name] = { error: String(e?.message || e) };
      }
    };

    out.world = {
      system: game.system?.id,
      systemVersion: game.system?.version,
      foundry: game.version,
    };

    // 1) SCHEMA FIELD KEYS ---------------------------------------------------
    await safe('schema', () => {
      const RT = CONFIG.RollTable?.documentClass;
      const TR = CONFIG.TableResult?.documentClass;
      const fieldInfo = schema => {
        const fields = schema?.fields || {};
        return Object.fromEntries(
          Object.keys(fields).map(k => {
            const f = fields[k];
            return [
              k,
              {
                type: f?.constructor?.name,
                required: f?.required,
                hasDefault: f?.initial !== undefined,
                deprecated: !!(f?.options?.deprecated || f?.deprecated),
              },
            ];
          })
        );
      };
      return {
        rollTableFields: fieldInfo(RT?.schema),
        tableResultFields: fieldInfo(TR?.schema),
        TABLE_RESULT_TYPES: CONST?.TABLE_RESULT_TYPES,
      };
    });

    // 2) DMG TABLES PACK INDEX ----------------------------------------------
    await safe('dmgTablesIndex', async () => {
      const pack = game.packs.get('dnd-dungeon-masters-guide.tables');
      if (!pack) return { error: 'dnd-dungeon-masters-guide.tables not found' };
      const idx = await pack.getIndex({});
      const entries = Array.from(idx.values()).map(e => ({ id: e._id, name: e.name }));
      return { count: entries.length, entries };
    });

    // 3) RESULT SHAPE ACROSS THE WHOLE DMG TABLES PACK -----------------------
    // Read every table's documents, tally result `type` values, and capture how
    // document-bearing results are encoded (native documentUuid vs @UUID-in-text).
    await safe('resultShapes', async () => {
      const pack = game.packs.get('dnd-dungeon-masters-guide.tables');
      if (!pack) return { error: 'pack missing' };
      const docs = await pack.getDocuments();
      const typeTally = {};
      const fieldPresence = {}; // which _source keys appear on results, across the pack
      const samplesWithDocLink = [];
      const samplesTextOnly = [];
      const uuidInTextCount = { yes: 0, no: 0 };

      for (const table of docs) {
        for (const r of table.results?.contents ?? []) {
          let src;
          try {
            src = r?.toObject?.();
          } catch (e) {
            typeTally[`<toObject-threw:${String(e?.message || e)}>`] =
              (typeTally['<toObject-threw>'] || 0) + 1;
            continue;
          }
          if (!src) {
            typeTally['<null-source>'] = (typeTally['<null-source>'] || 0) + 1;
            continue;
          }
          const t = String(src.type);
          typeTally[t] = (typeTally[t] || 0) + 1;
          for (const k of Object.keys(src)) fieldPresence[k] = (fieldPresence[k] || 0) + 1;

          const descText = src.description ?? src.text ?? '';
          const hasUuidInText = /@UUID\[/.test(descText);
          uuidInTextCount[hasUuidInText ? 'yes' : 'no']++;

          const hasNativeDoc = !!(src.documentUuid || src.documentId || src.documentCollection);
          if ((hasNativeDoc || hasUuidInText) && samplesWithDocLink.length < 6) {
            samplesWithDocLink.push({
              table: table.name,
              source: src,
              live: {
                type: r.type,
                text: r.text,
                description: r.description,
                documentUuid: r.documentUuid,
                documentCollection: r.documentCollection,
                documentId: r.documentId,
              },
            });
          } else if (!hasNativeDoc && !hasUuidInText && samplesTextOnly.length < 3) {
            samplesTextOnly.push({ table: table.name, source: src });
          }
        }
      }
      return {
        tableCount: docs.length,
        typeTally,
        resultSourceFieldPresence: fieldPresence,
        uuidInTextCount,
        samplesWithDocLink,
        samplesTextOnly,
      };
    });

    // 4) ONE FULL TABLE toObject() ------------------------------------------
    await safe('oneTableFull', async () => {
      const pack = game.packs.get('dnd-dungeon-masters-guide.tables');
      const docs = await pack.getDocuments();
      // Prefer a table that looks like a magic-item/treasure table.
      const table =
        docs.find(d => /magic item|treasure|arcana|armaments|implements|relics/i.test(d.name)) ||
        docs[0];
      const src = table.toObject();
      return {
        name: table.name,
        topLevelKeys: Object.keys(src),
        description: src.description,
        formula: src.formula,
        replacement: src.replacement,
        displayRoll: src.displayRoll,
        img: src.img,
        firstThreeResults: (src.results || []).slice(0, 3),
      };
    });

    // 5) LIVE ROLL on a DMG table -------------------------------------------
    await safe('liveRoll', async () => {
      const pack = game.packs.get('dnd-dungeon-masters-guide.tables');
      const docs = await pack.getDocuments();
      const table =
        docs.find(d => /magic item|treasure|arcana|armaments|implements|relics/i.test(d.name)) ||
        docs[0];
      const { roll, results } = await table.roll();
      return {
        table: table.name,
        formula: table.formula,
        total: roll?.total,
        drawn: (results ?? []).map(r => ({
          type: r.type,
          text: r.text,
          description: r.description,
          documentUuid: r.documentUuid,
          name: r.name, // v13+ may expose a resolved name
        })),
      };
    });

    return out;
  });

  log('PROBE RESULT:\n' + JSON.stringify(probe, null, 2));
  ok = true;
} catch (err) {
  log('SPIKE FAILED:', err?.message || err);
} finally {
  await browser.close();
  log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}
