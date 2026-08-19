// Hot-deploy a house module to the live Molten box over WebDAV (Plane B), and prove the
// bytes landed. Generalizes scripts/deploy-partystash.mjs + scripts/check-prod-bytes.mjs,
// which were written per-module and had to be cloned for every new one.
//
//   node scripts/deploy-house-module.mjs fvtt-mod-lootshelf
//   node scripts/deploy-house-module.mjs fvtt-mod-partystash --check   (compare only)
//   node scripts/deploy-house-module.mjs fvtt-mod-battleflow --local   (LOCAL sandbox, not prod)
//
// TARGETS: by default this deploys to PROD over WebDAV. `--local` instead writes straight into
// the local sandbox's Data/modules (LOCAL_FOUNDRY_DATA — see docs/local-sandbox.md); it is a
// plain filesystem copy with the same byte read-back proof, and it never touches prod. That is
// the loop a sister module repo wants: build → --local → test against foundry-local5e → only
// then deploy for real. ⚠️ A sandbox REFRESH (pull-prod-to-local.mjs) mirrors prod's modules/
// and will overwrite or delete a locally-deployed module — re-run --local after every refresh.
//
// WHAT IT UPLOADS: module.json plus everything the module SERVES — scripts/, styles/,
// templates/, lang/. Not the README, the design docs, or tools/: those never leave the repo.
// The file list is walked from disk rather than read out of module.json, because a module's
// ESM graph pulls in files the manifest never names (an `import "./receipts.js"` is invisible
// to `esmodules`), and a template is fetched by path at runtime.
//
// WHAT REGISTRATION IS FOR: the package registry is scanned at server PROCESS boot, so a
// BRAND-NEW module has to go in through Foundry's own installPackage (scripts/register-
// module.mjs) — this script only refreshes the files of an already-registered one. Their
// content is served off disk per request, so overwriting them and reloading the world is
// enough for scripts, styles and templates. The manifest is the exception: `game.modules` is
// built from that boot-time scan, so a module.json edit (a new version string, a new `styles`
// entry) does NOT take effect until the process next restarts. It is uploaded anyway, so the
// box is right whenever that happens, and the lag is REPORTED rather than pretended away.
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { WebDavClient } from '../dist/tools/molten/webdav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const toLocal = args.includes('--local');
const moduleId = args.find(a => !a.startsWith('--'));
if (!moduleId) {
  console.error('usage: node scripts/deploy-house-module.mjs <module-id> [--check] [--local]');
  process.exit(2);
}

const REPO = join(__dirname, '..', '..', moduleId);
if (!existsSync(join(REPO, 'module.json'))) {
  console.error(`No module.json at ${REPO} — is the repo cloned beside this one?`);
  process.exit(2);
}

/** Directories whose contents the module serves at runtime. */
const SERVED_DIRS = ['scripts', 'styles', 'templates', 'lang'];
const CONTENT_TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.hbs': 'text/plain',
  '.html': 'text/html',
};

/** Every served file in the repo, as repo-relative posix paths. */
function servedFiles() {
  const out = ['module.json'];
  const walk = rel => {
    for (const entry of readdirSync(join(REPO, rel)).sort()) {
      const child = posix.join(rel, entry);
      if (statSync(join(REPO, child)).isDirectory()) walk(child);
      else out.push(child);
    }
  };
  for (const dir of SERVED_DIRS) if (existsSync(join(REPO, dir))) walk(dir);
  return out;
}

const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}
/**
 * One write/read-back target so the deploy loop below is identical for both planes: prod goes
 * over WebDAV, the sandbox goes straight to disk. Both re-READ what they wrote — a successful
 * write is not proof the bytes landed.
 */
let target;
if (toLocal) {
  const dataRoot = env.LOCAL_FOUNDRY_DATA;
  if (!dataRoot) {
    console.error('LOCAL_FOUNDRY_DATA is not set in .env (see docs/local-sandbox.md).');
    process.exit(2);
  }
  if (!existsSync(dataRoot)) {
    console.error(`LOCAL_FOUNDRY_DATA does not exist: ${dataRoot}`);
    process.exit(2);
  }
  const abs = rel => join(dataRoot, ...rel.split('/'));
  target = {
    label: `local sandbox (${dataRoot})`,
    ensureParents: async rel => mkdirSync(dirname(abs(rel)), { recursive: true }),
    put: async (rel, body) => writeFileSync(abs(rel), body),
    get: async rel => readFileSync(abs(rel)),
    liveHint:
      'Restart the local Foundry process to pick up module.json changes; a world reload is ' +
      'enough for scripts, styles and templates.',
  };
} else {
  if (!env.MOLTEN_WEBDAV_PASSWORD) throw new Error('MOLTEN_WEBDAV_PASSWORD is not set in .env');
  const dav = new WebDavClient({
    webdavUrl: env.MOLTEN_WEBDAV_URL,
    user: env.MOLTEN_WEBDAV_USER || 'foundry-ftp',
    password: env.MOLTEN_WEBDAV_PASSWORD,
  });
  target = {
    label: 'prod (Molten, over WebDAV)',
    ensureParents: rel => dav.ensureParents(rel),
    put: (rel, body, contentType) => dav.putFile(rel, body, contentType),
    get: rel => dav.getFile(rel),
    liveHint:
      'Scripts, styles and templates are live on the next world reload. module.json (version ' +
      'string, esmodules/styles lists) keeps vending the OLD values until the Foundry PROCESS ' +
      'restarts — expected, not a failure.',
  };
}

const sha = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const asBuffer = raw => (Buffer.isBuffer(raw) ? raw : Buffer.from(raw));

const files = servedFiles();
const manifest = JSON.parse(readFileSync(join(REPO, 'module.json'), 'utf8'));
console.log(
  `${checkOnly ? 'Checking' : 'Deploying'} ${moduleId} v${manifest.version} ` +
    `(${files.length} files) -> ${target.label}\n`
);

let fails = 0;
for (const rel of files) {
  const dest = `modules/${moduleId}/${rel}`;
  const local = readFileSync(join(REPO, rel));
  try {
    if (!checkOnly) {
      const ext = rel.slice(rel.lastIndexOf('.'));
      await target.ensureParents(dest);
      await target.put(dest, local, CONTENT_TYPES[ext] ?? 'application/octet-stream');
    }
    // Read it straight back — a 2xx on PUT is not proof the bytes landed intact.
    const remote = asBuffer(await target.get(dest));
    const ok = sha(local) === sha(remote);
    if (!ok) fails++;
    console.log(
      `  ${ok ? 'MATCH ' : 'DIFFER'} ${rel} (${local.length} bytes)` +
        (ok ? '' : ` — local=${sha(local)} deployed=${sha(remote)}`)
    );
  } catch (err) {
    console.error(`  FAIL   ${rel}: ${err?.message || err}`);
    fails++;
  }
}

const where = toLocal ? 'the sandbox' : 'prod';
if (fails) {
  console.log(`\n${fails} file(s) did not match.`);
} else if (checkOnly) {
  console.log(`\n${where} is byte-identical to the local v${manifest.version}.`);
} else {
  console.log(`\nDeployed ${moduleId} v${manifest.version}; ${where} is byte-identical.`);
  console.log(target.liveHint);
  if (toLocal) {
    console.log(
      '⚠ A sandbox refresh (pull-prod-to-local.mjs) mirrors prod and will overwrite this — ' +
        're-run --local after every refresh.'
    );
  }
}
process.exit(fails ? 1 : 0);
