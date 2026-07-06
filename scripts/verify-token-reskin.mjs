// Live verification: update-token `imagePath` — the placed-instance RESKIN (texture.src), the last
// reason a placed-token art change needed delete+re-place.
//
// Claims under test (page-side updateSceneTokens/buildTokenUpdate, src/page/placeables/token.ts):
//   1. imagePath sets the placed token's texture.src (and echoes it in the summary `src`).
//   2. The path is NORMALIZED (a "/Data/…"-prefixed path lands as the bare world-relative path).
//   3. A 404 imagePath is DROPPED (art unchanged) with a warning — never a broken texture.
//   4. A 404 imagePath alongside another field: the other field still applies, art untouched.
//   5. The sidebar actor's prototype token is NOT touched by a placed-instance reskin.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixtures,
// cleaned in finally. Build first: npm run build. Run: node scripts/verify-token-reskin.mjs
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

const TAG = 'ZZ-RESKIN';
const ART_A = 'icons/svg/mystery-man.svg'; // ships with Foundry core — always resolves
const ART_B = 'icons/svg/aura.svg'; // second core icon, for the normalization pass
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

let actorId;
let sceneId;

const tokenState = tokenId =>
  f.evaluate(
    ({ sid, tid }) => {
      const t = game.scenes.get(sid).tokens.get(tid);
      return { src: t.texture?.src, rotation: t.rotation };
    },
    { sid: sceneId, tid: tokenId }
  );

try {
  console.log('[verify-reskin] connecting…');
  await f.connect();
  console.log('[verify-reskin] connected\n');

  console.log('# setup — fixture actor + scene + placed token');
  ({ actorId, sceneId } = await f.evaluate(async tag => {
    const a = await Actor.create({ name: `${tag} Host`, type: 'npc' });
    const s = await Scene.create({ name: `${tag} Scene`, width: 1000, height: 1000 });
    return { actorId: a.id, sceneId: s.id };
  }, TAG));
  const tokenId = await f.evaluate(
    async ({ aid, sid }) => {
      const td = await game.actors.get(aid).getTokenDocument({ x: 100, y: 100 });
      const doc = td.toObject();
      delete doc._id;
      const [created] = await game.scenes.get(sid).createEmbeddedDocuments('Token', [doc]);
      return created.id;
    },
    { aid: actorId, sid: sceneId }
  );
  const protoBefore = await f.evaluate(
    id => game.actors.get(id).prototypeToken.texture?.src,
    actorId
  );
  console.log(`  actor ${actorId}, scene ${sceneId}, token ${tokenId}\n`);

  console.log('# 1) imagePath reskins the placed token (texture.src) and echoes it');
  const r1 = await f.call('updateSceneTokens', {
    sceneIdentifier: sceneId,
    tokenIds: [tokenId],
    imagePath: ART_A,
  });
  assert(r1.updated === 1, `updated ${r1.updated} of ${r1.matched}`);
  assert(r1.tokens?.[0]?.src === ART_A, `summary echoes src = "${r1.tokens?.[0]?.src}"`);
  let st = await tokenState(tokenId);
  assert(st.src === ART_A, `token texture.src = "${st.src}"`);

  console.log('# 2) a /Data/-prefixed path is NORMALIZED before the write');
  await f.call('updateSceneTokens', {
    sceneIdentifier: sceneId,
    tokenIds: [tokenId],
    imagePath: `/Data/${ART_B}`,
  });
  st = await tokenState(tokenId);
  assert(st.src === ART_B, `normalized to "${st.src}"`);

  console.log('# 3) a 404 imagePath is dropped with a warning — art unchanged');
  const r3 = await f.call('updateSceneTokens', {
    sceneIdentifier: sceneId,
    tokenIds: [tokenId],
    imagePath: 'assets/zz-not-a-real-file-9f2c.png',
  });
  assert(r3.updated === 0, `updated ${r3.updated} (nothing to change once the reskin dropped)`);
  assert(
    (r3.warnings ?? []).some(w => /was not found on the server/i.test(w)),
    'warning names the missing path'
  );
  st = await tokenState(tokenId);
  assert(st.src === ART_B, `art untouched = "${st.src}"`);

  console.log('# 4) 404 imagePath + rotation — rotation still lands, art untouched');
  const r4 = await f.call('updateSceneTokens', {
    sceneIdentifier: sceneId,
    tokenIds: [tokenId],
    imagePath: 'assets/zz-not-a-real-file-9f2c.png',
    rotation: 45,
  });
  assert(r4.updated === 1, 'the rest of the patch applied');
  st = await tokenState(tokenId);
  assert(st.rotation === 45 && st.src === ART_B, `rotation ${st.rotation}, art "${st.src}"`);

  console.log('# 5) the sidebar prototype token was never touched');
  const protoAfter = await f.evaluate(
    id => game.actors.get(id).prototypeToken.texture?.src,
    actorId
  );
  assert(protoAfter === protoBefore, `prototype texture.src unchanged ("${protoAfter}")`);
} finally {
  await f.evaluate(
    async ({ aid, sid }) => {
      await game.scenes.get(sid)?.delete();
      await game.actors.get(aid)?.delete();
    },
    { aid: actorId, sid: sceneId }
  );
  console.log('\n[verify-reskin] fixtures cleaned');
  await f.dispose?.();
}

console.log(`\n[verify-reskin] ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
