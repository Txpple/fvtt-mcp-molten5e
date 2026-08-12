// Tell every connected client to reload the world page — the second half of a hot module
// deploy (scripts/deploy-house-module.mjs).
//
// WHY IT IS NEEDED: a browser holds the module scripts it loaded at page load. Overwriting the
// files on the box changes what the NEXT load fetches and nothing else, so a client that has
// been sitting open since before the deploy keeps running the old code — and for a module
// whose work happens on an ELECTED client (Loot Shelf's kernel runs on `game.users.activeGM`,
// the highest-role active GM), that stale client is the one doing the work. A deploy is not
// live until the clients have come back.
//
// This is exactly what core does when a world setting demands it: `game.socket.emit("reload")`,
// which every client answers with `foundry.utils.debouncedReload`. It is a page refresh, not a
// world or server restart — never `game.shutDown()` through the bridge.
//
// Run: node scripts/reload-clients.mjs
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

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER ?? 'DM Assistant',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

await f.connect();
const before = await f.evaluate(
  () => ({
    users: game.users.filter(u => u.active).map(u => `${u.name}[role ${u.role}]`),
    activeGM: game.users.activeGM?.name ?? null,
  }),
  null
);
console.log(`connected clients: ${before.users.join(', ') || 'none'}`);
console.log(`GM-elect: ${before.activeGM ?? 'none'}`);

// Emitted only — this client is about to be disposed anyway, and reloading it would race the
// evaluate's own return.
await f.evaluate(() => {
  game.socket.emit('reload');
  return true;
}, null);
console.log('reload emitted to every connected client.');
await f.dispose?.();
