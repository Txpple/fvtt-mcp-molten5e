/**
 * Unit tests for JournalTools.
 *
 * Eight handlers, each: zod.parse(args) -> one or more
 * foundry.call('<op>', data) calls -> a result
 * OBJECT (these handlers return structured objects, not human strings). The
 * tests assert (a) the correct bridge method + payload is forwarded and the
 * returned object's fields match what the format code builds, and (b) zod
 * rejects bad input. On validation failure these handlers funnel through
 * ErrorHandler.handleToolError which re-throws a reformatted Error, so the
 * rejection tests only assert that a throw occurs.
 */

import { describe, it, expect } from 'vitest';
import { JournalTools } from './journal.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new JournalTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('JournalTools.getToolDefinitions', () => {
  it('exposes exactly the ten expected tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual([
      'create-journal',
      'create-quest-journal',
      'delete-journal',
      'delete-journal-page',
      'link-quest-to-npc',
      'list-journals',
      'search-journals',
      'set-journal-page-visibility',
      'update-journal',
      'update-quest-journal',
    ]);
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('handleCreateQuestJournal (structuring — blocks -> styled HTML, no prose)', () => {
  it("renders each page's blocks into the house style + maps playerVisible to ownership", async () => {
    const { tools, calls } = build({
      id: 'j1',
      name: 'The Grove',
      pageCount: 2,
      pages: [{ id: 'p1' }, { id: 'p2' }],
    });
    const out = await tools.handleCreateQuestJournal({
      title: 'The Grove',
      pages: [
        {
          name: 'Overview',
          blocks: [
            { type: 'lead', html: 'A cursed grove.' },
            { type: 'readaloud', html: '<p>Cold air bites.</p>' },
            { type: 'list', items: ['Find the druid'] },
          ],
        },
        {
          name: 'Handout',
          playerVisible: true,
          blocks: [{ type: 'paragraph', html: 'For the players.' }],
        },
      ],
      folderName: 'Quests',
    });

    expect(calls[0][0]).toBe('createJournal');
    expect(calls[0][1].name).toBe('The Grove');
    expect(calls[0][1].folderName).toBe('Quests');
    const pages = calls[0][1].pages;
    expect(pages).toHaveLength(2);
    // page 1: GM-only (no ownership), styled content carrying ONLY the caller's words
    expect(pages[0].name).toBe('Overview');
    expect(pages[0].ownership).toBeUndefined();
    expect(pages[0].content).toContain('class="mcp-journal"');
    expect(pages[0].content).toContain('A cursed grove.');
    expect(pages[0].content).toContain('Cold air bites.');
    expect(pages[0].content).toContain('Find the druid');
    // page 2: player-visible handout -> ownership default 2 (observe)
    expect(pages[1].ownership).toEqual({ default: 2 });
    expect(pages[1].content).toContain('For the players.');

    expect(out).toMatchObject({
      success: true,
      journalId: 'j1',
      journalName: 'The Grove',
      pageCount: 2,
    });
  });

  it('never invents prose — the page HTML contains only the caller words', async () => {
    const { tools, calls } = build({ id: 'j', name: 'X', pageCount: 1, pages: [] });
    await tools.handleCreateQuestJournal({
      title: 'X',
      pages: [{ name: 'P', blocks: [{ type: 'paragraph', html: 'JustThis.' }] }],
    });
    const content = calls[0][1].pages[0].content;
    expect(content).toContain('JustThis.');
    for (const fabricated of [
      'approaches the party',
      'urgent news',
      'Report back',
      'innocent people',
    ]) {
      expect(content).not.toContain(fabricated);
    }
  });

  it('throws when the bridge returns an error payload', async () => {
    const { tools } = build({ error: 'boom' });
    await expect(
      tools.handleCreateQuestJournal({
        title: 'X',
        pages: [{ name: 'P', blocks: [{ type: 'paragraph', html: 'y' }] }],
      })
    ).rejects.toThrow();
  });

  it('rejects missing pages / an empty title / a bad block type / empty blocks', async () => {
    const { tools } = build();
    await expect(tools.handleCreateQuestJournal({ title: 'X' })).rejects.toThrow();
    await expect(
      tools.handleCreateQuestJournal({
        title: '',
        pages: [{ name: 'P', blocks: [{ type: 'paragraph', html: 'y' }] }],
      })
    ).rejects.toThrow();
    await expect(
      tools.handleCreateQuestJournal({
        title: 'X',
        pages: [{ name: 'P', blocks: [{ type: 'bogus', html: 'y' }] }],
      })
    ).rejects.toThrow();
    await expect(
      tools.handleCreateQuestJournal({ title: 'X', pages: [{ name: 'P', blocks: [] }] })
    ).rejects.toThrow();
  });
});

describe('handleLinkQuestToNPC (real @UUID link, never a dead name)', () => {
  it('resolves the NPC and appends a @UUID[Actor.id] enricher link', async () => {
    const { tools, calls } = build((method: string) => {
      if (method === 'findActor') return { id: 'abc123', name: 'Old Druid' };
      if (method === 'getJournalContent') return { content: '<section>old</section>' };
      if (method === 'updateJournalContent')
        return { success: true, pageId: 'p1', pageName: 'Quest' };
      return {};
    });

    const out = await tools.handleLinkQuestToNPC({
      journalId: 'j1',
      npcName: 'Old Druid',
      relationship: 'questGiver',
    });

    expect(calls.find(c => c[0] === 'findActor')![1]).toEqual({ identifier: 'Old Druid' });
    const updateCall = calls.find(c => c[0] === 'updateJournalContent')!;
    expect(updateCall[1].journalId).toBe('j1');
    expect(updateCall[1].content).toContain('@UUID[Actor.abc123]{Old Druid}');
    expect(updateCall[1].content).toContain('old'); // appended after existing content
    expect(out).toMatchObject({
      success: true,
      npc: { id: 'abc123', name: 'Old Druid' },
      link: '@UUID[Actor.abc123]{Old Druid}',
    });
  });

  it('throws (no dead link) when the NPC does not resolve', async () => {
    const { tools } = build((method: string) => (method === 'findActor' ? null : {}));
    await expect(
      tools.handleLinkQuestToNPC({ journalId: 'j1', npcName: 'Ghost', relationship: 'ally' })
    ).rejects.toThrow(/not found in the world/);
  });

  it('rejects an invalid relationship / empty npcName', async () => {
    const { tools } = build();
    await expect(
      tools.handleLinkQuestToNPC({ journalId: 'j', npcName: 'X', relationship: 'frenemy' })
    ).rejects.toThrow();
    await expect(
      tools.handleLinkQuestToNPC({ journalId: 'j', npcName: '', relationship: 'ally' })
    ).rejects.toThrow();
  });
});

describe('handleUpdateQuestJournal (append a styled section from blocks)', () => {
  it('creates a new page from blocks when newPageName is given (single write)', async () => {
    const { tools, calls } = build((method: string) =>
      method === 'updateJournalContent'
        ? { success: true, pageId: 'p9', pageName: 'Session 2' }
        : {}
    );

    const out = await tools.handleUpdateQuestJournal({
      journalId: 'j1',
      newPageName: 'Session 2',
      blocks: [
        { type: 'heading', text: 'Session 2' },
        { type: 'paragraph', html: 'The party reached the keep.' },
      ],
    });

    // Only the create-page write — no read.
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('updateJournalContent');
    expect(calls[0][1].newPageName).toBe('Session 2');
    expect(calls[0][1].content).toContain('The party reached the keep.');
    expect(calls[0][1].content).toContain('class="mcp-journal"');
    expect(out).toMatchObject({ success: true, pageId: 'p9', pageName: 'Session 2' });
  });

  it('appends a styled section to the first text page (read then write)', async () => {
    let stored = '<section class="mcp-journal"><div>old</div></section>';
    const { tools, calls } = build((method: string, data: any) => {
      if (method === 'getJournalContent') return { content: stored };
      if (method === 'updateJournalContent') {
        stored = data.content;
        return { success: true, pageId: 'p1', pageName: 'Quest' };
      }
      return {};
    });

    await tools.handleUpdateQuestJournal({
      journalId: 'j1',
      blocks: [{ type: 'paragraph', html: 'New milestone reached.' }],
    });

    expect(calls.map(c => c[0])).toEqual(['getJournalContent', 'updateJournalContent']);
    const writeCall = calls[1];
    expect(writeCall[1].content).toContain('old'); // existing content preserved
    expect(writeCall[1].content).toContain('New milestone reached.'); // appended
  });

  it('appends to a specific page when pageId is supplied', async () => {
    let stored = '<p>existing page text</p>';
    const { tools, calls } = build((method: string, data: any) => {
      if (method === 'getJournalPageContent') return { content: stored };
      if (method === 'updateJournalContent') {
        stored = data.content;
        return { success: true, pageId: 'p2', pageName: 'Notes' };
      }
      return {};
    });

    await tools.handleUpdateQuestJournal({
      journalId: 'j1',
      pageId: 'p2',
      blocks: [{ type: 'paragraph', html: 'A clue was found.' }],
    });

    expect(calls.map(c => c[0])).toEqual(['getJournalPageContent', 'updateJournalContent']);
    expect(calls[1][1].pageId).toBe('p2');
    expect(calls[1][1].content).toContain('existing page text');
    expect(calls[1][1].content).toContain('A clue was found.');
  });

  it('forwards ownership {default:2} to a NEW page when playerVisible:true (a handout)', async () => {
    const { tools, calls } = build((method: string) =>
      method === 'updateJournalContent' ? { success: true, pageId: 'p9', pageName: 'Flavor' } : {}
    );
    await tools.handleUpdateQuestJournal({
      journalId: 'j1',
      newPageName: 'Flavor',
      playerVisible: true,
      blocks: [{ type: 'paragraph', html: 'A weathered map.' }],
    });
    expect(calls[0][1].ownership).toEqual({ default: 2 });
  });

  it('omits ownership entirely when playerVisible is not given (inherits GM-only)', async () => {
    const { tools, calls } = build((method: string) =>
      method === 'updateJournalContent'
        ? { success: true, pageId: 'p9', pageName: 'Session 2' }
        : {}
    );
    await tools.handleUpdateQuestJournal({
      journalId: 'j1',
      newPageName: 'Session 2',
      blocks: [{ type: 'paragraph', html: 'x' }],
    });
    expect('ownership' in calls[0][1]).toBe(false);
  });

  it('rejects empty blocks / a bad block', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateQuestJournal({ journalId: 'j1', blocks: [] })).rejects.toThrow();
    await expect(
      tools.handleUpdateQuestJournal({ journalId: 'j1', blocks: [{ type: 'nope', html: 'x' }] })
    ).rejects.toThrow();
  });
});

describe('handleListJournals', () => {
  it('lists all journals when no journalId is given', async () => {
    const journals = [
      { id: 'a', name: 'Quest One' },
      { id: 'b', name: 'Lore Notes' },
    ];
    const { tools, calls } = build((method: string) => (method === 'listJournals' ? journals : {}));

    const out = await tools.handleListJournals({});
    expect(calls[0][0]).toBe('listJournals');
    expect(out).toMatchObject({
      success: true,
      mode: 'list',
      journals,
      total: 2,
      filtered: false,
    });
  });

  it('filters to quest-related journals when filterQuests is true', async () => {
    const journals = [
      { id: 'a', name: 'Quest One' },
      { id: 'b', name: 'Lore Notes' },
      { id: 'c', name: 'The Mission' },
    ];
    const { tools } = build((method: string) => (method === 'listJournals' ? journals : {}));
    const out = await tools.handleListJournals({ filterQuests: true });
    expect(out.total).toBe(2); // "Quest One" + "The Mission"
    expect(out.filtered).toBe(true);
    expect(out.journals.map((j: any) => j.id)).toEqual(['a', 'c']);
  });

  it('reads a single journal when journalId is supplied', async () => {
    const { tools, calls } = build((method: string) =>
      method === 'getJournalContent'
        ? {
            content: '<p>body</p>',
            currentPage: 'Quest',
            allPages: [{ id: 'p1', name: 'Quest' }],
            pageCount: 1,
          }
        : {}
    );
    const out = await tools.handleListJournals({ journalId: 'j1' });
    expect(calls[0][0]).toBe('getJournalContent');
    expect(calls[0][1]).toEqual({ journalId: 'j1' });
    expect(out).toMatchObject({
      success: true,
      mode: 'journal',
      journalId: 'j1',
      content: '<p>body</p>',
      pageCount: 1,
    });
  });

  it('reads a specific page when journalId + pageId are supplied', async () => {
    const page = { id: 'p1', name: 'Quest', content: '<p>page body</p>' };
    const { tools, calls } = build((method: string) =>
      method === 'getJournalPageContent' ? page : {}
    );
    const out = await tools.handleListJournals({ journalId: 'j1', pageId: 'p1' });
    expect(calls[0][0]).toBe('getJournalPageContent');
    expect(calls[0][1]).toEqual({ journalId: 'j1', pageId: 'p1' });
    expect(out).toMatchObject({ success: true, mode: 'page', journalId: 'j1', page });
  });
});

describe('handleSearchJournals', () => {
  it('matches by title and reports the totals', async () => {
    const journals = [
      { id: 'a', name: 'Goblin Ambush', pageCount: 0, pages: [] },
      { id: 'b', name: 'Tavern Talk', pageCount: 0, pages: [] },
    ];
    const { tools, calls } = build((method: string) => (method === 'listJournals' ? journals : {}));
    const out = await tools.handleSearchJournals({ searchQuery: 'goblin', searchType: 'title' });
    expect(calls[0][0]).toBe('listJournals');
    expect(out).toMatchObject({
      success: true,
      searchQuery: 'goblin',
      searchType: 'title',
      totalMatches: 1,
    });
    expect(out.results[0]).toMatchObject({ id: 'a', name: 'Goblin Ambush' });
    expect(out.results[0].matchType).toContain('title');
  });

  it('matches by page content and records the matched page', async () => {
    const journals = [
      {
        id: 'a',
        name: 'Notes',
        pageCount: 1,
        pages: [{ id: 'p1', name: 'Body', type: 'text' }],
      },
    ];
    const { tools } = build((method: string) => {
      if (method === 'listJournals') return journals;
      if (method === 'getJournalPageContent')
        return { content: 'The dragon sleeps in the cavern.' };
      return {};
    });
    const out = await tools.handleSearchJournals({ searchQuery: 'dragon', searchType: 'content' });
    expect(out.totalMatches).toBe(1);
    expect(out.results[0].matchType).toContain('content');
    expect(out.results[0].matchedPages[0]).toMatchObject({ pageId: 'p1', pageName: 'Body' });
    expect(out.results[0].matchedPages[0].contentSnippet).toContain('dragon');
  });

  it('returns zero matches when nothing matches', async () => {
    const journals = [{ id: 'a', name: 'Notes', pageCount: 0, pages: [] }];
    const { tools } = build((method: string) => (method === 'listJournals' ? journals : {}));
    const out = await tools.handleSearchJournals({ searchQuery: 'zzz', searchType: 'both' });
    expect(out.totalMatches).toBe(0);
    expect(out.results).toEqual([]);
  });

  it('rejects an empty searchQuery', async () => {
    const { tools } = build();
    await expect(tools.handleSearchJournals({ searchQuery: '' })).rejects.toThrow();
  });

  it('rejects an invalid searchType enum value', async () => {
    const { tools } = build();
    await expect(
      tools.handleSearchJournals({ searchQuery: 'x', searchType: 'everywhere' })
    ).rejects.toThrow();
  });
});

describe('handleCreateJournal', () => {
  it('forwards name + pages and reports the page count', async () => {
    const { tools, calls } = build({
      id: 'j1',
      name: 'My Journal',
      pageCount: 2,
      pages: [{ id: 'p1' }, { id: 'p2' }],
    });
    const out = await tools.handleCreateJournal({
      name: 'My Journal',
      pages: [
        { name: 'Intro', content: '<p>Hi</p>' },
        { name: 'Details', content: '<p>More</p>' },
      ],
    });
    expect(calls[0][0]).toBe('createJournal');
    expect(calls[0][1].name).toBe('My Journal');
    expect(calls[0][1].pages).toHaveLength(2);
    expect(out).toMatchObject({
      success: true,
      journalId: 'j1',
      journalName: 'My Journal',
      pageCount: 2,
      message: 'Journal "My Journal" created with 2 page(s)',
    });
  });

  it('defaults missing page content to an empty string and passes folderName', async () => {
    const { tools, calls } = build({ id: 'j2', name: 'J', pageCount: 1, pages: [] });
    await tools.handleCreateJournal({
      name: 'J',
      pages: [{ name: 'OnlyName' }],
      folderName: 'Lore',
    });
    expect(calls[0][1].pages[0]).toEqual({ name: 'OnlyName', content: '' });
    expect(calls[0][1].folderName).toBe('Lore');
  });

  it('forwards an image page (kind:image -> src + caption + ownership) beside text pages', async () => {
    const { tools, calls } = build({ id: 'j3', name: 'Keys', pageCount: 2, pages: [] });
    await tools.handleCreateJournal({
      name: 'Keys',
      pages: [
        { name: 'Overview', content: '<p>Map keys</p>' },
        {
          name: 'Iris Key',
          kind: 'image',
          src: 'worlds/w/assets/iris_Key.webp',
          caption: 'Iris',
          playerVisible: true,
        },
      ],
    });
    const pages = calls[0][1].pages;
    // text page unchanged (no kind/src leaks in)
    expect(pages[0]).toEqual({ name: 'Overview', content: '<p>Map keys</p>' });
    // image page carries kind + src + caption + ownership, NOT a content field
    expect(pages[1]).toEqual({
      name: 'Iris Key',
      kind: 'image',
      src: 'worlds/w/assets/iris_Key.webp',
      caption: 'Iris',
      ownership: { default: 2 },
    });
  });

  it('forwards an explicit sort key when given', async () => {
    const { tools, calls } = build({ id: 'j', name: 'J', pageCount: 1, pages: [] });
    await tools.handleCreateJournal({ name: 'J', pages: [{ name: 'P', content: 'x', sort: 200 }] });
    expect(calls[0][1].pages[0]).toEqual({ name: 'P', content: 'x', sort: 200 });
  });

  it('surfaces page-side asset warnings (a non-resolving image src is kept, not substituted)', async () => {
    const { tools } = build({
      id: 'j4',
      name: 'Keys',
      pageCount: 1,
      pages: [{ id: 'p1' }],
      warnings: [
        'Supplied src "x/nope.webp" was not found on the server — the document was created.',
      ],
    });
    const out = await tools.handleCreateJournal({
      name: 'Keys',
      pages: [{ name: 'Bad', kind: 'image', src: 'x/nope.webp' }],
    });
    expect(out.message).toContain('not found on the server');
    expect(out.message).toContain('⚠️ 1 warning(s):');
  });

  it('rejects an image page with no src (refine)', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateJournal({ name: 'J', pages: [{ name: 'Img', kind: 'image' }] })
    ).rejects.toThrow();
  });

  it('rejects an empty name', async () => {
    const { tools } = build();
    await expect(tools.handleCreateJournal({ name: '', pages: [{ name: 'p' }] })).rejects.toThrow();
  });

  it('rejects an empty pages array', async () => {
    const { tools } = build();
    await expect(tools.handleCreateJournal({ name: 'J', pages: [] })).rejects.toThrow();
  });

  it('rejects a page with an empty name', async () => {
    const { tools } = build();
    await expect(tools.handleCreateJournal({ name: 'J', pages: [{ name: '' }] })).rejects.toThrow();
  });
});

describe('handleUpdateJournal', () => {
  it('forwards a rename + content update and reports success', async () => {
    const { tools, calls } = build({
      success: true,
      renamed: true,
      pageId: 'p1',
      pageName: 'Body',
    });
    const out = await tools.handleUpdateJournal({
      journalId: 'j1',
      name: 'Renamed',
      content: '<p>new</p>',
    });
    expect(calls[0][0]).toBe('updateJournal');
    expect(calls[0][1]).toMatchObject({
      journalId: 'j1',
      name: 'Renamed',
      content: '<p>new</p>',
    });
    expect(out).toMatchObject({
      success: true,
      journalId: 'j1',
      renamed: true,
      pageId: 'p1',
      pageName: 'Body',
      message: 'Journal updated',
    });
  });

  it('omits unset optional fields from the bridge payload', async () => {
    const { tools, calls } = build({ success: true });
    await tools.handleUpdateJournal({ journalId: 'j1', name: 'OnlyName' });
    expect(calls[0][1]).toEqual({ journalId: 'j1', name: 'OnlyName' });
    expect('content' in calls[0][1]).toBe(false);
    expect('pageId' in calls[0][1]).toBe(false);
  });

  it('defaults renamed to false when the bridge omits it', async () => {
    const { tools } = build({ success: true });
    const out = await tools.handleUpdateJournal({ journalId: 'j1', content: '<p>x</p>' });
    expect(out.renamed).toBe(false);
  });

  it('forwards ownership when playerVisible is given', async () => {
    const { tools, calls } = build({ success: true, pageId: 'p1', pageName: 'P' });
    await tools.handleUpdateJournal({
      journalId: 'j1',
      newPageName: 'Handout',
      content: '<p>x</p>',
      playerVisible: true,
    });
    expect(calls[0][1].ownership).toEqual({ default: 2 });
  });

  it('throws when the bridge reports success:false', async () => {
    const { tools } = build({ success: false, error: 'nope' });
    await expect(tools.handleUpdateJournal({ journalId: 'j1', name: 'X' })).rejects.toThrow();
  });

  it('rejects when neither name nor content is provided (refine)', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateJournal({ journalId: 'j1', pageId: 'p1' })).rejects.toThrow();
  });

  it('rejects an empty journalId', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateJournal({ journalId: '', name: 'X' })).rejects.toThrow();
  });
});

describe('handleSetJournalPageVisibility', () => {
  it('forwards journalId/pageId/playerVisible and reports the new state', async () => {
    const { tools, calls } = build({ success: true, pageId: 'p1', pageName: 'Flavor' });
    const out = await tools.handleSetJournalPageVisibility({
      journalId: 'j1',
      pageId: 'p1',
      playerVisible: true,
    });
    expect(calls[0][0]).toBe('setJournalPageVisibility');
    expect(calls[0][1]).toEqual({ journalId: 'j1', pageId: 'p1', playerVisible: true });
    expect(out).toMatchObject({ success: true, pageId: 'p1', playerVisible: true });
    expect(out.message).toContain('player-visible');
  });

  it('reports GM-only when hiding a page', async () => {
    const { tools } = build({ success: true, pageId: 'p1', pageName: 'Secrets' });
    const out = await tools.handleSetJournalPageVisibility({
      journalId: 'j1',
      pageId: 'p1',
      playerVisible: false,
    });
    expect(out.message).toContain('GM-only');
  });

  it('throws on the bridge error payload', async () => {
    const { tools } = build({ success: false, error: 'Page not found: p9' });
    await expect(
      tools.handleSetJournalPageVisibility({ journalId: 'j1', pageId: 'p9', playerVisible: true })
    ).rejects.toThrow();
  });

  it('rejects a missing playerVisible / empty ids', async () => {
    const { tools } = build();
    await expect(
      tools.handleSetJournalPageVisibility({ journalId: 'j1', pageId: 'p1' })
    ).rejects.toThrow();
    await expect(
      tools.handleSetJournalPageVisibility({ journalId: '', pageId: 'p1', playerVisible: true })
    ).rejects.toThrow();
  });
});

describe('handleDeleteJournalPage', () => {
  it('forwards journalId/pageId and reports the deleted page', async () => {
    const { tools, calls } = build({
      success: true,
      deleted: true,
      page: { id: 'p2', name: 'Stray' },
    });
    const out = await tools.handleDeleteJournalPage({ journalId: 'j1', pageId: 'p2' });
    expect(calls[0][0]).toBe('deleteJournalPage');
    expect(calls[0][1]).toEqual({ journalId: 'j1', pageId: 'p2' });
    expect(out).toMatchObject({ success: true, deleted: true, page: { id: 'p2', name: 'Stray' } });
  });

  it('reports not-found when the page id does not resolve', async () => {
    const { tools } = build({ success: true, deleted: false, notFound: 'p9' });
    const out = await tools.handleDeleteJournalPage({ journalId: 'j1', pageId: 'p9' });
    expect(out).toMatchObject({ success: true, deleted: false, notFound: 'p9' });
  });

  it('rejects empty ids', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteJournalPage({ journalId: 'j1', pageId: '' })).rejects.toThrow();
  });
});

describe('handleDeleteJournal', () => {
  it('forwards identifiers and reports the deleted count', async () => {
    const { tools, calls } = build({
      deletedCount: 2,
      deleted: [
        { name: 'Quest One', id: 'a' },
        { name: 'Quest Two', id: 'b' },
      ],
      notFound: [],
    });
    const out = await tools.handleDeleteJournal({ identifiers: ['a', 'b'] });
    expect(calls[0][0]).toBe('deleteJournals');
    expect(calls[0][1]).toEqual({ identifiers: ['a', 'b'] });
    expect(out).toMatchObject({
      success: true,
      deletedCount: 2,
      message: 'Deleted 2 journal(s)',
    });
    expect(out.deleted).toHaveLength(2);
  });

  it('passes through a notFound list from the bridge', async () => {
    const { tools } = build({ deletedCount: 0, deleted: [], notFound: ['ghost'] });
    const out = await tools.handleDeleteJournal({ identifiers: ['ghost'] });
    expect(out.notFound).toEqual(['ghost']);
    expect(out.message).toBe('Deleted 0 journal(s)');
  });

  it('throws when the bridge returns an error', async () => {
    const { tools } = build({ error: 'failed' });
    await expect(tools.handleDeleteJournal({ identifiers: ['a'] })).rejects.toThrow();
  });

  it('rejects an empty identifiers array', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteJournal({ identifiers: [] })).rejects.toThrow();
  });

  it('rejects an identifier that is an empty string', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteJournal({ identifiers: [''] })).rejects.toThrow();
  });
});
