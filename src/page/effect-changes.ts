// Pure, offline-tested helpers for dnd5e / Foundry-v14 ActiveEffect `changes[]` mapping. Extracted
// from the live effects.ts orchestrator (mirroring the activities.ts ↔ manage-activity.ts split) so
// the version-coupled field math — the legacy numeric `mode` → v14 string `type` migration and the
// change shape — is unit-tested OFFLINE. A Foundry/dnd5e schema bump that renumbers the modes or
// moves these fields then fails effect-changes.test.ts here, instead of silently mis-authoring
// effects in a live world (which the seam-mocked / verify-script paths would not catch).
//
// Live-verified dnd5e 5.3.3 / Foundry v14 facts (locked by effect-changes.test.ts):
//  - A change is { key, value, type, phase }: `type` is a STRING (override/add/multiply/upgrade/
//    downgrade/custom); the legacy numeric `mode` (CONST.ACTIVE_EFFECT_MODES) is normalized to it.
//  - `value` is stored as a string; `phase` defaults to "initial".

/** Legacy numeric ActiveEffect mode → v14 string type (CONST.ACTIVE_EFFECT_MODES). */
const MODE_NUM_TO_TYPE: Record<number, string> = {
  0: 'custom',
  1: 'multiply',
  2: 'add',
  3: 'downgrade',
  4: 'upgrade',
  5: 'override',
};

/** Normalize an authored change to the v14 { key, value(string), type, phase } shape. */
export function normalizeChange(c: any): Record<string, unknown> {
  const type =
    typeof c?.type === 'string'
      ? c.type
      : typeof c?.mode === 'number'
        ? (MODE_NUM_TO_TYPE[c.mode] ?? 'add')
        : 'add';
  return {
    key: String(c?.key ?? ''),
    value: c?.value === undefined || c?.value === null ? '' : String(c.value),
    type,
    phase: typeof c?.phase === 'string' ? c.phase : 'initial',
  };
}

/** Summarize an effect's changes for list/read output (surfacing type from legacy mode if needed). */
export function summarizeChanges(changes: any[]): Array<Record<string, unknown>> {
  return (changes ?? []).map((c: any) => ({
    key: c?.key,
    value: c?.value,
    type: typeof c?.type === 'string' ? c.type : (MODE_NUM_TO_TYPE[c?.mode] ?? undefined),
  }));
}
