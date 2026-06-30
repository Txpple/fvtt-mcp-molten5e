import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { ErrorHandler } from '../../utils/error-handler.js';
import { assertDnd5e } from '../../utils/system-detection.js';
import { formatImportReport } from '../../utils/format.js';
import { toInputSchema } from '../../utils/schema.js';
import { DEFAULT_SPELL_PACKS, assertNoSrdPacks } from '../../utils/compendium-sources.js';
import { DAMAGE_TYPES, WEAPON_PROPERTIES } from '../../utils/dnd5e-canonical.js';

// ---------------------------------------------------------------------------
// Canonical value sets for soft validation (warnings, not errors)
// ---------------------------------------------------------------------------

// Canonical dnd5e enum sets for soft validation (warn, never block) — single-sourced in
// utils/dnd5e-canonical.ts so the damage/property sets can't drift across the authoring tools.
const DAMAGE_CANONICAL = DAMAGE_TYPES;
const ATTACK_PROPERTY_CANONICAL = WEAPON_PROPERTIES;

const CLASS_DEFAULT_ABILITY: Record<string, string> = {
  wizard: 'int',
  artificer: 'int',
  cleric: 'wis',
  druid: 'wis',
  ranger: 'wis',
  sorcerer: 'cha',
  warlock: 'cha',
  bard: 'cha',
  paladin: 'cha',
};

// ---------------------------------------------------------------------------
// Shared Zod building blocks
// ---------------------------------------------------------------------------

// Single source of truth for a damage component — used both by the per-mode enforcement schemas
// (handleSave/handleAttack/…) and, via the advertised umbrella schema, by getToolDefinitions().
// `z.literal([...])` enforces the same die-size set the old `.refine()` did and also renders as a
// JSON-Schema `enum`, so the advertised denomination list cannot drift from what is enforced.
const damagePart = z.object({
  number: z.number().int().min(1).describe('Number of dice (e.g. 4)'),
  denomination: z.literal([4, 6, 8, 10, 12, 20, 100]).describe('Die size'),
  type: z
    .string()
    .min(1, 'damage type cannot be empty')
    .describe('Damage type (e.g. "fire", "slashing", "cold")'),
});

// Canonical enum value sets — single-sourced so the umbrella schema (advertised) and the per-mode
// enforcement schemas reference the SAME literals and cannot drift apart (see the CAVEAT below).
const ABILITY_ENUM = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const ACTIVATION_ENUM = ['action', 'bonus', 'reaction', 'legendary', 'lair', 'special'] as const;
const WEAPON_CLASS_ENUM = ['natural', 'simpleM', 'martialM', 'simpleR', 'martialR'] as const;
const ATTACK_TYPE_ENUM = ['melee', 'ranged'] as const;
const AREA_SHAPE_ENUM = [
  'cone',
  'cube',
  'cylinder',
  'emanation',
  'line',
  'radius',
  'sphere',
] as const;
const AFFECTS_ENUM = ['creature', 'object', 'space', ''] as const;
const AREA_UNITS_ENUM = ['ft', 'm'] as const;
const SOURCE_RULES_ENUM = ['2014', '2024'] as const;
const SAVE_ON_SAVE_ENUM = ['half', 'none'] as const;
const SPELLCASTING_CLASS_ENUM = [
  'artificer',
  'bard',
  'cleric',
  'druid',
  'paladin',
  'ranger',
  'sorcerer',
  'warlock',
  'wizard',
] as const;
const SPELL_SCHOOL_ENUM = ['abj', 'con', 'div', 'enc', 'evo', 'ill', 'nec', 'trs'] as const;
const SPELL_METHOD_ENUM = ['atwill', 'innate', 'ritual', 'pact', 'spell'] as const;
const SPELL_COMPONENT_ENUM = ['vocal', 'somatic', 'material', 'concentration', 'ritual'] as const;
const SPELL_RANGE_UNITS_ENUM = ['ft', 'mi', 'touch', 'self', 'spec', 'any'] as const;
const SPELL_ACTIVITY_ENUM = ['attack', 'save', 'damage', 'heal', 'utility'] as const;
const HEAL_TYPE_ENUM = ['healing', 'temphp'] as const;

// Shared per-mode field fragments (reused zod instances — safe across multiple z.object() parents).
const featureHeaderFields = {
  actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
  featureName: z.string().min(1, 'featureName cannot be empty'),
  description: z.string().default(''),
  img: z.string().optional(),
};
const activationField = z.enum(ACTIVATION_ENUM).default('action');
const damagePartsRequired = z.array(damagePart).min(1, 'at least one damage part is required');
const sourceMetaFields = {
  sourceRules: z.enum(SOURCE_RULES_ENUM).default('2024'),
  sourceBook: z.string().default(''),
  sourcePage: z.string().default(''),
};
// Attack mechanics shared verbatim by the `attack` and `attack-with-save` modes.
const attackCoreFields = {
  attackType: z.enum(ATTACK_TYPE_ENUM),
  weaponClass: z.enum(WEAPON_CLASS_ENUM).default('natural'),
  abilityModifier: z.enum(ABILITY_ENUM).optional(),
  attackBonus: z.number().int().min(0).max(10).default(0),
  proficient: z.boolean().default(true),
  equipped: z.boolean().default(true),
  reachFt: z.number().int().min(5).default(5),
  rangeFt: z.number().int().min(1).optional(),
  longRangeFt: z.number().int().min(1).optional(),
  damageParts: damagePartsRequired,
  properties: z.array(z.string()).default([]),
};

// The ranged-attack cross-field rules, shared by `attack` and `attack-with-save`.
function refineRangedAttack(
  data: { attackType?: string; rangeFt?: number | undefined; longRangeFt?: number | undefined },
  ctx: z.RefinementCtx
): void {
  if (data.attackType === 'ranged' && data.rangeFt === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rangeFt'],
      message: 'rangeFt is required when attackType is "ranged"',
    });
  }
  if (
    data.longRangeFt !== undefined &&
    data.rangeFt !== undefined &&
    data.longRangeFt <= data.rangeFt
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['longRangeFt'],
      message: `longRangeFt (${data.longRangeFt}) must be greater than rangeFt (${data.rangeFt})`,
    });
  }
}

// ── Formatting helpers (pure) — collapse the per-mode response boilerplate. ──
type DamageDie = { number: number; denomination: number; type: string };
const damageList = (parts: ReadonlyArray<DamageDie>): string =>
  parts.map(p => `${p.number}d${p.denomination} ${p.type}`).join(' + ');
const warningBlock = (warnings: ReadonlyArray<string>): string =>
  warnings.length > 0
    ? `\n\n⚠️ **Warnings (${warnings.length}):**\n${warnings.map(w => `- ${w}`).join('\n')}`
    : '';

// Collect (deduped) "unknown damage type" warnings, optionally logging each as it is found.
function unknownDamageWarnings(
  parts: ReadonlyArray<{ type: string }>,
  log?: (msg: string, meta?: unknown) => void
): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!DAMAGE_CANONICAL.has(part.type)) {
      const msg = `Unknown damage type "${part.type}" — verify it matches dnd5e system values`;
      if (!out.includes(msg)) out.push(msg);
      log?.(msg, { value: part.type });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertised input contract (single source of truth)
//
// add-feature is a discriminated tool: featureType selects one of seven per-mode handlers, each of
// which strictly validates its own subset with its own zod schema below. This umbrella is the FLAT
// advertised surface — every parameter any mode accepts, all optional except the two universal
// keys — and getToolDefinitions() generates its inputSchema from it via toInputSchema().
//
// CAVEAT: the umbrella's field SET and per-field wrappers (.optional()/.default()) are still
// hand-MAINTAINED in parallel with the per-mode enforcement schemas (a true discriminated union
// doesn't fit MCP's flat-args model). The enum VALUE sets are now single-sourced (the *_ENUM consts
// above) and the shared field fragments (featureHeaderFields / attackCoreFields / sourceMetaFields /
// activationField / damagePartsRequired) are reused by both sides, so those can no longer drift. What
// remains is fail-safe — the umbrella only ever advertises looser constraints than the mode enforces
// (e.g. a missing .int()), so a bad value passes the advertised schema and is then rejected by the
// per-mode .parse() with a clear ZodError, never silently mis-applied.
// ---------------------------------------------------------------------------

export const AddFeatureSchema = z.object({
  // ── Discriminator ─────────────────────────────────────────────────
  featureType: z
    .enum([
      'passive',
      'save',
      'attack',
      'attack-with-save',
      'aura',
      'spellcasting',
      'spells',
      'homebrew-spell',
    ])
    .describe(
      'Mode selector — determines which parameters are used and which Foundry handler is called.'
    ),

  // ── Common ────────────────────────────────────────────────────────
  actorIdentifier: z
    .string()
    .describe(
      'Name or ID of the target actor (partial name match supported). Required for all featureTypes.'
    ),
  featureName: z
    .string()
    .optional()
    .describe(
      'Name for the new feature/item — must be unique on the actor. ' +
        'Required for: passive, save, attack, attack-with-save, aura.'
    ),
  description: z
    .string()
    .default('')
    .describe(
      'HTML description of the feature (optional). Used by: passive, save, attack, attack-with-save, aura.'
    ),
  img: z
    .string()
    .optional()
    .describe(
      'Icon path for the authored feature. OMIT and a real, kind-appropriate icon is auto-filled ' +
        '(no blank star). Set it to the img of the compendium feature you are emulating ' +
        '(search-compendium-* → copy its img) for an exact match. Used by: passive, save, attack, ' +
        'attack-with-save, aura, homebrew-spell.'
    ),
  activationType: z
    .enum(ACTIVATION_ENUM)
    .default('action')
    .describe(
      'Action economy type. Used by: save, attack, attack-with-save, aura. Default: "action".'
    ),

  // ── Damage ────────────────────────────────────────────────────────
  damageParts: z
    .array(damagePart)
    .min(1)
    .optional()
    .describe(
      'Damage components. ' +
        'For attack: first entry is base weapon die, extra entries stack on top. ' +
        'For save and aura: all damage dealt on trigger. ' +
        'For attack-with-save: the attack roll damage (on hit). ' +
        'Required for: save, attack, attack-with-save, aura.'
    ),

  // ── Save parameters ───────────────────────────────────────────────
  saveAbility: z
    .enum(ABILITY_ENUM)
    .optional()
    .describe('Ability used for the saving throw. Required for: save, attack-with-save.'),
  saveDC: z
    .number()
    .min(1)
    .max(30)
    .optional()
    .describe('Saving throw DC (1–30). Required for: save, attack-with-save.'),
  halfOnSave: z
    .boolean()
    .default(true)
    .describe(
      'Whether the target takes half damage on a successful save. Used by: save. Default: true.'
    ),
  saveDamageParts: z
    .array(damagePart)
    .min(1)
    .optional()
    .describe(
      'Damage dealt by the save effect on a failed save (independent of attack damage). ' +
        'Required for: attack-with-save.'
    ),
  saveOnSave: z
    .enum(SAVE_ON_SAVE_ENUM)
    .default('none')
    .describe(
      '"none" — no damage on a successful save (default). ' +
        '"half" — half save damage on a successful save. Used by: attack-with-save.'
    ),

  // ── Area parameters ───────────────────────────────────────────────
  areaType: z
    .enum([...AREA_SHAPE_ENUM, ''])
    .default('')
    .describe(
      'Area-of-effect template shape. ' +
        'For save: optional (omit or use "" for no template); if set, areaSize is required. ' +
        'For aura: required — use "emanation" or "sphere" for radial auras.'
    ),
  areaSize: z
    .number()
    .gt(0)
    .optional()
    .describe(
      'Template size in areaUnits (e.g. 30 for a 30 ft cone). Must be > 0. ' +
        'Required for: aura. Required for save when areaType is set.'
    ),
  areaUnits: z
    .enum(AREA_UNITS_ENUM)
    .default('ft')
    .describe('Units for areaSize. Used by: save, aura. Default: "ft".'),
  affectsType: z
    .enum(AFFECTS_ENUM)
    .default('creature')
    .describe('What the area targets. Used by: save, aura. Default: "creature".'),

  // ── Attack parameters ─────────────────────────────────────────────
  attackType: z
    .enum(ATTACK_TYPE_ENUM)
    .optional()
    .describe(
      '"melee" for reach-based attacks; "ranged" for bow/thrown attacks. ' +
        'Required for: attack, attack-with-save.'
    ),
  weaponClass: z
    .enum(WEAPON_CLASS_ENUM)
    .default('natural')
    .describe(
      'Weapon category. Use "natural" for monster attacks (claws, bite, touch). ' +
        'Used by: attack, attack-with-save. Default: "natural".'
    ),
  abilityModifier: z
    .enum(ABILITY_ENUM)
    .optional()
    .describe(
      'Ability used for to-hit and damage rolls. ' +
        'Omit to use default: STR for melee, DEX for ranged. ' +
        'Used by: attack, attack-with-save.'
    ),
  attackBonus: z
    .number()
    .min(0)
    .max(10)
    .default(0)
    .describe(
      'Flat bonus to the attack roll only, not damage (e.g. 1 for +1 to hit). ' +
        'Used by: attack, attack-with-save. Default: 0.'
    ),
  proficient: z
    .boolean()
    .default(true)
    .describe(
      'Whether the actor is proficient with this weapon (adds proficiency bonus to to-hit). ' +
        'Used by: attack, attack-with-save. Default: true.'
    ),
  equipped: z
    .boolean()
    .default(true)
    .describe(
      'Whether the weapon is equipped and available for attack rolls. ' +
        'Used by: attack, attack-with-save. Default: true.'
    ),
  reachFt: z
    .number()
    .min(5)
    .default(5)
    .describe('Melee reach in feet. Used by: attack, attack-with-save (melee only). Default: 5.'),
  rangeFt: z
    .number()
    .min(1)
    .optional()
    .describe(
      'Normal range in feet. Used by: attack, attack-with-save. ' +
        'Required when attackType is "ranged".'
    ),
  longRangeFt: z
    .number()
    .min(1)
    .optional()
    .describe(
      'Long range in feet — attacks beyond rangeFt up to this distance are at disadvantage. ' +
        'Must be greater than rangeFt. Used by: attack, attack-with-save (ranged only).'
    ),
  properties: z
    .array(z.string())
    .default([])
    .describe(
      'Weapon property codes (e.g. ["fin", "lgt"]). ' +
        'Canonical dnd5e codes: ada, amm, fin, fir, foc, hvy, lgt, lod, mgc, rch, rel, ret, sil, spc, thr, two, ver. ' +
        'Used by: attack, attack-with-save. Default: [].'
    ),

  // ── Spellcasting parameters ───────────────────────────────────────
  spellcastingClass: z
    .enum(SPELLCASTING_CLASS_ENUM)
    .optional()
    .describe(
      'The spellcasting class — determines slot table and default casting ability. ' +
        'Warlock uses Pact Magic. Required for: spellcasting.'
    ),
  spellcastingLevel: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe(
      'Class level (1–20). Determines how many slots the actor receives. Required for: spellcasting.'
    ),
  spellcastingAbility: z
    .enum(ABILITY_ENUM)
    .optional()
    .describe(
      'Override the casting ability. Omit to use the class default. ' + 'Used by: spellcasting.'
    ),

  // ── Spells parameters ─────────────────────────────────────────────
  spellNames: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .optional()
    .describe(
      'English spell names to import (exact match, case-insensitive). Max 50 per call. ' +
        'Required for: spells.'
    ),
  compendiumPacks: z
    .array(z.string().min(1))
    .default([...DEFAULT_SPELL_PACKS])
    .describe(
      'Premium-book pack IDs to search, in priority order (first match wins). ' +
        `Default: ${JSON.stringify([...DEFAULT_SPELL_PACKS])} (PHB). SOURCE ONLY from the premium ` +
        'MM/PHB/DMG books — NEVER the dnd5e.* SRD packs (design.md §2.3). Used by: spells.'
    ),

  // ── Feat widening (passive) ───────────────────────────────────────
  featType: z
    .string()
    .optional()
    .describe(
      'Feat category for the feat document type.value (e.g. "monster", "class", "feat", "background"). ' +
        'Used by: passive. Default: "monster".'
    ),
  requirements: z
    .string()
    .optional()
    .describe('Free-text prerequisite/requirements line on the feat. Used by: passive.'),

  // ── Homebrew spell parameters ─────────────────────────────────────
  spellLevel: z
    .number()
    .int()
    .min(0)
    .max(9)
    .optional()
    .describe('Spell level 0–9 (0 = cantrip). Required for: homebrew-spell.'),
  spellSchool: z
    .enum(SPELL_SCHOOL_ENUM)
    .optional()
    .describe('School: abj/con/div/enc/evo/ill/nec/trs. Used by: homebrew-spell.'),
  spellMethod: z
    .enum(SPELL_METHOD_ENUM)
    .default('spell')
    .describe(
      'Casting method. "innate"/"atwill" for monster innate casting; "spell" for prepared/known. ' +
        'Used by: homebrew-spell.'
    ),
  spellPrepared: z
    .number()
    .int()
    .min(0)
    .max(2)
    .default(0)
    .describe(
      'Preparation state: 0 unprepared, 1 prepared, 2 always prepared. Used by: homebrew-spell.'
    ),
  spellComponents: z
    .array(z.enum(SPELL_COMPONENT_ENUM))
    .default([])
    .describe('Components/properties. Used by: homebrew-spell.'),
  spellMaterials: z
    .string()
    .optional()
    .describe(
      'Material component text (when components include "material"). Used by: homebrew-spell.'
    ),
  spellRange: z
    .number()
    .optional()
    .describe('Numeric range (with spellRangeUnits). Used by: homebrew-spell.'),
  spellRangeUnits: z
    .enum(SPELL_RANGE_UNITS_ENUM)
    .optional()
    .describe('Range units. Use "self"/"touch" without spellRange. Used by: homebrew-spell.'),
  spellDuration: z
    .number()
    .optional()
    .describe('Numeric duration (with spellDurationUnits). Used by: homebrew-spell.'),
  spellDurationUnits: z
    .string()
    .optional()
    .describe('Duration units (e.g. "inst", "minute", "hour", "round"). Used by: homebrew-spell.'),
  spellActivity: z
    .enum(SPELL_ACTIVITY_ENUM)
    .optional()
    .describe(
      'Optional single activity giving the spell mechanics. Pair with damageParts (attack/damage/save), ' +
        'attackType (attack), saveAbility+saveDC+saveOnSave (save), or healAmount (heal). Used by: homebrew-spell.'
    ),
  healAmount: z
    .object({
      number: z.number().int().min(1),
      denomination: z.literal([4, 6, 8, 10, 12, 20, 100]),
      type: z.enum(HEAL_TYPE_ENUM).optional(),
    })
    .optional()
    .describe('Healing dice for a heal activity. Used by: homebrew-spell (spellActivity "heal").'),

  // ── Source metadata ───────────────────────────────────────────────
  sourceRules: z
    .enum(SOURCE_RULES_ENUM)
    .default('2024')
    .describe(
      'Rules edition. Used by: passive, attack, attack-with-save, aura, spellcasting, homebrew-spell. Default: "2024" (pass "2014" for legacy content).'
    ),
  sourceBook: z
    .string()
    .default('')
    .describe(
      'Source book abbreviation (e.g. "MM\'14"). Used by: passive, attack, attack-with-save, aura.'
    ),
  sourcePage: z
    .string()
    .default('')
    .describe('Page number in the source book. Used by: passive, attack, attack-with-save, aura.'),
});

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface DnD5eAddFeatureToolOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class DnD5eAddFeatureTool {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: DnD5eAddFeatureToolOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eAddFeatureTool' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'add-feature',
        description:
          '[D&D 5e only] Add a feature, attack, spellcasting setup, or spells to an existing actor. ' +
          'Set featureType to select the mode — each mode uses only its own parameters:\n\n' +
          '• passive — descriptive trait, no roll (Magic Resistance, Spider Climb).\n' +
          '  Required: actorIdentifier, featureName\n' +
          '  Optional: description, featType (monster/class/feat/...), requirements, sourceRules, sourceBook, sourcePage\n\n' +
          '• save — feature that forces a saving throw (breath weapon, cone of cold, etc.).\n' +
          '  Required: actorIdentifier, featureName, saveAbility, saveDC, damageParts\n' +
          '  Optional: description, activationType, halfOnSave, areaType, areaSize ' +
          '(required if areaType set), areaUnits, affectsType\n\n' +
          '• attack — weapon attack with to-hit roll (Claw, Bite, Scimitar, etc.).\n' +
          '  Required: actorIdentifier, featureName, attackType, damageParts\n' +
          '  Required when ranged: rangeFt\n' +
          '  Optional: description, activationType, weaponClass, abilityModifier, attackBonus, ' +
          'proficient, equipped, reachFt, longRangeFt, properties, sourceRules, sourceBook, sourcePage\n\n' +
          '• attack-with-save — attack roll on hit + forced save for bonus damage ' +
          '(e.g. Stinger: piercing hit + CON save or poison damage).\n' +
          '  Required: actorIdentifier, featureName, attackType, damageParts, ' +
          'saveAbility, saveDC, saveDamageParts\n' +
          '  Required when ranged: rangeFt\n' +
          '  Optional: description, activationType, weaponClass, abilityModifier, attackBonus, ' +
          'proficient, equipped, reachFt, longRangeFt, properties, saveOnSave, ' +
          'sourceRules, sourceBook, sourcePage\n\n' +
          '• aura — automatic-damage area, no to-hit, no save (all creatures in range take damage).\n' +
          '  Required: actorIdentifier, featureName, damageParts, areaType, areaSize\n' +
          '  Optional: description, activationType, areaUnits, affectsType, ' +
          'sourceRules, sourceBook, sourcePage\n\n' +
          '• spellcasting — configure spell slots and casting ability. ' +
          'Run this BEFORE featureType "spells".\n' +
          '  Required: actorIdentifier, spellcastingClass, spellcastingLevel\n' +
          '  Optional: spellcastingAbility (default per class: wizard/artificer→INT, ' +
          'cleric/druid/ranger→WIS, sorcerer/warlock/bard/paladin→CHA), sourceRules\n\n' +
          '• spells — import EXISTING named spells from compendium. Names must be in English.\n' +
          '  Required: actorIdentifier, spellNames (max 50)\n' +
          `  Optional: compendiumPacks (default ${JSON.stringify([...DEFAULT_SPELL_PACKS])} — premium PHB; never the dnd5e.* SRD)\n\n` +
          '• homebrew-spell — author a NEW spell from scratch (vs "spells" which imports).\n' +
          '  Required: actorIdentifier, featureName, spellLevel\n' +
          '  Optional: description, spellSchool, spellMethod (atwill/innate/ritual/pact/spell), ' +
          'spellPrepared (0/1/2), spellComponents, spellMaterials, spellRange(+Units), ' +
          'spellDuration(+Units), activationType, sourceRules, and an optional spellActivity ' +
          '(attack/save/damage/heal/utility) with its params (damageParts, attackType, ' +
          'saveAbility+saveDC+saveOnSave, or healAmount)\n\n' +
          'Use list-actors or get-actor first to find the actorIdentifier.',

        inputSchema: toInputSchema(AddFeatureSchema),
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Master dispatcher
  // ---------------------------------------------------------------------------

  async handleAddFeature(args: any): Promise<any> {
    const { featureType } = z
      .object({
        featureType: z.enum([
          'passive',
          'save',
          'attack',
          'attack-with-save',
          'aura',
          'spellcasting',
          'spells',
          'homebrew-spell',
        ]),
      })
      .parse(args);

    switch (featureType) {
      case 'passive':
        return this.handlePassive(args);
      case 'save':
        return this.handleSave(args);
      case 'attack':
        return this.handleAttack(args);
      case 'attack-with-save':
        return this.handleAttackWithSave(args);
      case 'aura':
        return this.handleAura(args);
      case 'spellcasting':
        return this.handleSpellcasting(args);
      case 'spells':
        return this.handleSpells(args);
      case 'homebrew-spell':
        return this.handleHomebrewSpell(args);
    }
  }

  // ---------------------------------------------------------------------------
  // passive
  // ---------------------------------------------------------------------------

  private async handlePassive(args: any): Promise<any> {
    const schema = z.object({
      featureType: z.literal('passive'),
      ...featureHeaderFields,
      featType: z.string().optional(),
      requirements: z.string().optional(),
      ...sourceMetaFields,
    });

    const parsed = schema.parse(args);

    this.logger.info('Adding passive feature to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'add-feature (passive)');

      const result = await this.foundry.call('addPassiveFeatureToActor', parsed);

      this.logger.info('Passive feature added successfully', {
        actorId: result.actor?.id,
        itemId: result.item?.id,
      });

      return this.formatPassiveResponse(result, parsed);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'add-feature', 'passive feature creation');
    }
  }

  private formatPassiveResponse(result: any, params: any): any {
    const summary = `✅ Feature "${result.item.name}" added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Feature:** ${result.item.name} (id: \`${result.item.id}\`)`,
      `**Type:** passive / descriptive (no activity)`,
      `**Rules:** ${params.sourceRules}${params.sourceBook ? ` — ${params.sourceBook}` : ''}`,
    ].join('\n');
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      message: `${summary}\n\n${details}`,
    };
  }

  // ---------------------------------------------------------------------------
  // save
  // ---------------------------------------------------------------------------

  private async handleSave(args: any): Promise<any> {
    const schema = z
      .object({
        featureType: z.literal('save'),
        ...featureHeaderFields,
        activationType: activationField,
        saveAbility: z.enum(ABILITY_ENUM),
        saveDC: z.number().int().min(1).max(30),
        damageParts: damagePartsRequired,
        halfOnSave: z.boolean().default(true),
        areaType: z.enum([...AREA_SHAPE_ENUM, '']).default(''),
        areaSize: z.number().positive().optional(),
        areaUnits: z.enum(AREA_UNITS_ENUM).default('ft'),
        affectsType: z.enum(AFFECTS_ENUM).default('creature'),
      })
      .superRefine((data, ctx) => {
        if (data.areaType !== '' && data.areaSize === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['areaSize'],
            message: `areaSize is required when areaType is "${data.areaType}"`,
          });
        }
      });

    const parsed = schema.parse(args);

    this.logger.info('Adding save feature to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
      saveAbility: parsed.saveAbility,
      saveDC: parsed.saveDC,
      areaType: parsed.areaType || 'none',
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'add-feature (save)');

      const result = await this.foundry.call('addSaveFeatureToActor', parsed);

      this.logger.info('Save feature added successfully', {
        actorId: result.actor?.id,
        itemId: result.item?.id,
      });

      return this.formatSaveResponse(result, parsed);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'add-feature', 'save feature creation');
    }
  }

  private formatSaveResponse(result: any, params: any): any {
    const damageDesc = damageList(params.damageParts);
    const areaDesc = params.areaType
      ? `, ${params.areaSize}${params.areaUnits} ${params.areaType}`
      : '';
    const saveDesc = `DC ${params.saveDC} ${String(params.saveAbility).toUpperCase()} save`;
    const onSaveDesc = params.halfOnSave ? 'half damage on save' : 'no damage on save';
    const summary = `✅ Feature "${result.item.name}" added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Feature:** ${result.item.name} (id: \`${result.item.id}\`)`,
      `**Save:** ${saveDesc} — ${onSaveDesc}`,
      `**Damage:** ${damageDesc}${areaDesc}`,
      `**Activation:** ${params.activationType}`,
    ].join('\n');
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      message: `${summary}\n\n${details}`,
    };
  }

  // ---------------------------------------------------------------------------
  // attack
  // ---------------------------------------------------------------------------

  private async handleAttack(args: any): Promise<any> {
    const schema = z
      .object({
        featureType: z.literal('attack'),
        ...featureHeaderFields,
        activationType: activationField,
        ...attackCoreFields,
        ...sourceMetaFields,
      })
      .superRefine(refineRangedAttack);

    const parsed = schema.parse(args);
    const effectiveAbility: string =
      parsed.abilityModifier ?? (parsed.attackType === 'melee' ? 'str' : 'dex');

    const warnings: string[] = unknownDamageWarnings(parsed.damageParts, (m, meta) =>
      this.logger.warn(m, meta)
    );
    for (const prop of parsed.properties) {
      if (!ATTACK_PROPERTY_CANONICAL.has(prop)) {
        const msg = `Unknown weapon property "${prop}" — verify it matches dnd5e system values`;
        warnings.push(msg);
        this.logger.warn(msg, { value: prop });
      }
    }

    this.logger.info('Adding attack feature to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
      attackType: parsed.attackType,
      ability: effectiveAbility,
      warnings: warnings.length,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'add-feature (attack)');

      const result = await this.foundry.call('addAttackToActor', {
        ...parsed,
        effectiveAbility,
      });

      this.logger.info('Attack feature added successfully', {
        actorId: result.actor?.id,
        itemId: result.item?.id,
      });

      return this.formatAttackResponse(result, { ...parsed, effectiveAbility }, warnings);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'add-feature', 'attack feature creation');
    }
  }

  private formatAttackResponse(result: any, params: any, warnings: string[]): any {
    const bonusStr = params.attackBonus > 0 ? ` +${params.attackBonus} to hit` : '';
    const damageDesc = damageList(params.damageParts);
    const rangeDesc =
      params.attackType === 'melee'
        ? `reach ${params.reachFt ?? 5} ft.`
        : `range ${params.rangeFt}${params.longRangeFt ? `/${params.longRangeFt}` : ''} ft.`;
    const summary = `✅ Attack "${result.item.name}" added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Item:** ${result.item.name} (id: \`${result.item.id}\`)`,
      `**Attack:** ${params.attackType} — ${String(params.effectiveAbility).toUpperCase()} modifier${bonusStr}`,
      `**Damage:** ${damageDesc}`,
      `**Range/Reach:** ${rangeDesc}`,
      `**Weapon class:** ${params.weaponClass}`,
    ].join('\n');
    const warningSection = warningBlock(warnings);
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      warnings,
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }

  // ---------------------------------------------------------------------------
  // attack-with-save
  // ---------------------------------------------------------------------------

  private async handleAttackWithSave(args: any): Promise<any> {
    const schema = z
      .object({
        featureType: z.literal('attack-with-save'),
        ...featureHeaderFields,
        activationType: activationField,
        ...attackCoreFields,
        saveAbility: z.enum(ABILITY_ENUM),
        saveDC: z.number().int().min(1).max(30),
        saveDamageParts: z.array(damagePart).min(1, 'at least one save damage part is required'),
        saveOnSave: z.enum(SAVE_ON_SAVE_ENUM).default('none'),
        ...sourceMetaFields,
      })
      .superRefine(refineRangedAttack);

    const parsed = schema.parse(args);
    const effectiveAbility: string =
      parsed.abilityModifier ?? (parsed.attackType === 'melee' ? 'str' : 'dex');

    const warnings: string[] = unknownDamageWarnings(
      [...parsed.damageParts, ...parsed.saveDamageParts],
      (m, meta) => this.logger.warn(m, meta)
    );

    this.logger.info('Adding attack+save feature to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
      attackType: parsed.attackType,
      saveAbility: parsed.saveAbility,
      saveDC: parsed.saveDC,
      warnings: warnings.length,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'add-feature (attack-with-save)');

      const result = await this.foundry.call('addAttackWithSaveToActor', {
        ...parsed,
        effectiveAbility,
      });

      this.logger.info('Attack+save feature added successfully', {
        actorId: result.actor?.id,
        itemId: result.item?.id,
      });

      return this.formatAttackWithSaveResponse(result, { ...parsed, effectiveAbility }, warnings);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'add-feature', 'attack+save feature creation');
    }
  }

  private formatAttackWithSaveResponse(result: any, params: any, warnings: string[]): any {
    const bonusStr = params.attackBonus > 0 ? ` +${params.attackBonus} to hit` : '';
    const attackDamageDesc = damageList(params.damageParts);
    const saveDamageDesc = damageList(params.saveDamageParts);
    const rangeDesc =
      params.attackType === 'melee'
        ? `reach ${params.reachFt ?? 5} ft.`
        : `range ${params.rangeFt}${params.longRangeFt ? `/${params.longRangeFt}` : ''} ft.`;
    const summary = `✅ Attack+Save "${result.item.name}" added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Item:** ${result.item.name} (id: \`${result.item.id}\`)`,
      `**Attack:** ${params.attackType} — ${String(params.effectiveAbility).toUpperCase()} modifier${bonusStr}, ${rangeDesc}`,
      `**Attack damage:** ${attackDamageDesc}`,
      `**Save:** DC ${params.saveDC} ${String(params.saveAbility).toUpperCase()} — ${saveDamageDesc} (${params.saveOnSave === 'half' ? 'half on save' : 'no damage on save'})`,
    ].join('\n');
    const warningSection = warningBlock(warnings);
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      warnings,
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }

  // ---------------------------------------------------------------------------
  // aura
  // ---------------------------------------------------------------------------

  private async handleAura(args: any): Promise<any> {
    const schema = z.object({
      featureType: z.literal('aura'),
      ...featureHeaderFields,
      activationType: activationField,
      damageParts: damagePartsRequired,
      areaType: z.enum(AREA_SHAPE_ENUM),
      areaSize: z.number().positive('areaSize must be greater than 0'),
      areaUnits: z.enum(AREA_UNITS_ENUM).default('ft'),
      affectsType: z.enum(AFFECTS_ENUM).default('creature'),
      ...sourceMetaFields,
    });

    const parsed = schema.parse(args);

    const warnings: string[] = unknownDamageWarnings(parsed.damageParts, (m, meta) =>
      this.logger.warn(m, meta)
    );

    this.logger.info('Adding aura feature to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
      areaType: parsed.areaType,
      areaSize: parsed.areaSize,
      warnings: warnings.length,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'add-feature (aura)');

      const result = await this.foundry.call('addAuraToActor', parsed);

      this.logger.info('Aura feature added successfully', {
        actorId: result.actor?.id,
        itemId: result.item?.id,
      });

      return this.formatAuraResponse(result, parsed, warnings);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'add-feature', 'aura feature creation');
    }
  }

  private formatAuraResponse(result: any, params: any, warnings: string[]): any {
    const damageDesc = damageList(params.damageParts);
    const areaDesc = `${params.areaSize}${params.areaUnits} ${params.areaType}`;
    const summary = `✅ Aura "${result.item.name}" added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Feature:** ${result.item.name} (id: \`${result.item.id}\`)`,
      `**Damage:** ${damageDesc} (automatic — no attack roll, no saving throw)`,
      `**Area:** ${areaDesc}, affects: ${params.affectsType || 'any'}`,
      `**Activation:** ${params.activationType}`,
    ].join('\n');
    const warningSection = warningBlock(warnings);
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      warnings,
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }

  // ---------------------------------------------------------------------------
  // spellcasting
  // ---------------------------------------------------------------------------

  private async handleSpellcasting(args: any): Promise<any> {
    const schema = z.object({
      featureType: z.literal('spellcasting'),
      actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
      spellcastingClass: z.enum(SPELLCASTING_CLASS_ENUM),
      spellcastingLevel: z.number().int().min(1).max(20),
      spellcastingAbility: z.enum(ABILITY_ENUM).optional(),
      sourceRules: z.enum(SOURCE_RULES_ENUM).default('2024'),
    });

    const parsed = schema.parse(args);
    const effectiveAbility =
      parsed.spellcastingAbility ?? CLASS_DEFAULT_ABILITY[parsed.spellcastingClass];

    this.logger.info('Setting actor spellcasting', {
      actorIdentifier: parsed.actorIdentifier,
      spellcastingClass: parsed.spellcastingClass,
      spellcastingLevel: parsed.spellcastingLevel,
      ability: effectiveAbility,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'add-feature (spellcasting)');

      const result = await this.foundry.call('setActorSpellcasting', {
        ...parsed,
        effectiveAbility,
      });

      this.logger.info('Actor spellcasting set successfully', { actorId: result.actor?.id });

      return this.formatSpellcastingResponse(result, { ...parsed, effectiveAbility });
    } catch (error) {
      this.errorHandler.handleToolError(error, 'add-feature', 'spellcasting setup');
    }
  }

  private formatSpellcastingResponse(result: any, params: any): any {
    const isWarlock = params.spellcastingClass === 'warlock';
    const slotsDesc = isWarlock
      ? `Pact Magic: ${result.spellcasting.slots.pact.max} slot(s) of level ${result.spellcasting.slots.pact.level}`
      : Object.entries(result.spellcasting.slots as Record<string, number>)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `L${k.replace('spell', '')}: ${n}`)
          .join(', ') || 'no slots';
    const summary = `✅ Spellcasting configured on "${result.actor.name}" — ${params.spellcastingClass} level ${params.spellcastingLevel}`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Class:** ${params.spellcastingClass} — level ${params.spellcastingLevel}`,
      `**Ability:** ${String(params.effectiveAbility).toUpperCase()}`,
      `**Slots:** ${slotsDesc}`,
    ].join('\n');
    const warningSection =
      (result.warnings as string[]).length > 0
        ? `\n\n⚠️ **Warnings:**\n${(result.warnings as string[]).map((w: string) => `- ${w}`).join('\n')}`
        : '';
    return {
      summary,
      success: true,
      actor: result.actor,
      spellcasting: result.spellcasting,
      warnings: result.warnings,
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }

  // ---------------------------------------------------------------------------
  // spells
  // ---------------------------------------------------------------------------

  private async handleSpells(args: any): Promise<any> {
    const schema = z.object({
      featureType: z.literal('spells'),
      actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
      spellNames: z.array(z.string().min(1)).min(1).max(50),
      compendiumPacks: z.array(z.string().min(1)).default([...DEFAULT_SPELL_PACKS]),
    });

    const parsed = schema.parse(args);
    assertNoSrdPacks(parsed.compendiumPacks, 'add-feature spells');

    this.logger.info('Adding spells to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      spellCount: parsed.spellNames.length,
      packs: parsed.compendiumPacks,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'add-feature (spells)');

      const result = await this.foundry.call('addSpellsToActor', parsed);

      this.logger.info('Spells import complete', {
        actorId: result.actor?.id,
        added: result.added?.length,
        skipped: result.skipped?.length,
        notFound: result.notFound?.length,
        failed: result.failed?.length,
      });

      return formatImportReport(result, parsed.spellNames.length, 'Spells');
    } catch (error) {
      this.errorHandler.handleToolError(error, 'add-feature', 'spell import');
    }
  }

  // ---------------------------------------------------------------------------
  // homebrew-spell — author a NEW spell Item from scratch (with an optional activity)
  // ---------------------------------------------------------------------------

  private async handleHomebrewSpell(args: any): Promise<any> {
    const schema = z
      .object({
        featureType: z.literal('homebrew-spell'),
        ...featureHeaderFields,
        spellLevel: z.number().int().min(0).max(9),
        spellSchool: z.enum(SPELL_SCHOOL_ENUM).optional(),
        spellMethod: z.enum(SPELL_METHOD_ENUM).default('spell'),
        spellPrepared: z.number().int().min(0).max(2).default(0),
        spellComponents: z.array(z.enum(SPELL_COMPONENT_ENUM)).default([]),
        spellMaterials: z.string().optional(),
        spellRange: z.number().optional(),
        spellRangeUnits: z.enum(SPELL_RANGE_UNITS_ENUM).optional(),
        spellDuration: z.number().optional(),
        spellDurationUnits: z.string().optional(),
        activationType: activationField,
        // optional single activity
        spellActivity: z.enum(SPELL_ACTIVITY_ENUM).optional(),
        damageParts: z.array(damagePart).optional(),
        attackType: z.enum(ATTACK_TYPE_ENUM).optional(),
        saveAbility: z.enum(ABILITY_ENUM).optional(),
        saveDC: z.number().int().min(1).max(30).optional(),
        saveOnSave: z.enum(SAVE_ON_SAVE_ENUM).default('none'),
        healAmount: z
          .object({
            number: z.number().int().min(1),
            denomination: z.literal([4, 6, 8, 10, 12, 20, 100]),
            type: z.enum(HEAL_TYPE_ENUM).optional(),
          })
          .optional(),
        sourceRules: z.enum(SOURCE_RULES_ENUM).default('2024'),
      })
      .superRefine((data, ctx) => {
        if (
          data.spellActivity === 'save' &&
          (data.saveAbility === undefined || data.saveDC === undefined)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['saveAbility'],
            message: 'spellActivity "save" requires saveAbility and saveDC',
          });
        }
        if (data.spellActivity === 'heal' && data.healAmount === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['healAmount'],
            message: 'spellActivity "heal" requires healAmount',
          });
        }
        if (data.spellActivity === 'attack' && data.attackType === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['attackType'],
            message: 'spellActivity "attack" requires attackType',
          });
        }
      });

    const parsed = schema.parse(args);

    // Soft validation (warn, never block).
    const warnings: string[] = [];
    if (parsed.spellSchool === undefined) {
      warnings.push('No spellSchool set — the spell will have an empty school.');
    }
    warnings.push(...unknownDamageWarnings(parsed.damageParts ?? []));

    // Build the optional activity opts the page builder consumes.
    let activity: Record<string, any> | undefined;
    if (parsed.spellActivity) {
      activity = {
        type: parsed.spellActivity,
        activationType: parsed.activationType,
        damageParts: parsed.damageParts,
        attackType: parsed.attackType,
        ability: parsed.saveAbility, // harmless extra for non-attack types
        saveAbility: parsed.saveAbility,
        saveDC: parsed.saveDC,
        onSave: parsed.saveOnSave,
        healing: parsed.healAmount,
      };
    }

    this.logger.info('Authoring homebrew spell', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
      level: parsed.spellLevel,
      method: parsed.spellMethod,
      spellActivity: parsed.spellActivity ?? 'none',
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'add-feature (homebrew-spell)');

      const result = await this.foundry.call('addHomebrewSpellToActor', {
        actorIdentifier: parsed.actorIdentifier,
        name: parsed.featureName,
        img: parsed.img,
        level: parsed.spellLevel,
        school: parsed.spellSchool,
        method: parsed.spellMethod,
        prepared: parsed.spellPrepared,
        components: parsed.spellComponents,
        materials: parsed.spellMaterials,
        description: parsed.description,
        activationType: parsed.activationType,
        rangeValue: parsed.spellRange,
        rangeUnits: parsed.spellRangeUnits,
        durationValue: parsed.spellDuration,
        durationUnits: parsed.spellDurationUnits,
        sourceRules: parsed.sourceRules,
        ...(activity ? { activity } : {}),
      });

      return this.formatHomebrewSpellResponse(result, parsed, warnings);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'add-feature', 'homebrew spell authoring');
    }
  }

  private formatHomebrewSpellResponse(result: any, params: any, warnings: string[]): any {
    const lvl = params.spellLevel === 0 ? 'cantrip' : `level ${params.spellLevel}`;
    const summary = `✅ Spell "${result.item.name}" (${lvl}) added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Spell:** ${result.item.name} (id: \`${result.item.id}\`) — ${lvl}, ${params.spellMethod}`,
      `**Components:** ${(params.spellComponents ?? []).join(', ') || '(none)'}`,
      ...(result.activityType ? [`**Activity:** ${result.activityType}`] : []),
    ].join('\n');
    const warningSection = warningBlock(warnings);
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      warnings,
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }
}
