import { z } from 'zod';
import { Logger } from '../../logger.js';
import { ErrorHandler, FormattedToolError } from '../../utils/error-handler.js';
import { toInputSchema } from '../../utils/schema.js';
import { type DdbCharacterPlan, parseDdbCharacter } from './ddb/parse.js';

// ---------------------------------------------------------------------------
// parse-ddb-character — the deterministic "tool does" half of the DDB import (design.md §7).
//
// It fetches a PUBLIC D&D Beyond character (v5 endpoint) or accepts a pasted/saved JSON blob, then
// runs the pure parser (ddb/parse.ts) to emit a typed, name-bearing, judgment-free DdbCharacterPlan.
// It performs ZERO compendium lookup and never touches Foundry — so it lives Node-side, not in the
// headless page (which cannot reach dndbeyond cross-origin anyway). It deliberately does NOT handle
// the account-password-equivalent cobalt cookie: a PRIVATE character must be made Public or pasted.
// All canonicalization, the STOP-and-ASK gate, and the create-pc build belong to the ddb-import SKILL.
// ---------------------------------------------------------------------------

const V5_ENDPOINT = (id: string) =>
  `https://character-service.dndbeyond.com/character/v5/character/${id}`;

const ParseDdbCharacterSchema = z
  .object({
    characterId: z
      .string()
      .optional()
      .describe('D&D Beyond character id (the digits in the sheet URL, e.g. "167582904").'),
    url: z
      .string()
      .optional()
      .describe('A dndbeyond.com character URL — the id is extracted from it.'),
    json: z
      .any()
      .optional()
      .describe(
        'The raw D&D Beyond v5 character JSON — the full {success, data, …} envelope or the inner ' +
          '`data` object, as a parsed object OR a JSON string. Use this for a PRIVATE character: ask ' +
          'the player to make it Public or paste/save its JSON; the tool never handles a cobalt cookie.'
      ),
  })
  .superRefine((data, ctx) => {
    const n = [data.characterId, data.url, data.json].filter(v => v != null).length;
    if (n !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['characterId'],
        message: 'Provide exactly one of `characterId`, `url`, or `json`.',
      });
    }
  });

const PARSE_DDB_DESCRIPTION =
  'Parse a D&D Beyond character into a normalized, name-bearing plan for the ddb-import skill. ' +
  'Fetches a PUBLIC character by `characterId`/`url` (v5 endpoint) OR accepts pasted `json` (the ' +
  'common case — a PRIVATE character must be set Public or its JSON pasted; this tool NEVER handles ' +
  'a D&D Beyond account cookie). Pure + deterministic: it computes final ability scores (deduping ' +
  "DDB's per-class modifier duplication, resolving choose-an-ability-score, honoring overrides), the " +
  'classes/multiclass + subclasses, species, background, derived proficiencies/expertise/saves/' +
  'languages/tools, resolved option picks (fighting style, favored enemy…), spells (cantrips + ' +
  'prepared/known by name), inventory, feats, currency, HP, art, and an `unresolved[]` list of every ' +
  'homebrew / 2014-legacy / custom entry to STOP-and-ASK about. It emits RAW DDB names, does ZERO ' +
  'compendium lookup, and never invents content (design.md §2.3). The skill then canonicalizes names ' +
  'to premium-2024 entries and drives create-pc. Returns {success, plan, message}.';

function extractId(input: {
  characterId?: string | undefined;
  url?: string | undefined;
}): string | null {
  if (input.characterId && /^\d+$/.test(input.characterId.trim())) return input.characterId.trim();
  const src = input.url ?? input.characterId ?? '';
  const m = src.match(/(\d{4,})/);
  return m ? m[1] : null;
}

export interface DnD5eDdbImportToolsOptions {
  logger: Logger;
}

export class DnD5eDdbImportTools {
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ logger }: DnD5eDdbImportToolsOptions) {
    this.logger = logger.child({ component: 'DnD5eDdbImportTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'parse-ddb-character',
        description: PARSE_DDB_DESCRIPTION,
        inputSchema: toInputSchema(ParseDdbCharacterSchema),
      },
    ];
  }

  async handleParseDdbCharacter(args: any): Promise<any> {
    const parsed = ParseDdbCharacterSchema.parse(args);
    try {
      let payload: any;
      if (parsed.json != null) {
        payload = typeof parsed.json === 'string' ? JSON.parse(parsed.json) : parsed.json;
        this.logger.info('Parsing pasted DDB character JSON');
      } else {
        const id = extractId(parsed);
        if (!id) {
          throw new FormattedToolError(
            'Could not find a character id. Pass `characterId` (the digits in the sheet URL) or a ' +
              'dndbeyond.com character `url`.'
          );
        }
        this.logger.info('Fetching DDB character', { id });
        payload = await this.fetchPublicCharacter(id);
      }

      const plan = parseDdbCharacter(payload);
      return this.formatResponse(plan);
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      if (error instanceof SyntaxError) {
        throw new FormattedToolError(
          `That \`json\` is not valid JSON (${error.message}). Paste the full v5 response or its ` +
            '`data` object.'
        );
      }
      this.errorHandler.handleToolError(error, 'parse-ddb-character', 'DDB parse');
    }
  }

  /** Fetch a PUBLIC character from the v5 endpoint; explain 403 (private) / 404 (missing) clearly. */
  private async fetchPublicCharacter(id: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res: Response;
    try {
      res = await fetch(V5_ENDPOINT(id), {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; fvtt-mcp-molten5e)',
        },
        signal: controller.signal,
      });
    } catch (err: any) {
      throw new FormattedToolError(
        `Could not reach D&D Beyond to fetch character ${id} (${err?.message ?? err}). Check the ` +
          'network, or paste the character JSON as `json` instead.'
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 403) {
      throw new FormattedToolError(
        `D&D Beyond character ${id} is PRIVATE. Ask the player to set its sharing to Public on D&D ` +
          'Beyond (Manage → Character Privacy → Public), or paste/save its JSON and pass it as ' +
          '`json`. This tool never handles a D&D Beyond account cookie.'
      );
    }
    if (res.status === 404) {
      throw new FormattedToolError(
        `No D&D Beyond character with id ${id} (it may have been deleted, or the id is wrong).`
      );
    }
    if (!res.ok) {
      throw new FormattedToolError(
        `D&D Beyond returned HTTP ${res.status} for character ${id}. Try again, or paste its JSON as ` +
          '`json`.'
      );
    }
    return res.json();
  }

  // -------------------------------------------------------------------------
  // Response shaping — a digest for the operator plus the full structured plan for the skill.
  // -------------------------------------------------------------------------

  private formatResponse(plan: DdbCharacterPlan): any {
    const classes = plan.classes
      .map(c => `${c.name} ${c.level}${c.subclass ? ` (${c.subclass})` : ''}`)
      .join(' / ');
    const ab = plan.abilities;
    const abilityLine = `STR ${ab.str} · DEX ${ab.dex} · CON ${ab.con} · INT ${ab.int} · WIS ${ab.wis} · CHA ${ab.cha}`;

    const summary = `📥 Parsed "${plan.name}" — ${classes} (level ${plan.totalLevel}, ${plan.edition})`;

    const lines = [
      `**${plan.name}** — ${classes}`,
      `**Level ${plan.totalLevel}** · ${plan.species.fullName} · ${plan.background.name ?? '(no background)'} · edition: **${plan.edition}**`,
      `**Abilities (final):** ${abilityLine}`,
      `**Spells:** ${plan.spells.cantrips.length} cantrips, ${plan.spells.prepared.length} prepared/known · **Inventory:** ${plan.inventory.length} · **Feats:** ${plan.feats.length}`,
    ];

    if (plan.unresolved.length > 0) {
      const byReason = (r: string) =>
        plan.unresolved.filter(u => u.reason === r).map(u => `${u.kind} "${u.name}"`);
      const groups: string[] = [];
      for (const r of ['homebrew', 'legacy-2014', 'custom'] as const) {
        const g = byReason(r);
        if (g.length) groups.push(`  - **${r}**: ${g.join(', ')}`);
      }
      lines.push(
        `\n⚠️ **STOP-and-ASK — ${plan.unresolved.length} entr${plan.unresolved.length === 1 ? 'y' : 'ies'} need a ruling before building** ` +
          '(canonicalize to a premium-2024 entry, or ask the user — never substitute/invent):\n' +
          groups.join('\n')
      );
    }
    if (plan.abilityNotes.length)
      lines.push(`\n⚠️ Ability notes:\n${plan.abilityNotes.map(n => `  - ${n}`).join('\n')}`);
    if (plan.warnings.length)
      lines.push(`\n⚠️ Warnings:\n${plan.warnings.map(w => `  - ${w}`).join('\n')}`);

    lines.push(
      '\n_Next (ddb-import skill): canonicalize every name to the premium-2024 books via ' +
        'search-compendium, STOP-and-ASK on anything unresolved, then build with create-pc + the PC ' +
        'finishing pass._'
    );

    return { summary, success: true, plan, message: `${summary}\n\n${lines.join('\n')}` };
  }
}
