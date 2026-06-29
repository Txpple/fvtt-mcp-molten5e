// Live verification for tool-hardening ③ — the content-audit finishing check (rules 7/8/9 safety net).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). On a throwaway NPC it INJECTS
// one violation per rule, then asserts auditContent flags exactly those — and does NOT flag a magic
// item that DOES have a loot twin:
//   rule 8 — a feature given a placeholder icon.
//   rule 7 — a feature whose description contains GM-fudge language.
//   rule 9 — a magic weapon on the NPC with no loot twin (lootCopy:false).
//   (control) a magic weapon WITH a loot twin (lootCopy:true) → not flagged.
// Cleaned up in `finally`.
//
// Build first: npm run build. Run: node scripts/verify-content-audit.mjs
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

const TAG = 'ZZ-AUDIT-IT';
const LOOT_FOLDER = `${TAG} Loot`;
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
  console.log('[verify-audit] connecting to sandbox…');
  await f.connect();
  console.log('[verify-audit] connected\n');

  const creatures = await f.call('searchCompendiumFaceted', { documentType: 'creature', limit: 1 });
  const cHit = (Array.isArray(creatures) ? creatures : [])[0];
  if (!cHit?.pack) throw new Error('could not resolve a source creature');
  const aOut = await f.call('createActorFromCompendium', {
    packId: cHit.pack,
    itemId: cHit.id,
    customNames: [`${TAG} Host`],
    quantity: 1,
    addToScene: false,
  });
  actorId = aOut?.actors?.[0]?.id;
  if (!actorId) throw new Error('host NPC not created');
  console.log(`[verify-audit] host NPC: ${aOut.actors[0].name} (${actorId})\n`);

  // Inject one violation per rule.
  console.log('# inject violations');
  await f.call('addPassiveFeatureToActor', {
    actorIdentifier: actorId,
    featureName: `${TAG} Blank Trait`,
    description: 'A perfectly fine description.',
    img: 'icons/svg/mystery-man.svg', // placeholder — rule 8
  });
  await f.call('addPassiveFeatureToActor', {
    actorIdentifier: actorId,
    featureName: `${TAG} Fudge Trait`,
    description: 'GM, treat its radiant flame as necrotic damage for this villain.', // rule 7
  });
  await f.call('addItem', {
    actorIdentifier: actorId,
    itemType: 'weapon',
    name: `${TAG} Orphan Blade`,
    damage: { number: 1, denomination: 8, types: ['slashing'] },
    magicalBonus: 1,
    lootCopy: false, // magic, NO twin — rule 9
  });
  await f.call('addItem', {
    actorIdentifier: actorId,
    itemType: 'weapon',
    name: `${TAG} Looted Blade`,
    damage: { number: 1, denomination: 8, types: ['slashing'] },
    magicalBonus: 1,
    lootCopy: true, // magic, HAS a twin — control (not flagged)
    lootCopyFolder: LOOT_FOLDER,
  });
  console.log(
    '  (added: blank-icon feature, fudge feature, orphan magic weapon, looted magic weapon)'
  );

  // Audit the actor.
  console.log('\n# audit the actor');
  const audit = await f.call('auditContent', { actorIdentifiers: [actorId] });
  const findings = audit?.findings ?? [];
  const has = (rule, name) => findings.some(x => x.rule === rule && (x.name ?? '').includes(name));

  assert(has(8, 'Blank Trait'), 'rule 8 — flags the placeholder-icon feature');
  assert(has(7, 'Fudge Trait'), 'rule 7 — flags the GM-fudge description');
  assert(has(9, 'Orphan Blade'), 'rule 9 — flags the magic weapon with no loot twin');
  assert(!has(9, 'Looted Blade'), 'rule 9 — does NOT flag the magic weapon that has a loot twin');
  assert(audit?.ok === false, 'audit reports ok:false when violations exist');
  console.log(
    `        counts: fudge=${audit?.counts?.rule7_fudge} icon=${audit?.counts?.rule8_icon} loot=${audit?.counts?.rule9_loot}`
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-audit] FATAL: ${e?.message || String(e)}`);
} finally {
  try {
    await f.call('deleteFolder', { identifier: LOOT_FOLDER, type: 'Item', deleteContents: true });
  } catch {
    /* best-effort */
  }
  if (actorId) {
    try {
      await f.call('deleteActor', { identifiers: [actorId], removeEmptyFolder: true });
    } catch {
      /* best-effort */
    }
  }
  console.log('\n[verify-audit] cleaned up host NPC + loot folder');
  await f.dispose?.();
}

console.log(`\n==== content-audit verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
