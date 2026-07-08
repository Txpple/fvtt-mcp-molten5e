/**
 * Unit tests for planCombatTrackerChanges — the PURE fold of requested combat-tracker changes
 * onto the current core.combatTrackerConfig value. The async configureCombatTracker (live
 * settings get/set + src existence guard) is covered by scripts/verify-combat-tracker.mjs.
 */

import { describe, it, expect } from 'vitest';
import { planCombatTrackerChanges } from './combat-tracker.js';

const ANIMATIONS = [
  { value: 'spin', label: 'Spin' },
  { value: 'spinPulse', label: 'Spin Pulse' },
  { value: 'pulse', label: 'Pulse' },
];

const current = () => ({
  resource: '',
  skipDefeated: false,
  turnMarker: {
    enabled: true,
    animation: 'spin',
    src: 'worlds/w/assets/ui/m-01.png',
    disposition: false,
  },
});

describe('planCombatTrackerChanges', () => {
  it('applies a src change and echoes previous → next', () => {
    const { next, applied } = planCombatTrackerChanges(
      current(),
      { turnMarker: { src: 'worlds/w/assets/ui/m-02.png' } },
      ANIMATIONS
    );
    expect(applied).toEqual([
      {
        field: 'turnMarker.src',
        previous: 'worlds/w/assets/ui/m-01.png',
        next: 'worlds/w/assets/ui/m-02.png',
      },
    ]);
    expect(next.turnMarker.src).toBe('worlds/w/assets/ui/m-02.png');
    // untouched fields survive
    expect(next.turnMarker.animation).toBe('spin');
    expect(next.skipDefeated).toBe(false);
  });

  it('folds several fields in one call', () => {
    const { next, applied } = planCombatTrackerChanges(
      current(),
      { skipDefeated: true, turnMarker: { animation: 'pulse', disposition: true } },
      ANIMATIONS
    );
    expect(applied.map(c => c.field).sort()).toEqual([
      'skipDefeated',
      'turnMarker.animation',
      'turnMarker.disposition',
    ]);
    expect(next.turnMarker.animation).toBe('pulse');
    expect(next.skipDefeated).toBe(true);
  });

  it('re-applying the current value is a clean no-op (applied: [])', () => {
    const { applied } = planCombatTrackerChanges(
      current(),
      { turnMarker: { enabled: true, animation: 'spin' }, skipDefeated: false },
      ANIMATIONS
    );
    expect(applied).toEqual([]);
  });

  it('treats "" as a real value (reset-to-stock src, track-nothing resource)', () => {
    const { next, applied } = planCombatTrackerChanges(
      current(),
      { turnMarker: { src: '' } },
      ANIMATIONS
    );
    expect(applied).toEqual([
      { field: 'turnMarker.src', previous: 'worlds/w/assets/ui/m-01.png', next: '' },
    ]);
    expect(next.turnMarker.src).toBe('');
  });

  it('rejects an animation the live registry does not know, listing the valid ids', () => {
    expect(() =>
      planCombatTrackerChanges(current(), { turnMarker: { animation: 'wobble' } }, ANIMATIONS)
    ).toThrow(/unknown turn-marker animation "wobble".*"spin", "spinPulse", "pulse"/);
  });

  it('does not mutate the input config', () => {
    const cfg = current();
    planCombatTrackerChanges(cfg, { turnMarker: { src: 'x.png' } }, ANIMATIONS);
    expect(cfg.turnMarker.src).toBe('worlds/w/assets/ui/m-01.png');
  });

  it('is safe on a missing/empty current config', () => {
    const { next, applied } = planCombatTrackerChanges(
      undefined,
      { turnMarker: { enabled: true } },
      ANIMATIONS
    );
    expect(applied).toEqual([{ field: 'turnMarker.enabled', previous: undefined, next: true }]);
    expect(next.turnMarker.enabled).toBe(true);
  });
});
