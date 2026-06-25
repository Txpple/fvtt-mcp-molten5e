/**
 * Unit tests for CardsTools (create-cards, list-cards, delete-cards).
 *
 * Covers the two things these handlers own before the bridge is reached:
 *   1. zod input validation — required fields, enum membership, non-empty
 *      strings/arrays are enforced (bad input throws, never hits the bridge).
 *   2. response formatting — the human-readable string built from the bridge
 *      result.
 */

import { describe, it, expect } from 'vitest';
import { CardsTools } from './cards.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new CardsTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('CardsTools.getToolDefinitions', () => {
  it('exposes exactly the four cards tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(['create-cards', 'delete-cards', 'import-cards', 'list-cards']);
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('handleCreateCards', () => {
  it('forwards a valid request and formats the result', async () => {
    const { tools, calls } = build({
      type: 'deck',
      cardsName: 'Tarokka',
      cardsId: 'c1',
      cardCount: 54,
    });
    const out = await tools.handleCreateCards({ name: 'Tarokka', type: 'deck' });
    expect(calls[0][0]).toBe('createCards');
    expect(calls[0][1]).toMatchObject({ name: 'Tarokka', type: 'deck' });
    expect(out).toBe('Created deck "Tarokka" (c1) with 54 card(s).');
  });

  it('passes optional description, folderName and cards (text + img) through', async () => {
    const { tools, calls } = build({
      type: 'pile',
      cardsName: 'Loot',
      cardsId: 'x',
      cardCount: 1,
    });
    await tools.handleCreateCards({
      name: 'Loot',
      type: 'pile',
      description: 'a pile',
      folderName: 'Decks',
      cards: [{ name: 'The Sun', text: '<p>Gain a Wondrous item.</p>', img: 'path/sun.webp' }],
    });
    expect(calls[0][1]).toMatchObject({
      description: 'a pile',
      folderName: 'Decks',
      cards: [{ name: 'The Sun', text: '<p>Gain a Wondrous item.</p>', img: 'path/sun.webp' }],
    });
  });

  it('rejects an empty name', async () => {
    const { tools } = build();
    await expect(tools.handleCreateCards({ name: '', type: 'deck' })).rejects.toThrow();
  });

  it('rejects a missing name', async () => {
    const { tools } = build();
    await expect(tools.handleCreateCards({ type: 'deck' })).rejects.toThrow();
  });

  it('rejects an invalid stack type', async () => {
    const { tools } = build();
    await expect(tools.handleCreateCards({ name: 'X', type: 'spread' })).rejects.toThrow();
  });

  it('rejects a card with an empty name', async () => {
    const { tools } = build();
    await expect(tools.handleCreateCards({ name: 'X', cards: [{ name: '' }] })).rejects.toThrow();
  });
});

describe('handleImportCards', () => {
  it('forwards a valid preset import and formats the result', async () => {
    const { tools, calls } = build({
      type: 'deck',
      cardsName: 'Poker Deck',
      cardsId: 'p1',
      cardCount: 52,
      preset: 'pokerDark',
    });
    const out = await tools.handleImportCards({ preset: 'pokerDark', folderName: 'Decks' });
    expect(calls[0][0]).toBe('importCardsPreset');
    expect(calls[0][1]).toMatchObject({ preset: 'pokerDark', folderName: 'Decks' });
    expect(out).toBe('Imported deck "Poker Deck" (p1) from preset "pokerDark" — 52 card(s).');
  });

  it('rejects a missing preset', async () => {
    const { tools } = build();
    await expect(tools.handleImportCards({ folderName: 'Decks' })).rejects.toThrow();
  });
});

describe('handleListCards', () => {
  it('formats a populated list', async () => {
    const { tools, calls } = build([
      { name: 'Tarokka', id: 'c1', type: 'deck', cardCount: 54 },
      { name: 'Hand', id: 'h1', type: 'hand', cardCount: 5 },
    ]);
    const out = await tools.handleListCards({});
    expect(calls[0][0]).toBe('listCards');
    expect(out).toBe(
      'Card stacks (2):\n' +
        '  - "Tarokka" (c1) — deck, 54 card(s)\n' +
        '  - "Hand" (h1) — hand, 5 card(s)'
    );
  });

  it('reports when no stacks exist', async () => {
    const { tools } = build([]);
    const out = await tools.handleListCards({});
    expect(out).toBe('No card stacks found.');
  });

  it('reports when the bridge returns null', async () => {
    const { tools } = build(null);
    const out = await tools.handleListCards({});
    expect(out).toBe('No card stacks found.');
  });
});

describe('handleDeleteCards', () => {
  it('forwards a valid delete and lists the removed stacks', async () => {
    const { tools, calls } = build({
      deletedCount: 2,
      deleted: [
        { name: 'Tarokka', id: 'c1' },
        { name: 'Hand', id: 'h1' },
      ],
      notFound: [],
    });
    const out = await tools.handleDeleteCards({ identifiers: ['c1', 'h1'] });
    expect(calls[0][0]).toBe('deleteCards');
    expect(calls[0][1]).toEqual({ identifiers: ['c1', 'h1'] });
    expect(out).toBe('Deleted 2 card stack(s):\n  - "Tarokka" (c1)\n  - "Hand" (h1)');
  });

  it('appends a not-found list when ids do not resolve', async () => {
    const { tools } = build({
      deletedCount: 0,
      deleted: [],
      notFound: ['ghost'],
    });
    const out = await tools.handleDeleteCards({ identifiers: ['ghost'] });
    expect(out).toContain('not found: ghost');
  });

  it('rejects a missing identifiers array', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteCards({})).rejects.toThrow();
  });

  it('rejects an empty identifiers array', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteCards({ identifiers: [] })).rejects.toThrow();
  });

  it('rejects an identifier that is an empty string', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteCards({ identifiers: [''] })).rejects.toThrow();
  });
});
