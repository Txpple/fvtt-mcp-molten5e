// Repair items whose system.container points at a container that does not exist on the actor.
//
// Found live 2026-08-08 on the Greenrest merchants: stocking them from the PHB compendium left
// goods carrying the container id of the adventuring pack they ship inside (phbagExplorersPa,
// phbagBurglarsPac, …) without those pack containers ever existing as items on the actor. The
// items are therefore parented to nothing.
//
// Fatal under Loot Shelf, whose purchase kernel refuses anything with
// system.container set (transfer.js:326 — "that item is not for sale"). So basics like Rope and
// Torch sit on the shelf and reject every click.
//
// The repair is to null the dangling reference, which makes them ordinary loose stock. Items
// nested in a container that DOES resolve are left alone — that nesting is real.
//
//   node scripts/repair-orphaned-container-refs.mjs                 # report only
//   node scripts/repair-orphaned-container-refs.mjs --apply
//   node scripts/repair-orphaned-container-refs.mjs --actors a,b     # limit to actor ids
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

const arg = n => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const apply = process.argv.includes('--apply');
const only = (arg('actors') ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

setTimeout(() => {
  console.error('[repair] WATCHDOG: 240s elapsed — hard abort');
  process.exit(3);
}, 240_000);

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

console.log('[repair] connecting…');
await f.connect();
console.log(`[repair] connected — mode=${apply ? 'APPLY' : 'REPORT'}\n`);

const report = await f.evaluate(
  async payload => {
    const { apply, only } = payload;
    const results = [];
    for (const a of game.actors) {
      if (only.length && !only.includes(a.id)) continue;
      const orphans = a.items.contents.filter(
        i => i.system?.container && !a.items.get(i.system.container)
      );
      const nestedOk = a.items.contents.filter(
        i => i.system?.container && a.items.get(i.system.container)
      );
      if (!orphans.length && !nestedOk.length) continue;
      const entry = {
        id: a.id,
        name: a.name,
        type: a.type,
        orphans: orphans.map(i => ({ id: i.id, name: i.name, ref: i.system.container })),
        nestedOk: nestedOk.length,
        repaired: 0,
      };
      if (apply && orphans.length) {
        await a.updateEmbeddedDocuments(
          'Item',
          orphans.map(i => ({ _id: i.id, 'system.container': null }))
        );
        entry.repaired =
          a.items.contents.filter(i => i.system?.container && !a.items.get(i.system.container))
            .length === 0
            ? orphans.length
            : -1; // -1 => some survived the write
      }
      results.push(entry);
    }
    return results;
  },
  { apply, only }
);

let totalOrphans = 0;
for (const r of report) {
  totalOrphans += r.orphans.length;
  console.log(`── ${r.name} [${r.type}] ${r.id}`);
  console.log(`   dangling: ${r.orphans.length} · genuinely nested: ${r.nestedOk}`);
  const byRef = {};
  for (const o of r.orphans) (byRef[o.ref] ??= []).push(o.name);
  for (const [ref, names] of Object.entries(byRef))
    console.log(`     ${ref} -> ${names.join(', ')}`);
  if (apply)
    console.log(
      `   repaired: ${r.repaired === -1 ? 'PARTIAL — some refs survived the write' : r.repaired}`
    );
}
if (!report.length) console.log('(no actor carries a container reference)');

console.log(
  `\n[repair] ${totalOrphans} dangling reference(s) across ${report.length} actor(s)` +
    (apply ? ' — cleared' : ' — report only, re-run with --apply')
);
process.exit(0);
