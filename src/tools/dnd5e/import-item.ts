import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { ErrorHandler, FormattedToolError } from '../../utils/error-handler.js';
import { assertDnd5e } from '../../utils/system-detection.js';
import { toInputSchema } from '../../utils/schema.js';
import { assertNoSrdPacks } from '../../utils/compendium-sources.js';
import { formatUnresolvedScale } from '../../utils/format.js';

/**
 * import-item — COPY a physical item from a compendium pack onto an actor (or into the world Items
 * sidebar), preserving its art, system data, and activities. This is the compendium-first counterpart
 * to add-item (which authors from scratch): the project policy is to grab the real PHB/DMG 2024 entry
 * and tweak it, rather than rebuild gear by hand. Find the packId + itemId with search-compendium /
 * get-compendium-entry first, then copy here; afterward refine the copy with update-actor-item,
 * manage-activity, or manage-effect (e.g. bump a base shield to +1 and rename it for a custom item).
 */
const ImportItemSchema = z.object({
  packId: z
    .string()
    .min(1, 'packId cannot be empty')
    .describe(
      'Compendium pack id holding the item (e.g. "dnd-players-handbook.equipment", ' +
        '"dnd-dungeon-masters-guide.equipment"). Premium MM/PHB/DMG books ONLY — never the dnd5e.* SRD (design.md §2.3). Find it with list-compendium-packs / search-compendium.'
    ),
  itemId: z
    .string()
    .min(1, 'itemId cannot be empty')
    .describe('Entry id within the pack (from search-compendium / get-compendium-entry results).'),
  actorIdentifier: z
    .string()
    .optional()
    .describe(
      'Target actor (name or id, partial match) to copy the item onto. Omit to copy into the world ' +
        'Items sidebar instead.'
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('Rename the copy (e.g. when adapting a base item into a custom magic item).'),
  quantity: z.number().int().min(0).optional().describe('Override the stack count on the copy.'),
  equipped: z
    .boolean()
    .optional()
    .describe('Set equipped state on the copy (equippable items only; ignored otherwise).'),
  identified: z
    .boolean()
    .optional()
    .describe('Set identified state (false = mystery/unidentified loot).'),
  container: z
    .string()
    .optional()
    .describe('Id or name of an EXISTING container on the same target to nest the copy inside.'),
  folder: z
    .string()
    .optional()
    .describe('When copying to the world (no actorIdentifier), place the item in this folder.'),
});

export interface DnD5eImportItemToolOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class DnD5eImportItemTool {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: DnD5eImportItemToolOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eImportItemTool' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'import-item',
        description:
          '[D&D 5e only] COPY an existing item from a compendium pack onto an actor (or into the world ' +
          'Items sidebar), keeping its artwork, full system data, and activities. PREFER THIS over ' +
          'add-item for any real piece of gear — a plain greatsword, a Potion of Healing, a +1 shield, ' +
          'a magic weapon: copying brings the correct PHB/DMG 2024 stats AND the graphic, where ' +
          'authoring from scratch does not.\n\n' +
          'WORKFLOW: 1) find the item with search-compendium (prefer the 2024 packs: ' +
          '"dnd-players-handbook.equipment", "dnd-dungeon-masters-guide.equipment" — premium books ONLY, never the dnd5e.* SRD); ' +
          '2) import-item with its packId + itemId; 3) for a CUSTOM item, copy the closest base then ' +
          'refine it with update-actor-item / manage-activity / manage-effect and rename via `name`.\n\n' +
          'Optional on-copy tweaks: name (rename), quantity, equipped, identified, container (nest in a ' +
          'bag/chest), folder (world target only). Target an actor with actorIdentifier, or omit it to ' +
          'build a reusable world Item. Use add-item only for genuine homebrew with no compendium base.',
        inputSchema: toInputSchema(ImportItemSchema),
      },
    ];
  }

  async handleImportItem(args: any): Promise<any> {
    try {
      const parsed = ImportItemSchema.parse(args ?? {});
      assertNoSrdPacks(parsed.packId, 'import-item');
      await assertDnd5e(this.foundry, this.logger, 'import-item');

      this.logger.info('Copying item from compendium', {
        packId: parsed.packId,
        itemId: parsed.itemId,
        target: parsed.actorIdentifier ?? 'world',
        rename: parsed.name,
      });

      const result = await this.foundry.call('importItemFromCompendium', parsed);
      return this.formatResponse(result);
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'import-item', 'item import');
    }
  }

  private formatResponse(result: any): any {
    const item = result?.item ?? {};
    const src = result?.source ?? {};
    const target =
      result?.target?.type === 'actor'
        ? `actor "${result.target.name}"`
        : `world Items${result?.target?.folderName ? ` (folder "${result.target.folderName}")` : ''}`;
    const renamed = src.name && item.name && src.name !== item.name ? ` (from "${src.name}")` : '';
    const summary = `✅ Copied "${item.name ?? '?'}"${renamed} onto ${target}`;
    const details = [
      `**Item:** ${item.name ?? '?'} (id: \`${item.id ?? '?'}\`, type: ${item.type ?? '?'})`,
      `**Source:** \`${src.packId ?? '?'}\` / \`${src.itemId ?? '?'}\``,
      `**Target:** ${target}`,
    ].join('\n');
    // The page reports any unresolved @scale tokens the copy carries (rare for gear, but a magic-item
    // feature rider can); surface them so the skill sets the die.
    const unresolvedScale = (result?.unresolvedScale ?? []).map((t: any) => ({
      label: item.name ?? '?',
      path: t.path,
      formula: t.formula,
    }));
    return {
      summary,
      success: true,
      item,
      source: result?.source,
      target: result?.target,
      ...(unresolvedScale.length > 0 ? { unresolvedScale } : {}),
      message: `${summary}\n\n${details}${formatUnresolvedScale(unresolvedScale)}`,
    };
  }
}
