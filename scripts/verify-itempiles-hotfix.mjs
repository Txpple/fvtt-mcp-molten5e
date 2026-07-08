// Tripwire for the LOCAL itempilesdnd5e NaN-attunement hotfix (installed + verified 2026-07-08).
//
// The world runs a hand-patched dist/module.js for "Item Piles: D&D 5e" (stock 1.1.0 writes
// system.attunement = "NaN" on every transfer). Root cause + patched file: notes repo
// evidence/nan-attunement-2026-07-08-session1-loot.md + hotfixes/itempilesdnd5e-1.1.0/.
//
// MECHANISM (live-verified 2026-07-08 — subtler than it looks):
//   - The companion registers per-dnd5e-version configs in an awaited loop on item-piles-ready.
//   - Item Piles core reads AND CACHES SYSTEMS.DATA synchronously right after firing that hook
//     (module.js:123 registerSystemLibwrappers -> libwrapper.js:103), while the loop has only
//     registered its FIRST entry ("2.4.1" = pure baseConfig).
//   - So baseConfig's ITEM_TRANSFORMER — with the legacy numeric clamp
//     Math.min(CONFIG.DND5E.attunementTypes.REQUIRED, ...) that yields NaN on dnd5e >= 3.2 —
//     is what actually runs; the later "5.0.0" entry never takes effect.
//   - The hotfix therefore patches BASECONFIG's transformer (type-guarded), plus the 5.0.0
//     entry for belt-and-suspenders.
//
// The patch lives in the module's own file: ANY module update — or a reinstall of stock 1.1.0,
// which keeps the version string — silently reverts it. And marker-present alone once masked a
// still-broken world (the v1 patch missed baseConfig), so the --transfer probe is the ONLY
// full proof. Run BEFORE and AFTER any work involving Item Piles and after any module
// install/update pass:
//
//   node scripts/verify-itempiles-hotfix.mjs              # marker + version check (read-only)
//   node scripts/verify-itempiles-hotfix.mjs --transfer   # + end-to-end behavior probe:
//                                                         #   real transferItems both directions,
//                                                         #   asserts attunement survives intact
//                                                         #   (creates+deletes ZZ-IPFIX fixtures)
//
// Verdicts (exit 0 only on the first two; prefer --transfer for a real all-clear):
//   HOTFIX-INTACT      both patch markers present in the served file
//   BEHAVIOR-OK        --transfer probe passed (the definitive verdict)
//   BEHAVIOR-BROKEN    markers present but transfers corrupt — patch incomplete/stale clients
//   STOCK-RESTORED     markers gone — the NaN factory is LIVE; re-drop
//                      hotfixes/itempilesdnd5e-1.1.0/module.js via WebDAV
//   UPSTREAM-UPDATED   markers gone AND version changed — do NOT assume upstream fixed the
//                      bug: re-run with --transfer, keep the post-session NaN audit standing
//
// Version notes: on-disk module.json says 1.1.0.1 (local tamper signature; manifest blanked so
// Foundry can't offer updates). The VENDED version lags at 1.1.0 until the next server reboot —
// treat version as informational, never as proof.
//
// dnd5e prep gotcha baked into the fixture: non-magical items show prepared attunement "" even
// when "required" is stored — the probe item MUST carry properties:['mgc'].
//
// Build first if dist is stale: npm run build.  Read-only unless --transfer.
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

const TAG = 'ZZ-IPFIX';
const MARKER = 'MOLTEN LOCAL FIX';
const EXPECTED_MARKERS = 3; // part-1 fence x2 (5.0.0 entry) + part-2 header (baseConfig)
const doTransfer = process.argv.includes('--transfer');

let verdict = null;
let fails = 0;
function assert(cond, msg) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let srcId;
let dstId;

try {
  console.log('[verify-ipfix] connecting…');
  await f.connect();
  console.log('[verify-ipfix] connected\n');

  // --- A. marker + version (read-only) ------------------------------------------------------
  console.log('# hotfix presence — served dist/module.js + module version');
  const state = await f.evaluate(async marker => {
    const mod = game.modules.get('itempilesdnd5e');
    if (!mod) return { installed: false };
    let markerCount = null; // null = fetch failed, unknown
    try {
      const res = await fetch('modules/itempilesdnd5e/dist/module.js', { cache: 'no-store' });
      if (res.ok) markerCount = (await res.text()).split(marker).length - 1;
    } catch (e) {
      /* leave null */
    }
    return {
      installed: true,
      active: mod.active,
      version: mod.version,
      coreVersion: game.modules.get('item-piles')?.version ?? null,
      markerCount,
    };
  }, MARKER);

  if (!state.installed) throw new Error('itempilesdnd5e is not installed in this world');
  assert(
    state.active,
    `itempilesdnd5e is active (vended version ${state.version}; item-piles core ${state.coreVersion})`
  );
  assert(state.markerCount !== null, 'served dist/module.js is readable');

  if (state.markerCount >= EXPECTED_MARKERS) {
    verdict = 'HOTFIX-INTACT';
    assert(true, `"${MARKER}" markers present (${state.markerCount})`);
  } else if (state.markerCount !== null) {
    verdict =
      state.version === '1.1.0' || state.version === '1.1.0.1'
        ? 'STOCK-RESTORED'
        : 'UPSTREAM-UPDATED';
    assert(
      false,
      `"${MARKER}" markers MISSING or incomplete (found ${state.markerCount}, expected ${EXPECTED_MARKERS}; vended version ${state.version})`
    );
  }

  // --- B. optional end-to-end behavior probe -------------------------------------------------
  if (doTransfer) {
    console.log('\n# behavior probe — transferItems must preserve string attunement');
    const probe = await f.evaluate(async tag => {
      if (!game.itempiles?.API) return { error: 'game.itempiles.API unavailable' };
      const src = await Actor.create({ name: `${tag} Src`, type: 'npc' });
      const dst = await Actor.create({ name: `${tag} Dst`, type: 'npc' });
      const [req, none] = await Promise.all([
        // properties:['mgc'] is load-bearing — non-magical items PREP attunement to "" and
        // would false-fail the probe even though the stored value is intact
        Item.create(
          {
            name: `${tag} Amulet`,
            type: 'equipment',
            system: { attunement: 'required', properties: ['mgc'], rarity: 'rare' },
          },
          { parent: src }
        ),
        Item.create(
          { name: `${tag} Buckle`, type: 'equipment', system: { attunement: '' } },
          { parent: src }
        ),
      ]);
      const read = (actor, name) => {
        const it = actor.items.find(i => i.name === name);
        return it ? { attunement: it.system.attunement, attuned: it.system.attuned } : null;
      };
      const pre = { req: read(src, `${tag} Amulet`), none: read(src, `${tag} Buckle`) };
      // forward: src -> dst (the pile->PC shape)
      await game.itempiles.API.transferItems(src, dst, [
        { _id: req.id, quantity: 1 },
        { _id: none.id, quantity: 1 },
      ]);
      const fwd = { req: read(dst, `${tag} Amulet`), none: read(dst, `${tag} Buckle`) };
      // reverse: dst -> src (the PC->pile shape; same add path on the receiver)
      const back = dst.items
        .filter(i => i.name.startsWith(tag))
        .map(i => ({ _id: i.id, quantity: 1 }));
      await game.itempiles.API.transferItems(dst, src, back);
      const rev = { req: read(src, `${tag} Amulet`), none: read(src, `${tag} Buckle`) };
      return { srcId: src.id, dstId: dst.id, pre, fwd, rev };
    }, TAG);

    if (probe.error) throw new Error(probe.error);
    srcId = probe.srcId;
    dstId = probe.dstId;
    assert(
      probe.pre.req?.attunement === 'required',
      `fixture sanity: source amulet reads "required" pre-transfer (got ${JSON.stringify(probe.pre.req?.attunement)})`
    );
    for (const [leg, r] of [
      ['pile->PC', probe.fwd],
      ['PC->pile', probe.rev],
    ]) {
      assert(
        r.req?.attunement === 'required',
        `${leg}: "required" survived (got ${JSON.stringify(r.req?.attunement)})`
      );
      assert(
        r.none?.attunement === '',
        `${leg}: "" survived (got ${JSON.stringify(r.none?.attunement)})`
      );
      assert(
        r.req?.attuned === false,
        `${leg}: attuned reset to false (got ${JSON.stringify(r.req?.attuned)})`
      );
    }
    if (fails === 0) verdict = 'BEHAVIOR-OK';
    else verdict = 'BEHAVIOR-BROKEN';
  }
} catch (e) {
  fails++;
  console.log(`\n[verify-ipfix] FATAL: ${e?.stack || e?.message || String(e)}`);
} finally {
  try {
    const actorIds = [srcId, dstId].filter(Boolean);
    if (actorIds.length) {
      await f.call('deleteActor', { identifiers: actorIds });
      console.log('\n[verify-ipfix] cleaned up fixtures');
    }
  } catch (e) {
    console.log(`\n[verify-ipfix] cleanup note: ${e?.message || e}`);
  }
  await f.dispose?.();
}

const ok = verdict === 'HOTFIX-INTACT' || verdict === 'BEHAVIOR-OK';
console.log(
  `\n==== itempiles hotfix: VERDICT ${verdict ?? 'UNKNOWN'} (${fails} check failures) ====`
);
if (verdict === 'STOCK-RESTORED')
  console.log(
    '→ NaN factory is LIVE. Re-drop hotfixes/itempilesdnd5e-1.1.0/module.js (notes repo) via WebDAV, then re-run with --transfer.'
  );
if (verdict === 'UPSTREAM-UPDATED')
  console.log(
    '→ Module was updated. Re-run with --transfer before trusting it; keep the post-session NaN audit standing.'
  );
if (verdict === 'BEHAVIOR-BROKEN')
  console.log(
    '→ Markers present but transfers corrupt — patch incomplete or stale client code. See hotfixes README (mechanism) before touching anything.'
  );
process.exit(ok && fails === 0 ? 0 : 1);
