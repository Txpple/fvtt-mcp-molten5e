// Read every Foundry user's avatar + colour — the values behind chat-message portraits.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m) env[m[1]] = m[2];
}
const f = new Foundry({ serverUrl: env.MOLTEN_SERVER_URL, magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude', password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY, worldId: env.MOLTEN_WORLD_ID });
await f.connect();
const rows = await f.evaluate(() => game.users.map(u => ({
  name: u.name, role: u.role,
  avatarRaw: u._source?.avatar ?? null,   // what is actually stored
  avatarResolved: u.avatar,               // what the UI renders
  character: u.character?.name ?? null,
  charImg: u.character?.img ?? null
})), null);
for (const r of rows) {
  console.log(`${r.name.padEnd(16)} role=${r.role}`);
  console.log(`   stored : ${r.avatarRaw ?? '(none)'}`);
  console.log(`   renders: ${r.avatarResolved}`);
  if (r.character) console.log(`   char   : ${r.character} — ${r.charImg}`);
}
await f.dispose();
