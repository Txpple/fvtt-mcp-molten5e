import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';
import { toInputSchema } from '../utils/schema.js';
// Quest prose + HTML templating live in ./quest/* (pure, string-in/string-out); this class is
// the thin MCP orchestration around them.
import {
  generateQuestContent,
  addNPCLinkToJournal,
  formatNewPageContent,
  formatQuestUpdate,
  formatUpdateContentForFoundry,
} from './quest/quest-template.js';

// Single source of truth for each tool's input contract: the handler parses with these
// schemas and getToolDefinitions() advertises toInputSchema(...) of the same schema.
const CreateQuestJournalSchema = z.object({
  questTitle: z.string().min(1, 'Quest title is required').describe('The title of the quest'),
  questDescription: z
    .string()
    .min(1, 'Quest description is required')
    .describe('Detailed description of what the quest should accomplish'),
  questType: z
    .enum(['main', 'side', 'personal', 'mystery', 'fetch', 'escort', 'kill', 'collection'])
    .optional()
    .describe('Type of quest (optional)'),
  difficulty: z
    .enum(['easy', 'medium', 'hard', 'deadly'])
    .optional()
    .describe('Quest difficulty level (optional)'),
  location: z.string().optional().describe('Where the quest takes place (optional)'),
  questGiver: z
    .string()
    .optional()
    .describe('Name of the NPC who gives this quest to the party (optional)'),
  npcName: z
    .string()
    .optional()
    .describe(
      'Name of key NPC this quest involves - could be antagonist, ally, or target (optional)'
    ),
  rewards: z.string().optional().describe('Quest rewards description (optional)'),
  additionalPages: z
    .array(
      z.object({
        name: z.string().min(1).describe('Page name (e.g. "Player Handout", "GM Notes")'),
        content: z.string().min(1).describe('HTML content for this page'),
      })
    )
    .optional()
    .describe(
      'Optional additional pages to create alongside the main quest page. Use for multi-page journals with separate sections like Player Handout, GM Notes, etc.'
    ),
  folderName: z
    .string()
    .optional()
    .describe(
      'Optional folder name to organize the journal into. The folder is created automatically if it does not exist.'
    ),
});

const LinkQuestToNPCSchema = z.object({
  journalId: z.string().min(1, 'Journal ID is required').describe('ID of the quest journal entry'),
  npcName: z
    .string()
    .min(1, 'NPC name is required')
    .describe('Name of the NPC to link to the quest'),
  relationship: z
    .enum(['questGiver', 'target', 'ally', 'enemy', 'contact'])
    .describe('Relationship between NPC and quest'),
});

const UpdateQuestJournalSchema = z.object({
  journalId: z
    .string()
    .min(1, 'Journal ID is required')
    .describe('ID of the quest journal to update'),
  newContent: z
    .string()
    .min(1, 'New content is required')
    .describe(
      'Content to add using quest-style HTML or plain text. Quest HTML classes: <h2 class="spaced">Section</h2>, <div class="gmnote"><p>GM info</p></div>, <div class="readaloud"><p>Player content</p></div>, <div class="grid-2">Two columns</div>. Plain text gets wrapped in <p> tags. Markdown will be stripped.'
    ),
  updateType: z
    .enum(['progress', 'completion', 'failure', 'modification'])
    .describe('Type of update being made'),
  pageId: z
    .string()
    .optional()
    .describe(
      'ID of a specific page to update. If omitted, updates the first text page. Get page IDs from list-journals.'
    ),
  newPageName: z
    .string()
    .optional()
    .describe(
      'If provided (without pageId), creates a new page with this name instead of updating an existing one.'
    ),
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
          'Create a new quest journal entry with AI-generated content based on natural language description',
        inputSchema: toInputSchema(CreateQuestJournalSchema),
      },
      {
        name: 'link-quest-to-npc',
        description: 'Link an existing quest journal to an NPC in the world',
        inputSchema: toInputSchema(LinkQuestToNPCSchema),
      },
      {
        name: 'update-quest-journal',
        description:
          'Update an existing quest journal with new progress information. By default updates the FIRST text page. Use pageId to target a specific page, or newPageName to create a new page.\n\nFor Foundry VTT v13 ProseMirror editor compatibility:\n\n✅ USE QUEST-STYLE HTML: Match create-quest-journal formatting\n✅ OR USE PLAIN TEXT: Will be wrapped in <p> tags with line breaks as <br>\n❌ DO NOT USE MARKDOWN: **bold**, *italic*, # headers will be stripped to plain text\n\nQuest-style HTML examples:\n• Sections: "<h2 class=\\"spaced\\">New Discovery</h2>"\n• GM Notes: "<div class=\\"gmnote\\"><p>GM info here</p></div>"\n• Player Info: "<div class=\\"readaloud\\"><p>Player-facing content</p></div>"\n• Plain text: "The party discovered the secret chamber"\n• Avoid: "**The party** discovered the *secret chamber*" (Markdown will be stripped)',
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
      // Validate arguments
      const request = CreateQuestJournalSchema.parse(args);

      // Generate formatted quest content
      const questContent = generateQuestContent(request);

      // Create journal entry via Foundry client
      const result = await this.foundry.call('createJournalEntry', {
        name: request.questTitle,
        content: questContent,
        additionalPages: request.additionalPages,
        ...(request.folderName ? { folderName: request.folderName } : {}),
      });

      if (!result || result.error) {
        throw new Error(result?.error || 'Failed to create quest journal');
      }

      return {
        success: true,
        journalId: result.id,
        journalName: result.name,
        pageCount: result.pageCount || 1,
        content: questContent,
        message: `Quest "${request.questTitle}" created successfully with ${result.pageCount || 1} page(s)`,
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

      // Get journal content first
      const journalResult = await this.foundry.call('getJournalContent', {
        journalId: request.journalId,
      });

      if (!journalResult || journalResult.error) {
        throw new Error('Journal not found');
      }

      // Add NPC relationship information to journal
      const updatedContent = addNPCLinkToJournal(
        journalResult.content,
        request.npcName,
        request.relationship
      );

      // Update journal with NPC link
      const updateResult = await this.foundry.call('updateJournalContent', {
        journalId: request.journalId,
        content: updatedContent,
      });

      if (!updateResult || updateResult.error) {
        throw new Error('Failed to update journal with NPC link');
      }

      return {
        success: true,
        message: `Linked ${request.npcName} to quest as ${request.relationship
          .replace(/([A-Z])/g, ' $1')
          .toLowerCase()}`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'link-quest-to-npc', 'linking quest to NPC');
    }
  }

  /**
   * Handle update quest journal request
   */
  async handleUpdateQuestJournal(args: any): Promise<any> {
    try {
      const request = UpdateQuestJournalSchema.parse(args);

      // Auto-convert Markdown to plain text with warning (don't block)
      request.newContent = this.convertMarkdownToPlainText(request.newContent);

      // If creating a new page, skip the read-modify-write cycle
      if (request.newPageName) {
        const formattedContent = formatNewPageContent(request.newContent, request.updateType);
        const result = await this.foundry.call('updateJournalContent', {
          journalId: request.journalId,
          content: formattedContent,
          newPageName: request.newPageName,
        });

        if (!result || result.error || !result.success) {
          throw new Error(result?.error || 'Failed to create new journal page');
        }

        return {
          success: true,
          updateType: request.updateType,
          message: `New page "${request.newPageName}" created in journal`,
          pageId: result.pageId,
          pageName: result.pageName,
          verified: true,
        };
      }

      // Get current journal content (for the target page)
      let currentContent: string;
      if (request.pageId) {
        const pageResult = await this.foundry.call('getJournalPageContent', {
          journalId: request.journalId,
          pageId: request.pageId,
        });
        if (!pageResult || pageResult.error) {
          throw new Error(`Page not found: ${request.pageId}`);
        }
        currentContent = pageResult.content;
      } else {
        const currentJournal = await this.foundry.call('getJournalContent', {
          journalId: request.journalId,
        });
        if (!currentJournal || currentJournal.error) {
          throw new Error(
            `Journal not found: ${currentJournal?.error || 'Journal ID may be invalid'}`
          );
        }
        currentContent = currentJournal.content;
      }

      if (!currentContent) {
        throw new Error('Journal/page exists but has no content to update');
      }

      // Format the update based on type
      // For specific page updates, use append-style since the page may not have quest HTML structure
      let updatedContent: string;
      if (request.pageId) {
        const formattedNew = formatUpdateContentForFoundry(request.newContent);
        updatedContent = currentContent + formattedNew;
      } else {
        updatedContent = formatQuestUpdate(currentContent, request.newContent, request.updateType);
      }

      // Update the journal
      const result = await this.foundry.call('updateJournalContent', {
        journalId: request.journalId,
        content: updatedContent,
        pageId: request.pageId,
      });

      if (!result) {
        throw new Error('Failed to update quest journal: No response from Foundry');
      }

      if (result.error) {
        throw new Error(`Failed to update quest journal: ${result.error}`);
      }

      if (!result.success) {
        throw new Error('Failed to update quest journal: Update operation returned failure');
      }

      // Verify the update by reading the content back
      let verifyContent: string;
      if (request.pageId) {
        const verifyResult = await this.foundry.call('getJournalPageContent', {
          journalId: request.journalId,
          pageId: request.pageId,
        });
        verifyContent = verifyResult?.content || '';
      } else {
        const verifyResult = await this.foundry.call('getJournalContent', {
          journalId: request.journalId,
        });
        verifyContent = verifyResult?.content || '';
      }

      // The bridge already confirmed result.success above. Use the read-back only to catch the
      // one failure that flag can't: a page that's empty after we wrote non-empty content. (The
      // previous OR-chain hard-coded English heading strings that had to stay in lockstep with
      // formatQuestUpdate, and its "content changed" clause subsumed all the others — dropped as
      // brittle. Foundry's HTML normalization makes an exact substring match unreliable, so we
      // don't assert the formatted content survives verbatim.)
      if (request.newContent.trim().length > 0 && verifyContent.trim().length === 0) {
        throw new Error(
          'Journal update verification failed: the page is empty after writing non-empty content.'
        );
      }

      return {
        success: true,
        updateType: request.updateType,
        message: `Quest journal updated with ${request.updateType}`,
        pageId: result.pageId,
        pageName: result.pageName,
        verified: true,
        details: `Content successfully updated and verified. Content length changed from ${currentContent.length} to ${verifyContent.length} characters.`,
        updatedContent: verifyContent,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'update-quest-journal', 'journal update');
    }
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

      const result = await this.foundry.call('createJournal', {
        name: request.name,
        pages: request.pages,
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

  /**
   * Convert Markdown to plain text and warn (don't block the operation)
   * This ensures the tool works while gently educating about proper format
   */
  private convertMarkdownToPlainText(content: string): string {
    const originalContent = content;

    // Convert common Markdown patterns to plain text
    content = content
      .replace(/\*\*(.+?)\*\*/g, '$1') // **bold** → bold
      .replace(/\*(.+?)\*/g, '$1') // *italic* → italic
      .replace(/^#{1,6}\s+(.+)/gm, '$1') // # headers → headers
      .replace(/`(.+?)`/g, '$1') // `code` → code
      .replace(/\[(.+?)\]\((.+?)\)/g, '$1') // [text](url) → text
      .replace(/^[-*+]\s+(.+)/gm, '$1') // - item → item
      .replace(/^\d+\.\s+(.+)/gm, '$1') // 1. item → item
      .replace(/^>\s*(.+)/gm, '$1'); // > quote → quote

    // If we made changes, log a warning (but don't block)
    if (content !== originalContent) {
      this.logger.warn(
        'Automatically converted Markdown formatting to plain text. Future updates will work better with plain text input.'
      );
    }

    return content;
  }
}
