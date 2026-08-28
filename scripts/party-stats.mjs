// Party stats CLI — the dev/archival harness for the get-combat-stats MCP tool.
//
// ONE COPY of the arithmetic: the scan is the page function `scanCombatStats`
// (src/page/combat-stats.ts, in the injected bundle) and the fold/report are imported from
// dist/tools/combat-stats.js — this script adds only targeting, occupancy guarding and files.
// Build first: `npm run build && node esbuild.page.mjs`.
//
// THE READ CONTRACT is fvtt-mod-battleflow's ARCHITECTURE.md §4 "The data plane — stat stamps",
// consumed as an external wire format (data contract, not a code dependency).
//
// READ-ONLY: no writes, no settings, no fixtures — safe beside a live prod session. For the
// LOCAL sandbox it refuses to join while another client is connected (the elect is per-user;
// a second GM-capable client can steal it from a running suite) — --force overrides.
//
// Usage:
//   node scripts/party-stats.mjs                    # scan the LOCAL sandbox, print reports
//   node scripts/party-stats.mjs --prod             # scan live Molten prod (read-only)
//   node scripts/party-stats.mjs --dump scan.json   # also write the raw scan (archival/debug)
//   node scripts/party-stats.mjs --from scan.json   # fold a saved scan offline, no connection
//   node scripts/party-stats.mjs --out report.json  # also write the folded ledger JSON
//   node scripts/party-stats.mjs --since 2026-08-27 # only messages at/after this date/epoch-ms
//
// Chat is not forever (messages get pruned): --dump per session is the archival path; --from
// folds any past dump. The ledger starts when the stamps do (2026-08-27).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';
import { foldCombatLedger, renderCombatReport } from '../dist/tools/combat-stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flagArg = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const PROD = argv.includes('--prod');
const FORCE = argv.includes('--force');
const DUMP = flagArg('dump');
const FROM = flagArg('from');
const OUT = flagArg('out');
const SINCE = (() => {
  const raw = flagArg('since');
  if (!raw) return 0;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n)) {
    console.error(`--since "${raw}" is not a date or epoch-ms`);
    process.exit(1);
  }
  return n;
})();

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function scanLive() {
  const env = loadEnv();
  const cfg = PROD
    ? {
        serverUrl: env.MOLTEN_SERVER_URL,
        magicUrl: env.MOLTEN_MAGIC_URL,
        user: env.FOUNDRY_USER,
        password: env.FOUNDRY_PASSWORD,
      }
    : {
        serverUrl: env.LOCAL_SERVER_URL || 'http://localhost:30000',
        user: env.FOUNDRY_USER,
        password: env.FOUNDRY_PASSWORD,
      };
  console.log(`[stats] target: ${PROD ? 'PROD (Molten)' : `local sandbox (${cfg.serverUrl})`}`);

  if (!PROD) {
    // Occupancy guard: a suite or another session may be driving the shared sandbox.
    try {
      const s = await (
        await fetch(`${cfg.serverUrl}/api/status`, { signal: AbortSignal.timeout(5000) })
      ).json();
      if (!s?.active) {
        console.error(
          '[stats] no world active on the sandbox — start it first (scripts/local-foundry.mjs start)'
        );
        process.exit(1);
      }
      if ((s.users ?? 0) > 0 && !FORCE) {
        console.error(
          `[stats] REFUSING: ${s.users} client(s) already connected to the sandbox — a suite may be mid-run.`
        );
        console.error('[stats] Re-run with --force only when you know the world is idle.');
        process.exit(2);
      }
    } catch (e) {
      console.error(`[stats] sandbox unreachable at ${cfg.serverUrl}: ${e?.message || e}`);
      process.exit(1);
    }
  }

  const f = new Foundry(cfg);
  setTimeout(() => {
    console.error('[stats] WATCHDOG 180s');
    process.exit(3);
  }, 180_000).unref?.();
  await f.connect();
  try {
    return await f.call('scanCombatStats', { since: SINCE });
  } finally {
    await f.dispose();
  }
}

const scan = FROM ? JSON.parse(readFileSync(FROM, 'utf8')) : await scanLive();
if (DUMP) {
  writeFileSync(DUMP, JSON.stringify(scan, null, 2));
  console.log(`[stats] raw scan → ${DUMP}`);
}
const ledger = foldCombatLedger(scan);
console.log(renderCombatReport(scan, ledger));
if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        scan: { world: scan.world, scannedAt: scan.scannedAt },
        ledger,
        rosters: scan.rosters ?? {},
      },
      null,
      2
    )
  );
  console.log(`\n[stats] ledger → ${OUT}`);
}
process.exit(0);
