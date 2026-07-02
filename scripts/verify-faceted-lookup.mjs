// Live verification of the faceted compendium engine (src/page/compendium-facets.ts) against the
// Molten `sandbox` world — the Phase-4 sign-off for the compendium-lookup overhaul. Drives a real
// headless Foundry session through the foundry.call seam (bypassing the MCP process, so it exercises
// the freshly-built dist/page.bundle.js without a Claude Code restart) and asserts, per content
// family: results are returned, NO SRD (dnd5e.*) pack ever surfaces, every hit is a premium book
// pack (premium-first), and the friendly->dnd5e key normalizations (school, rarity, size) took.
//
// Build first: npm run build. Run: node scripts/verify-faceted-lookup.mjs
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

// Mirror of src/utils/compendium-sources.ts (kept inline — this script can't import TS).
const PREMIUM = [
  'dnd-monster-manual.',
  'dnd-players-handbook.',
  'dnd-dungeon-masters-guide.',
  'dnd-heroes-faerun.',
  'dnd-ravenloft-horrors-within.',
];
const isSrd = p => typeof p === 'string' && p.startsWith('dnd5e.');
const isPremium = p => typeof p === 'string' && PREMIUM.some(pre => p.startsWith(pre));

const allHits = []; // every hit seen across all checks — for the global no-SRD assertion
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

function packDist(hits) {
  const m = new Map();
  for (const h of hits) m.set(h.pack, (m.get(h.pack) ?? 0) + 1);
  return [...m.entries()].map(([p, n]) => `${p}=${n}`).join(', ');
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  password: env.FOUNDRY_PASSWORD,
});

async function facet(label, args, checks) {
  console.log(`\n# ${label}`);
  let hits;
  try {
    hits = await f.call('searchCompendiumFaceted', args);
  } catch (e) {
    fails++;
    console.log(`  FAIL  call threw: ${(e?.message || String(e)).slice(0, 160)}`);
    return [];
  }
  if (!Array.isArray(hits)) {
    fails++;
    console.log(`  FAIL  expected an array, got ${typeof hits}`);
    return [];
  }
  allHits.push(...hits);
  console.log(
    `  -> ${hits.length} hits; sample: ${hits
      .slice(0, 5)
      .map(h => h.name)
      .join(' | ')}`
  );
  console.log(`     packs: ${packDist(hits) || '(none)'}`);
  // Universal invariants for any non-empty result set.
  if (hits.length > 0) {
    assert(
      hits.every(h => !isSrd(h.pack)),
      'no SRD (dnd5e.*) pack in results'
    );
    assert(
      hits.every(h => isPremium(h.pack)),
      'every hit is a premium book pack'
    );
  }
  checks?.(hits);
  return hits;
}

try {
  console.log('[verify-faceted] connecting to sandbox…');
  await f.connect();
  console.log('[verify-faceted] connected — exercising the faceted engine\n');

  // --- Creatures ---------------------------------------------------------
  await facet(
    'creatures: CR 1–5',
    { documentType: 'creature', challengeRating: { min: 1, max: 5 }, limit: 20 },
    hits => {
      assert(hits.length > 0, 'returns creatures');
      assert(
        hits.every(h => h.facets.challengeRating >= 1 && h.facets.challengeRating <= 5),
        'all CR within 1–5'
      );
    }
  );
  await facet(
    'creatures: type=dragon',
    { documentType: 'creature', creatureType: 'dragon', limit: 20 },
    hits => {
      assert(hits.length > 0, 'returns dragons');
      assert(
        hits.every(h => h.facets.creatureType === 'dragon'),
        'all facets.creatureType === "dragon"'
      );
    }
  );
  await facet(
    'creatures: size=large (friendly enum -> "lg")',
    { documentType: 'creature', size: 'large', limit: 10 },
    hits => {
      assert(hits.length > 0, 'returns large creatures');
      assert(
        hits.every(h => h.facets.size === 'lg'),
        'all facets.size === "lg" (size key mapped)'
      );
    }
  );

  // --- Spells ------------------------------------------------------------
  await facet('spells: level=3', { documentType: 'spell', spellLevel: 3, limit: 20 }, hits => {
    assert(hits.length > 0, 'returns level-3 spells');
    assert(
      hits.every(h => h.facets.spellLevel === 3),
      'all facets.spellLevel === 3'
    );
  });
  await facet(
    'spells: school="evocation" (friendly -> "evo")',
    { documentType: 'spell', spellSchool: 'evocation', limit: 20 },
    hits => {
      assert(hits.length > 0, 'returns evocation spells');
      assert(
        hits.every(h => h.facets.spellSchool === 'evo'),
        'all facets.spellSchool === "evo" (school normalized)'
      );
    }
  );
  await facet(
    'spells: damageType=fire (two-stage), level 1–3',
    { documentType: 'spell', damageType: 'fire', spellLevel: { min: 1, max: 3 }, limit: 20 },
    hits => {
      assert(hits.length > 0, 'returns fire spells (two-stage refine worked)');
    }
  );

  // --- Items -------------------------------------------------------------
  await facet(
    'items: rarity="very rare" (friendly -> "veryRare")',
    { documentType: 'gear', rarity: 'very rare', limit: 20 },
    hits => {
      assert(hits.length > 0, 'returns very-rare items (rarity key mapped)');
      assert(
        hits.every(h => h.facets.rarity === 'veryRare'),
        'all facets.rarity === "veryRare"'
      );
    }
  );
  await facet(
    'items: wondrous + magical',
    { documentType: 'gear', itemType: 'wondrous', magical: true, limit: 20 },
    hits => {
      assert(hits.length > 0, 'returns magical wondrous items');
      assert(
        hits.every(h => h.facets.magical === true),
        'all facets.magical === true'
      );
    }
  );
  await facet(
    'items: weapon family, rare',
    { documentType: 'weapon', rarity: 'rare', limit: 20 },
    hits => {
      assert(hits.length > 0, 'returns rare weapons');
    }
  );

  // --- Global invariant --------------------------------------------------
  console.log('\n# global');
  assert(allHits.length > 0, 'collected hits across all checks');
  assert(
    allHits.every(h => !isSrd(h.pack)),
    `ZERO SRD packs across all ${allHits.length} hits`
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-faceted] FATAL: ${e?.message || String(e)}`);
} finally {
  await f.dispose?.();
}

console.log(`\n==== faceted-lookup verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
