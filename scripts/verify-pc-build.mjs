// Live verify for the PC leveling engine (src/page/dnd5e/advancement.ts → page ops createPcActor /
// inspectAdvancementChoices). Drives the FRESH dist/ against the sandbox world, so it exercises the
// new page code WITHOUT a CC restart (the MCP tool layer is a thin wrapper — proven separately by
// pc.test.ts). Mirrors scripts/verify-scale-report.mjs: connect → exercise → assert → clean up in
// `finally`. TAG-namespaced actors are deleted whatever happens.
//
// Build first: npm run build. Run: node scripts/verify-pc-build.mjs   (needs the world up + .env)
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

const TAG = 'ZZ-PC-IT';
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
function withNodeTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`node-timeout: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), timeout]);
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const createdNames = [];

// Build a choices map from a needsChoices[] list: concrete (non-wildcard) trait keys, pool uuids.
function fillChoices(needs) {
  const choices = {};
  for (const c of needs) {
    const lvl = String(c.level);
    choices[lvl] ??= {};
    if (c.dataKey === 'chosen') {
      const concrete = c.options.map(o => o.value).filter(v => !v.includes('*'));
      if (concrete.length) choices[lvl][c.id] = { chosen: concrete.slice(0, c.count) };
    } else if (c.dataKey === 'selected') {
      const picks = c.options.map(o => o.value).slice(0, c.count);
      if (picks.length) choices[lvl][c.id] = { selected: picks };
    }
  }
  return choices;
}

try {
  console.log('[verify-pc] connecting to sandbox…');
  await f.connect();
  console.log('[verify-pc] connected\n');

  // ---- Test A: dry-run — missing required choices returns needsChoices[] and does NOT persist ----
  const fighterName = `${TAG} Fighter Dragonborn`;
  const dryRun = await withNodeTimeout(
    f.call('createPcActor', {
      name: fighterName,
      className: 'Fighter',
      species: 'Dragonborn',
      background: 'Soldier',
      abilities: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
      level: 1,
    }),
    120_000,
    'dryRun'
  );
  console.log('--- Test A: dry-run needsChoices ---');
  console.log(
    JSON.stringify(
      dryRun?.needsChoices?.map(c => ({
        src: c.source,
        title: c.title,
        type: c.type,
        count: c.count,
      })),
      null,
      2
    )
  );
  assert(
    dryRun?.success === false,
    'A1: build refused (success:false) when required choices missing'
  );
  assert(
    (dryRun?.needsChoices?.length ?? 0) > 0,
    `A2: needsChoices[] returned (${dryRun?.needsChoices?.length})`
  );
  assert(
    dryRun?.needsChoices?.some(c => c.type === 'Trait' && /skill/i.test(c.title)),
    'A3: needsChoices includes the class Skill Proficiencies (Trait)'
  );
  assert(
    dryRun?.needsChoices?.some(c => c.type === 'ItemChoice'),
    'A4: needsChoices includes an ItemChoice (fighting style / ancestry)'
  );
  // No actor should have been created by the dry-run.
  const leakedAfterDry = await withNodeTimeout(
    f.evaluate(name => !!globalThis.game.actors.find(a => a.name === name), fighterName),
    30_000,
    'leakCheck'
  );
  assert(leakedAfterDry === false, 'A5: dry-run created NO actor (no litter)');

  // ---- Test B: full build with choices filled → persists, HP correct, @scale resolves ----
  const choices = fillChoices(dryRun?.needsChoices ?? []);
  const built = await withNodeTimeout(
    f.call('createPcActor', {
      name: fighterName,
      className: 'Fighter',
      species: 'Dragonborn',
      background: 'Soldier',
      abilities: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
      choices,
      acceptDefaults: true, // wildcard-pool traits (languages/tools) fall back to forced defaults
      level: 1,
    }),
    180_000,
    'fullBuild'
  );
  createdNames.push(fighterName);
  console.log('\n--- Test B: full build ---');
  console.log(
    JSON.stringify(
      {
        success: built?.success,
        actor: built?.actor,
        unresolvedScale: built?.unresolvedScale,
        warnings: built?.warnings,
      },
      null,
      2
    )
  );
  assert(built?.success === true, 'B1: PC built + persisted (success:true)');
  assert(!!built?.actor?.id, 'B2: returns a persisted actor id');
  // Fighter d10 + CON 14 (+2) = 12 at L1
  assert(
    built?.actor?.hp === 12,
    `B3: persisted HP = 12 (Fighter d10 + CON14) (got ${built?.actor?.hp})`
  );
  assert(
    (built?.unresolvedScale?.length ?? 0) === 0,
    `B4: no unresolved @scale on the persisted PC (${JSON.stringify(built?.unresolvedScale)})`
  );

  // Read the persisted actor back: skills, feats, racial @scale resolution.
  const readback = await withNodeTimeout(
    f.evaluate(id => {
      const a = globalThis.game.actors.get(id);
      a.reset?.();
      const skills = Object.entries(a.system?.skills || {})
        .filter(([, v]) => (v?.value ?? 0) > 0)
        .map(([k]) => k);
      const feats = a.items.filter(i => i.type === 'feat').map(i => i.name);
      const rd = a.getRollData();
      // find a breath-weapon @scale token and resolve it
      let breath = null;
      for (const it of a.items) {
        const m = JSON.stringify(it.toObject()).match(/@scale\.breath-weapon\.[a-z-]+/i);
        if (m) {
          breath = {
            token: m[0],
            resolved: String(
              globalThis.Roll.replaceFormulaData(m[0], rd, { missing: '0', warn: false })
            ),
          };
          break;
        }
      }
      return {
        type: a.type,
        hp: a.system?.attributes?.hp?.max,
        skills,
        feats,
        breath,
        originalClass: a.system?.details?.originalClass,
      };
    }, built.actor.id),
    60_000,
    'readback'
  );
  console.log('\n--- Test B readback ---');
  console.log(JSON.stringify(readback, null, 2));
  assert(readback?.type === 'character', 'B5: actor is type:character');
  assert(
    (readback?.skills?.length ?? 0) >= 2,
    `B6: class skill choices landed (${readback?.skills?.join(', ')})`
  );
  assert(
    (readback?.feats?.length ?? 0) >= 4,
    `B7: class+species+background features present (${readback?.feats?.length}: ${readback?.feats?.join(', ')})`
  );
  assert(
    readback?.breath?.resolved &&
      readback.breath.resolved !== '0' &&
      !/@scale/.test(readback.breath.resolved),
    `B8: racial @scale resolves (${readback?.breath?.token} -> ${readback?.breath?.resolved})`
  );

  // ---- Test C: inspect-pc-advancement reports the same class choices ----
  const inspect = await withNodeTimeout(
    f.call('inspectAdvancementChoices', { className: 'Fighter', level: 1 }),
    60_000,
    'inspect'
  );
  console.log('\n--- Test C: inspect Fighter ---');
  console.log(
    JSON.stringify(
      inspect?.choices?.map(c => ({ title: c.title, type: c.type, count: c.count })),
      null,
      2
    )
  );
  assert(
    inspect?.choices?.some(c => c.type === 'Trait' && /skill/i.test(c.title)),
    'C1: inspect reports Skill Proficiencies (Trait)'
  );
  assert(
    inspect?.choices?.some(c => c.type === 'ItemChoice'),
    'C2: inspect reports an ItemChoice'
  );

  // ---- Test D: caster (Wizard) — L1 spell slots auto-derive; chosen cantrips import ----
  const wizName = `${TAG} Wizard`;
  const wizDry = await withNodeTimeout(
    f.call('createPcActor', {
      name: wizName,
      className: 'Wizard',
      abilities: { str: 8, dex: 14, con: 14, int: 15, wis: 12, cha: 10 },
      level: 1,
    }),
    120_000,
    'wizDry'
  );
  const wizChoices = fillChoices(wizDry?.needsChoices ?? []);
  const wiz = await withNodeTimeout(
    f.call('createPcActor', {
      name: wizName,
      className: 'Wizard',
      abilities: { str: 8, dex: 14, con: 14, int: 15, wis: 12, cha: 10 },
      choices: wizChoices,
      acceptDefaults: true,
      spells: { cantrips: ['Fire Bolt', 'Mage Hand'] },
      level: 1,
    }),
    180_000,
    'wizBuild'
  );
  createdNames.push(wizName);
  console.log('\n--- Test D: Wizard ---');
  console.log(
    JSON.stringify({ success: wiz?.success, hp: wiz?.actor?.hp, warnings: wiz?.warnings }, null, 2)
  );
  assert(wiz?.success === true, 'D1: Wizard built + persisted');
  const wizRead = await withNodeTimeout(
    f.evaluate(id => {
      const a = globalThis.game.actors.get(id);
      a.reset?.();
      return {
        spell1max: a.system?.spells?.spell1?.max,
        ability: a.system?.attributes?.spellcasting,
        cantrips: a.items.filter(i => i.type === 'spell').map(i => i.name),
      };
    }, wiz.actor.id),
    60_000,
    'wizRead'
  );
  console.log(JSON.stringify(wizRead, null, 2));
  assert(
    wizRead?.spell1max >= 2,
    `D2: Wizard L1 spell slots auto-derived (spell1.max=${wizRead?.spell1max})`
  );
  assert(
    (wizRead?.cantrips?.length ?? 0) >= 2,
    `D3: chosen cantrips imported (${wizRead?.cantrips?.join(', ')})`
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-pc] FATAL: ${e?.message || String(e)}`);
} finally {
  try {
    await withNodeTimeout(
      f.call('deleteActor', { identifiers: createdNames, removeEmptyFolder: true }),
      30_000,
      'cleanup'
    );
    // belt-and-suspenders: sweep any ZZ-PC-IT actors that slipped through
    const swept = await withNodeTimeout(
      f.evaluate(async tag => {
        const hits = globalThis.game.actors.filter(a => a.name?.startsWith(tag));
        for (const a of hits) await a.delete();
        return hits.length;
      }, TAG),
      30_000,
      'sweep'
    );
    console.log(`[verify-pc] cleanup done (swept ${swept} stray ${TAG} actor(s))`);
  } catch (e) {
    console.log(`[verify-pc] cleanup note: ${e?.message || e}`);
  }
  await f.dispose?.();
}

console.log(`\n==== verify-pc-build: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
