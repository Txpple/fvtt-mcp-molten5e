/**
 * Unit tests for the Note (map-pin) descriptor: the dump, the create/patch field mapping, and the
 * strict journal/page resolution (via a minimal `game.journal` stub — ambiguity throws, re-pointing
 * without a page CLEARS pageId). The icon SUBSTITUTE-BY-DROP branch needs a live 404 (imgResolves
 * fails open offline), so it stays live-verified.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { noteDescriptor, resolveNoteTarget } from './note.js';

const CTX = { scene: {} };

function stubJournals(entries: Array<{ id: string; name: string; pages?: any[] }>) {
  const withPages = entries.map(e => {
    const pages = e.pages ?? [];
    return {
      ...e,
      pages: {
        get: (id: string) => pages.find((p: any) => p.id === id),
        [Symbol.iterator]: function* () {
          yield* pages;
        },
      },
    };
  });
  (globalThis as any).game = {
    journal: {
      get: (id: string) => withPages.find(e => e.id === id),
      [Symbol.iterator]: function* () {
        yield* withPages;
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as any).game;
});

describe('noteDescriptor.dump', () => {
  it('maps the numeric text anchor to a name and surfaces the journal link', () => {
    const doc = {
      id: 'n1',
      x: 1617,
      y: 955,
      text: '01 — Cart Wreckage',
      entryId: 'jrn1',
      pageId: 'pg1',
      iconSize: 40,
      global: false,
      textAnchor: 1,
      fontSize: 32,
      texture: { src: 'icons/svg/book.svg' },
    };
    expect(noteDescriptor.dump(doc)).toMatchObject({
      id: 'n1',
      text: '01 — Cart Wreckage',
      entryId: 'jrn1',
      pageId: 'pg1',
      textAnchor: 'bottom',
      src: 'icons/svg/book.svg',
    });
  });

  it('nulls a missing entry/page link', () => {
    const out = noteDescriptor.dump({ id: 'n', entryId: '', pageId: null, texture: {} });
    expect(out.entryId).toBeNull();
    expect(out.pageId).toBeNull();
  });
});

describe('resolveNoteTarget (strict journal/page resolution)', () => {
  it('resolves by id and by exact name; page optional', () => {
    stubJournals([{ id: 'j1', name: 'Temple Keys', pages: [{ id: 'p1', name: '1 — Entry' }] }]);
    expect(resolveNoteTarget('j1')).toEqual({ entryId: 'j1' });
    expect(resolveNoteTarget('Temple Keys', '1 — Entry')).toEqual({ entryId: 'j1', pageId: 'p1' });
  });

  it('throws on no match, an ambiguous name, and a missing page', () => {
    stubJournals([
      { id: 'j1', name: 'Twin' },
      { id: 'j2', name: 'Twin' },
      { id: 'j3', name: 'Solo' },
    ]);
    expect(() => resolveNoteTarget('Nope')).toThrow(/No journal found/);
    expect(() => resolveNoteTarget('Twin')).toThrow(/Ambiguous/);
    expect(() => resolveNoteTarget('Solo', 'Ghost Page')).toThrow(/No page/);
  });
});

describe('noteDescriptor.toCreateDoc', () => {
  it('builds the pin doc with resolved entry/page + only-supplied fields', async () => {
    stubJournals([{ id: 'j1', name: 'Temple Keys', pages: [{ id: 'p1', name: '1 — Entry' }] }]);
    const r = (await noteDescriptor.toCreateDoc!(
      {
        journal: 'Temple Keys',
        page: '1 — Entry',
        x: 100,
        y: 200,
        label: '1 — Entry',
        global: true,
      },
      CTX
    )) as { doc?: any };
    expect(r.doc).toEqual({
      entryId: 'j1',
      pageId: 'p1',
      x: 100,
      y: 200,
      text: '1 — Entry',
      global: true,
    });
  });

  it('errors (isolated) on a missing journal or coordinates', async () => {
    stubJournals([]);
    expect((await noteDescriptor.toCreateDoc!({ x: 1, y: 2 }, CTX)).error).toMatch(/journal/);
    expect((await noteDescriptor.toCreateDoc!({ journal: 'X', x: 1 }, CTX)).error).toMatch(/y/);
  });
});

describe('noteDescriptor.buildPatch', () => {
  it('patches only supplied fields; re-pointing without a page CLEARS pageId', async () => {
    stubJournals([{ id: 'j2', name: 'New Keys' }]);
    const r = await noteDescriptor.buildPatch!(
      {},
      { id: 'n1', x: 150, label: 'Antechamber', journal: 'New Keys' },
      CTX
    );
    expect(r.changed).toBe(true);
    expect(r.patch).toEqual({ x: 150, text: 'Antechamber', entryId: 'j2', pageId: null });
  });

  it('changed:false when only the id is supplied', async () => {
    const r = await noteDescriptor.buildPatch!({}, { id: 'n1' }, CTX);
    expect(r.changed).toBe(false);
  });
});
