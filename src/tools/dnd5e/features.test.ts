/**
 * Unit tests for DnD5eFeaturesFromCompendiumTools
 * (add-features-from-compendium → addFeaturesFromCompendium).
 *
 * Covers:
 *   1. getToolDefinitions — tool name + object inputSchema.
 *   2. zod input validation — required actorIdentifier/featureNames, the
 *      .min(1)/.max(50) array bounds, non-empty string items.
 *   3. bridge forwarding — method name + parsed payload (incl. the default
 *      compendiumPacks) reach foundry.
 *   4. response formatting — the added/skipped/notFound/failed/warnings
 *      sections and the status-icon branches of the summary line.
 *
 * handleAddFeaturesFromCompendium calls detectGameSystem() (calls
 * `getWorldInfo`, caches module-globally), so the fake bridge answers that
 * probe with `{ system: 'dnd5e' }` and the cache is cleared before each test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5eFeaturesFromCompendiumTools } from './features.js';
import { makeLogger, makeFoundry } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

function build(bridgeResult: any = {}) {
  const { foundry, calls } = makeFoundry((method: string) =>
    method === 'getWorldInfo' ? { system: 'dnd5e' } : bridgeResult
  );
  const tools = new DnD5eFeaturesFromCompendiumTools({
    foundry,
    logger: makeLogger(),
  });
  return { tools, calls, foundry };
}

/** Build a complete bridge result; the formatter reads every array. */
function result(overrides: Record<string, any> = {}) {
  return {
    actor: { id: 'npc1', name: 'Goblin Boss' },
    added: [],
    skipped: [],
    notFound: [],
    failed: [],
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  clearSystemCache();
});

describe('DnD5eFeaturesFromCompendiumTools.getToolDefinitions', () => {
  it('exposes the single add-features-from-compendium tool', () => {
    const { tools } = build();
    const defs = tools.getToolDefinitions();
    expect(defs.map(d => d.name)).toEqual(['add-features-from-compendium']);
  });

  it('definition has an object inputSchema with required fields', () => {
    const { tools } = build();
    const def = tools.getToolDefinitions()[0];
    expect(def.inputSchema.type).toBe('object');
    expect(def.inputSchema.required).toEqual(['actorIdentifier', 'featureNames']);
  });
});

describe('handleAddFeaturesFromCompendium — bridge forwarding & formatting', () => {
  it('forwards the parsed payload (with default packs) and formats an all-added report', async () => {
    const { tools, calls } = build(
      result({
        added: [
          {
            name: 'Pack Tactics',
            packId: 'dnd5e.monsterfeatures',
            packLabel: 'Monster Features',
            itemId: 'i1',
          },
        ],
      })
    );
    const out = await tools.handleAddFeaturesFromCompendium({
      actorIdentifier: 'Goblin Boss',
      featureNames: ['Pack Tactics'],
    });

    const bridgeCall = calls.find(c => c[0] === 'addFeaturesFromCompendium');
    expect(bridgeCall).toBeDefined();
    expect(bridgeCall![1]).toMatchObject({
      actorIdentifier: 'Goblin Boss',
      featureNames: ['Pack Tactics'],
      compendiumPacks: ['dnd5e.monsterfeatures', 'dnd5e.classfeatures'],
    });

    expect(out.success).toBe(true);
    expect(out.summary).toBe('✅ Features imported to "Goblin Boss" — 1 added');
    expect(out.message).toContain('**Actor:** Goblin Boss (id: `npc1`)');
    expect(out.message).toContain('**Requested:** 1 — Added: 1, Skipped: 0, Not found: 0');
    expect(out.message).toContain('  - Pack Tactics *(Monster Features, item `i1`)*');
  });

  it('passes explicit compendiumPacks through unchanged', async () => {
    const { tools, calls } = build(result());
    await tools.handleAddFeaturesFromCompendium({
      actorIdentifier: 'X',
      featureNames: ['Multiattack'],
      compendiumPacks: ['dnd5e.monsterfeatures24'],
    });
    const bridgeCall = calls.find(c => c[0] === 'addFeaturesFromCompendium');
    expect(bridgeCall![1].compendiumPacks).toEqual(['dnd5e.monsterfeatures24']);
  });

  it('uses the 🔍 icon and lists not-found features when none failed', async () => {
    const { tools } = build(result({ notFound: ['Bogus Feature'] }));
    const out = await tools.handleAddFeaturesFromCompendium({
      actorIdentifier: 'X',
      featureNames: ['Bogus Feature'],
    });
    expect(out.summary).toBe('🔍 Features imported to "Goblin Boss" — 1 not found');
    expect(out.message).toContain('❌ **Not found in compendium:**');
    expect(out.message).toContain('  - Bogus Feature');
  });

  it('uses the ⚠️ icon and lists failures + warnings', async () => {
    const { tools } = build(
      result({
        failed: [{ name: 'Broken', error: 'embed error' }],
        warnings: ['heads up'],
      })
    );
    const out = await tools.handleAddFeaturesFromCompendium({
      actorIdentifier: 'X',
      featureNames: ['Broken'],
    });
    expect(out.summary).toBe('⚠️ Features imported to "Goblin Boss" — 1 failed');
    expect(out.success).toBe(false);
    expect(out.message).toContain('⚠️ **Failed during import:**');
    expect(out.message).toContain('  - Broken — *embed error*');
    expect(out.message).toContain('  - heads up');
  });

  it('reports "nothing changed" when every section is empty', async () => {
    const { tools } = build(result());
    const out = await tools.handleAddFeaturesFromCompendium({
      actorIdentifier: 'X',
      featureNames: ['Already There'],
    });
    expect(out.summary).toBe('✅ Features imported to "Goblin Boss" — nothing changed');
  });
});

describe('handleAddFeaturesFromCompendium — zod validation rejects bad input', () => {
  it('rejects a missing actorIdentifier', async () => {
    const { tools } = build();
    await expect(tools.handleAddFeaturesFromCompendium({ featureNames: ['X'] })).rejects.toThrow();
  });

  it('rejects an empty actorIdentifier', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeaturesFromCompendium({ actorIdentifier: '', featureNames: ['X'] })
    ).rejects.toThrow();
  });

  it('rejects a missing featureNames', async () => {
    const { tools } = build();
    await expect(tools.handleAddFeaturesFromCompendium({ actorIdentifier: 'X' })).rejects.toThrow();
  });

  it('rejects an empty featureNames array', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeaturesFromCompendium({ actorIdentifier: 'X', featureNames: [] })
    ).rejects.toThrow();
  });

  it('rejects an empty-string feature name', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeaturesFromCompendium({ actorIdentifier: 'X', featureNames: [''] })
    ).rejects.toThrow();
  });

  it('rejects more than 50 feature names', async () => {
    const { tools } = build();
    const tooMany = Array.from({ length: 51 }, (_, i) => `Feature ${i}`);
    await expect(
      tools.handleAddFeaturesFromCompendium({ actorIdentifier: 'X', featureNames: tooMany })
    ).rejects.toThrow();
  });

  it('rejects an empty-string compendium pack id', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeaturesFromCompendium({
        actorIdentifier: 'X',
        featureNames: ['Y'],
        compendiumPacks: [''],
      })
    ).rejects.toThrow();
  });

  it('rejects undefined args', async () => {
    const { tools } = build();
    await expect(tools.handleAddFeaturesFromCompendium(undefined)).rejects.toThrow();
  });
});
