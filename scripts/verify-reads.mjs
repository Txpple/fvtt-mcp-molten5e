// Live verification of the read-side page library against the Molten world.
// Calls every read function through the foundry.call seam with args derived from
// real world data, and reports a PASS/FAIL + shape summary per function.
// Build first: npm run build. Run: node scripts/verify-reads.mjs
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

function summarize(r) {
  if (r === null || r === undefined) return String(r);
  if (Array.isArray(r))
    return (
      `array(${r.length})` + (r.length ? ` first.keys={${Object.keys(r[0] ?? {}).join(',')}}` : '')
    );
  if (typeof r === 'object') return `obj.keys={${Object.keys(r).join(',')}}`;
  return `${typeof r}: ${String(r).slice(0, 50)}`;
}

const rows = [];
async function check(name, fn) {
  try {
    const r = await fn();
    rows.push([name, 'OK', summarize(r)]);
    return r;
  } catch (e) {
    rows.push([name, 'FAIL', (e?.message || String(e)).slice(0, 120)]);
    return null;
  }
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
});
try {
  await f.connect();

  await check('getWorldInfo', () => f.call('getWorldInfo'));
  const actors = await check('listActors', () => f.call('listActors', {}));
  const actorName = actors?.[0]?.name;
  await check('getCharacterInfo', () => f.call('getCharacterInfo', { characterName: actorName }));
  await check('searchCharacterItems', () =>
    f.call('searchCharacterItems', { characterIdentifier: actorName })
  );
  await check('findActor', () =>
    f.call('findActor', { identifier: (actorName || 'a').split(' ')[0] })
  );

  await check('getActiveScene', () => f.call('getActiveScene'));
  await check('listScenes', () => f.call('listScenes', {}));

  await check('getAvailablePacks', () => f.call('getAvailablePacks'));
  const search = await check('searchCompendium', () =>
    f.call('searchCompendium', { query: 'goblin' })
  );
  const sc0 = search?.[0];
  if (sc0)
    await check('getCompendiumDocumentFull', () =>
      f.call('getCompendiumDocumentFull', { packId: sc0.pack, documentId: sc0.id })
    );

  const journals = await check('listJournals', () => f.call('listJournals'));
  const j0 = journals?.[0];
  if (j0) {
    await check('getJournalContent', () => f.call('getJournalContent', { journalId: j0.id }));
    const p0 = j0.pages?.[0];
    if (p0)
      await check('getJournalPageContent', () =>
        f.call('getJournalPageContent', { journalId: j0.id, pageId: p0.id })
      );
  }

  const items = await check('listWorldItems', () => f.call('listWorldItems', {}));
  const i0 = items?.[0];
  if (i0) await check('getWorldItem', () => f.call('getWorldItem', { identifier: i0.id }));

  await check('getActorOwnership', () => f.call('getActorOwnership', { actorIdentifier: 'all' }));
  await check('getFriendlyNPCs', () => f.call('getFriendlyNPCs'));
  await check('getPartyCharacters', () => f.call('getPartyCharacters'));
  await check('getConnectedPlayers', () => f.call('getConnectedPlayers'));
  await check('findPlayers', () => f.call('findPlayers', { identifier: 'Player' }));

  await check('listPlaylists', () => f.call('listPlaylists'));
  const tables = await check('listRollTables', () => f.call('listRollTables'));
  const t0 = tables?.[0];
  if (t0) await check('rollOnTable', () => f.call('rollOnTable', { identifier: t0.id }));
  await check('listCards', () => f.call('listCards'));

  // Creature index — scans Actor packs on demand; may be slow.
  await check('listCreaturesByCriteria', () =>
    f.call('listCreaturesByCriteria', { challengeRating: 1 })
  );
  await check('getEnhancedCreatureIndex', () => f.call('getEnhancedCreatureIndex'));
} finally {
  await f.dispose();
}

const pass = rows.filter(r => r[1] === 'OK').length;
console.log('\n=== READ VERIFICATION ===');
for (const [name, status, info] of rows) {
  console.log(`${status === 'OK' ? '✓' : '✗'} ${name.padEnd(26)} ${status.padEnd(5)} ${info}`);
}
console.log(`\n${pass}/${rows.length} passed`);
process.exit(pass === rows.length ? 0 : 1);
