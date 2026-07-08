import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { assertDnd5e } from '../../utils/system-detection.js';
import { toInputSchema } from '../../utils/schema.js';

/**
 * update-actor — edit an EXISTING dnd5e actor's own stat-block fields (abilities, saves, skills,
 * HP/AC/init, movement, senses, defenses, languages, details/biography, NPC resources, 2024 habitat/
 * treasure). It does NOT touch embedded items (use update-actor-item / add-feature / manage-activity)
 * or run combat automation. The page layer (updateActor) owns correctness: field paths, NPC-only
 * gating, FormulaField string coercion, Set add/remove read-modify-write, and soft validation.
 */

const ABILITY = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);

// Reusable Set-field shape (damage/condition immunities, languages, treasure). Replace overwrites
// the whole list; add/remove merge against the actor's current list (page reads it live).
const setField = (what: string) =>
  z
    .object({
      mode: z
        .enum(['replace', 'add', 'remove'])
        .default('replace')
        .describe(
          'replace (default) overwrites the whole list; add/remove merge with the current list.'
        ),
      values: z.array(z.string()).default([]).describe(what),
      custom: z
        .string()
        .optional()
        .describe(
          'Free-text custom entry stored alongside the set (replaces the existing custom string).'
        ),
    })
    .optional();

const UpdateActorSchema = z.object({
  actorIdentifier: z
    .string()
    .min(1)
    .describe(
      'Name or id of the actor to edit (partial name match supported). Also accepts a placed TOKEN id ' +
        "(from list-tokens): the edit then lands on that token INSTANCE's own actor (its delta), not the " +
        'base actor — the way to edit ONE placed copy of an unlinked NPC, since base-actor edits never ' +
        'reach tokens already on a scene.'
    ),

  // identity
  name: z.string().min(1).optional().describe('Rename the actor.'),
  tokenName: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Prototype-token nameplate, decoupled from the actor name — e.g. actor "Morgash the Gravemaker" ' +
        'whose dropped tokens read just "Morgash". A plain `name` rename keeps the two in lockstep; ' +
        'pass tokenName (alone or alongside name) to make them differ. Placed tokens keep their own ' +
        'name — retitle those with update-token.'
    ),
  img: z.string().optional().describe('Portrait image path or URL.'),
  disposition: z
    .enum(['hostile', 'neutral', 'friendly', 'secret'])
    .optional()
    .describe(
      "Prototype-token disposition (friend vs foe). Set 'friendly' to mark an NPC an ally (e.g. a " +
        "freed captive), 'hostile' for an enemy, 'neutral' for a bystander."
    ),
  tokenAutoRotate: z
    .boolean()
    .optional()
    .describe(
      'Prototype-token auto-rotation: true = the token turns to face its movement ' +
        '(lockRotation off — the house default; new creations already get it), false = fixed facing.'
    ),
  tokenRing: z
    .boolean()
    .optional()
    .describe(
      'Prototype-token dynamic ring: false = plain token (the house default; new creations ' +
        'already get it), true = re-enable the ring (its colors/subject config is preserved).'
    ),
  tokenScale: z
    .number()
    .positive()
    .optional()
    .describe(
      'Prototype-token art scale — the "Scale (Ratio)" slider on the token Appearance tab ' +
        '(sets texture.scaleX and scaleY together). 1 = normal, 1.5 = 50% larger, 2 = double. ' +
        "Scales only the art within the token's grid footprint; it does NOT change the token's " +
        'size (grid spaces).'
    ),
  tokenRotation: z
    .number()
    .optional()
    .describe(
      'Prototype-token facing in degrees (0–359) — the default angle a dropped token faces. Same ' +
        'behavior as update-token for placed tokens: a lock-rotation prototype (tokenAutoRotate ' +
        'false) HIDES the angle, so setting a rotation without also setting tokenAutoRotate ' +
        'AUTO-UNLOCKS rotation (and warns) so the facing shows. (elevation / hidden / x / y are ' +
        'PLACEMENT-only — a prototype has no such fields; set those on a dropped token with update-token.)'
    ),

  // details (most NPC-only)
  size: z
    .enum(['tiny', 'small', 'sm', 'medium', 'med', 'large', 'lg', 'huge', 'gargantuan', 'grg'])
    .optional()
    .describe('Creature size (long name or short code).'),
  cr: z
    .number()
    .min(0)
    .max(30)
    .optional()
    .describe('[NPC] Challenge rating (0.125 / 0.25 / 0.5 allowed).'),
  creatureType: z
    .string()
    .optional()
    .describe(
      '[NPC] Creature type: aberration, beast, celestial, construct, dragon, elemental, fey, fiend, giant, humanoid, monstrosity, ooze, plant, undead.'
    ),
  creatureSubtype: z
    .string()
    .optional()
    .describe('[NPC] Creature subtype free text (e.g. "Devil").'),
  swarmSize: z
    .enum(['', 'tiny', 'sm', 'med', 'lg', 'huge', 'grg'])
    .optional()
    .describe('[NPC] Swarm member size, or "" if the creature is not a swarm.'),
  alignment: z.string().optional().describe('Alignment free text (e.g. "Lawful Evil").'),
  biography: z.string().optional().describe('Biography / description (HTML).'),
  source: z
    .object({
      book: z.string().optional(),
      page: z.string().optional(),
      rules: z.enum(['2014', '2024']).optional(),
    })
    .optional()
    .describe('Source metadata (book / page / rules edition).'),

  // abilities / saves / skills
  abilities: z
    .object({
      str: z.number().int().min(1).max(30).optional(),
      dex: z.number().int().min(1).max(30).optional(),
      con: z.number().int().min(1).max(30).optional(),
      int: z.number().int().min(1).max(30).optional(),
      wis: z.number().int().min(1).max(30).optional(),
      cha: z.number().int().min(1).max(30).optional(),
    })
    .optional()
    .describe('Ability scores to set — only the abilities you list change.'),
  savingThrows: z
    .array(ABILITY)
    .optional()
    .describe(
      'Replace the proficient saving throws: the listed abilities become proficient, all others non-proficient.'
    ),
  skills: z
    .array(
      z.object({
        skill: z.string().describe('Skill full name ("Perception") or key ("prc").'),
        proficiency: z
          .enum(['none', 'proficient', 'expert'])
          .describe('none clears proficiency; proficient = ×1; expert = ×2 (expertise).'),
      })
    )
    .optional()
    .describe('Set skill proficiencies — merge: only the listed skills change.'),
  weaponMasteries: z
    .object({
      mode: z
        .enum(['replace', 'add', 'remove'])
        .default('replace')
        .describe(
          'replace (default) overwrites the whole list; add/remove merge with the current list.'
        ),
      values: z
        .array(z.string())
        .default([])
        .describe(
          'Base weapon KINDS ("greatsword", "longbow", "handcrossbow", ...) — NOT mastery names: ' +
            'each weapon carries its own mastery property (vex/topple/graze/...), the actor just ' +
            'unlocks it per kind.'
        ),
    })
    .optional()
    .describe(
      '[PC] 2024 Weapon Mastery selections — the kinds of weapons whose mastery property the ' +
        'character can use (system.traits.weaponProf.mastery). Swappable on a Long Rest per the ' +
        "class feature; the count allowed is the class's business (fighter 3, paladin/ranger 2 at " +
        'low levels) — the tool does not enforce it.'
    ),

  // vitals
  hp: z
    .object({
      value: z.number().int().optional(),
      max: z.number().int().optional(),
      temp: z.number().int().optional(),
      tempmax: z.number().int().optional(),
      formula: z.string().optional(),
    })
    .optional()
    .describe('Hit points (value / max / temp / tempmax / formula).'),
  ac: z
    .object({
      calc: z
        .string()
        .optional()
        .describe('AC calculation: flat, natural, default, mage, draconic, unarmoredMonk, ...'),
      flat: z
        .number()
        .int()
        .optional()
        .describe('Flat AC value (used by calc "flat" / "natural").'),
      formula: z.string().optional(),
    })
    .optional()
    .describe('Armor class.'),
  initiative: z
    .object({
      bonus: z.number().optional(),
      ability: ABILITY.or(z.literal('')).optional(),
    })
    .optional()
    .describe('Initiative bonus and/or ability override.'),

  // movement / senses
  movement: z
    .object({
      walk: z.number().min(0).optional(),
      fly: z.number().min(0).optional(),
      swim: z.number().min(0).optional(),
      climb: z.number().min(0).optional(),
      burrow: z.number().min(0).optional(),
      units: z.string().optional(),
      hover: z.boolean().optional(),
    })
    .optional()
    .describe('Movement speeds (in the given units, default feet).'),
  senses: z
    .object({
      darkvision: z.number().min(0).optional(),
      blindsight: z.number().min(0).optional(),
      tremorsense: z.number().min(0).optional(),
      truesight: z.number().min(0).optional(),
      units: z.string().optional(),
      special: z.string().optional(),
    })
    .optional()
    .describe('Senses ranges (feet) plus special-sense free text.'),

  // defenses
  damageImmunities: setField('Damage types (acid, bludgeoning, cold, fire, ...).'),
  damageResistances: setField('Damage types (acid, bludgeoning, cold, fire, ...).'),
  damageVulnerabilities: setField('Damage types (acid, bludgeoning, cold, fire, ...).'),
  conditionImmunities: setField('Conditions (poisoned, charmed, frightened, ...).'),
  languages: setField('Languages (common, infernal, draconic, ...).'),
  telepathy: z
    .object({ value: z.number().int().min(0), units: z.string().default('ft') })
    .optional()
    .describe('Telepathy range (0 = none).'),

  // resources (NPC)
  legendaryActions: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('[NPC] Legendary action points per round (resources.legact.max).'),
  legendaryResistances: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('[NPC] Legendary resistance uses per day (resources.legres.max).'),
  lair: z
    .object({ initiative: z.number().int().optional() })
    .optional()
    .describe(
      '[NPC] Lair actions — sets the lair initiative count (marks the creature as having a lair).'
    ),

  // 2024 fields (NPC)
  habitat: z
    .array(z.object({ type: z.string(), subtype: z.string().optional() }))
    .optional()
    .describe(
      '[NPC, 2024] Habitats (replace the whole list), e.g. [{type:"forest"},{type:"planar",subtype:"nine hells"}].'
    ),
  treasure: setField('[NPC, 2024] Treasure themes (any, arcana, individual, ...).'),

  // currency (coins) — actor-level, applies to NPCs and PCs
  currency: z
    .object({
      mode: z
        .enum(['set', 'add'])
        .default('set')
        .describe(
          'set (default) overwrites each listed coin; add adjusts by the amount (negatives spend, clamped at 0).'
        ),
      pp: z.number().int().optional().describe('Platinum pieces.'),
      gp: z.number().int().optional().describe('Gold pieces.'),
      ep: z.number().int().optional().describe('Electrum pieces.'),
      sp: z.number().int().optional().describe('Silver pieces.'),
      cp: z.number().int().optional().describe('Copper pieces.'),
    })
    .optional()
    .describe('Carried coins (pp/gp/ep/sp/cp). Only the coins you list change.'),
});

export interface DnD5eUpdateActorToolOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class DnD5eUpdateActorTool {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: DnD5eUpdateActorToolOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eUpdateActorTool' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'update-actor',
        description:
          "[D&D 5e only] Edit an EXISTING actor's own stat-block fields. Supply only the groups you want to change:\n" +
          '• identity + prototype token — name, tokenName (prototype nameplate ≠ actor name), img, ' +
          'disposition (friend/foe), tokenAutoRotate ' +
          '(face movement / lockRotation), tokenRing (dynamic ring), tokenScale (art size), ' +
          'tokenRotation (facing) — the PROTOTYPE-token editor. (elevation / hidden / x / y are ' +
          'placement-only: edit those on a dropped token with update-token)\n' +
          '• details — size, cr*, creatureType*, creatureSubtype*, swarmSize*, alignment, biography, source\n' +
          '• abilities — abilities.{str..cha}, savingThrows (replace), skills (merge; proficiency none/proficient/expert)\n' +
          '• weaponMasteries [PC] — {mode: replace|add|remove, values: ["greatsword", ...]} — 2024 Weapon ' +
          'Mastery weapon KINDS (base weapon ids, not mastery names)\n' +
          '• vitals — hp, ac, initiative\n' +
          '• movement, senses\n' +
          '• defenses — damageImmunities / damageResistances / damageVulnerabilities / conditionImmunities / languages ' +
          '(each {mode: replace|add|remove, values, custom?}), telepathy\n' +
          '• resources* — legendaryActions, legendaryResistances, lair\n' +
          '• 2024* — habitat, treasure\n' +
          '• currency — coins {mode: set|add, pp, gp, ep, sp, cp} (carried money)\n\n' +
          'Fields marked * are NPC-only (skipped with a warning on player characters). This authors the ' +
          'stat block; it does NOT edit embedded items (use update-actor-item / add-feature / manage-activity) ' +
          'or run combat. Use list-actors or get-actor to find the actorIdentifier.',
        inputSchema: toInputSchema(UpdateActorSchema),
      },
    ];
  }

  async handleUpdateActor(args: any): Promise<any> {
    const parsed = UpdateActorSchema.parse(args ?? {});
    this.logger.info('Updating dnd5e actor', { actorIdentifier: parsed.actorIdentifier });

    await assertDnd5e(this.foundry, this.logger, 'update-actor');
    const result = await this.foundry.call('updateActor', parsed);

    this.logger.info('Actor updated', {
      actorId: result?.actor?.id,
      applied: result?.applied?.length,
      warnings: result?.warnings?.length,
    });
    return this.formatResponse(result);
  }

  private formatResponse(result: any): any {
    const applied: string[] = result?.applied ?? [];
    const warnings: string[] = result?.warnings ?? [];
    const summary = `✅ Updated "${result?.actor?.name}" — ${applied.length ? applied.join(', ') : 'no changes'}`;
    const details = [
      `**Actor:** ${result?.actor?.name} (id: \`${result?.actor?.id}\`, type: ${result?.actor?.type})`,
      `**Applied:** ${applied.length ? applied.join(', ') : '(none)'}`,
    ].join('\n');
    const warningSection =
      warnings.length > 0
        ? `\n\n⚠️ **Warnings (${warnings.length}):**\n${warnings.map(w => `- ${w}`).join('\n')}`
        : '';
    return {
      summary,
      success: true,
      actor: result?.actor,
      applied,
      warnings,
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }
}
