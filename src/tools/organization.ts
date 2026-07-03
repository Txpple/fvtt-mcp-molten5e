import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { formatDeletionResult } from '../utils/format.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * Organization & batch tools — list-folders (the read/inspect step), create-folder,
 * update-folder, move-documents, bulk-delete. General-purpose document wrangling across
 * every world collection (Actor, Item, JournalEntry, Scene, RollTable, Cards, Playlist,
 * Macro). Runs over the bridge; GM-only for writes. delete-folder lives in actor-creation.ts.
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
const ListFoldersSchema = z.object({
  type: z
    .enum(DOC_TYPES)
    .optional()
    .describe('Filter to one document type (Actor, Scene, …). Omit for the whole sidebar.'),
});

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

const UpdateFolderSchema = z
  .object({
    identifier: z.string().min(1).describe('Folder id or exact name to update.'),
    type: z
      .enum(DOC_TYPES)
      .default('Actor')
      .describe('Folder document type (needed to resolve by name; default Actor).'),
    name: z.string().min(1).optional().describe('New folder name (rename).'),
    color: z.string().optional().describe('New hex color, e.g. "#4a90e2".'),
    parentFolder: z
      .string()
      .optional()
      .describe('Reparent under this folder id or exact name (same type). "" = move to root.'),
  })
  .refine(v => v.name !== undefined || v.color !== undefined || v.parentFolder !== undefined, {
    message: 'Provide at least one of: name, color, parentFolder',
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
  dryRun: z
    .boolean()
    .default(false)
    .describe(
      'Preview only: report exactly which documents WOULD be deleted (and which were not found) ' +
        'without deleting anything. Run a dry-run first to confirm an irreversible bulk delete.'
    ),
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
        name: 'list-folders',
        description:
          'Read the sidebar folder TREE — every world folder (or one document type) in tree order ' +
          'with its id, nesting depth + "/"-joined path, hex color, parent, direct document count, ' +
          'and subfolder count. The inspect step the folder tools were missing: find the ids/names ' +
          'for update-folder (rename/recolor/reparent), delete-folder, move-documents, and the ' +
          'folder params on the create tools — without guessing what exists. Read-only.',
        inputSchema: toInputSchema(ListFoldersSchema),
      },
      {
        name: 'create-folder',
        description:
          'Create a sidebar Folder for any world document type, optionally nested under a parent ' +
          'folder of the same type. Use to organize generated content. GM-only.',
        inputSchema: toInputSchema(CreateFolderSchema),
      },
      {
        name: 'update-folder',
        description:
          'Update a sidebar Folder in place — rename it, recolor it, and/or reparent it (nest under ' +
          'another folder of the same type, or pass parentFolder:"" to move it to the root). Resolves ' +
          'the folder by exact id or exact name+type. Use this to RENAME a folder without the ' +
          'move-documents + delete-folder dance. GM-only.',
        inputSchema: toInputSchema(UpdateFolderSchema),
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
          'STRICT resolution — no fuzzy/substring matching. IRREVERSIBLE — pass dryRun:true first to ' +
          'preview exactly what would be deleted. For folders use delete-folder. GM-only.',
        inputSchema: toInputSchema(BulkDeleteSchema),
      },
    ];
  }

  async handleListFolders(args: any): Promise<string> {
    const parsed = ListFoldersSchema.parse(args ?? {});
    const result: any = await this.foundry.call('listFolders', parsed);
    const folders: any[] = Array.isArray(result?.folders) ? result.folders : [];
    if (folders.length === 0) {
      return parsed.type ? `No ${parsed.type} folders exist.` : 'No folders exist.';
    }
    const types: string[] = Array.isArray(result?.types) ? result.types : [];
    const lines: string[] = [`Folders (${folders.length} across ${types.length} type(s)):`];
    for (const t of types) {
      const ofType = folders.filter(f => f.type === t);
      lines.push(`\n${t} (${ofType.length}):`);
      for (const f of ofType) {
        const bits = [
          f.color ? `${f.color}` : null,
          `${f.documentCount} doc(s)`,
          f.subfolderCount > 0 ? `${f.subfolderCount} subfolder(s)` : null,
          f.orphaned ? 'ORPHANED (dangling parent)' : null,
        ].filter(Boolean);
        lines.push(`${'  '.repeat(f.depth + 1)}- "${f.name}" (${f.id}) — ${bits.join(', ')}`);
      }
    }
    return lines.join('\n');
  }

  async handleCreateFolder(args: any): Promise<string> {
    const parsed = CreateFolderSchema.parse(args ?? {});
    const result = await this.foundry.call('createFolder', parsed);
    return `Created ${result?.type} folder "${result?.folderName}" (${result?.folderId}).`;
  }

  async handleUpdateFolder(args: any): Promise<string> {
    const parsed = UpdateFolderSchema.parse(args ?? {});
    const result = await this.foundry.call('updateFolder', parsed);
    if (result?.updated === false) {
      return `Folder not found: "${result?.notFound ?? parsed.identifier}" (type ${parsed.type}). Nothing changed.`;
    }
    return `Updated ${result?.folder?.type} folder → "${result?.folder?.name}" (${result?.folder?.id}).`;
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
    const result: any = await this.foundry.call('bulkDelete', parsed);
    if (result?.dryRun) {
      const would = result.wouldDelete ?? [];
      const lines = would.map((d: any) => `  - ${d.name || '(unnamed)'} (${d.id})`).join('\n');
      const notFound =
        result.notFound && result.notFound.length > 0
          ? `\n  not found: ${result.notFound.join(', ')}`
          : '';
      return would.length
        ? `Dry run — would delete ${would.length} ${parsed.documentType} document(s):\n${lines}${notFound}\n\nRe-run without dryRun to delete them (IRREVERSIBLE).`
        : `Dry run — nothing matched.${notFound}`;
    }
    return formatDeletionResult(result, `${parsed.documentType} document(s)`);
  }
}
