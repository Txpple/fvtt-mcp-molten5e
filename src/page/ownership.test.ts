/**
 * Unit tests for setActorOwnership — the page-side write behind set-actor-ownership.
 *
 * The load-bearing distinction: Foundry treats an ABSENT ownership key and an explicit
 * level-0 entry differently. An absent key inherits `ownership.default`; an explicit 0
 * OVERRIDES it. So INHERIT must REMOVE the user's key (rebuilding the whole object —
 * the `{"ownership.-=<id>": null}` idiom silently no-ops on this field), while NONE must
 * keep storing an explicit 0.
 *
 * `game` is a page global; these tests stand up a minimal actors/users fake around it and
 * record what actor.update() was handed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getActorOwnership, setActorOwnership } from './ownership.js';

type UpdateCall = { data: any; options?: any };

/**
 * Install a fake `game` with one actor (carrying `ownership`) and one user. Returns the
 * recorded update calls; `update` also applies the write so post-state can be asserted.
 */
function stubWorld(ownership: Record<string, number>) {
  const updates: UpdateCall[] = [];
  const actor: any = {
    id: 'actor1',
    name: 'The Party',
    ownership: { ...ownership },
    update: async (data: any, options?: any) => {
      updates.push({ data, options });
      actor.ownership = { ...data.ownership };
    },
  };
  (globalThis as any).game = {
    actors: { get: (id: string) => (id === actor.id ? actor : undefined) },
    users: { get: (id: string) => (id === 'u1' ? { id: 'u1', name: 'John' } : undefined) },
  };
  return { actor, updates };
}

afterEach(() => {
  delete (globalThis as any).game;
});

describe('setActorOwnership — INHERIT (permission: null)', () => {
  it('REMOVES the user key so the actor default applies again', async () => {
    // The party-stash shape: default OWNER, one player pinned to an explicit 0.
    const { actor, updates } = stubWorld({ default: 3, u1: 0, u2: 2 });

    const out = await setActorOwnership({ actorId: 'actor1', userId: 'u1', permission: null });

    expect(out.success).toBe(true);
    expect(updates).toHaveLength(1);
    // The key is GONE — not set to 0, not set to undefined.
    expect(updates[0].data.ownership).toEqual({ default: 3, u2: 2 });
    expect(Object.hasOwn(updates[0].data.ownership, 'u1')).toBe(false);
    expect(Object.hasOwn(actor.ownership, 'u1')).toBe(false);
    // Other entries (including `default`) survive untouched.
    expect(actor.ownership.default).toBe(3);
    expect(actor.ownership.u2).toBe(2);
  });

  it('writes the whole object with diff/recursive off (a recursive merge would re-add the key)', async () => {
    const { updates } = stubWorld({ default: 3, u1: 0 });
    await setActorOwnership({ actorId: 'actor1', userId: 'u1', permission: null });
    expect(updates[0].options).toEqual({ diff: false, recursive: false });
    // And it must not reach for the `-=` deletion idiom, which silently no-ops here.
    expect(Object.keys(updates[0].data)).toEqual(['ownership']);
  });

  it('reports the level the user now inherits', async () => {
    const { updates } = stubWorld({ default: 3, u1: 0 });
    const out = await setActorOwnership({ actorId: 'actor1', userId: 'u1', permission: null });
    expect(out.message).toMatch(/Removed John's explicit ownership entry.*inherits.*\(OWNER\)/);
    expect(updates).toHaveLength(1);
  });

  it('is idempotent when there is no explicit entry to remove', async () => {
    const { actor, updates } = stubWorld({ default: 2 });
    const out = await setActorOwnership({ actorId: 'actor1', userId: 'u1', permission: null });
    expect(out.success).toBe(true);
    expect(out.message).toMatch(/no explicit ownership entry.*already inheriting.*\(OBSERVER\)/);
    expect(updates[0].data.ownership).toEqual({ default: 2 });
    expect(actor.ownership).toEqual({ default: 2 });
  });

  it('falls back to NONE when the actor has no default entry at all', async () => {
    stubWorld({ u1: 3 });
    const out = await setActorOwnership({ actorId: 'actor1', userId: 'u1', permission: null });
    expect(out.message).toMatch(/\(NONE\)/);
  });
});

describe('setActorOwnership — explicit levels', () => {
  it('NONE stores an EXPLICIT 0 (an override of the default, not a removal)', async () => {
    const { actor, updates } = stubWorld({ default: 3, u2: 2 });

    const out = await setActorOwnership({ actorId: 'actor1', userId: 'u1', permission: 0 });

    expect(out.success).toBe(true);
    expect(updates[0].data.ownership).toEqual({ default: 3, u2: 2, u1: 0 });
    expect(Object.hasOwn(actor.ownership, 'u1')).toBe(true);
    expect(actor.ownership.u1).toBe(0);
    // The message has to say what a stored 0 actually does, or a GM reads it as "removed".
    expect(out.message).toMatch(/NONE.*explicit deny.*INHERIT/);
  });

  it('merges a granted level into the existing map without disturbing other entries', async () => {
    const { actor } = stubWorld({ default: 0, u2: 2 });
    const out = await setActorOwnership({ actorId: 'actor1', userId: 'u1', permission: 3 });
    expect(actor.ownership).toEqual({ default: 0, u2: 2, u1: 3 });
    expect(out.message).toBe('Set The Party ownership to OWNER for John');
  });
});

/**
 * Install a fake `game` for the READ path: one actor carrying `ownership`, plus a
 * player and a GM. `testUserPermission` mirrors Foundry's cascade — GMs are always
 * OWNER, everyone else gets their explicit entry or falls back to `default`.
 */
function stubReadWorld(ownership: Record<string, number> | undefined) {
  const LEVELS: Record<string, number> = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
  const actor: any = {
    id: 'actor1',
    name: 'The Party',
    type: 'group',
    ownership: ownership ? { ...ownership } : undefined,
    testUserPermission: (user: any, level: string) => {
      const map = actor.ownership ?? {};
      const held = user.isGM ? 3 : (map[user.id] ?? map.default ?? 0);
      return held >= LEVELS[level];
    },
  };
  const users = [
    { id: 'u1', name: 'John', isGM: false },
    { id: 'gm', name: 'Gamemaster', isGM: true },
  ];
  (globalThis as any).game = {
    actors: { contents: [actor] },
    users: { contents: users, get: (id: string) => users.find(u => u.id === id) },
  };
  return { actor };
}

/** The single row getActorOwnership produces for the lone player. */
function readRow(): any {
  return (getActorOwnership({ actorIdentifier: 'all' }) as any[])[0];
}

describe('getActorOwnership — explicit vs inherited', () => {
  it('marks an explicit level-0 entry as an explicit DENY, not an absent one', async () => {
    // The party-stash shape: default OWNER, one player pinned to an explicit 0. Both this
    // and "no entry at all on a default-NONE actor" read as NONE — only `source` separates
    // them, and that is what decides between set-actor-ownership NONE and INHERIT.
    stubReadWorld({ default: 3, u1: 0 });

    const info = readRow();
    expect(info.defaultPermission).toBe('OWNER');
    expect(info.numericDefaultPermission).toBe(3);
    expect(info.ownership).toEqual([
      {
        userId: 'u1',
        userName: 'John',
        permission: 'NONE',
        numericPermission: 0,
        source: 'explicit',
        explicitPermission: 'NONE',
        numericExplicitPermission: 0,
      },
    ]);
  });

  it('marks a level the player only gets from the actor default as inherited', async () => {
    stubReadWorld({ default: 3 });

    const row = readRow().ownership[0];
    expect(row.permission).toBe('OWNER');
    expect(row.source).toBe('inherited');
    expect(row.explicitPermission).toBeNull();
    expect(row.numericExplicitPermission).toBeNull();
  });

  it('reports a granted entry as explicit even when it matches the default', async () => {
    stubReadWorld({ default: 2, u1: 2 });

    const row = readRow().ownership[0];
    expect(row.permission).toBe('OBSERVER');
    expect(row.source).toBe('explicit');
    expect(row.explicitPermission).toBe('OBSERVER');
  });

  it('defaults to NONE when the actor carries no ownership map at all', async () => {
    stubReadWorld(undefined);

    const info = readRow();
    expect(info.defaultPermission).toBe('NONE');
    expect(info.numericDefaultPermission).toBe(0);
    expect(info.ownership[0]).toMatchObject({ permission: 'NONE', source: 'inherited' });
  });

  it('still excludes GM users, who test as OWNER on everything', async () => {
    stubReadWorld({ default: 0 });
    expect(readRow().ownership.map((r: any) => r.userId)).toEqual(['u1']);
  });
});

describe('setActorOwnership — guards', () => {
  it('returns an error (not a throw) for an unknown actor or user, writing nothing', async () => {
    const { updates } = stubWorld({ default: 3 });
    await expect(
      setActorOwnership({ actorId: 'nope', userId: 'u1', permission: null })
    ).resolves.toMatchObject({ success: false, error: 'Actor not found: nope' });
    await expect(
      setActorOwnership({ actorId: 'actor1', userId: 'ghost', permission: null })
    ).resolves.toMatchObject({ success: false, error: 'User not found: ghost' });
    expect(updates).toHaveLength(0);
  });
});
