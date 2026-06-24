// Shared Plane-B WebDAV access helpers.
//
// Extracted from MoltenTools so BOTH the asset tools (src/tools/molten/index.ts) and the chat tools
// (src/tools/chat.ts — export-chat-log + image embedding) reach the WebDAV file channel through one
// hardened path. The cardinal world-DB write guard (looksLikeWorldDbPath / worldDbRefusal) and the
// not-configured / error messaging are single-sourced here so they can't drift between callers.

import { Logger } from '../../logger.js';
import type { MoltenConfig } from '../../config.js';
import { WebDavClient, WebDavError } from './webdav.js';

/** Lazily build a WebDAV client from config; null when no password is configured. */
export function makeDavClient(molten: MoltenConfig, logger: Logger): WebDavClient | null {
  if (!molten.webdavPassword) return null;
  return new WebDavClient({
    webdavUrl: molten.webdavUrl,
    user: molten.webdavUser,
    password: molten.webdavPassword,
    logger,
  });
}

/** "<tool> is not configured: set MOLTEN_WEBDAV_PASSWORD …" — the standard no-password message. */
export function notConfiguredMessage(tool: string, webdavUser: string): string {
  return (
    `${tool} is not configured: set MOLTEN_WEBDAV_PASSWORD in your .env (the File Manager ` +
    `password from the Molten panel; user "${webdavUser}"). Never commit it.`
  );
}

/** Refusal for any path inside a world's live LevelDB store. */
export function worldDbRefusal(remotePath: string): string {
  return (
    `Refused: "${remotePath}" points inside a world's live LevelDB (\`.../data/\`). Writing there ` +
    'over WebDAV corrupts the database. File tools are for assets only; mass DB changes are a ' +
    'separate offline job (stop → Create Backup → fvtt unpack → edit → pack → start).'
  );
}

/**
 * Heuristic: is this Data-relative path inside a world's live LevelDB store (`worlds/<w>/data/...`)?
 * Matches the `data` dir itself and anything under it. Paths must be canonicalized by toDataRelative
 * (rejects `..`) before this runs, so traversal can't evade the guard.
 */
export function looksLikeWorldDbPath(dataRelativePath: string): boolean {
  return /^worlds\/[^/]+\/data(\/|$)/i.test(dataRelativePath);
}

/** Public HTTPS URL for a path relative to `Data/` (DESIGN §6: served at the server root). */
export function buildPublicUrl(serverUrl: string, dataRelativePath: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/${dataRelativePath}`;
}

/** Friendly one-line message for a failed WebDAV op (logs the detail). */
export function davErrorMessage(tool: string, err: unknown, logger: Logger): string {
  if (err instanceof WebDavError) {
    logger.warn(`${tool} WebDAV error`, { status: err.status, message: err.message });
    return `${tool} failed: ${err.message}`;
  }
  logger.error(`${tool} unexpected error`, { error: (err as Error).message });
  return `${tool} failed: ${(err as Error).message}`;
}

/** Human-readable byte size. */
export function humanSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
