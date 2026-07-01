// Shared prototype-token defaults applied to EVERY PC/NPC the authoring tools create (create-pc,
// author-npc, create-actor-from-compendium) so a token dragged onto a scene is immediately usable at
// the table: its name + HP bar are shown to everyone, vision is on and matches the sheet's darkvision,
// and it carries a disposition. Per design.md §7 the TOOL bakes the deterministic bits (display modes,
// vision-from-senses); the caller/SKILL decides the one judgment field — friend vs foe.

/** CONST.TOKEN_DISPLAY_MODES.ALWAYS — the name/bars are shown to every player, always. */
export const TOKEN_DISPLAY_ALWAYS = 50;

/** CONST.TOKEN_DISPOSITIONS. */
export const TOKEN_DISPOSITION = { secret: -2, hostile: -1, neutral: 0, friendly: 1 } as const;
export type DispositionKey = keyof typeof TOKEN_DISPOSITION;

/**
 * Read a creature's darkvision range off either the modern dnd5e 5.3 shape
 * (`senses.ranges.darkvision`) or the legacy flat one (`senses.darkvision`). Returns 0 when absent —
 * i.e. basic vision.
 */
export function readDarkvision(senses: any): number {
  const v = senses?.ranges?.darkvision ?? senses?.darkvision ?? 0;
  return typeof v === 'number' && v > 0 ? v : 0;
}

/**
 * Map a disposition key (or an already-numeric value) to the Foundry numeric disposition, falling
 * back to `fallback` when unset/unrecognized.
 */
export function resolveDisposition(
  d: DispositionKey | number | undefined | null,
  fallback: number
): number {
  if (typeof d === 'number') return d;
  if (typeof d === 'string' && d in TOKEN_DISPOSITION)
    return TOKEN_DISPOSITION[d as DispositionKey];
  return fallback;
}

/**
 * The prototypeToken fields every created actor receives. Merge over an existing prototypeToken
 * (keep its `name`/`texture`). `disposition` is the resolved numeric Foundry value; `darkvision` is
 * the range in feet (0 = basic vision).
 */
export function tokenDefaults(opts: {
  disposition: number;
  darkvision?: number;
}): Record<string, unknown> {
  const dark = opts.darkvision && opts.darkvision > 0 ? opts.darkvision : 0;
  return {
    displayName: TOKEN_DISPLAY_ALWAYS,
    displayBars: TOKEN_DISPLAY_ALWAYS,
    disposition: opts.disposition,
    sight: { enabled: true, visionMode: dark > 0 ? 'darkvision' : 'basic', range: dark },
  };
}
