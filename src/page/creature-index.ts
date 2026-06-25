// Page-side: D&D 5e creature index. Runs INSIDE the headless Foundry page.
//
// Replaces the old persistent, file-cached creature index (FilePicker fingerprints +
// hooks + world-flag persistence). This version scans the Actor compendium packs on
// demand and extracts a flat per-creature index record. Correctness over performance:
// every call re-scans the packs (see perf caveat in the handoff notes). The RETURNED
// SHAPES exactly match what the old data-access.ts queries produced, which is what the
// Node tools (src/tools/compendium.ts) and their tests expect.

import { packPriority } from '../utils/compendium-sources.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single flat creature-index entry (D&D 5e). Matches the old DnD5eCreatureIndex. */
interface CreatureIndexEntry {
  id: string;
  name: string;
  type: string;
  pack: string;
  packLabel: string;
  challengeRating: number;
  creatureType: string;
  size: string;
  hitPoints: number;
  armorClass: number;
  hasSpells: boolean;
  hasLegendaryActions: boolean;
  alignment: string;
  description: string;
  img: string;
}

/** Criteria accepted by listCreaturesByCriteria. */
interface CreatureCriteria {
  challengeRating?: number | { min?: number; max?: number };
  creatureType?: string;
  size?: string;
  hasSpells?: boolean;
  hasLegendaryActions?: boolean;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the enhanced creature index for campaign analysis.
 *
 * Returns a flat array of every indexable creature (npc/character/creature) across
 * all Actor compendium packs. Old behavior returned `enhancedCreatures || []`.
 */
export async function getEnhancedCreatureIndex(): Promise<unknown> {
  const creatures = await buildCreatureIndex();
  return creatures;
}

/**
 * List creatures matching the given criteria, with a search summary.
 *
 * Mirrors the old listCreaturesByCriteria: scan the on-demand index, filter, sort by
 * CR then name, cap to `limit`, then project each survivor into the result shape and
 * assemble the searchSummary (pack distribution + index metadata).
 */
export async function listCreaturesByCriteria(args?: CreatureCriteria): Promise<unknown> {
  const criteria: CreatureCriteria = args ?? {};
  const limit = criteria.limit ?? 500;

  const indexed = await buildCreatureIndex();

  // Filter by criteria.
  let filtered = indexed.filter(creature => passesCriteria(creature, criteria));

  // Sort by Challenge Rating, then name, for stable ordering.
  filtered.sort((a, b) => {
    // Premium books first, SRD (dnd5e.*) last — we author only from the books (design.md §2.3).
    const pri = packPriority(a.pack) - packPriority(b.pack);
    if (pri !== 0) return pri;
    if (a.challengeRating !== b.challengeRating) {
      return a.challengeRating - b.challengeRating;
    }
    return a.name.localeCompare(b.name);
  });

  // Apply limit.
  if (filtered.length > limit) {
    filtered = filtered.slice(0, limit);
  }

  // Project into the result shape the Node tool expects.
  const results = filtered.map(d => ({
    id: d.id,
    name: d.name,
    type: d.type,
    pack: d.pack,
    packLabel: d.packLabel,
    description: d.description || '',
    hasImage: !!d.img,
    creatureType: d.creatureType,
    size: d.size,
    hitPoints: d.hitPoints,
    armorClass: d.armorClass,
    hasSpells: d.hasSpells,
    alignment: d.alignment,
    summary: `CR ${d.challengeRating} ${d.creatureType} from ${d.packLabel}`,
    challengeRating: d.challengeRating,
    hasLegendaryActions: d.hasLegendaryActions,
  }));

  // Pack distribution for the summary (label -> count among results).
  const resultsByPackMap = new Map<string, number>();
  for (const creature of results) {
    resultsByPackMap.set(creature.packLabel, (resultsByPackMap.get(creature.packLabel) ?? 0) + 1);
  }

  // Unique packs across the full index, sampling label for the top few.
  const uniquePacks = Array.from(new Set(indexed.map(c => c.pack)));
  const topPacks = uniquePacks.slice(0, 5).map(packId => {
    const sample = indexed.find(c => c.pack === packId);
    return {
      id: packId,
      label: sample?.packLabel ?? 'Unknown Pack',
      priority: 100, // All packs are weighted equally in this on-demand scan.
    };
  });

  return {
    creatures: results,
    searchSummary: {
      packsSearched: uniquePacks.length,
      topPacks,
      totalCreaturesFound: results.length,
      resultsByPack: Object.fromEntries(resultsByPackMap),
      criteria,
      indexMetadata: {
        totalIndexedCreatures: indexed.length,
        searchMethod: 'onDemandPackScan',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Local helpers (non-exported)
// ---------------------------------------------------------------------------

/**
 * Scan every Actor compendium pack and build a flat creature index. Loads full
 * documents per pack so the system-data extraction below has the real stat block.
 * Pack-level and document-level failures are isolated so one bad pack/doc cannot
 * sink the whole scan.
 */
async function buildCreatureIndex(): Promise<CreatureIndexEntry[]> {
  const actorPacks: any[] = Array.from(game.packs.values()).filter(
    (pack: any) => pack?.metadata?.type === 'Actor'
  );

  const creatures: CreatureIndexEntry[] = [];

  for (const pack of actorPacks) {
    try {
      const documents = await pack.getDocuments();
      for (const doc of documents) {
        // Only index NPCs, characters, and creatures.
        if (doc.type !== 'npc' && doc.type !== 'character' && doc.type !== 'creature') {
          continue;
        }
        const entry = extractCreatureEntry(doc, pack);
        if (entry) {
          creatures.push(entry);
        }
      }
    } catch (error) {
      // Skip packs that fail to load; keep scanning the rest.
      console.warn(`[creature-index] Failed to load pack ${pack?.metadata?.label}:`, error);
    }
  }

  return creatures;
}

/**
 * Extract a single flat creature-index entry from a Foundry actor document.
 * Uses comprehensive D&D 5e fallback paths (system data layouts vary by source).
 * On extraction failure returns a safe fallback record rather than dropping the
 * creature, matching the old behavior.
 */
function extractCreatureEntry(doc: any, pack: any): CreatureIndexEntry {
  try {
    const system = doc.system ?? {};

    return {
      id: doc._id,
      name: doc.name,
      type: doc.type,
      pack: pack.metadata.id,
      packLabel: pack.metadata.label,
      challengeRating: extractChallengeRating(system),
      creatureType: extractCreatureType(system),
      size: extractSize(system),
      hitPoints: extractHitPoints(system),
      armorClass: extractArmorClass(system),
      hasSpells: extractHasSpells(system),
      hasLegendaryActions: extractHasLegendaryActions(system),
      alignment: extractAlignment(system),
      description: extractDescription(doc),
      img: doc.img,
    };
  } catch (error) {
    console.warn(`[creature-index] Failed to extract data from ${doc?.name}:`, error);
    return {
      id: doc._id,
      name: doc.name,
      type: doc.type,
      pack: pack.metadata.id,
      packLabel: pack.metadata.label,
      challengeRating: 0,
      creatureType: 'unknown',
      size: 'medium',
      hitPoints: 1,
      armorClass: 10,
      hasSpells: false,
      hasLegendaryActions: false,
      alignment: 'unaligned',
      description: 'Data extraction failed',
      img: doc.img ?? '',
    };
  }
}

/** Resolve Challenge Rating across the known D&D 5e data layouts; handle fractions. */
function extractChallengeRating(system: any): number {
  let cr =
    system.details?.cr ??
    system.details?.cr?.value ??
    system.cr?.value ??
    system.cr ??
    system.attributes?.cr?.value ??
    system.attributes?.cr ??
    system.challenge?.rating ??
    system.challenge?.cr ??
    0;

  if (cr === null || cr === undefined) {
    cr = 0;
  }

  if (typeof cr === 'string') {
    if (cr === '1/8') cr = 0.125;
    else if (cr === '1/4') cr = 0.25;
    else if (cr === '1/2') cr = 0.5;
    else cr = parseFloat(cr) || 0;
  }

  return Number(cr) || 0;
}

/** Resolve creature type (lowercased), defaulting to 'unknown'. */
function extractCreatureType(system: any): string {
  let creatureType =
    system.details?.type?.value ??
    system.details?.type ??
    system.type?.value ??
    system.type ??
    system.race?.value ??
    system.race ??
    system.details?.race ??
    'unknown';

  if (creatureType === null || creatureType === undefined || creatureType === '') {
    creatureType = 'unknown';
  }
  if (typeof creatureType !== 'string') {
    creatureType = String(creatureType || 'unknown');
  }

  return creatureType.toLowerCase();
}

/** Resolve size (lowercased), defaulting to 'medium'. */
function extractSize(system: any): string {
  let size =
    system.traits?.size?.value ||
    system.traits?.size ||
    system.size?.value ||
    system.size ||
    system.details?.size ||
    'medium';

  if (typeof size !== 'string') {
    size = String(size || 'medium');
  }

  return size.toLowerCase();
}

/** Resolve max (then current) hit points, defaulting to 0. */
function extractHitPoints(system: any): number {
  return (
    system.attributes?.hp?.max ||
    system.hp?.max ||
    system.attributes?.hp?.value ||
    system.hp?.value ||
    system.health?.max ||
    system.health?.value ||
    0
  );
}

/** Resolve armor class, defaulting to 10. */
function extractArmorClass(system: any): number {
  return (
    system.attributes?.ac?.value ||
    system.ac?.value ||
    system.attributes?.ac ||
    system.ac ||
    system.armor?.value ||
    system.armor ||
    10
  );
}

/** Resolve alignment (lowercased), defaulting to 'unaligned'. */
function extractAlignment(system: any): string {
  let alignment =
    system.details?.alignment?.value ||
    system.details?.alignment ||
    system.alignment?.value ||
    system.alignment ||
    'unaligned';

  if (typeof alignment !== 'string') {
    alignment = String(alignment || 'unaligned');
  }

  return alignment.toLowerCase();
}

/** Detect spellcasting across several D&D 5e markers. */
function extractHasSpells(system: any): boolean {
  return !!(
    system.spells ||
    system.attributes?.spellcasting ||
    (system.details?.spellLevel && system.details.spellLevel > 0) ||
    (system.resources?.spell && system.resources.spell.max > 0) ||
    system.spellcasting ||
    system.traits?.spellcasting ||
    system.details?.spellcaster
  );
}

/** Detect legendary actions across several D&D 5e markers. */
function extractHasLegendaryActions(system: any): boolean {
  return !!(
    system.resources?.legact ||
    system.legendary ||
    (system.resources?.legres && system.resources.legres.value > 0) ||
    system.details?.legendary ||
    system.traits?.legendary ||
    (system.resources?.legendary && system.resources.legendary.max > 0)
  );
}

/** Resolve a description string (biography or generic description), defaulting to ''. */
function extractDescription(doc: any): string {
  return doc.system?.details?.biography || doc.system?.description || '';
}

/**
 * Check whether a creature passes all specified criteria. Comparisons use the
 * already-normalized (lowercased) index fields, matching the old passesDnD5eCriteria.
 */
function passesCriteria(creature: CreatureIndexEntry, criteria: CreatureCriteria): boolean {
  // Challenge Rating filter (exact number or {min,max} range).
  if (criteria.challengeRating !== undefined) {
    if (typeof criteria.challengeRating === 'number') {
      if (creature.challengeRating !== criteria.challengeRating) {
        return false;
      }
    } else if (typeof criteria.challengeRating === 'object' && criteria.challengeRating !== null) {
      const { min, max } = criteria.challengeRating;
      if (min !== undefined && creature.challengeRating < min) {
        return false;
      }
      if (max !== undefined && creature.challengeRating > max) {
        return false;
      }
    }
  }

  // Creature type filter (case-insensitive).
  if (criteria.creatureType) {
    if (creature.creatureType.toLowerCase() !== criteria.creatureType.toLowerCase()) {
      return false;
    }
  }

  // Size filter (case-insensitive).
  if (criteria.size) {
    if (creature.size.toLowerCase() !== criteria.size.toLowerCase()) {
      return false;
    }
  }

  // Spellcaster filter.
  if (criteria.hasSpells !== undefined) {
    if (creature.hasSpells !== criteria.hasSpells) {
      return false;
    }
  }

  // Legendary-actions filter.
  if (criteria.hasLegendaryActions !== undefined) {
    if (creature.hasLegendaryActions !== criteria.hasLegendaryActions) {
      return false;
    }
  }

  return true;
}
