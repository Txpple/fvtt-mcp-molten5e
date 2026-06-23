import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { formatDeletionResult } from '../utils/format.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * Organization & batch tools — create-folder, move-documents, bulk-delete.
 * General-purpose document wrangling across every world collection (Actor,
 * Item, JournalEntry, Scene, RollTable, Cards, Playlist, Macro). Runs over the
 * bridge; GM-only for writes. delete-folder lives in actor-creation.ts.
 */

export interface OrganizationToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

const DOC_TYPES = [
  'Actor',
  'Item',
  'JournalEntry',
  'Scene',
  'RollTable',
  'Cards',
  'Playlist',
  'Macro',
] as const;

// Single source of truth for each tool's input contract: the handlers parse with these schemas
// and getToolDefinitions() advertises toInputSchema(...) of the same schema. Descriptions are
// copied verbatim from the previous hand-written JSON Schema; only `.describe()` is added.
const CreateFolderSchema = z.object({
  name: z.string().min(1).describe('Folder name.'),
  type: z
    .enum(DOC_TYPES)
    .describe('Document type this folder holds (Actor, Item, JournalEntry, …).'),
  parentFolder: z
    .string()
    .optional()
    .describe('Optional parent folder id or exact name (must be the same type).'),
  color: z.string().optional().describe('Optional hex color, e.g. "#4a90e2".'),
});

const MoveDocumentsSchema = z.object({
  documentType: z.enum(DOC_TYPES).describe('Type of the documents being moved.'),
  identifiers: z
    .array(z.string().min(1))
    .min(1)
    .describe('Exact ids (preferred) or exact names of documents to move.'),
  targetFolder: z
    .string()
    .optional()
    .describe('Target folder id or name (created at root if missing). Empty = root.'),
});

const BulkDeleteSchema = z.object({
  documentType: z.enum(DOC_TYPES).describe('Type of the documents being deleted.'),
  identifiers: z
    .array(z.string().min(1))
    .min(1)
    .describe('Exact ids (preferred) or exact names to delete.'),
});

export class OrganizationTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: OrganizationToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'OrganizationTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-folder',
        description:
          'Create a sidebar Folder for any world document type, optionally nested under a parent ' +
          'folder of the same type. Use to organize generated content. GM-only.',
        inputSchema: toInputSchema(CreateFolderSchema),
      },
      {
        name: 'move-documents',
        description:
          'Move one or more world documents of a single type into a target folder (resolved by id ' +
          'or name; created at root if absent). Pass an empty targetFolder to move them to the root. ' +
          'GM-only.',
        inputSchema: toInputSchema(MoveDocumentsSchema),
      },
      {
        name: 'bulk-delete',
        description:
          'Permanently delete many world documents of a single type by exact id or exact name. ' +
          'STRICT resolution — no fuzzy/substring matching. For folders use delete-folder. GM-only.',
        inputSchema: toInputSchema(BulkDeleteSchema),
      },
    ];
  }

  async handleCreateFolder(args: any): Promise<string> {
    const parsed = CreateFolderSchema.parse(args ?? {});
    const result = await this.foundry.call('createFolder', parsed);
    return `Created ${result?.type} folder "${result?.folderName}" (${result?.folderId}).`;
  }

  async handleMoveDocuments(args: any): Promise<string> {
    const parsed = MoveDocumentsSchema.parse(args ?? {});
    const result = await this.foundry.call('moveDocuments', parsed);
    const dest = result?.targetFolderName
      ? `"${result.targetFolderName}" (${result.targetFolderId})`
      : 'root';
    const notFound =
      result?.notFound && result.notFound.length > 0
        ? `\n  not found: ${result.notFound.join(', ')}`
        : '';
    return `Moved ${result?.movedCount ?? 0} ${parsed.documentType} document(s) → ${dest}.${notFound}`;
  }

  async handleBulkDelete(args: any): Promise<string> {
    const parsed = BulkDeleteSchema.parse(args ?? {});
    const result = await this.foundry.call('bulkDelete', parsed);
    return formatDeletionResult(result, `${parsed.documentType} document(s)`);
  }
}
