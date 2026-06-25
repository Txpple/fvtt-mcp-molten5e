// Page-side: D&D 5e creature index. Runs INSIDE the headless Foundry page.
//
// Replaces the old persistent, file-cached creature index (FilePicker fingerprints +
// hooks + world-flag persistence). This version reads the premium Actor packs' compendium
// INDEX on demand (cheap — requesting only the creature-stat fields it needs, never the full
// documents) and projects a flat per-creature record. The RETURNED SHAPES exactly match what
// the old data-access.ts queries produced, which is what the Node tools (src/tools/compendium.ts)
// and their tests expect.

import { excludeSrdPacks, packPriority } from '../utils/compendium-sources.js';

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
// Local helpers (non-exported unless tested)
// ---------------------------------------------------------------------------

/**
 * The `system.*` field paths we pull into the compendium INDEX for creature discovery.
 *
 * dnd5e registers NO index fields on Actor packs (only Item), so the default index carries only
 * core fields (`_id`/`name`/`img`/`type`) — every creature stat must be requested explicitly here.
 * All paths are scalar dot-paths into stored `_source` data (confirmed populated live on the 2024
 * MM pack). Two known limits (see [[fvtt-mcp-compendium-lookup-facts]]): `ac.value` is DERIVED and
 * NOT indexable (we read `ac.flat`, approximate); true spellcasting / legendary actions live in
 * embedded items/activities (not indexable) so we approximate them from `spell.level` / `legact.max`.
 */
const CREATURE_INDEX_FIELDS = [
  'system.details.cr',
  'system.details.type.value',
  'system.traits.size',
  'system.attributes.hp.max',
  'system.attributes.ac.flat',
  'system.attributes.spell.level',
  'system.resources.legact.max',
  'system.details.alignment',
] as const;

/**
 * Scan every premium Actor compendium pack and build a flat creature index from the pack INDEX
 * (cheap) rather than full documents. SRD (`dnd5e.*`) packs are excluded outright (design.md §2.3);
 * dropping them up front also reserves the result `limit` budget for the books. Pack-level failures
 * are isolated so one bad pack cannot sink the whole scan.
 *
 * This replaces the former `getDocuments()` full-load: loading every actor document on every call
 * was the single heaviest path in the lookup surface; the index read carries everything the
 * discovery contract needs (see CREATURE_INDEX_FIELDS).
 */
async function buildCreatureIndex(): Promise<CreatureIndexEntry[]> {
  const actorPacks: any[] = excludeSrdPacks(
    Array.from(game.packs.values()) as any[],
    (pack: any) => pack?.metadata?.id
  ).filter((pack: any) => pack?.metadata?.type === 'Actor');

  const creatures: CreatureIndexEntry[] = [];

  for (const pack of actorPacks) {
    try {
      const index = await pack.getIndex({ fields: [...CREATURE_INDEX_FIELDS] });
      for (const entry of index.values() as IterableIterator<any>) {
        // Only index NPCs, characters, and creatures.
        if (entry.type !== 'npc' && entry.type !== 'character' && entry.type !== 'creature') {
          continue;
        }
        creatures.push(projectIndexEntry(entry, pack.metadata.id, pack.metadata.label));
      }
    } catch (error) {
      // Skip packs that fail to index; keep scanning the rest.
      console.warn(`[creature-index] Failed to index pack ${pack?.metadata?.label}:`, error);
    }
  }

  return creatures;
}

/**
 * Project a single compendium INDEX entry (an `{ _id, name, type, img, system }` record carrying
 * only CREATURE_INDEX_FIELDS) into the flat CreatureIndexEntry contract.
 *
 * Exported for offline unit testing — pure, no Foundry globals. The CR/type/size/hp/alignment
 * helpers normalize the corresponding index field; armorClass / hasSpells / hasLegendaryActions
 * read the index-specific paths directly (and are APPROXIMATE — see CREATURE_INDEX_FIELDS):
 *   - armorClass ← `ac.flat` (the only stored AC; `ac.value` is derived/unavailable), default 10.
 *   - hasSpells ← `spell.level > 0` (real spellcasting lives in embedded spell items / activities).
 *   - hasLegendaryActions ← `legact.max > 0` (the legact schema object exists even when max is 0,
 *     so we must test the number, not the object's presence).
 */
export function projectIndexEntry(
  entry: any,
  packId: string,
  packLabel: string
): CreatureIndexEntry {
  const system = entry?.system ?? {};
  return {
    id: entry?._id,
    name: entry?.name,
    type: entry?.type,
    pack: packId,
    packLabel,
    challengeRating: extractChallengeRating(system),
    creatureType: extractCreatureType(system),
    size: extractSize(system),
    hitPoints: extractHitPoints(system),
    armorClass: Number(system.attributes?.ac?.flat) || 10,
    hasSpells: Number(system.attributes?.spell?.level) > 0,
    hasLegendaryActions: Number(system.resources?.legact?.max) > 0,
    alignment: extractAlignment(system),
    description: '', // not in the index; unused by the Node formatter (kept for shape parity)
    img: entry?.img ?? '',
  };
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

/** Resolve size from the index field `system.traits.size` — a bare dnd5e key (e.g. 'med'), lowercased. */
function extractSize(system: any): string {
  const size = system.traits?.size;
  return typeof size === 'string' && size ? size.toLowerCase() : 'med';
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

/** Resolve alignment from the index field `system.details.alignment` — a bare string, lowercased. */
function extractAlignment(system: any): string {
  const alignment = system.details?.alignment;
  return typeof alignment === 'string' && alignment ? alignment.toLowerCase() : 'unaligned';
}

/**
 * Map the tool's friendly size enum (medium/large/…) to the dnd5e stored size KEY (med/lg/…),
 * which is what `system.traits.size` (and thus the index + a creature's `size`) actually holds.
 * Without this, a `size: "medium"` filter never matched an index value of `"med"`.
 */
const SIZE_TO_DND5E: Record<string, string> = {
  tiny: 'tiny',
  small: 'sm',
  medium: 'med',
  large: 'lg',
  huge: 'huge',
  gargantuan: 'grg',
};

/**
 * Check whether a creature passes all specified criteria. Comparisons use the already-normalized
 * (lowercased) index fields. Exported for offline unit testing — pure, no Foundry globals.
 */
export function passesCriteria(creature: CreatureIndexEntry, criteria: CreatureCriteria): boolean {
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

  // Size filter — map the friendly enum to the dnd5e key before comparing.
  if (criteria.size) {
    const wanted = SIZE_TO_DND5E[criteria.size.toLowerCase()] ?? criteria.size.toLowerCase();
    if (creature.size.toLowerCase() !== wanted) {
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
