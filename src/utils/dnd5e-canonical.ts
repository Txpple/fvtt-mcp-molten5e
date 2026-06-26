// THE single source of truth for canonical dnd5e 5.3.3 enum sets used in SOFT validation (warn, never
// block) across the authoring surface. Previously each tool/page file kept its own copy, which drifted
// (the Node-side damage copies were missing 'none'/'vitality' that the page-side set had).
//
// Intentionally PURE — no imports, no Node or Foundry globals — so it can be shared by BOTH bundles:
// the Node-side tools (add-feature / add-item / npc) and the page-side library (bundled into
// dist/page.bundle.js by esbuild). Same sanctioned-exception rationale as utils/compendium-sources.ts.

/** CONFIG.DND5E.damageTypes (dnd5e 5.3.3) — incl. 'none' and 'vitality'. */
export const DAMAGE_TYPES = new Set([
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'none',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
  'vitality',
]);

/** CONFIG.DND5E.validProperties.weapon (dnd5e 5.3.3) — the 17 weapon property codes. */
export const WEAPON_PROPERTIES = new Set([
  'ada',
  'amm',
  'fin',
  'fir',
  'foc',
  'hvy',
  'lgt',
  'lod',
  'mgc',
  'rch',
  'rel',
  'ret',
  'sil',
  'spc',
  'thr',
  'two',
  'ver',
]);

/** The 15 dnd5e conditions (status effects). */
export const CONDITIONS = new Set([
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
]);
