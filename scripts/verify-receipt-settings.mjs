// E2E verification for the Receipt Settings shipped in fvtt-mod-lootshelf v1.2.0 and
// fvtt-mod-partystash v1.4.0 — one world setting per module choosing between broadcasting
// receipts to the server and whispering them to the transaction's participants and the DMs.
//
// Asserts, per module:
//   A. registration  : `receiptVisibility` is registered, world-scoped, and defaults to public
//   B. settings sheet: the Receipt Settings divider, both radios with their consequence notes,
//                      the real <select> hidden behind them, and a radio click driving it
//   C. participants  : a real transfer under "participants" whispers to the DMs (assistant
//                      DMs included), the acting user, and the personal-side actor's owners —
//                      and to NOBODY else
//   D. public        : the same transfer under "public" posts with no whisper list at all
//
// C drives real module code paths: Loot Shelf through `api.purchase` (its kernel's audit
// line), Party Stash through the paired create/delete its receipt flush treats as a member
// stashing an item. Every fixture — a probe shop, probe items, the probe chat lines — is
// swept in `finally`, and both settings are restored to "public" (the owner's server-wide
// default) whatever happens.
//
// Run: node scripts/verify-receipt-settings.mjs
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

const LOOTSHELF = 'fvtt-mod-lootshelf';
const PARTYSTASH = 'fvtt-mod-partystash';
const PROBE = 'ZZ-Receipt Probe';

let fails = 0;
function assert(cond, msg) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER ?? 'DM Assistant',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

/** A. What the two modules registered. */
const REGISTRATION = async ({ ids }) => {
  const out = {};
  for (const id of ids) {
    const key = `${id}.receiptVisibility`;
    const setting = game.settings.settings.get(key);
    out[id] = {
      active: !!game.modules.get(id)?.active,
      vendedVersion: game.modules.get(id)?.version ?? null,
      registered: !!setting,
      scope: setting?.scope ?? null,
      default: setting?.default ?? null,
      choices: setting?.choices ? Object.keys(setting.choices) : null,
      current: setting ? game.settings.get(id, 'receiptVisibility') : null,
    };
  }
  return out;
};

/** B. The Receipt Settings block as it renders on the settings sheet. */
const SETTINGS_SHEET = async ({ ids }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const app = game.settings.sheet;
  await app.render({ force: true });
  await sleep(2500);
  const root = app.element;
  const out = {};
  for (const id of ids) {
    const select = root.querySelector(`select[name="${id}.receiptVisibility"]`);
    const group = select?.closest('.form-group');
    const radios = [...(group?.querySelectorAll('input[type="radio"]') ?? [])];
    const before = select?.value ?? null;
    // Click the option that is NOT current and confirm the hidden select followed.
    const other = radios.find(r => r.value !== before);
    if (other) {
      other.click();
      await sleep(200);
    }
    // The header sits above the whole receipts block, which in Party Stash starts one group
    // earlier (the on/off toggle) — so look for it across the module's section, not just at
    // this group's shoulder.
    const section = group?.closest('section[data-category]');
    out[id] = {
      hasSelect: !!select,
      selectHidden: !!select?.hidden,
      radioValues: radios.map(r => r.value),
      radioLabels: radios.map(r => r.closest('label')?.textContent.trim() ?? ''),
      notes: [...(group?.querySelectorAll('.form-fields p.hint') ?? [])].map(p =>
        p.textContent.trim()
      ),
      dividers: [...(section?.querySelectorAll('h4.divider') ?? [])].map(h => h.textContent.trim()),
      before,
      afterClick: select?.value ?? null,
      clicked: other?.value ?? null,
      // Nothing may submit under a name core would try to resolve as a second setting.
      strayNamesRegistered: radios.some(r => !!game.settings.settings.get(r.name)),
    };
    // Leave the stored value alone — this sheet is closed without submitting.
    if (before !== null && select) select.value = before;
  }
  await app.close();
  return out;
};

/** Fixture: the party, a member with player owners, and a second member for the negative test. */
const FIXTURE = async () => {
  const group =
    game.actors.find(a => a.type === 'group' && a.name === 'The Party') ??
    game.actors.find(a => a.type === 'group');
  if (!group) return { error: 'no group actor' };
  const members = group.system.members.map(m => m.actor).filter(a => a?.type === 'character');
  const owners = actor => game.users.filter(u => !u.isGM && actor.testUserPermission(u, 'OWNER'));
  const withOwner = members.find(a => owners(a).length);
  if (!withOwner) return { error: 'no member with a non-GM owner' };
  const other = members.find(
    a =>
      a !== withOwner &&
      owners(a).length &&
      !owners(a).some(u => owners(withOwner).some(o => o.id === u.id))
  );
  return {
    groupId: group.id,
    groupName: group.name,
    memberId: withOwner.id,
    memberName: withOwner.name,
    memberOwners: owners(withOwner).map(u => ({ id: u.id, name: u.name })),
    otherId: other?.id ?? null,
    otherName: other?.name ?? null,
    otherOwners: other ? owners(other).map(u => ({ id: u.id, name: u.name })) : [],
    gmUsers: ChatMessage.implementation
      .getWhisperRecipients('GM')
      .map(u => ({ id: u.id, name: u.name, role: u.role })),
    actingUser: { id: game.user.id, name: game.user.name, role: game.user.role },
    // Loot Shelf's kernel — and so its audit line — runs on the GM-ELECT's client
    // (`getDesignatedUser`: the highest-role active GM, which an assistant bridge can never
    // outrank). If that client is still running a pre-deploy script, the C/D loot assertions
    // are measuring the OLD code, not this release.
    activeGM: game.users.activeGM
      ? { name: game.users.activeGM.name, isSelf: game.users.activeGM.isSelf }
      : null,
  };
};

/**
 * C/D — Loot Shelf: buy a free item from a probe shop and report the receipt's audience.
 * The shop is created here and deleted by the caller's sweep.
 */
const LOOTSHELF_BUY = async ({ mode, buyerId, probe }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await game.settings.set('fvtt-mod-lootshelf', 'receiptVisibility', mode);
  const api = game.modules.get('fvtt-mod-lootshelf').api;
  const buyer = game.actors.get(buyerId);

  let shop = game.actors.find(a => a.name === `${probe} Shop`);
  if (!shop) {
    shop = await api.createMerchant({
      name: `${probe} Shop`,
      items: [
        {
          name: `${probe} Trinket`,
          type: 'loot',
          system: { quantity: 1, price: { value: 0, denomination: 'gp' } },
        },
      ],
      priceModifier: 0,
      infiniteStock: true,
    });
  }
  const item = shop.items.find(i => i.name === `${probe} Trinket`);
  // Snapshot the log by ID rather than by clock: the receipt is authored on the GM-ELECT's
  // client, so its timestamp is that machine's clock, and a "since now" filter measures the
  // skew between two boxes instead of the module. `api.purchase` also resolves as soon as the
  // kernel returns — `audit()` is deliberately fire-and-forget — so the line lands a beat
  // later, after a socket round trip. Poll for it.
  const seen = new Set(game.messages.map(m => m.id));
  const fresh = () =>
    [...game.messages].filter(
      m => !seen.has(m.id) && m.speaker?.alias === 'Loot Shelf' && (m.content ?? '').includes(probe)
    );

  await api.purchase({
    merchantUuid: shop.uuid,
    buyerUuid: buyer.uuid,
    itemId: item.id,
    quantity: 1,
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !fresh().length) await sleep(250);
  await sleep(1000); // let a second (unwanted) line arrive too, so `count` can catch it

  const mine = fresh();
  return {
    mode,
    shopId: shop.id,
    count: mine.length,
    whisper: mine.map(m => [...(m.whisper ?? [])]),
    contents: mine.map(m => m.content.replace(/<[^>]+>/g, '')),
  };
};

/**
 * C/D — Party Stash: the create-on-group + delete-on-member pair its flush reads as a member
 * stashing an item (the shape dnd5e's own move pipeline produces), then the receipt's audience.
 */
const PARTYSTASH_STASH = async ({ mode, groupId, memberId, probe }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await game.settings.set('fvtt-mod-partystash', 'receiptVisibility', mode);
  const group = game.actors.get(groupId);
  const member = game.actors.get(memberId);
  const data = { name: `${probe} Bauble`, type: 'loot', system: { quantity: 1 } };

  // Stage the member's copy first and let it settle past the 500ms flush window, so it is
  // context for the pairing rather than an event of its own.
  const [staged] = await member.createEmbeddedDocuments('Item', [data]);
  await sleep(1500);

  const seen = new Set(game.messages.map(m => m.id));
  const fresh = () =>
    [...game.messages].filter(
      m =>
        !seen.has(m.id) && m.speaker?.alias === 'Party Stash' && (m.content ?? '').includes(probe)
    );

  const [landed] = await group.createEmbeddedDocuments('Item', [data]);
  await staged.delete();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !fresh().length) await sleep(250);
  await sleep(1000); // the 500ms flush buffer could still be gathering a second line

  const mine = fresh();
  const out = {
    mode,
    count: mine.length,
    whisper: mine.map(m => [...(m.whisper ?? [])]),
    contents: mine.map(m => m.content.replace(/<[^>]+>/g, '')),
  };
  await landed.delete();
  return out;
};

/**
 * Sweep every probe document and restore the owner's server-wide default.
 *
 * Chat lines are swept by CONTENT, not by the ids the run collected: a receipt the run did not
 * expect (the tidy-up delete of a stashed probe item posts its own ledger line, correctly) is
 * still probe debris, and matching on the probe name catches every one.
 */
const SWEEP = async ({ probe }) => {
  const swept = { actors: [], items: [], messages: 0 };
  for (const actor of [...game.actors].filter(a => a.name.startsWith(probe))) {
    swept.actors.push(actor.name);
    await actor.delete();
  }
  for (const actor of game.actors) {
    const strays = actor.items.filter(i => i.name.startsWith(probe));
    for (const item of strays) {
      swept.items.push(`${actor.name}/${item.name}`);
      await item.delete();
    }
  }
  const ids = [...game.messages].filter(m => (m.content ?? '').includes(probe)).map(m => m.id);
  if (ids.length) {
    await ChatMessage.implementation.deleteDocuments(ids);
    swept.messages = ids.length;
  }
  for (const id of ['fvtt-mod-lootshelf', 'fvtt-mod-partystash']) {
    await game.settings.set(id, 'receiptVisibility', 'public');
  }
  swept.finalMode = {
    lootshelf: game.settings.get('fvtt-mod-lootshelf', 'receiptVisibility'),
    partystash: game.settings.get('fvtt-mod-partystash', 'receiptVisibility'),
  };
  return swept;
};

try {
  console.log('[receipts] connecting…');
  await f.connect();

  // --- A. registration -------------------------------------------------------------------------
  console.log('# A — registration');
  const reg = await f.evaluate(REGISTRATION, { ids: [LOOTSHELF, PARTYSTASH] });
  for (const [id, r] of Object.entries(reg)) {
    console.log(`  [${id}] vended version ${r.vendedVersion} (the process-boot lag is expected)`);
    assert(r.active, `${id}: module active`);
    assert(r.registered, `${id}: receiptVisibility registered`);
    assert(r.scope === 'world', `${id}: world-scoped (got ${r.scope})`);
    assert(r.default === 'public', `${id}: defaults to public (got ${r.default})`);
    assert(
      sameSet(r.choices ?? [], ['public', 'participants']),
      `${id}: exactly two choices (got ${JSON.stringify(r.choices)})`
    );
  }

  // --- B. settings sheet -----------------------------------------------------------------------
  console.log('# B — settings sheet');
  const sheet = await f.evaluate(SETTINGS_SHEET, { ids: [LOOTSHELF, PARTYSTASH] });
  for (const [id, s] of Object.entries(sheet)) {
    assert(s.hasSelect && s.selectHidden, `${id}: the real <select> is present but hidden`);
    assert(
      sameSet(s.radioValues, ['public', 'participants']),
      `${id}: two radios (got ${JSON.stringify(s.radioValues)})`
    );
    assert(
      s.notes.length === 2 && s.notes.every(n => n.length > 40),
      `${id}: each option carries its consequence note`
    );
    assert(
      s.notes.some(n => /assistant dms/i.test(n)),
      `${id}: the participants note names assistant DMs`
    );
    assert(
      (s.dividers ?? []).includes('Receipt Settings'),
      `${id}: a "Receipt Settings" header chapters the block (got ${JSON.stringify(s.dividers)})`
    );
    assert(
      s.afterClick === s.clicked,
      `${id}: clicking a radio drives the hidden select (${s.before} → ${s.afterClick})`
    );
    assert(!s.strayNamesRegistered, `${id}: the radios submit under no registered setting name`);
  }

  // --- fixture ---------------------------------------------------------------------------------
  const fx = await f.evaluate(FIXTURE, {});
  if (fx.error) throw new Error(fx.error);
  console.log(
    `# fixture: ${fx.groupName}; participant ${fx.memberName} ` +
      `(owners: ${fx.memberOwners.map(o => o.name).join(', ') || 'none'})`
  );
  console.log(`  DMs: ${fx.gmUsers.map(u => `${u.name}[role ${u.role}]`).join(', ')}`);
  console.log(`  acting: ${fx.actingUser.name}[role ${fx.actingUser.role}]`);
  console.log(
    `  GM-elect (posts Loot Shelf receipts): ${fx.activeGM?.name ?? 'NONE'}` +
      `${
        fx.activeGM && !fx.activeGM.isSelf
          ? ' — NOT this client; it must have reloaded ' +
            'since the deploy or the loot assertions below measure the old script'
          : ''
      }`
  );
  assert(
    fx.gmUsers.some(u => u.role === 3),
    'an ASSISTANT-role DM exists to prove the rule'
  );

  const expected = [
    ...new Set([...fx.gmUsers.map(u => u.id), fx.actingUser.id, ...fx.memberOwners.map(o => o.id)]),
  ];

  // --- C. participants mode --------------------------------------------------------------------
  console.log('# C — participants and DMs');
  const buy = await f.evaluate(LOOTSHELF_BUY, {
    mode: 'participants',
    buyerId: fx.memberId,
    probe: PROBE,
  });
  assert(buy.count === 1, `loot shelf: one receipt (got ${buy.count})`);
  console.log(`  [loot shelf] ${buy.contents[0] ?? '(none)'}`);
  assert(
    sameSet(buy.whisper[0] ?? [], expected),
    `loot shelf: whispered to the DMs + acting user + ${fx.memberName}'s owners ` +
      `(expected ${expected.length}, got ${(buy.whisper[0] ?? []).length})`
  );

  const stash = await f.evaluate(PARTYSTASH_STASH, {
    mode: 'participants',
    groupId: fx.groupId,
    memberId: fx.memberId,
    probe: PROBE,
  });
  assert(stash.count === 1, `party stash: one receipt (got ${stash.count})`);
  console.log(`  [party stash] ${stash.contents[0] ?? '(none)'}`);
  assert(
    sameSet(stash.whisper[0] ?? [], expected),
    `party stash: whispered to the DMs + acting user + ${fx.memberName}'s owners ` +
      `(expected ${expected.length}, got ${(stash.whisper[0] ?? []).length})`
  );

  if (fx.otherId) {
    const uninvolved = fx.otherOwners.map(o => o.id);
    assert(
      !uninvolved.some(id => (buy.whisper[0] ?? []).includes(id)) &&
        !uninvolved.some(id => (stash.whisper[0] ?? []).includes(id)),
      `an uninvolved player (${fx.otherName}'s owner) is on neither receipt`
    );
  } else {
    console.log('  [note] no second member with a distinct owner — negative case not covered');
  }

  // --- D. public mode --------------------------------------------------------------------------
  console.log('# D — broadcast to the server');
  const buyPublic = await f.evaluate(LOOTSHELF_BUY, {
    mode: 'public',
    buyerId: fx.memberId,
    probe: PROBE,
  });
  assert(
    buyPublic.count === 1 && (buyPublic.whisper[0] ?? []).length === 0,
    `loot shelf: public receipt carries no whisper list (got ${JSON.stringify(buyPublic.whisper)})`
  );

  const stashPublic = await f.evaluate(PARTYSTASH_STASH, {
    mode: 'public',
    groupId: fx.groupId,
    memberId: fx.memberId,
    probe: PROBE,
  });
  assert(
    stashPublic.count === 1 && (stashPublic.whisper[0] ?? []).length === 0,
    `party stash: public receipt carries no whisper list (got ${JSON.stringify(stashPublic.whisper)})`
  );
} catch (err) {
  console.error('\nFATAL:', err?.stack || err);
  fails++;
} finally {
  try {
    const swept = await f.evaluate(SWEEP, { probe: PROBE });
    console.log(
      `\n# sweep: actors [${swept.actors.join(', ') || 'none'}], ` +
        `items [${swept.items.join(', ') || 'none'}], ${swept.messages} chat message(s)`
    );
    console.log(
      `  both settings restored to: loot shelf=${swept.finalMode.lootshelf}, ` +
        `party stash=${swept.finalMode.partystash}`
    );
  } catch (err) {
    console.error(
      '  SWEEP FAILED — check the world for ZZ-Receipt Probe debris:',
      err?.message || err
    );
    fails++;
  }
  await f.dispose?.();
}

console.log(fails ? `\n${fails} assertion(s) failed` : '\nALL PASS');
process.exit(fails ? 1 : 0);
