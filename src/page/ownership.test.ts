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
import { setActorOwnership } from './ownership.js';

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
