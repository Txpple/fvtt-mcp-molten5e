/**
 * Shared test helpers for tool-class unit tests.
 *
 * Tool classes take `{ foundry, logger }` and only ever call
 * `foundry.call(name, data)` and `logger.child(...)`. These builders supply
 * minimal fakes so the validation + response-formatting layer of each handler
 * can be exercised with no live Foundry. The recorded `name` is the bare page
 * function name (e.g. 'getWorldInfo') — the legacy 'foundry-mcp-bridge.' prefix
 * is gone with the WebRTC transport.
 */

import { vi } from 'vitest';

/** A Logger stand-in: `child()` returns itself; all log methods are no-ops. */
export function makeLogger(): any {
  const logger: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger.child = () => logger;
  return logger;
}

/**
 * A FoundryBridge stand-in. `call` resolves to `response` (or the value
 * returned by a `response(name, args)` function). The returned `.calls`
 * array records every `[name, args]` pair so tests can assert what the
 * handler forwarded to the bridge. `name` is the bare page function name.
 */
export function makeFoundry(response: any = {}): {
  foundry: any;
  calls: Array<[string, any]>;
} {
  const calls: Array<[string, any]> = [];
  const foundry: any = {
    call: vi.fn(async (name: string, args?: any) => {
      calls.push([name, args]);
      return typeof response === 'function' ? response(name, args) : response;
    }),
    // The bridge seam also exposes screenshot(outPath) (Playwright-level). Recorded as a no-op so
    // tool handlers that capture screenshots can be exercised offline.
    screenshot: vi.fn(async (_outPath: string) => {}),
  };
  return { foundry, calls };
}
