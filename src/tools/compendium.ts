import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import {
  detectGameSystem,
  getCreatureLevel,
  getCreatureType,
  hasSpellcasting,
  type GameSystem,
} from '../utils/system-detection.js';
import { GenericFiltersSchema, describeFilters } from '../utils/compendium-filters.js';
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
          'Search through compendium packs by name. IMPORTANT LIMITATIONS: (1) Text search only matches entity NAMES - descriptions and traits are NOT searchable. (2) Filters use name heuristics only (not actual system data) and only work on Actor packs - challengeRating and creatureType filters search for keywords like "ancient", "legendary", "humanoid", etc. in entity names. For accurate filtering by level/CR, traits, or rarity, use search-compendium-creatures instead. For best results, use broad name-based searches (e.g., "dragon", "knight") and inspect individual items with get-compendium-entry.',
        inputSchema: toInputSchema(SearchCompendiumSchema),
      },
      {
        name: 'get-compendium-entry',
        description:
          'Retrieve a specific compendium entry (monster, item, spell, etc.) by pack id + entry id. Returns the full stat block — items, spells, abilities, effects, system data — needed for actor/item creation. Set compact=true for a condensed stat block when full detail is not needed.',
        inputSchema: toInputSchema(GetCompendiumEntrySchema),
      },
      {
        name: 'search-compendium-creatures',
        description:
          'D&D 5e CREATURE DISCOVERY: Get a comprehensive list of creatures matching specific criteria (Challenge Rating, type, size, spellcasting, legendary actions). Perfect for encounter building - returns minimal data so Claude can use built-in monster knowledge to identify suitable creatures by name, then pull full details only for final selections. Features intelligent pack prioritization and high result limits for complete surveys.',
        inputSchema: toInputSchema(ListCreaturesByCriteriaSchema),
      },
      {
        name: 'list-compendium-packs',
        description: 'List all available compendium packs',
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

      // Limit results
      const limitedResults = results.slice(0, limit);

      this.logger.debug('Compendium search completed', {
        query,
        gameSystem,
        totalFound: results.length,
        returned: limitedResults.length,
      });

      return {
        query,
        gameSystem, // Include detected system in response
        filterDescription: filters ? describeFilters(filters, gameSystem) : 'no filters',
        results: limitedResults.map((item: any) => this.formatCompendiumItem(item, gameSystem)),
        totalFound: results.length,
        showing: limitedResults.length,
        hasMore: results.length > limit,
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
    // Detect game system for appropriate filtering
    const gameSystem = await this.getGameSystem();

    // Use generic filters schema to support both systems
    const schema = ListCreaturesByCriteriaSchema;

    let params: z.infer<typeof schema>;
    try {
      params = schema.parse(args);
      this.logger.debug('Parsed creature criteria parameters successfully', params);
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

    // Log system detection and criteria
    const criteriaDescription = this.describeCriteria(params);
    this.logger.info('Creature criteria search with system detection', {
      gameSystem,
      criteria: criteriaDescription,
    });

    try {
      const results = await this.foundry.call('listCreaturesByCriteria', params);

      this.logger.debug('Creature criteria search completed', {
        gameSystem,
        criteriaCount: Object.keys(params).length,
        totalFound: results.response?.creatures?.length || 0,
        limit: params.limit,
        packsSearched: results.response?.searchSummary?.packsSearched || 0,
      });

      // Extract search summary for transparency
      const searchSummary = results.response?.searchSummary || {
        packsSearched: 0,
        topPacks: [],
        totalCreaturesFound: results.response?.creatures?.length || 0,
      };

      // Bridge returns either { response: { creatures: [...] } } or a bare array.
      // Use nullish coalescing so an empty creatures array is preserved (an empty
      // result must report totalFound: 0, not fall through to the wrapper's length).
      const creatureList: any[] = results.response?.creatures ?? results ?? [];

      return {
        gameSystem, // Include detected system
        criteriaDescription, // Human-readable criteria
        creatures: creatureList.map((creature: any) =>
          this.formatCreatureListItem(creature, gameSystem)
        ),
        totalFound: creatureList.length,
        criteria: params,
        searchSummary: {
          ...searchSummary,
          searchStrategy: `Prioritized pack search - D&D 5e content first, then modules, then campaign-specific`,
          note: 'Packs searched in priority order to find most relevant creatures first',
        },
        optimizationNote:
          'Use creature names to identify suitable options, then call get-compendium-entry for final details only',
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
      const packs = await this.foundry.call('getAvailablePacks');

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

  private formatCreatureListItem(creature: any, gameSystem?: GameSystem): any {
    const system = creature.system || {};
    const formatted: any = {
      name: creature.name,
      id: creature.id,
      pack: { id: creature.pack, label: creature.packLabel },
    };

    if (gameSystem === 'dnd5e') {
      const level = getCreatureLevel(creature, gameSystem);
      if (level !== undefined) formatted.challengeRating = level;

      const creatureType = getCreatureType(creature, gameSystem);
      if (creatureType && typeof creatureType === 'string') {
        formatted.creatureType = creatureType;
      }

      const size = system.traits?.size?.value || system.traits?.size || system.size || 'medium';
      formatted.size = size;

      const hasSpells = hasSpellcasting(creature, gameSystem);
      const hasLegendary = !!(
        system.resources?.legact ||
        system.legendary ||
        (system.resources?.legres && system.resources.legres.value > 0)
      );
      const typeStr = typeof creatureType === 'string' ? creatureType.toLowerCase() : '';
      formatted.flags = {
        spellcaster: hasSpells,
        legendary: hasLegendary,
        undead: typeStr === 'undead',
        dragon: typeStr === 'dragon',
        fiend: typeStr === 'fiend',
      };
    } else {
      // Legacy fallback (D&D 5e assumptions)
      const challengeRating = creature.challengeRating ?? system.details?.cr ?? system.cr ?? 0;
      const creatureType =
        creature.creatureType ?? system.details?.type?.value ?? system.type?.value ?? 'unknown';
      const size = creature.size ?? system.traits?.size ?? system.size ?? 'medium';

      const hasSpells =
        creature.hasSpells ??
        !!(
          system.spells ||
          system.attributes?.spellcasting ||
          (system.details?.spellLevel && system.details.spellLevel > 0)
        );
      const hasLegendary =
        creature.hasLegendaryActions ??
        !!(
          system.resources?.legact ||
          system.legendary ||
          (system.resources?.legres && system.resources.legres.value > 0)
        );

      formatted.challengeRating = challengeRating;
      formatted.creatureType = creatureType;
      formatted.size = size;
      formatted.flags = {
        spellcaster: hasSpells,
        legendary: hasLegendary,
        undead: creatureType.toLowerCase() === 'undead',
        dragon: creatureType.toLowerCase() === 'dragon',
        fiend: creatureType.toLowerCase() === 'fiend',
      };
    }

    return formatted;
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
