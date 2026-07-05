/**
 * Unit tests for the pure, browser-independent page helpers in _shared.ts.
 *
 * These run inside the headless Foundry page in production, but the functions
 * exercised here touch no `game.*`/DOM globals, so they unit-test cleanly in Node —
 * closing part of the page-layer coverage gap without a browser. The headline case
 * is the activities-Map regression: sanitizing a LIVE dnd5e `system` empties its
 * `activities` Map to `{}`, while sanitizing `toSource(doc).system` preserves it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  normalizeAssetPath,
  basename,
  isVideoPath,
  slugify,
  toSource,
  unmaskedName,
  sanitizeDocData,
  importFromCompendium,
  findUnresolvedScaleTokens,
} from './_shared.js';

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
  it('preserves a literal # / ? inside a path segment, re-encoded (Tom Cartos "#48 - Room/" folders)', () => {
    // Regression caught live at the e2e: the legacy Into-the-Wilds pack stores maps under "#48 - …/"
    // folders. The old split('#') truncated the path to ".../maps/", losing the file; the `#` must
    // survive as %23 so Foundry's texture URL doesn't read it as a fragment.
    expect(normalizeAssetPath('worlds/w/assets/maps/#48 - Prison & Guard/TC_map.webp')).toBe(
      'worlds/w/assets/maps/%2348 - Prison & Guard/TC_map.webp'
    );
    expect(normalizeAssetPath('maps/q?2/a.webp')).toBe('maps/q%3F2/a.webp');
  });
  it('still strips a genuine trailing query/fragment on the file', () => {
    expect(normalizeAssetPath('maps/a.webp#thumb')).toBe('maps/a.webp');
    expect(normalizeAssetPath('maps/a.webp?v=3')).toBe('maps/a.webp');
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

describe('isVideoPath', () => {
  it('detects video extensions (case-insensitive), including a query/hash suffix', () => {
    for (const p of [
      'modules/JB2A/x/DancingLights_01_Yellow_200x200.webm',
      'a/b/effect.MP4',
      'clip.m4v',
      'loop.ogg',
      'anim.ogv',
      'movie.mov',
      'x/y.webm?v=2',
      'x/y.mp4#frag',
    ]) {
      expect(isVideoPath(p)).toBe(true);
    }
  });
  it('rejects still-image and other paths', () => {
    for (const p of [
      'art/goblin.webp',
      'tokens/x.png',
      'portrait.jpg',
      'icon.svg',
      'DancingLights_01_Yellow_Thumb.webp', // the still poster beside the webm
      'notavideo.webmx',
      '',
    ]) {
      expect(isVideoPath(p)).toBe(false);
    }
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

describe('unmaskedName', () => {
  // dnd5e identity mask: while system.identified === false, item.name (the prepared getter)
  // returns system.unidentified.name — even to the GM. The true name lives only in _source.
  const maskedItem = (opts?: { srcName?: any; source?: boolean; toObject?: boolean }) => {
    const srcName = opts?.srcName ?? 'Dawnthorn';
    return {
      name: 'Gilded Scimitar', // the mask (what dnd5e's getter returns)
      system: { identified: false, unidentified: { name: 'Gilded Scimitar' } },
      ...(opts?.source === false ? {} : { _source: { name: srcName } }),
      ...(opts?.toObject ? { toObject: () => ({ name: srcName }) } : {}),
    };
  };

  it('returns the source name while the identity mask is active', () => {
    expect(unmaskedName(maskedItem())).toBe('Dawnthorn');
  });

  it('REGRESSION: surfaces a rename applied to an unidentified item (mask reads back unchanged)', () => {
    // The live bug: update-item renamed _source.name to "Dawnthorn", but every read echoed the
    // mask "Gilded Scimitar" — making the rename look like a silent no-op.
    const item = maskedItem();
    expect(item.name).toBe('Gilded Scimitar'); // what reads showed
    expect(unmaskedName(item)).toBe('Dawnthorn'); // what actually applied
  });

  it('falls back to toObject().name when _source is absent', () => {
    expect(unmaskedName(maskedItem({ source: false, toObject: true }))).toBe('Dawnthorn');
  });

  it('is undefined for identified items (no mask → common shape untouched)', () => {
    expect(
      unmaskedName({
        name: 'Longsword',
        system: { identified: true },
        _source: { name: 'Longsword' },
      })
    ).toBeUndefined();
  });

  it('is undefined for items without the identifiable template (identified missing)', () => {
    expect(
      unmaskedName({ name: 'Fireball', type: 'spell', system: {}, _source: { name: 'Fireball' } })
    ).toBeUndefined();
    expect(unmaskedName(null)).toBeUndefined();
    expect(unmaskedName(undefined)).toBeUndefined();
  });

  it('is undefined when no usable source name exists', () => {
    expect(unmaskedName(maskedItem({ source: false }))).toBeUndefined();
    expect(unmaskedName(maskedItem({ srcName: '' }))).toBeUndefined();
    expect(unmaskedName(maskedItem({ srcName: 42 }))).toBeUndefined();
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

  it('preserves ActiveEffect changes[].key (collides with the sensitive `key` name)', () => {
    // The blanket sensitive-field filter dropped `key` everywhere, leaving every effect read-back
    // with keyless (useless) changes. The fix keeps `key` inside changes[] entries only.
    const out = sanitizeDocData({
      name: 'Bless',
      changes: [
        { key: 'system.attributes.ac.bonus', value: '2', type: 'add', phase: 'initial' },
        { key: 'system.abilities.str.value', value: '4', mode: 2 },
      ],
    });
    expect(out.changes).toEqual([
      { key: 'system.attributes.ac.bonus', value: '2', type: 'add', phase: 'initial' },
      { key: 'system.abilities.str.value', value: '4', mode: 2 },
    ]);
    // ...but a top-level `key` outside changes[] is still stripped as sensitive.
    expect(sanitizeDocData({ key: 'secret', name: 'ok' })).toEqual({ name: 'ok' });
  });
});

describe('importFromCompendium', () => {
  afterEach(() => vi.unstubAllGlobals());

  // A mock compendium document whose toObject() returns a FRESH literal each call
  // (mirrors Foundry's Document.toObject — independent plain source data).
  const mockDoc = () => ({
    _id: 'src123',
    name: 'Longsword',
    type: 'weapon',
    documentName: 'Item',
    toObject: () => ({ _id: 'src123', name: 'Longsword', type: 'weapon', system: { foo: 1 } }),
  });
  const mockPack = (type: string, doc: unknown) => ({
    metadata: { type, label: 'Mock Pack' },
    getDocument: vi.fn(async () => doc),
  });
  const stubGame = (pack: unknown) =>
    vi.stubGlobal('game', {
      packs: { get: vi.fn((id: string) => (id === 'pack.id' ? pack : undefined)) },
    });

  it('resolves pack+doc and returns a copy-ready `data` with _id stripped (source keeps it)', async () => {
    const doc = mockDoc();
    stubGame(mockPack('Item', doc));

    const { pack, source, data } = await importFromCompendium('pack.id', 'src123');

    expect(pack.metadata.label).toBe('Mock Pack');
    expect(source).toBe(doc);
    expect(source._id).toBe('src123'); // the live source document is untouched
    expect(data._id).toBeUndefined(); // the copy drops _id so Foundry assigns a fresh one
    expect(data).toMatchObject({ name: 'Longsword', type: 'weapon', system: { foo: 1 } });
  });

  it('returns fresh `data` — mutating it does not leak back into the source', async () => {
    const doc = mockDoc();
    stubGame(mockPack('Item', doc));

    const { data } = await importFromCompendium('pack.id', 'src123');
    data.system.foo = 999;

    expect(doc.toObject().system.foo).toBe(1); // a fresh toObject is unaffected
  });

  it('enforces requirePackType BEFORE fetching the document', async () => {
    const pack = mockPack('Actor', mockDoc()); // wrong pack type
    stubGame(pack);

    await expect(
      importFromCompendium('pack.id', 'src123', { requirePackType: 'Item' })
    ).rejects.toThrow(/expected "Item"/);
    expect(pack.getDocument).not.toHaveBeenCalled(); // rejected before the fetch
  });

  it('throws on missing inputs, a missing pack, and a missing document', async () => {
    stubGame(mockPack('Item', mockDoc()));
    await expect(importFromCompendium('', 'x')).rejects.toThrow(
      'Both packId and itemId are required'
    );
    await expect(importFromCompendium('nope.id', 'x')).rejects.toThrow(/Compendium pack not found/);

    vi.stubGlobal('game', {
      packs: {
        get: vi.fn(() => ({
          metadata: { type: 'Item', label: 'P' },
          getDocument: vi.fn(async () => null),
        })),
      },
    });
    await expect(importFromCompendium('pack.id', 'missing')).rejects.toThrow(/not found in pack/);
  });
});

describe('findUnresolvedScaleTokens', () => {
  it('finds an @scale token in a nested activity damage formula and reports its dot-path', () => {
    // The real shape of the live 2024 PHB Breath Weapon feat (toObject form: activities is a plain
    // object) — the token lives in damage.parts[].custom.formula, NOT in `bonus` (verified live on
    // sandbox), which is exactly why the scan walks every string field rather than known fields.
    const feat = {
      name: 'Breath Weapon',
      system: {
        activities: {
          abc123: {
            type: 'save',
            damage: {
              parts: [
                { types: ['fire'], custom: { enabled: true, formula: '@scale.breath-weapon.die' } },
              ],
            },
          },
        },
      },
    };
    expect(findUnresolvedScaleTokens(feat)).toEqual([
      {
        path: 'system.activities.abc123.damage.parts.0.custom.formula',
        formula: '@scale.breath-weapon.die',
      },
    ]);
  });

  it('catches @scale in uses.max and in mid-string formulas alike', () => {
    const tokens = findUnresolvedScaleTokens({
      system: {
        uses: { max: '@scale.monk.martial-arts' },
        activities: { x: { healing: { bonus: '2 + @scale.cleric.channel-divinity' } } },
      },
    });
    expect(tokens).toEqual([
      { path: 'system.uses.max', formula: '@scale.monk.martial-arts' },
      { path: 'system.activities.x.healing.bonus', formula: '2 + @scale.cleric.channel-divinity' },
    ]);
  });

  it('returns [] for a clean creature whose formulas are explicit dice (e.g. an MM prefab)', () => {
    expect(
      findUnresolvedScaleTokens({
        system: {
          activities: { a: { damage: { parts: [{ formula: '2d6 + 3', bonus: '@prof' }] } } },
        },
      })
    ).toEqual([]); // @prof resolves fine on an NPC; only @scale dangles
  });

  it('does not loop on a circular reference', () => {
    const node: any = { system: { uses: { max: '@scale.barbarian.rage-damage' } } };
    node.self = node;
    expect(findUnresolvedScaleTokens(node)).toEqual([
      { path: 'system.uses.max', formula: '@scale.barbarian.rage-damage' },
    ]);
  });
});
