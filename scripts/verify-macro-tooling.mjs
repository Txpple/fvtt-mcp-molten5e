// Live verification: create-macro / list-macros / delete-macro — the macro namespace
// (src/page/macros.ts).
//
// Claims under test:
//   1. createMacro creates a script macro with the stock icon, grants the hotbar user OWNER,
//      and pins it to that user's first free hotbar slot by default.
//   2. A second default pin lands on the next free slot; an explicit slot is honored.
//   3. Re-pinning an occupied slot replaces it and warns.
//   4. Script-permission warning matches the world's MACRO_SCRIPT config for the grantee's role.
//   5. Chat macros create with type 'chat'.
//   6. listMacros surfaces the macros with their hotbar pins.
//   7. deleteMacros scrubs the user's hotbar slots and deletes the documents.
//   8. Guards: missing command, hotbarSlot without hotbarUser, unknown user, unknown macro.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). Throwaway fixture user +
// macros, cleaned in finally. Build first: npm run build. Run: node scripts/verify-macro-tooling.mjs
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

const TAG = 'ZZ-MACROTEST';
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

let userId;

try {
  console.log('[verify-macros] connecting…');
  await f.connect();
  console.log('[verify-macros] connected\n');

  console.log('# setup fixture (throwaway player-role user with an empty hotbar)');
  ({ userId } = await f.evaluate(async tag => {
    const u = await User.create({ name: tag, role: CONST.USER_ROLES.PLAYER });
    return { userId: u.id };
  }, TAG));
  console.log(`  user ${userId}\n`);

  console.log('# 1) create script macro — ownership, stock icon, default first-free-slot pin');
  const r1 = await f.call('createMacro', {
    name: `${TAG} One`,
    command: 'console.log(1)',
    hotbarUser: userId,
  });
  assert(r1.success === true && r1.macro?.id, 'returns { success, macro.id }');
  assert(r1.macro?.type === 'script', `type defaults to script: ${r1.macro?.type}`);
  assert(r1.hotbar?.slot === 1, `fresh hotbar pins slot 1: ${r1.hotbar?.slot}`);
  const live1 = await f.evaluate(
    ({ userId, macroId }) => {
      const m = game.macros.get(macroId);
      return {
        img: m?.img,
        ownership: m?.ownership?.[userId],
        hotbarSlot1: game.users.get(userId)?.hotbar?.[1] ?? null,
      };
    },
    { userId, macroId: r1.macro.id }
  );
  assert(live1.img === 'icons/svg/dice-target.svg', `stock icon applied: ${live1.img}`);
  assert(live1.ownership === 3, `hotbar user granted OWNER (3): ${live1.ownership}`);
  assert(live1.hotbarSlot1 === r1.macro.id, 'live hotbar slot 1 holds the macro');

  console.log('# 2) permission warning matches world MACRO_SCRIPT config for role 1');
  const scriptAllowed = await f.evaluate(() =>
    (game.permissions?.MACRO_SCRIPT ?? []).includes(CONST.USER_ROLES.PLAYER)
  );
  const permWarned = (r1.warnings ?? []).some(w => /Use Script Macros/.test(w));
  assert(
    scriptAllowed ? !permWarned : permWarned,
    `world allows player scripts=${scriptAllowed}, warning fired=${permWarned}`
  );

  console.log('# 3) second default pin → next free slot; explicit slot honored');
  const r3a = await f.call('createMacro', {
    name: `${TAG} Two`,
    command: 'console.log(2)',
    hotbarUser: userId,
  });
  assert(r3a.hotbar?.slot === 2, `next free slot is 2: ${r3a.hotbar?.slot}`);
  const r3b = await f.call('createMacro', {
    name: `${TAG} Three`,
    command: 'console.log(3)',
    hotbarUser: userId,
    hotbarSlot: 7,
  });
  assert(r3b.hotbar?.slot === 7, `explicit slot 7 honored: ${r3b.hotbar?.slot}`);

  console.log('# 4) re-pinning an occupied slot replaces + warns');
  const r4 = await f.call('createMacro', {
    name: `${TAG} Four`,
    command: 'console.log(4)',
    hotbarUser: userId,
    hotbarSlot: 7,
  });
  assert(
    (r4.warnings ?? []).some(w => /slot 7 .*held .*Three/.test(w)),
    `replace warning names the evicted macro: ${JSON.stringify(r4.warnings)}`
  );
  const live4 = await f.evaluate(({ userId }) => game.users.get(userId)?.hotbar?.[7] ?? null, {
    userId,
  });
  assert(live4 === r4.macro.id, 'live slot 7 holds the replacement');

  console.log('# 5) chat macro type');
  const r5 = await f.call('createMacro', { name: `${TAG} Chat`, command: 'Hello', type: 'chat' });
  assert(r5.macro?.type === 'chat', `type chat: ${r5.macro?.type}`);
  assert(!r5.hotbar, 'no hotbar pin when hotbarUser omitted');

  console.log('# 6) listMacros — fixture macros present with hotbar pins');
  const r6 = await f.call('listMacros');
  assert(r6.success === true && Array.isArray(r6.macros), 'returns { success, macros[] }');
  const listed = r6.macros.find(m => m.id === r1.macro.id);
  assert(!!listed, 'macro One listed');
  assert(
    (listed?.hotbar ?? []).some(p => p.userId === userId && p.slot === 1),
    `list shows the slot-1 pin: ${JSON.stringify(listed?.hotbar)}`
  );

  console.log('# 7) deleteMacros — scrubs hotbar slots, deletes documents, reports missing');
  const r7 = await f.call('deleteMacros', {
    macros: [r1.macro.id, `${TAG} Two`, `${TAG} Three`, `${TAG} Four`, `${TAG} Chat`, 'ZZ-NOPE'],
  });
  assert(r7.deleted?.length === 5, `deleted 5: ${r7.deleted?.length}`);
  assert(
    (r7.scrubbedHotbarSlots ?? []).filter(s => s.userId === userId).length === 3,
    `scrubbed 3 fixture slots: ${JSON.stringify(r7.scrubbedHotbarSlots)}`
  );
  assert(r7.missing?.includes('ZZ-NOPE'), 'unknown identifier reported as missing');
  const live7 = await f.evaluate(
    ({ userId, ids }) => ({
      hotbar: Object.values(game.users.get(userId)?.hotbar ?? {}),
      remaining: ids.filter(id => !!game.macros.get(id)),
    }),
    { userId, ids: [r1.macro.id, r3a.macro.id, r3b.macro.id, r4.macro.id, r5.macro.id] }
  );
  assert(live7.hotbar.length === 0, `live hotbar empty: ${JSON.stringify(live7.hotbar)}`);
  assert(live7.remaining.length === 0, 'all fixture macros gone from the world');

  console.log('# 8) guards');
  let noCommand = false;
  try {
    await f.call('createMacro', { name: `${TAG} Bad` });
  } catch (e) {
    noCommand = /command is required/.test(e?.message || '');
  }
  assert(noCommand, 'missing command refused');
  let slotNoUser = false;
  try {
    await f.call('createMacro', { name: `${TAG} Bad`, command: 'x', hotbarSlot: 1 });
  } catch (e) {
    slotNoUser = /hotbarSlot requires hotbarUser/.test(e?.message || '');
  }
  assert(slotNoUser, 'hotbarSlot without hotbarUser refused');
  let unknownUser = false;
  try {
    await f.call('createMacro', {
      name: `${TAG} Bad`,
      command: 'x',
      hotbarUser: 'ZZ-NO-SUCH-USER',
    });
  } catch (e) {
    unknownUser = /not found.*Users in this world/is.test(e?.message || '');
  }
  assert(unknownUser, 'unknown hotbar user errors with the roster (and creates nothing)');
  const orphan = await f.evaluate(tag => !!game.macros.getName(`${tag} Bad`), TAG);
  assert(!orphan, 'failed create left no orphan macro');
  let unknownMacro = false;
  try {
    await f.call('deleteMacros', { macros: ['ZZ-NO-SUCH-MACRO'] });
  } catch (e) {
    unknownMacro = /no macros matched/.test(e?.message || '');
  }
  assert(unknownMacro, 'deleting only unknown identifiers errors');
} finally {
  await f
    .evaluate(
      async ({ userId, tag }) => {
        const strays = game.macros.contents.filter(m => m.name?.startsWith(tag)).map(m => m.id);
        if (strays.length) await game.macros.documentClass.deleteDocuments(strays);
        if (userId) await game.users.get(userId)?.delete();
      },
      { userId, tag: TAG }
    )
    .catch(e => console.log(`[verify-macros] cleanup failed: ${e?.message}`));
  console.log('\n[verify-macros] fixtures cleaned');
  await f.dispose?.();
}

console.log(`\n[verify-macros] ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
