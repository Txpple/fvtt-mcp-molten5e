// Live verification for tool-hardening ⑤ — "reskin visibility" (supports authoring rule 7).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). create-actor-from-compendium
// now reports the copied creature's attack damage TYPES, so an agent reskinning the base to a new theme
// must SEE the off-theme damage and reconcile it (replace the abilities, not reflavor in prose). Copies
// the Adult Red Dragon (fire + slashing) and asserts the damageProfile surfaces those types per attack.
// Also asserts the copy's prototype token follows the house token rules (auto-rotate on, dynamic ring
// off, randomImg off), that update-actor's tokenRing/tokenAutoRotate toggles flip them, and that a
// caller-supplied disposition ('neutral' townsfolk) overrides the npc→hostile default.
// Cleaned up in `finally`.
//
// Build first: npm run build. Run: node scripts/verify-reskin-visibility.mjs
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

const TAG = 'ZZ-RESKIN-IT';
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
  user: env.FOUNDRY_USER || 'MCP-Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let actorId;
let commonerId;

try {
  console.log('[verify-reskin] connecting to sandbox…');
  await f.connect();
  console.log('[verify-reskin] connected\n');

  console.log('# copy the Adult Red Dragon → damage profile surfaces');
  const out = await f.call('createActorFromCompendium', {
    packId: 'dnd-monster-manual.actors',
    itemId: 'mmAdultRedDragon',
    customNames: [`${TAG} Dragon`],
    quantity: 1,
    addToScene: false,
  });
  actorId = out?.actors?.[0]?.id;
  if (!actorId) throw new Error('dragon not created');

  const profile = out.actors[0].damageProfile;
  console.log(`        damageTypes: ${JSON.stringify(profile?.damageTypes)}`);
  assert(Boolean(profile), 'created actor carries a damageProfile');
  assert(
    Array.isArray(profile?.damageTypes) && profile.damageTypes.includes('fire'),
    'damage profile includes fire (the dragon theme to reconcile on a reskin)'
  );
  assert(
    profile?.attacks?.some(a => a.types?.includes('fire')),
    'at least one attack lists its fire damage type'
  );
  assert(
    profile?.attacks?.length > 0 && profile.attacks.every(a => a.name && Array.isArray(a.types)),
    'each attack entry has a name + its damage types'
  );

  console.log('\n# the copy is named on its prototype token (not the source creature name)');
  const protoName = await f.evaluate(
    id => globalThis.game.actors.get(id)?.prototypeToken?.name,
    actorId
  );
  assert(
    protoName === `${TAG} Dragon`,
    `prototype token carries the custom name, not "Adult Red Dragon" (got "${protoName}")`
  );

  console.log('\n# a rename via update-actor keeps the prototype token in lockstep');
  await f.call('updateActor', { actorIdentifier: actorId, name: `${TAG} Wyrm` });
  const renamed = await f.evaluate(id => {
    const a = globalThis.game.actors.get(id);
    return { name: a?.name, proto: a?.prototypeToken?.name };
  }, actorId);
  assert(renamed.name === `${TAG} Wyrm`, 'update-actor renamed the actor');
  assert(
    renamed.proto === `${TAG} Wyrm`,
    `update-actor synced the prototype token name (got "${renamed.proto}")`
  );

  console.log('\n# house token rules on the copy (auto-rotate on, ring off, no wildcard art)');
  const houseRules = await f.evaluate(id => {
    const pt = globalThis.game.actors.get(id)?.prototypeToken;
    return {
      lockRotation: pt?.lockRotation,
      randomImg: pt?.randomImg,
      ringEnabled: pt?.ring?.enabled,
    };
  }, actorId);
  assert(houseRules.lockRotation === false, 'auto-rotate is on (lockRotation false)');
  assert(houseRules.randomImg === false, 'randomImg is off');
  assert(houseRules.ringEnabled === false, 'dynamic token ring is off');

  console.log('\n# update-actor token toggles flip ring + auto-rotate back');
  await f.call('updateActor', {
    actorIdentifier: actorId,
    tokenRing: true,
    tokenAutoRotate: false,
  });
  const toggled = await f.evaluate(id => {
    const pt = globalThis.game.actors.get(id)?.prototypeToken;
    return { lockRotation: pt?.lockRotation, ringEnabled: pt?.ring?.enabled };
  }, actorId);
  assert(toggled.ringEnabled === true, 'tokenRing:true re-enabled the ring');
  assert(toggled.lockRotation === true, 'tokenAutoRotate:false locked rotation');

  console.log('\n# a neutral townsfolk copy (caller disposition overrides the npc→hostile default)');
  const out2 = await f.call('createActorFromCompendium', {
    packId: 'dnd-monster-manual.actors',
    itemId: 'mmCommoner000000',
    customNames: [`${TAG} Commoner`],
    quantity: 1,
    addToScene: false,
    disposition: 'neutral',
  });
  commonerId = out2?.actors?.[0]?.id;
  if (!commonerId) throw new Error('commoner not created');
  const disp = await f.evaluate(
    id => globalThis.game.actors.get(id)?.prototypeToken?.disposition,
    commonerId
  );
  assert(disp === 0, `commoner copy is neutral (disposition 0, got ${disp})`);
} catch (e) {
  fails++;
  console.log(`\n[verify-reskin] FATAL: ${e?.message || String(e)}`);
} finally {
  const created = [actorId, commonerId].filter(Boolean);
  if (created.length) {
    try {
      await f.call('deleteActor', { identifiers: created, removeEmptyFolder: true });
      console.log('\n[verify-reskin] cleaned up created actors');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== reskin-visibility verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
