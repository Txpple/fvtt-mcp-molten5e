// Live verification: the actor-editing tools reach a PLACED (unlinked) token's own actor by TOKEN id.
//
// The claim under test: `resolveActorFuzzy` (src/page/_shared.ts) falls back to scene-token lookup, so
// passing a TOKEN id (from list-tokens) as `actorIdentifier` to updateActorItem / removeActorItems /
// addActorItems / updateActor edits THAT token instance's ActorDelta — NOT the base actor, NOT sibling
// tokens of the same prototype. This is the tool-path for "swap the weapon on the placed captain" without
// the delete+re-place dance (NPC tokens are unlinked snapshots; base-actor edits don't propagate).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixture: a host NPC with
// a weapon + a feat, a scratch scene, TWO unlinked tokens (A = edit target, B = isolation control).
// Asserts after each edit: token A changed; token B AND the base actor byte-untouched. Cleaned in finally.
//
// Build first: npm run build. Run: node scripts/verify-token-item-editing.mjs
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

const TAG = 'ZZ-TOKITEM';
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

/** Snapshot the fixture's 3 views (base actor, token A, token B): item names + hp. */
const SNAPSHOT = ({ sceneId, actorId, tokA, tokB }) => {
  const dump = a => ({
    items: a.items.map(i => ({ id: i.id, name: i.name, type: i.type })).sort((x, y) => x.id.localeCompare(y.id)),
    hp: a.system?.attributes?.hp?.value ?? null,
  });
  const sc = game.scenes.get(sceneId);
  return {
    base: dump(game.actors.get(actorId)),
    a: dump(sc.tokens.get(tokA).actor),
    b: dump(sc.tokens.get(tokB).actor),
  };
};

let fixture;

try {
  console.log('[verify-tokitem] connecting…');
  await f.connect();
  console.log('[verify-tokitem] connected\n');

  // --- setup: host NPC (weapon + feat), scratch scene, 2 UNLINKED tokens ---
  console.log('# setup fixture');
  fixture = await f.evaluate(async tag => {
    const actor = await Actor.create({
      name: `${tag} Host`,
      type: 'npc',
      // Real hp.max matters: dnd5e clamps hp.value into [0, max], so a 0-max host would
      // silently clamp every hp write to 0 and fake a failure.
      system: { attributes: { hp: { value: 20, max: 20 } } },
      items: [
        { name: `${tag} Blade`, type: 'weapon' },
        { name: `${tag} Multiattack`, type: 'feat' },
      ],
    });
    const scene = await Scene.create({
      name: `${tag} Scene`,
      width: 2000,
      height: 2000,
      active: false,
      navigation: false,
    });
    const proto = i => ({
      name: `${tag} Copy ${i}`,
      x: 200 + i * 300,
      y: 200,
      width: 1,
      height: 1,
      actorId: actor.id,
      actorLink: false, // explicit: an UNLINKED snapshot (the NPC norm)
      texture: { src: 'icons/svg/mystery-man.svg' },
    });
    const made = await scene.createEmbeddedDocuments('Token', [proto(0), proto(1)]);
    return {
      sceneId: scene.id,
      actorId: actor.id,
      tokA: made[0].id,
      tokB: made[1].id,
      itemIds: actor.items.map(i => i.id),
    };
  }, TAG);
  console.log(`  scene ${fixture.sceneId}, actor ${fixture.actorId}, tokens A=${fixture.tokA} B=${fixture.tokB}\n`);

  const before = await f.evaluate(SNAPSHOT, fixture);
  assert(before.a.items.length === 2 && before.b.items.length === 2, 'setup — both tokens surface the 2 prototype items');

  // --- A: updateActorItem by TOKEN id — rename+patch lands on A's delta only ---
  console.log('# A: updateActorItem(actorIdentifier = token A id)');
  const a = await f.call('updateActorItem', {
    actorIdentifier: fixture.tokA,
    itemIdentifier: `${TAG} Blade`,
    name: `${TAG} Longsword`,
    patch: { 'system.damage.base.denomination': 8 },
  });
  assert(a?.success === true, 'A — call succeeded');
  const afterA = await f.evaluate(SNAPSHOT, fixture);
  assert(afterA.a.items.some(i => i.name === `${TAG} Longsword`), 'A — token A shows the renamed item');
  assert(afterA.base.items.some(i => i.name === `${TAG} Blade`), 'A — base actor still has the ORIGINAL name');
  assert(afterA.b.items.some(i => i.name === `${TAG} Blade`), 'A — sibling token B still has the ORIGINAL name');
  const dieA = await f.evaluate(
    ({ sceneId, tokA }) =>
      game.scenes.get(sceneId).tokens.get(tokA).actor.items.find(i => i.type === 'weapon')?.system?.damage?.base
        ?.denomination,
    fixture
  );
  assert(dieA === 8, `A — dot-path patch persisted on the delta (d8 → d${dieA})`);

  // --- B: removeActorItems by TOKEN id — deletion isolated to A ---
  console.log('# B: removeActorItems(actorIdentifier = token A id)');
  const b = await f.call('removeActorItems', {
    actorIdentifier: fixture.tokA,
    itemNames: [`${TAG} Multiattack`],
  });
  assert((b?.removed ?? []).length === 1, 'B — reported 1 removal');
  const afterB = await f.evaluate(SNAPSHOT, fixture);
  assert(!afterB.a.items.some(i => i.name === `${TAG} Multiattack`), 'B — gone from token A');
  assert(afterB.base.items.some(i => i.name === `${TAG} Multiattack`), 'B — base actor still has it');
  assert(afterB.b.items.some(i => i.name === `${TAG} Multiattack`), 'B — sibling token B still has it');

  // --- C: addActorItems by TOKEN id — creation isolated to B ---
  console.log('# C: addActorItems(actorIdentifier = token B id)');
  const c = await f.call('addActorItems', {
    actorIdentifier: fixture.tokB,
    items: [{ name: `${TAG} Venom`, type: 'feat' }],
  });
  assert((c?.created ?? []).length === 1, 'C — reported 1 creation');
  const afterC = await f.evaluate(SNAPSHOT, fixture);
  assert(afterC.b.items.some(i => i.name === `${TAG} Venom`), 'C — present on token B');
  assert(!afterC.base.items.some(i => i.name === `${TAG} Venom`), 'C — absent on the base actor');
  assert(!afterC.a.items.some(i => i.name === `${TAG} Venom`), 'C — absent on sibling token A');

  // --- D: updateActor (statblock) by TOKEN id — hp lands on A's delta only ---
  console.log('# D: updateActor(actorIdentifier = token A id, hp)');
  const d = await f.call('updateActor', { actorIdentifier: fixture.tokA, hp: { value: 5 } });
  assert(d?.success === true, 'D — call succeeded');
  const afterD = await f.evaluate(SNAPSHOT, fixture);
  assert(afterD.a.hp === 5, `D — token A hp 5 (got ${afterD.a.hp})`);
  assert(afterD.base.hp === before.base.hp, `D — base actor hp untouched (${afterD.base.hp})`);
  assert(afterD.b.hp === before.b.hp, `D — sibling token B hp untouched (${afterD.b.hp})`);

  // --- E: world-actor resolution still wins over token scan (regression guard) ---
  console.log('# E: world-actor id still resolves to the world actor');
  const e = await f.call('updateActor', { actorIdentifier: fixture.actorId, hp: { value: 3 } });
  assert(e?.success === true, 'E — call succeeded');
  const afterE = await f.evaluate(SNAPSHOT, fixture);
  assert(afterE.base.hp === 3, `E — base actor hp 3 (got ${afterE.base.hp})`);
  assert(afterE.a.hp === 5, 'E — token A keeps its own delta hp (5)');
} catch (e) {
  fails++;
  console.log(`\n[verify-tokitem] FATAL: ${e?.message || String(e)}`);
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
      console.log('\n[verify-tokitem] cleaned up fixture scene + actor');
    } catch (e) {
      console.log(`\n[verify-tokitem] cleanup note: ${e?.message || e}`);
    }
  }
  await f.dispose?.();
}

console.log(`\n==== token-item-editing verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
