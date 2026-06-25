import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { ErrorHandler, FormattedToolError } from '../../utils/error-handler.js';
import { assertDnd5e } from '../../utils/system-detection.js';
import { toInputSchema } from '../../utils/schema.js';

/**
 * manage-activity — add / edit / remove / list dnd5e Activities (the rollable things on an item:
 * attack, damage, save, heal, check, utility, cast) on an item embedded on an actor OR a world item.
 * This is what authors a Multiattack (a feat with a utility activity), a heal/check activity, or a
 * `cast` activity that LINKS a real compendium spell (a wand/staff that casts Fireball, pulling the
 * spell's measured template + save/attack for free — the page resolves & validates the spellUuid).
 * The page layer (manageActivity) + the shared buildActivity own the activity shapes; this tool is
 * the friendly surface. Authoring only — it edits document data, it does not run combat.
 */

const ABILITY = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);
const damagePart = z.object({
  number: z.number().int().min(1).describe('Number of dice (e.g. 2).'),
  denomination: z.literal([4, 6, 8, 10, 12, 20, 100]).describe('Die size.'),
  type: z.string().min(1).describe('Damage type (e.g. "fire", "slashing").'),
});

const ManageActivitySchema = z.object({
  action: z
    .enum(['add', 'edit', 'remove', 'list'])
    .describe(
      'add a new activity, edit/remove an existing one (by activityId), or list activities.'
    ),
  itemIdentifier: z
    .string()
    .min(1)
    .describe(
      'Item to operate on (id or name). On an actor when actorIdentifier is set, else a world item.'
    ),
  actorIdentifier: z
    .string()
    .optional()
    .describe('If set, the item is embedded on this actor; omit to target a world (sidebar) item.'),
  activityId: z
    .string()
    .optional()
    .describe(
      'Activity id — required for edit/remove. Get it from action "list" or get-actor-entity.'
    ),

  // add — activity definition
  type: z
    .enum(['attack', 'damage', 'save', 'heal', 'check', 'utility', 'cast'])
    .optional()
    .describe(
      'Activity type. Required for add. "utility" = descriptive action (e.g. Multiattack). ' +
        '"cast" = link & cast a real compendium spell (e.g. a wand/staff) — see spellUuid.'
    ),
  name: z
    .string()
    .optional()
    .describe('Activity name (e.g. "Multiattack"). Used by add and edit (rename).'),
  activationType: z
    .enum(['action', 'bonus', 'reaction', 'legendary', 'lair', 'special'])
    .optional()
    .describe('Action economy. Default "action".'),
  damageParts: z
    .array(damagePart)
    .optional()
    .describe('Damage dice — for attack (extra parts), damage, and save activities.'),
  // attack
  attackType: z.enum(['melee', 'ranged']).optional().describe('Attack activity: melee or ranged.'),
  attackBonus: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe(
      'Attack activity: flat to-hit bonus. Cast activity: pins a FIXED spell-attack ' +
        'bonus (else the cast defers the attack to the casting actor).'
    ),
  ability: ABILITY.optional().describe('Attack ability override (attack activity).'),
  includeBase: z
    .boolean()
    .optional()
    .describe('Attack: also roll the item base damage (default true).'),
  // save
  saveAbility: ABILITY.optional().describe('Save activity: the saving-throw ability.'),
  saveDC: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe(
      'Save activity: the DC. Cast activity: pins a FIXED save DC for the linked spell ' +
        '(else the cast defers the DC to the casting actor).'
    ),
  onSave: z
    .enum(['half', 'none'])
    .optional()
    .describe('Save activity: damage on a successful save.'),
  // heal
  healAmount: z
    .object({
      number: z.number().int().min(1),
      denomination: z.literal([4, 6, 8, 10, 12, 20, 100]),
      type: z.enum(['healing', 'temphp']).optional(),
    })
    .optional()
    .describe('Heal activity: healing dice (type "healing" or "temphp").'),
  // check
  checkAbility: ABILITY.optional().describe('Check activity: the ability rolled.'),
  checkDC: z.number().int().min(1).max(30).optional().describe('Check activity: the DC.'),
  skills: z
    .array(z.string())
    .optional()
    .describe('Check activity: associated skill keys (e.g. ["acr","ath"]).'),

  // cast — link a real compendium spell (the activity casts it, pulling its template/save/attack)
  spellUuid: z
    .string()
    .optional()
    .describe(
      'Cast activity (REQUIRED): the Compendium uuid of the spell to LINK, e.g. ' +
        '"Compendium.dnd-players-handbook.spells.Item.phbsplFireball00". The activity CASTS this ' +
        'spell — its measured template (fireball sphere, lightning line…), save/attack, and effects ' +
        'come for free. The spell must be a real premium-book spell (off-book/SRD is refused — if it ' +
        'is not in the books, STOP and ASK; do not hand-roll a fake save/damage activity).'
    ),
  castLevel: z
    .number()
    .int()
    .min(0)
    .max(9)
    .optional()
    .describe("Cast activity: level to cast at (0 = cantrip). Defaults to the spell's base level."),
  charges: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Cast activity: item charges (uses) consumed per cast. Omit for an at-will cast.'),

  // edit
  patch: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      'Edit: dot-paths RELATIVE to the activity root, e.g. {"attack.bonus":"3"}, ' +
        '{"save.dc.formula":"16"}, {"damage.onSave":"half"}.'
    ),
});

export interface DnD5eManageActivityToolOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class DnD5eManageActivityTool {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: DnD5eManageActivityToolOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eManageActivityTool' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-activity',
        description:
          '[D&D 5e only] Add / edit / remove / list Activities on an item — the rollable things ' +
          '(attack, damage, save, heal, check, utility, cast). Target an item on an actor (set ' +
          'actorIdentifier) or a world item (omit it). This authors actions like a Multiattack ' +
          '(action="add", type="utility", name="Multiattack"), a heal, an ability-check, a ' +
          'saving-throw activity, OR a spell-casting item (action="add", type="cast", spellUuid=…, ' +
          'charges=…, saveDC/attackBonus=… to pin a fixed challenge) — the cast LINKS a real ' +
          'compendium spell so its measured template + save/attack fire for free. Use action="list" ' +
          '(or get-actor-entity) to find activityIds, then edit/remove by id; edit takes a `patch` of ' +
          'dot-paths relative to the activity. Authoring only — it does not run combat.',
        inputSchema: toInputSchema(ManageActivitySchema),
      },
    ];
  }

  async handleManageActivity(args: any): Promise<any> {
    try {
      const parsed = ManageActivitySchema.parse(args ?? {});

      // Cross-field guards: throw FormattedToolError so the message surfaces verbatim (the central
      // error mapper would otherwise flatten a plain Error to a generic "unexpected error").
      if (parsed.action === 'add') {
        if (!parsed.type) {
          throw new FormattedToolError(
            'action "add" requires `type` (attack/damage/save/heal/check/utility).'
          );
        }
        // Per-type required mechanics — without these the built activity would be malformed
        // (e.g. a save with no ability writes save.ability:[undefined]) or empty/useless.
        if (parsed.type === 'save' && (!parsed.saveAbility || parsed.saveDC === undefined)) {
          throw new FormattedToolError('activity type "save" requires saveAbility and saveDC.');
        }
        if (parsed.type === 'heal' && !parsed.healAmount) {
          throw new FormattedToolError('activity type "heal" requires healAmount.');
        }
        if (parsed.type === 'damage' && !parsed.damageParts?.length) {
          throw new FormattedToolError(
            'activity type "damage" requires at least one damageParts entry.'
          );
        }
        if (parsed.type === 'cast') {
          if (!parsed.spellUuid) {
            throw new FormattedToolError(
              'activity type "cast" requires `spellUuid` — the Compendium uuid of the spell to link ' +
                '(e.g. "Compendium.dnd-players-handbook.spells.Item.phbsplFireball00").'
            );
          }
          if (parsed.saveDC !== undefined && parsed.attackBonus !== undefined) {
            throw new FormattedToolError(
              'activity type "cast": provide saveDC OR attackBonus (a spell uses one challenge), not both.'
            );
          }
        }
      }
      if ((parsed.action === 'edit' || parsed.action === 'remove') && !parsed.activityId) {
        throw new FormattedToolError(`action "${parsed.action}" requires \`activityId\`.`);
      }

      await assertDnd5e(this.foundry, this.logger, 'manage-activity');

      const fwd: Record<string, any> = {
        action: parsed.action,
        itemIdentifier: parsed.itemIdentifier,
      };
      if (parsed.actorIdentifier) fwd.actorIdentifier = parsed.actorIdentifier;
      if (parsed.activityId) fwd.activityId = parsed.activityId;
      if (parsed.patch) fwd.patch = parsed.patch;
      // The page builder reads `activity.{type,name,...}` (and maps healAmount -> healing here).
      fwd.activity = {
        type: parsed.type,
        name: parsed.name,
        activationType: parsed.activationType,
        damageParts: parsed.damageParts,
        attackType: parsed.attackType,
        attackBonus: parsed.attackBonus,
        ability: parsed.ability,
        includeBase: parsed.includeBase,
        saveAbility: parsed.saveAbility,
        saveDC: parsed.saveDC,
        onSave: parsed.onSave,
        healing: parsed.healAmount,
        checkAbility: parsed.checkAbility,
        checkDC: parsed.checkDC,
        skills: parsed.skills,
        // cast — the page resolves spellUuid -> level default + V/S/M components + name
        spellUuid: parsed.spellUuid,
        level: parsed.castLevel,
        charges: parsed.charges,
      };

      this.logger.info('manage-activity', {
        action: parsed.action,
        itemIdentifier: parsed.itemIdentifier,
        type: parsed.type,
      });
      const result = await this.foundry.call('manageActivity', fwd);
      return this.formatResponse(result);
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'manage-activity', 'managing activity');
    }
  }

  private formatResponse(result: any): any {
    const where = result?.actor
      ? `${result.actor.name} → ${result.item?.name}`
      : result?.item?.name;
    let summary: string;
    if (result?.activities) {
      const list = result.activities
        .map((a: any) => `${a.type}${a.name ? ` "${a.name}"` : ''} (\`${a.id}\`)`)
        .join(', ');
      summary = `📋 ${where} activities: ${list || '(none)'}`;
    } else if (result?.action === 'add') {
      const spellNote = result.spell ? ` linking spell \`${result.spell}\`` : '';
      summary = `✅ Added ${result.type} activity${spellNote} to "${where}" (id: \`${result.activityId}\`)`;
    } else if (result?.action === 'edit') {
      summary = `✅ Edited activity \`${result.activityId}\` on "${where}" (${(result.editedKeys ?? []).join(', ')})`;
    } else {
      summary = `✅ Removed activity \`${result?.activityId}\` from "${where}"`;
    }
    return { summary, success: true, ...result, message: summary };
  }
}
