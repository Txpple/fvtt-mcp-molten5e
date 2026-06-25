// Live verification for Phase 3.2 — Cards: themed-deck creation (face text + art) + preset import.
//
// Drives a real headless Foundry session through the foundry.call seam (exercises the freshly-built
// dist/page.bundle.js WITHOUT a Claude Code restart). Against the live `sandbox` world it proves:
//   * create-cards builds a deck whose cards carry a v14 face — if the face shape { name, text, img }
//     were wrong, CardsClass.create would reject the embedded card on validation, so a clean create
//     with text+img cards proves the shape is accepted;
//   * import-cards instantiates a core PRESET deck headlessly (the poker preset loads a 52-card deck),
//     confirming the preset fetch + create path works;
//   * GUARD: an unknown preset key is refused.
// Everything created is cleaned up.
//
// Build first: npm run build. Run: node scripts/verify-cards-tooling.mjs
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

const TAG = 'ZZ-CARDS-IT';
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
async function expectThrow(label, fn, re) {
  try {
    await fn();
    fails++;
    console.log(`  FAIL  ${label} — expected a throw, none thrown`);
  } catch (e) {
    const m = e?.message || String(e);
    if (re.test(m)) {
      passes++;
      console.log(`  PASS  ${label} — threw ${JSON.stringify(m.slice(0, 90))}`);
    } else {
      fails++;
      console.log(`  FAIL  ${label} — threw but message didn't match ${re}: ${m.slice(0, 140)}`);
    }
  }
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const createdCardIds = [];
try {
  console.log('[verify-cards] connecting to sandbox…');
  await f.connect();
  console.log('[verify-cards] connected — exercising Cards tooling\n');

  // --- 1. create-cards: a themed deck with face text (+ one with art) ---
  console.log('# create-cards: themed deck with face text + art');
  const deck = await f.call('createCards', {
    name: `${TAG} Mini Deck of Many Things`,
    type: 'deck',
    description: 'A small fate deck (verification).',
    cards: [
      {
        name: 'The Sun',
        text: '<p>Gain a wondrous item and 50,000 XP.</p>',
        img: 'icons/svg/sun.svg',
      },
      { name: 'The Void', text: '<p>Your soul is trapped in a distant prison.</p>' },
      { name: 'Balance', text: '<p>Your alignment changes.</p>' },
    ],
  });
  if (deck?.cardsId) createdCardIds.push(deck.cardsId);
  assert(deck?.type === 'deck', `created a deck (${deck?.type})`);
  assert(
    deck?.cardCount === 3,
    `deck has 3 cards — v14 face shape {name,text,img} accepted (${deck?.cardCount})`
  );

  // A hand stack (empty) — type round-trips
  const hand = await f.call('createCards', { name: `${TAG} GM Hand`, type: 'hand' });
  if (hand?.cardsId) createdCardIds.push(hand.cardsId);
  assert(hand?.type === 'hand', `hand stack type round-trips (${hand?.type})`);

  // --- 2. import-cards: a core preset deck (standard 52-card poker deck) ---
  console.log('\n# import-cards: core preset deck');
  const imp = await f.call('importCardsPreset', {
    preset: 'pokerDark',
    name: `${TAG} Standard Deck`,
    folderName: `${TAG} Decks`,
  });
  if (imp?.cardsId) createdCardIds.push(imp.cardsId);
  assert(imp?.preset === 'pokerDark', 'import reports the preset used');
  assert(imp?.cardCount === 52, `preset loaded a standard 52-card deck (${imp?.cardCount})`);
  assert(imp?.cardsName === `${TAG} Standard Deck`, 'imported stack took the supplied name');

  // --- GUARD: unknown preset refused ---
  console.log('\n# guards');
  await expectThrow(
    'import-cards(unknown preset -> refused)',
    () => f.call('importCardsPreset', { preset: 'notARealPreset' }),
    /Unknown card preset/
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-cards] FATAL: ${e?.message || String(e)}`);
} finally {
  if (createdCardIds.length > 0) {
    try {
      await f.call('deleteCards', { identifiers: createdCardIds });
      console.log(`\n[verify-cards] cleaned up ${createdCardIds.length} stack(s)`);
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== cards-tooling verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
