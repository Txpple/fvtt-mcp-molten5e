import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { ErrorHandler, FormattedToolError } from '../utils/error-handler.js';
import { toInputSchema } from '../utils/schema.js';
// Journal STRUCTURING (typed blocks -> styled HTML) lives in ./journal/blocks (pure). The skill
// supplies the words as blocks; this class arranges/styles them. No prose is generated here — the
// former quest/quest-content.ts prose generators were deleted (design.md §2.1 / Invariant 1).
import { renderStyledHtml, blockSchema, type Block } from './journal/blocks.js';

// Single source of truth for each tool's input contract: the handler parses with these
// schemas and getToolDefinitions() advertises toInputSchema(...) of the same schema.

// A journal page = a name + ordered typed blocks (the skill's words) + optional player visibility.
// The tool renders the blocks into the `.mcp-journal` house style; it NEVER generates the words.
const journalPageSchema = z.object({
  name: z.string().min(1).describe('Page title (the tab name in the journal).'),
  playerVisible: z
    .boolean()
    .optional()
    .describe('If true, players can OBSERVE this page (a handout). Default: GM-only.'),
  blocks: z
    .array(blockSchema)
    .min(1)
    .describe(
      'Ordered typed blocks that ARE the page body — heading / lead / paragraph / readaloud ' +
        '(boxed player text) / gmnote (GM-only box) / list / grid / html. You supply the words; the ' +
        'tool styles them.'
    ),
});

const CreateQuestJournalSchema = z.object({
  title: z.string().min(1, 'Title is required').describe('Journal entry name.'),
  pages: z
    .array(journalPageSchema)
    .min(1)
    .describe(
      'Ordered pages (e.g. a player Handout page + a GM Notes page), each a list of blocks.'
    ),
  folderName: z
    .string()
    .optional()
    .describe('Optional folder to organize the journal into (created if it does not exist).'),
});

const LinkQuestToNPCSchema = z.object({
  journalId: z.string().min(1, 'Journal ID is required').describe('ID of the quest journal entry.'),
  npcName: z
    .string()
    .min(1, 'NPC name is required')
    .describe('Name (or id) of a REAL world Actor to link. Must resolve — a dead link is refused.'),
  relationship: z
    .enum(['questGiver', 'target', 'ally', 'enemy', 'contact'])
    .describe('Relationship between the NPC and the quest.'),
  pageId: z
    .string()
    .optional()
    .describe('Page to add the link to (id from list-journals). Omit to use the first text page.'),
});

const UpdateQuestJournalSchema = z.object({
  journalId: z
    .string()
    .min(1, 'Journal ID is required')
    .describe('ID of the quest journal to update.'),
  blocks: z
    .array(blockSchema)
    .min(1)
    .describe(
      'Typed blocks to APPEND as a new styled section (e.g. a heading "Session 3 — date" + ' +
        'paragraphs). You supply the words; the tool styles them. Include a heading block to label it.'
    ),
  pageId: z
    .string()
    .optional()
    .describe('Page to append to (id from list-journals). Omit to use the first text page.'),
  newPageName: z
    .string()
    .optional()
    .describe('If set (without pageId), create a NEW page with this name from the blocks instead.'),
});

const ListJournalsSchema = z.object({
  filterQuests: z
    .boolean()
    .optional()
    .default(false)
    .describe('Only show journals that appear to be quest-related (default: false)'),
  includeContent: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include journal content preview (default: false)'),
  journalId: z
    .string()
    .optional()
    .describe(
      "If provided, read this journal's content instead of listing all journals. Returns full page content and a list of all pages in the journal."
    ),
  pageId: z
    .string()
    .optional()
    .describe(
      "If provided with journalId, read this specific page's content. Get page IDs from the pages array returned when listing journals or reading a journal."
    ),
});

const SearchJournalsSchema = z.object({
  searchQuery: z
    .string()
    .min(1, 'Search query is required')
    .describe('Text to search for in journal entries'),
  searchType: z
    .enum(['title', 'content', 'both'])
    .optional()
    .default('both')
    .describe('Where to search (default: both)'),
});

const CreateJournalSchema = z.object({
  name: z.string().min(1, 'Journal name is required').describe('Journal entry name.'),
  pages: z
    .array(
      z.object({
        name: z.string().min(1, 'Page name is required').describe('Page title.'),
        content: z.string().optional().default('').describe('HTML content for the page.'),
        playerVisible: z
          .boolean()
          .optional()
          .describe('If true, players can OBSERVE this page (a handout). Default: GM-only.'),
      })
    )
    .min(1, 'At least one page is required')
    .describe('Ordered text pages. Each needs a name; content is HTML (may be empty).'),
  folderName: z
    .string()
    .optional()
    .describe('Optional folder to place the journal in (created if absent).'),
});

const UpdateJournalSchema = z
  .object({
    journalId: z
      .string()
      .min(1, 'Journal ID is required')
      .describe('Journal entry id or exact name.'),
    name: z.string().optional().describe('New journal entry name (rename).'),
    content: z
      .string()
      .optional()
      .describe('HTML content to set on the target page (replaces existing content).'),
    pageId: z
      .string()
      .optional()
      .describe('Target a specific page by id (get ids from list-journals).'),
    newPageName: z
      .string()
      .optional()
      .describe('If set (without pageId), create a new page with this name from content.'),
  })
  .refine(v => v.name !== undefined || v.content !== undefined, {
    message: 'Provide at least one of: name, content',
  });

const DeleteJournalSchema = z.object({
  identifiers: z
    .array(z.string().min(1))
    .min(1, 'At least one identifier is required')
    .describe('Exact ids (preferred) or exact names of journals to delete.'),
});

export interface QuestCreationToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class QuestCreationTools {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor(options: QuestCreationToolsOptions) {
    this.foundry = options.foundry;
    this.logger = options.logger;
    this.errorHandler = new ErrorHandler(this.logger);
  }

  /**
   * Get all tool definitions for MCP registration
   */
  getToolDefinitions() {
    return [
      {
        name: 'create-quest-journal',
        description:
          'Create a multi-page journal (quest log, handout, lore, GM notes) from STRUCTURED typed ' +
          'blocks — a STRUCTURING tool, it never writes the words. You pass pages of blocks (heading / ' +
          'lead / paragraph / readaloud / gmnote / list / grid / html); the tool renders them in the ' +
          'house style and sets per-page visibility (playerVisible -> players can observe a handout; ' +
          "omit -> GM-only). Compose the prose yourself (that's the journal-builder skill's job). For " +
          'plain raw-HTML pages use create-journal instead.',
        inputSchema: toInputSchema(CreateQuestJournalSchema),
      },
      {
        name: 'link-quest-to-npc',
        description:
          'Append a link from a quest journal to a REAL world NPC: resolves the actor, inserts a ' +
          'Foundry @UUID[Actor.id]{Name} enricher link (clickable on render) in a GM note, labelled ' +
          'with the relationship. Refuses an unknown NPC (no dead links) — create the actor first.',
        inputSchema: toInputSchema(LinkQuestToNPCSchema),
      },
      {
        name: 'update-quest-journal',
        description:
          'Append a new styled section to a quest/journal page from typed blocks (e.g. a heading ' +
          '"Session 3" + paragraphs of what happened) — the §8 session-log/progress path. You supply ' +
          'the words as blocks; the tool styles + appends them. By default appends to the first text ' +
          'page; use pageId to target a page, or newPageName to start a new page. Structuring only.',
        inputSchema: toInputSchema(UpdateQuestJournalSchema),
      },
      {
        name: 'list-journals',
        description:
          "List all journal entries, or read a specific journal/page. Without parameters: lists all journals with their pages (id, name, type). With journalId: reads the journal's first text page content and shows all available pages. With journalId + pageId: reads a specific page's full content.",
        inputSchema: toInputSchema(ListJournalsSchema),
      },
      {
        name: 'search-journals',
        description:
          'Search through all pages of all journal entries for specific content or keywords. Returns which specific page matched, so you can read it with list-journals using journalId + pageId.',
        inputSchema: toInputSchema(SearchJournalsSchema),
      },
      {
        name: 'create-journal',
        description:
          'Create a generic multi-page JournalEntry from caller-supplied text pages. Unlike ' +
          'create-quest-journal (which generates styled quest content and auto-folders), this takes ' +
          'an explicit pages array of {name, content} and only folders the entry when folderName is ' +
          'given. Page content is HTML (Foundry v13 ProseMirror). GM-only.',
        inputSchema: toInputSchema(CreateJournalSchema),
      },
      {
        name: 'update-journal',
        description:
          'Generic JournalEntry update: rename the entry (name) and/or set page content. Content ' +
          'replaces the target page — pass pageId to target a specific page, newPageName to add a new ' +
          'page, or neither to update the first text page. For quest-style append updates use ' +
          'update-quest-journal instead. GM-only.',
        inputSchema: toInputSchema(UpdateJournalSchema),
      },
      {
        name: 'delete-journal',
        description:
          'Permanently delete one or more JournalEntry documents by exact id or exact name. STRICT ' +
          'resolution — no fuzzy/substring matching. GM-only.',
        inputSchema: toInputSchema(DeleteJournalSchema),
      },
    ];
  }

  /**
   * Handle create quest journal request
   */
  async handleCreateQuestJournal(args: any): Promise<any> {
    try {
      const request = CreateQuestJournalSchema.parse(args);

      // STRUCTURE the caller's blocks into styled HTML; map playerVisible -> per-page ownership
      // (2 = players observe a handout). The words are the caller's blocks — no prose generated here.
      const pages = request.pages.map(p => ({
        name: p.name,
        content: renderStyledHtml(p.blocks),
        ...(p.playerVisible ? { ownership: { default: 2 } } : {}),
      }));

      const result = await this.foundry.call('createJournal', {
        name: request.title,
        pages,
        ...(request.folderName ? { folderName: request.folderName } : {}),
      });

      if (!result || result.error) {
        throw new Error(result?.error || 'Failed to create journal');
      }

      return {
        success: true,
        journalId: result.id,
        journalName: result.name,
        pageCount: result.pageCount,
        pages: result.pages,
        message: `Journal "${result.name}" created with ${result.pageCount} page(s).`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'create-quest-journal', 'quest creation');
    }
  }

  /**
   * Handle link quest to NPC request
   */
  async handleLinkQuestToNPC(args: any): Promise<any> {
    try {
      const request = LinkQuestToNPCSchema.parse(args);

      // Resolve the NPC to a REAL Actor — a quest link must point at a live document, never a dead
      // name (ask-don't-invent). findActor returns { id, name } or null.
      const actor = (await this.foundry.call('findActor', {
        identifier: request.npcName,
      })) as { id?: string; name?: string } | null;
      if (!actor?.id) {
        throw new FormattedToolError(
          `NPC "${request.npcName}" not found in the world — create the actor first (or check the ` +
            'name). A quest link must point at a real Actor; I will not insert a dead reference.'
        );
      }

      // Build a Foundry @UUID enricher link (clickable on render) inside a GM note, labelled with the
      // relationship. This is STRUCTURE (a real document link), not prose.
      const link = `@UUID[Actor.${actor.id}]{${actor.name ?? request.npcName}}`;
      const relationshipText = request.relationship
        .replace(/([A-Z])/g, ' $1')
        .toLowerCase()
        .trim();
      const linkBlocks: Block[] = [
        {
          type: 'gmnote',
          html: `<p><strong>Related NPC:</strong> ${link} — ${relationshipText}</p>`,
        },
      ];

      const current = await this.readPageContent(request.journalId, request.pageId);
      const result = await this.foundry.call('updateJournalContent', {
        journalId: request.journalId,
        content: current + renderStyledHtml(linkBlocks),
        ...(request.pageId ? { pageId: request.pageId } : {}),
      });
      if (!result || result.error || !result.success) {
        throw new Error(result?.error || 'Failed to add the NPC link');
      }

      return {
        success: true,
        npc: { id: actor.id, name: actor.name ?? request.npcName },
        link,
        message: `Linked ${actor.name ?? request.npcName} to the quest as ${relationshipText}.`,
      };
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'link-quest-to-npc', 'linking quest to NPC');
    }
  }

  /**
   * Append a new styled section (from typed blocks) to a quest/journal page — the progress / §8
   * session-log path. Structuring only: the words are the caller's blocks; the tool styles + appends.
   */
  async handleUpdateQuestJournal(args: any): Promise<any> {
    try {
      const request = UpdateQuestJournalSchema.parse(args);
      const sectionHtml = renderStyledHtml(request.blocks);

      // New page: set its content directly (nothing to append to).
      if (request.newPageName) {
        const result = await this.foundry.call('updateJournalContent', {
          journalId: request.journalId,
          content: sectionHtml,
          newPageName: request.newPageName,
        });
        if (!result || result.error || !result.success) {
          throw new Error(result?.error || 'Failed to create the new page');
        }
        return {
          success: true,
          message: `New page "${request.newPageName}" added.`,
          pageId: result.pageId,
          pageName: result.pageName,
        };
      }

      // Existing page: append the new styled section after the current content.
      const current = await this.readPageContent(request.journalId, request.pageId);
      const result = await this.foundry.call('updateJournalContent', {
        journalId: request.journalId,
        content: current + sectionHtml,
        ...(request.pageId ? { pageId: request.pageId } : {}),
      });
      if (!result || result.error || !result.success) {
        throw new Error(result?.error || 'Failed to append the section');
      }
      return {
        success: true,
        message: 'Appended a new section to the journal page.',
        pageId: result.pageId,
        pageName: result.pageName,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'update-quest-journal', 'journal update');
    }
  }

  /** Read a journal page's current HTML (a specific page by id, else the first text page). */
  private async readPageContent(journalId: string, pageId?: string): Promise<string> {
    if (pageId) {
      const pageResult = await this.foundry.call('getJournalPageContent', { journalId, pageId });
      if (!pageResult || pageResult.error) throw new Error(`Page not found: ${pageId}`);
      return pageResult.content || '';
    }
    const journal = await this.foundry.call('getJournalContent', { journalId });
    if (!journal || journal.error) throw new Error(`Journal not found: ${journalId}`);
    return journal.content || '';
  }

  /**
   * Handle list journals request
   */
  async handleListJournals(args: any): Promise<any> {
    try {
      const request = ListJournalsSchema.parse(args);

      // Mode: Read a specific page
      if (request.journalId && request.pageId) {
        const pageResult = await this.foundry.call('getJournalPageContent', {
          journalId: request.journalId,
          pageId: request.pageId,
        });

        if (!pageResult || pageResult.error) {
          throw new Error(pageResult?.error || 'Page not found');
        }

        return {
          success: true,
          mode: 'page',
          journalId: request.journalId,
          page: pageResult,
        };
      }

      // Mode: Read a specific journal (first page + page manifest)
      if (request.journalId) {
        const journalContent = await this.foundry.call('getJournalContent', {
          journalId: request.journalId,
        });

        if (!journalContent || journalContent.error) {
          throw new Error(journalContent?.error || 'Journal not found');
        }

        return {
          success: true,
          mode: 'journal',
          journalId: request.journalId,
          content: journalContent.content,
          currentPage: journalContent.currentPage,
          allPages: journalContent.allPages,
          pageCount: journalContent.pageCount,
          note: journalContent.note,
        };
      }

      // Mode: List all journals
      const journals = await this.foundry.call('listJournals', {});

      if (!journals || journals.error) {
        throw new Error('Failed to retrieve journals');
      }

      let filteredJournals = journals;

      // Filter for quest-related journals if requested
      if (request.filterQuests) {
        filteredJournals = journals.filter((journal: any) => this.isQuestRelated(journal.name));
      }

      // Include content if requested
      if (request.includeContent) {
        for (const journal of filteredJournals) {
          try {
            const content = await this.foundry.call('getJournalContent', {
              journalId: journal.id,
            });
            journal.contentPreview = `${content?.content?.substring(0, 150)}...` || '';
          } catch (_error) {
            journal.contentPreview = 'Error loading content';
          }
        }
      }

      return {
        success: true,
        mode: 'list',
        journals: filteredJournals,
        total: filteredJournals.length,
        filtered: request.filterQuests,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'list-journals', 'journal listing');
    }
  }

  /**
   * Handle search journals request
   */
  async handleSearchJournals(args: any): Promise<any> {
    try {
      const request = SearchJournalsSchema.parse(args);

      // Get all journals (now includes page metadata)
      const journals = await this.foundry.call('listJournals', {});

      if (!journals || journals.error) {
        throw new Error('Failed to retrieve journals');
      }

      const searchResults = [];
      const query = request.searchQuery.toLowerCase();

      for (const journal of journals) {
        let matches = false;
        const matchInfo: any = {
          id: journal.id,
          name: journal.name,
          pageCount: journal.pageCount || 0,
          matchType: [],
          matchedPages: [],
        };

        // Search title
        if (request.searchType === 'title' || request.searchType === 'both') {
          if (journal.name.toLowerCase().includes(query)) {
            matches = true;
            matchInfo.matchType.push('title');
          }
        }

        // Search content across ALL pages
        if (request.searchType === 'content' || request.searchType === 'both') {
          const pages = journal.pages || [];
          for (const page of pages) {
            if (page.type !== 'text') continue;
            try {
              const pageContent = await this.foundry.call('getJournalPageContent', {
                journalId: journal.id,
                pageId: page.id,
              });

              if (pageContent?.content?.toLowerCase().includes(query)) {
                matches = true;
                if (!matchInfo.matchType.includes('content')) {
                  matchInfo.matchType.push('content');
                }
                matchInfo.matchedPages.push({
                  pageId: page.id,
                  pageName: page.name,
                  contentSnippet: this.extractSnippet(pageContent.content, request.searchQuery),
                });
              }
            } catch (_error) {
              // Skip pages with content errors
            }
          }
        }

        if (matches) {
          searchResults.push(matchInfo);
        }
      }

      return {
        success: true,
        searchQuery: request.searchQuery,
        searchType: request.searchType,
        results: searchResults,
        totalMatches: searchResults.length,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'search-journals', 'journal search');
    }
  }

  /**
   * Handle create generic journal request
   */
  async handleCreateJournal(args: any): Promise<any> {
    try {
      const request = CreateJournalSchema.parse(args);

      // Map the friendly per-page `playerVisible` onto Foundry's page ownership (2 = observe).
      const pages = request.pages.map(p => ({
        name: p.name,
        content: p.content,
        ...(p.playerVisible ? { ownership: { default: 2 } } : {}),
      }));

      const result = await this.foundry.call('createJournal', {
        name: request.name,
        pages,
        ...(request.folderName ? { folderName: request.folderName } : {}),
      });

      if (!result || result.error) {
        throw new Error(result?.error || 'Failed to create journal');
      }

      return {
        success: true,
        journalId: result.id,
        journalName: result.name,
        pageCount: result.pageCount,
        pages: result.pages,
        message: `Journal "${result.name}" created with ${result.pageCount} page(s)`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'create-journal', 'journal creation');
    }
  }

  /**
   * Handle generic journal update (rename and/or set page content)
   */
  async handleUpdateJournal(args: any): Promise<any> {
    try {
      const request = UpdateJournalSchema.parse(args);

      const result = await this.foundry.call('updateJournal', {
        journalId: request.journalId,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.content !== undefined ? { content: request.content } : {}),
        ...(request.pageId !== undefined ? { pageId: request.pageId } : {}),
        ...(request.newPageName !== undefined ? { newPageName: request.newPageName } : {}),
      });

      if (!result || result.error || result.success === false) {
        throw new Error(result?.error || 'Failed to update journal');
      }

      return {
        success: true,
        journalId: request.journalId,
        renamed: result.renamed ?? false,
        pageId: result.pageId,
        pageName: result.pageName,
        message: 'Journal updated',
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'update-journal', 'journal update');
    }
  }

  /**
   * Handle delete journal request
   */
  async handleDeleteJournal(args: any): Promise<any> {
    try {
      const request = DeleteJournalSchema.parse(args);

      const result = await this.foundry.call('deleteJournals', {
        identifiers: request.identifiers,
      });

      if (!result || result.error) {
        throw new Error(result?.error || 'Failed to delete journals');
      }

      return {
        success: true,
        deletedCount: result.deletedCount,
        deleted: result.deleted,
        notFound: result.notFound,
        message: `Deleted ${result.deletedCount} journal(s)`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'delete-journal', 'journal deletion');
    }
  }

  /**
   * Check if a journal appears to be quest-related
   */
  private isQuestRelated(journalName: string): boolean {
    const questKeywords = ['quest', 'mission', 'task', 'adventure', 'job', 'contract'];
    const nameLower = journalName.toLowerCase();
    return questKeywords.some(keyword => nameLower.includes(keyword));
  }

  /**
   * Extract content snippet around search term
   */
  private extractSnippet(content: string, searchTerm: string, maxLength: number = 200): string {
    const index = content.toLowerCase().indexOf(searchTerm.toLowerCase());
    if (index === -1) return '';

    const start = Math.max(0, index - 50);
    const end = Math.min(content.length, index + maxLength);

    return `...${content.substring(start, end)}...`;
  }
}
