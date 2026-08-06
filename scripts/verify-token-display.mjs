// Live acceptance for update-actor's prototype-token DISPLAY fields (tokenDisplayName /
// tokenDisplayBars): drive the tool's bridge path on a real actor and read the prototype back.
//   node scripts/verify-token-display.mjs [actorId]     # default: a Greenrest "Extras" actor
// Build first if dist is stale: npm run build.
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

const ACTOR = process.argv[2] || 'w4bENQ7PaWf8upSo'; // "Villager 01" (Greenrest > Extras > Crowds)

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const read = id =>
  f.evaluate(
    ({ id }) => {
      const a = game.actors.get(id);
      return a
        ? { displayName: a.prototypeToken.displayName, displayBars: a.prototypeToken.displayBars }
        : { error: 'actor not found' };
    },
    { id }
  );

let fails = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails++;
};

try {
  console.log('[verify-token-display] connecting…');
  await f.connect();
  console.log(`[verify-token-display] connected; test actor ${ACTOR}\n`);

  // 1) set a visible mode via the tool path → expect the mapped numbers on the prototype.
  const r1 = await f.call('updateActor', {
    actorIdentifier: ACTOR,
    tokenDisplayName: 'hover',
    tokenDisplayBars: 'owner',
  });
  const a1 = await read(ACTOR);
  check(
    'applied lists both fields',
    ['tokenDisplayName', 'tokenDisplayBars'].every(x => r1.applied?.includes(x)),
    JSON.stringify(r1.applied)
  );
  check('hover → displayName 30', a1.displayName === 30, `got ${a1.displayName}`);
  check('owner → displayBars 40', a1.displayBars === 40, `got ${a1.displayBars}`);

  // 2) restore to the window-dressing default (none) → expect 0 / 0.
  await f.call('updateActor', {
    actorIdentifier: ACTOR,
    tokenDisplayName: 'none',
    tokenDisplayBars: 'none',
  });
  const a2 = await read(ACTOR);
  check('none → displayName 0', a2.displayName === 0, `got ${a2.displayName}`);
  check('none → displayBars 0', a2.displayBars === 0, `got ${a2.displayBars}`);

  // 3) page-layer defense: an invalid mode warns and is skipped, while a valid companion field
  //    still applies (zod already blocks bad enums in the real tool; this covers a raw f.call).
  const r3 = await f.call('updateActor', {
    actorIdentifier: ACTOR,
    tokenDisplayName: 'sometimes',
    tokenDisplayBars: 'none',
  });
  const a3 = await read(ACTOR);
  check(
    'invalid mode warns',
    (r3.warnings ?? []).some(w => /tokenDisplayName/.test(w)),
    JSON.stringify(r3.warnings)
  );
  check(
    'invalid skipped, valid companion applied',
    !(r3.applied ?? []).includes('tokenDisplayName') &&
      (r3.applied ?? []).includes('tokenDisplayBars') &&
      a3.displayName === 0
  );

  console.log(`\n==== verify-token-display: ${fails ? `${fails} FAIL(s)` : 'PASS'} ====`);
  process.exitCode = fails ? 1 : 0;
} finally {
  await f.dispose().catch(() => {});
}
