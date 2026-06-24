import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { ErrorHandler, FormattedToolError } from '../../utils/error-handler.js';
import { toInputSchema } from '../../utils/schema.js';

/**
 * manage-effect — create / edit / delete / list ActiveEffects on an actor OR an item (embedded on
 * an actor, or a world item). Effects carry top-level `changes[]` ({key, value, type}) that modify
 * the target's data (e.g. +1 AC, resist fire), plus disabled / transfer / statuses. Authoring only —
 * it sets effect DATA; it does not run combat (no duration tick-down). The page layer (manageEffect)
 * owns the v14 change shape (string `type`, `phase`) + parent resolution.
 */

const change = z.object({
  key: z
    .string()
    .min(1)
    .describe(
      'Data path to modify, e.g. "system.attributes.ac.bonus" or "system.traits.dr.value".'
    ),
  value: z.string().describe('The change value (stored as a string; e.g. "2", "fire").'),
  type: z
    .enum(['add', 'multiply', 'override', 'upgrade', 'downgrade', 'custom'])
    .default('add')
    .describe('How the value is applied. Default "add".'),
});

const ManageEffectSchema = z.object({
  action: z
    .enum(['create', 'edit', 'delete', 'list'])
    .describe('create a new effect, edit/delete one by effectId, or list effects.'),
  actorIdentifier: z
    .string()
    .optional()
    .describe('Actor that owns the effects (or owns the item when itemIdentifier is also set).'),
  itemIdentifier: z
    .string()
    .optional()
    .describe(
      'Item to target: embedded on the actor (with actorIdentifier) or a world item (alone). ' +
        'Omit to target the actor itself.'
    ),
  effectId: z
    .string()
    .optional()
    .describe('Effect id — required for edit/delete. Get it from action "list".'),

  // create/edit
  name: z.string().optional().describe('Effect name. Required (create); optional rename (edit).'),
  changes: z
    .array(change)
    .optional()
    .describe('The effect changes. On edit this REPLACES the whole changes list.'),
  disabled: z.boolean().optional().describe('Whether the effect is disabled (inactive).'),
  transfer: z
    .boolean()
    .optional()
    .describe(
      'Item effects: whether the effect transfers to the owning actor. Default true for items.'
    ),
  statuses: z
    .array(z.string())
    .optional()
    .describe('Status/condition ids this effect confers (e.g. ["prone"]).'),
  description: z.string().optional().describe('Effect description (HTML).'),

  // edit escape hatch
  patch: z
    .record(z.string(), z.any())
    .optional()
    .describe('Edit: extra dot-paths relative to the effect, e.g. {"duration.rounds": 10}.'),
});

export interface DnD5eManageEffectToolOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class DnD5eManageEffectTool {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: DnD5eManageEffectToolOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eManageEffectTool' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-effect',
        description:
          '[D&D 5e] Create / edit / delete / list ActiveEffects on an actor or an item. Effects carry ' +
          '`changes` ({key, value, type}) that modify the target — e.g. +1 AC ' +
          '({key:"system.attributes.ac.bonus", value:"1", type:"add"}) or resist fire. Target the actor ' +
          '(actorIdentifier), an embedded item (actorIdentifier + itemIdentifier), or a world item ' +
          '(itemIdentifier alone). Use action="list" to find effectIds. Item effects transfer to the ' +
          'owning actor by default. Authoring only — it sets effect data, it does not run combat.',
        inputSchema: toInputSchema(ManageEffectSchema),
      },
    ];
  }

  async handleManageEffect(args: any): Promise<any> {
    try {
      const parsed = ManageEffectSchema.parse(args ?? {});

      if (!parsed.actorIdentifier && !parsed.itemIdentifier) {
        throw new FormattedToolError('Provide actorIdentifier and/or itemIdentifier.');
      }
      if (parsed.action === 'create' && (!parsed.name || !parsed.changes?.length)) {
        throw new FormattedToolError(
          'action "create" requires `name` and at least one `changes` entry.'
        );
      }
      if ((parsed.action === 'edit' || parsed.action === 'delete') && !parsed.effectId) {
        throw new FormattedToolError(`action "${parsed.action}" requires \`effectId\`.`);
      }

      const fwd: Record<string, any> = { action: parsed.action };
      if (parsed.actorIdentifier) fwd.actorIdentifier = parsed.actorIdentifier;
      if (parsed.itemIdentifier) fwd.itemIdentifier = parsed.itemIdentifier;
      if (parsed.effectId) fwd.effectId = parsed.effectId;
      if (parsed.patch) fwd.patch = parsed.patch;
      fwd.effect = {
        name: parsed.name,
        changes: parsed.changes,
        disabled: parsed.disabled,
        transfer: parsed.transfer,
        statuses: parsed.statuses,
        description: parsed.description,
      };

      this.logger.info('manage-effect', { action: parsed.action, effectId: parsed.effectId });
      const result = await this.foundry.call('manageEffect', fwd);
      return this.formatResponse(result);
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'manage-effect', 'managing effect');
    }
  }

  private formatResponse(result: any): any {
    const where = result?.item
      ? result?.actor
        ? `${result.actor.name} → ${result.item.name}`
        : result.item.name
      : result?.actor?.name;
    let summary: string;
    if (result?.effects) {
      const list = result.effects
        .map((e: any) => `"${e.name}"${e.disabled ? ' (disabled)' : ''} (\`${e.id}\`)`)
        .join(', ');
      summary = `📋 ${where} effects: ${list || '(none)'}`;
    } else if (result?.action === 'create') {
      summary = `✅ Created effect "${result.name}" on "${where}" (id: \`${result.effectId}\`)`;
    } else if (result?.action === 'edit') {
      summary = `✅ Edited effect \`${result.effectId}\` on "${where}" (${(result.editedKeys ?? []).join(', ')})`;
    } else {
      summary = `✅ Deleted effect \`${result?.effectId}\` from "${where}"`;
    }
    return { summary, success: true, ...result, message: summary };
  }
}
