// Spike: compendium-lookup overhaul ground truth (READ-ONLY).
// Confirms, against the live `sandbox` world:
//   1) pack inventory  -> the suffix conventions the need->pack resolver relies on
//   2) creature index fields -> what getIndex({fields}) actually populates on an NPC actor pack
//   3) dnd5e CompendiumBrowser.fetch + Filter -> exists? headless? honors SRD source exclusion?
//   4) spell facets + two-stage damage -> where spell damage type lives
// Standalone (no project deps): hand-parses .env, uses only playwright. Mirrors spike-headless.mjs.
// Run: node scripts/spike-compendium-lookup.mjs
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
    await page.goto(MAGIC, { waitUntil: 'domcontentloaded' }).catch(e => log('magic nav note:', e.message));
  }

  log('navigating to /join ...');
  let joined = false;
  for (let attempt = 1; attempt <= 12 && !joined; attempt++) {
    await page.goto(`${BASE}/join`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    // The join form is JS-rendered after domcontentloaded — wait for it, don't race it.
    const found = await page.waitForSelector('select[name="userid"]', { timeout: 8000 }).then(() => true).catch(() => false);
    log(`  attempt ${attempt}: url=${page.url()} title="${await page.title().catch(() => '?')}" userid=${found}`);
    if (found) { joined = true; break; }
    await page.waitForTimeout(3000);
  }
  if (!joined) {
    const diag = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyClass: document.body?.className,
      selects: [...document.querySelectorAll('select')].map(s => s.name || s.id || '(unnamed)'),
      inputs: [...document.querySelectorAll('input')].map(i => i.name || i.type),
      buttons: [...document.querySelectorAll('button, a.button')].map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 12),
      forms: [...document.querySelectorAll('form')].map(f => f.id || f.name || f.action || '(form)'),
      bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    })).catch(e => ({ error: String(e?.message || e) }));
    log('JOIN DIAG: ' + JSON.stringify(diag, null, 2));
    throw new Error('No /join userid form — see JOIN DIAG above.');
  }

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
  const ready = await Promise.race([
    page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120_000 }).then(() => 'ready'),
    (async () => {
      for (let i = 0; i < 60; i++) {
        const errs = await page.evaluate(() =>
          [...document.querySelectorAll('.notification.error, p.error')].map(e => e.textContent?.trim()).filter(Boolean)
        ).catch(() => []);
        if (errs.length) return 'error:' + errs.join(' | ');
        await page.waitForTimeout(2000);
      }
      return 'timeout';
    })(),
  ]);
  if (ready !== 'ready') throw new Error(`Join did not reach game.ready: ${ready}`);

  log('game.ready — running probes...');

  const probe = await page.evaluate(async () => {
    const out = {};
    const safe = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: String(e?.message || e) }; } };
    const packIdFromUuid = uuid => {
      // "Compendium.<scope>.<packname>.<DocType>.<id>" -> "<scope>.<packname>"
      const p = (uuid || '').split('.');
      return p[0] === 'Compendium' && p.length >= 3 ? `${p[1]}.${p[2]}` : null;
    };

    out.world = { world: game.world?.id, system: game.system?.id, systemVersion: game.system?.version, foundry: game.version };

    // 1) PACK INVENTORY ------------------------------------------------------
    await safe('packs', () =>
      Array.from(game.packs.values()).map(p => ({
        id: p.metadata.id,
        type: p.metadata.type,
        label: p.metadata.label,
        system: p.metadata.system,
      }))
    );

    // 2) CREATURE INDEX-FIELD PROBE -----------------------------------------
    await safe('creatureIndex', async () => {
      const pack = game.packs.get('dnd-monster-manual.actors');
      if (!pack) return { error: 'dnd-monster-manual.actors not found', actorPacks: Array.from(game.packs.values()).filter(p => p.metadata.type === 'Actor').map(p => p.metadata.id) };
      const fields = [
        'system.details.cr', 'system.details.type.value', 'system.details.type.subtype', 'system.details.type.swarm',
        'system.traits.size', 'system.attributes.hp.max', 'system.attributes.ac.flat', 'system.attributes.ac.calc',
        'system.attributes.ac.value', 'system.attributes.spell.level', 'system.resources.legact.max',
        'system.details.alignment', 'system.source.book', 'system.source',
      ];
      const idx = await pack.getIndex({ fields });
      const sample = Array.from(idx.values()).filter(e => e.type === 'npc').slice(0, 4).map(e => ({
        name: e.name, type: e.type, img: e.img,
        cr: e.system?.details?.cr, ctype: e.system?.details?.type?.value,
        subtype: e.system?.details?.type?.subtype, swarm: e.system?.details?.type?.swarm,
        size: e.system?.traits?.size, hpMax: e.system?.attributes?.hp?.max,
        acFlat: e.system?.attributes?.ac?.flat, acCalc: e.system?.attributes?.ac?.calc,
        acValue: e.system?.attributes?.ac?.value, // expect UNDEFINED (derived)
        spellLevel: e.system?.attributes?.spell?.level, legactMax: e.system?.resources?.legact?.max,
        alignment: e.system?.details?.alignment, source: e.system?.source,
      }));
      const total = Array.from(idx.values()).filter(e => e.type === 'npc').length;
      const alignmentFilled = Array.from(idx.values()).filter(e => e.type === 'npc' && e.system?.details?.alignment).length;
      return { fieldsRequested: fields, npcCount: total, alignmentFilled, sample };
    });

    // 3) COMPENDIUM BROWSER API ---------------------------------------------
    await safe('browserApi', () => ({
      hasFetch: typeof dnd5e?.applications?.CompendiumBrowser?.fetch === 'function',
      hasFilter: typeof dnd5e?.Filter?.performCheck === 'function',
      hasFilterUniqueKeys: typeof dnd5e?.Filter?.uniqueKeys === 'function',
      dnd5eKeys: dnd5e ? Object.keys(dnd5e) : null,
    }));

    await safe('browserFacets', () => {
      const grab = dm => {
        try {
          const f = dm?.compendiumBrowserFilters;
          const m = typeof f === 'function' ? f.call(dm) : f;
          if (m instanceof Map) return Array.from(m.entries()).map(([k, v]) => ({ key: k, type: v?.type, keyPath: v?.config?.keyPath || v?.keyPath }));
          return m ? Object.keys(m) : null;
        } catch (e) { return { error: String(e?.message || e) }; }
      };
      return {
        npc: grab(CONFIG.Actor?.dataModels?.npc),
        spell: grab(CONFIG.Item?.dataModels?.spell),
      };
    });

    await safe('browserFetchNpc', async () => {
      const CB = dnd5e?.applications?.CompendiumBrowser;
      if (!CB?.fetch) return { skipped: 'no fetch' };
      const res = await CB.fetch(CONFIG.Actor.documentClass, {
        types: new Set(['npc']),
        filters: [{ k: 'system.details.cr', o: 'gte', v: 5 }, { k: 'system.details.cr', o: 'lte', v: 8 }],
        index: true,
      });
      const arr = Array.from(res ?? []);
      const byPack = {};
      for (const e of arr) { const pk = packIdFromUuid(e.uuid) || 'unknown'; byPack[pk] = (byPack[pk] || 0) + 1; }
      const srd = Object.keys(byPack).filter(k => k.startsWith('dnd5e.'));
      return {
        count: arr.length,
        byPack,
        srdPacksPresent: srd,
        sample: arr.slice(0, 3).map(e => ({ name: e.name, cr: e.system?.details?.cr, uuid: e.uuid })),
      };
    });

    await safe('browserFetchSpell', async () => {
      const CB = dnd5e?.applications?.CompendiumBrowser;
      if (!CB?.fetch) return { skipped: 'no fetch' };
      const res = await CB.fetch(CONFIG.Item.documentClass, {
        types: new Set(['spell']),
        filters: [{ k: 'system.level', o: 'lte', v: 3 }, { k: 'system.school', o: 'in', v: ['evo'] }],
        index: true,
      });
      const arr = Array.from(res ?? []);
      const byPack = {};
      for (const e of arr) { const pk = packIdFromUuid(e.uuid) || 'unknown'; byPack[pk] = (byPack[pk] || 0) + 1; }
      const srd = Object.keys(byPack).filter(k => k.startsWith('dnd5e.'));
      return {
        count: arr.length,
        byPack,
        srdPacksPresent: srd,
        sample: arr.slice(0, 3).map(e => ({ name: e.name, level: e.system?.level, school: e.system?.school, uuid: e.uuid })),
      };
    });

    // 3b) getIndex CACHING — does requesting fields AFTER a default getIndex populate them? -----
    // Mirrors the live bundle: searchCompendium calls getIndex({}) (no system fields); our creature
    // path then calls getIndex({fields}) on the SAME pack. Confirm the second call is not served a
    // stale, field-less cache.
    await safe('getIndexCaching', async () => {
      const pack = game.packs.get('dnd-monster-manual.actors');
      if (!pack) return { error: 'dnd-monster-manual.actors not found' };
      await pack.getIndex({}); // prime the default (field-less) index first
      const idx = await pack.getIndex({ fields: ['system.details.cr', 'system.traits.size'] });
      const e = Array.from(idx.values()).find(x => x.type === 'npc');
      return {
        afterDefaultThenFields: {
          name: e?.name,
          cr: e?.system?.details?.cr,
          size: e?.system?.traits?.size,
          populated: e?.system?.details?.cr !== undefined && e?.system?.traits?.size !== undefined,
        },
      };
    });

    // 4) TWO-STAGE SPELL DAMAGE ---------------------------------------------
    await safe('spellDamageShape', async () => {
      const pack = game.packs.get('dnd-players-handbook.spells');
      if (!pack) return { error: 'dnd-players-handbook.spells not found', itemPacks: Array.from(game.packs.values()).filter(p => p.metadata.type === 'Item').map(p => p.metadata.id) };
      if (!pack.indexed) await pack.getIndex({});
      const entry = Array.from(pack.index.values()).find(e => /fireball/i.test(e.name || ''));
      if (!entry) return { note: 'no Fireball in PHB spells index', sampleNames: Array.from(pack.index.values()).slice(0, 5).map(e => e.name) };
      const doc = await pack.getDocument(entry._id);
      const src = doc.toObject();
      const acts = src.system?.activities || {};
      const damage = Object.values(acts).map(a => ({
        type: a.type,
        parts: (a.damage?.parts || []).map(pt => ({ types: pt.types, formula: pt.number ? `${pt.number}d${pt.denomination}` : pt.custom?.formula })),
      }));
      return { spell: doc.name, level: src.system?.level, school: src.system?.school, activityDamage: damage };
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
