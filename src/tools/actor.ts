import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';
import { extractActorStats, extractActorBasicInfo } from './dnd5e/actor-stats.js';

// ActorTools — read/inspect actors (the §5 actor building block, read side). Actor *creation* lives
// in ActorCreationTools + DnD5eNpcTools (create-actor-from-compendium / author-npc); world-Item CRUD
// and add/remove-from-actor live in ItemTools (src/tools/items.ts).
//
// Single source of truth for each tool's input contract: the handler parses with these schemas and
// getToolDefinitions() advertises toInputSchema(...) of the same schema, so the advertised and
// enforced contracts cannot drift.

const GetActorSchema = z.object({
  identifier: z
    .string()
    .min(1, 'Character identifier cannot be empty')
    .describe(
      'Character name or ID to look up. Also accepts a placed TOKEN id (from list-tokens) to read that ' +
        "token INSTANCE's live state — an unlinked NPC token can differ from its base actor."
    ),
});

const GetActorEntitySchema = z.object({
  characterIdentifier: z
    .string()
    .min(1, 'Character identifier cannot be empty')
    .describe('Character name or ID'),
  entityIdentifier: z
    .string()
    .min(1, 'Entity identifier cannot be empty')
    .describe('Entity name or ID (can be item ID, action name, spell name, or effect name)'),
});

const ListActorsSchema = z.object({
  type: z
    .string()
    .optional()
    .describe('Optional filter by character type (e.g., "character", "npc")'),
});

const SearchActorContentsSchema = z.object({
  characterIdentifier: z
    .string()
    .min(1, 'Character identifier cannot be empty')
    .describe('Character name or ID to search within'),
  query: z
    .string()
    .optional()
    .describe(
      'Text to search for in item names and descriptions (case-insensitive). Leave empty to return all items of specified type.'
    ),
  type: z
    .string()
    .optional()
    .describe(
      'Filter by item type: "spell", "weapon", "armor", "equipment", "consumable", "feat", "feature", "action", "effect", or system-specific types. Leave empty to search all types.'
    ),
  category: z
    .string()
    .optional()
    .describe(
      'Additional category filter. For spells: "cantrip", "prepared", "innate", "focus". For items: "equipped", "carried", "invested".'
    ),
  limit: z.number().optional().describe('Maximum number of results to return (default: 20)'),
});

export interface ActorToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class ActorTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: ActorToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'ActorTools' });
  }

  /**
   * Tool: get-actor
   * Retrieve detailed information about a specific character
   */
  getToolDefinitions() {
    return [
      {
        name: 'get-actor',
        description:
          'Retrieve D&D 5e character information optimized for minimal token usage. Returns: full stats (abilities, skills, saves, AC, HP, 2024 weapon-mastery kinds), action names, active effects/conditions (name only), and ALL items with minimal metadata (name, type, equipped status, attunement, weapon mastery property) without descriptions. Perfect for checking equipment or identifying what to investigate further. Use get-actor-entity to fetch full details for specific items, spells, or effects.',
        inputSchema: toInputSchema(GetActorSchema),
      },
      {
        name: 'get-actor-entity',
        description:
          'Retrieve full details for a specific entity from a character. Works for items (feats, equipment, spells), actions (strikes, special abilities), or effects/conditions. Returns complete description and all system data. Use this after get-actor when you need detailed information about a specific entity.',
        inputSchema: toInputSchema(GetActorEntitySchema),
      },
      {
        name: 'list-actors',
        description: 'List all available characters with basic information',
        inputSchema: toInputSchema(ListActorsSchema),
      },
      {
        name: 'search-actor-contents',
        description:
          "Search within a character's items, spells, actions, and effects. More token-efficient than get-actor when you need specific items. Supports text search (name/description) and type filtering. Returns matching items with full details including targeting info for spells. Use this to find specific spells, equipment, feats, or abilities without loading the entire character.",
        inputSchema: toInputSchema(SearchActorContentsSchema),
      },
    ];
  }

  async handleGetCharacter(args: any): Promise<any> {
    const { identifier } = GetActorSchema.parse(args);

    this.logger.info('Getting character information', { identifier });

    try {
      const characterData = await this.foundry.call('getCharacterInfo', {
        characterName: identifier,
      });

      this.logger.debug('Successfully retrieved character data', {
        characterId: characterData.id,
        characterName: characterData.name,
      });

      // Format the response for Claude
      return await this.formatCharacterResponse(characterData);
    } catch (error) {
      this.logger.error('Failed to get character information', error);
      throw new Error(
        `Failed to retrieve character "${identifier}": ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleGetCharacterEntity(args: any): Promise<any> {
    const { characterIdentifier, entityIdentifier } = GetActorEntitySchema.parse(args);

    this.logger.info('Getting character entity', { characterIdentifier, entityIdentifier });

    try {
      // First get the character
      const characterData = await this.foundry.call('getCharacterInfo', {
        characterName: characterIdentifier,
      });

      // Try to find the entity in different collections
      let entity = null;
      let entityType = null;

      // 1. Try to find as an item (by ID or name)
      entity = characterData.items?.find(
        (i: any) =>
          i.id === entityIdentifier || i.name.toLowerCase() === entityIdentifier.toLowerCase()
      );
      if (entity) {
        entityType = 'item';
      }

      // 2. Try to find as an action (by name)
      if (!entity && characterData.actions) {
        entity = characterData.actions.find(
          (a: any) => a.name.toLowerCase() === entityIdentifier.toLowerCase()
        );
        if (entity) {
          entityType = 'action';
        }
      }

      // 3. Try to find as an effect (by name)
      if (!entity && characterData.effects) {
        entity = characterData.effects.find(
          (e: any) => e.name.toLowerCase() === entityIdentifier.toLowerCase()
        );
        if (entity) {
          entityType = 'effect';
        }
      }

      if (!entity) {
        throw new Error(
          `Entity "${entityIdentifier}" not found on character "${characterIdentifier}". Tried items, actions, and effects.`
        );
      }

      this.logger.debug('Successfully retrieved entity', {
        entityType,
        entityName: entity.name,
      });

      // Return full entity details based on type
      if (entityType === 'item') {
        return {
          entityType: 'item',
          id: entity.id,
          name: entity.name,
          type: entity.type,
          description: entity.system?.description?.value || entity.system?.description || '',
          level: entity.system?.level, // dnd5e spell level (number); undefined for non-spells
          quantity: entity.system?.quantity ?? 1,
          equipped: entity.system?.equipped,
          attunement: entity.system?.attunement,
          hasImage: !!entity.img,
          // Full (source-sanitized) system data for advanced use cases.
          system: entity.system,
        };
      } else if (entityType === 'action') {
        return {
          entityType: 'action',
          name: entity.name,
          type: entity.type,
          itemId: entity.itemId,
          description: entity.description || 'Action from character strikes/abilities',
        };
      } else if (entityType === 'effect') {
        return {
          entityType: 'effect',
          id: entity.id,
          name: entity.name,
          description: entity.description || entity.name,
          duration: entity.duration,
          // Include full effect data
          ...entity,
        };
      }

      return entity;
    } catch (error) {
      this.logger.error('Failed to get character entity', error);
      throw new Error(
        `Failed to retrieve entity "${entityIdentifier}" from character "${characterIdentifier}": ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleListCharacters(args: any): Promise<any> {
    const { type } = ListActorsSchema.parse(args);

    this.logger.info('Listing characters', { type });

    try {
      const actors = await this.foundry.call('listActors', { type });

      this.logger.debug('Successfully retrieved character list', { count: actors.length });

      // Format the response for Claude
      return {
        characters: actors.map((actor: any) => ({
          id: actor.id,
          name: actor.name,
          type: actor.type,
          hasImage: !!actor.img,
        })),
        total: actors.length,
        filtered: type ? `Filtered by type: ${type}` : 'All characters',
      };
    } catch (error) {
      this.logger.error('Failed to list characters', error);
      throw new Error(
        `Failed to list characters: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleSearchCharacterItems(args: any): Promise<any> {
    const { characterIdentifier, query, type, category, limit } =
      SearchActorContentsSchema.parse(args);

    this.logger.info('Searching character items', {
      characterIdentifier,
      query,
      type,
      category,
      limit,
    });

    try {
      const result = await this.foundry.call('searchCharacterItems', {
        characterIdentifier,
        query,
        type,
        category,
        limit: limit ?? 20,
      });

      this.logger.debug('Successfully searched character items', {
        characterName: result.characterName,
        matchCount: result.matches?.length || 0,
      });

      return result;
    } catch (error) {
      this.logger.error('Failed to search character items', error);
      throw new Error(
        `Failed to search items for "${characterIdentifier}": ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async formatCharacterResponse(characterData: any): Promise<any> {
    const response: any = {
      id: characterData.id,
      name: characterData.name,
      type: characterData.type,
      basicInfo: extractActorBasicInfo(characterData),
      stats: extractActorStats(characterData),
      items: this.formatItems(characterData.items || []),
      effects: this.formatEffects(characterData.effects || []),
      hasImage: !!characterData.img,
    };

    // Add actions with minimal data (name, traits, action cost only - no variants)
    if (characterData.actions && characterData.actions.length > 0) {
      response.actions = this.formatActions(characterData.actions);
    }

    // Add spellcasting data with spell lists
    if (characterData.spellcasting && characterData.spellcasting.length > 0) {
      response.spellcasting = this.formatSpellcasting(characterData.spellcasting);
    }

    // Exclude itemVariants and itemToggles - these are verbose and can be fetched via get-actor-entity if needed

    return response;
  }

  private formatSpellcasting(spellcastingEntries: any[]): any[] {
    return spellcastingEntries.map(entry => {
      const formatted: any = {
        name: entry.name,
        type: entry.type,
      };

      // Spellcasting ability (dnd5e: int/wis/cha).
      if (entry.ability) {
        formatted.ability = entry.ability;
      }

      // Include spell slots if available
      if (entry.slots && Object.keys(entry.slots).length > 0) {
        formatted.slots = entry.slots;
      }

      // Format spells - minimal data for browsing, use get-actor-entity for full details
      if (entry.spells && entry.spells.length > 0) {
        formatted.spells = entry.spells.map((spell: any) => {
          const spellData: any = {
            id: spell.id,
            name: spell.name,
            level: spell.level,
          };

          // Only include prepared status if it's false (assumed prepared by default)
          if (spell.prepared === false) {
            spellData.prepared = false;
          }

          // Include action cost
          if (spell.actionCost) {
            spellData.actionCost = spell.actionCost;
          }

          // Include targeting info - helps Claude decide whether to specify targets
          if (spell.range) {
            spellData.range = spell.range;
          }
          if (spell.target) {
            spellData.target = spell.target;
          }
          if (spell.area) {
            spellData.area = spell.area;
          }

          return spellData;
        });

        formatted.spellCount = entry.spells.length;
      }

      return formatted;
    });
  }

  private formatActions(actions: any[]): any[] {
    // Return minimal action data - just enough to identify and filter
    return actions.map(action => {
      const formatted: any = {
        name: action.name,
        type: action.type,
      };

      // Include traits if present (for filtering, e.g., "fire" attacks, "concentrate" actions)
      if (action.traits && action.traits.length > 0) {
        formatted.traits = action.traits;
      }

      // Include action cost (e.g., 1, 2, 3 actions, reaction, free)
      if (action.actions !== undefined) {
        formatted.actionCost = action.actions;
      }

      // Include itemId for cross-referencing with items
      if (action.itemId) {
        formatted.itemId = action.itemId;
      }

      return formatted;
    });
  }

  private formatItems(items: any[]): any[] {
    // Return ALL items with minimal data
    return items.map(item => {
      // Return minimal data - just enough to identify and filter items
      const formattedItem: any = {
        id: item.id,
        name: item.name,
        type: item.type,
      };

      // Include quantity if present
      if (item.system?.quantity !== undefined && item.system.quantity !== 1) {
        formattedItem.quantity = item.system.quantity;
      }

      // Include level for dnd5e spells (a plain number).
      if (typeof item.system?.level === 'number') {
        formattedItem.level = item.system.level;
      }

      // Include equipped status for equippable items
      if (item.system?.equipped !== undefined) {
        formattedItem.equipped = item.system.equipped;
      }

      // Include attuned status for D&D 5e magic items
      if (item.system?.attunement !== undefined) {
        formattedItem.attunement = item.system.attunement;
      }

      // dnd5e 2024 weapons: the mastery property (vex/topple/graze/...) — whether the ACTOR can
      // use it is stats.weaponMasteries (the weapon-kind unlock); surfacing both makes mastery
      // questions a single get-actor call instead of a get-actor-entity per weapon.
      if (typeof item.system?.mastery === 'string' && item.system.mastery) {
        formattedItem.mastery = item.system.mastery;
      }

      return formattedItem;
    });
  }

  private formatEffects(effects: any[]): any[] {
    return effects.map(effect => ({
      id: effect.id,
      name: effect.name,
      disabled: effect.disabled,
      duration: effect.duration
        ? {
            type: effect.duration.type,
            remaining: effect.duration.remaining,
          }
        : null,
      hasIcon: !!effect.icon,
    }));
  }
}
