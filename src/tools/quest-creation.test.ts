/**
 * Unit tests for QuestCreationTools.
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
import { QuestCreationTools } from './quest-creation.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new QuestCreationTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('QuestCreationTools.getToolDefinitions', () => {
  it('exposes exactly the eight expected tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual([
      'create-journal',
      'create-quest-journal',
      'delete-journal',
      'link-quest-to-npc',
      'list-journals',
      'search-journals',
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

describe('handleCreateQuestJournal', () => {
  it('forwards the quest title + generated content and reports the page count', async () => {
    const { tools, calls } = build({ id: 'j1', name: 'Find the Amulet', pageCount: 1 });
    const out = await tools.handleCreateQuestJournal({
      questTitle: 'Find the Amulet',
      questDescription: 'A precious amulet was stolen.',
    });

    expect(calls[0][0]).toBe('createJournalEntry');
    expect(calls[0][1].name).toBe('Find the Amulet');
    // Generated HTML content carries the title and the lead description.
    expect(calls[0][1].content).toContain('Find the Amulet');
    expect(calls[0][1].content).toContain('A precious amulet was stolen.');

    expect(out).toMatchObject({
      success: true,
      journalId: 'j1',
      journalName: 'Find the Amulet',
      pageCount: 1,
      message: 'Quest "Find the Amulet" created successfully with 1 page(s)',
    });
  });

  it('passes folderName and additionalPages through to the bridge', async () => {
    const { tools, calls } = build({ id: 'j2', name: 'Side Quest', pageCount: 2 });
    await tools.handleCreateQuestJournal({
      questTitle: 'Side Quest',
      questDescription: 'Help the villagers.',
      folderName: 'Quests',
      additionalPages: [{ name: 'Player Handout', content: '<p>Hello</p>' }],
    });
    expect(calls[0][1].folderName).toBe('Quests');
    expect(calls[0][1].additionalPages).toEqual([
      { name: 'Player Handout', content: '<p>Hello</p>' },
    ]);
  });

  it('embeds quest-detail fields (type, difficulty, location) into the content', async () => {
    const { tools, calls } = build({ id: 'j3', name: 'Hunt', pageCount: 1 });
    await tools.handleCreateQuestJournal({
      questTitle: 'Hunt',
      questDescription: 'Track the beast.',
      questType: 'kill',
      difficulty: 'hard',
      location: 'Darkwood',
      questGiver: 'Mayor Tom',
      rewards: '500 gold',
    });
    const content = calls[0][1].content;
    expect(content).toContain('Kill Quest'); // questType capitalized
    expect(content).toContain('Hard'); // difficulty capitalized
    expect(content).toContain('Darkwood'); // location
    expect(content).toContain('Mayor Tom'); // quest giver
    expect(content).toContain('500 gold'); // rewards
  });

  it('throws when the bridge returns an error payload', async () => {
    const { tools } = build({ error: 'boom' });
    await expect(
      tools.handleCreateQuestJournal({ questTitle: 'X', questDescription: 'Y' })
    ).rejects.toThrow();
  });

  it('rejects a missing questDescription', async () => {
    const { tools } = build();
    await expect(tools.handleCreateQuestJournal({ questTitle: 'X' })).rejects.toThrow();
  });

  it('rejects an empty questTitle', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateQuestJournal({ questTitle: '', questDescription: 'Y' })
    ).rejects.toThrow();
  });

  it('rejects an invalid questType enum value', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateQuestJournal({
        questTitle: 'X',
        questDescription: 'Y',
        questType: 'epic',
      })
    ).rejects.toThrow();
  });

  it('rejects an additionalPages entry with empty content', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateQuestJournal({
        questTitle: 'X',
        questDescription: 'Y',
        additionalPages: [{ name: 'Page', content: '' }],
      })
    ).rejects.toThrow();
  });
});

describe('handleLinkQuestToNPC', () => {
  it('reads the journal, writes the linked content, and reports the relationship', async () => {
    const { tools, calls } = build((method: string) => {
      if (method === 'getJournalContent')
        return { content: '<section class="mcp-journal"><div></div></section>' };
      if (method === 'updateJournalContent') return { success: true };
      return {};
    });

    const out = await tools.handleLinkQuestToNPC({
      journalId: 'j1',
      npcName: 'Gandalf',
      relationship: 'questGiver',
    });

    expect(calls[0][0]).toBe('getJournalContent');
    expect(calls[0][1]).toEqual({ journalId: 'j1' });
    const updateCall = calls.find(c => c[0] === 'updateJournalContent');
    expect(updateCall![1].journalId).toBe('j1');
    expect(updateCall![1].content).toContain('Gandalf');

    // relationship has its underscore replaced with a space in the message.
    expect(out).toEqual({
      success: true,
      message: 'Linked Gandalf to quest as quest giver',
    });
  });

  it('throws when the journal cannot be found', async () => {
    const { tools } = build((method: string) =>
      method === 'getJournalContent' ? { error: 'not found' } : {}
    );
    await expect(
      tools.handleLinkQuestToNPC({ journalId: 'bad', npcName: 'X', relationship: 'ally' })
    ).rejects.toThrow();
  });

  it('rejects an invalid relationship enum value', async () => {
    const { tools } = build();
    await expect(
      tools.handleLinkQuestToNPC({ journalId: 'j', npcName: 'X', relationship: 'frenemy' })
    ).rejects.toThrow();
  });

  it('rejects an empty npcName', async () => {
    const { tools } = build();
    await expect(
      tools.handleLinkQuestToNPC({ journalId: 'j', npcName: '', relationship: 'ally' })
    ).rejects.toThrow();
  });
});

describe('handleUpdateQuestJournal', () => {
  it('creates a new page when newPageName is given (no read-modify-write)', async () => {
    const { tools, calls } = build((method: string) => {
      if (method === 'updateJournalContent')
        return { success: true, pageId: 'p9', pageName: 'Session 2' };
      return {};
    });

    const out = await tools.handleUpdateQuestJournal({
      journalId: 'j1',
      newContent: 'The party reached the keep.',
      updateType: 'progress',
      newPageName: 'Session 2',
    });

    // Only a single bridge call: the create-page write. No getJournalContent read.
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('updateJournalContent');
    expect(calls[0][1].newPageName).toBe('Session 2');
    expect(calls[0][1].content).toContain('The party reached the keep.');

    expect(out).toMatchObject({
      success: true,
      updateType: 'progress',
      message: 'New page "Session 2" created in journal',
      pageId: 'p9',
      pageName: 'Session 2',
      verified: true,
    });
  });

  it('appends to the first text page and verifies the grown content', async () => {
    // Stateful mock: the verify read-back must return the WRITTEN (grown)
    // content, mirroring the real bridge, or verification would fail.
    const original = '<section class="mcp-journal"><div>old</div></section>';
    let stored = original;
    const { tools, calls } = build((method: string, data: any) => {
      if (method === 'getJournalContent') return { content: stored };
      if (method === 'updateJournalContent') {
        stored = data.content;
        return { success: true, pageId: 'p1', pageName: 'Quest' };
      }
      return {};
    });

    const out = await tools.handleUpdateQuestJournal({
      journalId: 'j1',
      newContent: 'New milestone reached.',
      updateType: 'progress',
    });

    // Reads current content, writes updated content, reads back to verify.
    expect(calls.map(c => c[0])).toEqual([
      'getJournalContent',
      'updateJournalContent',
      'getJournalContent',
    ]);
    const writeCall = calls[1];
    expect(writeCall[1].content).toContain('New milestone reached.');
    expect(writeCall[1].content).toContain('Progress Update');

    expect(out).toMatchObject({ success: true, updateType: 'progress', verified: true });
  });

  it('appends to a specific page when pageId is supplied', async () => {
    // Stateful: page read-back returns the appended content so verify passes.
    let stored = '<p>existing page text</p>';
    const { tools, calls } = build((method: string, data: any) => {
      if (method === 'getJournalPageContent') return { content: stored };
      if (method === 'updateJournalContent') {
        stored = data.content;
        return { success: true, pageId: 'p2', pageName: 'Notes' };
      }
      return {};
    });

    const out = await tools.handleUpdateQuestJournal({
      journalId: 'j1',
      pageId: 'p2',
      newContent: 'A clue was found.',
      updateType: 'modification',
    });

    // Page read -> write (carrying pageId) -> page read-back to verify.
    expect(calls.map(c => c[0])).toEqual([
      'getJournalPageContent',
      'updateJournalContent',
      'getJournalPageContent',
    ]);
    expect(calls[1][1].pageId).toBe('p2');
    expect(calls[1][1].content).toContain('A clue was found.');
    expect(out).toMatchObject({ success: true, verified: true });
  });

  it('throws when the target journal has no content', async () => {
    const { tools } = build((method: string) =>
      method === 'getJournalContent' ? { content: '' } : {}
    );
    await expect(
      tools.handleUpdateQuestJournal({
        journalId: 'j1',
        newContent: 'x',
        updateType: 'progress',
      })
    ).rejects.toThrow();
  });

  it('rejects an invalid updateType enum value', async () => {
    const { tools } = build();
    await expect(
      tools.handleUpdateQuestJournal({
        journalId: 'j1',
        newContent: 'x',
        updateType: 'restart',
      })
    ).rejects.toThrow();
  });

  it('rejects an empty newContent', async () => {
    const { tools } = build();
    await expect(
      tools.handleUpdateQuestJournal({
        journalId: 'j1',
        newContent: '',
        updateType: 'progress',
      })
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
