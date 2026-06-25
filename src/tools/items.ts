import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';

// ItemTools — the world-item building block as a first-class tool family (design.md §5: items are a
// content building block, not an actor sub-concern). It owns the whole world-Item lifecycle: CRUD on
// sidebar Items (create/list/get/update/delete) plus placing items on / removing them from an actor
// (add-to-actor / remove-from-actor). Actor reads/authoring live in ActorTools (src/tools/actor.ts);
// embedded-item editing has its own dnd5e tools (update-actor-item, manage-activity, manage-effect).
//
// Single source of truth for each tool's input contract: the handler parses with these schemas and
// getToolDefinitions() advertises toInputSchema(...) of the same schema, so the advertised and
// enforced contracts cannot drift.

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

// The item array for placing items on an actor. Exported because it is the CANONICAL source for
// add-feature's mode "items" too (composed by buildAddFeatureTool) — so the advertised add-feature
// contract is generated from the same zod this handler enforces, never a hand-written duplicate.
export const AddToActorItemsSchema = z
  .array(
    z.object({
      name: z.string().min(1, 'Item name cannot be empty').describe('Display name of the item'),
      type: z
        .string()
        .min(1, 'Item type cannot be empty')
        .describe('dnd5e item type (weapon, equipment, …)'),
      img: z.string().optional().describe('Optional icon path'),
      system: z.record(z.string(), z.any()).optional(),
    })
  )
  .min(1, 'At least one item is required');

// add-to-actor is reached via the handleManageWorldItems dispatcher (and add-feature mode "items"),
// not advertised as its own tool — so this is a parse-only contract.
const AddToActorSchema = z.object({
  actorIdentifier: z.string().min(1, 'Actor identifier cannot be empty'),
  items: AddToActorItemsSchema,
});

export interface ItemToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class ItemTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: ItemToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'ItemTools' });
  }

  getToolDefinitions() {
    return [
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
    ];
  }

  // Dispatcher: the six world-item tool names route through here (registry wires each to a
  // pre-stamped `action`); add-feature mode "items" reuses the 'add-to-actor' action.
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

  async handleAddActorItems(args: any): Promise<any> {
    const { actorIdentifier, items } = AddToActorSchema.parse(args);

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
}
