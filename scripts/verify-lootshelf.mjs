// Live verification for the Loot Shelf module against the Greenrest merchants.
//
// Proves the two shelves actually WORK, not just that their flags look right — run it after every
// Loot Shelf release (register-module.mjs) as the deploy gate:
//   A. module + sheet registration
//   B. both shelves RENDER headlessly (openShelf catches template/JS breakage a flag read can't)
//   C. shelf contents are what a shopper would see — hidden kit filtered, prices at modifier
//   D. kernel rejects: bogus item, a hidden item, and over-stock on a pinned magic item
//   E. a real buy + sell-back round trip through the kernel, against a throwaway buyer
//
// Everything mutated in E is restored: the fixture actor is deleted and both the merchant's
// purse and the probe item's quantity are written back to their pre-test values.
//
// The kernel's audit lines are public chat by design, so a run leaves a few messages behind.
//
//   node scripts/verify-lootshelf.mjs
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

setTimeout(() => {
  console.error('[verify-ls] WATCHDOG: 300s elapsed — hard abort');
  process.exit(3);
}, 300_000);

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

console.log('[verify-ls] connecting…');
await f.connect();
console.log('[verify-ls] connected\n');

const res = await f.evaluate(
  async payload => {
    const { SELMA, WEND, TAG, CANON } = payload;
    const LS = 'fvtt-mod-lootshelf';
    const checks = [];
    const ok = (name, cond, detail = '') =>
      checks.push({ name, pass: !!cond, detail: String(detail) });
    const api = game.modules.get(LS)?.api;

    // --- A. registration ------------------------------------------------------------------
    ok(
      'lootshelf module active',
      game.modules.get(LS)?.active,
      game.modules.get(LS)?.version ?? ''
    );
    ok('lootshelf api exposed', !!api?.setMerchant);
    const sheetIds = Object.keys(
      foundry.applications?.apps?.DocumentSheetConfig?.getSheetClassesForSubType?.('Actor', 'npc')
        ?.sheetClasses ?? {}
    );
    ok(
      'MerchantShelfSheet registered for npc',
      sheetIds.some(s => s.includes('MerchantShelfSheet')),
      sheetIds.join(', ')
    );

    const out = { checks, shelves: {}, roundTrip: null };

    // --- B/C. render + contents ------------------------------------------------------------
    for (const [label, id] of [
      ['Selma', SELMA],
      ['Mother Wend', WEND],
    ]) {
      const a = game.actors.get(id);
      if (!a) {
        ok(`${label} exists`, false);
        continue;
      }
      const cfg = a.getFlag(LS, 'merchant');
      ok(`${label} merchant enabled`, cfg?.enabled, JSON.stringify(cfg));
      ok(`${label} on shelf sheet`, a.getFlag('core', 'sheetClass') === `${LS}.MerchantShelfSheet`);
      ok(`${label} has a purse`, (a.system?.currency?.gp ?? 0) > 0, `${a.system?.currency?.gp}gp`);

      // Render headlessly — this is what catches a broken template.
      let rendered = false;
      let renderErr = '';
      try {
        const app = await api.openShelf(a);
        rendered = !!app?.element;
        await app?.close?.();
      } catch (e) {
        renderErr = String(e?.message || e);
      }
      ok(`${label} shelf renders`, rendered, renderErr);

      const physical = a.items.contents.filter(i => i.system?.schema?.fields?.quantity);
      const visible = physical.filter(i => !i.getFlag(LS, 'hidden') && !i.system.equipped);
      const priceMod = Number(cfg?.priceModifier) || 1;
      out.shelves[label] = {
        total: a.items.size,
        physical: physical.length,
        visible: visible.length,
        hidden: physical.filter(i => i.getFlag(LS, 'hidden')).map(i => i.name),
        purse: a.system?.currency,
        infiniteStock: !!cfg?.infiniteStock,
        sample: visible.slice(0, 3).map(i => ({
          name: i.name,
          qty: i.system.quantity,
          listed: Math.ceil((api.priceInCopper?.(i) ?? 0) * priceMod),
        })),
      };
      ok(`${label} Club hidden from shelf`, !visible.some(i => i.name === 'Club'));

      // The purchase kernel refuses anything with system.container set (transfer.js:326), so a
      // shelf item carrying one is listed-but-unbuyable. Stocking from the PHB compendium leaves
      // goods pointing at the adventuring pack they ship inside; see
      // scripts/repair-orphaned-container-refs.mjs.
      const contained = visible.filter(i => i.system.container);
      ok(
        `${label} no shelf item is stuck in a container`,
        contained.length === 0,
        contained.map(i => i.name).join(', ')
      );
    }

    // --- D. kernel rejections ---------------------------------------------------------------
    const wend = game.actors.get(WEND);
    const buyer = await Actor.create({ name: `${TAG} Buyer`, type: 'character' });
    await buyer.update({ 'system.currency': { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } });

    const expectReject = async (name, payload, mustMatch) => {
      try {
        await api.purchase(payload);
        ok(name, false, 'purchase SUCCEEDED but should have been refused');
      } catch (e) {
        const msg = String(e?.message || e);
        ok(name, mustMatch.test(msg), msg);
      }
    };

    await expectReject(
      'reject: bogus item id',
      { merchantUuid: wend.uuid, buyerUuid: buyer.uuid, itemId: 'bogus' },
      /not for sale/i
    );
    const club = wend.items.find(i => i.name === 'Club');
    await expectReject(
      'reject: hidden statblock Club',
      { merchantUuid: wend.uuid, buyerUuid: buyer.uuid, itemId: club?.id },
      /not for sale/i
    );
    const magic = wend.items.find(i => i.name === '+1 Plate Armor');
    await expectReject(
      'reject: over-stock on pinned magic item',
      { merchantUuid: wend.uuid, buyerUuid: buyer.uuid, itemId: magic?.id, quantity: 5 },
      /only 1 in stock/i
    );

    // --- E. real buy + sell-back -------------------------------------------------------------
    const probe = wend.items.find(i => i.name === 'Longsword');
    const before = {
      stock: probe.system.quantity,
      merchantPurse: foundry.utils.deepClone(wend.system.currency),
      buyerCopper: 500 * 100,
    };

    const bought = await api.purchase({
      merchantUuid: wend.uuid,
      buyerUuid: buyer.uuid,
      itemId: probe.id,
      quantity: 2,
    });
    const afterBuy = {
      stock: wend.items.get(probe.id)?.system.quantity,
      buyerHas: buyer.items.find(i => i.name === 'Longsword')?.system.quantity ?? 0,
      merchantGp: wend.system.currency.gp,
      buyerGp: buyer.system.currency.gp,
    };
    ok('buy: cost is 2 × 15gp', bought.cost === 3000, `${bought.cost}cp`);
    ok(
      'buy: merchant stock decremented 20 -> 18',
      afterBuy.stock === before.stock - 2,
      `${afterBuy.stock}`
    );
    ok('buy: buyer received 2', afterBuy.buyerHas === 2, `${afterBuy.buyerHas}`);
    ok('buy: buyer paid 30gp', afterBuy.buyerGp === 470, `${afterBuy.buyerGp}gp`);
    ok(
      'buy: merchant took 30gp',
      afterBuy.merchantGp === (before.merchantPurse.gp ?? 0) + 30,
      `${afterBuy.merchantGp}gp`
    );

    const buyerItem = buyer.items.find(i => i.name === 'Longsword');
    const sold = await api.sell({
      merchantUuid: wend.uuid,
      sellerUuid: buyer.uuid,
      itemId: buyerItem.id,
      quantity: 2,
    });
    const afterSell = {
      buyerHas: buyer.items.find(i => i.name === 'Longsword')?.system.quantity ?? 0,
      buyerGp: buyer.system.currency.gp,
    };
    ok('sell: paid back at 0.5 modifier (15gp)', sold.gain === 1500, `${sold.gain}cp`);
    ok('sell: buyer no longer holds it', afterSell.buyerHas === 0, `${afterSell.buyerHas}`);
    ok('sell: buyer recovered to 485gp', afterSell.buyerGp === 485, `${afterSell.buyerGp}gp`);

    out.roundTrip = { bought, sold, afterBuy, afterSell };

    // --- restore ------------------------------------------------------------------------------
    // Restore to the migration's CANONICAL values, not to whatever was read at the start of this
    // run. Restoring to a self-captured snapshot lets a few gp of change survive each pass and
    // silently ratchet the merchant's purse upward across repeated runs.
    await buyer.delete();
    const probeNow = wend.items.get(probe.id);
    if (probeNow) await probeNow.update({ 'system.quantity': CANON.stock });
    await wend.update({ 'system.currency': { pp: 0, gp: CANON.wendPurseGp, ep: 0, sp: 0, cp: 0 } });
    const restored = {
      stock: wend.items.get(probe.id)?.system.quantity,
      purse: wend.system.currency.gp,
      fixtureGone: !game.actors.find(x => x.name.startsWith(TAG)),
    };
    ok('restore: probe stock back to 20', restored.stock === CANON.stock, `${restored.stock}`);
    ok(
      `restore: merchant purse back to ${CANON.wendPurseGp}gp`,
      restored.purse === CANON.wendPurseGp,
      `${restored.purse}gp`
    );
    ok('restore: fixture actor deleted', restored.fixtureGone);

    return out;
  },
  {
    SELMA: 'krdThcl2lpElRTny',
    WEND: 'JBEHNnZOEsNrtDmV',
    TAG: 'ZZ-LSVERIFY',
    // The values the migration established; the run restores to THESE, so it is idempotent.
    CANON: { wendPurseGp: 1000, selmaPurseGp: 500, stock: 20 },
  }
);

let fails = 0;
for (const c of res.checks) {
  if (!c.pass) fails++;
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
}

console.log('\n# shelf contents');
for (const [name, s] of Object.entries(res.shelves)) {
  console.log(
    `  ${name}: ${s.visible} on the shelf (${s.physical} physical of ${s.total} items) · ` +
      `purse ${s.purse?.gp}gp · infiniteStock=${s.infiniteStock}`
  );
  console.log(`     hidden: ${s.hidden.join(', ') || 'none'}`);
  console.log(
    `     sample: ${s.sample.map(x => `${x.name} x${x.qty} @${x.listed}cp`).join(' | ')}`
  );
}

console.log(
  `\n[verify-ls] RESULT: ${fails ? `FAIL (${fails})` : 'PASS'} — ${res.checks.length} checks`
);
process.exit(fails ? 1 : 0);
