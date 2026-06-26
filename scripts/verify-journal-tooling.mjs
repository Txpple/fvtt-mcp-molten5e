// Live verification for the Phase-2 journal de-leak — the page-model deepening (per-page ownership) +
// the pure block renderer round-trip + the @UUID-link / append primitives.
//
// Drives a real headless Foundry session through the foundry.call seam (fresh dist/, no CC restart).
// The TOOL handlers (JournalTools) are unit-tested; this exercises the PAGE primitives they
// compose, against the live `sandbox` world. It asserts:
//   1. DE-RISK per-page ownership — a journal with a playerVisible handout page + a GM-only page;
//      read back the visibility (proves Foundry v14 persists per-page JournalEntryPage ownership);
//   2. the pure block renderer's house-styled HTML round-trips as page content;
//   3. NPC-link primitives — findActor resolves a real actor; an appended @UUID[Actor.id] link
//      round-trips and preserves existing content;
//   4. findActor refuses an unknown NPC (the basis of link-quest-to-npc's dead-link guard);
//   5. append a session-recap page from blocks (the §8 log path).
// Everything created is namespaced ZZ-JOURNAL-IT and cleaned up.
//
// Build first: npm run build. Run: node scripts/verify-journal-tooling.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';
import { renderStyledHtml } from '../dist/tools/journal/blocks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const TAG = 'ZZ-JOURNAL-IT';
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

let journalId;

try {
  console.log('[verify-journal] connecting to sandbox…');
  await f.connect();
  console.log('[verify-journal] connected — exercising journal page primitives\n');

  // --- 1. DE-RISK per-page ownership ---------------------------------------
  console.log('# create: handout (player-visible) + GM-only page');
  const handoutHtml = renderStyledHtml([
    { type: 'lead', html: 'A note nailed to the tavern door.' },
    { type: 'readaloud', html: '<p>WANTED: whoever cursed the Thorned Grove.</p>' },
  ]);
  const gmHtml = renderStyledHtml([
    { type: 'gmnote', html: '<p>The druid IS the green hag in disguise.</p>' },
    { type: 'list', items: ['DC 15 Insight to notice the glamour'] },
  ]);
  const created = await f.call('createJournal', {
    name: `${TAG} The Thorned Grove`,
    pages: [
      { name: 'Player Handout', content: handoutHtml, ownership: { default: 2 } },
      { name: 'GM Notes', content: gmHtml }, // omitted ownership -> GM-only
    ],
    folderName: `${TAG} Journals`,
  });
  journalId = created?.id;
  assert(Boolean(journalId), 'journal created');
  assert(created?.pageCount === 2, `journal has 2 pages (${created?.pageCount})`);

  console.log('\n# read back per-page visibility (the key de-risk)');
  const list = await f.call('listJournals', {});
  const entry = (Array.isArray(list) ? list : []).find(j => j.id === journalId);
  assert(Boolean(entry), 'journal appears in listJournals');
  const handout = entry?.pages?.find(p => p.name === 'Player Handout');
  const gmPage = entry?.pages?.find(p => p.name === 'GM Notes');
  assert(
    handout?.playerVisible === true,
    'handout page is player-visible — Foundry v14 PERSISTED per-page ownership'
  );
  assert(gmPage?.playerVisible === false, 'GM Notes page is GM-only');

  // --- 2. block renderer round-trips on the page content -------------------
  console.log('\n# block renderer round-trip');
  const handoutContent =
    (await f.call('getJournalPageContent', { journalId, pageId: handout.id }))?.content || '';
  assert(handoutContent.includes('class="mcp-journal"'), 'house style present on the page');
  assert(handoutContent.includes('WANTED: whoever cursed'), 'page carries the caller words');
  assert(handoutContent.includes('class="readaloud"'), 'readaloud box rendered');
  assert(!handoutContent.includes('approaches the party'), 'no fabricated prose present');

  // --- 3. NPC-link primitives ---------------------------------------------
  console.log('\n# NPC @UUID link primitives');
  const actors = await f.call('listActors', {});
  const actor = (Array.isArray(actors) ? actors : [])[0];
  if (actor?.id) {
    const resolved = await f.call('findActor', { identifier: actor.name });
    assert(resolved?.id === actor.id, `findActor resolves "${actor.name}" -> its id`);
    const link = `@UUID[Actor.${resolved.id}]{${resolved.name}}`;
    const before =
      (await f.call('getJournalPageContent', { journalId, pageId: gmPage.id }))?.content || '';
    await f.call('updateJournalContent', {
      journalId,
      pageId: gmPage.id,
      content:
        before +
        renderStyledHtml([
          { type: 'gmnote', html: `<p><strong>Related NPC:</strong> ${link} — quest giver</p>` },
        ]),
    });
    const after =
      (await f.call('getJournalPageContent', { journalId, pageId: gmPage.id }))?.content || '';
    assert(after.includes(`@UUID[Actor.${resolved.id}]`), '@UUID link appended + round-trips');
    assert(after.includes('green hag in disguise'), 'append preserved the existing GM content');
  } else {
    console.log('  SKIP  no world actor available to link');
  }

  // --- 4. dead-link guard basis -------------------------------------------
  console.log('\n# dead-link guard');
  const ghost = await f.call('findActor', { identifier: 'ZZ-NoSuchActor-XYZ-9999' });
  assert(
    ghost === null,
    'findActor returns null for an unknown NPC (link-quest-to-npc would throw)'
  );

  // --- 5. append a session-recap page (the §8 log path) -------------------
  console.log('\n# session-recap append (new page from blocks)');
  const recap = await f.call('updateJournalContent', {
    journalId,
    content: renderStyledHtml([
      { type: 'heading', text: 'Session 1' },
      { type: 'paragraph', html: 'The party found the note and set out for the grove.' },
    ]),
    newPageName: 'Campaign Log',
  });
  assert(Boolean(recap?.success && recap?.pageId), 'session-recap page appended');
  const recapContent =
    (await f.call('getJournalPageContent', { journalId, pageId: recap.pageId }))?.content || '';
  assert(
    recapContent.includes('Session 1') && recapContent.includes('set out for the grove'),
    'recap content round-trips'
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-journal] FATAL: ${e?.message || String(e)}`);
} finally {
  if (journalId) {
    try {
      await f.call('deleteJournals', { identifiers: [journalId] });
      console.log('\n[verify-journal] cleaned up journal');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== journal-tooling verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
