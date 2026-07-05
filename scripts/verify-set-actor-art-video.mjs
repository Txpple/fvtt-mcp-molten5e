// Live verification: set-actor-art handles an ANIMATED (video) prototype token + a still portrait.
//
// The bug this proves fixed: actor.img is IMAGE-only, so writing a .webm to it made Foundry reject the
// WHOLE update — and setActorArt reported success anyway (nothing changed). Now: a video imagePath is
// kept OFF the portrait (warned), and tokenImagePath lets the token carry the video while the portrait
// stays a valid still image (the JB2A / dancing-light pattern).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway NPC fixture; cleaned up.
// Uses a real JB2A dancing-lights pair that ships in this world's modules.
//
// Build first: npm run build. Run: node scripts/verify-set-actor-art-video.mjs
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

const DIR = 'modules/JB2A_DnD5e/Library/Cantrip/Dancing_Lights';
const STILL = `${DIR}/DancingLights_01_Yellow_Thumb.webp`; // valid portrait
const VIDEO = `${DIR}/DancingLights_01_Yellow_200x200.webm`; // token-only (video)

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

const READ = ({ id }) => {
  const a = game.actors.get(id);
  return { img: a.img, tokenSrc: a.prototypeToken?.texture?.src };
};

let actorId;

try {
  console.log('[verify-art-video] connecting…');
  await f.connect();
  console.log('[verify-art-video] connected\n');

  actorId = await f.evaluate(async () => {
    const a = await Actor.create({
      name: 'ZZ-ARTVID Host',
      type: 'npc',
      img: 'icons/svg/mystery-man.svg',
    });
    return a.id;
  });
  console.log(`# fixture actor ${actorId}\n`);

  // --- A: still portrait + animated (video) token in ONE call ---
  console.log('# A: imagePath=still, tokenImagePath=video');
  const a = await f.call('setActorArt', {
    actorIdentifier: actorId,
    imagePath: STILL,
    tokenImagePath: VIDEO,
  });
  assert(a?.updated === true, 'A — reported updated');
  const aState = await f.evaluate(READ, { id: actorId });
  assert(aState.img === STILL, `A — portrait is the STILL image (${aState.img})`);
  assert(aState.tokenSrc === VIDEO, `A — token texture is the VIDEO (${aState.tokenSrc})`);
  assert(!a?.warnings?.length, 'A — no warnings for the valid still+video split');

  // --- B: a VIDEO as imagePath is kept OFF the portrait, used for the token, and warns ---
  console.log('# B: imagePath=video (no tokenImagePath)');
  // reset the portrait to a known still first
  await f.evaluate(async ({ id, still }) => game.actors.get(id).update({ img: still }), {
    id: actorId,
    still: STILL,
  });
  const b = await f.call('setActorArt', { actorIdentifier: actorId, imagePath: VIDEO });
  assert(b?.updated === true, 'B — reported updated (token applied)');
  assert(
    Array.isArray(b?.warnings) && b.warnings.some(w => /portrait must be a still image/i.test(w)),
    'B — warns the video was NOT used as the portrait'
  );
  const bState = await f.evaluate(READ, { id: actorId });
  assert(bState.img === STILL, `B — portrait UNCHANGED, still the image (${bState.img})`);
  assert(bState.tokenSrc === VIDEO, `B — token texture is the VIDEO (${bState.tokenSrc})`);

  // --- C: regression — plain still image applies to BOTH portrait and token ---
  console.log('# C: imagePath=still only (back-compat)');
  const c = await f.call('setActorArt', { actorIdentifier: actorId, imagePath: STILL });
  assert(c?.updated === true, 'C — reported updated');
  const cState = await f.evaluate(READ, { id: actorId });
  assert(
    cState.img === STILL && cState.tokenSrc === STILL,
    'C — still image on BOTH portrait + token'
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-art-video] FATAL: ${e?.message || String(e)}`);
} finally {
  if (actorId) {
    try {
      await f.evaluate(async ({ id }) => game.actors.get(id)?.delete(), { id: actorId });
      console.log('\n[verify-art-video] cleaned up fixture actor');
    } catch (e) {
      console.log(`\n[verify-art-video] cleanup note: ${e?.message || e}`);
    }
  }
  await f.dispose?.();
}

console.log(`\n==== set-actor-art video verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
