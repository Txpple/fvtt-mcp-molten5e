// Unit tests for the shared prototype-token defaults every created PC/NPC receives.
import { describe, it, expect } from 'vitest';
import {
  readDarkvision,
  resolveDisposition,
  TOKEN_DISPLAY_ALWAYS,
  TOKEN_DISPOSITION,
  tokenDefaults,
} from './token-defaults.js';

describe('tokenDefaults', () => {
  it('shows name + HP bar to everyone and enables basic vision by default', () => {
    const t = tokenDefaults({ disposition: TOKEN_DISPOSITION.friendly });
    expect(t.displayName).toBe(TOKEN_DISPLAY_ALWAYS);
    expect(t.displayBars).toBe(TOKEN_DISPLAY_ALWAYS);
    expect(t.disposition).toBe(1);
    expect(t.sight).toEqual({ enabled: true, visionMode: 'basic', range: 0 });
  });

  it('switches to darkvision mode + range when the sheet grants darkvision', () => {
    const t = tokenDefaults({ disposition: TOKEN_DISPOSITION.hostile, darkvision: 60 });
    expect(t.disposition).toBe(-1);
    expect(t.sight).toEqual({ enabled: true, visionMode: 'darkvision', range: 60 });
  });
});

describe('readDarkvision', () => {
  it('reads the modern senses.ranges shape', () => {
    expect(readDarkvision({ ranges: { darkvision: 120 } })).toBe(120);
  });
  it('falls back to the legacy flat shape', () => {
    expect(readDarkvision({ darkvision: 60 })).toBe(60);
  });
  it('is 0 (basic vision) when absent or non-positive', () => {
    expect(readDarkvision({})).toBe(0);
    expect(readDarkvision(undefined)).toBe(0);
    expect(readDarkvision({ darkvision: 0 })).toBe(0);
  });
});

describe('resolveDisposition', () => {
  it('maps keys to the Foundry numeric dispositions', () => {
    expect(resolveDisposition('friendly', -1)).toBe(1);
    expect(resolveDisposition('hostile', 1)).toBe(-1);
    expect(resolveDisposition('neutral', 1)).toBe(0);
    expect(resolveDisposition('secret', 0)).toBe(-2);
  });
  it('passes an already-numeric value through', () => {
    expect(resolveDisposition(0, -1)).toBe(0);
  });
  it('falls back when unset or unrecognized', () => {
    expect(resolveDisposition(undefined, -1)).toBe(-1);
    expect(resolveDisposition(null, 1)).toBe(1);
    expect(resolveDisposition('bogus' as never, 1)).toBe(1);
  });
});
