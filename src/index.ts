#!/usr/bin/env node

// The MCP server entry point. A single stdio process: it builds the tool surface (src/registry.ts)
// and dispatches callTool through it. The tools talk to the live Foundry world through the
// `foundry.call(name, args)` seam (src/foundry.ts — the only Playwright-aware file). No TCP wrapper,
// no spawned backend, no lock dance: the inherited WebRTC transport is gone.
//
// The headless Foundry client connects lazily — the first tool call wakes the Molten box and joins
// the world; tools/list responds without touching Foundry.

import * as os from 'node:os';
import * as path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { config } from './config.js';
import { Logger } from './logger.js';
import { Foundry } from './foundry.js';
import { ErrorHandler, FormattedToolError } from './utils/error-handler.js';
import { buildToolRegistry } from './registry.js';

/**
 * Cap a tool result so a single fat response (a fully-loaded actor dump, a broad search) can't blow
 * the model's context or inflate cost without bound. Truncates and annotates how much was dropped,
 * enforcing the config.toolResponseMaxChars guardrail that was previously defined but never applied.
 */
function capResponse(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n…[${omitted} chars omitted — response exceeded toolResponseMaxChars (${maxChars})]`;
}

async function main(): Promise<void> {
  // File-only logging: stdout is the JSON-RPC channel and must stay clean.
  const logger = new Logger({
    level: config.logLevel,
    format: config.logFormat,
    enableConsole: false,
    enableFile: true,
    filePath: path.join(os.tmpdir(), 'foundry-mcp-server', 'mcp-server.log'),
  });

  logger.info('Starting Foundry MCP server (headless)', {
    version: config.server.version,
    serverUrl: config.molten.serverUrl,
    user: config.molten.user,
  });

  // The live bridge. Lazy: it connects (wake -> /join -> game.ready -> inject)
  // on the first foundry.call(). Its own diagnostics go to stderr.
  const foundry = new Foundry({
    serverUrl: config.molten.serverUrl,
    user: config.molten.user,
    ...(config.molten.password ? { password: config.molten.password } : {}),
    ...(config.molten.magicUrl ? { magicUrl: config.molten.magicUrl } : {}),
    // Admin-key + world-id enable remote world-launch when a cold box is up but no world is active.
    ...(config.molten.adminKey ? { adminKey: config.molten.adminKey } : {}),
    ...(config.molten.worldId ? { worldId: config.molten.worldId } : {}),
  });

  // The whole tool surface: definitions + dispatch, wired in one place (src/registry.ts).
  const { tools, dispatch } = buildToolRegistry({ foundry, logger });

  // Central error mapper for the dispatch wrapper: turns raw failures (esp. cold-box / bridge
  // errors) from EVERY tool into actionable messages, while passing through messages the tools
  // already curated (FormattedToolError) verbatim.
  const errorHandler = new ErrorHandler(logger);

  const mcp = new Server(
    { name: config.server.name, version: config.server.version },
    { capabilities: { tools: {} } }
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params as any;
    try {
      const result = await dispatch(name, args ?? {});
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return {
        content: [{ type: 'text', text: capResponse(text, config.toolResponseMaxChars) }],
      };
    } catch (e) {
      // Tools that curate their own errors throw FormattedToolError — pass those through verbatim.
      // Everything else is mapped centrally so EVERY tool (not just the few that wired in
      // ErrorHandler) surfaces actionable guidance for cold-box / permission / not-found failures.
      const message =
        e instanceof FormattedToolError ? e.message : errorHandler.toUserMessage(e, name);
      logger.error('Tool call failed', { name, error: message });
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const shutdown = (): void => {
    void foundry.dispose().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);

  // Last-resort safety nets. A rejected promise that escapes a tool handler (or the bridge) must
  // not silently kill the stdio process with no trace; an uncaught exception leaves the headless
  // browser orphaned, so dispose before exiting.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (err: Error) => {
    logger.error('Uncaught exception — shutting down', { error: err.message });
    shutdown();
  });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info('MCP server connected over stdio');
}

main().catch(err => {
  console.error('Foundry MCP server failed to start:', err);
  process.exit(1);
});
