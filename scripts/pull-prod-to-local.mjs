// Refresh the LOCAL Foundry sandbox from prod — mirror the Molten world down to a Foundry
// install on this machine. The full process is documented in docs/local-sandbox.md.
//
// The sandbox contract: PROD (Molten) is the single source of truth for CONTENT (worlds, actors,
// items, assets, installed modules/systems); the local copy is a disposable clone we test against
// and re-image at will. Content only ever flows prod → local. Code flows the other way (house
// modules via scripts/deploy-house-module.mjs) — never content.
//
// What it does, in order:
//   1. Wakes the Molten box if it is asleep (MOLTEN_MAGIC_URL), since WebDAV needs the VM live.
//   2. Refuses to snapshot the world DB while a session is being PLAYED (users connected) —
//      copying LevelDB mid-write can tear the snapshot. Idle-but-active (0 users) is fine.
//   3. Refuses to overwrite the LOCAL world while the local Foundry has it ACTIVE (same risk,
//      other side). Local Foundry on its setup screen is fine (a warning notes the restart rule).
//   4. Walks the remote targets over WebDAV (READ-ONLY on the remote side — GET/PROPFIND only),
//      then MIRRORS them locally:
//        - downloads new/changed files (size + mtime compare; mtimes are stamped on write so
//          later runs skip everything unchanged — the refresh cost is the delta, not 3.5 GB),
//        - DELETES local files/dirs that no longer exist on prod (a stale .ldb/MANIFEST mixed
//          into a fresh LevelDB set corrupts the world — mirror semantics are load-bearing,
//          not tidiness). --no-delete opts out; a target whose remote walk comes back empty
//          never deletes anything (transient-listing tripwire).
//
// Default targets: worlds/<id> (id re-derived from the live worlds/ listing — never trust a
// remembered slug), systems, modules, assets. Config/ is deliberately NOT pulled: license,
// admin password, port and dataPath are per-machine.
//
//   node scripts/pull-prod-to-local.mjs [targets...] [--to <localDataRoot>] [--dry-run] [--force] [--no-delete]
//
//   node scripts/pull-prod-to-local.mjs                       # full refresh into LOCAL_FOUNDRY_DATA
//   node scripts/pull-prod-to-local.mjs --dry-run             # show the plan, change nothing
//   node scripts/pull-prod-to-local.mjs modules/lootshelf     # one module only
//   node scripts/pull-prod-to-local.mjs "C:\...\Data" assets  # legacy positional root still works
//
// Config comes from the repo .env: MOLTEN_WEBDAV_URL / _USER / _PASSWORD, MOLTEN_WORLD_ID,
// MOLTEN_SERVER_URL, MOLTEN_MAGIC_URL, and LOCAL_FOUNDRY_DATA (the local Data dir --to defaults
// to). First proven as a full clone 2026-08-07 (world 444 MB + modules 3.0 GB, 10,959 files,
// 0 failures); incremental mirror since 2026-08-19.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebDavClient } from '../dist/tools/molten/webdav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
const force = rawArgs.includes('--force');
const noDelete = rawArgs.includes('--no-delete');
const dryRun = rawArgs.includes('--dry-run');
let localRoot = env.LOCAL_FOUNDRY_DATA || '';
const positionals = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--to') {
    localRoot = rawArgs[++i] ?? '';
    continue;
  }
  if (a.startsWith('--')) continue;
  positionals.push(a);
}
// Legacy form: an absolute path as the first positional is the local Data root.
if (
  positionals.length &&
  (/^[A-Za-z]:[\\/]/.test(positionals[0]) || positionals[0].startsWith('/'))
) {
  localRoot = positionals.shift();
}
if (!localRoot) {
  console.error(
    'usage: node scripts/pull-prod-to-local.mjs [targets...] [--to <localDataRoot>] [--dry-run] [--force] [--no-delete]'
  );
  console.error('No local Data root: pass --to or set LOCAL_FOUNDRY_DATA in .env');
  console.error('  e.g. LOCAL_FOUNDRY_DATA=C:\\Users\\me\\AppData\\Local\\FoundryVTT\\Data');
  process.exit(2);
}
if (!env.MOLTEN_WEBDAV_PASSWORD) {
  console.error(
    'MOLTEN_WEBDAV_PASSWORD is not set in .env (File Manager password from the Molten panel).'
  );
  process.exit(2);
}

const noop = () => {};
const silent = { info: noop, warn: noop, error: noop, debug: noop };
const dav = new WebDavClient({
  webdavUrl: env.MOLTEN_WEBDAV_URL,
  user: env.MOLTEN_WEBDAV_USER || 'foundry-ftp',
  password: env.MOLTEN_WEBDAV_PASSWORD,
  logger: silent,
  timeoutMs: 60000,
});
// Short-timeout twin for liveness probes (a sleeping box should fail fast, not hang 60s).
const probe = new WebDavClient({
  webdavUrl: env.MOLTEN_WEBDAV_URL,
  user: env.MOLTEN_WEBDAV_USER || 'foundry-ftp',
  password: env.MOLTEN_WEBDAV_PASSWORD,
  logger: silent,
  timeoutMs: 8000,
});

// ---------------------------------------------------------------------------
// 1. Box awake? WebDAV needs the VM live — wake it via the Magic URL if we can.
// ---------------------------------------------------------------------------
async function boxAwake() {
  try {
    await probe.propfind('', '0');
    return true;
  } catch {
    return false;
  }
}
if (!(await boxAwake())) {
  if (!env.MOLTEN_MAGIC_URL) {
    console.error('Molten box is unreachable over WebDAV and MOLTEN_MAGIC_URL is not set.');
    console.error('Wake the server from the Molten panel, then re-run.');
    process.exit(1);
  }
  console.error('box asleep — waking via Magic URL ...');
  try {
    await fetch(env.MOLTEN_MAGIC_URL, { signal: AbortSignal.timeout(30000) });
  } catch {
    /* the GET itself often times out while the VM boots; the poll below is the real check */
  }
  const deadline = Date.now() + 5 * 60_000;
  let awake = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10_000));
    if (await boxAwake()) {
      awake = true;
      break;
    }
    console.error('  ...still waking');
  }
  if (!awake) {
    console.error('Box did not come up within 5 minutes — check the Molten panel.');
    process.exit(1);
  }
  console.error('box is awake.');
}

// ---------------------------------------------------------------------------
// 2. Prod-side LevelDB guard: never snapshot a world that is being actively played.
// ---------------------------------------------------------------------------
if (env.MOLTEN_SERVER_URL) {
  try {
    const res = await fetch(`${env.MOLTEN_SERVER_URL.replace(/\/+$/, '')}/api/status`, {
      signal: AbortSignal.timeout(15000),
    });
    const status = res.ok ? await res.json() : null;
    if (status?.active) {
      console.error(
        `prod status: world "${status.world}" ACTIVE, ${status.users} user(s) connected`
      );
      if (status.users > 0 && !force) {
        console.error(
          'Refusing to copy while users are connected (mid-write LevelDB snapshot risk).'
        );
        console.error('Wait for the table to empty, or re-run with --force.');
        process.exit(1);
      }
    } else {
      console.error('prod status: world not active (setup screen) — files at rest, safe to copy.');
    }
  } catch {
    console.error('prod status: Foundry process not answering (WebDAV is) — files at rest.');
  }
}

// ---------------------------------------------------------------------------
// 3. Local-side guard: never overwrite a world the LOCAL Foundry has open.
// ---------------------------------------------------------------------------
let localPort = 30000;
try {
  const opts = JSON.parse(readFileSync(join(localRoot, '..', 'Config', 'options.json'), 'utf8'));
  if (Number.isInteger(opts.port)) localPort = opts.port;
} catch {
  /* no local Config yet — first pull into a fresh dir */
}
try {
  const res = await fetch(`http://localhost:${localPort}/api/status`, {
    signal: AbortSignal.timeout(3000),
  });
  if (res.ok) {
    const status = await res.json();
    if (status?.active && !force) {
      console.error(`local Foundry has world "${status.world}" ACTIVE on :${localPort}.`);
      console.error(
        'Return it to Setup (or quit local Foundry), then re-run. (--force overrides.)'
      );
      process.exit(1);
    }
    if (status?.active) {
      console.error(`local Foundry world ACTIVE on :${localPort} — proceeding under --force.`);
    } else {
      console.error(
        `local Foundry is running on :${localPort} (setup screen) — OK, but remember: ` +
          'NEW modules/systems register only on a local process restart.'
      );
    }
  }
} catch {
  /* local Foundry not running — the ideal state for a refresh */
}

// ---------------------------------------------------------------------------
// 4. Targets. The world id is re-derived from the live worlds/ listing — Molten worlds get
//    deleted+recreated during setup, so a remembered slug can go stale.
// ---------------------------------------------------------------------------
let targets = positionals.map(t => t.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
if (!targets.length) {
  const worldEntries = await dav.propfind('worlds', '1');
  const worldIds = worldEntries.filter(e => e.isCollection && e.path !== 'worlds').map(e => e.name);
  let worldId = env.MOLTEN_WORLD_ID;
  if (worldId && !worldIds.includes(worldId)) {
    console.error(
      `MOLTEN_WORLD_ID "${worldId}" is not on the box. Worlds found: ${worldIds.join(', ') || '(none)'}`
    );
    console.error('Fix MOLTEN_WORLD_ID in .env (worlds are deleted+recreated during setup).');
    process.exit(1);
  }
  if (!worldId) {
    if (worldIds.length !== 1) {
      console.error(
        `Cannot pick a world automatically. Worlds on the box: ${worldIds.join(', ') || '(none)'}`
      );
      console.error('Set MOLTEN_WORLD_ID in .env or pass worlds/<id> explicitly.');
      process.exit(1);
    }
    worldId = worldIds[0];
  }
  targets = [`worlds/${worldId}`, 'systems', 'modules', 'assets'];
}
console.error(`targets: ${targets.join(', ')}`);
console.error(`local:   ${localRoot}${dryRun ? '   (DRY RUN)' : ''}`);

// ---------------------------------------------------------------------------
// 5. Walk remote (concurrent PROPFIND) + walk local, per target.
// ---------------------------------------------------------------------------
/** @type {Map<string, {path:string,size?:number,lastModified?:string,target:string}>} */
const remoteFiles = new Map();
const remoteDirs = new Set();
const perTargetRemote = new Map(targets.map(t => [t, 0]));
for (const target of targets) {
  console.error(`walking remote ${target}/ ...`);
  remoteDirs.add(target);
  let dirs = [target];
  while (dirs.length) {
    const batch = dirs.splice(0, 8);
    const results = await Promise.all(batch.map(d => dav.propfind(d, '1').then(es => [d, es])));
    for (const [d, es] of results) {
      for (const e of es) {
        if (e.path === d || e.path === d.replace(/\/$/, '')) continue;
        if (e.isCollection) {
          remoteDirs.add(e.path);
          dirs.push(e.path);
        } else {
          remoteFiles.set(e.path, { ...e, target });
          perTargetRemote.set(target, perTargetRemote.get(target) + 1);
        }
      }
    }
  }
}
const totalBytes = [...remoteFiles.values()].reduce((s, f) => s + (f.size ?? 0), 0);
console.error(
  `remote walk done: ${remoteFiles.size} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`
);

/** @type {Map<string, {size:number, mtimeMs:number}>} */
const localFiles = new Map();
const localDirs = new Map(); // dir relpath -> target it belongs to
function walkLocal(absDir, relDir, target) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // target not present locally yet
  }
  for (const e of entries) {
    const rel = `${relDir}/${e.name}`;
    const abs = join(absDir, e.name);
    if (e.isDirectory()) {
      localDirs.set(rel, target);
      walkLocal(abs, rel, target);
    } else if (e.isFile()) {
      try {
        const { size, mtimeMs } = statSync(abs);
        localFiles.set(rel, { size, mtimeMs });
      } catch {
        /* vanished mid-walk */
      }
    }
  }
}
for (const target of targets) {
  walkLocal(join(localRoot, ...target.split('/')), target, target);
}

// ---------------------------------------------------------------------------
// 6. Plan: download new/changed, delete local-only (mirror), skip the rest.
// ---------------------------------------------------------------------------
const MTIME_TOLERANCE_MS = 2000;
const toDownload = [];
let skipped = 0;
for (const [p, e] of remoteFiles) {
  const l = localFiles.get(p);
  const remoteMtime = e.lastModified ? Date.parse(e.lastModified) : NaN;
  if (
    l &&
    l.size === (e.size ?? -1) &&
    Number.isFinite(remoteMtime) &&
    Math.abs(l.mtimeMs - remoteMtime) < MTIME_TOLERANCE_MS
  ) {
    skipped++;
  } else {
    toDownload.push(e);
  }
}
// Case-insensitive membership for the delete pass — Windows treats Foo.png/foo.png as one file,
// so a case-only rename must not delete the file the download just refreshed.
const remoteFilesLower = new Set([...remoteFiles.keys()].map(s => s.toLowerCase()));
const remoteDirsLower = new Set([...remoteDirs].map(s => s.toLowerCase()));
const toDeleteFiles = [];
const toDeleteDirs = [];
if (!noDelete) {
  for (const [p] of localFiles) {
    if (remoteFilesLower.has(p.toLowerCase())) continue;
    const target = targets.find(t => p === t || p.startsWith(`${t}/`));
    if (target && perTargetRemote.get(target) === 0) continue; // empty remote walk → tripwire, keep local
    toDeleteFiles.push(p);
  }
  for (const [p, target] of localDirs) {
    if (remoteDirsLower.has(p.toLowerCase())) continue;
    if (perTargetRemote.get(target) === 0) continue;
    toDeleteDirs.push(p);
  }
  for (const target of targets) {
    if (
      perTargetRemote.get(target) === 0 &&
      [...localFiles.keys()].some(p => p.startsWith(`${target}/`))
    ) {
      console.error(
        `⚠ remote ${target}/ listed EMPTY but local copies exist — skipping deletes there ` +
          '(transient listing? wrong target?).'
      );
    }
  }
}
const downloadBytes = toDownload.reduce((s, f) => s + (f.size ?? 0), 0);
console.error(
  `plan: download ${toDownload.length} (${(downloadBytes / 1024 / 1024).toFixed(1)} MB), ` +
    `skip ${skipped} unchanged, delete ${toDeleteFiles.length} files + ${toDeleteDirs.length} dirs`
);
if (dryRun) {
  const show = (label, list) => {
    if (!list.length) return;
    console.error(`${label} (first ${Math.min(list.length, 20)} of ${list.length}):`);
    for (const x of list.slice(0, 20)) console.error(`  ${typeof x === 'string' ? x : x.path}`);
  };
  show('would download', toDownload);
  show('would delete', toDeleteFiles);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 7. Execute: download (6 workers, 2 retries, mtimes stamped), then mirror-delete.
// ---------------------------------------------------------------------------
const started = Date.now();
let done = 0;
let bytes = 0;
const failed = [];
const queue = toDownload.slice();
async function fetchWithRetry(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await dav.getFile(path);
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}
async function worker() {
  while (queue.length) {
    const f = queue.shift();
    const dest = join(localRoot, ...f.path.split('/'));
    try {
      const data = await fetchWithRetry(f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      const remoteMtime = f.lastModified ? Date.parse(f.lastModified) : NaN;
      if (Number.isFinite(remoteMtime)) {
        utimesSync(dest, new Date(), new Date(remoteMtime));
      }
      done++;
      bytes += data.length;
      if (done % 200 === 0)
        console.error(`  ${done}/${toDownload.length} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      failed.push({ path: f.path, err: String(err?.message ?? err) });
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

let deletedFiles = 0;
let deletedDirs = 0;
for (const p of toDeleteFiles) {
  try {
    unlinkSync(join(localRoot, ...p.split('/')));
    deletedFiles++;
  } catch (err) {
    failed.push({ path: `delete ${p}`, err: String(err?.message ?? err) });
  }
}
// Bottom-up so children go before parents; anything non-empty at this point is a bug we surface.
for (const p of toDeleteDirs.sort((a, b) => b.split('/').length - a.split('/').length)) {
  try {
    rmdirSync(join(localRoot, ...p.split('/')));
    deletedDirs++;
  } catch (err) {
    failed.push({ path: `rmdir ${p}`, err: String(err?.message ?? err) });
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(0);
console.error(
  `done in ${secs}s: ${done}/${toDownload.length} downloaded (${(bytes / 1024 / 1024).toFixed(1)} MB), ` +
    `${skipped} skipped, ${deletedFiles} files + ${deletedDirs} dirs deleted -> ${localRoot}`
);

// A refreshed world is only useful if the local app can open it — surface the version facts.
const worldTarget = targets.find(t => /^worlds\/[^/]+$/.test(t));
if (worldTarget) {
  try {
    const wj = JSON.parse(
      readFileSync(join(localRoot, ...worldTarget.split('/'), 'world.json'), 'utf8')
    );
    console.error(
      `world "${wj.title ?? wj.id}": coreVersion ${wj.coreVersion}, ${wj.system} ${wj.systemVersion} — ` +
        'local Foundry must be the same generation at >= that build.'
    );
  } catch {
    /* world.json unreadable — the failure list below will already say so */
  }

  // LevelDB integrity tripwire. Each collection is its own store, and its CURRENT file names the
  // ONE manifest that store is valid against. A mirror that half-worked — a failed delete, a
  // --no-delete run over an older snapshot — leaves a second MANIFEST behind or a CURRENT
  // pointing at a manifest that is no longer there, and Foundry then refuses to open the world
  // with an error that says nothing about the copy. Cheap to check here, miserable to diagnose
  // from the Foundry side, so we check every time rather than trusting the delete pass.
  const dataDir = join(localRoot, ...worldTarget.split('/'), 'data');
  const problems = [];
  let collections = 0;
  try {
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      collections++;
      const dir = join(dataDir, entry.name);
      const names = readdirSync(dir);
      const manifests = names.filter(n => n.startsWith('MANIFEST-'));
      if (manifests.length > 1) {
        problems.push(`${entry.name}: ${manifests.length} manifests (${manifests.join(', ')})`);
      }
      if (!names.includes('CURRENT')) {
        problems.push(`${entry.name}: no CURRENT file`);
        continue;
      }
      const current = readFileSync(join(dir, 'CURRENT'), 'utf8').trim();
      if (current && !names.includes(current)) {
        problems.push(`${entry.name}: CURRENT points at missing "${current}"`);
      }
    }
  } catch (err) {
    problems.push(`could not read ${dataDir}: ${String(err?.message ?? err)}`);
  }
  if (problems.length) {
    console.error(`⚠ WORLD DB INTEGRITY (${collections} collections) — PROBLEMS:`);
    for (const p of problems) console.error(`    ${p}`);
    console.error(
      '  This world may not open. Delete the local world folder and re-run for a clean pull.'
    );
    failed.push({ path: worldTarget, err: `${problems.length} LevelDB integrity problem(s)` });
  } else {
    console.error(`world DB integrity OK: ${collections} collections, one manifest each.`);
  }

  console.error(
    'next: start local Foundry (a RESTART if it was running — module registry is boot-scoped) and launch the world.'
  );
}
if (failed.length) {
  console.error(`FAILED (${failed.length}):`);
  for (const f of failed) console.error(`  ${f.path}: ${f.err}`);
  process.exit(1);
}
