// Live verification for tool-hardening ①b — author-npc portrait/token by creatureType (rule 8).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). A hand-authored NPC (no
// compendium source) now gets a real, creatureType-appropriate portrait + token instead of the
// mystery-man placeholder. Creates an undead and a beast from scratch and asserts each persists a real
// (non-placeholder) creatureType icon. Cleaned up in `finally`.
//
// Build first: npm run build. Run: node scripts/verify-npc-portrait.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';
import { resolveCreatureIcon, isPlaceholderIcon } from '../dist/page/dnd5e/icons.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const TAG = 'ZZ-PORTRAIT-IT';
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

// A minimal valid NpcInput for createNpcActor (mirrors the unit-test baseNpc factory).
const npc = (name, creatureType) => ({
  name,
  creatureType,
  creatureSubtype: '',
  size: 'medium',
  alignment: 'neutral evil',
  cr: '1',
  hpAverage: 20,
  hpFormula: '3d8+6',
  acMode: 'default',
  abilities: { str: 12, dex: 12, con: 14, int: 8, wis: 10, cha: 8 },
  savingThrows: [],
  walkSpeed: 30,
  flySpeed: 0,
  swimSpeed: 0,
  climbSpeed: 0,
  burrowSpeed: 0,
  hover: false,
  darkvision: 60,
  blindsight: 0,
  tremorsense: 0,
  truesight: 0,
  specialSenses: '',
  skills: [],
  damageImmunities: [],
  damageResistances: [],
  damageVulnerabilities: [],
  conditionImmunities: [],
  languages: ['common'],
  languagesCustom: '',
  biography: 'Authored from scratch.',
  sourceBook: 'MM',
  sourcePage: '1',
  sourceRules: '2024',
});

const created = [];

try {
  console.log('[verify-portrait] connecting to sandbox…');
  await f.connect();
  console.log('[verify-portrait] connected\n');

  for (const type of ['undead', 'beast']) {
    console.log(`# author a from-scratch ${type}`);
    const out = await f.call('createNpcActor', npc(`${TAG} ${type}`, type));
    const id = out?.actor?.id;
    if (!id) throw new Error(`${type} not created`);
    created.push(id);
    const info = await f.call('getCharacterInfo', { characterId: id });
    assert(!isPlaceholderIcon(info?.img), `${type} portrait is real: ${info?.img}`);
    assert(
      info?.img === resolveCreatureIcon(type),
      `${type} portrait matches the creatureType icon`
    );
  }
} catch (e) {
  fails++;
  console.log(`\n[verify-portrait] FATAL: ${e?.message || String(e)}`);
} finally {
  if (created.length) {
    try {
      await f.call('deleteActor', { identifiers: created, removeEmptyFolder: true });
      console.log('\n[verify-portrait] cleaned up authored NPCs');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== npc-portrait verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
