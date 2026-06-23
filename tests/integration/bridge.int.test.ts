// Bridge connectivity smoke (live). Proves the irreducible spine: launch headless
// Chromium -> wake the Molten box -> join the world -> game.ready -> inject window.__fvtt,
// then round-trip both seams (foundry.call + foundry.evaluate). If this file is green,
// the rest of the live suite has a working bridge to build on.
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Foundry } from '../../dist/foundry.js';
import { LIVE, foundryConfig, noopLogger, CONNECT_TIMEOUT_MS } from './setup.js';

describe.skipIf(!LIVE)('bridge connectivity (live)', () => {
  let foundry: Foundry;

  beforeAll(async () => {
    foundry = new Foundry(foundryConfig(), noopLogger);
    await foundry.connect();
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await foundry?.dispose();
  });

  it('reaches game.ready and reports isReady()', () => {
    expect(foundry.isReady()).toBe(true);
  });

  it('round-trips foundry.call(getWorldInfo)', async () => {
    const info = await foundry.call<Record<string, unknown>>('getWorldInfo');
    expect(info).toBeTruthy();
    expect(info.system ?? info.worldId ?? info.title).toBeTruthy();
  });

  it('round-trips foundry.evaluate (game.userId is a non-empty string)', async () => {
    const userId = await foundry.evaluate(
      () => (globalThis as { game?: { userId?: string } }).game?.userId ?? '',
      null
    );
    expect(typeof userId).toBe('string');
    expect(userId.length).toBeGreaterThan(0);
  });
});
