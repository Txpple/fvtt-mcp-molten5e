/**
 * Offline unit tests for the PURE soundscape helpers (src/page/soundscape.ts) — the set
 * normalizer/clamps, the day/night gate, set resolution, and the template-library filter. These
 * run in Node with no Foundry globals; the page-coupled write paths (flag persistence, the asset
 * HEAD-check, module detection) are exercised by scripts/verify-soundscape-tooling.mjs.
 *
 * The normalizer here MIRRORS fvtt-mod-soundscape's own scripts/engine.js#normalizeSet. These
 * tests pin the defaults and clamps to that contract, so a drift shows up here rather than as a
 * malformed set on a scene.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSoundscapeSet,
  gateAllows,
  describeTiming,
  resolveSet,
  matchTemplates,
  summarizeLibrary,
  NIGHT_DARKNESS,
  type SoundscapeSet,
  type SoundscapeTemplate,
} from './soundscape.js';

const set = (over: Partial<SoundscapeSet> = {}): SoundscapeSet =>
  normalizeSoundscapeSet({ id: 'fixed', name: 'A Set', ...over }).set;

describe('normalizeSoundscapeSet defaults', () => {
  it('fills the module schema from an empty blob', () => {
    const { set: s } = normalizeSoundscapeSet({ id: 'x' });
    expect(s).toEqual({
      id: 'x',
      name: 'New Sound Set',
      active: true,
      files: [],
      playStyle: 'interval',
      interval: 25,
      intervalVariation: 5,
      crossfade: 4,
      volume: 0.8,
      volumeVariation: 0,
      pitchVariation: 0,
      whenToPlay: 'always',
    });
  });

  it('generates a module-shaped id when none is supplied', () => {
    const { set: s } = normalizeSoundscapeSet({});
    expect(s.id).toMatch(/^[a-z0-9]{1,10}$/);
    expect(normalizeSoundscapeSet({}).set.id).not.toBe(s.id);
  });

  it('trims a name and falls back when it is blank', () => {
    expect(normalizeSoundscapeSet({ name: '  Crows  ' }).set.name).toBe('Crows');
    expect(normalizeSoundscapeSet({ name: '   ' }).set.name).toBe('New Sound Set');
  });

  it('treats only an explicit false as inactive', () => {
    expect(normalizeSoundscapeSet({ active: false }).set.active).toBe(false);
    expect(normalizeSoundscapeSet({ active: undefined }).set.active).toBe(true);
  });

  it('drops non-string and empty file entries instead of storing them', () => {
    const { set: s } = normalizeSoundscapeSet({ files: ['a.ogg', '', null, 7, 'b.ogg'] });
    expect(s.files).toEqual(['a.ogg', 'b.ogg']);
  });

  it('accepts only "loop" as the non-default play style', () => {
    expect(normalizeSoundscapeSet({ playStyle: 'loop' }).set.playStyle).toBe('loop');
    expect(normalizeSoundscapeSet({ playStyle: 'nonsense' }).set.playStyle).toBe('interval');
  });

  it('accepts only day/night as the non-default gate', () => {
    expect(normalizeSoundscapeSet({ whenToPlay: 'night' }).set.whenToPlay).toBe('night');
    expect(normalizeSoundscapeSet({ whenToPlay: 'dusk' }).set.whenToPlay).toBe('always');
  });

  it('repairs a genuinely non-numeric field to its default rather than throwing', () => {
    const { set: s, clamped } = normalizeSoundscapeSet({ interval: 'soon', crossfade: undefined });
    expect(s.interval).toBe(25);
    expect(s.crossfade).toBe(4);
    expect(clamped).toEqual([]); // a repair is not a clamp — nothing numeric was asked for
  });

  // Sharp edge, MIRRORED from the module on purpose: the fallback tests `Number.isFinite(+v)`, and
  // JS coerces null / "" / [] to 0 — so those land on the clamped floor, not on the default. The
  // module re-normalizes the flag on every read, so diverging here would make the tool report a
  // value the engine will not actually use. zod keeps null out of the tool path; this only bites a
  // set that was already malformed on the scene.
  it('coerces null/empty to zero exactly as the module does, not to the default', () => {
    expect(normalizeSoundscapeSet({ volume: null }).set.volume).toBe(0);
    expect(normalizeSoundscapeSet({ volume: '' }).set.volume).toBe(0);
    expect(normalizeSoundscapeSet({ interval: null }).set.interval).toBe(1); // clamped to the floor
  });
});

describe('normalizeSoundscapeSet clamps', () => {
  it('clamps each field to the module range and reports what moved', () => {
    const { set: s, clamped } = normalizeSoundscapeSet({
      interval: 9000,
      crossfade: 99,
      volume: 4,
      volumeVariation: -1,
      pitchVariation: 12,
    });
    expect(s.interval).toBe(3600);
    expect(s.crossfade).toBe(30);
    expect(s.volume).toBe(1);
    expect(s.volumeVariation).toBe(0);
    expect(s.pitchVariation).toBe(1);
    expect(clamped).toEqual([
      'interval 9000 → 3600',
      'crossfade 99 → 30',
      'volume 4 → 1',
      'volumeVariation -1 → 0',
      'pitchVariation 12 → 1',
    ]);
  });

  // The trap this exists for: lowering `interval` on an existing set would otherwise leave a
  // larger `intervalVariation` behind and ask the scheduler for a negative gap.
  it('bounds intervalVariation BY the interval, not by a fixed ceiling', () => {
    const { set: s, clamped } = normalizeSoundscapeSet({ interval: 10, intervalVariation: 20 });
    expect(s.intervalVariation).toBe(10);
    expect(clamped).toContain('intervalVariation 20 → 10');
  });

  it('leaves an in-range value alone and reports no clamp', () => {
    const { clamped } = normalizeSoundscapeSet({ interval: 30, volume: 0.5 });
    expect(clamped).toEqual([]);
  });
});

describe('gateAllows', () => {
  it('always-gated sets play at any darkness', () => {
    expect(gateAllows({ whenToPlay: 'always' }, 0)).toBe(true);
    expect(gateAllows({ whenToPlay: 'always' }, 1)).toBe(true);
  });

  it('splits day and night at the module threshold', () => {
    expect(gateAllows({ whenToPlay: 'day' }, NIGHT_DARKNESS - 0.01)).toBe(true);
    expect(gateAllows({ whenToPlay: 'day' }, NIGHT_DARKNESS)).toBe(false);
    expect(gateAllows({ whenToPlay: 'night' }, NIGHT_DARKNESS)).toBe(true);
    expect(gateAllows({ whenToPlay: 'night' }, NIGHT_DARKNESS - 0.01)).toBe(false);
  });
});

describe('describeTiming', () => {
  it('reads as silence-between for interval sets', () => {
    expect(describeTiming(set({ interval: 30, intervalVariation: 8 }))).toBe('every 30 ± 8s');
  });

  it('reads as a crossfade for loop sets', () => {
    expect(describeTiming(set({ playStyle: 'loop', crossfade: 6 }))).toBe('loop · 6s crossfade');
  });
});

describe('resolveSet', () => {
  const sets = [
    set({ id: 'aaa', name: 'Crows' }),
    set({ id: 'bbb', name: 'Wolves' }),
    set({ id: 'ccc', name: 'Wolves' }),
  ];

  it('prefers an exact id', () => {
    expect(resolveSet(sets, 'bbb').id).toBe('bbb');
  });

  it('resolves a unique exact name', () => {
    expect(resolveSet(sets, 'Crows').id).toBe('aaa');
  });

  it('resolves a unique name case-insensitively', () => {
    expect(resolveSet(sets, 'crows').id).toBe('aaa');
  });

  // Editing the wrong set silently is worse than an error that names both candidates.
  it('throws on an ambiguous name and lists the ids', () => {
    expect(() => resolveSet(sets, 'Wolves')).toThrow(/matches 2 sound sets/);
    expect(() => resolveSet(sets, 'Wolves')).toThrow(/bbb.*ccc/s);
  });

  it('throws with the present sets when nothing matches', () => {
    expect(() => resolveSet(sets, 'Bees')).toThrow(/No sound set "Bees"/);
    expect(() => resolveSet(sets, 'Bees')).toThrow(/"Crows" \(aaa\)/);
  });

  it('says the scene is empty rather than listing nothing', () => {
    expect(() => resolveSet([], 'Bees')).toThrow(/no sound sets yet/);
  });
});

describe('matchTemplates', () => {
  const templates: SoundscapeTemplate[] = [
    { name: 'Tavern Crowd', section: 'Interval Sounds', category: 'Voices — Tavern' },
    { name: 'Busy Tavern', section: 'Ambient Loops', category: 'Interiors' },
    { name: 'Forest Day', section: 'Ambient Loops', category: 'Forest' },
    { name: 'Wolves', section: 'Interval Sounds', category: 'Animals' },
  ];

  it('returns everything when no filter is given', () => {
    expect(matchTemplates(templates, {})).toHaveLength(4);
  });

  it('matches on name, category, or section', () => {
    expect(matchTemplates(templates, { query: 'tavern' }).map(t => t.name)).toEqual([
      'Tavern Crowd',
      'Busy Tavern',
    ]);
    expect(matchTemplates(templates, { query: 'animals' }).map(t => t.name)).toEqual(['Wolves']);
    expect(matchTemplates(templates, { query: 'ambient loops' })).toHaveLength(2);
  });

  it('ranks a prefix match above a mid-string one', () => {
    expect(matchTemplates(templates, { query: 'tavern' })[0].name).toBe('Tavern Crowd');
  });

  it('filters by section exactly and by category loosely', () => {
    expect(matchTemplates(templates, { section: 'Ambient Loops' })).toHaveLength(2);
    expect(matchTemplates(templates, { category: 'forest' }).map(t => t.name)).toEqual([
      'Forest Day',
    ]);
  });

  it('intersects filters rather than unioning them', () => {
    expect(matchTemplates(templates, { query: 'tavern', section: 'Ambient Loops' })).toHaveLength(
      1
    );
  });
});

describe('summarizeLibrary', () => {
  it('counts categories under each section', () => {
    const summary = summarizeLibrary([
      { name: 'a', section: 'Ambient Loops', category: 'Forest' },
      { name: 'b', section: 'Ambient Loops', category: 'Forest' },
      { name: 'c', section: 'Interval Sounds', category: 'Animals' },
    ]);
    expect(summary).toEqual([
      { section: 'Ambient Loops', total: 2, categories: [{ category: 'Forest', count: 2 }] },
      { section: 'Interval Sounds', total: 1, categories: [{ category: 'Animals', count: 1 }] },
    ]);
  });

  it('files an untagged template under the module defaults', () => {
    const summary = summarizeLibrary([{ name: 'a' }]);
    expect(summary[0].section).toBe('Interval Sounds');
    expect(summary[0].categories[0].category).toBe('Uncategorized');
  });
});
