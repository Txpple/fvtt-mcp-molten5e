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

  // =========================================================================
  // PHASE 1 — update-actor: full stat-block round-trip on a temp NPC.
  // =========================================================================
  {
    const npc = await makeTempNpc('ZZ-MCP-AT-NPC');
    const upd = await foundry.call('updateActor', {
      actorIdentifier: npc.id,
      name: 'ZZ-MCP-AT Pit Fiend',
      size: 'large',
      cr: 20,
      creatureType: 'fiend',
      creatureSubtype: 'Devil',
      alignment: 'Lawful Evil',
      biography: '<p>A test fiend.</p>',
      source: { book: 'MM', page: '300', rules: '2024' },
      abilities: { str: 26, dex: 14, con: 24, int: 22, wis: 18, cha: 24 },
      savingThrows: ['dex', 'con', 'wis', 'cha'],
      skills: [
        { skill: 'Perception', proficiency: 'proficient' },
        { skill: 'Stealth', proficiency: 'expert' },
      ],
      hp: { value: 300, max: 300, formula: '24d10 + 168' },
      ac: { calc: 'natural', flat: 19 },
      initiative: { bonus: 2 },
      movement: { walk: 30, fly: 60 },
      senses: { darkvision: 120, truesight: 120 },
      damageImmunities: { values: ['fire', 'poison'] },
      damageResistances: { values: ['cold'] },
      conditionImmunities: { values: ['poisoned'] },
      languages: { values: ['infernal'] },
      telepathy: { value: 120 },
      legendaryActions: 3,
      legendaryResistances: 3,
      habitat: [{ type: 'planar', subtype: 'nine hells' }],
      treasure: { values: ['any'] },
    });
    const okApplied = upd?.success && (upd?.warnings?.length ?? 0) === 0;
    okApplied
      ? pass('update-actor applied', `${upd.applied.length} groups`)
      : fail('update-actor applied', JSON.stringify(upd?.warnings));

    // Read back through the real seam + extractors.
    const info = await foundry.call('getCharacterInfo', { characterName: npc.id });
    const sys = info.system;
    const stats = extractActorStats(info);
    const checks = {
      name: info.name === 'ZZ-MCP-AT Pit Fiend',
      size: sys?.traits?.size === 'lg',
      cr: sys?.details?.cr === 20,
      type: sys?.details?.type?.value === 'fiend' && sys?.details?.type?.subtype === 'Devil',
      strMod: stats.abilities?.str?.modifier === 8, // STR 26 -> +8 (derived)
      ac: stats.armorClass === 19,
      hpFormula: sys?.attributes?.hp?.formula === '24d10 + 168' && sys?.attributes?.hp?.max === 300,
      walkStr: sys?.attributes?.movement?.walk === '30', // FormulaField -> string
      fly: sys?.attributes?.movement?.fly === '60',
      darkvision: sys?.attributes?.senses?.ranges?.darkvision === 120,
      di:
        JSON.stringify([...(sys?.traits?.di?.value ?? [])].sort()) ===
        JSON.stringify(['fire', 'poison']),
      ci: JSON.stringify([...(sys?.traits?.ci?.value ?? [])]) === JSON.stringify(['poisoned']),
      telepathy: sys?.traits?.languages?.communication?.telepathy?.value === 120,
      legact: sys?.resources?.legact?.max === 3,
      habitat: sys?.details?.habitat?.value?.[0]?.subtype === 'nine hells',
      treasure:
        JSON.stringify([...(sys?.details?.treasure?.value ?? [])]) === JSON.stringify(['any']),
      skillExpert: sys?.skills?.ste?.value === 2 && sys?.skills?.prc?.value === 1,
      saveProf: sys?.abilities?.con?.proficient === 1 && sys?.abilities?.str?.proficient === 0,
    };
    const failedChecks = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    failedChecks.length === 0
      ? pass('update-actor round-trip', `${Object.keys(checks).length} fields verified`)
      : fail('update-actor round-trip', `failed: ${failedChecks.join(', ')}`);

    // Set add/remove modes (read-modify-write).
    await foundry.call('updateActor', {
      actorIdentifier: npc.id,
      damageImmunities: { mode: 'add', values: ['acid'] },
    });
    await foundry.call('updateActor', {
      actorIdentifier: npc.id,
      damageImmunities: { mode: 'remove', values: ['fire'] },
    });
    const info2 = await foundry.call('getCharacterInfo', { characterName: npc.id });
    const di2 = [...(info2.system?.traits?.di?.value ?? [])].sort();
    JSON.stringify(di2) === JSON.stringify(['acid', 'poison'])
      ? pass('update-actor Set add/remove', di2.join(','))
      : fail('update-actor Set add/remove', `got ${di2.join(',')}`);
  }

  // PHASE 1 — NPC-only fields warn (not error) on a character.
  {
    const pc = await foundry.evaluate(async () => {
      const a = await globalThis.Actor.create({ name: 'ZZ-MCP-AT-PC', type: 'character' });
      return { id: a.id };
    }, null);
    tempActorIds.push(pc.id);
    const r = await foundry.call('updateActor', {
      actorIdentifier: pc.id,
      abilities: { str: 16 },
      cr: 5, // NPC-only — should warn + skip
    });
    const warned = (r?.warnings ?? []).some(w => w.includes('NPC-only'));
    const appliedStr = (r?.applied ?? []).includes('abilities');
    warned && appliedStr
      ? pass('update-actor NPC-only warns on PC', 'cr skipped, abilities applied')
      : fail(
          'update-actor NPC-only warns on PC',
          JSON.stringify({ applied: r?.applied, warnings: r?.warnings })
        );
  }

  // =========================================================================
  // PHASE 1b — apply-condition: toggle on/off + exhaustion level.
  // =========================================================================
  {
    const npc = await makeTempNpc('ZZ-MCP-AT-COND');
    const on = await foundry.call('applyCondition', {
      actorIdentifier: npc.id,
      conditions: ['poisoned', 'prone'],
    });
    const onOk = on?.statuses?.includes('poisoned') && on?.statuses?.includes('prone');
    onOk
      ? pass('apply-condition add', on.statuses.join(','))
      : fail('apply-condition add', JSON.stringify(on));

    const off = await foundry.call('applyCondition', {
      actorIdentifier: npc.id,
      conditions: ['prone'],
      active: false,
    });
    !off?.statuses?.includes('prone') && off?.statuses?.includes('poisoned')
      ? pass('apply-condition remove', `now ${off.statuses.join(',') || '(none)'}`)
      : fail('apply-condition remove', JSON.stringify(off));

    // Exhaustion level via the dnd5e.exhaustionLevel flag (derives system.attributes.exhaustion).
    await foundry.call('applyCondition', {
      actorIdentifier: npc.id,
      conditions: ['exhaustion'],
      exhaustionLevel: 4,
    });
    const exh = await foundry.evaluate(id => {
      const a = game.actors.get(id);
      const eff = a.effects.find(e => e.statuses?.has?.('exhaustion'));
      return {
        sys: a.system?.attributes?.exhaustion,
        flag: eff?.flags?.dnd5e?.exhaustionLevel,
        name: eff?.name,
      };
    }, npc.id);
    exh?.sys === 4 && exh?.flag === 4
      ? pass('apply-condition exhaustion level', `${exh.name} (sys=${exh.sys})`)
      : fail('apply-condition exhaustion level', JSON.stringify(exh));

    // unknown condition warns, not throws
    const bad = await foundry.call('applyCondition', {
      actorIdentifier: npc.id,
      conditions: ['confuddled'],
    });
    (bad?.warnings ?? []).some(w => w.includes('confuddled'))
      ? pass('apply-condition unknown warns', 'warned')
      : fail('apply-condition unknown warns', JSON.stringify(bad?.warnings));
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
