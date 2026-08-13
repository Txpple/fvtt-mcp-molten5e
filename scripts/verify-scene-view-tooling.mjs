// Live acceptance for activate-scene + pull-users-to-scene, driven through the page seam
// against the real world (fresh dist ⇒ no CC restart needed).
//
// The load-bearing claim under test is that VIEW and ACTIVE are independent: pulling a user
// to a scene must move THAT user's canvas while leaving game.scenes.active alone. That is the
// party-split behaviour the cross-scene teleporters already rely on.
//
// Run: node scripts/verify-scene-view-tooling.mjs [--activate "<scene>"]
// Without --activate it only READS + pulls the bridge user (restoring its view); with it, the
// named scene is actually activated (a visible change for every connected client).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const txt = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const argv = process.argv.slice(2);
const activateIdx = argv.indexOf('--activate');
const activateTarget = activateIdx >= 0 ? argv[activateIdx + 1] : null;

const env = loadEnv();
const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'DM Assistant',
  password: env.FOUNDRY_PASSWORD,
});

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const canvasState = () =>
  f.evaluate(
    () => ({
      canvasSceneId: globalThis.canvas?.scene?.id ?? null,
      canvasSceneName: globalThis.canvas?.scene?.name ?? null,
      activeSceneId: game.scenes?.find(s => s.active)?.id ?? null,
      activeSceneName: game.scenes?.find(s => s.active)?.name ?? null,
    }),
    null
  );

try {
  await f.connect();
  const me = await f.evaluate(() => ({ id: game.user.id, name: game.user.name }), null);
  const before = await canvasState();
  console.log(
    `\n[verify] bridge = ${me.name} (${me.id})\n[verify] active BEFORE: ${before.activeSceneName}\n`
  );

  // --- 1. activateScene: not-found path is honest ------------------------------------------
  console.log('1. activateScene — missing scene');
  const missing = await f.call('activateScene', { sceneIdentifier: 'ZZ No Such Scene' });
  check('reports notFound rather than throwing', missing?.success === false && !!missing?.notFound);

  // --- 2. pullUsersToScene: offline users are reported, not swallowed ----------------------
  console.log('\n2. pullUsersToScene — offline classification (core skips these silently)');
  // listUsers returns {success, count, users}; listScenes returns a bare array.
  const userList = (await f.call('listUsers', {}))?.users ?? [];
  const offlineUser = userList.find(u => !u.active && !u.isGM);
  if (offlineUser) {
    const res = await f.call('pullUsersToScene', {
      sceneIdentifier: before.activeSceneName,
      userIdentifiers: [offlineUser.name],
    });
    check(
      `offline user "${offlineUser.name}" lands in offline[], not pulled[]`,
      res?.offline?.some(u => u.name === offlineUser.name) && res?.pulled?.length === 0,
      JSON.stringify({ pulled: res?.pulled, offline: res?.offline })
    );
    check('success is false when nobody could actually be pulled', res?.success === false);
  } else {
    console.log('  (skipped — no offline non-GM user to test with)');
  }

  const unknown = await f.call('pullUsersToScene', {
    sceneIdentifier: before.activeSceneName,
    userIdentifiers: ['ZZ Nobody At All'],
  });
  check('unknown user lands in notFound[]', unknown?.notFound?.includes('ZZ Nobody At All'));

  // --- 3. self-pull is impossible, and we say so -------------------------------------------
  // pullUsers rides game.socket.emit, and a socket emit is relayed to the OTHER clients —
  // never echoed back to the sender. So the bridge can never pull ITSELF; proven live
  // 2026-08-13 (reported pulled, canvas never moved). It must land in selfSkipped.
  console.log('\n3. pullUsersToScene — the bridge cannot pull itself (socket never echoes back)');
  const scenes = await f.call('listScenes', {});
  const other = (scenes ?? []).find(s => !s.active);
  if (other) {
    const selfPull = await f.call('pullUsersToScene', {
      sceneIdentifier: other.name,
      userIdentifiers: [me.name],
    });
    check(
      'bridge user lands in selfSkipped[], NOT pulled[]',
      selfPull?.selfSkipped?.some(u => u.id === me.id) && selfPull?.pulled?.length === 0,
      JSON.stringify({ pulled: selfPull?.pulled, selfSkipped: selfPull?.selfSkipped })
    );

    await f.evaluate(() => new Promise(r => setTimeout(r, 3000)), null);
    const after = await canvasState();
    check(
      'and the bridge canvas is indeed unmoved (the behaviour selfSkipped documents)',
      after.canvasSceneId === before.canvasSceneId,
      `canvas=${after.canvasSceneName}`
    );
    check(
      'the ACTIVE scene is untouched by a pull',
      after.activeSceneId === before.activeSceneId,
      `active=${after.activeSceneName}, was=${before.activeSceneName}`
    );
  } else {
    console.log('  (skipped — no second scene available)');
  }

  // --- 3b. the real cross-client path, when a second client is connected -------------------
  // Needs a human at another browser: pass --target "<user>" to move THEIR view and prove
  // view-moves-while-active-stays end to end. Their client must be connected.
  const targetIdx = argv.indexOf('--target');
  const targetUser = targetIdx >= 0 ? argv[targetIdx + 1] : null;
  if (targetUser && other) {
    console.log(`\n3b. pullUsersToScene — pulling "${targetUser}" to "${other.name}"`);
    const res = await f.call('pullUsersToScene', {
      sceneIdentifier: other.name,
      userIdentifiers: [targetUser],
    });
    check(
      `"${targetUser}" reported pulled`,
      res?.pulled?.some(u => u.name === targetUser)
    );
    const after = await canvasState();
    check(
      'the ACTIVE scene STILL did not move (only their view did)',
      after.activeSceneId === before.activeSceneId
    );
    console.log(`  ↪ confirm by eye: ${targetUser}'s canvas should now show "${other.name}".`);
  } else if (!targetUser) {
    console.log('\n3b. cross-client pull — SKIPPED (pass --target "<connected user>")');
  }

  // --- 4. activateScene for real (opt-in) --------------------------------------------------
  if (activateTarget) {
    console.log(`\n4. activateScene — activating "${activateTarget}" for real`);
    const act = await f.call('activateScene', { sceneIdentifier: activateTarget });
    check('activate reported success', act?.success === true);
    check('activate was not a no-op', act?.alreadyActive === false, 'scene was already active');
    check(
      'the previously-active scene is reported back',
      act?.previous === null || typeof act?.previous?.name === 'string'
    );

    await f.evaluate(() => new Promise(r => setTimeout(r, 3000)), null);
    const post = await canvasState();
    check(
      'game.scenes.active is now the target',
      post.activeSceneId === act?.scene?.id,
      `active=${post.activeSceneName}`
    );

    const again = await f.call('activateScene', { sceneIdentifier: activateTarget });
    check('re-activating the same scene reports alreadyActive', again?.alreadyActive === true);
  } else {
    console.log('\n4. activateScene — SKIPPED (pass --activate "<scene>" to exercise it live)');
  }

  const end = await canvasState();
  console.log(`\n[verify] active AFTER: ${end.activeSceneName}`);
} catch (e) {
  fail++;
  console.error('[verify] ERROR:', e?.stack || e?.message || e);
} finally {
  await f.dispose();
  console.log(`\n[verify] RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
