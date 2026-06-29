// Live verification for tool-hardening ⑤ — "reskin visibility" (supports authoring rule 7).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). create-actor-from-compendium
// now reports the copied creature's attack damage TYPES, so an agent reskinning the base to a new theme
// must SEE the off-theme damage and reconcile it (replace the abilities, not reflavor in prose). Copies
// the Adult Red Dragon (fire + slashing) and asserts the damageProfile surfaces those types per attack.
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
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let actorId;

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
} catch (e) {
  fails++;
  console.log(`\n[verify-reskin] FATAL: ${e?.message || String(e)}`);
} finally {
  if (actorId) {
    try {
      await f.call('deleteActor', { identifiers: [actorId], removeEmptyFolder: true });
      console.log('\n[verify-reskin] cleaned up dragon');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== reskin-visibility verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
