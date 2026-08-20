/**
 * Unit tests for SoundscapeTools (configure-soundscape).
 *
 * The handler owns two things around the bridge call: zod parsing of a wide action-based schema,
 * and the per-action response shaping. The page layer owns the flag writes and is proved live by
 * scripts/verify-soundscape-tooling.mjs, so these tests feed it page-shaped payloads and assert
 * what a caller actually reads back — in particular that an inert set (no module, no files, a
 * closed day/night gate) never formats as a working soundscape.
 */

import { describe, it, expect } from 'vitest';
import { SoundscapeTools } from './soundscape.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new SoundscapeTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

const scene = { id: 'sc1', name: 'The Hollow', active: true, darkness: 0.9 };
const liveModule = { installed: true, enabled: true, version: '1.0.0' };

const listSet = (over: any = {}) => ({
  id: 'set1',
  name: 'Wolf Howls',
  active: true,
  playStyle: 'interval',
  fileCount: 3,
  files: ['a.ogg', 'b.ogg', 'c.ogg'],
  timing: 'every 25 ± 5s',
  volume: 0.8,
  whenToPlay: 'always',
  wouldPlayNow: true,
  ...over,
});

describe('SoundscapeTools.getToolDefinitions', () => {
  it('exposes exactly one action-based tool', () => {
    const { tools } = build();
    const defs = tools.getToolDefinitions();
    expect(defs.map(d => d.name)).toEqual(['configure-soundscape']);
    expect(defs[0].inputSchema).toMatchObject({ type: 'object' });
  });

  it('advertises action as the only required field', () => {
    const { tools } = build();
    const schema = tools.getToolDefinitions()[0].inputSchema as any;
    expect(schema.required).toEqual(['action']);
    expect(Object.keys(schema.properties)).toContain('sceneIdentifier');
    expect(schema.properties.action.enum).toEqual(['list', 'library', 'add', 'update', 'remove']);
  });
});

describe('configure-soundscape input parsing', () => {
  it('forwards the parsed args to the page function under its own name', async () => {
    const { tools, calls } = build({ action: 'list', scene, module: liveModule, sets: [] });
    await tools.handleConfigureSoundscape({ action: 'list', sceneIdentifier: 'The Hollow' });
    expect(calls[0][0]).toBe('configureSoundscape');
    expect(calls[0][1]).toMatchObject({ action: 'list', sceneIdentifier: 'The Hollow' });
  });

  it('applies the documented defaults', async () => {
    const { tools, calls } = build({ action: 'library', libraryFound: false, warnings: [] });
    await tools.handleConfigureSoundscape({ action: 'library' });
    expect(calls[0][1]).toMatchObject({ limit: 40, verifyFiles: false });
  });

  it('rejects an unknown action rather than passing it through', async () => {
    const { tools } = build();
    await expect(tools.handleConfigureSoundscape({ action: 'destroy' })).rejects.toThrow();
  });

  it('rejects an out-of-range limit', async () => {
    const { tools } = build();
    await expect(
      tools.handleConfigureSoundscape({ action: 'library', limit: 5000 })
    ).rejects.toThrow();
  });

  it('rejects a section outside the two library sections', async () => {
    const { tools } = build();
    await expect(
      tools.handleConfigureSoundscape({ action: 'library', section: 'Music' })
    ).rejects.toThrow();
  });
});

describe('action list', () => {
  it('reports what would be playing and names the scene', async () => {
    const { tools } = build({
      action: 'list',
      scene,
      module: liveModule,
      sets: [listSet(), listSet({ id: 'set2', name: 'Wind', wouldPlayNow: false })],
      warnings: [],
    });
    const out = await tools.handleConfigureSoundscape({ action: 'list' });
    expect(out).toContain('2 sound set(s) on The Hollow (sc1) — the ACTIVE scene, darkness 0.9');
    expect(out).toContain('1 would be playing now');
    expect(out).toContain('▶ "Wolf Howls" (set1)');
    expect(out).toContain('⏸ "Wind" (set2)');
  });

  // A silent set is the whole reason to run this action — say WHY, never just "not playing".
  it('surfaces the idle reason for a gated set', async () => {
    const { tools } = build({
      action: 'list',
      scene,
      module: liveModule,
      sets: [
        listSet({
          wouldPlayNow: false,
          whenToPlay: 'day',
          idle: 'gated to day (scene darkness 0.9)',
        }),
      ],
      warnings: [],
    });
    const out = await tools.handleConfigureSoundscape({ action: 'list' });
    expect(out).toContain('day only');
    expect(out).toContain('idle: gated to day (scene darkness 0.9)');
  });

  it('lists missing pool files when they were verified', async () => {
    const { tools } = build({
      action: 'list',
      scene,
      module: liveModule,
      filesVerified: true,
      sets: [listSet({ missingFiles: ['gone.ogg'] })],
      warnings: [],
    });
    const out = await tools.handleConfigureSoundscape({ action: 'list', verifyFiles: true });
    expect(out).toContain('1 missing file(s): gone.ogg');
    expect(out).not.toContain('pass verifyFiles');
  });

  it('offers the verify flag when the pools were not checked', async () => {
    const { tools } = build({
      action: 'list',
      scene,
      module: liveModule,
      filesVerified: false,
      sets: [listSet()],
      warnings: [],
    });
    expect(await tools.handleConfigureSoundscape({ action: 'list' })).toContain(
      'pass verifyFiles to HEAD-check the pools'
    );
  });

  it('says the sets are ducked while combat is running', async () => {
    const { tools } = build({
      action: 'list',
      scene,
      module: liveModule,
      combatDucking: true,
      sets: [listSet()],
      warnings: [],
    });
    expect(await tools.handleConfigureSoundscape({ action: 'list' })).toContain('DUCKED');
  });

  it('points an empty scene at the library instead of reporting a bare zero', async () => {
    const { tools } = build({ action: 'list', scene, module: liveModule, sets: [], warnings: [] });
    const out = await tools.handleConfigureSoundscape({ action: 'list' });
    expect(out).toContain('No sound sets on The Hollow');
    expect(out).toContain('action "library"');
  });

  // Sets are inert data without the module that plays them.
  it('reports a missing module in the header, not just in the warnings', async () => {
    const { tools } = build({
      action: 'list',
      scene,
      module: { installed: false, enabled: false, version: null },
      sets: [listSet()],
      warnings: ['the "fvtt-mod-soundscape" module is NOT INSTALLED in this world'],
    });
    const out = await tools.handleConfigureSoundscape({ action: 'list' });
    expect(out).toContain('module NOT INSTALLED');
    expect(out).toContain('⚠️');
  });

  it('distinguishes a disabled module from an absent one', async () => {
    const { tools } = build({
      action: 'list',
      scene,
      module: { installed: true, enabled: false, version: '1.0.0' },
      sets: [listSet()],
      warnings: [],
    });
    expect(await tools.handleConfigureSoundscape({ action: 'list' })).toContain('module DISABLED');
  });
});

describe('action library', () => {
  const libraryResult = {
    action: 'library',
    libraryPath: 'soundscape-sfx/library.json',
    libraryFound: true,
    total: 398,
    matched: 2,
    truncated: 0,
    sections: [
      {
        section: 'Ambient Loops',
        total: 112,
        categories: [{ category: 'Interiors', count: 12 }],
      },
    ],
    matches: [
      {
        name: 'Busy Tavern',
        section: 'Ambient Loops',
        category: 'Interiors',
        playStyle: 'loop',
        fileCount: 1,
        timing: 'loop · 4s crossfade',
        volume: 0.8,
      },
    ],
  };

  it('prints the taxonomy, the matches, and how to use one', async () => {
    const { tools } = build(libraryResult);
    const out = await tools.handleConfigureSoundscape({ action: 'library', query: 'tavern' });
    expect(out).toContain('398 template(s)');
    expect(out).toContain('2 matching');
    expect(out).toContain('Ambient Loops (112): Interiors 12');
    expect(out).toContain(
      '"Busy Tavern" — Ambient Loops / Interiors · 1 file(s) · loop · 4s crossfade'
    );
    expect(out).toContain('action "add" + template');
  });

  it('names the truncation instead of quietly cutting the list', async () => {
    const { tools } = build({ ...libraryResult, matched: 90, truncated: 50 });
    expect(await tools.handleConfigureSoundscape({ action: 'library' })).toContain('…and 50 more');
  });

  it('does not claim a filter when everything matched', async () => {
    const { tools } = build({ ...libraryResult, matched: 398 });
    expect(await tools.handleConfigureSoundscape({ action: 'library' })).not.toContain('matching');
  });

  it('reports an absent library as absent, with the warning', async () => {
    const { tools } = build({
      action: 'library',
      libraryFound: false,
      warnings: ['no template library at "soundscape-sfx/library.json"'],
    });
    const out = await tools.handleConfigureSoundscape({ action: 'library' });
    expect(out).toContain('No Soundscape template library');
    expect(out).toContain('no template library at');
  });
});

describe('action add', () => {
  const added = {
    action: 'add',
    scene,
    module: liveModule,
    set: {
      id: 'new1',
      name: 'Busy Tavern',
      active: true,
      files: ['soundscape-sfx/ambient-loops/interiors/tavern.ogg'],
      playStyle: 'loop',
      volume: 0.8,
      whenToPlay: 'always',
      timing: 'loop · 4s crossfade',
      wouldPlayNow: true,
    },
    changed: [],
    clamped: [],
    total: 3,
    warnings: [],
  };

  it('names the template it copied and the resulting set', async () => {
    const { tools } = build({ ...added, fromTemplate: 'Busy Tavern' });
    const out = await tools.handleConfigureSoundscape({ action: 'add', template: 'Busy Tavern' });
    expect(out).toContain(
      'Added sound set "Busy Tavern" (new1) from library template "Busy Tavern"'
    );
    expect(out).toContain('loop · 1 file(s) · loop · 4s crossfade · vol 0.8');
    expect(out).toContain('3 set(s) on the scene');
  });

  it('reports a clamp instead of applying it silently', async () => {
    const { tools } = build({ ...added, clamped: ['interval 9000 → 3600'] });
    expect(await tools.handleConfigureSoundscape({ action: 'add', template: 'x' })).toContain(
      "clamped to the module's limits: interval 9000 → 3600"
    );
  });

  it('says a gated set is not playing right now', async () => {
    const { tools } = build({
      ...added,
      set: { ...added.set, whenToPlay: 'night', wouldPlayNow: false },
    });
    const out = await tools.handleConfigureSoundscape({ action: 'add', template: 'x' });
    expect(out).toContain('night only');
    expect(out).toContain('Not playing right now');
  });

  it('marks an inactive set as inactive', async () => {
    const { tools } = build({
      ...added,
      set: { ...added.set, active: false, wouldPlayNow: false },
    });
    expect(await tools.handleConfigureSoundscape({ action: 'add', template: 'x' })).toContain(
      'INACTIVE'
    );
  });

  it('passes a 404 file warning through rather than reporting a clean add', async () => {
    const { tools } = build({
      ...added,
      warnings: ['Supplied file "missing.ogg" was not found on the server'],
    });
    const out = await tools.handleConfigureSoundscape({ action: 'add', template: 'x' });
    expect(out).toContain('was not found on the server');
  });
});

describe('action update', () => {
  const updated = {
    action: 'update',
    scene,
    module: liveModule,
    set: {
      id: 'set1',
      name: 'Wolf Howls',
      active: true,
      files: ['a.ogg'],
      playStyle: 'interval',
      volume: 0.4,
      whenToPlay: 'night',
      timing: 'every 40 ± 10s',
      wouldPlayNow: true,
    },
    changed: ['volume', 'whenToPlay'],
    clamped: [],
    total: 2,
    warnings: [],
  };

  it('lists the fields that actually changed', async () => {
    const { tools } = build(updated);
    const out = await tools.handleConfigureSoundscape({
      action: 'update',
      setIdentifier: 'set1',
      volume: 0.4,
    });
    expect(out).toContain('Updated sound set "Wolf Howls" (set1)');
    expect(out).toContain('changed: volume, whenToPlay');
  });

  // A patch that matches the stored values is a real no-op and should read as one.
  it('says nothing changed rather than implying a write', async () => {
    const { tools } = build({ ...updated, changed: [] });
    expect(
      await tools.handleConfigureSoundscape({
        action: 'update',
        setIdentifier: 'set1',
        volume: 0.4,
      })
    ).toContain('nothing actually changed');
  });
});

describe('action remove', () => {
  it('names what went and what is left', async () => {
    const { tools } = build({
      action: 'remove',
      scene,
      removed: [{ id: 'set1', name: 'Wolf Howls' }],
      remaining: 1,
    });
    const out = await tools.handleConfigureSoundscape({
      action: 'remove',
      setIdentifier: 'Wolf Howls',
    });
    expect(out).toContain('Removed 1 sound set(s)');
    expect(out).toContain('"Wolf Howls"');
    expect(out).toContain('1 set(s) remain');
  });

  it('reports a clear-all as every set removed', async () => {
    const { tools } = build({
      action: 'remove',
      scene,
      removed: [
        { id: 'set1', name: 'Wolf Howls' },
        { id: 'set2', name: 'Wind' },
      ],
      remaining: 0,
    });
    const out = await tools.handleConfigureSoundscape({ action: 'remove', setIdentifier: 'all' });
    expect(out).toContain('Removed 2 sound set(s)');
    expect(out).toContain('0 set(s) remain');
  });

  it('reports an empty scene as nothing to remove', async () => {
    const { tools } = build({ action: 'remove', scene, removed: [], remaining: 0 });
    expect(
      await tools.handleConfigureSoundscape({ action: 'remove', setIdentifier: 'all' })
    ).toContain('Nothing to remove');
  });
});
