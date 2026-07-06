import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { ErrorHandler, FormattedToolError } from '../../utils/error-handler.js';
import { toInputSchema } from '../../utils/schema.js';

/**
 * add-free-cast — wire a feature-granted "cast without a spell slot" onto the spell itself.
 *
 * House rule (owner, 2026-07-05): free casts granted by a feat/feature (Magic Initiate, Favored
 * Enemy, a lineage, a magic item…) live ON the spell entry in the Spells tab — a use pool on the
 * spell plus a `forward` activity consuming an item use — never as a separate Features-tab tracker
 * feat. The shape mirrors the premium PHB Hunter's Mark, which ships the pattern natively. The
 * forward activity is named `<Spell Name> - <granting feature>`.
 */

const AddFreeCastSchema = z.object({
  actorIdentifier: z
    .string()
    .min(1)
    .describe(
      'Name or id of the actor that owns the spell (partial name match supported). Also accepts a ' +
        "placed TOKEN id (from list-tokens): the edit then lands on that token INSTANCE's own delta."
    ),
  spellIdentifier: z
    .string()
    .min(1)
    .describe('Name or id of the embedded spell to grant the free cast on.'),
  grantedBy: z
    .string()
    .min(1)
    .describe(
      'The feature/feat that grants the free casting, e.g. "Magic Initiate" or "Favored Enemy". ' +
        'Becomes the activity name: "<Spell Name> - <grantedBy>".'
    ),
  uses: z
    .union([z.number().int().positive(), z.string().min(1)])
    .optional()
    .describe(
      'Free casts per recovery period. A number, or a formula string like ' +
        '"@scale.ranger.favored-enemy" for level-scaled pools. Default 1.'
    ),
  recoveryPeriod: z
    .enum(['lr', 'sr', 'day', 'dawn', 'dusk'])
    .optional()
    .describe(
      'When the free casts come back: "lr" long rest (default — the 2024 wording for feat-granted ' +
        'casts), "sr" short rest, "day", "dawn", or "dusk".'
    ),
  activityId: z
    .string()
    .optional()
    .describe(
      "Explicit cast activity id to forward to (from get-actor-entity). Default: the spell's " +
        'slot-consuming cast activity (lowest sort).'
    ),
});

export interface DnD5eFreeCastToolOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class DnD5eFreeCastTool {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: DnD5eFreeCastToolOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eFreeCastTool' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'add-free-cast',
        description:
          '[D&D 5e] Grant "cast without a spell slot, N per rest" ON a spell an actor already has — ' +
          'the way Magic Initiate, Favored Enemy, lineages, and similar features work. Adds a use ' +
          'pool to the spell plus a "<Spell> - <feature>" free-cast option in its Spells-tab row ' +
          "(the premium Hunter's Mark pattern). NEVER track a feature-granted free cast as a " +
          'separate feat item — use this tool on the spell instead. Idempotent: re-running updates ' +
          'the existing free-cast option in place.',
        inputSchema: toInputSchema(AddFreeCastSchema),
      },
    ];
  }

  async handleAddFreeCast(args: any): Promise<any> {
    try {
      const parsed = AddFreeCastSchema.parse(args ?? {});
      this.logger.info('Adding free cast to spell', {
        actorIdentifier: parsed.actorIdentifier,
        spellIdentifier: parsed.spellIdentifier,
        grantedBy: parsed.grantedBy,
      });

      const result = await this.foundry.call('addFreeCast', parsed);
      return this.formatResponse(result);
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'add-free-cast', 'adding free cast');
    }
  }

  private formatResponse(result: any): any {
    const warns: string[] = Array.isArray(result?.warnings) ? result.warnings : [];
    const verb = result?.activity?.reused ? 'Updated' : 'Added';
    const summary = `✅ ${verb} free cast "${result?.activity?.name}" on "${result?.actor?.name}" (${result?.uses?.max ?? '?'}/${result?.uses?.recovery?.[0]?.period ?? '?'})`;
    const details = [
      `**Actor:** ${result?.actor?.name} (id: \`${result?.actor?.id}\`)`,
      `**Spell:** ${result?.item?.name} (id: \`${result?.item?.id}\`)`,
      `**Free-cast activity:** ${result?.activity?.name} (id: \`${result?.activity?.id}\`, forwards to \`${result?.activity?.targetActivityId}\`)`,
      `**Uses:** ${result?.uses?.max} per ${result?.uses?.recovery?.[0]?.period ?? '?'}`,
    ].join('\n');
    const warningSection = warns.length
      ? `\n\n⚠️ ${warns.length} warning(s):\n${warns.map((w: string) => `- ${w}`).join('\n')}`
      : '';
    return {
      summary,
      success: true,
      actor: result?.actor,
      item: result?.item,
      activity: result?.activity,
      uses: result?.uses,
      ...(warns.length ? { warnings: warns } : {}),
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }
}
