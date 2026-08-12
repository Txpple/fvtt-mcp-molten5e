// Spike for fvtt-mod-partystash v1.3 (deposit/withdraw coin window).
//
// Reconnaissance only — writes nothing. Answers the questions the dialog design needs:
//   1. What class is the dnd5e GROUP sheet, and which `render<Class>` hooks fire for it
//      (ApplicationV2 fires one per class in the prototype chain)?
//   2. Where does the currency row live in the rendered group sheet DOM — selector, markup,
//      and what sits next to it that a button could join?
//   3. Same for a CHARACTER (member) sheet.
//   4. Does dnd5e already ship a currency dialog we should reuse or deliberately not reuse
//      (CurrencyManager)? What is its API surface?
//   5. Which ApplicationV2 / DialogV2 classes are available to build on.
//
// Run: node scripts/spike-group-currency-dom.mjs
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

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const show = (label, value) => {
  console.log(`\n===== ${label} =====`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

try {
  console.log('[spike] connecting…');
  await f.connect();

  // --- 1/4/5. static surface ------------------------------------------------------------------
  const statics = await f.evaluate(() => {
    const out = {};
    out.versions = {
      foundry: game.version,
      dnd5e: game.system.version,
    };
    const group = game.actors.find(a => a.type === 'group');
    out.group = group ? { id: group.id, name: group.name, currency: group.system.currency } : null;

    // The sheet class + every `render<Name>` hook ApplicationV2 will fire for it.
    if (group) {
      const chain = [];
      let c = group.sheet.constructor;
      while (c && c.name) {
        chain.push(c.name);
        c = Object.getPrototypeOf(c);
      }
      out.groupSheetChain = chain;
      out.groupSheetParts = Object.keys(group.sheet.constructor.PARTS ?? {});
      out.groupSheetTabs = group.sheet.constructor.TABS ?? null;
    }

    const pc = game.actors.find(a => a.type === 'character');
    if (pc) {
      const chain = [];
      let c = pc.sheet.constructor;
      while (c && c.name) {
        chain.push(c.name);
        c = Object.getPrototypeOf(c);
      }
      out.pc = { id: pc.id, name: pc.name, currency: pc.system.currency };
      out.pcSheetChain = chain;
      out.pcSheetParts = Object.keys(pc.sheet.constructor.PARTS ?? {});
    }

    // Does dnd5e ship a currency dialog already?
    const apps = dnd5e?.applications ?? {};
    const findCurrency = (obj, path = 'dnd5e.applications', depth = 0) => {
      const hits = [];
      if (depth > 3 || !obj) return hits;
      for (const [k, v] of Object.entries(obj)) {
        if (/currenc/i.test(k)) hits.push(`${path}.${k} (${typeof v})`);
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          hits.push(...findCurrency(v, `${path}.${k}`, depth + 1));
        }
      }
      return hits;
    };
    out.currencyClasses = findCurrency(apps);
    const CM = apps.CurrencyManager ?? apps.actor?.CurrencyManager;
    out.currencyManager = CM
      ? {
          name: CM.name,
          statics: Object.getOwnPropertyNames(CM).filter(
            n => !['length', 'name', 'prototype'].includes(n)
          ),
          protoMethods: Object.getOwnPropertyNames(CM.prototype ?? {}),
          defaultOptions: CM.DEFAULT_OPTIONS ?? null,
          parts: Object.keys(CM.PARTS ?? {}),
        }
      : null;

    out.appV2 = {
      ApplicationV2: !!foundry.applications?.api?.ApplicationV2,
      DialogV2: !!foundry.applications?.api?.DialogV2,
      HandlebarsApplicationMixin: !!foundry.applications?.api?.HandlebarsApplicationMixin,
    };
    out.currencyConfig = Object.fromEntries(
      Object.entries(CONFIG.DND5E?.currencies ?? {}).map(([k, v]) => [
        k,
        { label: v.label, abbreviation: v.abbreviation, conversion: v.conversion },
      ])
    );
    return out;
  }, null);
  show('statics', statics);

  // --- 2/3. rendered DOM ----------------------------------------------------------------------
  const dom = await f.evaluate(
    async ({ groupId, pcId }) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const out = {};

      const probe = async (actorId, label) => {
        const actor = game.actors.get(actorId);
        if (!actor) return { error: `no actor ${actorId}` };
        const sheet = actor.sheet;
        await sheet.render({ force: true });
        await sleep(1500);
        const root = sheet.element;
        const info = { classes: root.className, id: root.id };

        // Anything that smells like currency in the rendered markup.
        const sel = [
          '.currency',
          '[class*="currenc"]',
          '[data-tab="inventory"] .currency',
          'input[name*="currency"]',
          '[data-action*="currency"]',
          '[data-action*="Currency"]',
        ];
        info.matches = {};
        for (const s of sel) {
          const els = [...root.querySelectorAll(s)];
          info.matches[s] = els.length;
        }

        // Dump the outerHTML of the nearest currency container, trimmed.
        const cur =
          root.querySelector('.currency') ??
          root.querySelector('[class*="currenc"]') ??
          root.querySelector('input[name*="currency"]')?.closest('div,section,ul,fieldset');
        if (cur) {
          info.currencyTag = cur.tagName;
          info.currencyClass = cur.className;
          info.currencyHTML = cur.outerHTML.slice(0, 4000);
          info.currencyParentTag = cur.parentElement?.tagName;
          info.currencyParentClass = cur.parentElement?.className;
          info.currencyPrevSibling = cur.previousElementSibling
            ? `${cur.previousElementSibling.tagName}.${cur.previousElementSibling.className}`
            : null;
          info.currencyNextSibling = cur.nextElementSibling
            ? `${cur.nextElementSibling.tagName}.${cur.nextElementSibling.className}`
            : null;
          // Which template PART does it belong to?
          const part = cur.closest('[data-application-part]');
          info.currencyPart = part?.dataset?.applicationPart ?? null;
        } else {
          info.currencyHTML = null;
          // Fall back: list the tabs/sections present so we know where to look.
          info.tabs = [...root.querySelectorAll('[data-tab]')].map(
            e => `${e.tagName}.${e.className}[data-tab=${e.dataset.tab}]`
          );
        }

        // The inventory tab's top-of-list controls — the natural home for a button.
        const inv = root.querySelector('[data-tab="inventory"]');
        if (inv) {
          info.inventoryFirstChildren = [...inv.children]
            .slice(0, 8)
            .map(e => `${e.tagName}.${e.className}`);
          const controls = inv.querySelector(
            '.inventory-header, .header, .filter-row, .controls, item-list-controls, .top'
          );
          info.inventoryControls = controls
            ? `${controls.tagName}.${controls.className}`
            : null;
          info.inventoryControlsHTML = controls ? controls.outerHTML.slice(0, 2000) : null;
        }

        await sheet.close();
        return info;
      };

      out.group = await probe(groupId, 'group');
      out.pc = await probe(pcId, 'pc');
      return out;
    },
    { groupId: statics.group?.id, pcId: statics.pc?.id }
  );
  show('group sheet DOM', dom.group);
  show('character sheet DOM', dom.pc);
} catch (e) {
  console.error('[spike] ERROR:', e?.stack || e);
  process.exitCode = 1;
} finally {
  await f.dispose();
}
