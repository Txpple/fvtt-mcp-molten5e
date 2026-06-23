// Page-side: journal reads + writes. Runs inside the Foundry page.
//
// Reads are pure against game.journal. Writes (create/update/delete) perform
// awaited Foundry document mutations and are best-effort (no rollback). No
// permission/transaction/audit scaffolding — the bridge is always GM. Shapes
// match the old data-access.ts oracle (6f9612e:packages/foundry-module/src/
// data-access.ts: reads @2698-2798; writes createJournalEntry @2621-2698,
// updateJournalContent @2799-2895, createJournal @2895-2969, updateJournal
// @2969-3022, deleteJournals @3022-3083) and the contracts the Node tools in
// src/tools/quest-creation.ts + its tests expect.

import { resolveJournalStrict, getOrCreateFolder } from './_shared.js';

// Foundry document class (JournalEntry) lives in the page global scope but is
// not declared in foundry-globals.d.ts; reach it off globalThis.
const JournalEntryClass: any = (globalThis as any).JournalEntry;

interface JournalPageSummary {
  id: string;
  name: string;
  type: string;
}

interface JournalSummary {
  id: string;
  name: string;
  type: string;
  pageCount: number;
  pages: JournalPageSummary[];
}

interface JournalContent {
  content: string;
  currentPage?: { id: string; name: string };
  allPages: JournalPageSummary[];
  pageCount: number;
  note?: string;
}

interface JournalPageContent {
  id: string;
  name: string;
  type: string;
  content: string;
}

/** Reduce a journal's pages to the lightweight {id,name,type} summary shape. */
function mapPages(journal: any): JournalPageSummary[] {
  return (
    journal.pages?.map((page: any) => ({
      id: page.id || '',
      name: page.name || '',
      type: page.type || 'text',
    })) || []
  );
}

/** List every journal entry with a per-entry page manifest. */
export function listJournals(): JournalSummary[] {
  return game.journal.map((journal: any) => ({
    id: journal.id || '',
    name: journal.name || '',
    type: 'JournalEntry',
    pageCount: journal.pages?.size || 0,
    pages: mapPages(journal),
  }));
}

/**
 * Get a journal entry's content: the first text page plus the full page manifest.
 * Returns null when the journal id does not resolve.
 */
export function getJournalContent(args: { journalId: string }): JournalContent | null {
  const journal = game.journal.get(args.journalId);
  if (!journal) {
    return null;
  }

  const allPages = mapPages(journal);
  const pageCount = allPages.length;

  const firstPage = journal.pages.find((page: any) => page.type === 'text');
  if (!firstPage) {
    return { content: '', allPages, pageCount };
  }

  const result: JournalContent = {
    content: firstPage.text?.content || '',
    currentPage: { id: firstPage.id || '', name: firstPage.name || '' },
    allPages,
    pageCount,
  };

  if (pageCount > 1) {
    result.note = `This journal has ${pageCount} pages. Use list-journals with journalId and pageId to read other pages: ${allPages
      .map(p => `"${p.name}" (${p.id})`)
      .join(', ')}`;
  }

  return result;
}

/**
 * Get a specific journal page's content by id. For text pages the HTML body is
 * returned; for other page types (image, etc.) the source path is returned.
 * Returns null when either the journal or the page id does not resolve.
 */
export function getJournalPageContent(args: {
  journalId: string;
  pageId: string;
}): JournalPageContent | null {
  const journal = game.journal.get(args.journalId);
  if (!journal) {
    return null;
  }

  const page = journal.pages.get(args.pageId);
  if (!page) {
    return null;
  }

  return {
    id: page.id || '',
    name: page.name || '',
    type: page.type || 'text',
    content: page.type === 'text' ? page.text?.content || '' : page.src || '',
  };
}

// --- writes ------------------------------------------------------------------

/**
 * Create a quest-flavoured JournalEntry: the first page is always named
 * "Quest Details" holding the supplied content, followed by any additionalPages.
 * The journal is auto-foldered under folderName (or, when omitted, its own name).
 */
export async function createJournalEntry(request: {
  name: string;
  content: string;
  folderName?: string;
  additionalPages?: Array<{ name: string; content: string }>;
}): Promise<{ id: string; name: string; pageCount: number }> {
  // Build pages array: main page + any additional pages.
  const pages: Array<{ type: string; name: string; text: { content: string } }> = [
    {
      type: 'text',
      name: 'Quest Details',
      text: {
        content: request.content,
      },
    },
  ];

  if (request.additionalPages) {
    for (const page of request.additionalPages) {
      pages.push({
        type: 'text',
        name: page.name,
        text: {
          content: page.content,
        },
      });
    }
  }

  // Create journal entry with proper Foundry document structure.
  const journalData = {
    name: request.name,
    pages,
    ownership: { default: 0 }, // GM only by default
    folder: await getOrCreateFolder(request.folderName || request.name, 'JournalEntry'),
  };

  const journal = await JournalEntryClass.create(journalData);

  if (!journal) {
    throw new Error('Failed to create journal entry');
  }

  return {
    id: journal.id,
    name: journal.name || request.name,
    pageCount: pages.length,
  };
}

/**
 * Set a journal's page content in one of three modes:
 *  - newPageName given: create a new text page with that name.
 *  - pageId given: replace that specific page's content (throws if not found).
 *  - neither: update the first text page, or create a "Quest Details" page when
 *    the journal has no text page yet.
 * Returns { success, pageId, pageName }.
 */
export async function updateJournalContent(request: {
  journalId: string;
  content: string;
  pageId?: string | undefined;
  newPageName?: string | undefined;
}): Promise<{ success: boolean; pageId?: string | undefined; pageName?: string | undefined }> {
  const journal = game.journal.get(request.journalId);
  if (!journal) {
    throw new Error('Journal entry not found');
  }

  // Mode 1: Create a new page.
  if (request.newPageName) {
    const created = await journal.createEmbeddedDocuments('JournalEntryPage', [
      {
        type: 'text',
        name: request.newPageName,
        text: {
          content: request.content,
        },
      },
    ]);
    const newPage = created?.[0];
    return { success: true, pageId: newPage?.id || '', pageName: request.newPageName };
  }

  // Mode 2: Update a specific page by ID.
  if (request.pageId) {
    const page = journal.pages.get(request.pageId);
    if (!page) {
      throw new Error(`Page not found: ${request.pageId}`);
    }
    await page.update({
      'text.content': request.content,
    });
    return { success: true, pageId: page.id, pageName: page.name };
  }

  // Mode 3: Update first text page or create one if none exists (backward compat).
  const firstPage = journal.pages.find((page: any) => page.type === 'text');

  if (firstPage) {
    // Update existing page.
    await firstPage.update({
      'text.content': request.content,
    });
    return { success: true, pageId: firstPage.id, pageName: firstPage.name };
  } else {
    // Create new text page.
    const created = await journal.createEmbeddedDocuments('JournalEntryPage', [
      {
        type: 'text',
        name: 'Quest Details',
        text: {
          content: request.content,
        },
      },
    ]);
    const newPage = created?.[0];
    return { success: true, pageId: newPage?.id || '', pageName: 'Quest Details' };
  }
}

/**
 * Create a generic multi-page JournalEntry from caller-supplied text pages.
 *
 * Unlike createJournalEntry (quest-flavoured: first page is always named
 * "Quest Details" and the journal is auto-foldered under its own name), this
 * takes an explicit pages array and only places the journal in a folder when
 * folderName is given. Each page is a text page with HTML content.
 */
export async function createJournal(params: {
  name: string;
  pages: Array<{ name: string; content: string }>;
  folderName?: string;
}): Promise<{
  id: string;
  name: string;
  pageCount: number;
  pages: Array<{ id: string; name: string }>;
}> {
  if (!params?.name || params.name.trim().length === 0) {
    throw new Error('name is required and must be a non-empty string');
  }
  if (!Array.isArray(params.pages) || params.pages.length === 0) {
    throw new Error('pages array is required and must contain at least one page');
  }

  const pages = params.pages.map((p, idx) => {
    if (!p || typeof p.name !== 'string' || p.name.trim().length === 0) {
      throw new Error(`pages[${idx}]: "name" is required and must be a non-empty string`);
    }
    return {
      type: 'text',
      name: p.name,
      text: { content: typeof p.content === 'string' ? p.content : '' },
    };
  });

  const journalData: any = {
    name: params.name,
    pages,
    ownership: { default: 0 }, // GM only by default
  };
  if (params.folderName && params.folderName.trim().length > 0) {
    journalData.folder = await getOrCreateFolder(params.folderName.trim(), 'JournalEntry');
  }

  const journal = await JournalEntryClass.create(journalData);
  if (!journal) {
    throw new Error('Failed to create journal entry');
  }

  return {
    id: journal.id ?? '',
    name: journal.name || params.name,
    pageCount: journal.pages?.size ?? pages.length,
    pages: (journal.pages?.contents ?? []).map((pg: any) => ({ id: pg.id, name: pg.name })),
  };
}

/**
 * Generic JournalEntry update: optionally rename the entry, then optionally set
 * page content (replace a page by id, the first text page, or create a new page
 * via newPageName). Reuses updateJournalContent for the page-content path so the
 * 3-mode behaviour stays in one place.
 */
export async function updateJournal(params: {
  journalId: string;
  name?: string;
  content?: string;
  pageId?: string;
  newPageName?: string;
}): Promise<{
  success: boolean;
  pageId?: string | undefined;
  pageName?: string | undefined;
  renamed?: boolean;
}> {
  const journal = resolveJournalStrict(params.journalId);
  if (!journal) {
    throw new Error(`Journal entry "${params.journalId}" not found`);
  }

  if (params.name === undefined && params.content === undefined) {
    throw new Error('Provide at least one of: name, content');
  }

  let renamed = false;
  if (params.name !== undefined && params.name.trim().length > 0) {
    await journal.update({ name: params.name.trim() });
    renamed = true;
  }

  if (params.content !== undefined) {
    const res = await updateJournalContent({
      journalId: journal.id,
      content: params.content,
      pageId: params.pageId,
      newPageName: params.newPageName,
    });
    return { ...res, renamed };
  }

  return { success: true, renamed };
}

/**
 * Permanently delete one or more JournalEntry documents by exact id or exact
 * name. STRICT resolution (resolveJournalStrict) — no fuzzy matching. Returns
 * the deleted entries plus any identifiers that did not resolve.
 */
export async function deleteJournals(data: { identifiers: string[] }): Promise<{
  success: boolean;
  deletedCount: number;
  deleted: Array<{ id: string; name: string }>;
  notFound?: string[];
}> {
  if (!Array.isArray(data?.identifiers) || data.identifiers.length === 0) {
    throw new Error('identifiers array is required and must contain at least one entry');
  }

  try {
    const deleted: Array<{ id: string; name: string }> = [];
    const notFound: string[] = [];

    for (const identifier of data.identifiers) {
      const journal = resolveJournalStrict(identifier);
      if (journal) {
        const info = { id: journal.id ?? identifier, name: journal.name ?? '' };
        await journal.delete();
        deleted.push(info);
      } else {
        notFound.push(identifier);
      }
    }

    return {
      success: true,
      deletedCount: deleted.length,
      deleted,
      ...(notFound.length > 0 ? { notFound } : {}),
    };
  } catch (error) {
    throw new Error(
      `Failed to delete journal(s): ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
