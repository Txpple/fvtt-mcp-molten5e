// LIVE verification for set-landing-scene + fvtt-mod-openserver's landing-scene routing.
//
// The interesting half is not the flag write (that's a document update) but whether the MODULE
// actually routes a client at login. So this uses the BRIDGE ITSELF as the guinea pig: the bridge
// is a real Foundry client that loads modules, so flagging it and forcing a full reconnect is a
// genuine end-to-end login test — page load -> module `ready` hook -> Scene#view().
//
// Everything it sets on the bridge user is cleared in `finally`.
//
// Build first: npm run build.  Run: node scratch/verify-landing-scene.mjs
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

const LANDING = "Former Adventurers' Camp";
const ACTIVE = 'Party Camp';

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

/** Full page reload = a real login for the bridge client. */
const relogin = async () => {
  await f.dispose();
  await f.connect();
};
const viewedScene = () => f.evaluate(() => game.scenes.viewed?.name ?? null, null);
const bridgeName = () => f.evaluate(() => game.user.name, null);

try {
  console.log('[verify-landing-scene] connecting…');
  await f.connect();
  const me = await bridgeName();
  console.log(`[verify-landing-scene] connected as "${me}"\n`);

  console.log('— the module that does the routing —');
  const mod = await f.evaluate(() => {
    const m = game.modules.get('fvtt-mod-openserver');
    return m ? { active: m.active, version: m.version } : null;
  }, null);
  console.log(`  fvtt-mod-openserver: ${JSON.stringify(mod)}`);
  assert(!!mod, 'the house module is installed in this world');
  assert(mod?.active, 'the house module is ENABLED (without it the flag is inert data)');
  // module.json is read at server PROCESS boot, so the version string lags a WebDAV deploy.
  // The SCRIPT is served per request, so the new code is live regardless — check the code, not
  // the version, or this reads as a failed deploy when it is only a stale manifest.
  const hasNewCode = await f.evaluate(
    async () =>
      (await fetch('modules/fvtt-mod-openserver/scripts/openserver.js').then(r => r.text())).includes(
        'landingScene'
      ),
    null
  );
  assert(hasNewCode, 'the DEPLOYED module script contains the landing-scene code');

  console.log('\n— baseline —');
  const active = await f.evaluate(() => game.scenes.active?.name ?? null, null);
  console.log(`  active scene: ${active} · bridge is viewing: ${await viewedScene()}`);
  assert(active === ACTIVE, `the active scene is "${ACTIVE}"`);

  console.log('\n— setLandingScene writes the flag —');
  const set = await f.call('setLandingScene', {
    sceneIdentifier: LANDING,
    userIdentifiers: [me],
  });
  console.log(`  ${JSON.stringify(set, null, 2).replace(/\n/g, '\n  ')}`);
  assert(set.success === true, 'reports success');
  assert(set.assigned.length === 1 && set.assigned[0].name === me, 'assigned the bridge user');
  assert(set.cleared === false, 'not reported as a clear');
  assert(
    (set.warnings ?? []).some(w => w.includes('BRIDGE user')),
    'WARNS that the target is the bridge user (rarely intended)'
  );
  assert(set.activeScene?.name === ACTIVE, 'reports the active scene for contrast');
  assert(
    Array.isArray(set.followActive) && !set.followActive.some(u => u.name === me),
    'the newly-assigned user no longer counts as following the active scene'
  );

  console.log('\n— it round-trips through list-users (the read) —');
  const listed = (await f.call('listUsers', {})).users.find(u => u.name === me);
  console.log(`  ${JSON.stringify(listed.landingScene)}`);
  assert(listed?.landingScene?.name === LANDING, 'list-users resolves landingScene to a name');

  console.log('\n— a second identical set is a no-op, not a fake success —');
  const again = await f.call('setLandingScene', {
    sceneIdentifier: LANDING,
    userIdentifiers: [me],
  });
  assert(again.assigned.length === 0, 'nothing re-assigned');
  assert(again.unchanged.length === 1, 'reported as unchanged');

  console.log('\n— ⭐ THE REAL TEST: full reconnect = a login. Does the module route it? —');
  await relogin();
  const landed = await viewedScene();
  console.log(`  after login the bridge is viewing: ${landed}`);
  assert(landed === LANDING, `the client LANDED ON "${LANDING}", not the active "${ACTIVE}"`);
  const logged = await f.evaluate(
    () => game.scenes.active?.name ?? null,
    null
  );
  assert(logged === ACTIVE, 'and the ACTIVE scene was not changed for anyone else');

  console.log('\n— clearing puts the user back on the active scene —');
  const cleared = await f.call('setLandingScene', {
    sceneIdentifier: 'none',
    userIdentifiers: [me],
  });
  assert(cleared.cleared === true, 'reported as a clear');
  assert(cleared.assigned[0]?.previous === LANDING, 'names the assignment it removed');
  assert(
    (cleared.followActive ?? []).some(u => u.name === me),
    'the user is back among those following the active scene'
  );
  const clearedRead = (await f.call('listUsers', {})).users.find(u => u.name === me);
  assert(clearedRead?.landingScene === null, 'list-users reports no landing scene');

  await relogin();
  const backHome = await viewedScene();
  console.log(`  after login the bridge is viewing: ${backHome}`);
  assert(backHome === ACTIVE, `cleared user lands on the active "${ACTIVE}" again`);

  console.log('\n— a clear on an unassigned user is a no-op —');
  const noop = await f.call('setLandingScene', {
    sceneIdentifier: 'none',
    userIdentifiers: [me],
  });
  assert(noop.assigned.length === 0 && noop.unchanged.length === 1, 'reported as unchanged');

  console.log('\n— bad input is reported, not guessed —');
  const ghost = await f.call('setLandingScene', {
    sceneIdentifier: 'Ghost Camp',
    userIdentifiers: [me],
  });
  assert(ghost.success === false && ghost.sceneNotFound === 'Ghost Camp', 'unknown scene reported');
  const nobody = await f.call('setLandingScene', {
    sceneIdentifier: ACTIVE,
    userIdentifiers: ['Nobody At All'],
  });
  assert(nobody.notFound.includes('Nobody At All'), 'unknown user reported');
  assert(nobody.assigned.length === 0, 'and nothing was assigned');
} catch (err) {
  fails++;
  console.error('\nERROR:', err?.stack || err);
} finally {
  // Never leave the bridge pinned to a side scene.
  try {
    await f.call('setLandingScene', {
      sceneIdentifier: 'none',
      userIdentifiers: [await bridgeName()],
    });
    console.log('\ncleanup: bridge landing scene cleared.');
  } catch (e) {
    console.error('cleanup FAILED — clear the bridge landingScene flag by hand:', e?.message);
  }
  await f.dispose();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
