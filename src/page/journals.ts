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

import { resolveJournalStrict, getOrCreateFolder, normalizeAssetPath } from './_shared.js';
import { imgResolves, badAssetWarning } from './img-resolve.js';

// Foundry document class (JournalEntry) lives in the page global scope but is
// not declared in foundry-globals.d.ts; reach it off globalThis.
const JournalEntryClass: any = (globalThis as any).JournalEntry;

interface JournalPageSummary {
  id: string;
  name: string;
  type: string;
  /** True when players can observe this page (ownership.default >= OBSERVER) — i.e. a handout. */
  playerVisible: boolean;
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

/**
 * Reduce a journal's pages to the lightweight summary shape, including per-page visibility.
 * `playerVisible` derives from the page's own ownership (OBSERVER+ = a handout); an inherited/omitted
 * ownership (default -2 / 0) reads as GM-only.
 */
function mapPages(journal: any): JournalPageSummary[] {
  return (
    journal.pages?.map((page: any) => ({
      id: page.id || '',
      name: page.name || '',
      type: page.type || 'text',
      playerVisible: (page.ownership?.default ?? 0) >= 2,
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
  ownership?: { default: number } | undefined;
}): Promise<{ success: boolean; pageId?: string | undefined; pageName?: string | undefined }> {
  const journal = game.journal.get(request.journalId);
  if (!journal) {
    throw new Error('Journal entry not found');
  }

  // Mode 1: Create a new page (carry per-page ownership when given — e.g. a player handout page).
  if (request.newPageName) {
    const created = await journal.createEmbeddedDocuments('JournalEntryPage', [
      {
        type: 'text',
        name: request.newPageName,
        text: {
          content: request.content,
        },
        ...(request.ownership ? { ownership: request.ownership } : {}),
      },
    ]);
    const newPage = created?.[0];
    return { success: true, pageId: newPage?.id || '', pageName: request.newPageName };
  }

  // Mode 2: Update a specific page by ID (optionally re-set ownership — e.g. reveal a handout).
  if (request.pageId) {
    const page = journal.pages.get(request.pageId);
    if (!page) {
      throw new Error(`Page not found: ${request.pageId}`);
    }
    await page.update({
      'text.content': request.content,
      ...(request.ownership ? { ownership: request.ownership } : {}),
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
 * The sole journal creator (the quest-flavoured createJournalEntry was removed — the journal-builder
 * skill composes structure, this just stores it). Takes an explicit pages array; only folders the
 * journal when folderName is given. Each page is a text page with HTML content and OPTIONAL per-page
 * `ownership` (`{ default: 2 }` = players observe — a handout; omitted/`{ default: 0 }` = GM-only).
 * Per-page ownership is what lets one journal hold a player handout beside GM-only notes (design.md §5).
 */
export async function createJournal(params: {
  name: string;
  pages: Array<{
    name: string;
    kind?: 'image';
    content?: string;
    src?: string;
    caption?: string;
    sort?: number;
    ownership?: { default: number };
  }>;
  folderName?: string;
}): Promise<{
  id: string;
  name: string;
  pageCount: number;
  pages: Array<{ id: string; name: string }>;
  warnings?: string[];
}> {
  if (!params?.name || params.name.trim().length === 0) {
    throw new Error('name is required and must be a non-empty string');
  }
  if (!Array.isArray(params.pages) || params.pages.length === 0) {
    throw new Error('pages array is required and must contain at least one page');
  }

  // KEEP+WARN: a handout image has no sensible substitute, so a non-resolving image src is kept and a
  // warning is collected (validated AFTER normalizeAssetPath) — the page renders broken until fixed.
  const warnings: string[] = [];
  const pages = await Promise.all(
    params.pages.map(async (p, idx) => {
      if (!p || typeof p.name !== 'string' || p.name.trim().length === 0) {
        throw new Error(`pages[${idx}]: "name" is required and must be a non-empty string`);
      }
      // An explicit sort lets the caller interleave/order pages; otherwise creation (array) order
      // stands. Per-page ownership (JournalEntryPage carries its own in v10+) is omitted to inherit GM-only.
      const sortField = typeof p.sort === 'number' ? { sort: p.sort } : {};
      const ownershipField = p.ownership ? { ownership: p.ownership } : {};

      // Image page (e.g. a map legend key): a picture page with no HTML body. Mirrors addJournalImage.
      if (p.kind === 'image') {
        const src = normalizeAssetPath(p.src ?? '');
        if (!src) {
          throw new Error(`pages[${idx}]: an image page requires a non-empty "src"`);
        }
        if (!(await imgResolves(src))) {
          warnings.push(badAssetWarning('src', src, false));
        }
        return {
          type: 'image',
          name: p.name,
          src,
          ...(p.caption ? { image: { caption: p.caption } } : {}),
          ...sortField,
          ...ownershipField,
        };
      }

      // Text page (default): HTML content body.
      return {
        type: 'text',
        name: p.name,
        text: { content: typeof p.content === 'string' ? p.content : '' },
        ...sortField,
        ...ownershipField,
      };
    })
  );

  const journalData: any = {
    name: params.name,
    pages,
    ownership: { default: 0 }, // GM only by default (per-page ownership above can re-open a handout)
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
    ...(warnings.length ? { warnings } : {}),
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
