import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * Bridge session lifecycle — the one tool that talks to the BRIDGE itself instead of the world.
 *
 * disconnect-bridge: log the DM Assistant user out of the live world on request ("log out
 * please") by disposing the persistent Playwright session, without ending the MCP process.
 * The next tool call reconnects transparently through the existing lazy connect/recover path,
 * so this is purely a courtesy logout: the user drops off the world's active-player list.
 *
 * Deliberately NOT a foundry.call() tool — there is no page to call once the point is to close
 * the page. It drives the seam's own lifecycle methods (isReady/dispose) directly.
 */

const DisconnectBridgeSchema = z.object({});

export interface BridgeToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class BridgeTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: BridgeToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'BridgeTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'disconnect-bridge',
        description:
          'Log the DM Assistant bridge user out of the live Foundry world: closes the persistent ' +
          'headless browser session so the user goes inactive (drops off the active-player list). ' +
          'The world itself keeps running and the MCP server stays up — the NEXT tool call ' +
          'transparently reconnects (wake → join → ready), so nothing needs to be restarted. ' +
          'Use at the end of a work session ("log out please"); safe to call any time — already ' +
          'disconnected is a clean no-op.',
        inputSchema: toInputSchema(DisconnectBridgeSchema),
      },
    ];
  }

  async handleDisconnectBridge(args: any): Promise<string> {
    DisconnectBridgeSchema.parse(args ?? {});
    // Capture the state BEFORE disposing, then dispose unconditionally: isReady() is false while a
    // connect is still in flight, and dispose() (which awaits it) is the only way to make sure that
    // half-open session is torn down too rather than quietly finishing the login.
    const wasConnected = this.foundry.isReady();
    this.logger.info('Disconnecting the bridge session', { wasConnected });
    await this.foundry.dispose();

    if (!wasConnected) {
      return (
        'ℹ️ Bridge already disconnected — no live Foundry session was open. ' +
        'The next tool call will connect fresh.'
      );
    }
    return (
      '✅ Disconnected — the bridge user has logged out of the Foundry world and is now ' +
      'inactive. The world keeps running; the next tool call reconnects automatically.'
    );
  }
}
