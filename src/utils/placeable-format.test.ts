/** Unit tests for the pure placeable output formatters (utils/placeable-format.ts). */

import { describe, it, expect } from 'vitest';
import {
  formatCreatePlaceables,
  formatDeletePlaceables,
  formatListPlaceables,
  formatUpdatePlaceables,
} from './placeable-format.js';

describe('formatCreatePlaceables', () => {
  it('renders the count + one line per created id', () => {
    const out = formatCreatePlaceables(
      {
        sceneId: 'sc1',
        sceneName: 'Cave',
        created: 2,
        items: [{ id: 'a', name: 'X' }, { id: 'b' }],
      },
      'tile'
    );
    expect(out).toContain('Created 2 tile(s) on "Cave" (sc1)');
    expect(out).toContain('• a — X');
    expect(out).toContain('• b');
  });

  it('appends per-item errors and a warning block', () => {
    const out = formatCreatePlaceables(
      { sceneId: 'sc1', sceneName: 'Cave', created: 0, errors: ['Tile 0: bad'], warnings: ['w1'] },
      'tile'
    );
    expect(out).toContain('⚠ Tile 0: bad');
    expect(out).toContain('1 warning(s)');
    expect(out).toContain('- w1');
  });

  it('short-circuits on a not-found scene', () => {
    expect(formatCreatePlaceables({ notFound: 'Ghost' }, 'light')).toBe(
      'Scene not found: "Ghost". No lights created.'
    );
  });
});

describe('formatListPlaceables', () => {
  it('passes a found result through unchanged', () => {
    const r = { found: true, sceneId: 'sc1', count: 1, items: [{ id: 't' }] };
    expect(formatListPlaceables(r, 'tile')).toBe(r);
  });

  it('renders a not-found scene as a message', () => {
    expect(formatListPlaceables({ found: false, notFound: 'Ghost' }, 'tile')).toBe(
      'Scene not found: "Ghost" (no tiles).'
    );
  });
});

describe('formatUpdatePlaceables', () => {
  it('reports matched/updated', () => {
    const out = formatUpdatePlaceables(
      { sceneId: 'sc1', sceneName: 'Cave', matched: 2, updated: 2 },
      'tile'
    );
    expect(out).toBe('Updated 2 of 2 matched tile(s) on "Cave" (sc1)');
  });

  it('reports zero-match with the unresolved ids', () => {
    const out = formatUpdatePlaceables(
      { sceneId: 'sc1', sceneName: 'Cave', matched: 0, updated: 0, notFoundIds: ['x', 'y'] },
      'tile'
    );
    expect(out).toContain('No tiles matched on "Cave" (sc1)');
    expect(out).toContain('not found: x, y');
  });

  it('short-circuits on a not-found scene', () => {
    expect(formatUpdatePlaceables({ notFound: 'Ghost' }, 'tile')).toBe(
      'Scene not found: "Ghost". Nothing changed.'
    );
  });
});

describe('formatDeletePlaceables', () => {
  it('reports the deleted count + a missing-ids tail', () => {
    const out = formatDeletePlaceables(
      { sceneId: 'sc1', sceneName: 'Cave', deleted: 1, notFoundIds: ['ghost'] },
      'tile'
    );
    expect(out).toBe('Deleted 1 tile(s) from "Cave" (sc1) (1 id(s) not found: ghost).');
  });

  it('short-circuits on a not-found scene', () => {
    expect(formatDeletePlaceables({ notFound: 'Ghost' }, 'tile')).toBe(
      'Scene not found: "Ghost". Nothing deleted.'
    );
  });
});
