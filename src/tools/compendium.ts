import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import {
  detectGameSystem,
  getCreatureLevel,
  getCreatureType,
  type GameSystem,
} from '../utils/system-detection.js';
import { GenericFiltersSchema, describeFilters } from '../utils/compendium-filters.js';
import { assertNoSrdPacks, isSrdPack } from '../utils/compendium-sources.js';
import { toInputSchema } from '../utils/schema.js';

// Single source of truth for each tool's input contract: the handlers parse with these schemas
// and getToolDefinitions() advertises toInputSchema(...) of the same schema, so the advertised
// and enforced contracts cannot drift (e.g. the limit default that previously said 500 but
// enforced 100). The lenient coercion unions below are deliberate — they recover stringified
// argument shapes some MCP clients send — and `io: 'input'` advertises that accepted input side.

const SearchCompendiumSchema = z.object({
  query: z
    .string()
    .min(2, 'Search query must be at least 2 characters')
    .describe(
      'Search query to find items in compendiums by name only. Use broad, simple terms (e.g., "dragon", "sword", "feat"). Descriptions and traits are NOT searchable.'
    ),
  packType: z
    .string()
    .optional()
    .describe('Optional filter by pack type (e.g., "Item", "Actor", "JournalEntry")'),
  filters: GenericFiltersSchema.optional().describe(
    'LIMITED FUNCTIONALITY: Only works on Actor packs using name-based heuristics. challengeRating searches for keywords like "ancient" (CR 15+), "adult" (CR 10+), "captain" (CR 5+). creatureType searches for type keywords in names. Does NOT check actual system data. For accurate filtering, use search-compendium-creatures instead.'
  ),
  limit: z
    .number()
    .min(1)
    .max(50)
    .default(50)
    .describe('Maximum number of results to return (default: 50 for discovery searches, max: 50)'),
});

const GetCompendiumEntrySchema = z.object({
  packId: z
    .string()
    .min(1, 'Pack ID cannot be empty')
    .describe('ID of the compendium pack containing the item'),
  itemId: z
    .string()
    .min(1, 'Item ID cannot be empty')
    .describe('ID of the specific item to retrieve'),
  compact: z
    .boolean()
    .default(false)
    .describe(
      'Return condensed stat block (recommended for UI performance). Includes key stats, abilities, and actions but omits lengthy descriptions and technical data.'
    ),
});

const ListCreaturesByCriteriaSchema = z.object({
  // D&D 5e: challengeRating
  challengeRating: z
    .union([
      z
        .object({
          min: z.number().optional().default(0).describe('Minimum CR (default: 0)'),
          max: z.number().optional().default(30).describe('Maximum CR (default: 30)'),
        })
        .describe('CR range object (e.g., {"min": 10, "max": 15})'),
      z
        .string()
        .refine(
          val => {
            try {
              const parsed = JSON.parse(val);
              return (
                typeof parsed === 'object' &&
                parsed !== null &&
                (typeof parsed.min === 'number' || typeof parsed.max === 'number')
              );
            } catch {
              return false;
            }
          },
          {
            message: 'Challenge rating range must be valid JSON object with min/max numbers',
          }
        )
        .transform(val => {
          const parsed = JSON.parse(val);
          return {
            min: parsed.min || 0,
            max: parsed.max || 30,
          };
        }),
      z.number().describe('Exact CR value (e.g., 12)'),
      z
        .string()
        .refine(val => !Number.isNaN(parseFloat(val)), {
          message: 'Challenge rating must be a valid number',
        })
        .transform(val => parseFloat(val)),
    ])
    .optional()
    .describe(
      'Filter by Challenge Rating - accepts number, string, or range object. Use ranges for broader discovery (e.g., {"min": 10, "max": 15}) or exact values (12 or "12")'
    ),

  // Common filters
  creatureType: z.string().optional().describe('Filter by creature type'), // Accept any string, validate per system
  size: z
    .enum(['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'])
    .optional()
    .describe('Filter by creature size'),

  // Spellcasting flags
  hasSpells: z
    .union([
      z.boolean(),
      z
        .string()
        .refine(val => ['true', 'false'].includes(val.toLowerCase()))
        .transform(val => val.toLowerCase() === 'true'),
    ])
    .optional()
    .describe('Filter for spellcasting creatures'),
  hasLegendaryActions: z
    .union([
      z.boolean(),
      z
        .string()
        .refine(val => ['true', 'false'].includes(val.toLowerCase()))
        .transform(val => val.toLowerCase() === 'true'),
    ])
    .optional()
    .describe('Filter for creatures with legendary actions (D&D 5e)'),

  limit: z
    .union([
      z.number().min(1).max(1000),
      z
        .string()
        .refine(val => {
          const num = parseInt(val, 10);
          return !Number.isNaN(num) && num >= 1 && num <= 1000;
        })
        .transform(val => parseInt(val, 10)),
    ])
    .optional()
    // Matches the advertised JSON-Schema default (500, "comprehensive surveys"); generated from
    // this schema so the two can no longer diverge.
    .default(500)
    .describe('Maximum results to return (default: 500 for comprehensive surveys, max: 1000)'),
});

const ListCompendiumPacksSchema = z.object({
  type: z.string().optional().describe('Optional filter by pack type'),
});

// Thin typed facade over the page-side faceted engine (searchCompendiumFaceted). The tool hard-codes
// documentType: 'spell', so only spell facets are representable here (design.md §2.1, "a tool is a
// contract"). Lenient string/number unions mirror the other compendium schemas — they recover the
// stringified argument shapes some MCP clients send.
const SearchCompendiumSpellsSchema = z.object({
  name: z
    .string()
    .optional()
    .describe('Case-insensitive substring to narrow by spell name (e.g., "fire", "cure wounds").'),
  spellLevel: z
    .union([
      z
        .object({
          min: z.number().min(0).max(9).optional().describe('Minimum level (0 = cantrip)'),
          max: z.number().min(0).max(9).optional().describe('Maximum level'),
        })
        .describe('Level range, e.g. {"min":1,"max":3}'),
      z.number().min(0).max(9).describe('Exact spell level (0 = cantrip … 9)'),
      z
        .string()
        .refine(
          val => {
            try {
              const parsed = JSON.parse(val);
              return (
                typeof parsed === 'object' &&
                parsed !== null &&
                (typeof parsed.min === 'number' || typeof parsed.max === 'number')
              );
            } catch {
              return false;
            }
          },
          { message: 'Spell-level range must be valid JSON with min/max numbers' }
        )
        .transform(val => JSON.parse(val) as { min?: number; max?: number }),
      z
        .string()
        .refine(val => !Number.isNaN(parseInt(val, 10)), {
          message: 'Spell level must be a valid number',
        })
        .transform(val => parseInt(val, 10)),
    ])
    .optional()
    .describe(
      'Filter by spell level — exact number (0 = cantrip … 9) or a {"min","max"} range for surveys.'
    ),
  spellSchool: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Spell school(s): abjuration · conjuration · divination · enchantment · evocation · illusion · necromancy · transmutation (full name or dnd5e 3-letter key; one value or an array).'
    ),
  damageType: z
    .string()
    .optional()
    .describe(
      'Keep only spells that deal this damage type (e.g., "fire", "cold", "radiant"). Two-stage: candidate spells are loaded to inspect their activities, so this narrows an already facet-filtered set.'
    ),
  limit: z
    .union([
      z.number().min(1).max(200),
      z
        .string()
        .refine(val => {
          const num = parseInt(val, 10);
          return !Number.isNaN(num) && num >= 1 && num <= 200;
        })
        .transform(val => parseInt(val, 10)),
    ])
    .default(50)
    .describe('Maximum results to return (default: 50, max: 200)'),
});

// Thin typed facade over the faceted engine for GEAR. documentType narrows the item family
// (gear=all / weapon / armor / consumable); only gear facets are representable (design.md §2.1).
const SearchCompendiumItemsSchema = z.object({
  documentType: z
    .enum(['gear', 'weapon', 'armor', 'consumable'])
    .default('gear')
    .describe(
      'Item family to search: "gear" = everything (weapons, armor/equipment, consumables, tools, loot, containers); or narrow to "weapon", "armor", or "consumable".'
    ),
  name: z
    .string()
    .optional()
    .describe('Case-insensitive substring to narrow by item name (e.g., "flame", "healing").'),
  rarity: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Rarity/-ies: common · uncommon · rare · very rare · legendary · artifact (case- and space-insensitive; one value or an array).'
    ),
  itemType: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'dnd5e item SUBTYPE key (system.type.value), e.g. "wand" · "wondrous" · "rod" · "ring" · "potion" · "scroll" · "ammo"; for weapons the weapon-type key (e.g. "martialM"). One value or an array.'
    ),
  properties: z
    .array(z.string())
    .optional()
    .describe(
      'Keep items carrying ANY of these dnd5e property keys (e.g. "mgc" = magical, "fin" = finesse, "ver" = versatile).'
    ),
  magical: z
    .union([
      z.boolean(),
      z
        .string()
        .refine(val => ['true', 'false'].includes(val.toLowerCase()))
        .transform(val => val.toLowerCase() === 'true'),
    ])
    .optional()
    .describe('If true, keep only items flagged magical (the "mgc" property).'),
  limit: z
    .union([
      z.number().min(1).max(200),
      z
        .string()
        .refine(val => {
          const num = parseInt(val, 10);
          return !Number.isNaN(num) && num >= 1 && num <= 200;
        })
        .transform(val => parseInt(val, 10)),
    ])
    .default(50)
    .describe('Maximum results to return (default: 50, max: 200)'),
});

export interface CompendiumToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class CompendiumTools {
  private foundry: FoundryBridge;
  private logger: Logger;
  private gameSystem: GameSystem | null = null;

  constructor({ foundry, logger }: CompendiumToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'CompendiumTools' });
  }

  /**
   * Get or detect the game system (cached)
   */
  private async getGameSystem(): Promise<GameSystem> {
    if (!this.gameSystem) {
      this.gameSystem = await detectGameSystem(this.foundry, this.logger);
    }
    return this.gameSystem;
  }

  /**
   * Tool definitions for compendium operations
   */
  getToolDefinitions() {
    return [
      {
        name: 'search-compendium',
        description:
          'Search the premium book compendium packs by name. The SRD (dnd5e.*) packs are NOT searched and never appear in results — the authoring library is the premium books only (design.md §2.3). IMPORTANT LIMITATIONS: (1) Text search only matches entity NAMES - descriptions and traits are NOT searchable. (2) Filters use name heuristics only (not actual system data) and only work on Actor packs - challengeRating and creatureType filters search for keywords like "ancient", "legendary", "humanoid", etc. in entity names. For accurate filtering by level/CR, traits, or rarity, use search-compendium-creatures instead. For best results, use broad name-based searches (e.g., "dragon", "knight") and inspect individual items with get-compendium-entry.',
        inputSchema: toInputSchema(SearchCompendiumSchema),
      },
      {
        name: 'get-compendium-entry',
        description:
          'Retrieve a specific compendium entry (monster, item, spell, etc.) by pack id + entry id. Returns the full stat block — items, spells, abilities, effects, system data — needed for actor/item creation. Set compact=true for a condensed stat block when full detail is not needed. An SRD (dnd5e.*) pack id is refused — author only from the premium books (design.md §2.3).',
        inputSchema: toInputSchema(GetCompendiumEntrySchema),
      },
      {
        name: 'search-compendium-creatures',
        description:
          'D&D 5e CREATURE DISCOVERY: find creatures matching faceted criteria (Challenge Rating, type, size, spellcasting, legendary actions) across the premium book Actor packs only — the SRD (dnd5e.*) packs are excluded and never appear in results (design.md §2.3). Backed by the system Compendium Browser, so CR/type/size check real system data (not name heuristics); hasSpells/hasLegendaryActions are approximate index flags. Returns minimal hits ({id,name,type,uuid,pack,packLabel,img,facets}) premium-first ranked — identify candidates by name, then pull full stat blocks with get-compendium-entry. High result limits for complete encounter-building surveys.',
        inputSchema: toInputSchema(ListCreaturesByCriteriaSchema),
      },
      {
        name: 'search-compendium-spells',
        description:
          'D&D 5e SPELL DISCOVERY: find spells matching faceted criteria (level, school, damage type, name) across the premium book packs only — the SRD (dnd5e.*) packs are excluded and never appear in results (design.md §2.3). Backed by the system Compendium Browser, so filters check real spell data (not name heuristics). Returns minimal hits ({id,name,type,uuid,pack,packLabel,img,facets}) premium-first ranked — identify candidates here, then pull full detail with get-compendium-entry. damageType is a two-stage refine (loads candidate spells to inspect their activities).',
        inputSchema: toInputSchema(SearchCompendiumSpellsSchema),
      },
      {
        name: 'search-compendium-items',
        description:
          'D&D 5e ITEM/GEAR DISCOVERY: find equipment, weapons, armor, consumables, and treasure matching faceted criteria (rarity, subtype, properties, magical, name) across the premium book packs only — the SRD (dnd5e.*) packs are excluded and never appear in results (design.md §2.3). Backed by the system Compendium Browser, so filters check real item data (not name heuristics). Returns minimal hits ({id,name,type,uuid,pack,packLabel,img,facets}) premium-first ranked — identify candidates here, then pull full detail with get-compendium-entry. Use documentType to narrow the item family (gear=all, or weapon/armor/consumable).',
        inputSchema: toInputSchema(SearchCompendiumItemsSchema),
      },
      {
        name: 'list-compendium-packs',
        description:
          'List the available compendium packs. SRD (dnd5e.*) packs are excluded — only the premium book packs (and any other non-SRD packs) are listed (design.md §2.3).',
        inputSchema: toInputSchema(ListCompendiumPacksSchema),
      },
    ];
  }

  async handleSearchCompendium(args: any): Promise<any> {
    // Detect game system for appropriate filtering
    const gameSystem = await this.getGameSystem();

    const schema = SearchCompendiumSchema;

    // Defensive coercion for occasionally-malformed call shapes: some MCP clients have been
    // observed to send `query` as a bare string or under a single differently-named key instead
    // of `{ query }`. We recover those two shapes rather than hard-failing the search, but we
    // WARN when we do (the reshaping is intentionally not silent — a sudden spike means a client
    // is sending the wrong shape and the workaround should be revisited/removed).
    let parsedArgs: z.infer<typeof schema>;
    try {
      parsedArgs = schema.parse(args);
    } catch (zodError) {
      if (typeof args === 'string') {
        this.logger.warn(
          'search-compendium: recovered a bare-string query (non-standard arg shape)'
        );
        parsedArgs = schema.parse({ query: args });
      } else if (args && typeof args.query === 'undefined' && typeof args === 'object') {
        const firstKey = Object.keys(args)[0];
        if (firstKey && typeof args[firstKey] === 'string') {
          this.logger.warn('search-compendium: recovered query from a non-standard key', {
            key: firstKey,
          });
          parsedArgs = schema.parse({ query: args[firstKey] });
        } else {
          throw zodError;
        }
      } else {
        this.logger.debug('Failed to parse search args, using fallback', {
          args: typeof args === 'object' ? JSON.stringify(args) : args,
          error: zodError instanceof Error ? zodError.message : 'Unknown parsing error',
        });
        throw zodError;
      }
    }

    const { query, packType, filters, limit } = parsedArgs;

    // Log system detection and filters
    this.logger.info('Compendium search with system detection', {
      gameSystem,
      query,
      filters: filters ? describeFilters(filters, gameSystem) : 'none',
    });

    try {
      const results = await this.foundry.call('searchCompendium', {
        query,
        packType,
        filters,
      });

      // Enforced backstop to the page-side exclusion: an SRD (`dnd5e.*`) hit is never a result
      // (design.md §2.3). The page already drops SRD packs before indexing; we re-drop here so the
      // contract holds even if a pack slips past that filter, and counts reflect only book hits.
      const visibleResults = results.filter((item: any) => !isSrdPack(item?.pack));

      // Limit results
      const limitedResults = visibleResults.slice(0, limit);

      this.logger.debug('Compendium search completed', {
        query,
        gameSystem,
        totalFound: visibleResults.length,
        returned: limitedResults.length,
      });

      return {
        query,
        gameSystem, // Include detected system in response
        filterDescription: filters ? describeFilters(filters, gameSystem) : 'no filters',
        results: limitedResults.map((item: any) => this.formatCompendiumItem(item, gameSystem)),
        totalFound: visibleResults.length,
        showing: limitedResults.length,
        hasMore: visibleResults.length > limit,
      };
    } catch (error) {
      this.logger.error('Failed to search compendium', error);
      throw new Error(
        `Failed to search compendium: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleGetCompendiumItem(args: any): Promise<any> {
    const { packId, itemId, compact } = GetCompendiumEntrySchema.parse(args);

    // SRD packs are not a source and are not even visible in lookups (design.md §2.3); refuse an
    // SRD packId outright rather than reading from it, consistent with the pull-tool guards.
    assertNoSrdPacks(packId, 'get-compendium-entry');

    try {
      // Use the proper document retrieval method that already exists in actor creation
      const item = await this.foundry.call('getCompendiumDocumentFull', {
        packId,
        documentId: itemId,
      });

      if (!item) {
        throw new Error(`Item ${itemId} not found in pack ${packId}`);
      }

      // Format the response using the detailed item data
      const baseResponse = {
        id: item.id,
        name: item.name,
        type: item.type,
        pack: {
          id: item.pack,
          label: item.packLabel,
        },
        description: this.extractDescription(item),
        hasImage: !!item.img,
        imageUrl: item.img,
      };

      if (compact) {
        // Compact response for UI performance
        const compactStats = this.extractCompactStats(item);
        return {
          ...baseResponse,
          stats: compactStats,
          properties: this.extractItemProperties(item),
          items: (item.items || []).slice(0, 5), // Limit items to prevent bloat
          mode: 'compact',
        };
      } else {
        // Full response
        return {
          ...baseResponse,
          fullDescription: this.extractFullDescription(item),
          system: this.sanitizeSystemData(item.system || {}),
          properties: this.extractItemProperties(item),
          items: item.items || [],
          effects: item.effects || [],
          fullData: item.fullData,
          mode: 'full',
        };
      }
    } catch (error) {
      this.logger.error('Failed to get compendium item', error);
      throw new Error(
        `Failed to retrieve item: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleListCreaturesByCriteria(args: any): Promise<any> {
    let params: z.infer<typeof ListCreaturesByCriteriaSchema>;
    try {
      params = ListCreaturesByCriteriaSchema.parse(args);
    } catch (parseError) {
      this.logger.error('Failed to parse creature criteria parameters', { args, parseError });
      if (parseError instanceof z.ZodError) {
        const errorDetails = parseError.issues
          .map(err => `${err.path.join('.')}: ${err.message}`)
          .join('; ');
        throw new Error(
          `Parameter validation failed: ${errorDetails}. Received args: ${JSON.stringify(args)}`
        );
      }
      throw parseError;
    }

    const criteriaDescription = this.describeCriteria(params);
    this.logger.info('Creature faceted search', { criteria: criteriaDescription });

    try {
      // Re-backed on the one faceted engine (documentType:'creature'); CR/type/size are index
      // filters, hasSpells/hasLegendaryActions are engine post-filters on approximate index facets.
      const hits = await this.foundry.call('searchCompendiumFaceted', {
        documentType: 'creature',
        challengeRating: params.challengeRating,
        creatureType: params.creatureType,
        size: params.size,
        hasSpells: params.hasSpells,
        hasLegendaryActions: params.hasLegendaryActions,
        limit: params.limit,
      });

      // Enforced backstop to the engine's by-uuid SRD exclusion (design.md §2.3); see the spell facade.
      const list: any[] = Array.isArray(hits) ? hits : [];
      const results = list.filter(hit => !isSrdPack(hit?.pack));

      return {
        documentType: 'creature',
        criteriaDescription,
        results,
        totalFound: results.length,
        criteria: params,
        note: 'Premium book creatures only — the SRD is never a source (design.md §2.3). Use creature names to pick candidates, then get-compendium-entry for full stat blocks.',
      };
    } catch (error) {
      this.logger.error('Failed to list creatures by criteria', error);
      throw new Error(
        `Failed to list creatures: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleListCompendiumPacks(args: any): Promise<any> {
    const { type } = ListCompendiumPacksSchema.parse(args);

    this.logger.info('Listing compendium packs', { type });

    try {
      const rawPacks = await this.foundry.call('getAvailablePacks');

      // Enforced backstop to the page-side exclusion: SRD (`dnd5e.*`) packs are not visible in
      // lookups (design.md §2.3). The page already omits them; re-drop here so the contract holds,
      // and so `availableTypes` below is derived only from the visible (book) packs.
      const packs = rawPacks.filter((pack: any) => !isSrdPack(pack?.id));

      // Filter by type if specified
      const filteredPacks = type ? packs.filter((pack: any) => pack.type === type) : packs;

      this.logger.debug('Successfully retrieved compendium packs', {
        total: packs.length,
        filtered: filteredPacks.length,
        type,
      });

      return {
        packs: filteredPacks.map((pack: any) => ({
          id: pack.id,
          label: pack.label,
          type: pack.type,
          system: pack.system,
          private: pack.private,
        })),
        total: filteredPacks.length,
        availableTypes: [...new Set(packs.map((pack: any) => pack.type))],
      };
    } catch (error) {
      this.logger.error('Failed to list compendium packs', error);
      throw new Error(
        `Failed to list compendium packs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleSearchCompendiumSpells(args: any): Promise<any> {
    let params: z.infer<typeof SearchCompendiumSpellsSchema>;
    try {
      params = SearchCompendiumSpellsSchema.parse(args);
    } catch (parseError) {
      if (parseError instanceof z.ZodError) {
        const details = parseError.issues
          .map(err => `${err.path.join('.')}: ${err.message}`)
          .join('; ');
        throw new Error(
          `Parameter validation failed: ${details}. Received args: ${JSON.stringify(args)}`
        );
      }
      throw parseError;
    }

    const criteriaDescription = this.describeSpellCriteria(params);
    this.logger.info('Spell faceted search', { criteria: criteriaDescription });

    try {
      // Thin facade: hard-code the content type and forward the spell facets to the one engine.
      const hits = await this.foundry.call('searchCompendiumFaceted', {
        documentType: 'spell',
        name: params.name,
        spellLevel: params.spellLevel,
        spellSchool: params.spellSchool,
        damageType: params.damageType,
        limit: params.limit,
      });

      // Enforced backstop to the engine's by-uuid SRD exclusion: a dnd5e.* hit is never a result
      // (design.md §2.3). The engine already drops SRD packs; re-drop here so the contract holds
      // (and counts stay book-only) even if one slips past.
      const list: any[] = Array.isArray(hits) ? hits : [];
      const results = list.filter(hit => !isSrdPack(hit?.pack));

      return {
        documentType: 'spell',
        criteriaDescription,
        results,
        totalFound: results.length,
        criteria: params,
        note: 'Premium book spells only — the SRD is never a source (design.md §2.3). Use get-compendium-entry for full spell detail.',
      };
    } catch (error) {
      this.logger.error('Failed to search compendium spells', error);
      throw new Error(
        `Failed to search compendium spells: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleSearchCompendiumItems(args: any): Promise<any> {
    let params: z.infer<typeof SearchCompendiumItemsSchema>;
    try {
      params = SearchCompendiumItemsSchema.parse(args);
    } catch (parseError) {
      if (parseError instanceof z.ZodError) {
        const details = parseError.issues
          .map(err => `${err.path.join('.')}: ${err.message}`)
          .join('; ');
        throw new Error(
          `Parameter validation failed: ${details}. Received args: ${JSON.stringify(args)}`
        );
      }
      throw parseError;
    }

    const criteriaDescription = this.describeItemCriteria(params);
    this.logger.info('Item faceted search', {
      documentType: params.documentType,
      criteria: criteriaDescription,
    });

    try {
      // Thin facade: forward the gear facets to the one engine (documentType picks the family).
      const hits = await this.foundry.call('searchCompendiumFaceted', {
        documentType: params.documentType,
        name: params.name,
        rarity: params.rarity,
        itemType: params.itemType,
        properties: params.properties,
        magical: params.magical,
        limit: params.limit,
      });

      // Enforced backstop to the engine's by-uuid SRD exclusion (design.md §2.3); see the spell facade.
      const list: any[] = Array.isArray(hits) ? hits : [];
      const results = list.filter(hit => !isSrdPack(hit?.pack));

      return {
        documentType: params.documentType,
        criteriaDescription,
        results,
        totalFound: results.length,
        criteria: params,
        note: 'Premium book items only — the SRD is never a source (design.md §2.3). Use get-compendium-entry for full item detail.',
      };
    } catch (error) {
      this.logger.error('Failed to search compendium items', error);
      throw new Error(
        `Failed to search compendium items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /** Human-readable summary of the item-search facets (transparency + logging). */
  private describeItemCriteria(params: z.infer<typeof SearchCompendiumItemsSchema>): string {
    const parts: string[] = [];
    if (params.rarity) {
      parts.push(Array.isArray(params.rarity) ? params.rarity.join('/') : params.rarity);
    }
    if (params.itemType) {
      parts.push(Array.isArray(params.itemType) ? params.itemType.join('/') : params.itemType);
    }
    if (params.magical !== undefined) parts.push(params.magical ? 'magical' : 'non-magical');
    if (params.properties?.length) parts.push(`properties:${params.properties.join('+')}`);
    if (params.name) parts.push(`name~"${params.name}"`);
    const facets = parts.length > 0 ? parts.join(', ') : 'no facets';
    return `${params.documentType} (${facets})`;
  }

  /** Human-readable summary of the spell-search facets (transparency + logging). */
  private describeSpellCriteria(params: z.infer<typeof SearchCompendiumSpellsSchema>): string {
    const parts: string[] = [];
    if (params.spellLevel !== undefined) {
      if (typeof params.spellLevel === 'number') {
        parts.push(params.spellLevel === 0 ? 'cantrip' : `level ${params.spellLevel}`);
      } else {
        const min = params.spellLevel.min ?? 0;
        const max = params.spellLevel.max ?? 9;
        parts.push(`level ${min}-${max}`);
      }
    }
    if (params.spellSchool) {
      parts.push(
        Array.isArray(params.spellSchool) ? params.spellSchool.join('/') : params.spellSchool
      );
    }
    if (params.damageType) parts.push(`${params.damageType} damage`);
    if (params.name) parts.push(`name~"${params.name}"`);
    return parts.length > 0 ? parts.join(', ') : 'no criteria';
  }

  private formatCompendiumItem(item: any, gameSystem?: GameSystem): any {
    const formatted: any = {
      id: item.id,
      name: item.name,
      type: item.type,
      pack: {
        id: item.pack,
        label: item.packLabel,
      },
      description: this.extractDescription(item),
      hasImage: !!item.img,
      summary: this.createItemSummary(item),
    };

    // Add key stats for actors/creatures to reduce need for detail calls.
    if (item.type === 'npc' || item.type === 'character') {
      const stats: any = {};

      if (gameSystem === 'dnd5e') {
        // Challenge Rating
        const level = getCreatureLevel(item, gameSystem);
        if (level !== undefined) stats.challengeRating = level;

        // Creature type
        const creatureType = getCreatureType(item, gameSystem);
        if (creatureType && typeof creatureType === 'string') stats.creatureType = creatureType;

        const system = item.system || {};

        // Hit Points
        const hp = system.attributes?.hp?.value;
        const maxHp = system.attributes?.hp?.max;
        if (hp !== undefined || maxHp !== undefined) {
          stats.hitPoints = { current: hp, max: maxHp };
        }

        // Armor Class
        const ac = system.attributes?.ac?.value;
        if (ac !== undefined) stats.armorClass = ac;

        // Size
        const size = system.traits?.size?.value || system.traits?.size || system.size;
        if (size) stats.size = size;

        // Alignment
        const alignment =
          system.details?.alignment?.value || system.details?.alignment || system.alignment;
        if (alignment) stats.alignment = alignment;
      } else {
        // Fallback: Legacy D&D 5e extraction (system not detected)
        const system = item.system || {};
        const cr = system.details?.cr || system.cr;
        if (cr !== undefined) stats.challengeRating = cr;

        const hp = system.attributes?.hp?.value || system.hp?.value;
        const maxHp = system.attributes?.hp?.max || system.hp?.max;
        if (hp !== undefined || maxHp !== undefined) {
          stats.hitPoints = { current: hp, max: maxHp };
        }

        const ac = system.attributes?.ac?.value || system.ac?.value;
        if (ac !== undefined) stats.armorClass = ac;

        const creatureType = system.details?.type?.value || system.type?.value;
        if (creatureType) stats.creatureType = creatureType;

        const size = system.traits?.size || system.size;
        if (size) stats.size = size;

        const alignment = system.details?.alignment || system.alignment;
        if (alignment) stats.alignment = alignment;
      }

      if (Object.keys(stats).length > 0) {
        formatted.stats = stats;
      }
    }

    return formatted;
  }

  private extractDescription(item: any): string {
    const system = item.system || {};

    // Try different common description fields
    const description =
      system.description?.value ||
      system.description?.content ||
      system.description ||
      system.details?.description ||
      '';

    return this.truncateText(this.stripHtml(description), 200);
  }

  private extractFullDescription(item: any): string {
    const system = item.system || {};

    const description =
      system.description?.value ||
      system.description?.content ||
      system.description ||
      system.details?.description ||
      '';

    return this.stripHtml(description);
  }

  private createItemSummary(item: any): string {
    const parts = [];

    parts.push(`${item.type} from ${item.packLabel}`);

    const system = item.system || {};

    // Add relevant summary information based on item type
    switch (item.type.toLowerCase()) {
      case 'spell':
        if (system.level) parts.push(`Level ${system.level}`);
        if (system.school) parts.push(system.school);
        break;
      case 'weapon':
        if (system.damage?.parts?.length) {
          const damage = system.damage.parts[0];
          parts.push(`${damage[0]} ${damage[1]} damage`);
        }
        break;
      case 'armor':
        if (system.armor?.value) parts.push(`AC ${system.armor.value}`);
        break;
      case 'equipment':
      case 'item':
        if (system.rarity) parts.push(system.rarity);
        if (system.price?.value)
          parts.push(`${system.price.value} ${system.price.denomination || 'gp'}`);
        break;
    }

    return parts.join(' • ');
  }

  /**
   * Helper method to describe criteria in human-readable format
   */
  private describeCriteria(params: any): string {
    const parts: string[] = [];

    if (params.challengeRating !== undefined) {
      if (typeof params.challengeRating === 'number') {
        parts.push(`CR ${params.challengeRating}`);
      } else if (typeof params.challengeRating === 'object') {
        const min = params.challengeRating.min ?? 0;
        const max = params.challengeRating.max ?? 30;
        parts.push(`CR ${min}-${max}`);
      }
    }

    if (params.creatureType) parts.push(params.creatureType);
    if (params.size) parts.push(params.size);
    if (params.hasSpells) parts.push('spellcaster');
    if (params.hasLegendaryActions) parts.push('legendary');

    return parts.length > 0 ? parts.join(', ') : 'no criteria';
  }

  private extractCompactStats(item: any): any {
    const system = item.system || {};
    const stats: any = {};

    // Core combat stats
    if (system.attributes?.ac?.value) stats.armorClass = system.attributes.ac.value;
    if (system.attributes?.hp?.max) stats.hitPoints = system.attributes.hp.max;
    if (system.details?.cr !== undefined) stats.challengeRating = system.details.cr;

    // Basic info
    if (system.details?.type?.value) stats.creatureType = system.details.type.value;
    if (system.traits?.size) stats.size = system.traits.size;
    if (system.details?.alignment) stats.alignment = system.details.alignment;

    // Key abilities (only show notable ones)
    if (system.abilities) {
      const abilities: any = {};
      for (const [key, ability] of Object.entries(system.abilities)) {
        const abil = ability as any;
        if (abil.value !== undefined) {
          const mod = Math.floor((abil.value - 10) / 2);
          if (Math.abs(mod) >= 2) {
            // Only show significant modifiers
            abilities[key.toUpperCase()] = { value: abil.value, modifier: mod };
          }
        }
      }
      if (Object.keys(abilities).length > 0) stats.abilities = abilities;
    }

    // Speed
    if (system.attributes?.movement) {
      const movement = system.attributes.movement;
      const speeds: string[] = [];
      if (movement.walk) speeds.push(`${movement.walk} ft`);
      if (movement.fly) speeds.push(`fly ${movement.fly} ft`);
      if (movement.swim) speeds.push(`swim ${movement.swim} ft`);
      if (speeds.length > 0) stats.speed = speeds.join(', ');
    }

    return stats;
  }

  private extractItemProperties(item: any): any {
    const system = item.system || {};
    const properties: any = {};

    // Common properties across different item types
    if (system.rarity) properties.rarity = system.rarity;
    if (system.price) properties.price = system.price;
    if (system.weight) properties.weight = system.weight;
    if (system.quantity) properties.quantity = system.quantity;

    // Spell-specific properties
    if (item.type.toLowerCase() === 'spell') {
      if (system.level !== undefined) properties.spellLevel = system.level;
      if (system.school) properties.school = system.school;
      if (system.components) properties.components = system.components;
      if (system.duration) properties.duration = system.duration;
      if (system.range) properties.range = system.range;
    }

    // Weapon-specific properties
    if (item.type.toLowerCase() === 'weapon') {
      if (system.damage) properties.damage = system.damage;
      if (system.weaponType) properties.weaponType = system.weaponType;
      if (system.properties) properties.weaponProperties = system.properties;
    }

    // Armor-specific properties
    if (item.type.toLowerCase() === 'armor') {
      if (system.armor) properties.armorClass = system.armor;
      if (system.stealth) properties.stealthDisadvantage = system.stealth;
    }

    return properties;
  }

  private sanitizeSystemData(systemData: any): any {
    // Remove potentially large or unnecessary fields
    const sanitized = { ...systemData };

    // Remove large description fields (already handled separately)
    delete sanitized.description;
    delete sanitized.details;

    // Remove internal/technical fields
    delete sanitized._id;
    delete sanitized.folder;
    delete sanitized.sort;
    delete sanitized.ownership;

    return sanitized;
  }

  private stripHtml(text: any): string {
    if (!text) return '';

    // Handle objects with value property (e.g., {value: "text"})
    if (typeof text === 'object' && text !== null) {
      if (text.value) {
        text = text.value;
      } else if (text.content) {
        text = text.content;
      } else {
        // For other objects, try to stringify or return empty
        try {
          text = JSON.stringify(text);
        } catch {
          return '';
        }
      }
    }

    // Handle arrays
    if (Array.isArray(text)) {
      return text.map(item => this.stripHtml(item)).join(' ');
    }

    // Ensure we have a string before calling replace()
    if (typeof text !== 'string') {
      const stringified = String(text || '');
      if (!stringified || stringified === '[object Object]') {
        return '';
      }
      text = stringified;
    }

    return text.replace(/<[^>]*>/g, '').trim();
  }

  private truncateText(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) {
      return text;
    }
    return `${text.substring(0, maxLength - 3)}...`;
  }
}
