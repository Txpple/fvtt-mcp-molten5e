// Spike #2 for fvtt-mod-partystash v1.3 — targeted at the GROUP sheet's own purse.
//
// Pass 1 grabbed the first `.currency` on the group sheet, which turned out to be a MEMBER
// ROW pill (`ul.currency.pills` under `.pane`), not the group's purse. This pass anchors on
// the things that can only belong to the purse: `input[name^="system.currency"]` and the
// `[data-action="currency"]` button, and walks UP from them.
//
// Also dumps dnd5e's own CurrencyManager — it ships a "transfer" part, so before Party Stash
// grows its own dialog we need to know exactly what the system already does and why it is
// hard for players to find/use.
//
// Read-only. Run: node scripts/spike-group-currency-dom2.mjs
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
  console.log('[spike2] connecting…');
  await f.connect();

  const out = await f.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const res = {};

    const group = game.actors.find(a => a.type === 'group');
    res.groupName = group?.name;
    res.groupSheetClass = group?.sheet?.constructor?.name;
    // Every `render<Name>` hook ApplicationV2 fires, oldest-first is what Foundry emits.
    const chain = [];
    let c = group?.sheet?.constructor;
    while (c && c.name) {
      chain.push(c.name);
      c = Object.getPrototypeOf(c);
    }
    res.groupSheetChain = chain;
    res.groupSheetParts = Object.keys(group.sheet.constructor.PARTS ?? {});
    res.groupTabs = group.sheet.constructor.TABS ?? null;
    res.groupCurrency = group.system.currency;
    res.groupMembers = group.system.members.map(m => ({
      name: m.actor?.name,
      type: m.actor?.type,
      currency: m.actor?.system?.currency,
    }));

    const sheet = group.sheet;
    await sheet.render({ force: true });
    await sleep(1800);
    const root = sheet.element;

    // Make sure we are on the tab that carries the purse.
    res.tabsPresent = [...root.querySelectorAll('nav [data-tab], .tabs [data-tab]')].map(
      e => e.dataset.tab
    );
    const invTabBtn = root.querySelector(
      'nav [data-tab="inventory"], .tabs [data-tab="inventory"]'
    );
    if (invTabBtn) {
      invTabBtn.click();
      await sleep(900);
    }
    res.rootClassesAfterTab = root.className;

    const describe = el =>
      el
        ? `${el.tagName}${el.id ? '#' + el.id : ''}${
            el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).join('.')
              : ''
          }`
        : null;

    // --- anchor on the purse inputs -----------------------------------------------------
    const inputs = [...root.querySelectorAll('input[name^="system.currency"]')];
    res.purseInputs = inputs.map(i => ({
      name: i.name,
      value: i.value,
      classes: i.className,
      chain: (() => {
        const path = [];
        let e = i;
        for (let d = 0; d < 6 && e; d++) {
          path.push(describe(e));
          e = e.parentElement;
        }
        return path;
      })(),
    }));

    const purse = inputs[0]?.closest('section.currency, .currency, fieldset, div') ?? null;
    res.purseContainer = describe(purse);
    res.purseHTML = purse ? purse.outerHTML.slice(0, 3500) : null;
    res.pursePart = purse?.closest('[data-application-part]')?.dataset?.applicationPart ?? null;
    res.purseParent = describe(purse?.parentElement);
    res.pursePrev = describe(purse?.previousElementSibling);
    res.purseNext = describe(purse?.nextElementSibling);
    // The full parent chain up to the application part — tells us where to inject.
    res.purseAncestry = (() => {
      const path = [];
      let e = purse;
      for (let d = 0; d < 8 && e; d++) {
        path.push(describe(e));
        e = e.parentElement;
      }
      return path;
    })();

    // --- the system's currency button ---------------------------------------------------
    const btn = root.querySelector('[data-action="currency"]');
    res.currencyButton = btn
      ? { html: btn.outerHTML, describe: describe(btn), parent: describe(btn.parentElement) }
      : null;

    // --- what does the group's inventory tab look like at the top? -----------------------
    const invPart = root.querySelector('[data-application-part="inventory"]');
    res.inventoryPartChildren = invPart ? [...invPart.children].slice(0, 10).map(describe) : null;
    const invEl = root.querySelector('dnd5e-inventory');
    res.inventoryElementChildren = invEl ? [...invEl.children].slice(0, 10).map(describe) : null;

    await sheet.close();

    // --- dnd5e's own CurrencyManager ----------------------------------------------------
    const CM = dnd5e.applications.CurrencyManager;
    res.currencyManagerSource = {
      transferCurrency: CM.transferCurrency?.toString().slice(0, 2500),
      deductActorCurrency: CM.deductActorCurrency?.toString().slice(0, 1500),
      getActorCurrencyUpdates: CM.getActorCurrencyUpdates?.toString().slice(0, 2500),
      transferDestinations: Object.getOwnPropertyDescriptor(CM.prototype, 'transferDestinations')
        ?.get?.toString()
        .slice(0, 2000),
      PARTS: Object.fromEntries(Object.entries(CM.PARTS ?? {}).map(([k, v]) => [k, v.template])),
    };
    // Where is the CurrencyManager opened from? (the sheet action handler)
    const proto = group.sheet.constructor;
    const collectActions = cls => {
      const acc = {};
      let k = cls;
      while (k && k.name) {
        for (const [name, fn] of Object.entries(k.DEFAULT_OPTIONS?.actions ?? {})) {
          if (!(name in acc)) acc[name] = typeof fn === 'function' ? fn.name : String(fn);
        }
        k = Object.getPrototypeOf(k);
      }
      return acc;
    };
    const actions = collectActions(proto);
    res.groupSheetActions = Object.keys(actions);
    res.currencyAction = actions.currency ?? null;

    return res;
  }, null);

  show('group purse recon', out);
} catch (e) {
  console.error('[spike2] ERROR:', e?.stack || e);
  process.exitCode = 1;
} finally {
  await f.dispose();
}
