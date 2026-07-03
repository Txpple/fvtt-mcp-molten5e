import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { formatDeletionResult } from '../utils/format.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * RollTable tools — create / list / update / roll / delete. Net-new document
 * type for adventure creation (random encounters, loot, rumours, names). Runs
 * over the bridge against live Foundry documents, so the world must be loaded
 * and the headless Foundry client connected. GM-only for writes.
 */

export interface TableToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

const resultSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Literal result text (HTML / @UUID enrichers allowed). Combine with `uuid` via a {{link}} ' +
          'placeholder for mixed loot, e.g. "A pouch holding {{link}} and 2d6 gp".'
      ),
    uuid: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Reference a REAL item by compendium UUID (e.g. ' +
          'Compendium.dnd-dungeon-masters-guide.equipment.Item.<id>) — rendered as a clickable @UUID ' +
          'link, exactly how the published books build loot tables. Premium-book sources only; the ' +
          'tool refuses SRD (dnd5e.*) and unresolvable refs. World-document UUIDs (Item.<id>) are ' +
          'allowed too. Provide `text` OR `uuid` (or both) per result.'
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Display label for the `uuid` link (default: the resolved document name).'),
    weight: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Relative weight (default 1). Determines how many roll values map here.'),
    range: z
      .tuple([z.number().int(), z.number().int()])
      .optional()
      .describe('Explicit [low, high] roll range. Omit to auto-assign from weights.'),
  })
  .refine(
    r =>
      (typeof r.text === 'string' && r.text.trim().length > 0) ||
      (typeof r.uuid === 'string' && r.uuid.trim().length > 0),
    { message: 'each result needs either "text" or "uuid"' }
  );

// Reduce @UUID[uuid]{Label} enricher links to their human label for display (the raw enricher is
// what's stored; this just makes the rolled-result line readable).
function stripUuidEnrichers(text: string): string {
  return (text ?? '').replace(/@UUID\[[^\]]+\]\{([^}]*)\}/g, '$1');
}

// Single source of truth for each tool's input contract: the handler parses with these
// schemas and getToolDefinitions() advertises toInputSchema(...) of the same schema.
const CreateRollTableSchema = z.object({
  name: z.string().min(1).describe('Table name.'),
  description: z.string().optional().describe('Optional table description.'),
  formula: z.string().optional().describe('Roll formula (default 1d<total weight>), e.g. "1d20".'),
  replacement: z.boolean().optional().describe('Draw with replacement (default true).'),
  displayRoll: z.boolean().optional().describe('Show the roll when drawing (default true).'),
  folderName: z
    .string()
    .optional()
    .describe('Optional folder to place the table in (created if absent).'),
  results: z.array(resultSchema).min(1).describe('Table entries.'),
});

const ListRollTablesSchema = z.object({});

// One TARGETED per-entry edit: name the entry by `roll` (die face) or `resultId`, then patch only
// the supplied fields. text/uuid/name REBUILD that entry's content with create-rolltable's exact
// semantics (uuid → validated @UUID link, {{link}} placeholder, SRD refused) — they replace the
// entry's current text, so re-send any @UUID enricher you want kept (get-rolltable shows the raw
// stored text to copy from). weight/range write verbatim; nothing rebalances other entries.
const resultEditSchema = z
  .object({
    roll: z
      .number()
      .int()
      .optional()
      .describe(
        'Target the entry whose roll range covers this die face (e.g. 7 = "entry 07" on a d12). ' +
          'Errors if no entry — or more than one — covers it. Provide roll OR resultId.'
      ),
    resultId: z
      .string()
      .min(1)
      .optional()
      .describe('Target the entry by TableResult id (from get-rolltable) — always unambiguous.'),
    text: z
      .string()
      .min(1)
      .optional()
      .describe(
        "REPLACE this entry's text (HTML / @UUID enrichers allowed — the raw current text is in " +
          'get-rolltable; copy it and change only what you need). Combine with `uuid` via {{link}}.'
      ),
    uuid: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Re-link the entry to a REAL item by compendium/world UUID (premium-book only, SRD ' +
          'refused) — rendered as a clickable @UUID link, alone or into a {{link}} placeholder in `text`.'
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Display label for the `uuid` link (default: the resolved document name).'),
    weight: z.number().int().positive().optional().describe('New relative weight for this entry.'),
    range: z
      .tuple([z.number().int(), z.number().int()])
      .optional()
      .describe(
        'New explicit [low, high] roll range for THIS entry only — other entries are untouched ' +
          '(an introduced overlap/gap is warned, not blocked).'
      ),
  })
  .refine(e => (e.roll !== undefined) !== (e.resultId !== undefined), {
    message: 'target each edit with exactly one of roll or resultId',
  })
  .refine(
    e =>
      e.text !== undefined ||
      e.uuid !== undefined ||
      e.weight !== undefined ||
      e.range !== undefined,
    { message: 'each edit needs at least one of text, uuid, weight, or range' }
  );

const UpdateRollTableSchema = z
  .object({
    identifier: z.string().min(1).describe('Table id or exact name.'),
    name: z.string().min(1).optional().describe('New table name.'),
    description: z.string().optional().describe('New description.'),
    formula: z.string().min(1).optional().describe('New roll formula.'),
    replacement: z.boolean().optional().describe('Draw with replacement.'),
    displayRoll: z.boolean().optional().describe('Show the roll when drawing.'),
    results: z
      .array(resultSchema)
      .optional()
      .describe(
        'DESTRUCTIVE: replaces ALL existing results (deleted + recreated with auto-assigned ' +
          'ranges). To change one entry, use editResults instead.'
      ),
    editResults: z
      .array(resultEditSchema)
      .min(1)
      .optional()
      .describe(
        "TARGETED per-entry edits — fix one entry's text/link/weight/range in place; every other " +
          'entry (ranges, weights, @UUID item links) is left byte-identical. Mutually exclusive ' +
          'with `results`.'
      ),
  })
  .refine(v => !(v.results && v.editResults), {
    message: 'provide results (replace the whole set) OR editResults (targeted edits), not both',
  });

const RollOnTableSchema = z.object({
  identifier: z.string().min(1).describe('Table id or exact name.'),
});

const GetRollTableSchema = z.object({
  identifier: z.string().min(1).describe('Table id or exact name.'),
});

const DeleteRollTableSchema = z.object({
  identifiers: z
    .array(z.string().min(1))
    .min(1)
    .describe('Exact ids (preferred) or exact names of tables to delete.'),
});

const ImportRollTableSchema = z.object({
  packId: z
    .string()
    .min(1)
    .describe('Compendium pack id holding the table (e.g. dnd-dungeon-masters-guide.tables).'),
  itemId: z.string().min(1).describe('The RollTable document id within the pack.'),
  folderName: z
    .string()
    .optional()
    .describe('Optional folder to place the imported table in (created if absent).'),
});

export class TableTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: TableToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'TableTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-rolltable',
        description:
          'Create a RollTable from a list of results. Each result is literal `text` and/or a `uuid` ' +
          'referencing a REAL premium-book item (rendered as a clickable @UUID link — the way the ' +
          'published loot tables are built; SRD refs are refused). Ranges are auto-assigned from ' +
          'weights (and the formula defaults to 1d<total weight>) unless you provide explicit ' +
          'ranges/formula. Use for random encounter/loot/rumour/treasure tables. GM-only.',
        inputSchema: toInputSchema(CreateRollTableSchema),
      },
      {
        name: 'import-rolltable',
        description:
          'Copy a whole RollTable from a compendium pack into the world (e.g. a DMG treasure / ' +
          'magic-item table). Roll tables are world-only at roll time, so a published table must be ' +
          'imported before roll-on-table can use it; the embedded results — including their @UUID ' +
          'item links — come along intact. Premium-book packs only (SRD refused). GM-only.',
        inputSchema: toInputSchema(ImportRollTableSchema),
      },
      {
        name: 'list-rolltables',
        description:
          'List RollTable documents with id, name, formula, result count, and description.',
        inputSchema: toInputSchema(ListRollTablesSchema),
      },
      {
        name: 'update-rolltable',
        description:
          "Update a RollTable's fields (name, description, formula, replacement, displayRoll) " +
          'and/or its entries, two ways: `editResults` = TARGETED per-entry edits — name an entry ' +
          'by its roll face (e.g. 7 on a d12) or resultId (from get-rolltable) and patch just its ' +
          'text, linked uuid, weight, and/or range; every OTHER entry (ranges, weights, @UUID item ' +
          'links) stays byte-identical — the right way to fix a typo on one entry of a tuned table. ' +
          "text/uuid REPLACE that entry's content (copy the raw text from get-rolltable and change " +
          'only what you need). `results` = DESTRUCTIVE whole-set replace (all entries deleted and ' +
          'recreated with auto-assigned ranges). Bad edits are isolated + reported; an introduced ' +
          'range overlap/gap is warned. GM-only.',
        inputSchema: toInputSchema(UpdateRollTableSchema),
      },
      {
        name: 'roll-on-table',
        description:
          'Roll on a world RollTable and return the drawn result(s). Evaluates without marking ' +
          'results drawn or posting to chat. Any @UUID item links in a drawn result are surfaced as ' +
          'importable (uuid + label) so loot can be pulled into the world. (World tables only — copy ' +
          'a compendium/DMG table in first with import-rolltable.)',
        inputSchema: toInputSchema(RollOnTableSchema),
      },
      {
        name: 'get-rolltable',
        description:
          "Read a RollTable's FULL contents — every entry with its roll range, weight, drawn flag, the " +
          'result text (HTML/@UUID enrichers intact), and any linked items surfaced as uuid + label — ' +
          'sorted low-to-high so a d<N> table reads 1..N. The deterministic way to inspect or audit a ' +
          "table's entries without brute-force rolling (list-rolltables gives only a per-table summary; " +
          'roll-on-table draws one random entry). Resolves by id or exact name.',
        inputSchema: toInputSchema(GetRollTableSchema),
      },
      {
        name: 'delete-rolltable',
        description:
          'Permanently delete one or more RollTable documents by exact id or exact name. STRICT ' +
          'resolution — no fuzzy/substring matching. GM-only.',
        inputSchema: toInputSchema(DeleteRollTableSchema),
      },
    ];
  }

  async handleCreateRollTable(args: any): Promise<string> {
    const parsed = CreateRollTableSchema.parse(args ?? {});
    const result = await this.foundry.call('createRollTable', parsed);
    return (
      `Created roll table "${result?.tableName}" (${result?.tableId}) — formula ${result?.formula}, ` +
      `${result?.resultCount} result(s).`
    );
  }

  async handleImportRollTable(args: any): Promise<string> {
    const parsed = ImportRollTableSchema.parse(args ?? {});
    const result = await this.foundry.call('importRollTable', parsed);
    return (
      `Imported roll table "${result?.tableName}" (${result?.tableId}) — formula ${result?.formula}, ` +
      `${result?.resultCount} result(s). Roll it with roll-on-table.`
    );
  }

  async handleListRollTables(_args: any): Promise<string> {
    const tables = (await this.foundry.call('listRollTables', {})) ?? [];
    if (!Array.isArray(tables) || tables.length === 0) return 'No roll tables found.';
    const lines = tables.map(
      (t: any) => `  - "${t.name}" (${t.id}) — ${t.formula}, ${t.resultCount} result(s)`
    );
    return `Roll tables (${tables.length}):\n${lines.join('\n')}`;
  }

  async handleUpdateRollTable(args: any): Promise<string> {
    const parsed = UpdateRollTableSchema.parse(args ?? {});
    const result = await this.foundry.call('updateRollTable', parsed);
    if (result?.updated === false) {
      return `Roll table not found: "${result?.notFound ?? parsed.identifier}". Nothing changed.`;
    }
    let out = `Updated roll table "${result?.tableName}" (${result?.tableId}) — ${result?.resultCount} result(s)`;
    if (typeof result?.edited === 'number') {
      out += `, ${result.edited} entr${result.edited === 1 ? 'y' : 'ies'} edited in place`;
    }
    out += '.';
    const errs = Array.isArray(result?.errors) ? result.errors : [];
    if (errs.length > 0) out += errs.map((e: string) => `\n  ⚠ ${e}`).join('');
    const warns = Array.isArray(result?.warnings) ? result.warnings : [];
    if (warns.length > 0) {
      out += `\n\n⚠️ ${warns.length} warning(s):\n${warns.map((w: string) => `- ${w}`).join('\n')}`;
    }
    return out;
  }

  async handleRollOnTable(args: any): Promise<string> {
    const { identifier } = RollOnTableSchema.parse(args ?? {});
    const result = await this.foundry.call('rollOnTable', { identifier });
    if (result?.rolled === false) {
      return `Roll table not found: "${result?.notFound ?? identifier}".`;
    }
    const drawn = result?.results ?? [];
    const texts = drawn
      .map((r: any) => `"${stripUuidEnrichers(r.text ?? r.description ?? '')}"`)
      .join(', ');
    const links = drawn.flatMap((r: any) => r.links ?? []);
    let out = `Rolled ${result?.total} on "${result?.tableName}" → ${texts || '(no result matched)'}`;
    if (links.length > 0) {
      out += `\n  importable: ${links.map((l: any) => `${l.label} [${l.uuid}]`).join('; ')}`;
    }
    return out;
  }

  async handleGetRollTable(args: any): Promise<string> {
    const { identifier } = GetRollTableSchema.parse(args ?? {});
    const t: any = await this.foundry.call('getRollTable', { identifier });
    if (!t || t.found === false) {
      return `Roll table not found: "${t?.notFound ?? identifier}".`;
    }
    const results = Array.isArray(t.results) ? t.results : [];
    const meta =
      `[replacement ${t.replacement === false ? 'off' : 'on'}, ` +
      `displayRoll ${t.displayRoll === false ? 'off' : 'on'}]`;
    let out = `Roll table "${t.name}" (${t.id}) — ${t.formula}, ${results.length} result(s) ${meta}`;
    const desc = stripUuidEnrichers(t.description ?? '').trim();
    if (desc) out += `\n${desc}`;
    for (const r of results) {
      const lo = r?.range?.[0];
      const hi = r?.range?.[1];
      const label = lo === hi ? `${lo}` : `${lo}-${hi}`;
      out += `\n  [${label}] ${stripUuidEnrichers(r?.text ?? '')}`;
      const links = Array.isArray(r?.links) ? r.links : [];
      if (links.length > 0) {
        out += `\n      → ${links.map((l: any) => `${l.label} [${l.uuid}]`).join('; ')}`;
      }
    }
    return out;
  }

  async handleDeleteRollTable(args: any): Promise<string> {
    const { identifiers } = DeleteRollTableSchema.parse(args ?? {});
    const result = await this.foundry.call('deleteRollTables', { identifiers });
    return formatDeletionResult(result, 'roll table(s)');
  }
}
