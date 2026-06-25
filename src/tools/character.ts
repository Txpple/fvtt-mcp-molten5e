import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';
import { extractActorStats, extractActorBasicInfo } from './dnd5e/actor-stats.js';

// Single source of truth for each tool's input contract: the handler parses with these
// schemas and getToolDefinitions() advertises toInputSchema(...) of the same schema.

const GetActorSchema = z.object({
  identifier: z
    .string()
    .min(1, 'Character identifier cannot be empty')
    .describe('Character name or ID to look up'),
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

const CreateItemSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1, 'Item name cannot be empty').describe('Display name of the item'),
        type: z
          .string()
          .min(1, 'Item type cannot be empty')
          .describe('dnd5e item type (e.g. "weapon", "equipment", "consumable", "feat", "spell")'),
        img: z.string().optional().describe('Optional icon path (e.g. "icons/svg/explosion.svg")'),
        system: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "System-specific data (free-form). Passed through to Foundry's DataModel layer."
          ),
        effects: z.array(z.record(z.string(), z.any())).optional(),
        flags: z.record(z.string(), z.any()).optional(),
      })
    )
    .min(1, 'At least one item is required')
    .describe(
      'One or more items to create. Each requires a name and a valid dnd5e item type (e.g. "weapon", "equipment", "consumable", "feat", "spell"). Pass system-specific data via the "system" field.'
    ),
  folder: z
    .string()
    .optional()
    .describe('Folder name/ID to place the items in (created if absent).'),
});

const ListItemsSchema = z.object({
  type: z
    .string()
    .optional()
    .describe('Filter by item type (e.g. "weapon", "spell"). Omit to return all types.'),
  folder: z.string().optional().describe('Filter to items inside this folder (name or ID).'),
  nameFilter: z.string().optional().describe('Case-insensitive substring match on item name.'),
});

const GetItemSchema = z.object({
  identifier: z
    .string()
    .min(1, 'Item identifier cannot be empty')
    .describe('World Item id (preferred) or name to look up.'),
});

const UpdateItemSchema = z.object({
  updates: z
    .array(
      z.object({
        id: z.string().min(1, 'Item id cannot be empty').describe('ID of the world Item to update'),
        name: z.string().optional().describe('New display name'),
        img: z.string().optional().describe('New icon path'),
        system: z
          .record(z.string(), z.any())
          .optional()
          .describe('System-specific fields to update (merged into existing system data)'),
        folder: z
          .string()
          .optional()
          .describe('Move item into this folder (name or ID). Created if absent.'),
      })
    )
    .min(1, 'At least one update entry is required')
    .describe(
      'One or more item patches. Each entry must include "id" plus at least one field to change (name, img, system, folder).'
    ),
});

const DeleteItemSchema = z.object({
  identifiers: z
    .array(z.string().min(1))
    .min(1, 'At least one identifier is required')
    .describe('Exact ids (preferred) or exact names of world Items to delete.'),
});

const RemoveFromActorSchema = z
  .object({
    actorIdentifier: z
      .string()
      .min(1, 'Actor identifier cannot be empty')
      .describe('Actor name or ID to remove the items from.'),
    itemIds: z
      .array(z.string().min(1))
      .optional()
      .describe('Ids of items on the actor to delete (most reliable; get them from get-actor).'),
    itemNames: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Names of items on the actor to delete (case-insensitive). Combine with "type" to disambiguate.'
      ),
    type: z.string().optional().describe('Constrain itemNames to this item type.'),
  })
  .refine(v => (v.itemIds?.length ?? 0) + (v.itemNames?.length ?? 0) > 0, {
    message: 'Provide itemIds and/or itemNames identifying the items to remove',
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

export interface CharacterToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class CharacterTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: CharacterToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'CharacterTools' });
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
          'Retrieve D&D 5e character information optimized for minimal token usage. Returns: full stats (abilities, skills, saves, AC, HP), action names, active effects/conditions (name only), and ALL items with minimal metadata (name, type, equipped status, attunement) without descriptions. Perfect for checking equipment or identifying what to investigate further. Use get-actor-entity to fetch full details for specific items, spells, or effects.',
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
        name: 'create-item',
        description:
          'Create world-level Item document(s) in the Items sidebar — reusable library items (weapons, equipment, consumables, feats, spells). For dnd5e prefer the 2024 data model; pass system-specific data via the "system" field. GM-only. To put items on an actor instead, copy from a compendium with import-item, author one with add-item, or attach raw item data with add-feature (mode "items").',
        inputSchema: toInputSchema(CreateItemSchema),
      },
      {
        name: 'list-items',
        description:
          'List world-level Item documents, optionally filtered by type, name substring, or folder.',
        inputSchema: toInputSchema(ListItemsSchema),
      },
      {
        name: 'get-item',
        description:
          'Retrieve a single world-level Item document with its full system data, embedded effects, flags, and flattened description. Resolves by id (most reliable), exact name, or case-insensitive name. Use list-items first to find ids.',
        inputSchema: toInputSchema(GetItemSchema),
      },
      {
        name: 'update-item',
        description:
          'Update existing world-level Item(s) by id — change name, img, system data, or folder. GM-only.',
        inputSchema: toInputSchema(UpdateItemSchema),
      },
      {
        name: 'delete-item',
        description:
          'Permanently delete one or more world-level Item documents (Items sidebar) by exact id or exact name. STRICT resolution — no fuzzy/substring matching, so it never deletes the wrong item. GM-only. To remove an item embedded on an actor instead, use remove-from-actor.',
        inputSchema: toInputSchema(DeleteItemSchema),
      },
      {
        name: 'remove-from-actor',
        description:
          'Delete items already on an actor, identified by itemIds and/or itemNames (optionally constrained by type). GM-only. Use get-actor to find item ids.',
        inputSchema: toInputSchema(RemoveFromActorSchema),
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

  async handleAddActorItems(args: any): Promise<any> {
    const itemSchema = z.object({
      name: z.string().min(1, 'Item name cannot be empty'),
      type: z.string().min(1, 'Item type cannot be empty'),
      img: z.string().optional(),
      system: z.record(z.string(), z.any()).optional(),
    });

    const schema = z.object({
      actorIdentifier: z.string().min(1, 'Actor identifier cannot be empty'),
      items: z.array(itemSchema).min(1, 'At least one item is required'),
    });

    const { actorIdentifier, items } = schema.parse(args);

    this.logger.info('Adding items to actor', {
      actorIdentifier,
      count: items.length,
      types: items.map(i => i.type),
    });

    try {
      const result = await this.foundry.call('addActorItems', {
        actorIdentifier,
        items,
      });

      this.logger.debug('Successfully added actor items', {
        actorName: result.actorName,
        created: result.created?.length ?? 0,
      });

      return result;
    } catch (error) {
      this.logger.error('Failed to add actor items', error);
      throw new Error(
        `Failed to add items to "${actorIdentifier}": ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleUpdateWorldItems(args: any): Promise<any> {
    const { updates } = UpdateItemSchema.parse(args);

    this.logger.info('Updating world items', {
      count: updates.length,
      ids: updates.map(u => u.id),
    });

    try {
      const result = await this.foundry.call('updateWorldItems', {
        updates,
      });

      this.logger.debug('Successfully updated world items', { count: result.updated?.length ?? 0 });

      return result;
    } catch (error) {
      this.logger.error('Failed to update world items', error);
      throw new Error(
        `Failed to update world items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleListWorldItems(args: any): Promise<any> {
    const { type, folder, nameFilter } = ListItemsSchema.parse(args);

    this.logger.info('Listing world items', {
      type: type ?? null,
      folder: folder ?? null,
      nameFilter: nameFilter ?? null,
    });

    try {
      const items = await this.foundry.call('listWorldItems', {
        ...(type !== undefined ? { type } : {}),
        ...(folder !== undefined ? { folder } : {}),
        ...(nameFilter !== undefined ? { nameFilter } : {}),
      });

      this.logger.debug('Successfully listed world items', { count: items?.length ?? 0 });

      return {
        items: items ?? [],
        total: items?.length ?? 0,
      };
    } catch (error) {
      this.logger.error('Failed to list world items', error);
      throw new Error(
        `Failed to list world items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleCreateWorldItems(args: any): Promise<any> {
    const { items, folder } = CreateItemSchema.parse(args);

    this.logger.info('Creating world items', {
      count: items.length,
      folder: folder ?? null,
      types: items.map(i => i.type),
    });

    try {
      const result = await this.foundry.call('createWorldItems', {
        items,
        folder,
      });

      this.logger.debug('Successfully created world items', {
        folderId: result.folderId,
        created: result.created?.length ?? 0,
      });

      return result;
    } catch (error) {
      this.logger.error('Failed to create world items', error);
      throw new Error(
        `Failed to create world items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleManageWorldItems(args: any): Promise<any> {
    const { action } = z
      .object({
        action: z.enum([
          'create',
          'list',
          'get',
          'update',
          'delete',
          'add-to-actor',
          'remove-from-actor',
        ]),
      })
      .parse(args);

    switch (action) {
      case 'create':
        return this.handleCreateWorldItems(args);
      case 'list':
        return this.handleListWorldItems(args);
      case 'get':
        return this.handleGetWorldItem(args);
      case 'update':
        return this.handleUpdateWorldItems(args);
      case 'delete':
        return this.handleDeleteWorldItems(args);
      case 'add-to-actor':
        return this.handleAddActorItems(args);
      case 'remove-from-actor':
        return this.handleRemoveActorItems(args);
    }
  }

  async handleGetWorldItem(args: any): Promise<any> {
    const { identifier } = GetItemSchema.parse(args);

    this.logger.info('Getting world item', { identifier });

    try {
      const item = await this.foundry.call('getWorldItem', {
        identifier,
      });

      this.logger.debug('Successfully retrieved world item', { id: item?.id, name: item?.name });

      return item;
    } catch (error) {
      this.logger.error('Failed to get world item', error);
      throw new Error(
        `Failed to get world item "${identifier}": ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleDeleteWorldItems(args: any): Promise<any> {
    const { identifiers } = DeleteItemSchema.parse(args);

    this.logger.info('Deleting world items', { count: identifiers.length });

    try {
      const result = await this.foundry.call('deleteWorldItems', {
        identifiers,
      });

      this.logger.debug('Successfully deleted world items', {
        deleted: result?.deletedCount ?? 0,
      });

      return result;
    } catch (error) {
      this.logger.error('Failed to delete world items', error);
      throw new Error(
        `Failed to delete world items: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleRemoveActorItems(args: any): Promise<any> {
    const { actorIdentifier, itemIds, itemNames, type } = RemoveFromActorSchema.parse(args);

    this.logger.info('Removing items from actor', {
      actorIdentifier,
      ids: itemIds?.length ?? 0,
      names: itemNames?.length ?? 0,
      type: type ?? null,
    });

    try {
      const result = await this.foundry.call('removeActorItems', {
        actorIdentifier,
        ...(itemIds !== undefined ? { itemIds } : {}),
        ...(itemNames !== undefined ? { itemNames } : {}),
        ...(type !== undefined ? { type } : {}),
      });

      this.logger.debug('Successfully removed actor items', {
        actorName: result.actorName,
        removed: result.removed?.length ?? 0,
      });

      return result;
    } catch (error) {
      this.logger.error('Failed to remove actor items', error);
      throw new Error(
        `Failed to remove items from "${actorIdentifier}": ${error instanceof Error ? error.message : 'Unknown error'}`
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
