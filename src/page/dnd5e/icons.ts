// Page-side: authored-document icon resolver. PURE (no Foundry globals) — unit-tested in icons.test.ts.
//
// WHY THIS EXISTS (authoring rule 8 — no blank art): when a builder creates a document with no `img`,
// Foundry's DataModel fills a generic monochrome placeholder (`icons/svg/...` or
// `systems/dnd5e/icons/svg/...`). That reads as unfinished and is not acceptable in delivered content.
// `add-feature` was the worst offender — it hard-set the blank feature star on every authored feature.
// This resolver is the TOOL FLOOR that makes a blank icon impossible at the authoring boundary,
// regardless of which handler runs.
//
// TWO TIERS:
//   • Tier 1 (this file) — a curated, deterministic map of authored-kind → a VERIFIED-REAL Foundry
//     CORE icon. Core icons (`icons/**/*.webp`, the bundled "game-icons" set) ship with every Foundry
//     install, so a path here can never 404 and never depends on which premium modules are present.
//     Every path below was harvested from a LIVE premium-compendium entry's own `img` (so it is a real
//     file Foundry renders) and is module-independent. Pure + total: resolveAuthoredIcon() ALWAYS
//     returns a real, non-placeholder path.
//   • Tier 2 (impure, in the addItem handler) — a live compendium-index lookup for a closer same-kind
//     icon by name (so "Mace of the Long Dark" → a real mace), falling back to this floor. Kept OUT of
//     this module so it stays pure (the kernel-grade-bar rule: Tier-1 map only lives here).

/**
 * Matches the monochrome placeholder icons Foundry/dnd5e fall back to when a document is created with
 * no real art: core `icons/svg/...` and the dnd5e system's `systems/dnd5e/icons/svg/...`. Used both to
 * decide whether to auto-fill on create and by the content-audit finishing check (rule 8).
 */
export const PLACEHOLDER_ICON_PATTERN = /(^|\/)icons\/svg\//;

/** True when `img` is missing, empty, or one of the generic monochrome placeholders. */
export function isPlaceholderIcon(img: string | null | undefined): boolean {
  if (!img) return true;
  return PLACEHOLDER_ICON_PATTERN.test(img);
}

// The neutral global floor — a real, non-placeholder core icon used when nothing more specific matches.
const FALLBACK_ICON = 'icons/magic/light/orbs-hand-gray.webp';

// Re-export of the neutral floor for the asset-validation sites that have no kind context (a generic
// item icon, a card face, a map-note pin) and just need a guaranteed-real substitute. Single-sourced
// here so the "verified-real core icon" guarantee lives in one place.
export const GENERIC_ICON = FALLBACK_ICON;

// Authored-kind → verified-real Foundry CORE icon. Keys are either a bare `kind` or a `kind:subtype`
// compound (most-specific wins). EVERY value was observed this session as the live `img` of a real
// premium-compendium document (so it is a real, renderable file) AND is a core `icons/...` path (so it
// is present in every Foundry install, independent of premium modules). Re-verify with
// scripts/verify-icons.mjs after any edit.
const AUTHORED_ICONS: Record<string, string> = {
  // ── physical items (key = add-item itemType, subtype = equipmentType/consumableType/lootType) ──
  weapon: 'icons/weapons/swords/swords-sharp-worn.webp',
  armor: 'icons/equipment/chest/breastplate-layered-gilded-orange.webp',
  shield: 'icons/skills/melee/shield-block-gray-yellow.webp',

  wondrous: 'icons/equipment/neck/pendant-bronze-gem-blue.webp',
  'wondrous:ring': 'icons/equipment/finger/ring-band-copper.webp',
  'wondrous:rod': 'icons/weapons/maces/mace-round-steel.webp',
  'wondrous:wand': 'icons/weapons/wands/wand-skull-feathers.webp',
  'wondrous:cloak': 'icons/equipment/back/cloak-collared-feathers-green.webp',
  'wondrous:clothing': 'icons/equipment/chest/shirt-collared-yellow.webp',
  'wondrous:amulet': 'icons/equipment/neck/amulet-round-blue.webp',
  'wondrous:trinket': 'icons/equipment/neck/pendant-bronze-gem-blue.webp',

  consumable: 'icons/consumables/potions/bottle-round-corked-green.webp',
  'consumable:potion': 'icons/consumables/potions/bottle-round-corked-green.webp',
  'consumable:poison': 'icons/consumables/potions/bottle-bulb-corked-glowing-red.webp',
  'consumable:scroll': 'icons/sundries/scrolls/scroll-bound-blue-tan.webp',
  'consumable:ammo': 'icons/weapons/ammunition/arrows-broadhead-white.webp',
  'consumable:food': 'icons/consumables/drinks/alcohol-beer-stein-wooden-metal-brown.webp',
  'consumable:wand': 'icons/weapons/wands/wand-skull-feathers.webp',
  'consumable:rod': 'icons/weapons/maces/mace-round-steel.webp',

  tool: 'icons/tools/hand/awl-steel-tan.webp',

  loot: 'icons/commodities/gems/gem-cut-faceted-princess-purple.webp',
  'loot:gem': 'icons/commodities/gems/gem-cut-faceted-princess-purple.webp',
  'loot:art': 'icons/commodities/gems/pearl-purple-dark.webp',
  'loot:trade': 'icons/commodities/leather/leather-buckle-steel-tan.webp',

  container: 'icons/containers/bags/pouch-leather-simple-tan.webp',

  // ── authored features / attacks (feat & natural-weapon Items) ──
  passive: 'icons/magic/light/orbs-hand-gray.webp',
  save: 'icons/creatures/abilities/dragon-fire-breath-orange.webp',
  aura: 'icons/magic/control/orb-web-hold.webp',
  attack: 'icons/skills/melee/strike-weapons-orange.webp',
  'attack-with-save': 'icons/skills/melee/strike-weapons-orange.webp',

  // ── authored spell ──
  spell: 'icons/magic/lightning/orb-ball-spiral-blue.webp',
};

/**
 * Resolve a real, non-placeholder core icon for an authored document of the given kind. Tries the
 * `kind:subtype` compound first, then bare `kind`, then a neutral fallback — so it is TOTAL (never
 * returns a placeholder) and pure. Callers pass the floor result when the user supplied no `img`.
 *
 * @param kind    authored kind — an add-item itemType (weapon/armor/shield/wondrous/consumable/tool/
 *                loot/container), a feature kind (passive/save/aura/attack/attack-with-save), or 'spell'.
 * @param subtype finer kind — equipmentType (ring/rod/wand/…), consumableType (potion/scroll/ammo/…),
 *                or lootType (gem/art/trade). Ignored when no `kind:subtype` entry exists.
 */
export function resolveAuthoredIcon(
  kind: string,
  opts: { subtype?: string | undefined } = {}
): string {
  const k = String(kind ?? '').toLowerCase();
  const sub = opts.subtype ? String(opts.subtype).toLowerCase() : '';
  if (sub && AUTHORED_ICONS[`${k}:${sub}`]) return AUTHORED_ICONS[`${k}:${sub}`];
  if (AUTHORED_ICONS[k]) return AUTHORED_ICONS[k];
  return FALLBACK_ICON;
}

// dnd5e creatureType → a verified-real core icon for an AUTHORED-FROM-SCRATCH NPC's portrait + token
// (rule 8 — author-npc would otherwise default to the mystery-man placeholder). A compendium-copied
// creature keeps its own real art; this is only the floor for the hand-authored path. Every path was
// HTTP-confirmed against the live Foundry static server (scripts/verify-icons.mjs harvest run).
const DEFAULT_CREATURE_ICON = 'icons/environment/people/commoner.webp';
const CREATURE_ICONS: Record<string, string> = {
  aberration: 'icons/creatures/tentacles/tentacle-eyes-yellow-pink.webp',
  beast: 'icons/creatures/mammals/deer-antlers-glowing-blue.webp',
  celestial: 'icons/magic/holy/angel-wings-gray.webp',
  construct: 'icons/creatures/magical/construct-stone-earth-gray.webp',
  dragon: 'icons/creatures/reptiles/dragon-horned-blue.webp',
  elemental: 'icons/magic/fire/elemental-fire-humanoid.webp',
  fey: 'icons/creatures/magical/fae-fairy-winged-glowing-green.webp',
  fiend: 'icons/magic/unholy/strike-hand-glow-pink.webp',
  giant: 'icons/creatures/magical/humanoid-giant-forest-blue.webp',
  humanoid: DEFAULT_CREATURE_ICON,
  monstrosity: 'icons/creatures/eyes/lizard-single-slit-pink.webp',
  ooze: 'icons/creatures/slimes/slime-movement-pseudopods-green.webp',
  plant: 'icons/magic/nature/plant-vines-skull-green.webp',
  undead: 'icons/magic/death/skull-horned-worn-fire-blue.webp',
};

/** Resolve a real, non-placeholder portrait/token icon for an authored NPC of the given creatureType.
 * TOTAL (unknown types → a neutral humanoid floor) and pure — unit-tested. */
export function resolveCreatureIcon(creatureType: string): string {
  return CREATURE_ICONS[String(creatureType ?? '').toLowerCase()] ?? DEFAULT_CREATURE_ICON;
}
