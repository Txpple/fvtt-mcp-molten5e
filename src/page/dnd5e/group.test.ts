/**
 * Unit tests for the PURE membership planners in src/page/dnd5e/group.ts — the classification
 * that mirrors dnd5e's system.addMember/removeMember guards so a batch reports per-actor
 * outcomes instead of silently no-opping (dup) or throwing mid-loop (group-in-group /
 * non-member). The async live paths (create / addMember / settings) are covered by
 * scripts/verify-group-tooling.mjs.
 */

import { describe, it, expect } from 'vitest';
import { planMemberAdds, planMemberRemovals, assertCreatableMembers } from './group.js';
import type { MemberResolution } from './group.js';

const gren = { id: 'A1', name: 'Gren Greenmantle', type: 'character' };
const jetten = { id: 'A2', name: 'Jetten Elisedil', type: 'character' };
const wolf = { id: 'A3', name: 'Wolf', type: 'npc' };
const stash = { id: 'G1', name: 'Old Stash', type: 'group' };

const r = (identifier: string, actor: MemberResolution['actor']): MemberResolution => ({
  identifier,
  actor,
});

describe('planMemberAdds', () => {
  it('adds resolved non-members and classifies every skip', () => {
    const { add, skipped } = planMemberAdds(
      ['A2'],
      [
        r('Gren', gren),
        r('Jetten', jetten), // already a member
        r('Old Stash', stash), // group-in-group
        r('Nobody', null), // unresolved
      ]
    );
    expect(add).toEqual([gren]);
    expect(skipped).toEqual([
      { identifier: 'Jetten', reason: 'already-member' },
      { identifier: 'Old Stash', reason: 'group-actor' },
      { identifier: 'Nobody', reason: 'not-found' },
    ]);
  });

  it('collapses the same actor requested twice into one add + a duplicate-request skip', () => {
    const { add, skipped } = planMemberAdds([], [r('Gren', gren), r('gren greenmantle', gren)]);
    expect(add).toEqual([gren]);
    expect(skipped).toEqual([{ identifier: 'gren greenmantle', reason: 'duplicate-request' }]);
  });

  it('empty request → nothing to do', () => {
    expect(planMemberAdds(['A1'], [])).toEqual({ add: [], skipped: [] });
  });
});

describe('planMemberRemovals', () => {
  it('removes resolved members and classifies non-members', () => {
    const { remove, skipped } = planMemberRemovals(
      ['A1', 'A3'],
      [
        r('Gren', gren),
        r('Jetten', jetten), // resolves but is not in the group
        r('Nobody', null),
      ]
    );
    expect(remove).toEqual([{ id: 'A1', name: 'Gren Greenmantle' }]);
    expect(skipped).toEqual([
      { identifier: 'Jetten', reason: 'not-a-member' },
      { identifier: 'Nobody', reason: 'not-found' },
    ]);
  });

  it('a raw member id with NO surviving actor still removes (the dangling-member case)', () => {
    const { remove, skipped } = planMemberRemovals(['DEAD1'], [r('DEAD1', null)]);
    expect(remove).toEqual([{ id: 'DEAD1', name: null }]);
    expect(skipped).toEqual([]);
  });

  it('same member requested twice → one removal + duplicate-request', () => {
    const { remove, skipped } = planMemberRemovals(['A1'], [r('A1', gren), r('Gren', gren)]);
    expect(remove).toEqual([{ id: 'A1', name: 'Gren Greenmantle' }]);
    expect(skipped).toEqual([{ identifier: 'Gren', reason: 'duplicate-request' }]);
  });
});

describe('assertCreatableMembers', () => {
  it('returns the unique resolved roster (silent within-request dedupe)', () => {
    const members = assertCreatableMembers([r('Gren', gren), r('Wolf', wolf), r('gren', gren)]);
    expect(members).toEqual([gren, wolf]);
  });

  it('FAIL-CLOSED: one unresolved member rejects the whole create, listing it', () => {
    expect(() => assertCreatableMembers([r('Gren', gren), r('Nobody', null)])).toThrow(
      /nothing was created.*not found in this world: "Nobody"/
    );
  });

  it('FAIL-CLOSED: a group member rejects, and all problems are listed together', () => {
    expect(() =>
      assertCreatableMembers([r('Old Stash', stash), r('Ghost', null)])
    ).toThrow(/not found in this world: "Ghost".*group actors cannot be members.*"Old Stash"/);
  });

  it('empty member list is a valid create', () => {
    expect(assertCreatableMembers([])).toEqual([]);
  });
});
