// Hot-deploy fvtt-mod-partystash to the live Molten box over WebDAV (Plane B).
//
// Registration is a SEPARATE, one-time act (scripts/register-partystash.mjs) — the package
// registry is scanned at server PROCESS boot, so a brand-new module has to go in through
// Foundry's own installPackage. An ALREADY-REGISTERED module's FILES, though, are served off
// disk per request, so overwriting them and reloading the world is enough for script and style
// changes to take effect.
//
// The manifest is the exception: `game.modules` is built from the boot-time scan, so a
// module.json edit (new version string, a new `styles` entry) does NOT take effect until the
// next process restart. This script uploads it anyway — so the box is correct whenever it does
// restart — and REPORTS the lag rather than pretending it landed.
//
// Run: node scripts/deploy-partystash.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebDavClient } from '../dist/tools/molten/webdav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const MODULE_ID = 'fvtt-mod-partystash';
const REPO = join(__dirname, '..', '..', 'fvtt-mod-partystash');
const FILES = [
  ['module.json', 'application/json'],
  ['scripts/partystash.js', 'text/javascript'],
  ['styles/partystash.css', 'text/css'],
];

if (!env.MOLTEN_WEBDAV_PASSWORD) throw new Error('MOLTEN_WEBDAV_PASSWORD is not set in .env');

const dav = new WebDavClient({
  webdavUrl: env.MOLTEN_WEBDAV_URL,
  user: env.MOLTEN_WEBDAV_USER || 'foundry-ftp',
  password: env.MOLTEN_WEBDAV_PASSWORD,
});

let fails = 0;
for (const [rel, contentType] of FILES) {
  const dest = `modules/${MODULE_ID}/${rel}`;
  try {
    const body = readFileSync(join(REPO, rel));
    await dav.ensureParents(dest);
    await dav.putFile(dest, body, contentType);
    // Read it straight back — a 2xx on PUT is not proof the bytes landed intact.
    const back = await dav.getFile(dest);
    const got = Buffer.isBuffer(back) ? back : Buffer.from(back);
    const same = got.length === body.length;
    console.log(
      `  ${same ? 'OK  ' : 'WARN'} ${dest} (${body.length} bytes${same ? '' : ` — read back ${got.length}`})`
    );
    if (!same) fails++;
  } catch (err) {
    console.error(`  FAIL ${dest}: ${err?.message || err}`);
    fails++;
  }
}

const manifest = JSON.parse(readFileSync(join(REPO, 'module.json'), 'utf8'));
console.log(`\nUploaded ${MODULE_ID} v${manifest.version}.`);
console.log('Scripts + styles are live on the next world reload.');
console.log(
  'module.json (version string, styles list) will keep vending the OLD values until the ' +
    'Foundry PROCESS restarts — expected, not a failure.'
);
process.exit(fails ? 1 : 0);
