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

// Build a choices map from a needsChoices[] list: concrete (non-wildcard) trait keys, pool uuids,
// and the first available subclass for a Subclass (uuid) choice.
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
    } else if (c.dataKey === 'uuid') {
      if (c.options?.length) choices[lvl][c.id] = { uuid: c.options[0].value };
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

  // ---- Test E (v2): a LEVEL-5 Fighter — multi-level HP, subclass@3 + its features, @scale scales ----
  const lvl5Name = `${TAG} Fighter L5`;
  const e5Dry = await withNodeTimeout(
    f.call('createPcActor', {
      name: lvl5Name,
      className: 'Fighter',
      background: 'Soldier',
      abilities: { str: 16, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
      level: 5,
    }),
    120_000,
    'e5Dry'
  );
  console.log('\n--- Test E: level-5 Fighter dry-run needsChoices ---');
  console.log(
    JSON.stringify(
      e5Dry?.needsChoices?.map(c => ({
        src: c.source,
        title: c.title,
        type: c.type,
        level: c.level,
        count: c.count,
        opts: c.options?.length,
      })),
      null,
      2
    )
  );
  const subChoice = e5Dry?.needsChoices?.find(c => c.type === 'Subclass');
  assert(!!subChoice, 'E1: needsChoices includes the Subclass choice at level 3');
  assert(
    (subChoice?.options?.length ?? 0) > 0,
    `E2: Subclass choice is enriched with the class's subclasses (${subChoice?.options?.length} options: ${(
      subChoice?.options || []
    )
      .slice(0, 3)
      .map(o => o.label)
      .join(', ')}…)`
  );

  const e5Choices = fillChoices(e5Dry?.needsChoices ?? []);
  // pick Champion specifically (deterministic) so we can assert its known L3 features
  const champOpt = subChoice?.options?.find(o => /^champion$/i.test(o.label || ''));
  assert(
    !!champOpt,
    `E2b: Champion is among the Fighter subclass options (${(subChoice?.options || []).map(o => o.label).join(', ')})`
  );
  if (champOpt) e5Choices[String(subChoice.level)][subChoice.id] = { uuid: champOpt.value };
  const e5 = await withNodeTimeout(
    f.call('createPcActor', {
      name: lvl5Name,
      className: 'Fighter',
      background: 'Soldier',
      abilities: { str: 16, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
      choices: e5Choices,
      acceptDefaults: true,
      level: 5,
    }),
    180_000,
    'e5Build'
  );
  createdNames.push(lvl5Name);
  console.log('\n--- Test E: level-5 Fighter build ---');
  console.log(
    JSON.stringify(
      {
        success: e5?.success,
        actor: e5?.actor,
        unresolvedScale: e5?.unresolvedScale,
        warnings: e5?.warnings,
      },
      null,
      2
    )
  );
  assert(e5?.success === true, 'E3: level-5 Fighter built + persisted');
  // d10: L1 max 10 + L2-5 avg 6×4 = 24 → 34 base + CON14(+2)×5 = +10 → 44
  assert(
    e5?.actor?.hp === 44,
    `E4: multi-level HP correct = 44 (d10 max+4×avg6 +CON14×5) (got ${e5?.actor?.hp})`
  );
  const e5Read = await withNodeTimeout(
    f.evaluate(id => {
      const a = globalThis.game.actors.get(id);
      a.reset?.();
      const rd = a.getRollData();
      return {
        level: a.system?.details?.level,
        subclass: a.items.find(i => i.type === 'subclass')?.name ?? null,
        feats: a.items.filter(i => i.type === 'feat').map(i => i.name),
        secondWind: String(
          globalThis.Roll.replaceFormulaData('@scale.fighter.second-wind', rd, {
            missing: '0',
            warn: false,
          })
        ),
        extraAttack: a.items.some(i => /extra attack/i.test(i.name)),
      };
    }, e5.actor.id),
    60_000,
    'e5Read'
  );
  console.log('\n--- Test E readback ---');
  console.log(JSON.stringify(e5Read, null, 2));
  assert(e5Read?.level === 5, `E5: persisted character level = 5 (got ${e5Read?.level})`);
  assert(
    e5Read?.subclass === 'Champion',
    `E6: chosen subclass present (Champion; got ${e5Read?.subclass})`
  );
  assert(
    e5Read?.feats?.some(n => /improved critical|remarkable athlete/i.test(n)),
    `E7: subclass FEATURES granted by advancing the subclass item (feats: ${e5Read?.feats?.join(', ')})`
  );
  assert(e5Read?.extraAttack === true, 'E8: level-5 class feature present (Extra Attack)');
  assert(
    e5Read?.secondWind === '3',
    `E9: @scale scales with level (Fighter L5 second-wind uses = 3; got ${e5Read?.secondWind})`
  );
  assert(
    (e5?.unresolvedScale?.length ?? 0) === 0,
    `E10: no unresolved @scale on the L5 Fighter (${JSON.stringify(e5?.unresolvedScale)})`
  );

  // ---- Test F (v3): LEVEL-UP the L5 Fighter in place → 6 (same class) ----
  const f6 = await withNodeTimeout(
    f.call('levelUpPc', {
      actorIdentifier: e5.actor.id,
      className: 'Fighter',
      acceptDefaults: true,
    }),
    120_000,
    'levelUp6'
  );
  console.log('\n--- Test F: level-up Fighter 5 → 6 ---');
  console.log(
    JSON.stringify({ success: f6?.success, actor: f6?.actor, warnings: f6?.warnings }, null, 2)
  );
  assert(f6?.success === true, 'F1: leveled up in place (success)');
  assert(f6?.actor?.level === 6, `F2: character level = 6 (got ${f6?.actor?.level})`);
  // +avg6 + CON14(+2) = +8 → 44 → 52
  assert(f6?.actor?.hp === 52, `F3: HP delta on level-up = +8 (44 → 52) (got ${f6?.actor?.hp})`);

  // ---- Test G (v3): MULTICLASS the same PC into Wizard 1 → character level 7 ----
  const g7 = await withNodeTimeout(
    f.call('levelUpPc', {
      actorIdentifier: e5.actor.id,
      className: 'Wizard',
      acceptDefaults: true,
    }),
    120_000,
    'multiclass'
  );
  console.log('\n--- Test G: multiclass into Wizard ---');
  console.log(
    JSON.stringify({ success: g7?.success, actor: g7?.actor, warnings: g7?.warnings }, null, 2)
  );
  assert(g7?.success === true, 'G1: multiclassed (success)');
  assert(
    g7?.actor?.level === 7,
    `G2: character level = 7 (Fighter 6 / Wizard 1) (got ${g7?.actor?.level})`
  );
  assert(
    (g7?.actor?.classes || []).some(c => c.name === 'Fighter' && c.levels === 6) &&
      (g7?.actor?.classes || []).some(c => c.name === 'Wizard' && c.levels === 1),
    `G3: two class items (${JSON.stringify(g7?.actor?.classes)})`
  );
  // 2nd class first level = AVG d6 (4) + CON(+2) = +6 → 52 → 58
  assert(g7?.actor?.hp === 58, `G4: multiclass HP = +avg6(d6=4)+CON2 → 58 (got ${g7?.actor?.hp})`);
  const mcRead = await withNodeTimeout(
    f.evaluate(id => {
      const a = globalThis.game.actors.get(id);
      a.reset?.();
      return {
        spell1: a.system?.spells?.spell1?.max,
        saves: Object.entries(a.system?.abilities || {})
          .filter(([, v]) => v?.proficient)
          .map(([k]) => k),
      };
    }, e5.actor.id),
    60_000,
    'mcRead'
  );
  console.log(JSON.stringify(mcRead, null, 2));
  assert(
    mcRead?.spell1 >= 2,
    `G5: multiclass Wizard spell slots auto-derive (spell1.max=${mcRead?.spell1})`
  );
  assert(
    mcRead?.saves?.includes('str') &&
      mcRead?.saves?.includes('con') &&
      !mcRead?.saves?.includes('int'),
    `G6: multiclass proficiency SUBSET — Fighter saves kept, Wizard's INT save NOT granted (saves: ${mcRead?.saves?.join(', ')})`
  );

  // ---- Test H (v3): level-up DRY-RUN surfaces the subclass choice (build L2 → level to 3) ----
  const h2Name = `${TAG} Rogue L2`;
  const h2Dry = await withNodeTimeout(
    f.call('createPcActor', {
      name: h2Name,
      className: 'Rogue',
      abilities: { str: 10, dex: 16, con: 13, int: 12, wis: 11, cha: 8 },
      level: 2,
    }),
    120_000,
    'h2Dry'
  );
  const h2 = await withNodeTimeout(
    f.call('createPcActor', {
      name: h2Name,
      className: 'Rogue',
      abilities: { str: 10, dex: 16, con: 13, int: 12, wis: 11, cha: 8 },
      choices: fillChoices(h2Dry?.needsChoices ?? []),
      acceptDefaults: true,
      level: 2,
    }),
    180_000,
    'h2Build'
  );
  createdNames.push(h2Name);
  assert(h2?.success === true, 'H1: base Rogue L2 built');
  const h3Dry = await withNodeTimeout(
    f.call('levelUpPc', { actorIdentifier: h2.actor.id, className: 'Rogue' }),
    120_000,
    'h3Dry'
  );
  console.log('\n--- Test H: level-up Rogue 2 → 3 dry-run ---');
  console.log(
    JSON.stringify(
      h3Dry?.needsChoices?.map(c => ({ title: c.title, type: c.type, opts: c.options?.length })),
      null,
      2
    )
  );
  const h3Sub = h3Dry?.needsChoices?.find(c => c.type === 'Subclass');
  assert(
    h3Dry?.success === false && !!h3Sub,
    'H2: level-up to 3 dry-run surfaces the Subclass choice (no change)'
  );
  assert(
    (h3Sub?.options?.length ?? 0) > 0,
    `H3: subclass options enriched (${(h3Sub?.options || [])
      .slice(0, 3)
      .map(o => o.label)
      .join(', ')})`
  );
  const h3 = await withNodeTimeout(
    f.call('levelUpPc', {
      actorIdentifier: h2.actor.id,
      className: 'Rogue',
      choices: fillChoices(h3Dry?.needsChoices ?? []),
      acceptDefaults: true,
    }),
    180_000,
    'h3Build'
  );
  assert(
    h3?.success === true && h3?.actor?.level === 3,
    `H4: leveled to 3 with a subclass (level ${h3?.actor?.level})`
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
