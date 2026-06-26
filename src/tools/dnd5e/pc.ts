import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { ErrorHandler } from '../../utils/error-handler.js';
import { toInputSchema } from '../../utils/schema.js';
import { assertDnd5e } from '../../utils/system-detection.js';

// ---------------------------------------------------------------------------
// create-pc / inspect-pc-advancement input contracts
//
// PCs are a SEPARATE product from NPCs (design.md §7): type:character + advancement, which resolves
// @scale.* natively. The tool layer is a THIN wrapper — the leveling engine (src/page/dnd5e/
// advancement.ts) owns correctness; this owns the advertised contract + response shaping. Each
// schema is the single source of truth (the handler parses with it and getToolDefinitions advertises
// toInputSchema() of the SAME schema, so advertised and enforced contracts cannot drift).
//
// The `choices` map is keyed level → advancement-id → { chosen | selected | uuid } — exactly the
// shape advancement.apply expects, learned by the skill from inspect-pc-advancement (or create-pc's
// needsChoices dry-run). z.record only (no zod tuples — those emit invalid JSON-Schema-2020-12).
// ---------------------------------------------------------------------------

const FINAL_ABILITY = z.number().int().min(1).max(30);

/** One advancement's supplied pick — Trait → chosen[], ItemChoice → selected[], Subclass → uuid. */
const ChoiceDataSchema = z.object({
  chosen: z.array(z.string()).optional(),
  selected: z.array(z.string()).optional(),
  uuid: z.string().optional(),
});

const CreatePcSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  className: z.string().min(1, 'className cannot be empty'),
  species: z.string().optional(),
  background: z.string().optional(),
  // FINAL ability scores — the skill owns point-buy / array / ASI math (design.md §2.1). Omit to
  // leave the dnd5e defaults (10s).
  abilities: z
    .object({
      str: FINAL_ABILITY,
      dex: FINAL_ABILITY,
      con: FINAL_ABILITY,
      int: FINAL_ABILITY,
      wis: FINAL_ABILITY,
      cha: FINAL_ABILITY,
    })
    .optional(),
  // level → advancement-id → choice data.
  choices: z.record(z.string(), z.record(z.string(), ChoiceDataSchema)).optional(),
  // Caster spell picks by NAME (slots auto-derive from the class; this imports chosen spells).
  spells: z
    .object({
      cantrips: z.array(z.string()).optional(),
      prepared: z.array(z.string()).optional(),
    })
    .optional(),
  // Character level 1..20. HP/subclass/spell-slots scale with it; subclass is granted at level 3.
  level: z.number().int().min(1).max(20).default(1),
  // HP per level past the first: 'avg' (2024 fixed average, default) or 'max'. L1 is always max.
  hpMode: z.enum(['avg', 'max']).default('avg'),
  sourceRules: z.enum(['2014', '2024']).default('2024'),
  folder: z.string().optional(),
  // When required picks are missing, the tool returns needsChoices WITHOUT persisting (no litter).
  // Set true to build anyway with only the forced defaults for the unsupplied picks.
  acceptDefaults: z.boolean().default(false),
});

const InspectPcAdvancementSchema = z
  .object({
    className: z.string().optional(),
    classUuid: z.string().optional(),
    level: z.number().int().min(1).max(20).default(1),
  })
  .superRefine((data, ctx) => {
    const hasName = !!data.className;
    const hasUuid = !!data.classUuid;
    if (hasName === hasUuid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['className'],
        message: 'Provide exactly one of className or classUuid',
      });
    }
  });

const CREATE_PC_DESCRIPTION =
  'Build a player character (type:character) headlessly from premium class + species + background by ' +
  'NAME, running real dnd5e advancement so @scale.* (rage damage, sneak attack, breath weapon, …) ' +
  'resolves natively — unlike an NPC. Compendium-first, premium books only, never the SRD ' +
  '(design.md §2.3); a missing class/species/background is an error, not invented. The SKILL owns ' +
  'the math: pass FINAL ability scores (point-buy/array/ASI already applied) and the player CHOICES ' +
  '(skills, fighting style, ancestry…) in `choices` (level → advancement-id → {chosen|selected|uuid}). ' +
  'Call with no/partial choices first to get a `needsChoices[]` dry-run (legal options per choice — ' +
  'incl. the available subclasses at level 3 — NOTHING is created); fill the map and re-call. ' +
  'Levels 1-20: HP/features/subclass/spell-slots scale with `level` (subclass at L3 via a `choices` ' +
  'uuid; HP per level `hpMode` avg|max). Caster spell slots auto-derive from the class; pass ' +
  '`spells.cantrips`/`spells.prepared` (names) to add chosen spells. ASI ability-increases ride in the ' +
  'FINAL scores (not applied separately); a feat taken at an ASI tier is added by the skill via ' +
  'add-feature/import-item, like equipment — this tool adds no gear or ASI-feats. Returns ' +
  '{success, actor, applied[], needsChoices[], unresolvedScale[], warnings[]}.';

const INSPECT_PC_ADVANCEMENT_DESCRIPTION =
  'Read-only: report the player CHOICE points a premium class exposes up to a level — each ' +
  "advancement's id, type (Trait/ItemChoice/Subclass), how many to pick, and the legal options — so " +
  "the skill can ask the DM and fill create-pc's `choices` map without inventing anything. Resolve by " +
  'className OR classUuid (exactly one); premium books only, never the SRD. Touches no actor.';

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface DnD5ePcToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class DnD5ePcTools {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: DnD5ePcToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5ePcTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-pc',
        description: CREATE_PC_DESCRIPTION,
        inputSchema: toInputSchema(CreatePcSchema),
      },
      {
        name: 'inspect-pc-advancement',
        description: INSPECT_PC_ADVANCEMENT_DESCRIPTION,
        inputSchema: toInputSchema(InspectPcAdvancementSchema),
      },
    ];
  }

  async handleCreatePc(args: any): Promise<any> {
    const parsed = CreatePcSchema.parse(args);

    this.logger.info('Creating D&D 5e PC', {
      name: parsed.name,
      className: parsed.className,
      species: parsed.species,
      background: parsed.background,
      acceptDefaults: parsed.acceptDefaults,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'create-pc');
      const result = await this.foundry.call('createPcActor', parsed);
      this.logger.info('PC build returned', {
        success: result?.success,
        actorId: result?.actor?.id,
        needsChoices: result?.needsChoices?.length ?? 0,
      });
      return this.formatPcResponse(result, parsed);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'create-pc', 'PC creation');
    }
  }

  async handleInspectPcAdvancement(args: any): Promise<any> {
    const parsed = InspectPcAdvancementSchema.parse(args);

    try {
      await assertDnd5e(this.foundry, this.logger, 'inspect-pc-advancement');
      const result = await this.foundry.call('inspectAdvancementChoices', parsed);
      return this.formatInspectResponse(result);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'inspect-pc-advancement', 'advancement inspection');
    }
  }

  // -------------------------------------------------------------------------
  // Response shaping
  // -------------------------------------------------------------------------

  private formatChoiceLine(c: any): string {
    const opts = (c.options ?? [])
      .map((o: any) => o.label ?? o.value)
      .slice(0, 10)
      .join(', ');
    const more = (c.options?.length ?? 0) > 10 ? ', …' : '';
    const where = `\`choices["${c.level}"]["${c.id}"] = { ${c.dataKey}: … }\``;
    return `- **${c.title}** (${c.source} · ${c.type}, pick ${c.count}) → ${where}${opts ? `\n  options: ${opts}${more}` : ''}`;
  }

  private formatPcResponse(result: any, params: any): any {
    // Dry-run / under-specified: required choices missing, nothing persisted.
    if (result?.success === false && Array.isArray(result?.needsChoices)) {
      const lines = result.needsChoices.map((c: any) => this.formatChoiceLine(c));
      const summary = `⚠️ "${params.name}" needs ${result.needsChoices.length} choice(s) before building`;
      return {
        summary,
        success: false,
        needsChoices: result.needsChoices,
        warnings: result.warnings ?? [],
        message:
          `${summary} — NOTHING was created.\n\n${lines.join('\n')}\n\n` +
          'Fill the `choices` map and re-call create-pc (or pass acceptDefaults:true to build with ' +
          'the forced defaults).',
      };
    }

    const actor = result?.actor ?? {};
    const summary = `✅ PC "${actor.name}" created (${actor.className}${actor.level ? ` ${actor.level}` : ''})`;
    const lines = [
      `**Actor:** ${actor.name} (id: \`${actor.id}\`) — type:character`,
      `**Build:** ${actor.className}${actor.species ? ` · ${actor.species}` : ''}${actor.background ? ` · ${actor.background}` : ''} (level ${actor.level})`,
      `**HP:** ${actor.hp ?? '—'}`,
    ];
    if (actor.folder) lines.push(`**Folder:** ${actor.folder}`);
    if (Array.isArray(result?.applied)) {
      const choices = result.applied.filter((a: any) => /\+choice/.test(a.result));
      lines.push(
        `**Advancements applied:** ${result.applied.length} (${choices.length} player choice(s))`
      );
    }

    const unresolved = result?.unresolvedScale ?? [];
    const unresolvedSection =
      unresolved.length > 0
        ? `\n\n⚠️ **Unresolved @scale (${unresolved.length})** — the engine could not resolve these; ` +
          `pick an explicit die via update-actor-item:\n${unresolved
            .map((u: any) => `- ${u.itemName}: \`${u.formula}\` at ${u.path}`)
            .join('\n')}`
        : '';

    const warnings = result?.warnings ?? [];
    const warningSection =
      warnings.length > 0
        ? `\n\n⚠️ **Warnings (${warnings.length}):**\n${warnings.map((w: string) => `- ${w}`).join('\n')}`
        : '';

    return {
      summary,
      success: true,
      actor: result?.actor,
      applied: result?.applied,
      unresolvedScale: unresolved,
      warnings,
      message: `${summary}\n\n${lines.join('\n')}${unresolvedSection}${warningSection}`,
    };
  }

  private formatInspectResponse(result: any): any {
    const cls = result?.class ?? {};
    const choices = result?.choices ?? [];
    const summary = `📖 ${cls.name} — ${choices.length} choice point(s) through level ${result?.level}`;
    const lines = choices.map((c: any) => this.formatChoiceLine(c));
    const caster = result?.spellcasting
      ? `\n\n**Spellcasting:** ${result.spellcasting} caster`
      : '';
    return {
      summary,
      success: true,
      class: result?.class,
      level: result?.level,
      choices,
      spellcasting: result?.spellcasting ?? null,
      message:
        `${summary}\n\n${lines.length ? lines.join('\n') : '_No player choices at this level._'}${caster}\n\n` +
        "Fill these into create-pc's `choices` map (level → advancement-id → {chosen|selected|uuid}).",
    };
  }
}
