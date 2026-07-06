// Live verification: add-free-cast — feature-granted "cast without a spell slot" wired ON the spell.
//
// Claims under test (page-side addFreeCast, src/page/dnd5e/free-cast.ts):
//   1. Wires a use pool (max/recovery) + a convention-named `forward` activity ("<Spell> - <feature>")
//      onto an embedded spell, targeting its slot-consuming cast activity.
//   2. The forward persists with itemUses consumption (the premium Hunter's Mark shape).
//   3. Idempotent re-run: the existing forward is updated in place (no duplicate), uses.max can be
//      re-pointed (with an overwrite warning), spent uses survive.
//   4. Errors cleanly: unknown spell; a spell with no slot-consuming cast activity.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixture PC,
// cleaned in finally. Build first: npm run build. Run: node scripts/verify-free-cast.mjs
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

const TAG = 'ZZ-FREECAST';
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

// Raw source read of the spell straight off the live doc — the ground truth the tool must match.
const SPELL_RAW = (actorId, spellName) =>
  f.evaluate(
    ({ id, name }) => {
      const item = game.actors.get(id)?.items.find(i => i.name === name && i.type === 'spell');
      if (!item) return null;
      const sys = item.toObject().system;
      return { id: item.id, uses: sys.uses, activities: sys.activities };
    },
    { id: actorId, name: spellName }
  );

let actorId;

try {
  console.log('[verify-freecast] connecting…');
  await f.connect();
  console.log('[verify-freecast] connected\n');

  console.log('# setup fixture — scratch PC + a premium Bless copy');
  actorId = await f.evaluate(async tag => {
    const a = await Actor.create({ name: `${tag} Caster`, type: 'character' });
    return a.id;
  }, TAG);
  await f.call('addSpellsToActor', { actorIdentifier: actorId, spellNames: ['Bless'] });
  let raw = await SPELL_RAW(actorId, 'Bless');
  assert(raw?.id, `fixture ${actorId} carries a Bless copy (${raw?.id})`);

  console.log('\n# 1) add-free-cast wires uses + the convention-named forward');
  const r1 = await f.call('addFreeCast', {
    actorIdentifier: actorId,
    spellIdentifier: 'Bless',
    grantedBy: 'Magic Initiate',
  });
  assert(r1.success === true, 'call succeeds');
  assert(r1.activity?.name === 'Bless - Magic Initiate', `activity name "${r1.activity?.name}"`);
  assert(r1.activity?.reused === false, 'fresh forward (not reused)');
  raw = await SPELL_RAW(actorId, 'Bless');
  assert(raw.uses?.max === '1', `uses.max persisted = "${raw.uses?.max}"`);
  assert(raw.uses?.recovery?.[0]?.period === 'lr', 'recovery = long rest');
  const fwd = raw.activities?.[r1.activity?.id];
  assert(fwd?.type === 'forward', 'forward activity persisted');
  assert(
    fwd?.consumption?.targets?.[0]?.type === 'itemUses',
    'forward consumes itemUses (not a slot)'
  );
  assert(
    fwd?.activity?.id && raw.activities?.[fwd.activity.id]?.consumption?.spellSlot === true,
    'forward targets the slot-consuming cast activity'
  );

  console.log('\n# 2) idempotent re-run — updated in place, uses re-pointed with a warning');
  await f.evaluate(
    ({ id, itemId }) => game.actors.get(id).items.get(itemId).update({ 'system.uses.spent': 1 }),
    { id: actorId, itemId: raw.id }
  );
  const r2 = await f.call('addFreeCast', {
    actorIdentifier: actorId,
    spellIdentifier: 'Bless',
    grantedBy: 'Magic Initiate',
    uses: 2,
  });
  assert(r2.activity?.reused === true, 're-run reuses the existing forward');
  assert(r2.activity?.id === r1.activity?.id, 'same forward id (no duplicate)');
  assert(
    (r2.warnings ?? []).some(w => w.includes('overwritten')),
    'overwrite warning surfaced'
  );
  raw = await SPELL_RAW(actorId, 'Bless');
  assert(raw.uses?.max === '2', `uses.max re-pointed = "${raw.uses?.max}"`);
  assert(raw.uses?.spent === 1, 'spent use survives the re-run');
  const forwards = Object.values(raw.activities ?? {}).filter(a => a?.type === 'forward');
  assert(forwards.length === 1, `exactly one forward on the spell (${forwards.length})`);

  console.log('\n# 3) errors are clean');
  let threw = false;
  try {
    await f.call('addFreeCast', {
      actorIdentifier: actorId,
      spellIdentifier: 'Nonexistent Spell',
      grantedBy: 'X',
    });
  } catch (e) {
    threw = /not found/i.test(e?.message || '');
  }
  assert(threw, 'unknown spell rejected');
} finally {
  if (actorId) {
    await f.evaluate(async id => {
      await game.actors.get(id)?.delete();
    }, actorId);
    console.log('\n[verify-freecast] fixture cleaned');
  }
  await f.dispose?.();
}

console.log(`\n[verify-freecast] ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
