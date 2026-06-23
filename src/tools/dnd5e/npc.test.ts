/**
 * Unit tests for DnD5eNpcTools (create-actor source="authored" → createNpcActor).
 *
 * Covers what handleCreateNpc owns before/around the bridge call:
 *   1. zod input validation — required identity fields, enum membership,
 *      ability bounds, the acMode="flat" ⇒ acValue superRefine.
 *   2. response formatting — the human-readable message built from the bridge
 *      result (CR string, ability line, AC display, folder + warning sections).
 *   3. bridge forwarding — correct method name + payload reach the foundry seam.
 *
 * Because handleCreateNpc calls detectGameSystem() (which calls
 * `getWorldInfo` and caches the result module-globally), the fake bridge
 * answers that call with `{ system: 'dnd5e' }` and the cache is cleared
 * before each test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5eNpcTools } from './npc.js';
import { makeLogger, makeFoundry } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

/**
 * Build a tools instance whose bridge returns `{ system: 'dnd5e' }` for the
 * world-info probe and `bridgeResult` for every other (bridge) call.
 */
function build(bridgeResult: any = {}) {
  const { foundry, calls } = makeFoundry((method: string) =>
    method === 'getWorldInfo' ? { system: 'dnd5e' } : bridgeResult
  );
  const tools = new DnD5eNpcTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

/** A minimal, fully-valid create-NPC argument object. */
function validArgs(overrides: Record<string, any> = {}) {
  return {
    name: 'Goblin Boss',
    creatureType: 'humanoid',
    size: 'small',
    cr: '1',
    hpAverage: 21,
    hpFormula: '6d6',
    acMode: 'default',
    abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 8, cha: 10 },
    ...overrides,
  };
}

/** The bridge result shape formatResponse reads. */
function bridgeResult(overrides: Record<string, any> = {}) {
  return { actor: { id: 'actor123', name: 'Goblin Boss', ...overrides } };
}

beforeEach(() => {
  clearSystemCache();
});

describe('DnD5eNpcTools.getToolDefinitions', () => {
  it('exposes no tool definitions (registered under create-actor)', () => {
    const { tools } = build();
    expect(tools.getToolDefinitions()).toEqual([]);
  });
});

describe('handleCreateNpc — bridge forwarding & formatting', () => {
  it('forwards createNpcActor with the parsed payload and formats the message', async () => {
    const { tools, calls } = build(bridgeResult());
    const out = await tools.handleCreateNpc(validArgs());

    // The world-info probe runs first, then the bridge call.
    const bridgeCall = calls.find(c => c[0] === 'createNpcActor');
    expect(bridgeCall).toBeDefined();
    expect(bridgeCall![1]).toMatchObject({
      name: 'Goblin Boss',
      creatureType: 'humanoid',
      size: 'small',
      cr: '1',
      hpAverage: 21,
      hpFormula: '6d6',
      acMode: 'default',
    });

    expect(out.success).toBe(true);
    expect(out.summary).toBe('✅ NPC "Goblin Boss" created (CR 1)');
    expect(out.message).toContain('**Actor:** Goblin Boss (id: `actor123`)');
    expect(out.message).toContain('**Type:** humanoid, small');
    expect(out.message).toContain(
      '**CR:** 1  |  **HP:** 21 (6d6)  |  **AC:** default (calculated)'
    );
    expect(out.message).toContain(
      '**Abilities:** STR 10 / DEX 14 / CON 10 / INT 10 / WIS 8 / CHA 10'
    );
  });

  it('prefers the bridge-supplied CR string over the normalized fallback', async () => {
    const { tools } = build(bridgeResult({ cr: '1/4' }));
    const out = await tools.handleCreateNpc(validArgs({ cr: '1/4' }));
    expect(out.summary).toBe('✅ NPC "Goblin Boss" created (CR 1/4)');
  });

  it('falls back to formatCR(normalizeCR(cr)) when the bridge omits cr', async () => {
    const { tools } = build(bridgeResult()); // no cr on actor
    const out = await tools.handleCreateNpc(validArgs({ cr: '1/2' }));
    // normalizeCR('1/2') = 0.5 → formatCR → '1/2'
    expect(out.summary).toBe('✅ NPC "Goblin Boss" created (CR 1/2)');
  });

  it('renders a flat AC value and the creature subtype', async () => {
    const { tools } = build(bridgeResult());
    const out = await tools.handleCreateNpc(
      validArgs({ acMode: 'flat', acValue: 17, creatureSubtype: 'goblinoid' })
    );
    expect(out.message).toContain('**Type:** humanoid (goblinoid), small');
    expect(out.message).toContain('**AC:** 17');
  });

  it('includes a folder line when the bridge returns one', async () => {
    const { tools } = build(bridgeResult({ folder: 'Monsters' }));
    const out = await tools.handleCreateNpc(validArgs());
    expect(out.message).toContain('**Folder:** Monsters');
  });

  it('emits warnings for non-canonical damage/condition values', async () => {
    const { tools } = build(bridgeResult());
    const out = await tools.handleCreateNpc(
      validArgs({
        damageImmunities: ['wonky'],
        conditionImmunities: ['bewildered'],
      })
    );
    expect(out.warnings.length).toBe(2);
    expect(out.message).toContain('Unknown damage type "wonky" in damageImmunities');
    expect(out.message).toContain('Unknown condition "bewildered" in conditionImmunities');
  });
});

describe('handleCreateNpc — zod validation rejects bad input', () => {
  it('rejects an empty name', async () => {
    const { tools } = build();
    await expect(tools.handleCreateNpc(validArgs({ name: '' }))).rejects.toThrow();
  });

  it('rejects a missing creatureType', async () => {
    const { tools } = build();
    const args = validArgs();
    delete (args as any).creatureType;
    await expect(tools.handleCreateNpc(args)).rejects.toThrow();
  });

  it('rejects an unknown creatureType enum value', async () => {
    const { tools } = build();
    await expect(tools.handleCreateNpc(validArgs({ creatureType: 'kaiju' }))).rejects.toThrow();
  });

  it('rejects an unknown size enum value', async () => {
    const { tools } = build();
    await expect(tools.handleCreateNpc(validArgs({ size: 'colossal' }))).rejects.toThrow();
  });

  it('rejects a malformed CR string', async () => {
    const { tools } = build();
    await expect(tools.handleCreateNpc(validArgs({ cr: '1/3' }))).rejects.toThrow();
  });

  it('rejects an empty hpFormula', async () => {
    const { tools } = build();
    await expect(tools.handleCreateNpc(validArgs({ hpFormula: '' }))).rejects.toThrow();
  });

  it('rejects an out-of-range ability score', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateNpc(
        validArgs({ abilities: { str: 99, dex: 14, con: 10, int: 10, wis: 8, cha: 10 } })
      )
    ).rejects.toThrow();
  });

  it('rejects acMode "flat" without an acValue (superRefine)', async () => {
    const { tools } = build();
    await expect(tools.handleCreateNpc(validArgs({ acMode: 'flat' }))).rejects.toThrow();
  });

  it('rejects an invalid savingThrows entry', async () => {
    const { tools } = build();
    await expect(tools.handleCreateNpc(validArgs({ savingThrows: ['luck'] }))).rejects.toThrow();
  });

  it('rejects undefined args', async () => {
    const { tools } = build();
    await expect(tools.handleCreateNpc(undefined)).rejects.toThrow();
  });
});
