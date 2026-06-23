/**
 * Unit tests for the pure, browser-independent page helpers in _shared.ts.
 *
 * These run inside the headless Foundry page in production, but the functions
 * exercised here touch no `game.*`/DOM globals, so they unit-test cleanly in Node —
 * closing part of the page-layer coverage gap without a browser. The headline case
 * is the activities-Map regression: sanitizing a LIVE dnd5e `system` empties its
 * `activities` Map to `{}`, while sanitizing `toSource(doc).system` preserves it.
 */

import { describe, it, expect } from 'vitest';
import { normalizeAssetPath, basename, slugify, toSource, sanitizeDocData } from './_shared.js';

describe('normalizeAssetPath', () => {
  it('strips query, hash, host/protocol, backslashes, leading slash and Data/ prefix', () => {
    expect(normalizeAssetPath('https://host.example/Data/assets/x.webp?v=2#frag')).toBe(
      'assets/x.webp'
    );
    expect(normalizeAssetPath('/Data/maps/a.png')).toBe('maps/a.png');
    expect(normalizeAssetPath('assets\\audio\\b.ogg')).toBe('assets/audio/b.ogg');
    expect(normalizeAssetPath('data/foo')).toBe('foo'); // case-insensitive Data/ prefix
  });
  it('decodes percent-encoding but tolerates malformed encoding', () => {
    expect(normalizeAssetPath('assets/a%20b.png')).toBe('assets/a b.png');
    expect(normalizeAssetPath('assets/100%.png')).toBe('assets/100%.png'); // invalid % left as-is
  });
  it('returns empty string for empty/non-string input', () => {
    expect(normalizeAssetPath('')).toBe('');
    expect(normalizeAssetPath(undefined as unknown as string)).toBe('');
  });
});

describe('basename', () => {
  it('returns the last path segment', () => {
    expect(basename('a/b/c.png')).toBe('c.png');
    expect(basename('solo.webp')).toBe('solo.webp');
    expect(basename('a/b/')).toBe('b'); // trailing slash ignored
  });
});

describe('slugify', () => {
  it('lowercases, strips accents, and hyphenates', () => {
    expect(slugify('Fire Bolt')).toBe('fire-bolt');
    expect(slugify('Élan Vital!')).toBe('elan-vital');
  });
  it('falls back to the default only when every char is stripped away', () => {
    expect(slugify('***')).toBe('feature'); // no [a-z0-9-] survives → fallback
    expect(slugify('***', 'feat')).toBe('feat'); // custom fallback
  });
});

describe('toSource', () => {
  it('returns document.toObject() when present, else the value unchanged', () => {
    const doc = { toObject: () => ({ system: { a: 1 } }) };
    expect(toSource(doc)).toEqual({ system: { a: 1 } });
    const plain = { system: { a: 1 } };
    expect(toSource(plain)).toBe(plain);
    expect(toSource(null)).toBe(null);
  });

  it('REGRESSION: sanitizing a live system drops a Map; via toSource it survives', () => {
    // dnd5e 5.x: system.activities is a Map. Object.keys() on a Map is [] → empties to {}.
    const activities = new Map([['a1', { type: 'attack', damage: '1d8' }]]);
    const liveSystem = { name: 'Longsword', activities };
    const doc = {
      system: liveSystem,
      toObject: () => ({
        system: { name: 'Longsword', activities: { a1: { type: 'attack', damage: '1d8' } } },
      }),
    };

    // The bug: sanitizing the LIVE system silently empties activities.
    expect(sanitizeDocData(doc.system).activities).toEqual({});

    // The fix: sanitize toSource(doc).system instead.
    expect(sanitizeDocData(toSource(doc).system).activities).toEqual({
      a1: { type: 'attack', damage: '1d8' },
    });
  });
});

describe('sanitizeDocData', () => {
  it('drops sensitive and problematic keys, keeps _id but no other underscore keys', () => {
    const out = sanitizeDocData({
      _id: 'keepme',
      _stats: { bloat: true },
      password: 'nope',
      parent: { cyclic: true },
      name: 'ok',
      nested: { secret: 'no', value: 1 },
    });
    expect(out).toEqual({ _id: 'keepme', name: 'ok', nested: { value: 1 } });
  });

  it('guards against circular references', () => {
    const a: any = { name: 'a' };
    a.self = a;
    const out = sanitizeDocData(a);
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular Reference]');
  });

  it('skips deprecated dnd5e legacy sense getters when the modern ranges shape exists', () => {
    const out = sanitizeDocData({ ranges: { darkvision: 60 }, darkvision: 60, blindsight: 0 });
    expect(out).toEqual({ ranges: { darkvision: 60 } });
  });

  it('passes primitives through unchanged', () => {
    expect(sanitizeDocData(5)).toBe(5);
    expect(sanitizeDocData('x')).toBe('x');
    expect(sanitizeDocData(null)).toBe(null);
  });
});
