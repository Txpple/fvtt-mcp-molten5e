/** Unit test for the read-only Note descriptor's dump (text-anchor mapping + journal link fields). */

import { describe, it, expect } from 'vitest';
import { noteDescriptor } from './note.js';

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

  it('nulls a missing entry/page link and is list-only', () => {
    const out = noteDescriptor.dump({ id: 'n', entryId: '', pageId: null, texture: {} });
    expect(out.entryId).toBeNull();
    expect(out.pageId).toBeNull();
    expect(noteDescriptor.toCreateDoc).toBeUndefined();
  });
});
