/**
 * Offline unit tests for the pure scene helpers (src/page/scenes.ts) — fog-mode
 * mapping and weather-key normalization. These run in Node with no Foundry
 * globals; the page-coupled write paths (createScene/updateScene, image probe,
 * link resolution) are exercised by the live verify script.
 */

import { describe, it, expect } from 'vitest';
import {
  FOG_MODE_TO_NUMBER,
  fogModeToNumber,
  fogModeToName,
  normalizeWeatherKey,
} from './scenes.js';

describe('fogModeToNumber', () => {
  it('maps each mode name to its v14 numeric fog.mode', () => {
    expect(fogModeToNumber('disabled')).toBe(0);
    expect(fogModeToNumber('individual')).toBe(1);
    expect(fogModeToNumber('shared')).toBe(2);
  });

  it('matches the exported map', () => {
    expect(FOG_MODE_TO_NUMBER).toEqual({ disabled: 0, individual: 1, shared: 2 });
  });

  it('throws on an unknown mode', () => {
    expect(() => fogModeToNumber('bogus')).toThrow(/Invalid fogMode/);
  });
});

describe('fogModeToName', () => {
  it('maps numbers back to names', () => {
    expect(fogModeToName(0)).toBe('disabled');
    expect(fogModeToName(1)).toBe('individual');
    expect(fogModeToName(2)).toBe('shared');
  });

  it('stringifies unknown/absent values', () => {
    expect(fogModeToName(7)).toBe('7');
    expect(fogModeToName(undefined)).toBe('');
    expect(fogModeToName(null)).toBe('');
  });
});

describe('normalizeWeatherKey', () => {
  const keys = ['leaves', 'rain', 'rainStorm', 'fog', 'snow', 'blizzard'];

  it('passes through an exact key', () => {
    expect(normalizeWeatherKey('snow', keys)).toBe('snow');
    expect(normalizeWeatherKey('rainStorm', keys)).toBe('rainStorm');
  });

  it('normalizes case-insensitively to the canonical key', () => {
    expect(normalizeWeatherKey('SNOW', keys)).toBe('snow');
    expect(normalizeWeatherKey('rainstorm', keys)).toBe('rainStorm');
  });

  it('treats empty/nullish as "none"', () => {
    expect(normalizeWeatherKey('', keys)).toBe('');
    expect(normalizeWeatherKey(null, keys)).toBe('');
    expect(normalizeWeatherKey(undefined, keys)).toBe('');
  });

  it('throws on an unknown key, listing the available ones', () => {
    expect(() => normalizeWeatherKey('thunder', keys)).toThrow(/Unknown weather "thunder"/);
    expect(() => normalizeWeatherKey('thunder', keys)).toThrow(/snow/);
  });
});
