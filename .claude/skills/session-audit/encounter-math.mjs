// encounter-math.mjs — the arithmetic half of the session-audit skill.
//
// An audit is only worth reading if its numbers are right, and encounter math is exactly the kind
// of long addition a model fumbles quietly: thirty-three creatures, four rooms, a hit rate per PC
// per attacker. This script does that arithmetic deterministically so the skill can spend its
// attention on judgment instead of sums.
//
// It needs NO bridge and NO live world — you feed it a JSON file you assembled from the reads, and
// it prints markdown tables ready to paste into the report. That also means you can re-run it
// instantly while trying tuning options ("what if I cut six zombies?") without touching Foundry.
//
// What it computes:
//   * per room  — bodies, total HP, total XP, the DMG budget band, estimated rounds, enemy turns
//   * table time — a fast-table / slow-table RANGE in minutes, against your actual session length
//   * to-hit    — every enemy attack bonus against every PC's real AC
//   * saves     — every save-or-suck DC against every PC's real modifier, with expected value
//
// Usage (from the repo root):
//   node .claude/skills/session-audit/encounter-math.mjs --data path/to/audit-data.json
//   node .claude/skills/session-audit/encounter-math.mjs --data audit.json --json   # machine-readable
//
// Options:
//   --data <path>   The assembled audit JSON (required). Shape documented below.
//   --json          Emit JSON instead of markdown (for diffing two tuning options).
//   --quiet         Tables only, no interpretation footnotes.
//
// ---------------------------------------------------------------------------------------------
// INPUT SHAPE — every field optional except party[] and rooms[]. Omit what you could not read;
// the script reports "unread" rather than inventing a value, which is the whole point.
//
// {
//   "level": 4,                        // party level, for the XP budget band
//   "sessionMinutes": 210,             // how long the session actually runs
//   "nonCombatMinutes": 75,            // shopping, travel, parley, reveals — your estimate
//   "party": [
//     { "name": "Morgash", "ac": 17, "hp": 48, "dpr": 11.4,
//       "saves": { "str": 6, "dex": 0, "con": 5, "int": -1, "wis": 1, "cha": 0 } }
//   ],
//   "rooms": [
//     { "name": "02 Catacombs",
//       "enemies": [ { "name": "Aldous (wight)", "hp": 82, "xp": 700, "count": 1 } ],
//       "avgOnScreen": null }          // set for wave fights: mean bodies active per round
//   ],
//   "attacks": [ { "name": "Wight sword", "toHit": 4, "damage": 11 } ],
//   "saveEffects": [
//     { "name": "Life Drain", "ability": "con", "dc": 13, "avgDamage": 6.5, "halfOnSave": false }
//   ]
// }
// ---------------------------------------------------------------------------------------------
import { readFileSync } from 'node:fs';

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { json: false, quiet: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--data') opts.data = argv[++i];
  else if (a === '--json') opts.json = true;
  else if (a === '--quiet') opts.quiet = true;
  else {
    console.error(`unknown argument: ${a}`);
    process.exit(64);
  }
}
if (!opts.data) {
  console.error('--data <path> is required (see the INPUT SHAPE block at the top of this file)');
  process.exit(64);
}

function fail(msg) {
  console.error(`encounter-math: ${msg}`);
  process.exit(65);
}

let d;
try {
  d = JSON.parse(readFileSync(opts.data, 'utf8'));
} catch (e) {
  fail(e.code === 'ENOENT' ? `no such file: ${opts.data}` : `${opts.data} is not valid JSON — ${e.message}`);
}
if (!Array.isArray(d.party) || !d.party.length) fail('party[] is required and must be non-empty');
if (!Array.isArray(d.rooms) || !d.rooms.length) fail('rooms[] is required and must be non-empty');

// ---- constants --------------------------------------------------------------------------------
// 2024 DMG encounter XP budget, PER CHARACTER. This is a coarse sanity check and nothing more —
// it has no notion of how many bodies the XP is spread across, so a swarm of quarter-CR chaff and
// one big solo read identically. Treat a mismatch here as a prompt to look, never as the finding.
// Verify against your own DMG printing if a band drives a decision; override per-run if you like.
const XP_BUDGET = {
  1: [50, 75, 100],          2: [100, 150, 200],       3: [150, 225, 400],
  4: [250, 375, 500],        5: [500, 750, 1100],      6: [600, 1000, 1400],
  7: [750, 1300, 1700],      8: [1000, 1700, 2100],    9: [1300, 2000, 2600],
  10: [1600, 2300, 3100],    11: [1900, 2900, 4100],   12: [2200, 3700, 4700],
  13: [2600, 4200, 5400],    14: [2900, 4900, 6200],   15: [3300, 5400, 7800],
  16: [3800, 6100, 9800],    17: [4500, 7200, 11700],  18: [5000, 8700, 14200],
  19: [5500, 10700, 17200],  20: [6400, 13200, 22000],
};

// A turn costs wall-clock. These bracket a real VTT table: the fast figure is a practised group
// with pre-rolled initiative and no rules lookups, the slow figure is the night you actually have.
const FAST = { enemy: 25, player: 45 };
const SLOW = { enemy: 45, player: 75 };

// ---- helpers ----------------------------------------------------------------------------------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const r1 = (n) => Math.round(n * 10) / 10;
const pct = (n) => `${Math.round(n * 100)}%`;
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');

// The input JSON is hand-assembled, so a quoted number is a live risk — and `+` would silently
// string-concatenate it into a plausible-looking total. Coerce and validate once, up front.
const num = (v, where) => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) fail(`${where}: expected a number, got ${JSON.stringify(v)}`);
  return n;
};

// 2024 PHB D20 Test rule: a natural 20 auto-succeeds and a natural 1 auto-fails on EVERY d20 test —
// attack rolls, ability checks AND saving throws — so both curves are bounded to [5%, 95%].
// (Under 2014 rules saves had no auto-success/failure; do not "fix" saveFailChance to drop the clamp.)
const hitChance = (toHit, ac) => clamp((21 - (ac - toHit)) / 20, 0.05, 0.95);
const saveFailChance = (dc, mod) => 1 - clamp((21 - (dc - mod)) / 20, 0.05, 0.95);

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

// ---- roster + rounds --------------------------------------------------------------------------
const partySize = d.party.length;
const dprKnown = d.party.filter((p) => p.dpr != null);
const partyDpr = dprKnown.reduce((s, p) => s + num(p.dpr, `${p.name}.dpr`), 0);
if (partyDpr <= 0) fail('at least one party member needs a dpr — the whole round model hangs off it');

for (const s of d.saveEffects ?? []) {
  if (!s.ability) fail(`saveEffect "${s.name ?? '(unnamed)'}" has no ability`);
  if (!ABILITIES.includes(String(s.ability).toLowerCase()))
    fail(`saveEffect "${s.name}": unknown ability "${s.ability}"`);
}

const rooms = d.rooms.map((room) => {
  const enemies = room.enemies ?? [];
  const bodies = enemies.reduce((s, e) => s + (num(e.count, `${room.name} count`) ?? 1), 0);
  const hp = enemies.reduce((s, e) => s + (num(e.hp, `${room.name} hp`) ?? 0) * (num(e.count) ?? 1), 0);
  const xp = enemies.reduce((s, e) => s + (num(e.xp, `${room.name} xp`) ?? 0) * (num(e.count) ?? 1), 0);
  // Anything unread is tracked, never coerced to a silent 0 — a 0 deflates the totals and the XP
  // band with nothing on screen to say so, which is the exact failure this script exists to avoid.
  const unread = {
    hp: enemies.filter((e) => e.hp == null).length,
    xp: enemies.filter((e) => e.xp == null).length,
  };

  if (room.avgOnScreen != null) {
    const v = num(room.avgOnScreen, `${room.name}.avgOnScreen`);
    if (v <= 0) fail(`${room.name}: avgOnScreen must be positive`);
    if (v > bodies) fail(`${room.name}: avgOnScreen ${v} exceeds ${bodies} bodies in the room`);
  }

  const rounds = bodies === 0 ? 0 : Math.max(1, Math.ceil(hp / partyDpr));

  // Enemy turns has to agree with the round model. `rounds` comes from the party killing the room,
  // so the roster SHRINKS as the fight runs — charging every body for every round would assume
  // nobody ever dies, and overstates table time by roughly 1.7x. Default to steady attrition;
  // report the no-one-drops figure alongside it as the ceiling. A wave fight overrides both via
  // avgOnScreen, which is the whole reason waves buy back table time.
  const onScreen = room.avgOnScreen ?? (bodies + 1) / 2;
  const enemyTurns = Math.round(onScreen * rounds);
  const enemyTurnsCeiling = Math.round(bodies * rounds);
  return { name: room.name, bodies, onScreen, hp, xp, unread, rounds, enemyTurns, enemyTurnsCeiling };
});

const total = rooms.reduce(
  (t, r) => ({
    bodies: t.bodies + r.bodies,
    hp: t.hp + r.hp,
    xp: t.xp + r.xp,
    rounds: t.rounds + r.rounds,
    enemyTurns: t.enemyTurns + r.enemyTurns,
    enemyTurnsCeiling: t.enemyTurnsCeiling + r.enemyTurnsCeiling,
    unreadHp: t.unreadHp + r.unread.hp,
    unreadXp: t.unreadXp + r.unread.xp,
  }),
  { bodies: 0, hp: 0, xp: 0, rounds: 0, enemyTurns: 0, enemyTurnsCeiling: 0, unreadHp: 0, unreadXp: 0 },
);

const playerTurns = partySize * total.rounds;

const band = (xp) => {
  const row = XP_BUDGET[d.level];
  if (!row) return 'unread';
  const per = xp / partySize;
  if (per < row[0]) return 'under Low';
  if (per < row[1]) return 'Low';
  if (per < row[2]) return 'Moderate';
  return 'High+';
};

const minutes = (rate) => (total.enemyTurns * rate.enemy + playerTurns * rate.player) / 60;
const combatFast = minutes(FAST);
const combatSlow = minutes(SLOW);
const nonCombat = d.nonCombatMinutes ?? 0;

// ---- matrices ---------------------------------------------------------------------------------
const attacks = (d.attacks ?? []).map((a) => ({
  name: a.name,
  toHit: a.toHit == null ? null : num(a.toHit, `${a.name}.toHit`),
  // How many creatures throw this attack, and how many swings each — used for the lethality line.
  volume: (num(a.count) ?? 1) * (num(a.attacksPerRound) ?? 1),
  perPc: d.party.map((p) => {
    const chance = p.ac == null || a.toHit == null ? null : hitChance(a.toHit, p.ac);
    return { pc: p.name, chance, expected: chance == null || a.damage == null ? null : chance * a.damage };
  }),
}));

// The number that actually answers "can anyone die": if the whole roster turned on one character,
// how many rounds until they drop. Expected damage already accounts for their AC.
const lethality = d.party.map((p) => {
  const incoming = attacks.reduce((s, a) => {
    const cell = a.perPc.find((c) => c.pc === p.name);
    return s + (cell?.expected == null ? 0 : cell.expected * a.volume);
  }, 0);
  const hp = num(p.hp, `${p.name}.hp`);
  return { pc: p.name, hp, incoming: r1(incoming), rounds: hp == null || incoming <= 0 ? null : hp / incoming };
});

const saves = (d.saveEffects ?? []).map((s) => ({
  name: s.name,
  ability: String(s.ability).toLowerCase(),
  dc: s.dc == null ? null : num(s.dc, `${s.name}.dc`),
  perPc: d.party.map((p) => {
    const mod = p.saves?.[String(s.ability).toLowerCase()];
    if (mod == null || s.dc == null) return { pc: p.name, fail: null, expected: null };
    const f = saveFailChance(s.dc, mod);
    // A rider that also bites on a success (half damage, a lesser effect) roughly doubles the
    // clock's real teeth — which is usually invisible until you put the two numbers side by side.
    const expected =
      s.avgDamage == null ? null : f * s.avgDamage + (s.halfOnSave ? (1 - f) * (s.avgDamage / 2) : 0);
    return { pc: p.name, fail: f, expected };
  }),
}));

const result = {
  partyDpr: r1(partyDpr),
  partySize,
  rooms,
  total,
  playerTurns,
  time: {
    combatFastMinutes: Math.round(combatFast),
    combatSlowMinutes: Math.round(combatSlow),
    nonCombatMinutes: nonCombat,
    totalFastMinutes: Math.round(combatFast + nonCombat),
    totalSlowMinutes: Math.round(combatSlow + nonCombat),
    sessionMinutes: d.sessionMinutes ?? null,
  },
  attacks,
  lethality,
  saves,
};

if (opts.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// ---- markdown ---------------------------------------------------------------------------------
const out = [];
const say = (s = '') => out.push(s);

say(`**Party sustained output:** ${r1(partyDpr)} damage/round across ${partySize} characters.`);
if (dprKnown.length < partySize)
  say(`> **${partySize - dprKnown.length} of ${partySize} characters had no dpr** — the round model below is understated.`);
if (total.unreadHp || total.unreadXp)
  say(`> **Unread:** ${total.unreadHp} enemies with no HP, ${total.unreadXp} with no XP. Cells marked \`?\` are floors, not totals.`);
say('');

say('| Room | Bodies | HP | XP | Band | Est. rounds | Enemy turns |');
say('|---|---:|---:|---:|---|---:|---:|');
for (const r of rooms) {
  const bodyCell = r.onScreen !== r.bodies ? `${r.bodies} (${r1(r.onScreen)} avg live)` : `${r.bodies}`;
  const hpCell = r.unread.hp ? `${r.hp}+?` : `${r.hp}`;
  const xpCell = r.unread.xp ? `${r.xp.toLocaleString('en-US')}+?` : r.xp.toLocaleString('en-US');
  const bandCell = r.unread.xp ? `${band(r.xp)}?` : band(r.xp);
  const turnCell = r.enemyTurns === r.enemyTurnsCeiling ? `${r.enemyTurns}` : `${r.enemyTurns} (${r.enemyTurnsCeiling})`;
  say(`| ${esc(r.name)} | ${bodyCell} | ${hpCell} | ${xpCell} | ${bandCell} | ${r.rounds} | ${turnCell} |`);
}
say(`| **Total** | **${total.bodies}** | **${total.hp}** | **${total.xp.toLocaleString('en-US')}** | — | **${total.rounds}** | **${total.enemyTurns}** (${total.enemyTurnsCeiling}) |`);
say('');
if (!opts.quiet)
  say(`_Enemy turns assume the roster thins as the party kills it, matching the round model. The figure in parentheses is the ceiling if nothing ever drops._`);
say('');

say('### Table time');
say('');
say(`${total.enemyTurns} enemy turns + ${playerTurns} player turns.`);
say(`- Fast table (${FAST.enemy}s / ${FAST.player}s per turn): **${Math.round(combatFast)} min** of initiative`);
say(`- Slow table (${SLOW.enemy}s / ${SLOW.player}s per turn): **${Math.round(combatSlow)} min** of initiative`);
if (nonCombat) say(`- Plus ${nonCombat} min of non-combat → **${Math.round(combatFast + nonCombat)}–${Math.round(combatSlow + nonCombat)} min** total`);
if (d.sessionMinutes) {
  const over = combatSlow + nonCombat - d.sessionMinutes;
  say(
    over > 0
      ? `- Against a ${d.sessionMinutes} min session: **over by ${Math.round(over)} min** at the slow end.`
      : `- Against a ${d.sessionMinutes} min session: fits, with ${Math.round(-over)} min of slack.`,
  );
}
say('');

if (attacks.length) {
  say('### To-hit against real ACs');
  say('');
  say(`| Attack | To hit | ${d.party.map((p) => `${esc(p.name)} (AC ${p.ac ?? '?'})`).join(' | ')} |`);
  say(`|---|---:|${d.party.map(() => '---:').join('|')}|`);
  for (const a of attacks) {
    const cells = a.perPc.map((c) =>
      c.chance == null ? 'unread' : c.expected == null ? pct(c.chance) : `${pct(c.chance)} · ${r1(c.expected)}`,
    );
    const hitCell = a.toHit == null ? '?' : a.toHit < 0 ? `${a.toHit}` : `+${a.toHit}`;
    say(`| ${esc(a.name)} | ${hitCell} | ${cells.join(' | ')} |`);
  }
  say('');
  if (lethality.some((l) => l.rounds != null)) {
    say('**If the whole roster focused one character:**');
    say(
      lethality
        .filter((l) => l.rounds != null)
        .map((l) => `${esc(l.pc)} drops in ${r1(l.rounds)} rounds (${l.incoming}/round vs ${l.hp} HP)`)
        .join(' · '),
    );
  }
  if (!opts.quiet) say('');
  if (!opts.quiet) say('_Cells read `hit chance · expected damage per attack`._');
  say('');
}

if (saves.length) {
  say('### Save effects');
  say('');
  say(`| Effect | Save | ${d.party.map((p) => esc(p.name)).join(' | ')} |`);
  say(`|---|---|${d.party.map(() => '---:').join('|')}|`);
  for (const s of saves) {
    const cells = s.perPc.map((c) =>
      c.fail == null ? 'unread' : c.expected == null ? pct(c.fail) : `${pct(c.fail)} · ${r1(c.expected)}`,
    );
    say(`| ${esc(s.name)} | ${s.ability.toUpperCase()} DC ${s.dc ?? '?'} | ${cells.join(' | ')} |`);
  }
  if (!opts.quiet) {
    say('');
    say('_Cells read `chance the PC fails · expected damage (or resource loss) per use`._');
  }
  say('');
}

if (!opts.quiet) {
  say('---');
  say(
    'Rounds are `room HP ÷ party output`, which assumes clean focus fire and no wasted turns — it is ' +
      'the optimistic floor, so a fight never runs *shorter* than this. Enemy turns follow the same ' +
      'assumption, thinning the roster as it dies; the parenthesised ceiling is what you pay if nothing ' +
      'drops. Enemy turns is the number that actually predicts table time — XP bands do not, because ' +
      'they cannot see how many bodies the XP is spread across. Expected damage excludes critical hits ' +
      'and so runs 3–5% low.',
  );
}

console.log(out.join('\n'));
