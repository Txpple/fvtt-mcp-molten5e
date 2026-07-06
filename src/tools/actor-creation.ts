import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';
import { toInputSchema } from '../utils/schema.js';
import { assertNoSrdPacks } from '../utils/compendium-sources.js';
import { formatUnresolvedScale } from '../utils/format.js';

export interface ActorCreationToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

// Single source of truth for each tool's input contract: the handlers parse with these schemas
// and getToolDefinitions() advertises toInputSchema(...) of the same schema, so the advertised
// and enforced contracts cannot drift.

// create-actor-from-compendium contract (the §6 step-1 + step-2 path): packId/itemId/names ARE
// required because this serves ONLY the compendium-pull path. Single source of truth: the handler
// parses with it and getToolDefinitions() advertises toInputSchema(...) of it.
const CreateActorFromCompendiumSchema = z.object({
  packId: z
    .string()
    .min(1, 'Pack ID cannot be empty')
    .describe(
      'ID of the premium-book pack containing the creature (e.g., "dnd-monster-manual.actors"). ' +
        'Premium MM/PHB/DMG only — never the dnd5e.* SRD (design.md §2.3).'
    ),
  itemId: z
    .string()
    .min(1, 'Item ID cannot be empty')
    .describe(
      'ID of the specific creature entry within the pack (get this from search-compendium results)'
    ),
  names: z
    .array(z.string().min(1))
    .min(1, 'At least one name is required')
    .describe('Custom names for the created actors (e.g., ["Flameheart", "Sneak", "Peek"])'),
  quantity: z
    .number()
    .min(1)
    .max(10)
    .optional()
    .describe('Number of actors to create (default: based on names array length)'),
  folder: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Actor folder to file the created copies under — a folder id or exact name (created if ' +
        'absent), so the actor lands in its folder in ONE call instead of create + move-documents. ' +
        'Omit for the default "Foundry MCP Creatures" folder.'
    ),
  addToScene: z
    .boolean()
    .default(false)
    .describe('Whether to add created actors to the current scene as tokens'),
  placement: z
    .object({
      type: z
        .enum(['random', 'grid', 'center', 'coordinates'])
        .default('grid')
        .describe('Placement strategy'),
      coordinates: z
        .array(
          z.object({
            x: z.number().describe('X coordinate in pixels'),
            y: z.number().describe('Y coordinate in pixels'),
          })
        )
        .optional()
        .describe('Specific coordinates for each token (required when type is "coordinates")'),
    })
    .optional()
    .describe('Token placement options (only used when addToScene is true)'),
  disposition: z
    .enum(['friendly', 'neutral', 'hostile', 'secret'])
    .optional()
    .describe(
      'Prototype-token disposition for the created copies — YOUR judgment call (shared ' +
        "authoring-policy house token rules): 'neutral' for civilians/townsfolk/bystanders, " +
        "'friendly' for allies, 'hostile' for enemies. Omit to default by source type (copied PC " +
        'pregen → friendly, copied monster → hostile).'
    ),
  modifications: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      'PREFAB-AS-BASE bridge: stat edits to layer onto the instantiated WORLD COPY — copy a ' +
        'close-matching Monster Manual creature, then customize it in one call (the §6 step-2 path). ' +
        'Same shape as update-actor, e.g. {cr, hp:{value,max,formula}, ac:{calc,flat}, ' +
        'abilities:{str,…}, skills:[{skill,proficiency}], damageResistances:{values}, biography, ' +
        'currency:{mode,gp,…}}. Applied to the copy ONLY — the source compendium entry is never ' +
        'modified. Use names[] for the name, not this. Applies to every copy when quantity > 1.'
    ),
});

const DeleteActorSchema = z.object({
  identifiers: z
    .array(z.string().min(1))
    .min(1, 'At least one actor identifier is required')
    .describe(
      'Exact actor names or IDs to delete (e.g., ["ZZ MCP Smoke Test NPC"] or ["5GRD8GE7GJUWEbB2"])'
    ),
  removeEmptyFolder: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), also delete a bridge-created folder left completely empty by this deletion. Only ever removes mcp-generated, empty folders — never a user folder or one with remaining contents.'
    ),
});

const DeleteFolderSchema = z.object({
  identifier: z
    .string()
    .min(1, 'Folder identifier cannot be empty')
    .describe('Exact folder name or ID to delete (e.g., "Foundry MCP Creatures")'),
  type: z
    .string()
    .min(1)
    .default('Actor')
    .describe(
      'Folder document type (default "Actor"). E.g. "Actor", "Item", "JournalEntry", "Scene".'
    ),
  deleteContents: z
    .boolean()
    .default(false)
    .describe(
      'When true, delete the folder and all documents/subfolders inside it. When false (default), only delete the folder if it is already empty.'
    ),
});

export class ActorCreationTools {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: ActorCreationToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'ActorCreationTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  /**
   * Tool definitions for actor creation operations
   */
  getToolDefinitions() {
    return [
      {
        name: 'create-actor-from-compendium',
        description:
          'Copy one or more actors from a premium-book compendium pack — the DEFAULT, preferred path ' +
          'for official content (e.g. pull the Owlbear from the Monster Manual). Find the entry with ' +
          'search-compendium / get-compendium-entry, then pass its packId + itemId plus names[] for ' +
          'the new actors. PREFAB-AS-BASE (the §6 step-2 bridge): to make a CUSTOM creature, copy the ' +
          'closest Monster Manual match and pass `modifications` (update-actor-shaped stat edits — ' +
          'cr/hp/ac/abilities/skills/defenses/biography/currency) to layer onto the world copy in the ' +
          'SAME call; the edits land on the copy only, never the source entry. Pass `folder` (id or ' +
          'exact name, created if absent) to file the copies directly — no move-documents follow-up. ' +
          'For a fully hand-authored NPC with no compendium base, use author-npc (last resort).',
        inputSchema: toInputSchema(CreateActorFromCompendiumSchema),
      },
      {
        name: 'delete-actor',
        description:
          'Permanently delete one or more world actors (NPCs/characters) by exact name or ID. ' +
          'IRREVERSIBLE — Foundry has no undo for document deletion; the actor is removed from the world directory. ' +
          'GM-only. Resolution is STRICT (exact id or exact name — no fuzzy matching), so look up the precise ' +
          'name/ID with list-actors first. If the deletion empties a folder the bridge itself created (e.g. ' +
          '"Foundry MCP Creatures"), that folder is auto-removed unless removeEmptyFolder is false.',
        inputSchema: toInputSchema(DeleteActorSchema),
      },
      {
        name: 'delete-folder',
        description:
          'Permanently delete a folder by exact name or ID. GM-only, IRREVERSIBLE. By default refuses ' +
          'to delete a folder that still contains documents or subfolders (safe for cleaning up empty ' +
          'leftover folders). Pass deleteContents:true to delete the folder AND everything inside it. ' +
          'Defaults to Actor folders; set type for other document folders.',
        inputSchema: toInputSchema(DeleteFolderSchema),
      },
    ];
  }

  /**
   * Handle actor creation from specific compendium entry
   */
  async handleCreateActorFromCompendium(args: any): Promise<any> {
    const {
      packId,
      itemId,
      names,
      quantity,
      folder,
      addToScene,
      placement,
      modifications,
      disposition,
    } = CreateActorFromCompendiumSchema.parse(args);
    assertNoSrdPacks(packId, 'create-actor-from-compendium');
    const finalQuantity = quantity || names.length;

    this.logger.info('Creating actors from specific compendium entry', {
      packId,
      itemId,
      names,
      quantity: finalQuantity,
      addToScene,
    });

    try {
      // Ensure we have enough names for the quantity
      const customNames = [...names];
      while (customNames.length < finalQuantity) {
        const baseName = names[0] || 'Unnamed';
        customNames.push(`${baseName} ${customNames.length + 1}`);
      }

      // Create the actors page-side (foundry.call) using exact pack/item IDs
      const result = await this.foundry.call('createActorFromCompendium', {
        packId,
        itemId,
        customNames: customNames.slice(0, finalQuantity),
        quantity: finalQuantity,
        addToScene,
        placement: placement
          ? {
              type: placement.type,
              coordinates: placement.coordinates,
            }
          : undefined,
        // Prefab-as-base: layer these edits onto the world copy (never the compendium source).
        ...(modifications ? { modifications } : {}),
        ...(disposition ? { disposition } : {}),
        ...(folder ? { folder } : {}),
      });

      this.logger.info('Actor creation completed', {
        totalCreated: result.totalCreated,
        totalRequested: result.totalRequested,
        tokensPlaced: result.tokensPlaced || 0,
        hasErrors: !!result.errors,
      });

      // Format response for Claude
      return this.formatSimpleActorCreationResponse(
        result,
        packId,
        itemId,
        customNames.slice(0, finalQuantity)
      );
    } catch (error) {
      this.errorHandler.handleToolError(error, 'create-actor-from-compendium', 'actor creation');
    }
  }

  /**
   * Handle permanent deletion of one or more world actors
   */
  async handleDeleteActor(args: any): Promise<any> {
    const { identifiers, removeEmptyFolder } = DeleteActorSchema.parse(args);

    this.logger.info('Deleting actor(s)', { identifiers, removeEmptyFolder });

    try {
      const result = await this.foundry.call('deleteActor', {
        identifiers,
        removeEmptyFolder,
      });

      this.logger.info('Actor deletion completed', {
        deletedCount: result.deletedCount,
        notFound: result.notFound?.length || 0,
        removedFolders: result.removedFolders?.length || 0,
      });

      return this.formatDeleteActorResponse(result);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'delete-actor', 'actor deletion');
    }
  }

  /**
   * Format actor deletion response
   */
  private formatDeleteActorResponse(result: any): any {
    const count = result.deletedCount || 0;
    const summary = `🗑️ Deleted ${count} actor${count === 1 ? '' : 's'}`;

    const deletedList = (result.deleted || [])
      .map((actor: any) => `• **${actor.name}** (${actor.id})`)
      .join('\n');

    const notFoundInfo =
      result.notFound?.length > 0
        ? `\n⚠️ Not found (nothing deleted): ${result.notFound.join(', ')}`
        : '';

    const foldersInfo =
      result.removedFolders?.length > 0
        ? `\n📁 Also removed emptied folder(s): ${result.removedFolders.map((f: any) => f.name).join(', ')}`
        : '';

    return {
      summary,
      success: result.success,
      details: {
        deleted: result.deleted || [],
        notFound: result.notFound,
        removedFolders: result.removedFolders,
      },
      message: summary + (deletedList ? `\n\n${deletedList}` : '') + notFoundInfo + foldersInfo,
    };
  }

  /**
   * Handle permanent deletion of a folder
   */
  async handleDeleteFolder(args: any): Promise<any> {
    const { identifier, type, deleteContents } = DeleteFolderSchema.parse(args);

    this.logger.info('Deleting folder', { identifier, type, deleteContents });

    try {
      const result = await this.foundry.call('deleteFolder', {
        identifier,
        type,
        deleteContents,
      });

      this.logger.info('Folder deletion completed', {
        deleted: result.deleted,
        notFound: result.notFound || null,
        deletedContents: result.deletedContents || false,
      });

      return this.formatDeleteFolderResponse(result, identifier);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'delete-folder', 'folder deletion');
    }
  }

  /**
   * Format folder deletion response
   */
  private formatDeleteFolderResponse(result: any, identifier: string): any {
    if (!result.deleted) {
      const summary = `⚠️ Folder not found: ${result.notFound ?? identifier}`;
      return {
        summary,
        success: result.success,
        details: { deleted: false, notFound: result.notFound ?? identifier },
        message: summary,
      };
    }

    const f = result.folder || {};
    const summary = `🗑️ Deleted folder **${f.name}**`;
    const contentsInfo = result.deletedContents
      ? `\n⚠️ Also deleted ${result.removedDocuments} document(s) and ${result.removedSubfolders} subfolder(s) inside it`
      : '\n(was empty)';

    return {
      summary,
      success: result.success,
      details: {
        deleted: true,
        folder: f,
        deletedContents: result.deletedContents || false,
        removedDocuments: result.removedDocuments || 0,
        removedSubfolders: result.removedSubfolders || 0,
      },
      message: `${summary} (${f.id})${contentsInfo}`,
    };
  }

  /**
   * Format simplified actor creation response
   */
  private formatSimpleActorCreationResponse(
    result: any,
    packId: string,
    itemId: string,
    _customNames: string[]
  ): any {
    const summary = `✅ Created ${result.totalCreated} of ${result.totalRequested} requested actors`;

    const details = result.actors
      .map((actor: any) => `• **${actor.name}** (from ${packId})`)
      .join('\n');

    // Echo where the copies were filed (the page resolves/creates the folder and reports it back).
    const folderInfo = result.folder?.name ? `\n📁 Filed under **${result.folder.name}**` : '';

    const sceneInfo =
      result.tokensPlaced > 0
        ? `\n🎯 Added ${result.tokensPlaced} tokens to the current scene`
        : '';

    const errorInfo = result.errors?.length > 0 ? `\n⚠️ Issues: ${result.errors.join(', ')}` : '';

    // Prefab-as-base: report which stat edits were layered onto the world copy (same on every copy),
    // plus any soft-validation warnings update-actor raised. Confirms the bridge touched the COPY.
    const firstMod = (result.actors ?? []).find((a: any) => a.modifications)?.modifications;
    const modApplied: string[] = firstMod?.applied ?? [];
    const modWarnings: string[] = Array.from(
      new Set((result.actors ?? []).flatMap((a: any) => a.modifications?.warnings ?? []))
    );
    const modInfo =
      modApplied.length > 0
        ? `\n🔧 Layered onto the copy: ${modApplied.join(', ')}` +
          (modWarnings.length > 0 ? `\n⚠️ Modification warnings: ${modWarnings.join('; ')}` : '')
        : '';

    // A pure MM prefab copy is clean, but a humanoid built from PC class/racial features carries
    // @scale tokens that dangle on an NPC — the page reports them per created actor/item. Surface
    // them so the skill sets explicit dice on the world copy (the tool never picks the value).
    const unresolvedScale = (result.actors ?? []).flatMap((a: any) =>
      (a.unresolvedScale ?? []).map((t: any) => ({
        label: `${a.name} → ${t.itemName}`,
        path: t.path,
        formula: t.formula,
      }))
    );

    // Rule 7 — surface the copied creature's attack damage types. If the agent reskinned this base to
    // a new theme (a rename / modifications), it must SEE the off-theme damage and replace those
    // abilities with real ones — not reflavor in prose. The tool removes the "didn't notice" excuse.
    const damageTypes: string[] = Array.from(
      new Set<string>((result.actors ?? []).flatMap((a: any) => a.damageProfile?.damageTypes ?? []))
    ).sort();
    const damageInfo =
      damageTypes.length > 0
        ? `\n⚔️ Base attacks deal: **${damageTypes.join(', ')}**. If you reskinned this creature to a ` +
          'different theme, REPLACE each off-theme attack/ability with a real one of the new damage ' +
          'type (rule 7) — never reflavor it in prose.'
        : '';

    return {
      summary,
      success: result.success,
      details: {
        actors: result.actors,
        sourceEntry: {
          packId,
          itemId,
        },
        tokensPlaced: result.tokensPlaced || 0,
        errors: result.errors,
        ...(result.folder ? { folder: result.folder } : {}),
        ...(modApplied.length > 0
          ? { modifications: { applied: modApplied, warnings: modWarnings } }
          : {}),
        ...(damageTypes.length > 0 ? { damageTypes } : {}),
        ...(unresolvedScale.length > 0 ? { unresolvedScale } : {}),
      },
      message: `${summary}\n\n${details}${folderInfo}${modInfo}${sceneInfo}${errorInfo}${damageInfo}${formatUnresolvedScale(unresolvedScale)}`,
    };
  }
}
