// Spike #3 for fvtt-mod-partystash v1.3 — which render hook can the coin buttons ride?
//
// The injection has to survive the ways the group sheet redraws in play: a currency change,
// an item arriving, a tab switch. This probe records every `render*` hook that fires for the
// group sheet, then mutates the actor's currency and an item to see which of them fire again
// and whether a marker element planted inside `section.currency` survives.
//
// Read-only apart from a currency round-trip on the group actor (restored at the end).
// Run: node scripts/spike-group-render-hooks.mjs
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

try {
  console.log('[spike3] connecting…');
  await f.connect();

  const out = await f.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const res = { phases: {} };
    const group = game.actors.find(a => a.type === 'group');
    const before = foundry.utils.deepClone(group.system.currency);
    res.groupName = group.name;
    res.currencyBefore = before;

    // Record every hook whose name starts with "render" while we drive the sheet.
    const seen = [];
    const origCallAll = Hooks.callAll;
    Hooks.callAll = function (name, ...args) {
      if (typeof name === 'string' && name.startsWith('render')) seen.push(name);
      return origCallAll.call(this, name, ...args);
    };
    const drain = () => {
      const s = [...new Set(seen)];
      seen.length = 0;
      return s;
    };

    try {
      const sheet = group.sheet;
      await sheet.render({ force: true });
      await sleep(1800);
      res.phases.initialRender = drain();

      const root = sheet.element;
      const tab = root.querySelector('nav [data-tab="inventory"], .tabs [data-tab="inventory"]');
      if (tab) {
        tab.click();
        await sleep(900);
      }
      res.phases.tabSwitch = drain();

      // Plant a marker exactly where the coin buttons would live.
      const plant = () => {
        const section = root.querySelector('section.currency');
        if (!section) return false;
        if (!section.querySelector('.ps-marker')) {
          const m = document.createElement('span');
          m.className = 'ps-marker';
          m.textContent = '·';
          section.append(m);
        }
        return true;
      };
      res.markerPlanted = plant();
      const markerAlive = () => !!root.querySelector('section.currency .ps-marker');
      res.markerAfterPlant = markerAlive();

      // 1. currency change (the case the deposit/withdraw dialog itself will cause)
      await group.update({ 'system.currency.gp': (before.gp ?? 0) + 1 });
      await sleep(1400);
      res.phases.afterCurrencyChange = drain();
      res.markerAfterCurrencyChange = markerAlive();
      res.currencySectionStillThere = !!root.querySelector('section.currency');

      // 2. an item landing in the stash (a redraw of the inventory list)
      const [probe] = await group.createEmbeddedDocuments('Item', [
        { name: 'ZZ-PSTASH Coin Probe', type: 'loot', system: { quantity: 1 } },
      ]);
      await sleep(1400);
      res.phases.afterItemCreate = drain();
      res.markerAfterItemCreate = markerAlive();

      await group.deleteEmbeddedDocuments('Item', [probe.id]);
      await sleep(1200);
      res.phases.afterItemDelete = drain();
      res.markerAfterItemDelete = markerAlive();

      // Does the inventory custom element own its own subtree redraw?
      const invEl = root.querySelector('dnd5e-inventory');
      res.inventoryElementTag = invEl?.tagName ?? null;
      res.inventoryElementProto = invEl
        ? Object.getOwnPropertyNames(Object.getPrototypeOf(invEl))
        : null;

      await group.update({ 'system.currency': before });
      await sleep(900);
      res.markerAfterRestore = markerAlive();
      root.querySelector('.ps-marker')?.remove();
      await sheet.close();
    } finally {
      Hooks.callAll = origCallAll;
      await group.update({ 'system.currency': before });
    }

    res.currencyAfter = game.actors.get(group.id).system.currency;
    return res;
  }, null);

  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error('[spike3] ERROR:', e?.stack || e);
  process.exitCode = 1;
} finally {
  await f.dispose();
}
