import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { ErrorHandler } from '../../utils/error-handler.js';
import { toInputSchema } from '../../utils/schema.js';
import { assertDnd5e } from '../../utils/system-detection.js';

// ---------------------------------------------------------------------------
// Canonical value sets for soft validation (warnings, not errors)
// ---------------------------------------------------------------------------

const DAMAGE_CANONICAL = new Set([
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
]);

const CONDITION_CANONICAL = new Set([
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
]);

// ---------------------------------------------------------------------------
// CR helpers
// ---------------------------------------------------------------------------

/**
 * Converts a CR string ("1/4", "1/2", "5") or number (0.25, 5) to a float.
 */
function normalizeCR(input: string | number): number {
  if (typeof input === 'number') return input;
  if (input.includes('/')) {
    const [num, den] = input.split('/').map(Number);
    return num / den;
  }
  return parseInt(input, 10);
}

/**
 * Formats a CR float back to the canonical display string.
 */
function formatCR(value: number): string {
  if (value === 0) return '0';
  if (value === 0.125) return '1/8';
  if (value === 0.25) return '1/4';
  if (value === 0.5) return '1/2';
  return String(Math.round(value));
}

// ---------------------------------------------------------------------------
// author-npc input contract
// ---------------------------------------------------------------------------

// Single source of truth for the authored-NPC contract: handleCreateNpc parses with this schema
// and getToolDefinitions() advertises toInputSchema(...) of the same schema, so the advertised and
// enforced contracts cannot drift. The acMode='flat' ⇒ acValue cross-field check rides as a
// .superRefine() (runtime-only — JSON Schema can't express it; the description states it instead).
const AuthorNpcSchema = z
  .object({
    // Identity
    name: z.string().min(1, 'name cannot be empty'),
    creatureType: z.enum([
      'humanoid',
      'undead',
      'beast',
      'dragon',
      'aberration',
      'construct',
      'elemental',
      'fey',
      'fiend',
      'giant',
      'monstrosity',
      'ooze',
      'plant',
      'celestial',
      'swarm',
    ]),
    creatureSubtype: z.string().default(''),
    size: z.enum([
      'tiny',
      'small',
      'sm',
      'medium',
      'med',
      'large',
      'lg',
      'huge',
      'gargantuan',
      'grg',
    ]),
    alignment: z.string().default(''),
    cr: z.union([
      z
        .string()
        .regex(
          /^\d+(\/[248])?$/,
          'CR must be a whole number or fraction string (e.g. "0", "1/4", "1/2", "5")'
        ),
      z.number().finite().min(0),
    ]),
    // HP
    hpAverage: z.number().int().min(1),
    hpFormula: z.string().min(1, 'hpFormula cannot be empty'),
    // AC
    acMode: z.enum(['default', 'flat']),
    acValue: z.number().int().min(0).max(30).optional(),
    // Abilities
    abilities: z.object({
      str: z.number().int().min(1).max(30),
      dex: z.number().int().min(1).max(30),
      con: z.number().int().min(1).max(30),
      int: z.number().int().min(1).max(30),
      wis: z.number().int().min(1).max(30),
      cha: z.number().int().min(1).max(30),
    }),
    savingThrows: z.array(z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha'])).default([]),
    // Movement
    walkSpeed: z.number().int().min(0).default(30),
    flySpeed: z.number().int().min(0).default(0),
    swimSpeed: z.number().int().min(0).default(0),
    climbSpeed: z.number().int().min(0).default(0),
    burrowSpeed: z.number().int().min(0).default(0),
    hover: z.boolean().default(false),
    // Senses
    darkvision: z.number().int().min(0).default(0),
    blindsight: z.number().int().min(0).default(0),
    tremorsense: z.number().int().min(0).default(0),
    truesight: z.number().int().min(0).default(0),
    specialSenses: z.string().default(''),
    // Skills
    skills: z
      .array(
        z.object({
          skill: z.enum([
            'Acrobatics',
            'Animal Handling',
            'Arcana',
            'Athletics',
            'Deception',
            'History',
            'Insight',
            'Intimidation',
            'Investigation',
            'Medicine',
            'Nature',
            'Perception',
            'Performance',
            'Persuasion',
            'Religion',
            'Sleight of Hand',
            'Stealth',
            'Survival',
          ]),
          proficiency: z.enum(['proficient', 'expert']),
        })
      )
      .default([]),
    // Damage & condition traits
    damageImmunities: z.array(z.string()).default([]),
    damageResistances: z.array(z.string()).default([]),
    damageVulnerabilities: z.array(z.string()).default([]),
    conditionImmunities: z.array(z.string()).default([]),
    // Languages
    languages: z.array(z.string()).default([]),
    languagesCustom: z.string().default(''),
    // Biography & source
    biography: z.string().default(''),
    sourceBook: z.string().default(''),
    sourcePage: z.string().default(''),
    sourceRules: z.enum(['2014', '2024']).default('2024'),
  })
  .superRefine((data, ctx) => {
    if (data.acMode === 'flat' && data.acValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acValue'],
        message: 'acValue is required when acMode is "flat"',
      });
    }
  });

const AUTHOR_NPC_DESCRIPTION =
  'Author a custom NPC (type:npc) from a hand-written stat block — the LAST-RESORT path in the §6 ' +
  'ladder, used ONLY when nothing in the premium MM/PHB/DMG books is a workable base. Prefer ' +
  'create-actor-from-compendium (copy a real Monster Manual creature, optionally with prefab-as-base ' +
  'modifications); if the books are missing what you need, tell the user and ask before authoring ' +
  "rather than inventing content. Prefer the 2024 ruleset (sourceRules:'2024'). Required: name, " +
  'creatureType (humanoid/undead/beast/dragon/fiend/…), size (tiny…gargantuan), cr (number or ' +
  "fraction string like '1/4'), abilities {str,dex,con,int,wis,cha}, hpAverage, hpFormula (e.g. " +
  "'5d8+10'), acMode ('default'|'flat'; acValue required if 'flat'). Optional: alignment, " +
  'savingThrows[], skills[{skill,proficiency}], walk/fly/swim/climb/burrowSpeed, ' +
  'darkvision/blindsight/tremorsense/truesight, damage immunities/resistances/vulnerabilities[], ' +
  'conditionImmunities[], languages[], biography, sourceBook/sourcePage/sourceRules. Add features, ' +
  'attacks, and spells afterward with add-feature; copy gear from a compendium with import-item.';

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface DnD5eNpcToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class DnD5eNpcTools {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: DnD5eNpcToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eNpcTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'author-npc',
        description: AUTHOR_NPC_DESCRIPTION,
        inputSchema: toInputSchema(AuthorNpcSchema),
      },
    ];
  }

  async handleCreateNpc(args: any): Promise<any> {
    const parsed = AuthorNpcSchema.parse(args);

    // -----------------------------------------------------------------------
    // Soft validation — collect warnings, do NOT block creation
    // -----------------------------------------------------------------------
    const warnings: string[] = [];

    const allDamageValues = [
      ...parsed.damageImmunities.map(v => ({ field: 'damageImmunities', value: v })),
      ...parsed.damageResistances.map(v => ({ field: 'damageResistances', value: v })),
      ...parsed.damageVulnerabilities.map(v => ({ field: 'damageVulnerabilities', value: v })),
    ];
    for (const { field, value } of allDamageValues) {
      if (!DAMAGE_CANONICAL.has(value)) {
        const msg = `Unknown damage type "${value}" in ${field} — verify it matches dnd5e system values`;
        warnings.push(msg);
        this.logger.warn(msg, { field, value });
      }
    }
    for (const value of parsed.conditionImmunities) {
      if (!CONDITION_CANONICAL.has(value)) {
        const msg = `Unknown condition "${value}" in conditionImmunities — verify it matches dnd5e system values`;
        warnings.push(msg);
        this.logger.warn(msg, { value });
      }
    }

    this.logger.info('Creating D&D 5e NPC', {
      name: parsed.name,
      creatureType: parsed.creatureType,
      cr: parsed.cr,
      warnings: warnings.length,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'author-npc');

      const result = await this.foundry.call('createNpcActor', parsed);

      this.logger.info('NPC created successfully', {
        actorId: result.actor?.id,
        actorName: result.actor?.name,
      });

      return this.formatResponse(result, parsed, warnings);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'author-npc', 'NPC creation');
    }
  }

  private formatResponse(result: any, params: any, warnings: string[]): any {
    const crStr = result.actor?.cr ?? formatCR(normalizeCR(params.cr));

    const abilityLine = (['str', 'dex', 'con', 'int', 'wis', 'cha'] as const)
      .map(ab => `${ab.toUpperCase()} ${params.abilities[ab]}`)
      .join(' / ');

    const acDisplay = params.acMode === 'flat' ? String(params.acValue) : 'default (calculated)';

    const summary = `✅ NPC "${result.actor.name}" created (CR ${crStr})`;

    const lines = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Type:** ${params.creatureType}${params.creatureSubtype ? ` (${params.creatureSubtype})` : ''}, ${params.size}`,
      `**CR:** ${crStr}  |  **HP:** ${params.hpAverage} (${params.hpFormula})  |  **AC:** ${acDisplay}`,
      `**Abilities:** ${abilityLine}`,
    ];

    if (result.actor.folder) {
      lines.push(`**Folder:** ${result.actor.folder}`);
    }

    const warningSection =
      warnings.length > 0
        ? `\n\n⚠️ **Warnings (${warnings.length}):**\n${warnings.map(w => `- ${w}`).join('\n')}`
        : '';

    return {
      summary,
      success: true,
      actor: result.actor,
      warnings,
      message: `${summary}\n\n${lines.join('\n')}${warningSection}`,
    };
  }
}
