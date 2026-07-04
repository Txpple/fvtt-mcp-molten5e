import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { ErrorHandler, FormattedToolError } from '../../utils/error-handler.js';
import { toInputSchema } from '../../utils/schema.js';

/**
 * update-actor-item — edit an item embedded on an actor (a weapon, feature, spell, piece of
 * equipment, ...). Generic dot-path editor: `patch` keys are Foundry data paths applied as-is, and
 * `deletePaths` remove keys (via the `-=` form). For authoring/editing activities specifically,
 * prefer manage-activity, which knows the activity shapes; this tool is the low-level escape hatch
 * for any item field. The page layer (updateActorItem) owns resolution + the deletion-key transform.
 */

const UpdateActorItemSchema = z.object({
  actorIdentifier: z
    .string()
    .min(1)
    .describe(
      'Name or id of the actor that owns the item (partial name match supported). Also accepts a placed ' +
        "TOKEN id (from list-tokens): the edit then lands on that token INSTANCE's own delta, not the base " +
        'actor — the way to re-gear ONE placed copy of an unlinked NPC (base-actor edits never reach ' +
        'tokens already on a scene).'
    ),
  itemIdentifier: z
    .string()
    .min(1)
    .describe('Name or id of the embedded item to edit (id, exact name, then substring).'),
  type: z
    .string()
    .optional()
    .describe('Optional item type to disambiguate the lookup (e.g. "weapon", "feat", "spell").'),
  name: z.string().min(1).optional().describe('Rename the item.'),
  img: z.string().optional().describe('Item image path or URL.'),
  patch: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      'Map of Foundry dot-path -> value, applied as-is. Examples: ' +
        '{"system.damage.base.number": 3}, {"system.damage.base.types": ["fire"]} (arrays REPLACE ' +
        'whole), {"system.activities.<id>.attack.bonus": "2"}, {"system.equipped": true}, ' +
        '{"system.description.value": "<p>...</p>"}.'
    ),
  deletePaths: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Dot-paths to delete from the item, e.g. "system.activities.<id>" to remove an activity. ' +
        'Converted to the Foundry "-=" deletion form for you.'
    ),
});

export interface DnD5eUpdateActorItemToolOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class DnD5eUpdateActorItemTool {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: DnD5eUpdateActorItemToolOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eUpdateActorItemTool' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'update-actor-item',
        description:
          '[D&D 5e] Edit an item embedded on an actor (weapon / feature / spell / equipment). ' +
          'Apply a dot-path `patch` (values applied as-is; arrays/Sets replace whole) and/or ' +
          '`deletePaths` (remove keys, e.g. an activity by id), and/or change name/img. This is the ' +
          'low-level item editor — to add/edit/remove activities (attacks, saves, heals, etc.) prefer ' +
          'manage-activity, which knows the shapes. Use get-actor or get-actor-entity to find the item ' +
          'and the exact paths/ids to change.',
        inputSchema: toInputSchema(UpdateActorItemSchema),
      },
    ];
  }

  async handleUpdateActorItem(args: any): Promise<any> {
    try {
      const parsed = UpdateActorItemSchema.parse(args ?? {});
      if (
        parsed.name === undefined &&
        parsed.img === undefined &&
        !parsed.patch &&
        !parsed.deletePaths
      ) {
        throw new Error('Provide at least one of: name, img, patch, deletePaths.');
      }
      this.logger.info('Updating embedded actor item', {
        actorIdentifier: parsed.actorIdentifier,
        itemIdentifier: parsed.itemIdentifier,
      });

      const result = await this.foundry.call('updateActorItem', parsed);
      return this.formatResponse(result);
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'update-actor-item', 'updating embedded item');
    }
  }

  private formatResponse(result: any): any {
    const keys: string[] = result?.appliedKeys ?? [];
    // Surface any bad-asset (broken-img) warnings the page layer reported (rule 8).
    const warns = Array.isArray(result?.warnings) ? result.warnings : [];
    const summary = `✅ Updated "${result?.item?.name}" on "${result?.actor?.name}" (${keys.length} change${keys.length === 1 ? '' : 's'})`;
    const details = [
      `**Actor:** ${result?.actor?.name} (id: \`${result?.actor?.id}\`)`,
      `**Item:** ${result?.item?.name} (id: \`${result?.item?.id}\`, type: ${result?.item?.type})`,
      `**Changed:** ${keys.join(', ') || '(none)'}`,
    ].join('\n');
    const warningSection = warns.length
      ? `\n\n⚠️ ${warns.length} warning(s):\n${warns.map((w: string) => `- ${w}`).join('\n')}`
      : '';
    return {
      summary,
      success: true,
      actor: result?.actor,
      item: result?.item,
      appliedKeys: keys,
      ...(warns.length ? { warnings: warns } : {}),
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }
}
