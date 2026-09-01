import { describe, it, expect } from 'vitest';
import {
  CombatStatsTools,
  foldCombatLedger,
  renderCombatReport,
  takenOf,
  bucketOf,
} from './combat-stats.js';
import { makeFoundry, makeLogger } from './test-helpers.js';

/**
 * Fold pins against the battleflow §4 wire format. The fixture mirrors shapes VERIFIED against
 * the live sandbox battle of 2026-08-27 (scan dump), not just the docs: receipt entries
 * (prior/delta/taken/reverted/combat/sourceUuid), effectReceipt records, spend rows/slots,
 * d20fold spends+targets, saves/concentration rollMessageId joins.
 */

const SYNTH = (tok: string, act: string) => `Scene.S1.Token.${tok}.Actor.${act}`;

function fixtureScan() {
  return {
    world: 'test',
    scannedAt: 1756300000000,
    totalMessages: 20,
    combats: { C1: 'Temple Fight' },
    rosters: {
      C1: {
        combatId: 'C1',
        sceneName: 'Temple Fight',
        endedRound: 3,
        combatants: [
          { actorUuid: 'Actor.A', tokenId: 'tokA', name: 'Gren', initiative: 18, isPC: true },
        ],
      },
    },
    names: {
      'Actor.A': 'Gren',
      'Actor.B': 'Jetten',
      [SYNTH('t1', 'g1')]: 'Goblin',
      [SYNTH('t2', 'g2')]: 'Goblin',
    },
    stamped: [
      {
        id: 'm1',
        ts: 1,
        flags: {
          receipt: {
            targets: [
              // damage: 7 dealt by Gren to goblin token 1
              {
                uuid: SYNTH('t1', 'g1'),
                name: 'Goblin',
                prior: { value: 10, temp: 0 },
                delta: { value: -7, temp: 0 },
                taken: 7,
                traits: [],
                reverted: false,
                combat: 'C1:2:0',
                sourceUuid: 'Actor.A',
              },
              // damage to goblin token 2 (second archetype token)
              {
                uuid: SYNTH('t2', 'g2'),
                name: 'Goblin',
                prior: { value: 3, temp: 0 },
                delta: { value: -3, temp: 0 },
                taken: 5,
                traits: [],
                reverted: false,
                combat: 'C1:3:1',
                sourceUuid: 'Actor.B',
              },
              // REVERTED — must not count (R-B)
              {
                uuid: SYNTH('t2', 'g2'),
                name: 'Goblin',
                prior: { value: 3, temp: 0 },
                delta: { value: -3, temp: 0 },
                taken: 9,
                traits: [],
                reverted: true,
                combat: 'C1:3:1',
                sourceUuid: 'Actor.B',
              },
            ],
          },
        },
      },
      {
        id: 'm2',
        ts: 2,
        flags: {
          receipt: {
            targets: [
              // healing: rolled 9, pool moved +6 (clamped) → 3 overheal
              {
                uuid: 'Actor.A',
                name: 'Gren',
                prior: { value: 5, temp: 0 },
                delta: { value: 6, temp: 0 },
                taken: -9,
                note: 'Healing',
                traits: [],
                reverted: false,
                combat: 'C1:3:2',
                sourceUuid: 'Actor.B',
              },
            ],
          },
        },
      },
      {
        id: 'm3',
        ts: 3,
        flags: {
          spend: {
            combat: 'C1:2:0',
            sourceUuid: 'Actor.B',
            rows: [{ pool: 'Second Wind', spent: 1, left: 0, max: 1 }],
            slots: [{ slot: 'spell2', level: 2, spent: 1, left: 1, max: 2 }],
          },
        },
      },
      {
        id: 'm4',
        ts: 4,
        flags: {
          d20fold: {
            testKind: 'attack',
            actorUuid: 'Actor.A',
            baseTotal: 14,
            outcome: 'used',
            spends: [{ kind: 'bardic', name: 'Inspired', die: 4 }],
            targets: [
              { uuid: SYNTH('t1', 'g1'), name: 'Goblin', ac: 16, margin: 2, verdict: 'hit' },
            ],
            combat: 'C1:2:0',
            sourceUuid: 'Actor.A',
          },
        },
      },
      {
        id: 'm5',
        ts: 5,
        flags: {
          // LEGACY: no combat/sourceUuid fields at all — excluded but counted
          receipt: {
            targets: [
              {
                uuid: 'Actor.A',
                name: 'Gren',
                prior: { value: 9, temp: 0 },
                delta: { value: -4, temp: 0 },
                taken: 4,
                traits: [],
              },
            ],
          },
        },
      },
      {
        id: 'm6',
        ts: 6,
        flags: {
          concentration: {
            actorUuid: 'Actor.A',
            dc: 10,
            names: ['Bless'],
            combat: 'C1:2:1',
            sourceUuid: 'Actor.A',
            outcome: { total: 14, success: true, rollMessageId: 'r-conc' },
          },
        },
      },
      {
        id: 'm7',
        ts: 7,
        flags: {
          saves: {
            dc: 15,
            item: { name: 'Hold Person' },
            combat: 'C1:2:2',
            sourceUuid: 'Actor.B',
            targets: [
              {
                uuid: SYNTH('t1', 'g1'),
                name: 'Goblin',
                outcome: 'saved',
                total: 16,
                rollMessageId: 'r-save',
              },
            ],
          },
        },
      },
      {
        id: 'm8',
        ts: 8,
        flags: {
          effectReceipt: {
            targets: [
              {
                uuid: SYNTH('t1', 'g1'),
                name: 'Goblin',
                effects: [
                  {
                    id: 'e1',
                    name: 'Bless',
                    reverted: false,
                    combat: 'C1:2:0',
                    sourceUuid: 'Actor.B',
                  },
                  {
                    id: 'e2',
                    name: 'Hex',
                    reverted: true,
                    combat: 'C1:2:0',
                    sourceUuid: 'Actor.B',
                  },
                ],
              },
            ],
          },
        },
      },
      {
        id: 'm9',
        ts: 9,
        // out-of-combat by CONTRACT: explicit null — its own bucket, never dropped
        flags: {
          receipt: {
            targets: [
              {
                uuid: 'Actor.B',
                name: 'Jetten',
                prior: { value: 10, temp: 0 },
                delta: { value: -2, temp: 0 },
                taken: 2,
                traits: [],
                reverted: false,
                combat: null,
                sourceUuid: null,
              },
            ],
          },
        },
      },
      {
        id: 'm10',
        ts: 10,
        // second-pass fields: parts vs the message's own pre-mitigation rolls. The entry's
        // multiplier annotates the SAME halving the parts carry (measured live) — the meter
        // must not apply it twice: resist necrotic roll 9 → part 4.5 → denied 4.5, and the
        // fire part (no matching trait) contributes only to by-type, never the trait meter.
        rolls: [
          { total: 9, type: 'necrotic' },
          { total: 3, type: 'fire' },
        ],
        flags: {
          receipt: {
            targets: [
              {
                uuid: 'Actor.A',
                name: 'Gren',
                prior: { value: 20, temp: 0 },
                delta: { value: -7, temp: 0 },
                taken: 7,
                multiplier: 0.5,
                traits: [{ type: 'necrotic', outcome: 'resistant' }],
                parts: [
                  { type: 'necrotic', amount: 4.5 },
                  { type: 'fire', amount: 3 },
                ],
                reverted: false,
                combat: 'C1:3:3',
                sourceUuid: SYNTH('t1', 'g1'),
              },
            ],
          },
        },
      },
      {
        id: 'm11',
        ts: 11,
        // holdSkipped: the futile-skip record — a moment tally, source = the attacker
        flags: {
          holdSkipped: {
            targets: [{ uuid: 'Actor.A', name: 'Gren', reaction: 'Shield' }],
            combat: 'C1:3:4',
            sourceUuid: SYNTH('t1', 'g1'),
          },
        },
      },
      {
        id: 'm12',
        ts: 12,
        // answeredAt + deadline/window → decision latency (clock started deadline − window·1000)
        flags: {
          bashOffer: {
            combat: 'C1:3:5',
            sourceUuid: 'Actor.B',
            window: 24,
            deadline: 1000_000 + 24_000,
            answeredAt: 1000_000 + 6_000,
          },
        },
      },
    ],
    d20s: [
      // conc save: 14 total with +5 of bonus dice vs DC 10 → EXACT join by rollMessageId, flip
      {
        id: 'r-conc',
        ts: 6,
        rollType: 'save',
        total: 14,
        actorUuid: 'Actor.A',
        speakerAlias: 'Gren',
        adv: 0,
        d20: { result: 3, all: [3] },
        bonusDice: [
          { faces: 4, total: 2 },
          { faces: 4, total: 3 },
        ],
        targets: [],
      },
      // demanded save: 16 vs DC 15 with +2 bonus → exact join via saves flag, flip
      {
        id: 'r-save',
        ts: 7,
        rollType: 'save',
        total: 16,
        actorUuid: SYNTH('t1', 'g1'),
        speakerAlias: 'Goblin',
        adv: 0,
        d20: { result: 9, all: [9] },
        bonusDice: [{ faces: 4, total: 2 }],
        targets: [],
      },
      // attack that hits only thanks to the bonus die
      {
        id: 'r-atk',
        ts: 8,
        rollType: 'attack',
        ctx: { combat: 'C1:2:3', sourceUuid: 'Actor.A' },
        total: 17,
        actorUuid: 'Actor.A',
        speakerAlias: 'Gren',
        adv: 1,
        d20: { result: 14, all: [14, 6] },
        bonusDice: [{ faces: 4, total: 3 }],
        targets: [{ uuid: SYNTH('t1', 'g1'), name: 'Goblin', ac: 16 }],
      },
      // nat 20 with disadvantage, no bonus dice
      {
        id: 'r-n20',
        ts: 9,
        rollType: 'attack',
        total: 25,
        actorUuid: 'Actor.B',
        speakerAlias: 'Jetten',
        adv: -1,
        d20: { result: 20, all: [20, 4] },
        bonusDice: [],
        targets: [],
      },
      // death saves: one made, one failed
      {
        id: 'r-d1',
        ts: 10,
        rollType: 'death',
        total: 12,
        actorUuid: 'Actor.A',
        speakerAlias: 'Gren',
        adv: 0,
        d20: { result: 12, all: [12] },
        bonusDice: [],
        targets: [],
      },
      {
        id: 'r-d2',
        ts: 11,
        rollType: 'death',
        total: 4,
        actorUuid: 'Actor.A',
        speakerAlias: 'Gren',
        adv: 0,
        d20: { result: 4, all: [4] },
        bonusDice: [],
        targets: [],
      },
    ],
  };
}

describe('bucketOf / takenOf (contract primitives)', () => {
  it('tells explicit-null (out of combat) from ABSENT (legacy)', () => {
    expect(bucketOf({ combat: null })).toEqual({ key: 'out-of-combat', legacy: false });
    expect(bucketOf({})).toEqual({ key: null, legacy: true });
    expect(bucketOf({ combat: 'C1:4:2' })).toMatchObject({ key: 'C1', round: 4, legacy: false });
  });

  it('takenOf prefers the recorded taken; falls back to the pool movement', () => {
    expect(takenOf({ taken: 14, delta: { value: 0, temp: 0 } })).toBe(14); // 0-HP clamp case
    expect(takenOf({ delta: { value: -5, temp: -2 } })).toBe(7); // pre-field legacy entry
  });
});

describe('foldCombatLedger', () => {
  const ledger = foldCombatLedger(fixtureScan());
  const c1 = ledger.combats.C1;
  const actors = c1.actors;

  it('subtracts reverted applications (R-B) and counts legacy separately', () => {
    // Goblin took 7 + 5 — the reverted 9 must NOT count
    expect(actors['archetype:Goblin'].taken).toBe(12);
    expect(ledger.legacy).toBe(1);
  });

  it('aggregates synthetic token actors by archetype with a token count', () => {
    expect(actors['archetype:Goblin'].name).toBe('Goblin (×2)');
    expect(actors['archetype:Goblin'].tokens).toBe(2);
  });

  it('splits healing into rolled / overheal / received-applied', () => {
    const jetten = actors['Actor.B'];
    expect(jetten.healed).toBe(9);
    expect(jetten.overheal).toBe(3);
    expect(actors['Actor.A'].healReceived).toBe(6);
  });

  it('credits d20fold verdict flips off per-target margins', () => {
    expect(actors['Actor.A'].flips).toBe(1);
    expect(actors['Actor.A'].folds[0]).toMatchObject({ kind: 'bardic', flipped: true });
  });

  it('folds the spend economy: pools and slot-levels', () => {
    const jetten = actors['Actor.B'];
    expect(jetten.pools['Second Wind']).toEqual({ spent: 1, max: 1 });
    expect(jetten.slotLevels).toBe(2);
  });

  it('keeps effect receipts minus reverted, and rounds from the max stamp', () => {
    expect(actors['Actor.B'].effectsApplied).toBe(1); // Hex was reverted
    expect(c1.rounds).toBe(3);
  });

  it('groups the explicit-null bucket as out-of-combat, never dropping it', () => {
    expect(ledger.combats['out-of-combat'].actors['Actor.B'].taken).toBe(2);
  });

  it('joins buff-die margins EXACTLY via rollMessageId for concentration AND demanded saves', () => {
    const conc = ledger.bless.find(b => b.kind === 'concentration');
    expect(conc).toMatchObject({ who: 'Gren', threshold: 10, bonus: 5, heuristic: true }); // two d4s overlap
    const save = ledger.bless.find(b => b.kind === 'save');
    expect(save).toMatchObject({ who: 'Goblin', threshold: 15, bonus: 2, heuristic: false });
    expect(save!.versus).toContain('Hold Person');
    const atk = ledger.bless.find(b => b.kind === 'attack');
    expect(atk).toMatchObject({ who: 'Gren', threshold: 16, bonus: 3 });
  });

  it('folds accuracy and AC pressure from rollCtx-stamped attack rolls', () => {
    expect(actors['Actor.A'].attacksMade).toBe(1);
    expect(actors['Actor.A'].attacksHit).toBe(1);
    expect(actors['archetype:Goblin'].targeted).toBe(1);
  });

  it('measures the trait meter type-matched and WITHOUT double-applying multiplier', () => {
    // resist necrotic: roll 9 → part 4.5 (multiplier 0.5 annotates the same halving)
    expect(actors['Actor.A'].mitigated).toBe(4.5);
    expect(actors['Actor.A'].amplified).toBe(0);
    // fire has no matching trait — by-type only, never the trait meter
    const goblin = actors['archetype:Goblin'];
    expect(goblin.damageByType).toEqual({ necrotic: 4.5, fire: 3 });
  });

  it('counts save outcomes roller-side from saves targets and concentration outcomes', () => {
    expect(actors['archetype:Goblin'].savesMade).toBe(1); // Hold Person target saved
    expect(actors['Actor.A'].savesMade).toBe(1); // concentration outcome.success
  });

  it('tallies holdSkipped as a moment on the attacker', () => {
    expect(actors['archetype:Goblin'].moments.holdSkipped).toBe(1);
  });

  it('computes decision latency from answeredAt vs deadline/window', () => {
    expect(ledger.latency).toEqual([{ who: 'Jetten', kind: 'bashOffer', ms: 6000 }]);
  });

  it('tallies session flavor: nat 20/1, advantage economy, death saves', () => {
    expect(ledger.flavor.nat20.Jetten).toBe(1);
    expect(ledger.flavor.adv.Gren).toBe(1);
    expect(ledger.flavor.dis.Jetten).toBe(1);
    expect(ledger.flavor.death.Gren).toEqual({ made: 1, failed: 1 });
  });
});

describe('foldCombatLedger with a SPARSE names map (deleted unlinked tokens)', () => {
  // Session-6 regression: a defeated monster's token is deleted, its synthetic uuid stops
  // resolving live, and the scan's names map goes sparse. The fold must fall back to the
  // wire-carried names (roster combatants, stamped targets) — BOTH for the printed label
  // and for the archetype KEY, or ×N aggregation silently never merges.
  function sparseScan() {
    return {
      world: 'test',
      scannedAt: 1756300000000,
      totalMessages: 5,
      names: { 'Actor.A': 'Gren' }, // no entries for either synthetic uuid
      combats: { C1: 'Bog Fight' },
      rosters: {
        C1: {
          combatId: 'C1',
          combatants: [
            { actorUuid: SYNTH('t1', 'b1'), name: 'Bullywug Bog Sage', initiative: 12 },
            { actorUuid: SYNTH('t2', 'b2'), name: 'Bullywug Bog Sage', initiative: 9 },
          ],
        },
      },
      d20s: [],
      stamped: [
        {
          id: 'm1',
          ts: 1,
          rolls: [],
          flags: {
            receipt: {
              targets: [
                {
                  uuid: SYNTH('t1', 'b1'),
                  name: 'Bullywug Bog Sage',
                  prior: { value: 20, temp: 0 },
                  delta: { value: -7, temp: 0 },
                  taken: 7,
                  traits: [],
                  reverted: false,
                  combat: 'C1:1:0',
                  sourceUuid: 'Actor.A',
                },
                {
                  uuid: SYNTH('t2', 'b2'),
                  name: 'Bullywug Bog Sage',
                  prior: { value: 20, temp: 0 },
                  delta: { value: -5, temp: 0 },
                  taken: 5,
                  traits: [],
                  reverted: false,
                  combat: 'C1:1:0',
                  sourceUuid: 'Actor.A',
                },
              ],
            },
          },
        },
      ],
    };
  }

  it('aggregates both tokens into ONE archetype bucket keyed by the wire name', () => {
    const ledger = foldCombatLedger(sparseScan());
    const actors = ledger.combats.C1.actors;
    const keys = Object.keys(actors).filter(k => k.startsWith('archetype:'));
    expect(keys).toEqual(['archetype:Bullywug Bog Sage']);
    const sage = actors['archetype:Bullywug Bog Sage'];
    expect(sage.name).toBe('Bullywug Bog Sage (×2)');
    expect(sage.tokens).toBe(2);
    expect(sage.taken).toBe(12);
  });

  it('never prints a raw synthetic uuid in the rendered report', () => {
    const scan = sparseScan();
    const report = renderCombatReport(scan, foldCombatLedger(scan)); // all sections default
    expect(report).not.toContain('.Token.');
    expect(report).toContain('Bullywug Bog Sage');
  });

  it('falls back roster-only when a stamped target predates the name field', () => {
    const scan = sparseScan();
    for (const t of scan.stamped[0].flags.receipt.targets) delete (t as any).name;
    const ledger = foldCombatLedger(scan);
    expect(Object.keys(ledger.combats.C1.actors)).toContain('archetype:Bullywug Bog Sage');
  });
});

describe('renderCombatReport', () => {
  const scan = fixtureScan();
  const ledger = foldCombatLedger(scan);

  it('renders every section by default, with the combat name and legacy note', () => {
    const out = renderCombatReport(scan, ledger);
    expect(out).toContain('COMBAT Temple Fight — 3 rounds (ended round 3)');
    expect(out).toContain('accuracy 1/1');
    expect(out).toContain('folds spent: bardic (attack)');
    expect(out).toContain('avg decision 6.0s');
    expect(out).toContain('pre-plane legacy');
    expect(out).toContain('BUFF-DIE FLIPS');
    expect(out).toContain('SESSION FLAVOR');
    expect(out).toContain('Goblin (×2)');
  });

  it('filters by section, combat and actor at call time (the GM-facing runtime filter)', () => {
    const damageOnly = renderCombatReport(scan, ledger, { sections: ['damage'] });
    expect(damageOnly).not.toContain('BUFF-DIE');
    expect(damageOnly).not.toContain('slots:');
    const oneCombat = renderCombatReport(scan, ledger, { combat: 'out-of-combat' });
    expect(oneCombat).toContain('OUT OF COMBAT');
    expect(oneCombat).not.toContain('Temple Fight');
    const gren = renderCombatReport(scan, ledger, { actor: 'gren' });
    expect(gren).toContain('Gren');
    expect(gren).not.toContain('Goblin (×2)');
  });
});

describe('get-combat-stats handler', () => {
  it('scans, folds and renders; forwards since; appends the ledger on request', async () => {
    const { foundry, calls } = makeFoundry(fixtureScan());
    const tools = new CombatStatsTools({ foundry, logger: makeLogger() });
    const out = await tools.handleGetCombatStats({ since: '2026-08-27', includeLedger: true });
    expect(calls[0][0]).toBe('scanCombatStats');
    expect(calls[0][1].since).toBe(Date.parse('2026-08-27'));
    expect(out).toContain('COMBAT Temple Fight');
    expect(out).toContain('```json');
  });

  it('rejects an unknown combat id with the known buckets listed', async () => {
    const { foundry } = makeFoundry(fixtureScan());
    const tools = new CombatStatsTools({ foundry, logger: makeLogger() });
    const out = await tools.handleGetCombatStats({ combat: 'nope' });
    expect(out).toContain('❌');
    expect(out).toContain('C1');
  });

  it('advertises exactly one tool: get-combat-stats', () => {
    const { foundry } = makeFoundry({});
    const tools = new CombatStatsTools({ foundry, logger: makeLogger() });
    const defs = tools.getToolDefinitions();
    expect(defs.map(d => d.name)).toEqual(['get-combat-stats']);
  });
});
