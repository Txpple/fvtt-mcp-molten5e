/**
 * disconnect-bridge — the bridge-lifecycle tool (courtesy logout).
 *
 * The handler must drive the seam's OWN lifecycle methods (isReady/dispose) and never
 * foundry.call(): calling into the page would force a reconnect of the very session the tool
 * exists to close. Dispose runs unconditionally (isReady() is false while a connect is still in
 * flight, and dispose() is what tears that half-open session down too); only the message varies.
 */

import { describe, it, expect } from 'vitest';
import { BridgeTools } from './bridge.js';
import { makeFoundry, makeLogger } from './test-helpers.js';

function build(overrides?: (foundry: any) => void) {
  const { foundry, calls } = makeFoundry();
  overrides?.(foundry);
  const tools = new BridgeTools({ foundry, logger: makeLogger() });
  return { tools, foundry, calls };
}

describe('BridgeTools', () => {
  it('advertises disconnect-bridge with an empty (no-argument) input schema', () => {
    const { tools } = build();
    const defs = tools.getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('disconnect-bridge');
    expect(defs[0]!.inputSchema.type).toBe('object');
    expect(defs[0]!.inputSchema.properties).toEqual({});
    expect(defs[0]!.inputSchema.required).toEqual([]);
  });

  it('disposes a live session and reports the logout + auto-reconnect contract', async () => {
    const { tools, foundry, calls } = build();
    const result = await tools.handleDisconnectBridge({});
    expect(foundry.dispose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]); // never foundry.call() — that would reconnect the session
    expect(result).toContain('✅ Disconnected');
    expect(result).toContain('next tool call reconnects');
  });

  it('still disposes when not connected, but reports the no-op', async () => {
    const { tools, foundry } = build(f => {
      f.isReady = () => false;
    });
    const result = await tools.handleDisconnectBridge({});
    // Unconditional dispose: isReady() is false mid-connect, and dispose() (which awaits the
    // in-flight connect) is the only way to guarantee that session is torn down too.
    expect(foundry.dispose).toHaveBeenCalledTimes(1);
    expect(result).toContain('already disconnected');
  });
});
