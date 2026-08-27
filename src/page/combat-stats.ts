// Page-side: the combat-stats SCAN — one read-only sweep of game.messages for Battle Flow's
// stat stamps plus the raw d20 rolls the buff-margin and advantage meters need.
//
// THE READ CONTRACT is fvtt-mod-battleflow's ARCHITECTURE.md §4 "The data plane — stat stamps".
// The flags are read as an EXTERNAL WIRE FORMAT (a data contract, not a code dependency — user
// constraint 2026-08-27): nothing here imports battleflow. Contract essentials:
//   • every stamped record carries `combat` ("combatId:round:turn", null = out of combat) and
//     `sourceUuid` (null = no honest source); an ABSENT field marks a pre-plane legacy record —
//     never conflate absent with explicit null.
//   • unlinked tokens stamp their SYNTHETIC actor uuid (THAT goblin); the fold normalizes to
//     archetype identity Node-side.
//   • the fold (src/tools/combat-stats.ts) subtracts `reverted` — ruling R-B.
//
// READ-ONLY by design: no writes, no settings, no fixtures — safe beside a live session.
// The scan returns raw JSON; all folding happens Node-side so it is unit-testable.

const BF_MOD = 'fvtt-mod-battleflow';
// Families folded from `stamped`. rollCtx and combatRoster are deliberately NOT here:
// rollCtx rides the d20 entries (its message IS the roll), combatRoster feeds `rosters`.
const BF_KEYS = [
  'receipt',
  'effectReceipt',
  'd20fold',
  'precision',
  'mastery',
  'bashOffer',
  'riposte',
  'topple',
  'saves',
  'hold',
  'holdSkipped',
  'volley',
  'concentration',
  'spend',
];
const D20_TYPES = new Set(['attack', 'save', 'ability', 'skill', 'tool', 'concentration', 'death']);

export interface ScanCombatStatsArgs {
  since?: number;
}

/** The item/spell behind a message, best-effort off dnd5e's own flags (use → item fallback). */
function itemOf(m: any): string | null {
  return (
    m.flags?.dnd5e?.use?.itemUuid ?? m.flags?.dnd5e?.item?.uuid ?? m.flags?.dnd5e?.item?.id ?? null
  );
}

export async function scanCombatStats(args: ScanCombatStatsArgs = {}): Promise<unknown> {
  const since = Number(args.since) || 0;
  const uuids = new Set<string>();
  const stamped: any[] = [];
  const d20s: any[] = [];
  const rosterFlags: any[] = [];

  for (const m of game.messages.contents) {
    if (m.timestamp < since) continue;
    const bf = m.flags?.[BF_MOD];
    // combatRoster: the GM-whispered marker card — the turn→actor map that outlives deletion
    if (bf?.combatRoster) rosterFlags.push(JSON.parse(JSON.stringify(bf.combatRoster)));
    if (bf && BF_KEYS.some(k => bf[k])) {
      stamped.push({
        id: m.id,
        ts: m.timestamp,
        flags: JSON.parse(
          JSON.stringify(Object.fromEntries(BF_KEYS.filter(k => bf[k]).map(k => [k, bf[k]])))
        ),
        deltas: m.system?.deltas ? JSON.parse(JSON.stringify(m.system.deltas)) : null,
        speakerActor: m.speaker?.actor ?? null,
        itemUuid: itemOf(m),
        // damage-roll totals by type off the receipt message's own rolls: PRE-mitigation
        rolls: (m.rolls ?? []).map((r: any) => ({ total: r.total, type: r.options?.type ?? null })),
        dnd5e: {
          targets: m.getFlag('dnd5e', 'targets') ?? null,
          origin: m.getFlag('dnd5e', 'originatingMessage') ?? null,
        },
      });
    }
    // Buff margins, nat 20/1, advantage economy and death saves need the RAW d20 rolls — a
    // buff die rides the roll as its own term, on messages battleflow may never touch.
    const rollType = m.flags?.dnd5e?.roll?.type;
    if (m.rolls?.length && D20_TYPES.has(rollType)) {
      const r = m.rolls[0];
      const d20 = r.terms?.find((t: any) => t.faces === 20 && t.results);
      d20s.push({
        id: m.id,
        ts: m.timestamp,
        rollType,
        total: r.total,
        actorUuid: m.speaker?.actor ? `Actor.${m.speaker.actor}` : null,
        speakerAlias: m.speaker?.alias ?? null,
        itemUuid: itemOf(m),
        // rollCtx: battleflow's at-roll-time context stamp — {combat, sourceUuid}
        ctx: bf?.rollCtx ? JSON.parse(JSON.stringify(bf.rollCtx)) : null,
        // advantageMode: dnd5e's own -1 | 0 | 1; `all` keeps both dice for adv/dis outcomes
        adv: r.options?.advantageMode ?? null,
        d20: d20
          ? {
              result: d20.results.find((x: any) => x.active !== false)?.result ?? d20.total,
              all: d20.results.map((x: any) => x.result),
            }
          : null,
        bonusDice: (r.terms ?? [])
          .filter((t: any) => t.faces && t.faces !== 20 && t.results)
          .map((t: any) => ({ faces: t.faces, total: t.total })),
        targets: (m.getFlag('dnd5e', 'targets') ?? []).map((t: any) => ({
          uuid: t.uuid,
          name: t.name,
          ac: t.ac ?? null,
        })),
      });
    }
  }

  // Name map for every uuid the ledger will speak about.
  for (const s of stamped) {
    const F = s.flags;
    if (F.receipt?.targets)
      for (const t of F.receipt.targets) {
        uuids.add(t.uuid);
        if (t.sourceUuid) uuids.add(t.sourceUuid);
      }
    if (F.effectReceipt?.targets)
      for (const t of F.effectReceipt.targets) {
        uuids.add(t.uuid);
        for (const e of t.effects ?? []) if (e.sourceUuid) uuids.add(e.sourceUuid);
      }
    for (const k of BF_KEYS) if (F[k]?.sourceUuid) uuids.add(F[k].sourceUuid);
  }
  for (const r of d20s) if (r.actorUuid) uuids.add(r.actorUuid);
  const names: Record<string, string> = {};
  for (const u of uuids) {
    try {
      const doc = fromUuidSync(u);
      if (doc?.name) names[u] = doc.name;
    } catch {
      /* stale uuid — the name map just stays sparse */
    }
  }

  // Rosters: the combatRoster marker flags are the durable source (they outlive deletion);
  // live encounters are archived too as belt-and-braces, without overwriting a flag's snapshot.
  const combats: Record<string, string> = {};
  const rosters: Record<string, unknown> = {};
  for (const rf of rosterFlags) {
    if (!rf.combatId) continue;
    rosters[rf.combatId] = rf;
    combats[rf.combatId] ??= rf.sceneName ?? rf.combatId;
  }
  for (const c of game.combats.contents) {
    // A roster flag's sceneName wins; a live encounter's own name fills in only when real —
    // an unnamed encounter returns '' and must not blank a better label.
    combats[c.id] = combats[c.id] || c.getName?.() || c.name || c.id;
    rosters[c.id] ??= {
      combatId: c.id,
      combatants: c.turns.map((t: any, i: number) => ({
        turn: i,
        actorUuid: t.actor?.uuid ?? null,
        name: t.name,
        initiative: t.initiative,
      })),
    };
  }

  return {
    world: game.world.id,
    scannedAt: Date.now(),
    stamped,
    d20s,
    names,
    combats,
    rosters,
    totalMessages: game.messages.size,
  };
}
