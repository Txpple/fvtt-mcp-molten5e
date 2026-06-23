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

const resultSchema = z.object({
  text: z
    .string()
    .min(1, 'result text is required')
    .describe('Result text (shown when this entry is rolled).'),
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
});

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

const UpdateRollTableSchema = z.object({
  identifier: z.string().min(1).describe('Table id or exact name.'),
  name: z.string().min(1).optional().describe('New table name.'),
  description: z.string().optional().describe('New description.'),
  formula: z.string().min(1).optional().describe('New roll formula.'),
  replacement: z.boolean().optional().describe('Draw with replacement.'),
  displayRoll: z.boolean().optional().describe('Show the roll when drawing.'),
  results: z.array(resultSchema).optional().describe('If provided, replaces ALL existing results.'),
});

const RollOnTableSchema = z.object({
  identifier: z.string().min(1).describe('Table id or exact name.'),
});

const DeleteRollTableSchema = z.object({
  identifiers: z
    .array(z.string().min(1))
    .min(1)
    .describe('Exact ids (preferred) or exact names of tables to delete.'),
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
          'Create a RollTable from a list of text results. Ranges are auto-assigned from weights ' +
          '(and the formula defaults to 1d<total weight>) unless you provide explicit ranges/formula. ' +
          'Use for random encounter/loot/rumour tables. GM-only.',
        inputSchema: toInputSchema(CreateRollTableSchema),
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
          "Update a RollTable's fields (name, description, formula, replacement, displayRoll) and/or " +
          'replace its entire result set (results). Supplying results deletes existing entries and ' +
          'recreates them with auto-assigned ranges. GM-only.',
        inputSchema: toInputSchema(UpdateRollTableSchema),
      },
      {
        name: 'roll-on-table',
        description:
          'Roll on a RollTable and return the drawn result(s). Evaluates without marking results ' +
          'drawn or posting to chat.',
        inputSchema: toInputSchema(RollOnTableSchema),
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
    return `Updated roll table "${result?.tableName}" (${result?.tableId}) — ${result?.resultCount} result(s).`;
  }

  async handleRollOnTable(args: any): Promise<string> {
    const { identifier } = RollOnTableSchema.parse(args ?? {});
    const result = await this.foundry.call('rollOnTable', { identifier });
    if (result?.rolled === false) {
      return `Roll table not found: "${result?.notFound ?? identifier}".`;
    }
    const texts = (result?.results ?? []).map((r: any) => `"${r.text}"`).join(', ');
    return `Rolled ${result?.total} on "${result?.tableName}" → ${texts || '(no result matched)'}`;
  }

  async handleDeleteRollTable(args: any): Promise<string> {
    const { identifiers } = DeleteRollTableSchema.parse(args ?? {});
    const result = await this.foundry.call('deleteRollTables', { identifiers });
    return formatDeletionResult(result, 'roll table(s)');
  }
}
