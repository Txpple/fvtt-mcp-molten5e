// Live verification for the update-token tool — editing a PLACED token instance on a scene.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Builds a THROWAWAY fixture via
// the foundry.evaluate escape hatch (a scene + a host actor + 3 tokens, all lockRotation:true), then
// exercises the real `updateSceneTokens` page function through f.call and asserts:
//   • token-id targeting: rotation + scale, and the lockRotation GOTCHA auto-unlock (+warning).
//   • actorIds targeting by NAME: matches ALL placed copies; randomizeRotation gives each an angle.
//   • scene + actor resolve by exact NAME.
//   • unmatched ids are reported, not fatal.
// Fixture is deleted in `finally`.
//
// Build first: npm run build. Run: node scripts/verify-token-tooling.mjs
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

const TAG = 'ZZ-TOKEN-IT';
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

let fixture;

try {
  console.log('[verify-token] connecting…');
  await f.connect();
  console.log('[verify-token] connected\n');

  // --- setup: a throwaway scene + host actor + 3 locked tokens (escape hatch, not the tool under test) ---
  console.log('# setup fixture');
  fixture = await f.evaluate(async tag => {
    const actor = await Actor.create({ name: `${tag} Host`, type: 'npc' });
    const scene = await Scene.create({
      name: `${tag} Scene`,
      width: 2000,
      height: 2000,
      active: false,
      navigation: false,
    });
    const proto = i => ({
      name: `${tag} Corpse ${i}`,
      x: 200 + i * 200,
      y: 200,
      width: 1,
      height: 1,
      lockRotation: true, // the gotcha: a set rotation would be HIDDEN until unlocked
      actorId: actor.id,
      texture: { src: 'icons/svg/mystery-man.svg', scaleX: 1, scaleY: 1 },
    });
    const made = await scene.createEmbeddedDocuments('Token', [proto(0), proto(1), proto(2)]);
    return {
      sceneId: scene.id,
      sceneName: scene.name,
      actorId: actor.id,
      actorName: actor.name,
      tokenIds: made.map(t => t.id),
    };
  }, TAG);
  console.log(
    `  scene ${fixture.sceneId}, actor ${fixture.actorId}, tokens ${fixture.tokenIds.join(', ')}\n`
  );

  // --- A: token-id targeting — rotation + scale + lockRotation gotcha ---
  console.log('# A: token-id target, rotation+scale, lockRotation auto-unlock');
  const a = await f.call('updateSceneTokens', {
    sceneIdentifier: fixture.sceneId,
    tokenIds: [fixture.tokenIds[0]],
    rotation: 90,
    scale: 1.5,
  });
  assert(a?.matched === 1 && a?.updated === 1, 'A — matched & updated exactly 1 token');
  assert(
    Array.isArray(a?.warnings) && a.warnings.some(w => /auto-unlock/i.test(w)),
    'A — warns it auto-unlocked lockRotation'
  );
  const a0 = await f.evaluate(
    ({ sceneId, tokenId }) => {
      const t = game.scenes.get(sceneId).tokens.get(tokenId);
      return { rotation: t.rotation, scaleX: t.texture?.scaleX, lockRotation: t.lockRotation };
    },
    { sceneId: fixture.sceneId, tokenId: fixture.tokenIds[0] }
  );
  assert(a0.rotation === 90, `A — rotation persisted (90 → ${a0.rotation})`);
  assert(a0.scaleX === 1.5, `A — art scale persisted (1.5 → ${a0.scaleX})`);
  assert(a0.lockRotation === false, `A — lockRotation flipped false (→ ${a0.lockRotation})`);

  // --- B: actor targeting by NAME — all copies, randomizeRotation ---
  console.log('# B: actorIds by NAME → all copies, randomizeRotation');
  const b = await f.call('updateSceneTokens', {
    sceneIdentifier: fixture.sceneName, // resolve scene by exact name
    actorIds: [fixture.actorName], // resolve actor by exact name → every placed copy
    randomizeRotation: true,
  });
  assert(
    b?.matched === 3 && b?.updated === 3,
    `B — matched all 3 copies of the host (matched ${b?.matched})`
  );
  const angles = await f.evaluate(
    ({ sceneId, tokenIds }) => {
      const sc = game.scenes.get(sceneId);
      return tokenIds.map(id => {
        const t = sc.tokens.get(id);
        return { rot: t.rotation, lock: t.lockRotation };
      });
    },
    { sceneId: fixture.sceneId, tokenIds: fixture.tokenIds }
  );
  assert(
    angles.every(x => typeof x.rot === 'number' && x.rot >= 0 && x.rot < 360),
    'B — every token has a 0–359 angle'
  );
  assert(
    angles.every(x => x.lock === false),
    'B — every token ended lockRotation:false'
  );

  // --- C: unmatched ids reported, not fatal ---
  console.log('# C: unmatched ids reported');
  const c = await f.call('updateSceneTokens', {
    sceneIdentifier: fixture.sceneId,
    tokenIds: ['doesNotExist00'],
    actorIds: ['No Such Actor'],
    scale: 2,
  });
  assert(c?.matched === 0, 'C — matched 0 for bogus targets');
  assert(c?.unmatched?.tokenIds?.includes('doesNotExist00'), 'C — reports the unresolved token id');
  assert(
    c?.unmatched?.actorIds?.includes('No Such Actor'),
    'C — reports the unresolved actor name'
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-token] FATAL: ${e?.message || String(e)}`);
} finally {
  if (fixture) {
    try {
      await f.evaluate(
        async ({ sceneId, actorId }) => {
          await game.scenes.get(sceneId)?.delete();
          await game.actors.get(actorId)?.delete();
        },
        { sceneId: fixture.sceneId, actorId: fixture.actorId }
      );
      console.log('\n[verify-token] cleaned up fixture scene + actor');
    } catch (e) {
      console.log(`\n[verify-token] cleanup note: ${e?.message || e}`);
    }
  }
  await f.dispose?.();
}

console.log(`\n==== update-token verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
