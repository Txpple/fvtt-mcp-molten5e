// Hot-deploy a house module to the live Molten box over WebDAV (Plane B), and prove the
// bytes landed. Generalizes scripts/deploy-partystash.mjs + scripts/check-prod-bytes.mjs,
// which were written per-module and had to be cloned for every new one.
//
//   node scripts/deploy-house-module.mjs fvtt-mod-lootshelf
//   node scripts/deploy-house-module.mjs fvtt-mod-partystash --check   (compare only)
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
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { WebDavClient } from '../dist/tools/molten/webdav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const moduleId = args.find(a => !a.startsWith('--'));
if (!moduleId) {
  console.error('usage: node scripts/deploy-house-module.mjs <module-id> [--check]');
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
if (!env.MOLTEN_WEBDAV_PASSWORD) throw new Error('MOLTEN_WEBDAV_PASSWORD is not set in .env');

const dav = new WebDavClient({
  webdavUrl: env.MOLTEN_WEBDAV_URL,
  user: env.MOLTEN_WEBDAV_USER || 'foundry-ftp',
  password: env.MOLTEN_WEBDAV_PASSWORD,
});

const sha = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const asBuffer = raw => (Buffer.isBuffer(raw) ? raw : Buffer.from(raw));

const files = servedFiles();
const manifest = JSON.parse(readFileSync(join(REPO, 'module.json'), 'utf8'));
console.log(
  `${checkOnly ? 'Checking' : 'Deploying'} ${moduleId} v${manifest.version} ` +
    `(${files.length} files)\n`
);

let fails = 0;
for (const rel of files) {
  const dest = `modules/${moduleId}/${rel}`;
  const local = readFileSync(join(REPO, rel));
  try {
    if (!checkOnly) {
      const ext = rel.slice(rel.lastIndexOf('.'));
      await dav.ensureParents(dest);
      await dav.putFile(dest, local, CONTENT_TYPES[ext] ?? 'application/octet-stream');
    }
    // Read it straight back — a 2xx on PUT is not proof the bytes landed intact.
    const prod = asBuffer(await dav.getFile(dest));
    const ok = sha(local) === sha(prod);
    if (!ok) fails++;
    console.log(
      `  ${ok ? 'MATCH ' : 'DIFFER'} ${rel} (${local.length} bytes)` +
        (ok ? '' : ` — local=${sha(local)} prod=${sha(prod)}`)
    );
  } catch (err) {
    console.error(`  FAIL   ${rel}: ${err?.message || err}`);
    fails++;
  }
}

if (fails) {
  console.log(`\n${fails} file(s) did not match.`);
} else if (checkOnly) {
  console.log(`\nprod is byte-identical to the local v${manifest.version}.`);
} else {
  console.log(`\nUploaded ${moduleId} v${manifest.version}; prod is byte-identical.`);
  console.log('Scripts, styles and templates are live on the next world reload.');
  console.log(
    'module.json (version string, esmodules/styles lists) keeps vending the OLD ' +
      'values until the Foundry PROCESS restarts — expected, not a failure.'
  );
}
process.exit(fails ? 1 : 0);
