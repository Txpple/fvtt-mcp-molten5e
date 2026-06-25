// Page-side: compendium reads. Runs INSIDE the Foundry page.
//
// Pure reads against game.packs. No module settings, permissions, transactions,
// sockets, or other legacy scaffolding — those are all gone. The consuming Node
// tools (src/tools/compendium.ts) do the input validation, limiting, and output
// shaping; these functions return the raw bridge-shaped values those tools
// expect (faithful to the old data-access.ts oracle).

import { toSource, sanitizeDocData } from './_shared.js';
import { packPriority } from '../utils/compendium-sources.js';

interface CompendiumSearchArgs {
  query: string;
  packType?: string;
  filters?: {
    challengeRating?: number | { min?: number; max?: number };
    creatureType?: string;
    size?: string;
    alignment?: string;
    hasLegendaryActions?: boolean;
    spellcaster?: boolean;
  };
}

interface CompendiumSearchResult {
  id: string;
  name: string;
  type: string;
  img?: string;
  pack: string;
  packLabel: string;
  description?: string;
  hasImage?: boolean;
  summary?: string;
}

interface GetCompendiumDocumentArgs {
  packId: string;
  documentId: string;
}

interface CompendiumItem {
  id: string;
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
}

interface CompendiumEffect {
  id: string;
  name: string;
  icon?: string;
  disabled: boolean;
  duration?: Record<string, unknown>;
}

interface CompendiumEntryFull {
  id: string;
  name: string;
  type: string;
  img?: string;
  pack: string;
  packLabel: string;
  system: Record<string, unknown>;
  items?: CompendiumItem[];
  effects?: CompendiumEffect[];
  fullData: Record<string, unknown>;
}

const RESULT_LIMIT = 100;

/**
 * Search every (non-Scene) compendium pack's index for entries whose NAME
 * matches all whitespace-separated terms in the query. Name-only matching —
 * descriptions/traits are not indexed. Results are ranked (exact-name first,
 * then optional filter relevance, then alphabetical) and capped at 50.
 *
 * The Node tool re-applies its own limit on top of this; we return the same
 * CompendiumSearchResult[] shape it forwards from the bridge.
 */
export async function searchCompendium(
  args: CompendiumSearchArgs
): Promise<CompendiumSearchResult[]> {
  const query = args?.query;
  const packType = args?.packType;
  const filters = args?.filters;

  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    throw new Error('Search query must be a string with at least 2 characters');
  }

  const cleanQuery = query.toLowerCase().trim();
  const searchTerms = cleanQuery
    .split(' ')
    .filter(term => term && typeof term === 'string' && term.length > 0);

  if (searchTerms.length === 0) {
    throw new Error('Search query must contain valid search terms');
  }

  // Filter packs by requested type; never search Scene packs.
  const packs: any[] = Array.from(game.packs.values()).filter((pack: any) => {
    if (packType && pack.metadata.type !== packType) {
      return false;
    }
    return pack.metadata.type !== 'Scene';
  });

  const results: CompendiumSearchResult[] = [];

  for (const pack of packs) {
    try {
      if (!pack.indexed) {
        await pack.getIndex({});
      }

      const entries = Array.from(pack.index.values());

      for (const entry of entries) {
        try {
          const typedEntry = entry as any;
          if (
            !typedEntry?.name ||
            typeof typedEntry.name !== 'string' ||
            typedEntry.name.trim().length === 0
          ) {
            continue;
          }

          const entryNameLower = typedEntry.name.toLowerCase();
          const nameMatch = searchTerms.every(term => entryNameLower.includes(term));
          if (!nameMatch) {
            continue;
          }

          // Optional name-heuristic filtering, Actor packs only.
          if (
            filters &&
            shouldApplyFilters(typedEntry, filters) &&
            pack.metadata.type === 'Actor'
          ) {
            const searchCriteria: { searchTerms?: string[] } = {};

            if (filters.challengeRating) {
              const crTerms: string[] = [];
              if (typeof filters.challengeRating === 'number') {
                if (filters.challengeRating >= 15) {
                  crTerms.push('ancient', 'legendary', 'elder', 'greater');
                } else if (filters.challengeRating >= 10) {
                  crTerms.push('adult', 'warlord', 'champion', 'master');
                } else if (filters.challengeRating >= 5) {
                  crTerms.push('captain', 'knight', 'priest', 'mage');
                } else {
                  crTerms.push('guard', 'soldier', 'warrior', 'scout');
                }
              }
              searchCriteria.searchTerms = crTerms;
            }

            if (filters.creatureType) {
              const typeTerms = [filters.creatureType];
              if (filters.creatureType.toLowerCase() === 'humanoid') {
                typeTerms.push('human', 'elf', 'dwarf', 'orc', 'goblin');
              }
              searchCriteria.searchTerms = [...(searchCriteria.searchTerms || []), ...typeTerms];
            }

            if (!matchesSearchCriteria(typedEntry, searchCriteria)) {
              continue;
            }
          }

          results.push({
            id: typedEntry._id || '',
            name: typedEntry.name,
            type: typedEntry.type || 'unknown',
            img: typedEntry.img || undefined,
            pack: pack.metadata.id,
            packLabel: pack.metadata.label,
            description: typedEntry.description || '',
            hasImage: !!typedEntry.img,
            summary: `${typedEntry.type} from ${pack.metadata.label}`,
          });
        } catch {
          continue;
        }

        if (results.length >= RESULT_LIMIT) break;
      }
    } catch {
      // Skip packs that fail to index/search; keep going.
    }

    if (results.length >= RESULT_LIMIT) break;
  }

  // Relevance ranking: exact name, then filter score, then alphabetical.
  results.sort((a, b) => {
    // Premium books first, SRD (dnd5e.*) always last — we author only from the books (design.md §2.3).
    const aPri = packPriority(a.pack);
    const bPri = packPriority(b.pack);
    if (aPri !== bPri) return aPri - bPri;

    const aExact = a.name.toLowerCase() === query.toLowerCase();
    const bExact = b.name.toLowerCase() === query.toLowerCase();
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;

    if (filters) {
      const aScore = calculateRelevanceScore(a, filters, query);
      const bScore = calculateRelevanceScore(b, filters, query);
      if (aScore !== bScore) return bScore - aScore;
    }

    return a.name.localeCompare(b.name);
  });

  return results.slice(0, 50);
}

/**
 * List all compendium packs with their basic metadata. The Node tool filters by
 * type and derives availableTypes from this list.
 */
export function getAvailablePacks(): unknown {
  return Array.from(game.packs.values()).map((pack: any) => ({
    id: pack.metadata.id,
    label: pack.metadata.label,
    type: pack.metadata.type,
    system: pack.metadata.system,
    private: pack.metadata.private,
  }));
}

/**
 * Load a single compendium document in full: sanitized system data, sanitized
 * raw toObject() data, plus embedded items and active effects when present.
 */
export async function getCompendiumDocumentFull(
  args: GetCompendiumDocumentArgs
): Promise<CompendiumEntryFull> {
  const packId = args?.packId;
  const documentId = args?.documentId;

  const pack = game.packs.get(packId);
  if (!pack) {
    throw new Error(`Compendium pack ${packId} not found`);
  }

  const document = await pack.getDocument(documentId);
  if (!document) {
    throw new Error(`Document ${documentId} not found in pack ${packId}`);
  }

  // Sanitize toObject() SOURCE, not the live document: dnd5e 5.x system.activities is a
  // Map and Object.keys() on a Map is [] — sanitizing the live `system` would empty it to {}.
  const source: any = document.toObject();

  const fullEntry: CompendiumEntryFull = {
    id: document.id || '',
    name: document.name || '',
    type: document.type || 'unknown',
    img: document.img || undefined,
    pack: packId,
    packLabel: pack.metadata.label,
    system: sanitizeData(source.system || {}),
    fullData: sanitizeData(source),
  };

  if (document.items) {
    fullEntry.items = document.items.map((item: any) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      img: item.img || undefined,
      system: sanitizeData(toSource(item).system || {}),
    }));
  }

  if (document.effects) {
    fullEntry.effects = document.effects.map((effect: any) => ({
      id: effect.id,
      name: effect.name || effect.label || 'Unknown Effect',
      icon: effect.icon || undefined,
      disabled: effect.disabled || false,
      duration: sanitizeData(effect.duration || {}),
    }));
  }

  return fullEntry;
}

// --- local helpers -------------------------------------------------------

/** Only NPC/character/creature entries are eligible for name-heuristic filtering. */
function shouldApplyFilters(entry: any, filters: any): boolean {
  if (entry.type !== 'npc' && entry.type !== 'character' && entry.type !== 'creature') {
    return false;
  }
  return Object.keys(filters).some(key => filters[key] !== undefined);
}

/** Name-based heuristic: pass if the entry name contains any of the derived terms. */
function matchesSearchCriteria(entry: any, criteria: { searchTerms?: string[] }): boolean {
  const terms = criteria.searchTerms;
  if (!terms || terms.length === 0) {
    return true;
  }
  const nameLower = (entry.name || '').toLowerCase();
  return terms.some(term => nameLower.includes(term.toLowerCase()));
}

/** Heuristic relevance score used to rank filtered Actor searches. */
function calculateRelevanceScore(entry: any, filters: any, query: string): number {
  let score = 0;
  const system = entry.system || {};

  if (filters.creatureType) {
    const entryType = system.details?.type?.value || system.type?.value || '';
    if (entryType.toLowerCase() === filters.creatureType.toLowerCase()) {
      score += 20;
    }
  }

  if (filters.challengeRating !== undefined) {
    const entryCR = system.details?.cr || system.cr || 0;
    if (typeof filters.challengeRating === 'number') {
      if (entryCR === filters.challengeRating) score += 15;
    } else if (typeof filters.challengeRating === 'object') {
      const { min, max } = filters.challengeRating;
      if (min !== undefined && max !== undefined) {
        if (entryCR >= min && entryCR <= max) {
          score += 10;
          const rangeMid = (min + max) / 2;
          const distFromMid = Math.abs(entryCR - rangeMid);
          score += Math.max(0, 5 - distFromMid);
        }
      }
    }
  }

  const commonNames = [
    'knight',
    'warrior',
    'guard',
    'soldier',
    'mage',
    'priest',
    'bandit',
    'orc',
    'goblin',
    'dragon',
  ];
  const lowerName = (entry.name || '').toLowerCase();
  if (commonNames.some(name => lowerName.includes(name))) {
    score += 5;
  }

  const queryTerms = query.toLowerCase().split(' ');
  for (const term of queryTerms) {
    if (term.length > 2 && lowerName.includes(term)) {
      score += 3;
    }
  }

  return score;
}

/**
 * JSON-safe sanitize: strips sensitive/problematic/deprecated fields and most
 * underscore-prefixed keys (keeps _id), handles cycles, and works around dnd5e
 * 5.3 deprecated senses getters. Returns a plain JSON-clonable copy.
 */
/**
 * Sanitize compendium data for output. Delegates the field-stripping/cycle-guarding to the
 * shared sanitizeDocData (the page layer's single chokepoint), then runs a JSON round-trip so
 * the result is guaranteed plain-JSON-clonable for the bridge return path.
 */
function sanitizeData(data: any): any {
  if (data === null || data === undefined) {
    return data;
  }
  if (typeof data !== 'object') {
    return data;
  }
  try {
    return JSON.parse(safeJSONStringify(sanitizeDocData(data)));
  } catch {
    return {};
  }
}

function safeJSONStringify(obj: any): string {
  try {
    return JSON.stringify(obj, (key, value) => {
      if (key === 'save' && typeof value === 'object' && value !== null) {
        return undefined;
      }
      return value;
    });
  } catch {
    return '{}';
  }
}
