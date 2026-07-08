import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { assertDnd5e } from '../../utils/system-detection.js';
import { toInputSchema } from '../../utils/schema.js';

/**
 * add-free-cast — feature-granted "cast without a spell slot, N per rest", the native way.
 *
 * House rule (owner, 2026-07-05 — supersedes the earlier forward-on-the-spell shape): the sheet
 * gets TWO entries. The spell sits in the repertoire as a normal ALWAYS-PREPARED spell (castable
 * with slots, no pools, no dialogs), and the free cast is a `cast` activity ON the granting
 * feature — which projects a "<Spell> - <Feature>" entry into the sheet's NATIVE "Additional
 * Spells" spellbook section with its own tracked pool (default 1/long rest). The old shape (a use
 * pool + forward activity on the spell) is migrated off automatically.
 */

const AddFreeCastSchema = z.object({
  actorIdentifier: z
    .string()
    .min(1)
    .describe(
      'Name or id of the actor (partial name match supported). Also accepts a placed TOKEN id ' +
        "(from list-tokens): the edit then lands on that token INSTANCE's own delta."
    ),
  spellIdentifier: z
    .string()
    .min(1)
    .describe(
      'The spell to grant a free cast of — an embedded spell on the actor (name or id), or a ' +
        'premium compendium uuid ("Compendium.dnd-players-handbook.spells.Item.…") to also ADD it ' +
        'to the repertoire (always prepared) when the actor lacks it.'
    ),
  grantedBy: z
    .string()
    .min(1)
    .describe(
      'The granting feature ITEM on the actor (name or id) — e.g. "Magic Initiate", "Favored ' +
        'Enemy", a lineage feature. The cast activity lands ON this item and the Additional Spells ' +
        'entry is titled "<Spell> - <feature name>".'
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
});

export interface DnD5eFreeCastToolOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class DnD5eFreeCastTool {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: DnD5eFreeCastToolOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eFreeCastTool' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'add-free-cast',
        description:
          '[D&D 5e] Grant "cast without a spell slot, N per rest" the native 2024 way — Magic ' +
          'Initiate, Favored Enemy, lineage grants. TWO sheet entries result: the spell stays in ' +
          'the repertoire as a normal ALWAYS-PREPARED spell (castable with slots; imported from ' +
          'the compendium if missing), and a cast activity ON the granting feature projects a ' +
          '"<Spell> - <Feature>" entry into the sheet\'s native "Additional Spells" spellbook ' +
          'section with its own tracked pool (default 1/long rest) — no slot, no use-dialog. Also ' +
          'MIGRATES the old shape (on-spell use pool + forward activity) off the spell, and dedupes ' +
          "dnd5e's cached spellbook copies. Idempotent. NEVER track a free cast as a separate " +
          'tracker feat or as a forward on the spell.',
        inputSchema: toInputSchema(AddFreeCastSchema),
      },
    ];
  }

  async handleAddFreeCast(args: any): Promise<any> {
    const parsed = AddFreeCastSchema.parse(args ?? {});
    this.logger.info('Adding free cast', {
      actorIdentifier: parsed.actorIdentifier,
      spellIdentifier: parsed.spellIdentifier,
      grantedBy: parsed.grantedBy,
    });

    await assertDnd5e(this.foundry, this.logger, 'add-free-cast');
    const result = await this.foundry.call('addFreeCast', parsed);
    return this.formatResponse(result);
  }

  private formatResponse(result: any): any {
    const warns: string[] = Array.isArray(result?.warnings) ? result.warnings : [];
    const verb = result?.activity?.reused ? 'Updated' : 'Added';
    const period = result?.activity?.uses?.recovery?.[0]?.period ?? '?';
    const summary =
      `✅ ${verb} free cast "${result?.activity?.name}" on "${result?.actor?.name}" ` +
      `(${result?.activity?.uses?.max ?? '?'}/${period}, on feature "${result?.feature?.name}")`;
    const repertoire = result?.repertoire?.imported
      ? `imported to the repertoire (always prepared)`
      : result?.repertoire?.migrated
        ? `already in the repertoire — old free-cast shape migrated off`
        : `already in the repertoire (clean)`;
    const details = [
      `**Actor:** ${result?.actor?.name} (id: \`${result?.actor?.id}\`)`,
      `**Repertoire spell:** ${result?.repertoire?.name} (id: \`${result?.repertoire?.id}\`) — ${repertoire}`,
      `**Feature:** ${result?.feature?.name} (id: \`${result?.feature?.id}\`)`,
      `**Cast activity:** ${result?.activity?.name} (id: \`${result?.activity?.id}\`, ` +
        `${result?.activity?.uses?.max} per ${period}, ${result?.activity?.activationType})`,
      `**Additional Spells entry:** ${result?.additionalSpells?.name ?? '(mints on first use)'}` +
        (result?.additionalSpells?.cachedId
          ? ` (id: \`${result.additionalSpells.cachedId}\`)`
          : ''),
    ].join('\n');
    const warningSection = warns.length
      ? `\n\n⚠️ ${warns.length} warning(s):\n${warns.map((w: string) => `- ${w}`).join('\n')}`
      : '';
    return {
      summary,
      success: true,
      actor: result?.actor,
      feature: result?.feature,
      spell: result?.spell,
      repertoire: result?.repertoire,
      activity: result?.activity,
      additionalSpells: result?.additionalSpells,
      ...(warns.length ? { warnings: warns } : {}),
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }
}
