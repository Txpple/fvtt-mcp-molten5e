// Confirm the files live on the Molten box are byte-identical to the local repo copies.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { WebDavClient } from '../dist/tools/molten/webdav.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m) env[m[1]] = m[2];
}
const REPO = join(__dirname, '..', '..', 'fvtt-mod-partystash');
const dav = new WebDavClient({ webdavUrl: env.MOLTEN_WEBDAV_URL,
  user: env.MOLTEN_WEBDAV_USER || 'foundry-ftp', password: env.MOLTEN_WEBDAV_PASSWORD });
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 16);
let bad = 0;
for (const rel of ['module.json', 'scripts/partystash.js', 'styles/partystash.css']) {
  const local = readFileSync(join(REPO, rel));
  const raw = await dav.getFile(`modules/fvtt-mod-partystash/${rel}`);
  const prod = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const ok = sha(local) === sha(prod);
  if (!ok) bad++;
  console.log(`  ${ok ? 'MATCH' : 'DIFFER'}  ${rel}  local=${sha(local)} prod=${sha(prod)}`);
}
console.log(bad ? `\n${bad} file(s) differ` : '\nprod is byte-identical to the shipped v1.3.0');
process.exit(bad ? 1 : 0);
