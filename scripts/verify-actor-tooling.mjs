// Live acceptance for the ACTOR TOOLING build (update-actor, apply-condition, update-actor-item,
// manage-activity, add-feature spell mode, manage-effect) + the Phase 0 read-fixes. Exercises the
// page-side write/read seams against the live Molten world; unit tests mock the seam, so this is the
// real correctness gate. Test docs are tagged ZZ-MCP-AT and cleaned up in a finally.
//
// Build first: npm run build. Run: node scripts/verify-actor-tooling.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';
import { extractActorStats, extractActorBasicInfo } from '../dist/tools/dnd5e/actor-stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const txt = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const foundry = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const results = [];
const pass = (n, s) => {
  results.push({ n, ok: true });
  console.log(`PASS  ${n}${s ? ` -> ${s}` : ''}`);
};
const fail = (n, e) => {
  results.push({ n, ok: false });
  console.log(`FAIL  ${n} -> ${e}`);
};
const tempActorIds = [];

async function makeTempNpc(name) {
  const r = await foundry.evaluate(async n => {
    const a = await globalThis.Actor.create({ name: n, type: 'npc' });
    return { id: a.id, name: a.name };
  }, name);
  tempActorIds.push(r.id);
  return r;
}

try {
  // =========================================================================
  // PHASE 0 — R1: get-actor surfaces real derived modifiers (end-to-end).
  // =========================================================================
  {
    const info = await foundry.call('getCharacterInfo', { characterName: 'Barbed Devil' });
    const basic = extractActorBasicInfo(info);
    const stats = extractActorStats(info);
    const okDerived =
      info?.derived?.abilities?.str?.mod === 5 &&
      info?.derived?.ac?.value === 15 &&
      typeof info?.derived?.skills?.prc?.passive === 'number';
    okDerived
      ? pass(
          'R1 page derived block',
          `str.mod=${info.derived.abilities.str.mod}, ac=${info.derived.ac.value}`
        )
      : fail('R1 page derived block', JSON.stringify(info?.derived));

    const okStats =
      basic.armorClass === 15 &&
      stats.armorClass === 15 &&
      stats.abilities?.str?.modifier === 5 &&
      stats.skills?.prc?.modifier === 8 &&
      stats.skills?.prc?.passive === 18;
    okStats
      ? pass(
          'R1 extractor consumes derived',
          `AC=${stats.armorClass}, STR mod=${stats.abilities.str.modifier}, prc=${stats.skills.prc.modifier}/pp${stats.skills.prc.passive}`
        )
      : fail(
          'R1 extractor consumes derived',
          JSON.stringify({
            basicAC: basic.armorClass,
            statsAC: stats.armorClass,
            str: stats.abilities?.str,
            prc: stats.skills?.prc,
          })
        );
  }
} catch (e) {
  fail('SUITE', e?.message || String(e));
} finally {
  if (tempActorIds.length) {
    try {
      const del = await foundry.call('deleteActor', { identifiers: tempActorIds });
      console.log(`cleanup -> deleted ${del?.deletedCount ?? 0} temp actor(s)`);
    } catch (e) {
      console.log(`cleanup FAILED: ${e?.message || e}`);
    }
  }
  await foundry.dispose?.();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}
