// Live verification: set-actor-ownership INHERIT vs NONE (src/page/ownership.ts + src/tools/ownership.ts).
//
// The semantic being proved: in Foundry an ABSENT ownership key inherits `ownership.default`,
// while an EXPLICIT 0 overrides it. So on a shared actor whose default is OWNER (the party
// stash shape), NONE must actively DENY the player and INHERIT must restore the inherited level
// by removing the key entirely.
//
// Claims under test:
//   1. NONE stores an explicit 0 — the key is PRESENT and the user loses the default's OWNER.
//   2. INHERIT REMOVES the key — absent from the live document, and the default applies again.
//      (The `{"ownership.-=<id>": null}` idiom silently no-ops here; this proves the rewrite path.)
//   3. INHERIT is idempotent when there is no explicit entry.
//   4. A granted level (OBSERVER) still merges without disturbing `default` or other users.
//   5. End-to-end through OwnershipTools: permissionLevel 'INHERIT' → permission null on the wire.
//   6. INHERIT never touches the `default` key or other users' entries.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixture user +
// actor, cleaned in finally. Build first: npm run build. Run: node scripts/verify-ownership-inherit.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';
import { OwnershipTools } from '../dist/tools/ownership.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].trim();
}

const TAG = 'ZZ-OWNTEST';
// A distinct name for the bystander player — the tool's player lookup does PARTIAL matching, so
// "ZZ-OWNTEST-2" would also match TAG and turn the single assignment into a blocked bulk op.
const TAG2 = 'ZZ-BYSTANDER';
let passes = 0;
let fails = 0;
function assert(cond, msg) {
  if (cond) {
    passes++;
    console.log(`  PASS  ${msg}`);
  } else {
    fails++;
    console.log(`  FAIL  ${msg}`);
  }
}

// Minimal Logger stand-in (src/logger.ts shape).
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

// Read the fixture actor's raw ownership map + the user's EFFECTIVE permission.
const readState = (actorId, userId) =>
  f.evaluate(
    ids => {
      const actor = game.actors.get(ids.actorId);
      const user = game.users.get(ids.userId);
      const ownership = { ...(actor.ownership ?? {}) };
      return {
        ownership,
        hasKey: Object.hasOwn(ownership, ids.userId),
        stored: ownership[ids.userId] ?? null,
        effective: actor.testUserPermission(user, 'OWNER')
          ? 3
          : actor.testUserPermission(user, 'OBSERVER')
            ? 2
            : actor.testUserPermission(user, 'LIMITED')
              ? 1
              : 0,
      };
    },
    { actorId, userId }
  );

let userId;
let otherUserId;
let actorId;

try {
  console.log('[verify-ownership] connecting…');
  await f.connect();
  console.log('[verify-ownership] connected\n');

  console.log('# setup fixtures (2 throwaway players + a shared actor defaulting to OWNER)');
  ({ userId, otherUserId, actorId } = await f.evaluate(
    async tags => {
      const u = await User.create({ name: tags.tag, role: CONST.USER_ROLES.PLAYER });
      const u2 = await User.create({ name: tags.tag2, role: CONST.USER_ROLES.PLAYER });
      // The party-stash shape: everyone inherits OWNER from `default`.
      const a = await Actor.create({
        name: `${tags.tag} Stash`,
        type: 'npc',
        ownership: { default: 3, [u2.id]: 2 },
      });
      return { userId: u.id, otherUserId: u2.id, actorId: a.id };
    },
    { tag: TAG, tag2: TAG2 }
  ));
  console.log(`  users ${userId} / ${otherUserId}, actor ${actorId}\n`);

  const baseline = await readState(actorId, userId);
  assert(!baseline.hasKey && baseline.effective === 3, 'baseline: no key, inherits OWNER (3)');

  console.log('# 1) NONE stores an EXPLICIT 0 that overrides the permissive default');
  const r1 = await f.call('setActorOwnership', { actorId, userId, permission: 0 });
  const s1 = await readState(actorId, userId);
  assert(r1.success === true, 'setActorOwnership(0) reports success');
  assert(
    s1.hasKey && s1.stored === 0,
    `key present with stored 0 (got ${JSON.stringify(s1.stored)})`
  );
  assert(
    s1.effective === 0,
    `effective permission dropped to NONE despite default 3 (got ${s1.effective})`
  );
  assert(/explicit deny/.test(r1.message), `message names it a deny: "${r1.message}"`);

  console.log('# 2) INHERIT removes the key — the default applies again');
  const r2 = await f.call('setActorOwnership', { actorId, userId, permission: null });
  const s2 = await readState(actorId, userId);
  assert(r2.success === true, 'setActorOwnership(null) reports success');
  assert(
    s2.hasKey === false,
    `key REMOVED from the live document (ownership: ${JSON.stringify(s2.ownership)})`
  );
  assert(s2.effective === 3, `effective permission back to inherited OWNER (got ${s2.effective})`);
  assert(
    /inherits the actor default \(OWNER\)/.test(r2.message),
    `message reports the inherited level: "${r2.message}"`
  );

  console.log('# 3) INHERIT again is a clean no-op');
  const r3 = await f.call('setActorOwnership', { actorId, userId, permission: null });
  const s3 = await readState(actorId, userId);
  assert(r3.success === true && s3.hasKey === false, 'still absent, still success');
  assert(/already inheriting/.test(r3.message), `message says already inheriting: "${r3.message}"`);

  console.log('# 4) a granted level still merges');
  await f.call('setActorOwnership', { actorId, userId, permission: 2 });
  const s4 = await readState(actorId, userId);
  assert(
    s4.stored === 2 && s4.effective === 2,
    `stored OBSERVER (got ${s4.stored}/${s4.effective})`
  );

  console.log('# 5) end-to-end through the TOOL (permissionLevel: INHERIT)');
  const tools = new OwnershipTools({ foundry: f, logger });
  const out = await tools.handleToolCall('set-actor-ownership', {
    actorIdentifier: `${TAG} Stash`,
    playerIdentifier: TAG,
    permissionLevel: 'INHERIT',
  });
  const s5 = await readState(actorId, userId);
  assert(out.success === true, `tool reports success (${out.message})`);
  assert(out.results?.[0]?.permission === 'INHERIT', 'result echoes permission INHERIT');
  assert(s5.hasKey === false, 'tool path removed the key too');
  assert(s5.effective === 3, `tool path restored the inherited OWNER (got ${s5.effective})`);

  console.log('# 6) `default` and the other player were never disturbed');
  assert(s5.ownership.default === 3, `default still 3 (got ${s5.ownership.default})`);
  assert(
    s5.ownership[otherUserId] === 2,
    `other player still OBSERVER (got ${s5.ownership[otherUserId]})`
  );

  console.log(`\n${fails === 0 ? 'ALL GREEN' : 'FAILURES'} — ${passes} passed, ${fails} failed`);
  process.exitCode = fails === 0 ? 0 : 1;
} catch (e) {
  console.error('[verify-ownership] ERROR:', e?.message || e);
  process.exitCode = 1;
} finally {
  // Clean up the fixtures — a leftover user id on an actor is exactly the stale-entry mess
  // scripts/clean-stale-ownership.mjs had to sweep up.
  try {
    const left = await f.evaluate(
      async ids => {
        for (const id of [ids.userId, ids.otherUserId]) await game.users.get(id)?.delete();
        await game.actors.get(ids.actorId)?.delete();
        return {
          users: [ids.userId, ids.otherUserId].filter(id => game.users.get(id)).length,
          actor: game.actors.get(ids.actorId) ? 1 : 0,
          stale: game.actors.contents.filter(a =>
            Object.keys(a.ownership ?? {}).some(id => id !== 'default' && !game.users.get(id))
          ).length,
        };
      },
      { userId, otherUserId, actorId }
    );
    console.log(
      `# cleanup: ${left.users} fixture users left, ${left.actor} fixture actors left, ` +
        `${left.stale} actor(s) world-wide carrying a stale ownership entry`
    );
  } catch (e) {
    console.error('[verify-ownership] cleanup ERROR:', e?.message || e);
  }
  await f.dispose();
}
