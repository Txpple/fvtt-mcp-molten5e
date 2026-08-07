// Pull the prod Molten world down to a local Foundry install — "restore from backup" into a sandbox.
//
// Mirrors Data-relative folders from the Molten WebDAV channel (Plane B) into a local Foundry
// Data directory. READ-ONLY on the remote side; local files are overwritten in place. It is a
// copy, not a true mirror: files deleted on prod are NOT deleted locally (delete the local
// folder first for a byte-exact restore).
//
// Default targets (when none given): worlds/<MOLTEN_WORLD_ID>, modules, assets — the full
// prod → local-sandbox clone. Mirroring modules from prod (instead of reinstalling) matters:
// it carries locally patched files byte-for-byte (e.g. the itempilesdnd5e NaN-attunement
// hotfix — see scripts/verify-itempiles-hotfix.mjs).
//
// LevelDB-consistency guard: copying worlds/<id>/data while a session is being PLAYED can
// snapshot the DB mid-write. The script probes /api/status first and aborts when the world is
// active with users connected; an idle-but-active world (0 users) or a sleeping box is fine.
// Override with --force if you accept a possibly torn snapshot.
//
//   node scripts/pull-prod-to-local.mjs <localDataRoot> [targets...] [--force]
//
//   node scripts/pull-prod-to-local.mjs "C:\Users\me\AppData\Local\FoundryVTT\Data"
//   node scripts/pull-prod-to-local.mjs "C:\...\Data" modules/itempilesdnd5e   # one module only
//
// Config comes from the repo .env (MOLTEN_WEBDAV_URL / _USER / _PASSWORD, MOLTEN_WORLD_ID,
// MOLTEN_SERVER_URL). First proven as a full clone 2026-08-07 (world 444 MB + modules 3.0 GB,
// 10,959 files, 0 failures).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebDavClient } from '../dist/tools/molten/webdav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const args = process.argv.slice(2).filter(a => a !== '--force');
const force = process.argv.includes('--force');
const localRoot = args[0];
if (!localRoot) {
  console.error(
    'usage: node scripts/pull-prod-to-local.mjs <localDataRoot> [targets...] [--force]'
  );
  console.error(
    '  e.g. node scripts/pull-prod-to-local.mjs "C:\\Users\\me\\AppData\\Local\\FoundryVTT\\Data"'
  );
  process.exit(2);
}
if (!env.MOLTEN_WEBDAV_PASSWORD) {
  console.error(
    'MOLTEN_WEBDAV_PASSWORD is not set in .env (File Manager password from the Molten panel).'
  );
  process.exit(2);
}
const targets = args.slice(1).length
  ? args.slice(1).map(t => t.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
  : [env.MOLTEN_WORLD_ID ? `worlds/${env.MOLTEN_WORLD_ID}` : null, 'modules', 'assets'].filter(
      Boolean
    );

// --- LevelDB-consistency guard: refuse to snapshot a world that is being actively played. ---
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
      console.error('prod status: world not active (setup screen or waking) — safe to copy.');
    }
  } catch {
    console.error('prod status: box unreachable (asleep) — files are at rest, safe to copy.');
  }
}

const noop = () => {};
const dav = new WebDavClient({
  webdavUrl: env.MOLTEN_WEBDAV_URL,
  user: env.MOLTEN_WEBDAV_USER || 'foundry-ftp',
  password: env.MOLTEN_WEBDAV_PASSWORD,
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  timeoutMs: 60000,
});

// Walk every target, then download with limited concurrency.
const files = [];
for (const target of targets) {
  console.error(`walking ${target}/ ...`);
  const dirs = [target];
  while (dirs.length) {
    const dir = dirs.shift();
    for (const e of await dav.propfind(dir, '1')) {
      if (e.path === dir || e.path === dir.replace(/\/$/, '')) continue;
      if (e.isCollection) dirs.push(e.path);
      else files.push(e);
    }
  }
}
const totalBytes = files.reduce((s, f) => s + (f.size ?? 0), 0);
console.error(`walk done: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

let done = 0;
let bytes = 0;
const failed = [];
const queue = files.slice();
async function worker() {
  while (queue.length) {
    const f = queue.shift();
    const dest = join(localRoot, ...f.path.split('/'));
    try {
      const data = await dav.getFile(f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      done++;
      bytes += data.length;
      if (done % 200 === 0)
        console.error(`  ${done}/${files.length} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      failed.push({ path: f.path, err: String(err?.message ?? err) });
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

console.error(
  `done: ${done}/${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${localRoot}`
);
if (failed.length) {
  console.error(`FAILED (${failed.length}):`);
  for (const f of failed) console.error(`  ${f.path}: ${f.err}`);
  process.exit(1);
}
