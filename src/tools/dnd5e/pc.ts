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

/** FINAL ability scores (point-buy/array/ASI already applied — the skill owns that math, §2.1). */
const AbilitiesSchema = z.object({
  str: FINAL_ABILITY,
  dex: FINAL_ABILITY,
  con: FINAL_ABILITY,
  int: FINAL_ABILITY,
  wis: FINAL_ABILITY,
  cha: FINAL_ABILITY,
});

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
  abilities: AbilitiesSchema.optional(),
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
  // For a multiclass PC this is the PRIMARY class's level (see `multiclass`).
  level: z.number().int().min(1).max(20).default(1),
  // Multiclass: additional SECONDARY classes built in the same call (className/level above is the
  // primary / originalClass). Each gets the 2024 multiclass proficiency subset; total character level
  // (level + every multiclass.levels) must be ≤ 20; a class may appear only once.
  multiclass: z
    .array(
      z.object({
        className: z.string().min(1, 'multiclass className cannot be empty'),
        levels: z.number().int().min(1).max(19),
      })
    )
    .optional(),
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

const LevelUpPcSchema = z.object({
  actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
  className: z.string().min(1, 'className cannot be empty'),
  // choices for the NEW level (keyed level → advancement-id → data) — e.g. a subclass at the class's
  // level 3 → choices: { "3": { "<subclass-adv-id>": { uuid } } }.
  choices: z.record(z.string(), z.record(z.string(), ChoiceDataSchema)).optional(),
  hpMode: z.enum(['avg', 'max']).default('avg'),
  acceptDefaults: z.boolean().default(false),
});

const CreatePcFromPrefabSchema = z
  .object({
    name: z.string().min(1, 'name cannot be empty'),
    // Resolve the source pregen EITHER by friendly name (`prefab`) OR explicit packId + actorId.
    prefab: z.string().optional(),
    packId: z.string().optional(),
    actorId: z.string().optional(),
    // Override the pregen's ability array with FINAL scores (the skill owns the math).
    abilities: AbilitiesSchema.optional(),
    // update-actor-shaped stat edits layered onto the COPY only (mirrors create-actor-from-compendium).
    modifications: z.record(z.string(), z.any()).optional(),
    folder: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const hasName = !!data.prefab;
    const hasExplicit = !!data.packId && !!data.actorId;
    if (!hasName && !hasExplicit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prefab'],
        message: 'Provide either `prefab` (a pregen name) or both `packId` and `actorId`.',
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
  'uuid; HP per level `hpMode` avg|max). Multiclass in ONE call via `multiclass:[{className,levels}]` ' +
  '(className/level is the primary; each multiclass class gets the 2024 proficiency subset; total ≤ 20). ' +
  'Caster spell slots auto-derive from the class; pass ' +
  '`spells.cantrips`/`spells.prepared` (names) to add chosen spells. ASI ability-increases ride in the ' +
  'FINAL scores (not applied separately); a feat taken at an ASI tier is added by the skill via ' +
  'add-feature/import-item, like equipment — this tool adds no gear or ASI-feats. If a required ' +
  'advancement (a forced grant / supplied pick / subclass embed) FAILS to apply, the PC is NOT ' +
  'persisted (no junk actor) and success:false is returned with errors[]. Returns ' +
  '{success, actor, applied[], needsChoices[], unresolvedScale[], errors[], warnings[]}.';

const INSPECT_PC_ADVANCEMENT_DESCRIPTION =
  'Read-only: report the player CHOICE points a premium class exposes up to a level — each ' +
  "advancement's id, type (Trait/ItemChoice/Subclass), how many to pick, and the legal options — so " +
  "the skill can ask the DM and fill create-pc's `choices` map without inventing anything. Resolve by " +
  'className OR classUuid (exactly one); premium books only, never the SRD. Touches no actor.';

const CREATE_PC_FROM_PREFAB_DESCRIPTION =
  'Create a player character by COPYING a premium-book PREGEN (a complete type:character template — ' +
  'e.g. the PHB class pregens Barbarian…Wizard in dnd-players-handbook.actors, each a ready level-1 ' +
  'build with gear/feats/art) and layering your changes, INSTEAD of building via advancement. The PC ' +
  "family's prefab-as-base path — the §6/§7 analog of create-actor-from-compendium for NPCs, but " +
  'PC-correct (files under the PC folder, never the NPC one). Resolve the source by `prefab` NAME ' +
  '(e.g. "Fighter") OR explicit packId+actorId; premium books only, never the SRD (design.md §2.3). ' +
  "Override the pregen's ability array via `abilities` (final scores) and/or any update-actor-shaped " +
  '`modifications` — applied to the COPY only, the source is never touched. @scale resolves natively ' +
  '(it is a real character, no advancement run). Assign the player as owner afterward with ' +
  'set-actor-ownership. Returns {success, from, actor, modificationsApplied, unresolvedScale, warnings}.';

const LEVEL_UP_PC_DESCRIPTION =
  "Add ONE level to an existing PC (type:character) and apply that level's advancement IN PLACE. " +
  'Same `className` as a class the PC already has → a single-class level-up; a class it does NOT have → ' +
  'a MULTICLASS add (the PC gets the 2024 multiclass proficiency SUBSET, not the full first-level kit). ' +
  "HP/features/subclass(@ the class's level 3)/spell-slots scale; @scale stays native. Like create-pc: " +
  'call with no/partial choices to get a `needsChoices[]` dry-run (e.g. the subclass options at level 3 — ' +
  'the actor is NOT touched); fill `choices` (level → advancement-id → {chosen|selected|uuid}) and ' +
  're-call. ASI ability bumps are NOT applied here — raise the final scores with update-actor; a feat ' +
  'taken at an ASI tier is added with add-feature. If a required advancement FAILS to apply, the PC is ' +
  'rolled back to its prior level and success:false is returned with errors[]. Required: ' +
  'actorIdentifier, className. Returns ' +
  '{success, actor (incl. classLevel + classes[]), applied[], needsChoices[], unresolvedScale[], errors[], warnings[]}.';

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
      {
        name: 'level-up-pc',
        description: LEVEL_UP_PC_DESCRIPTION,
        inputSchema: toInputSchema(LevelUpPcSchema),
      },
      {
        name: 'create-pc-from-prefab',
        description: CREATE_PC_FROM_PREFAB_DESCRIPTION,
        inputSchema: toInputSchema(CreatePcFromPrefabSchema),
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

  async handleLevelUpPc(args: any): Promise<any> {
    const parsed = LevelUpPcSchema.parse(args);

    this.logger.info('Leveling up D&D 5e PC', {
      actor: parsed.actorIdentifier,
      className: parsed.className,
      acceptDefaults: parsed.acceptDefaults,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'level-up-pc');
      const result = await this.foundry.call('levelUpPc', parsed);
      this.logger.info('Level-up returned', {
        success: result?.success,
        level: result?.actor?.level,
        needsChoices: result?.needsChoices?.length ?? 0,
      });
      return this.formatLevelUpResponse(result, parsed);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'level-up-pc', 'PC level-up');
    }
  }

  async handleCreatePcFromPrefab(args: any): Promise<any> {
    const parsed = CreatePcFromPrefabSchema.parse(args);

    this.logger.info('Creating D&D 5e PC from prefab', {
      name: parsed.name,
      prefab: parsed.prefab,
      packId: parsed.packId,
      actorId: parsed.actorId,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'create-pc-from-prefab');
      const result = await this.foundry.call('createPcFromPrefab', parsed);
      this.logger.info('PC prefab build returned', {
        success: result?.success,
        actorId: result?.actor?.id,
        from: result?.from,
      });
      return this.formatPrefabResponse(result);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'create-pc-from-prefab', 'PC prefab creation');
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
    // Corrupting advancement failure: the engine refused to persist a broken PC (nothing was created).
    if (result?.success === false && Array.isArray(result?.errors) && result.errors.length > 0) {
      const summary = `❌ "${params.name}" was NOT created — ${result.errors.length} advancement(s) failed`;
      return {
        summary,
        success: false,
        errors: result.errors,
        applied: result.applied ?? [],
        warnings: result.warnings ?? [],
        message:
          `${summary} (nothing was persisted — no junk actor).\n\n${result.errors
            .map((e: string) => `- ${e}`)
            .join('\n')}\n\n` +
          'Fix the inputs (e.g. a bad subclass/choice uuid, or a class/feature the books reject) and ' +
          're-call create-pc.',
      };
    }

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
    if (Array.isArray(actor.classes) && actor.classes.length > 1) {
      lines.splice(
        2,
        0,
        `**Classes:** ${actor.classes.map((c: any) => `${c.name} ${c.levels}`).join(' / ')}`
      );
    }
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

  private formatPrefabResponse(result: any): any {
    const actor = result?.actor ?? {};
    const from = result?.from ?? '—';
    const summary = `✅ PC "${actor.name}" created from prefab "${from}" (${actor.className}${actor.level ? ` ${actor.level}` : ''})`;
    const lines = [
      `**Actor:** ${actor.name} (id: \`${actor.id}\`) — type:character`,
      `**Copied from:** ${from}`,
      `**Build:** ${actor.className}${actor.species ? ` · ${actor.species}` : ''}${actor.background ? ` · ${actor.background}` : ''}${actor.level ? ` (level ${actor.level})` : ''}`,
      `**HP:** ${actor.hp ?? '—'}`,
    ];
    if (Array.isArray(actor.classes) && actor.classes.length > 1) {
      lines.splice(
        3,
        0,
        `**Classes:** ${actor.classes.map((c: any) => `${c.name} ${c.levels}`).join(' / ')}`
      );
    }
    if (actor.folder) lines.push(`**Folder:** ${actor.folder}`);
    const mods = result?.modificationsApplied ?? [];
    if (mods.length) lines.push(`**Modifications applied:** ${mods.join(', ')}`);

    const unresolved = result?.unresolvedScale ?? [];
    const unresolvedSection =
      unresolved.length > 0
        ? `\n\n⚠️ **Unresolved @scale (${unresolved.length})** (unexpected on a real PC):\n${unresolved
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
      from: result?.from,
      actor: result?.actor,
      modificationsApplied: mods,
      unresolvedScale: unresolved,
      warnings,
      message:
        `${summary}\n\n${lines.join('\n')}${unresolvedSection}${warningSection}\n\n` +
        '_Assign the player as owner with set-actor-ownership (the prefab carries the book art already)._',
    };
  }

  private formatLevelUpResponse(result: any, params: any): any {
    // Corrupting advancement failure: the engine rolled the PC back to its prior level.
    if (result?.success === false && Array.isArray(result?.errors) && result.errors.length > 0) {
      const summary = `❌ "${params.actorIdentifier}" was NOT leveled — ${result.errors.length} advancement(s) failed`;
      return {
        summary,
        success: false,
        errors: result.errors,
        applied: result.applied ?? [],
        warnings: result.warnings ?? [],
        message:
          `${summary} (the PC was rolled back to its prior level).\n\n${result.errors
            .map((e: string) => `- ${e}`)
            .join('\n')}\n\n` +
          'Fix the inputs (e.g. a bad subclass/choice uuid) and re-call level-up-pc.',
      };
    }

    // Under-specified (e.g. a subclass pick missing at level 3): nothing was changed.
    if (result?.success === false && Array.isArray(result?.needsChoices)) {
      const lines = result.needsChoices.map((c: any) => this.formatChoiceLine(c));
      const summary = `⚠️ Leveling ${params.className} needs ${result.needsChoices.length} choice(s)`;
      return {
        summary,
        success: false,
        needsChoices: result.needsChoices,
        warnings: result.warnings ?? [],
        message:
          `${summary} — the PC was NOT changed.\n\n${lines.join('\n')}\n\n` +
          'Fill the `choices` map and re-call level-up-pc (or pass acceptDefaults:true).',
      };
    }

    const actor = result?.actor ?? {};
    const classesLine = (actor.classes ?? []).map((c: any) => `${c.name} ${c.levels}`).join(' / ');
    const summary = `✅ "${actor.name}" leveled up: ${actor.className} ${actor.classLevel} (character level ${actor.level})`;
    const lines = [
      `**Actor:** ${actor.name} (id: \`${actor.id}\`)`,
      `**Classes:** ${classesLine || `${actor.className} ${actor.classLevel}`}`,
      `**HP:** ${actor.hp ?? '—'}`,
    ];
    if (Array.isArray(result?.applied)) {
      lines.push(`**Advancements applied this level:** ${result.applied.length}`);
    }

    const unresolved = result?.unresolvedScale ?? [];
    const unresolvedSection =
      unresolved.length > 0
        ? `\n\n⚠️ **Unresolved @scale (${unresolved.length})**:\n${unresolved
            .map((u: any) => `- ${u.itemName}: \`${u.formula}\``)
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
