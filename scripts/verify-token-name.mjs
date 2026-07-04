// Live verification: update-actor `tokenName` — the prototype-token nameplate decoupled from the
// actor name.
//
// Claims under test (page-side updateActor, src/page/actors.ts):
//   1. tokenName alone rewrites prototypeToken.name and leaves actor.name untouched.
//   2. name alone still keeps prototypeToken.name in lockstep (the pre-existing behavior).
//   3. name + tokenName together: actor gets `name`, prototype gets `tokenName` (tokenName wins
//      the prototypeToken.name write — it is applied after the lockstep write).
//   4. A blank/whitespace tokenName is ignored (no applied entry, nameplate untouched).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixture NPC,
// cleaned in finally. Build first: npm run build. Run: node scripts/verify-token-name.mjs
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

const TAG = 'ZZ-TOKNAME';
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

const NAMES = actorId =>
  f.evaluate(id => {
    const a = game.actors.get(id);
    return { actor: a.name, proto: a.prototypeToken.name };
  }, actorId);

let actorId;

try {
  console.log('[verify-tokname] connecting…');
  await f.connect();
  console.log('[verify-tokname] connected\n');

  console.log('# setup fixture');
  actorId = await f.evaluate(async tag => {
    const a = await Actor.create({ name: `${tag} Host`, type: 'npc' });
    return a.id;
  }, TAG);
  console.log(`  fixture actor ${actorId}\n`);

  console.log('# 1) tokenName alone — prototype changes, actor name untouched');
  const r1 = await f.call('updateActor', { actorIdentifier: actorId, tokenName: `${TAG} Plate` });
  assert(r1.applied?.includes('tokenName'), 'applied includes tokenName');
  let n = await NAMES(actorId);
  assert(n.proto === `${TAG} Plate`, `prototypeToken.name = "${n.proto}"`);
  assert(n.actor === `${TAG} Host`, `actor.name untouched = "${n.actor}"`);

  console.log('# 2) name alone — lockstep still holds');
  await f.call('updateActor', { actorIdentifier: actorId, name: `${TAG} Renamed` });
  n = await NAMES(actorId);
  assert(n.actor === `${TAG} Renamed` && n.proto === `${TAG} Renamed`, 'actor + prototype in lockstep');

  console.log('# 3) name + tokenName together — tokenName wins the nameplate');
  const r3 = await f.call('updateActor', {
    actorIdentifier: actorId,
    name: `${TAG} the Gravemaker`,
    tokenName: `${TAG} Short`,
  });
  assert(
    r3.applied?.includes('name') && r3.applied?.includes('tokenName'),
    'applied includes name + tokenName'
  );
  n = await NAMES(actorId);
  assert(n.actor === `${TAG} the Gravemaker`, `actor.name = "${n.actor}"`);
  assert(n.proto === `${TAG} Short`, `prototypeToken.name = "${n.proto}"`);

  console.log('# 4) blank tokenName — ignored (falls through to "no applicable fields")');
  let r4threw = false;
  try {
    await f.call('updateActor', { actorIdentifier: actorId, tokenName: '   ' });
  } catch (e) {
    r4threw = /No applicable fields/i.test(e?.message || '');
  }
  assert(r4threw, 'blank tokenName rejected as no-op');
  n = await NAMES(actorId);
  assert(n.proto === `${TAG} Short`, 'nameplate untouched by blank tokenName');
} finally {
  if (actorId) {
    await f.evaluate(async id => {
      await game.actors.get(id)?.delete();
    }, actorId);
    console.log('\n[verify-tokname] fixture cleaned');
  }
  await f.dispose?.();
}

console.log(`\n[verify-tokname] ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
