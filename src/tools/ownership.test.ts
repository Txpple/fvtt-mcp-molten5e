/**
 * Unit tests for OwnershipTools (set-actor-ownership, list-actor-ownership).
 *
 * These handlers are private and reached through `handleToolCall(name, args)`.
 * Each one resolves actors/players via extra bridge calls before applying
 * (or reading) ownership, so the mock foundry dispatches per-method via a
 * function response. The handlers return result OBJECTS (not strings), so the
 * assertions inspect those object fields against what the format code builds.
 */

import { describe, it, expect } from 'vitest';
import { OwnershipTools } from './ownership.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new OwnershipTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('OwnershipTools.getToolDefinitions', () => {
  it('exposes exactly the two ownership tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(['list-actor-ownership', 'set-actor-ownership']);
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });

  it('set-actor-ownership requires actor/player/permission and exposes the level enum', () => {
    const { tools } = build();
    const def = tools.getToolDefinitions().find(t => t.name === 'set-actor-ownership')!;
    expect(def.inputSchema.required).toEqual([
      'actorIdentifier',
      'playerIdentifier',
      'permissionLevel',
    ]);
    expect((def.inputSchema.properties as any).permissionLevel.enum).toEqual([
      'NONE',
      'LIMITED',
      'OBSERVER',
      'OWNER',
    ]);
  });
});

describe('set-actor-ownership (assignActorOwnership)', () => {
  // Dispatcher: findActor -> single actor; findPlayers -> single player;
  // setActorOwnership -> success payload the formatter reads.
  function singleAssignResponse(method: string) {
    switch (method) {
      case 'findActor':
        return { id: 'actor1', name: 'Aragorn' };
      case 'findPlayers':
        return [{ id: 'user1', name: 'John' }];
      case 'setActorOwnership':
        return { success: true, message: 'ok' };
      default:
        return {};
    }
  }

  it('forwards the correct bridge method + numeric permission and reports success', async () => {
    const { tools, calls } = build(singleAssignResponse);
    const out = await tools.handleToolCall('set-actor-ownership', {
      actorIdentifier: 'Aragorn',
      playerIdentifier: 'John',
      permissionLevel: 'OWNER',
    });

    // The mutating call carries the resolved ids and the numeric OWNER level (3).
    const ownershipCall = calls.find(c => c[0] === 'setActorOwnership');
    expect(ownershipCall).toBeDefined();
    expect(ownershipCall![1]).toEqual({ actorId: 'actor1', userId: 'user1', permission: 3 });

    expect(out).toMatchObject({
      success: true,
      message: '1 ownership assignments completed',
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      actor: 'Aragorn',
      player: 'John',
      permission: 'OWNER',
      success: true,
    });
  });

  it('maps each permission level name to its numeric Foundry constant', async () => {
    for (const [level, numeric] of [
      ['NONE', 0],
      ['LIMITED', 1],
      ['OBSERVER', 2],
      ['OWNER', 3],
    ] as const) {
      const { tools, calls } = build(singleAssignResponse);
      await tools.handleToolCall('set-actor-ownership', {
        actorIdentifier: 'Aragorn',
        playerIdentifier: 'John',
        permissionLevel: level,
      });
      const ownershipCall = calls.find(c => c[0] === 'setActorOwnership');
      expect(ownershipCall![1].permission).toBe(numeric);
    }
  });

  it('reports a per-pair failure when the bridge returns success:false', async () => {
    const { tools } = build((method: string) => {
      if (method === 'findActor') return { id: 'a', name: 'Aragorn' };
      if (method === 'findPlayers') return [{ id: 'u', name: 'John' }];
      if (method === 'setActorOwnership') return { success: false, error: 'denied' };
      return {};
    });
    const out = await tools.handleToolCall('set-actor-ownership', {
      actorIdentifier: 'Aragorn',
      playerIdentifier: 'John',
      permissionLevel: 'OBSERVER',
    });
    // No successes -> overall success false, failure count reflected in message.
    expect(out.success).toBe(false);
    expect(out.message).toBe('0 ownership assignments completed, 1 failed');
  });

  it('blocks a bulk operation (multiple actors) unless confirmBulkOperation is set', async () => {
    // "all friendly npcs" resolves via getFriendlyNPCs -> 2 actors -> bulk.
    const { tools, calls } = build((method: string) => {
      if (method === 'getFriendlyNPCs')
        return [
          { id: 'n1', name: 'Guard' },
          { id: 'n2', name: 'Merchant' },
        ];
      if (method === 'findPlayers') return [{ id: 'u', name: 'John' }];
      return {};
    });
    const out = await tools.handleToolCall('set-actor-ownership', {
      actorIdentifier: 'all friendly npcs',
      playerIdentifier: 'John',
      permissionLevel: 'OBSERVER',
    });
    expect(out.success).toBe(false);
    expect(out.error).toContain('Bulk operation detected');
    expect(out).toMatchObject({ actorsFound: 2, playersFound: 1, totalChanges: 2 });
    // It must NOT have written anything when unconfirmed.
    expect(calls.some(c => c[0] === 'setActorOwnership')).toBe(false);
  });

  it('proceeds with a bulk operation when confirmBulkOperation is true', async () => {
    const { tools, calls } = build((method: string) => {
      if (method === 'getFriendlyNPCs')
        return [
          { id: 'n1', name: 'Guard' },
          { id: 'n2', name: 'Merchant' },
        ];
      if (method === 'findPlayers') return [{ id: 'u', name: 'John' }];
      if (method === 'setActorOwnership') return { success: true };
      return {};
    });
    const out = await tools.handleToolCall('set-actor-ownership', {
      actorIdentifier: 'all friendly npcs',
      playerIdentifier: 'John',
      permissionLevel: 'OBSERVER',
      confirmBulkOperation: true,
    });
    expect(out.success).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(calls.filter(c => c[0] === 'setActorOwnership')).toHaveLength(2);
  });

  it('rejects an invalid permission level via the zod enum', async () => {
    const { tools } = build(singleAssignResponse);
    await expect(
      tools.handleToolCall('set-actor-ownership', {
        actorIdentifier: 'Aragorn',
        playerIdentifier: 'John',
        permissionLevel: 'GODMODE',
      })
    ).rejects.toThrow();
  });
});

describe('list-actor-ownership (listActorOwnership)', () => {
  it('forwards identifiers to getActorOwnership and wraps the result', async () => {
    const ownership = [{ actor: 'Aragorn', players: [{ name: 'John', level: 'OWNER' }] }];
    const { tools, calls } = build(ownership);
    const out = await tools.handleToolCall('list-actor-ownership', {
      actorIdentifier: 'Aragorn',
      playerIdentifier: 'John',
    });
    expect(calls[0][0]).toBe('getActorOwnership');
    expect(calls[0][1]).toEqual({ actorIdentifier: 'Aragorn', playerIdentifier: 'John' });
    expect(out).toEqual({ success: true, ownership });
  });

  it('returns a failure object (not a throw) when the bridge query rejects', async () => {
    const { tools } = build(() => {
      throw new Error('connection lost');
    });
    const out = await tools.handleToolCall('list-actor-ownership', { actorIdentifier: 'all' });
    expect(out).toEqual({ success: false, error: 'connection lost' });
  });
});

describe('handleToolCall dispatch', () => {
  it('throws on an unknown tool name', async () => {
    const { tools } = build();
    await expect(tools.handleToolCall('not-a-tool', {})).rejects.toThrow(/Unknown ownership tool/);
  });
});
