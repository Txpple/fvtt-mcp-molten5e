import { z } from 'zod';
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load .env from the repo root regardless of the process's CWD, so the server picks up its
// config whether it's launched from the repo root or wired into Claude Code from another directory.
// The compiled file lives at <repo>/dist/config.js, so the repo-root .env is one level up.
// (If import.meta.url is ever unavailable — e.g. an esbuild bundle replaces it with a sentinel —
// fileURLToPath throws and we fall back to dotenv's default CWD lookup.)
try {
  dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });
} catch {
  dotenv.config();
}

/**
 * Single source of truth for the version the MCP server advertises: package.json (one level up
 * from the compiled dist/config.js). Reading it here keeps the wire version, the npm package
 * version, and the docs from drifting apart. Falls back gracefully if the file can't be read.
 */
function readPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const ConfigSchema = z.object({
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  logFormat: z.enum(['json', 'simple']).default('simple'),
  enableFileLogging: z.boolean().default(false),
  logFilePath: z.string().optional(),
  toolResponseMaxChars: z.number().min(256).max(500000).default(20000),
  server: z.object({
    name: z.string().default('foundry-mcp-server'),
    // Default only applies if rawConfig provides nothing; rawConfig reads package.json (see below).
    version: z.string().default('0.0.0'),
  }),
  // Molten Hosting config. `serverUrl`/`magicUrl`/`user` drive the headless Foundry
  // bridge (src/foundry.ts); the webdav* fields drive the Plane-B asset tools.
  // Non-secret connection facts default to neutral `your-server` placeholders — set the
  // real values for your instance via the MOLTEN_* env vars in a gitignored .env (see .env.example).
  // Secrets AND worldId are `.optional()` with NO default — worldId is left unset rather than a
  // placeholder so the bridge's remote world-launch only fires for a real, configured world
  // (an unset MOLTEN_WORLD_ID then takes the manual-launch guidance path, not a doomed launch).
  // Tools check presence and tell the user which var to set.
  molten: z
    .object({
      serverUrl: z.string().url().default('https://your-server.moltenhosting.com'),
      worldId: z.string().optional(), // MOLTEN_WORLD_ID — real world to remote-launch; unset = manual
      // Headless bridge (src/foundry.ts): wake a sleeping box + which user to join as.
      magicUrl: z.string().optional(), // MOLTEN_MAGIC_URL — GET to wake (…?s=token)
      user: z.string().default('MCP-Claude'), // FOUNDRY_USER — GM user to /join as
      webdavUrl: z.string().url().default('https://your-server.webdav.moltenhosting.com'),
      fileBrowserUrl: z.string().url().default('https://your-server.files.moltenhosting.com'),
      webdavUser: z.string().default('foundry-ftp'),
      // --- secrets (env-only; undefined === not configured) ---
      password: z.string().optional(), // FOUNDRY_PASSWORD — the join user's password (omit for a passwordless user)
      webdavPassword: z.string().optional(), // MOLTEN_WEBDAV_PASSWORD — WebDAV/FileBrowser
      adminKey: z.string().optional(), // MOLTEN_ADMIN_KEY — Foundry admin access key
    })
    // .prefault({}) (not .default({})) so an omitted `molten` key is fed through the
    // schema and each field's own default fills in. zod 4's .default() takes the parsed
    // OUTPUT type (all fields required); .prefault() keeps the zod-3 "parse the default" behavior.
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type MoltenConfig = Config['molten'];

const rawConfig = {
  logLevel: process.env.LOG_LEVEL || 'warn',
  logFormat: process.env.LOG_FORMAT || 'simple',
  enableFileLogging: process.env.ENABLE_FILE_LOGGING === 'true',
  logFilePath: process.env.LOG_FILE_PATH,
  toolResponseMaxChars: parseInt(process.env.TOOL_RESPONSE_MAX_CHARS || '20000', 10),
  server: {
    name: process.env.SERVER_NAME || 'foundry-mcp-server',
    version: process.env.SERVER_VERSION || readPackageVersion(),
  },
  molten: {
    serverUrl: process.env.MOLTEN_SERVER_URL || 'https://your-server.moltenhosting.com',
    worldId: process.env.MOLTEN_WORLD_ID, // unset -> manual-launch path (no placeholder)
    magicUrl: process.env.MOLTEN_MAGIC_URL,
    user: process.env.FOUNDRY_USER || 'MCP-Claude',
    password: process.env.FOUNDRY_PASSWORD,
    webdavUrl: process.env.MOLTEN_WEBDAV_URL || 'https://your-server.webdav.moltenhosting.com',
    fileBrowserUrl:
      process.env.MOLTEN_FILEBROWSER_URL || 'https://your-server.files.moltenhosting.com',
    webdavUser: process.env.MOLTEN_WEBDAV_USER || 'foundry-ftp',
    webdavPassword: process.env.MOLTEN_WEBDAV_PASSWORD,
    adminKey: process.env.MOLTEN_ADMIN_KEY,
  },
};

export const config = ConfigSchema.parse(rawConfig);
