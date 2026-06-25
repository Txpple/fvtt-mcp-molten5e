// THE single source of truth for the compendium LIBRARY policy (design.md §2.3).
//
// RULE: we author ONLY from the premium published books; the SRD packs are NEVER a source.
//   - The premium-book set is EXTENSIBLE: when a new premium book ships and is brought into scope,
//     add its pack-id prefix to PREMIUM_BOOK_PREFIXES below — the ONE place. Nothing else changes.
//   - The SRD deny-list is PERMANENT: no future book ever moves an SRD pack into scope.
//
// This module is intentionally PURE — no imports, no Node or Foundry globals — so it can be shared
// by BOTH bundles: the Node-side tools (pack defaults) and the page-side search (premium-first
// ranking, bundled into dist/page.bundle.js by esbuild). It is the sanctioned exception to the
// "page code does not import from utils" convention precisely because it is dependency-free and the
// library policy must not be duplicated.

/** Prefix of the SRD packs the dnd5e system ships (e.g. `dnd5e.spells24`, `dnd5e.monsters`). NEVER a source. */
export const SRD_PACK_PREFIX = 'dnd5e.';

/**
 * The premium published books that ARE our authoring library (design.md §2.3).
 * EXTENSIBLE — add a new book's pack-id prefix here when it ships and is brought into scope.
 * Never add an SRD (`dnd5e.*`) pack here.
 */
export const PREMIUM_BOOK_PREFIXES = [
  // Core 2024 rulebooks
  'dnd-monster-manual.',
  'dnd-players-handbook.',
  'dnd-dungeon-masters-guide.',
  // Additional premium books brought into scope (add new releases here)
  'dnd-heroes-faerun.', // Heroes of Faerûn
  'dnd-ravenloft-horrors-within.', // Ravenloft: The Horrors Within
] as const;

/** True if a pack id is an SRD (`dnd5e.*`) pack — never an authoring source. */
export function isSrdPack(packId: string): boolean {
  return typeof packId === 'string' && packId.startsWith(SRD_PACK_PREFIX);
}

/** True if a pack id is one of the in-scope premium book packs. */
export function isPremiumBookPack(packId: string): boolean {
  return (
    typeof packId === 'string' && PREMIUM_BOOK_PREFIXES.some(prefix => packId.startsWith(prefix))
  );
}

/**
 * Throw if any supplied pack id is an SRD (`dnd5e.*`) pack. The PULL tools (create-actor from
 * compendium, import-item, add-feature's compendium modes) call this on the caller-supplied
 * pack(s), so "books only, never SRD" (design.md §2.3) is enforced BY CONSTRUCTION — not just by
 * defaults / ranking / skill prose. A manual call or skill slip that names an SRD pack is refused
 * with a message pointing at the premium equivalent.
 */
export function assertNoSrdPacks(packIds: string | readonly string[], context?: string): void {
  const ids = typeof packIds === 'string' ? [packIds] : packIds;
  const srd = ids.filter(isSrdPack);
  if (srd.length > 0) {
    throw new Error(
      `Refusing to source from SRD pack(s) [${srd.join(', ')}]${context ? ` in ${context}` : ''}: ` +
        'per design.md §2.3 we author ONLY from the premium MM/PHB/DMG books, never the dnd5e.* SRD. ' +
        'Use the premium equivalent (dnd-monster-manual.*, dnd-players-handbook.*, dnd-dungeon-masters-guide.*).'
    );
  }
}

// --- Authoring tool pack defaults (premium books only; never SRD) -----------------------------
// What the tools fall back to when the caller/skill doesn't name packs explicitly.

/** Default spell source: the Player's Handbook. */
export const DEFAULT_SPELL_PACKS: readonly string[] = ['dnd-players-handbook.spells'];

/** Default feature sources: MM monster features + PHB classes (the 2024 class-feature feats live there). */
export const DEFAULT_FEATURE_PACKS: readonly string[] = [
  'dnd-monster-manual.features',
  'dnd-players-handbook.classes',
];

/**
 * Premium-first ranking key for a pack id (lower sorts first):
 *   0 = premium book (the in-scope library)
 *   1 = any other non-SRD pack (third-party/module — allowed, but not a book)
 *   2 = SRD pack (`dnd5e.*`) — always last
 * Used to order search results so authoring lands on the books, never the SRD.
 */
export function packPriority(packId: string): 0 | 1 | 2 {
  if (isPremiumBookPack(packId)) return 0;
  if (isSrdPack(packId)) return 2;
  return 1;
}
