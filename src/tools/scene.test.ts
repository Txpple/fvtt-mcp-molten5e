/**
 * Unit tests for SceneTools (get-current-scene, get-world-info).
 *
 * These handlers own two things before/after the bridge:
 *   1. zod input parsing (booleans with defaults — no required fields).
 *   2. response shaping — the structured object built from the bridge result,
 *      including token formatting, disposition mapping, note truncation, and
 *      the user roll-ups for world info.
 */

import { describe, it, expect } from 'vitest';
import { SceneTools } from './scene.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new SceneTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('SceneTools.getToolDefinitions', () => {
  it('exposes exactly the two scene tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(['get-current-scene', 'get-world-info']);
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('handleGetCurrentScene', () => {
  const sceneData = {
    id: 'scene1',
    name: 'Tavern',
    active: true,
    width: 4000,
    height: 3000,
    padding: 0.25,
    background: 'tavern.webp',
    navigation: true,
    walls: 12,
    lights: 3,
    sounds: 1,
    notes: [{ id: 'n1', text: 'A short note', x: 10, y: 20 }],
    tokens: [
      {
        id: 't1',
        name: 'Bartender',
        x: 100,
        y: 200,
        width: 1,
        height: 1,
        actorId: 'a1',
        disposition: 1,
        hidden: false,
        img: 'bartender.webp',
      },
      {
        id: 't2',
        name: 'Sneak Thief',
        x: 300,
        y: 400,
        width: 1,
        height: 1,
        actorId: null,
        disposition: -1,
        hidden: true,
        img: null,
      },
    ],
  };

  it('forwards the getActiveScene bridge call', async () => {
    const { tools, calls } = build(sceneData);
    await tools.handleGetCurrentScene({});
    expect(calls[0][0]).toBe('getActiveScene');
  });

  it('shapes the scene response with dimensions, elements and background flag', async () => {
    const { tools } = build(sceneData);
    const out = await tools.handleGetCurrentScene({});
    expect(out.id).toBe('scene1');
    expect(out.name).toBe('Tavern');
    expect(out.active).toBe(true);
    expect(out.dimensions).toEqual({ width: 4000, height: 3000, padding: 0.25 });
    expect(out.hasBackground).toBe(true);
    expect(out.navigation).toBe(true);
    expect(out.elements).toEqual({ walls: 12, lights: 3, sounds: 1, notes: 1 });
  });

  it('includes tokens and a token summary by default, excluding hidden tokens', async () => {
    const { tools } = build(sceneData);
    const out = await tools.handleGetCurrentScene({});
    // includeTokens defaults true, includeHidden defaults false → only t1
    expect(out.tokens).toHaveLength(1);
    expect(out.tokens[0]).toMatchObject({
      id: 't1',
      name: 'Bartender',
      position: { x: 100, y: 200 },
      size: { width: 1, height: 1 },
      actorId: 'a1',
      disposition: 'friendly',
      hidden: false,
      hasImage: true,
    });
    expect(out.tokenSummary).toMatchObject({
      total: 1,
      byDisposition: { friendly: 1, neutral: 0, hostile: 0, unknown: 0 },
      hasActors: 1,
      withoutActors: 0,
    });
  });

  it('includes hidden tokens and maps their disposition when includeHidden is true', async () => {
    const { tools } = build(sceneData);
    const out = await tools.handleGetCurrentScene({ includeHidden: true });
    expect(out.tokens).toHaveLength(2);
    const thief = out.tokens.find((t: any) => t.id === 't2');
    expect(thief.disposition).toBe('hostile');
    expect(thief.hasImage).toBe(false);
    expect(out.tokenSummary).toMatchObject({
      total: 2,
      byDisposition: { friendly: 1, neutral: 0, hostile: 1, unknown: 0 },
      hasActors: 1,
      withoutActors: 1,
    });
  });

  it('omits tokens entirely when includeTokens is false', async () => {
    const { tools } = build(sceneData);
    const out = await tools.handleGetCurrentScene({ includeTokens: false });
    expect(out.tokens).toBeUndefined();
    expect(out.tokenSummary).toBeUndefined();
  });

  it('formats notes with position', async () => {
    const { tools } = build(sceneData);
    const out = await tools.handleGetCurrentScene({});
    expect(out.notes).toEqual([{ id: 'n1', text: 'A short note', position: { x: 10, y: 20 } }]);
  });

  it('truncates long note text to 100 chars with an ellipsis', async () => {
    const longText = 'x'.repeat(150);
    const { tools } = build({ ...sceneData, notes: [{ id: 'n1', text: longText, x: 0, y: 0 }] });
    const out = await tools.handleGetCurrentScene({});
    expect(out.notes[0].text).toHaveLength(100);
    expect(out.notes[0].text.endsWith('...')).toBe(true);
  });

  it('rejects a non-boolean includeTokens', async () => {
    const { tools } = build();
    await expect(tools.handleGetCurrentScene({ includeTokens: 'yes' })).rejects.toThrow();
  });

  it('wraps bridge errors with a descriptive message', async () => {
    const { foundry, calls } = makeFoundry(() => {
      throw new Error('no active scene');
    });
    const tools = new SceneTools({ foundry, logger: makeLogger() });
    await expect(tools.handleGetCurrentScene({})).rejects.toThrow(
      'Failed to get current scene: no active scene'
    );
    expect(calls[0][0]).toBe('getActiveScene');
  });
});

describe('handleGetWorldInfo', () => {
  const worldData = {
    id: 'world1',
    title: 'My Test World',
    system: 'dnd5e',
    systemVersion: '5.3.3',
    foundryVersion: '14.364',
    users: [
      { id: 'u1', name: 'GM', isGM: true, active: true },
      { id: 'u2', name: 'Alice', isGM: false, active: true },
      { id: 'u3', name: 'Bob', isGM: false, active: false },
    ],
  };

  it('forwards the getWorldInfo bridge call', async () => {
    const { tools, calls } = build(worldData);
    await tools.handleGetWorldInfo({});
    expect(calls[0][0]).toBe('getWorldInfo');
  });

  it('shapes the world response with system, foundry and user roll-ups', async () => {
    const { tools } = build(worldData);
    const out = await tools.handleGetWorldInfo({});
    expect(out.id).toBe('world1');
    expect(out.title).toBe('My Test World');
    expect(out.system).toEqual({ id: 'dnd5e', version: '5.3.3' });
    expect(out.foundry).toEqual({ version: '14.364' });
    expect(out.users).toEqual({ total: 3, active: 2, gms: 1, players: 2 });
  });

  it('lists only active users in activeUsers', async () => {
    const { tools } = build(worldData);
    const out = await tools.handleGetWorldInfo({});
    expect(out.activeUsers).toEqual([
      { id: 'u1', name: 'GM', isGM: true },
      { id: 'u2', name: 'Alice', isGM: false },
    ]);
  });

  it('defaults user counts to zero when no users are present', async () => {
    const { tools } = build({ id: 'w', title: 't', system: 'dnd5e' });
    const out = await tools.handleGetWorldInfo({});
    expect(out.users).toEqual({ total: 0, active: 0, gms: 0, players: 0 });
    expect(out.activeUsers).toEqual([]);
  });

  it('wraps bridge errors with a descriptive message', async () => {
    const { foundry } = makeFoundry(() => {
      throw new Error('bridge down');
    });
    const tools = new SceneTools({ foundry, logger: makeLogger() });
    await expect(tools.handleGetWorldInfo({})).rejects.toThrow(
      'Failed to get world information: bridge down'
    );
  });
});
