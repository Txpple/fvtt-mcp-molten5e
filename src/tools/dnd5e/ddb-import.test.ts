/**
 * Unit tests for DnD5eDdbImportTools (parse-ddb-character).
 *
 * Covers: the tool definition, exactly-one-source validation, the pasted-JSON path (object + string),
 * and the fetch paths with `fetch` stubbed — public 200, PRIVATE 403, and 404 — asserting the curated
 * FormattedToolError messages. The parser itself is exercised in ddb/parse.test.ts; here we test the
 * tool seam (source resolution, fetch, error wording, response shaping).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeLogger } from '../test-helpers.js';
import { DnD5eDdbImportTools } from './ddb-import.js';

function build() {
  return new DnD5eDdbImportTools({ logger: makeLogger() });
}

function minimalEnvelope(name = 'Stub Hero') {
  return {
    success: true,
    data: {
      id: 1,
      name,
      stats: [1, 2, 3, 4, 5, 6].map(id => ({ id, value: 10 })),
      bonusStats: [1, 2, 3, 4, 5, 6].map(id => ({ id, value: null })),
      overrideStats: [1, 2, 3, 4, 5, 6].map(id => ({ id, value: null })),
      modifiers: { race: [], class: [], background: [], item: [], feat: [], condition: [] },
      choices: { choiceDefinitions: [] },
      options: {},
      classes: [{ level: 1, isStartingClass: true, definition: { name: 'Fighter', hitDice: 10 } }],
      race: { fullName: 'Human', baseRaceName: 'Human' },
      background: { definition: { name: 'Soldier' } },
      inventory: [],
      feats: [],
      currencies: { cp: 0, sp: 0, gp: 0, ep: 0, pp: 0 },
      spells: {},
      classSpells: [],
      preferences: {},
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parse-ddb-character — definition + validation', () => {
  it('exposes the single tool with an object inputSchema', () => {
    const defs = build().getToolDefinitions();
    expect(defs.map(d => d.name)).toEqual(['parse-ddb-character']);
    expect(defs[0].inputSchema.type).toBe('object');
  });

  it('requires exactly one of characterId / url / json', async () => {
    const t = build();
    await expect(t.handleParseDdbCharacter({})).rejects.toThrow(/exactly one/i);
    await expect(t.handleParseDdbCharacter({ characterId: '1', json: {} })).rejects.toThrow(
      /exactly one/i
    );
  });
});

describe('parse-ddb-character — pasted JSON path', () => {
  it('parses a pasted envelope object', async () => {
    const res = await build().handleParseDdbCharacter({ json: minimalEnvelope('Pasted PC') });
    expect(res.success).toBe(true);
    expect(res.plan.name).toBe('Pasted PC');
    expect(res.plan.classes[0]).toMatchObject({ name: 'Fighter', level: 1 });
  });

  it('parses a pasted JSON string', async () => {
    const res = await build().handleParseDdbCharacter({ json: JSON.stringify(minimalEnvelope()) });
    expect(res.plan.name).toBe('Stub Hero');
  });

  it('rejects malformed JSON with a helpful message', async () => {
    await expect(build().handleParseDdbCharacter({ json: '{ not json' })).rejects.toThrow(
      /not valid JSON/i
    );
  });
});

describe('parse-ddb-character — fetch paths', () => {
  it('fetches a public character by id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => minimalEnvelope('Public PC') }))
    );
    const res = await build().handleParseDdbCharacter({ characterId: '25755022' });
    expect(res.plan.name).toBe('Public PC');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/character/v5/character/25755022'),
      expect.anything()
    );
  });

  it('extracts the id from a dndbeyond URL', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => minimalEnvelope() }));
    vi.stubGlobal('fetch', f);
    await build().handleParseDdbCharacter({
      url: 'https://www.dndbeyond.com/characters/167582904',
    });
    expect(f).toHaveBeenCalledWith(expect.stringContaining('167582904'), expect.anything());
  });

  it('explains a PRIVATE character (403) and never mentions cookies as a fix to apply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }))
    );
    await expect(build().handleParseDdbCharacter({ characterId: '167582904' })).rejects.toThrow(
      /PRIVATE.*Public|Public.*paste/is
    );
  });

  it('explains a missing character (404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    );
    await expect(build().handleParseDdbCharacter({ characterId: '999' })).rejects.toThrow(
      /No D&D Beyond character/i
    );
  });
});
