// Live verification: the dnd5e group-actor tools (src/page/dnd5e/group.ts) —
// create-group / manage-group-members / get-group / set-primary-party.
//
// Claims under test:
//   1. create-group is FAIL-CLOSED on members: a bogus member name errors and creates nothing.
//   2. Happy path: create with members + defaultOwnership owner + seed currency → members
//      enrolled via system.addMember, ownership.default 3, coin persisted.
//   3. get-group returns the group-shaped read: roster, currency, ownership, inventory
//      (embedded items), isPrimaryParty=false for a fresh group.
//   4. get-group on a NON-group actor errors naming the actual type.
//   5. manage-group-members: remove + re-add, with per-actor skip classification
//      (already-member / not-a-member / group-actor / not-found).
//   6. Dangling member: delete a member actor → get-group flags it; removal by raw id works.
//   7. set-primary-party: read → set (previous echoed) → re-set is a clean no-op → clear.
//      The live setting is snapshotted first and restored in finally.
//
// Drives a real headless Foundry session (fresh dist/, no CC restart). All test documents are
// deleted and the primaryParty setting restored in finally. Build first: npm run build.
// Run: node scripts/verify-group-tooling.mjs
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

const GROUP_NAME = 'MCP Verify Group';
let memberIds = [];
let groupId = null;
let primaryPartySnapshot = null; // actor id | null — restored in finally

try {
  console.log('[verify-group-tooling] connecting…');
  await f.connect();
  console.log('[verify-group-tooling] connected\n');

  console.log('# 0) setup — snapshot primaryParty, create two throwaway member NPCs');
  primaryPartySnapshot = await f.evaluate(
    () => game.settings.get('dnd5e', 'primaryParty')?.actor?.id ?? null,
    undefined
  );
  console.log(`  primaryParty snapshot: ${primaryPartySnapshot ?? '(none)'}`);
  memberIds = await f.evaluate(async () => {
    const a = await Actor.create({ name: 'MCP Verify Member A', type: 'npc' });
    const b = await Actor.create({ name: 'MCP Verify Member B', type: 'npc' });
    return [a.id, b.id];
  }, undefined);
  assert(memberIds.length === 2, `test members created: ${memberIds.join(', ')}`);

  console.log('\n# 1) create-group is fail-closed on a bad member');
  let threw = null;
  try {
    await f.call('createGroupActor', {
      name: GROUP_NAME,
      members: ['MCP Verify Member A', 'zz-definitely-no-such-actor-zz'],
    });
  } catch (e) {
    threw = e;
  }
  assert(
    threw &&
      /nothing was created.*zz-definitely-no-such-actor-zz/.test(String(threw.message ?? threw)),
    'rejected, listing the unresolved member'
  );
  const ghost = await f.evaluate(
    name => game.actors.find(a => a.name === name)?.id ?? null,
    GROUP_NAME
  );
  assert(ghost === null, 'no group document was created');

  console.log('\n# 2) create-group happy path (members + owner default + coin)');
  const created = await f.call('createGroupActor', {
    name: GROUP_NAME,
    members: ['MCP Verify Member A', memberIds[1]],
    defaultOwnership: 'owner',
    currency: { gp: 25, sp: 10 },
    summary: 'verify-group-tooling scratch group',
  });
  groupId = created.group.id;
  assert(created.success === true && !!groupId, `created ${created.group.name} (${groupId})`);
  assert(
    created.members.length === 2 && created.members.every(m => memberIds.includes(m.id)),
    'both members enrolled via system.addMember'
  );
  assert(created.group.defaultOwnership === 'OWNER', 'ownership.default = OWNER');

  console.log('\n# 3) get-group — the group-shaped read');
  await f.evaluate(async id => {
    await game.actors
      .get(id)
      .createEmbeddedDocuments('Item', [
        { name: 'MCP Verify Rope', type: 'loot', system: { quantity: 2 } },
      ]);
  }, groupId);
  const info = await f.call('getGroupInfo', { groupIdentifier: GROUP_NAME });
  assert(info.id === groupId, 'resolves by name');
  assert(
    info.members
      .map(m => m.id)
      .sort()
      .join() === [...memberIds].sort().join(),
    'roster matches'
  );
  assert(info.currency.gp === 25 && info.currency.sp === 10, 'seeded currency persisted');
  assert(
    info.inventory.length === 1 &&
      info.inventory[0].name === 'MCP Verify Rope' &&
      info.inventory[0].quantity === 2,
    'shared inventory lists the embedded item with quantity'
  );
  assert(info.ownership.default === 'OWNER', 'ownership read back');
  assert(info.isPrimaryParty === false, 'fresh group is not the primary party');

  console.log('\n# 4) get-group on a non-group actor errors naming the type');
  threw = null;
  try {
    await f.call('getGroupInfo', { groupIdentifier: 'MCP Verify Member A' });
  } catch (e) {
    threw = e;
  }
  assert(
    threw && /type "npc", not a group actor/.test(String(threw.message ?? threw)),
    'rejected with the actual type named'
  );

  console.log('\n# 5) manage-group-members — remove, re-add, skip classification');
  const removed = await f.call('manageGroupMembers', {
    groupIdentifier: groupId,
    remove: ['MCP Verify Member B'],
  });
  assert(
    removed.removed.length === 1 &&
      removed.removed[0].id === memberIds[1] &&
      removed.members.length === 1,
    'member removed via system.removeMember'
  );
  const mixed = await f.call('manageGroupMembers', {
    groupIdentifier: groupId,
    add: [memberIds[1], 'MCP Verify Member A', GROUP_NAME, 'zz-no-such-actor-zz'],
    remove: ['MCP Verify Member B'],
  });
  assert(
    mixed.added.length === 1 && mixed.added[0].id === memberIds[1],
    're-added the removed member by id'
  );
  const reasons = Object.fromEntries(mixed.skipped.map(s => [s.identifier, s.reason]));
  assert(reasons['MCP Verify Member A'] === 'already-member', 'already-member classified');
  assert(reasons[GROUP_NAME] === 'group-actor', 'group-in-group classified');
  assert(reasons['zz-no-such-actor-zz'] === 'not-found', 'unresolved add classified');
  assert(
    reasons['MCP Verify Member B'] === 'not-a-member',
    'removing an actor no longer in the group classified (removals plan before adds)'
  );
  assert(mixed.members.length === 2, 'roster back to both members');

  console.log('\n# 6) dangling member — delete the actor, flag it, remove by raw id');
  await f.evaluate(async id => {
    await game.actors.get(id).delete();
  }, memberIds[1]);
  const withDangling = await f.call('getGroupInfo', { groupIdentifier: groupId });
  const dangling = withDangling.members.find(m => m.id === memberIds[1]);
  assert(
    dangling?.dangling === true && dangling.name === null,
    'deleted member flagged dangling in the read'
  );
  const cleanup = await f.call('manageGroupMembers', {
    groupIdentifier: groupId,
    remove: [memberIds[1]],
  });
  assert(
    cleanup.removed.length === 1 && cleanup.members.length === 1,
    'dangling id removed by raw member id'
  );

  console.log('\n# 7) set-primary-party — read, set, no-op, clear');
  const readPp = await f.call('configurePrimaryParty', {});
  assert(
    readPp.changed === false && (readPp.current?.id ?? null) === primaryPartySnapshot,
    `read matches snapshot (${readPp.current?.name ?? '(none)'})`
  );
  const setPp = await f.call('configurePrimaryParty', { groupIdentifier: groupId });
  assert(
    setPp.changed === true &&
      setPp.current?.id === groupId &&
      (setPp.previous?.id ?? null) === primaryPartySnapshot,
    'set echoes previous → current'
  );
  const noopPp = await f.call('configurePrimaryParty', { groupIdentifier: GROUP_NAME });
  assert(noopPp.changed === false && noopPp.current?.id === groupId, 're-set is a clean no-op');
  const clearPp = await f.call('configurePrimaryParty', { clear: true });
  assert(clearPp.changed === true && clearPp.current === null, 'clear unsets');
} finally {
  console.log('\n# cleanup — delete test docs, restore primaryParty');
  try {
    const restored = await f.evaluate(
      async state => {
        await game.settings.set('dnd5e', 'primaryParty', { actor: state.primaryPartyId });
        for (const id of state.deleteIds) {
          await game.actors.get(id)?.delete();
        }
        const leftovers = game.actors.filter(a => a.name?.startsWith('MCP Verify')).map(a => a.id);
        for (const id of leftovers) await game.actors.get(id)?.delete();
        return {
          primaryParty: game.settings.get('dnd5e', 'primaryParty')?.actor?.id ?? null,
          leftoversSwept: leftovers.length,
        };
      },
      { primaryPartyId: primaryPartySnapshot, deleteIds: [groupId, ...memberIds].filter(Boolean) }
    );
    console.log(
      `  restored primaryParty=${restored.primaryParty ?? '(none)'} ` +
        `(snapshot ${primaryPartySnapshot ?? '(none)'}), swept ${restored.leftoversSwept} leftover(s)`
    );
    if ((restored.primaryParty ?? null) !== (primaryPartySnapshot ?? null)) {
      console.log('  RESTORE MISMATCH — re-point primaryParty manually!');
      fails++;
    }
  } catch (e) {
    console.log(`  CLEANUP FAILED — sweep "MCP Verify*" actors and re-check primaryParty: ${e}`);
    fails++;
  }
  await f.close?.();
}

console.log(`\n[verify-group-tooling] ${passes} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
