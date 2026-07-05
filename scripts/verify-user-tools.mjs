// Live verification: list-users + update-user — the user-account admin pair (src/page/users.ts).
//
// Claims under test:
//   1. listUsers returns every account with role/roleLabel/active/character and flags the bridge user.
//   2. updateUser changes a role (trusted → player) and echoes previous → new.
//   3. Re-applying the same role is a clean no-op (applied: []).
//   4. color / pronouns / name apply and echo previous values.
//   5. character assigns an actor by name, warns on a non-"character" type, and "none" clears it.
//   6. Guard: the bridge user's own role cannot be changed.
//   7. Guard: the world's last GAMEMASTER cannot be demoted.
//   8. Unknown user errors with the roster; case-insensitive name resolution works.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixture user +
// actor, cleaned in finally. Build first: npm run build. Run: node scripts/verify-user-tools.mjs
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

const TAG = 'ZZ-USERTEST';
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

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let userId;
let actorId;
let npcId;

try {
  console.log('[verify-users] connecting…');
  await f.connect();
  console.log('[verify-users] connected\n');

  console.log('# setup fixtures (throwaway user + PC + NPC)');
  ({ userId, actorId, npcId } = await f.evaluate(async tag => {
    const u = await User.create({ name: tag, role: CONST.USER_ROLES.TRUSTED });
    const a = await Actor.create({ name: `${tag} PC`, type: 'character' });
    const n = await Actor.create({ name: `${tag} NPC`, type: 'npc' });
    return { userId: u.id, actorId: a.id, npcId: n.id };
  }, TAG));
  console.log(`  user ${userId}, pc ${actorId}, npc ${npcId}\n`);

  console.log('# 1) listUsers — roster shape + bridge-user flag');
  const list = await f.call('listUsers');
  assert(list.success === true && Array.isArray(list.users), 'returns { success, users[] }');
  assert(list.count === list.users.length, 'count matches users.length');
  const me = list.users.find(u => u.isBridgeUser);
  assert(!!me, 'bridge user flagged');
  const fixture = list.users.find(u => u.id === userId);
  assert(
    fixture?.role === 2 && fixture?.roleLabel === 'trusted',
    `fixture listed as role 2 (trusted): ${fixture?.role} (${fixture?.roleLabel})`
  );
  assert(typeof fixture?.active === 'boolean', 'active is a boolean');

  console.log('# 2) role change trusted → player');
  const r2 = await f.call('updateUser', { user: userId, role: 'player' });
  assert(r2.applied?.includes('role'), 'applied includes role');
  assert(
    r2.previous?.role === '2 (trusted)',
    `previous echoes "2 (trusted)": ${r2.previous?.role}`
  );
  assert(r2.user?.role === 1 && r2.user?.roleLabel === 'player', 'echo shows role 1 (player)');
  const liveRole = await f.evaluate(id => game.users.get(id).role, userId);
  assert(liveRole === 1, `live document role = ${liveRole}`);

  console.log('# 3) same role again — clean no-op');
  const r3 = await f.call('updateUser', { user: userId, role: 'player' });
  assert(Array.isArray(r3.applied) && r3.applied.length === 0, 'applied is empty');

  console.log('# 4) color + pronouns + name');
  const r4 = await f.call('updateUser', {
    user: userId,
    color: '#ff8800',
    pronouns: 'they/them',
    name: `${TAG} Renamed`,
  });
  assert(
    ['color', 'pronouns', 'name'].every(k => r4.applied?.includes(k)),
    `applied color+pronouns+name: ${JSON.stringify(r4.applied)}`
  );
  const live4 = await f.evaluate(
    id => ({
      color: game.users.get(id).color?.css,
      pronouns: game.users.get(id).pronouns,
      name: game.users.get(id).name,
    }),
    userId
  );
  assert(live4.color === '#ff8800', `live color = ${live4.color}`);
  assert(live4.pronouns === 'they/them', `live pronouns = ${live4.pronouns}`);
  assert(live4.name === `${TAG} Renamed`, `live name = ${live4.name}`);

  console.log('# 5) character: assign by name, npc warning, clear with "none"');
  const r5a = await f.call('updateUser', { user: userId, character: `${TAG} PC` });
  assert(r5a.applied?.includes('character'), 'applied includes character');
  assert(r5a.user?.character?.id === actorId, 'character resolved to the PC actor');
  assert(!r5a.warnings, 'no warning for a type "character" actor');
  const r5b = await f.call('updateUser', { user: userId, character: `${TAG} NPC` });
  assert(
    r5b.warnings?.some(w => /not a player character/.test(w)),
    'npc assignment warns but applies'
  );
  const r5c = await f.call('updateUser', { user: userId, character: 'none' });
  assert(r5c.applied?.includes('character'), '"none" applies');
  const liveChar = await f.evaluate(id => game.users.get(id).character?.id ?? null, userId);
  assert(liveChar === null, 'live character cleared');

  console.log('# 6) guard — bridge user cannot change its own role');
  let ownThrew = false;
  try {
    await f.call('updateUser', { user: me.id, role: 'player' });
  } catch (e) {
    ownThrew = /bridge user/i.test(e?.message || '');
  }
  assert(ownThrew, 'own-role change refused');
  const bridgeRole = await f.evaluate(() => game.user.role);
  assert(bridgeRole === me.role, 'bridge role unchanged');

  console.log('# 7) guard — last GAMEMASTER cannot be demoted');
  const gms = list.users.filter(u => u.role === 4);
  if (gms.length === 1) {
    let gmThrew = false;
    try {
      await f.call('updateUser', { user: gms[0].id, role: 'player' });
    } catch (e) {
      gmThrew = /only GAMEMASTER/i.test(e?.message || '');
    }
    assert(gmThrew, `demoting the only gamemaster ("${gms[0].name}") refused`);
    const gmRole = await f.evaluate(id => game.users.get(id).role, gms[0].id);
    assert(gmRole === 4, 'gamemaster role unchanged');
  } else {
    console.log(`  SKIP  world has ${gms.length} gamemasters — guard not exercisable safely`);
  }

  console.log('# 8) resolution — unknown user errors with roster; case-insensitive name works');
  let unknownThrew = false;
  try {
    await f.call('updateUser', { user: 'ZZ-NO-SUCH-USER', role: 'player' });
  } catch (e) {
    unknownThrew = /not found.*Users in this world/is.test(e?.message || '');
  }
  assert(unknownThrew, 'unknown user error lists the roster');
  const r8 = await f.call('updateUser', { user: `${TAG.toLowerCase()} renamed`, role: 'trusted' });
  assert(r8.user?.id === userId, 'case-insensitive name resolved the fixture');
  assert(r8.user?.role === 2, 'role restored to trusted via lowercase identifier');
} finally {
  const ids = { userId, actorId, npcId };
  await f
    .evaluate(async ({ userId, actorId, npcId }) => {
      if (userId) await game.users.get(userId)?.delete();
      if (actorId) await game.actors.get(actorId)?.delete();
      if (npcId) await game.actors.get(npcId)?.delete();
    }, ids)
    .catch(e => console.log(`[verify-users] cleanup failed: ${e?.message}`));
  console.log('\n[verify-users] fixtures cleaned');
  await f.dispose?.();
}

console.log(`\n[verify-users] ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
