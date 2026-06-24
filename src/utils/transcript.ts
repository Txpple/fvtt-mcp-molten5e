// Node-side helper for export-chat-log: validate the export destination(s).
// Kept out of the tool handler so it can be unit-tested without a bridge.

import { isAbsolute } from 'node:path';

export interface ExportDestinations {
  localPath?: string;
  remotePath?: string;
}

export type DestinationCheck = { ok: true } | { ok: false; error: string };

/**
 * Require at least one destination, and require any local path to be absolute (mirrors the
 * download-asset contract — relative local writes land in an unpredictable CWD).
 */
export function validateExportDestinations(d: ExportDestinations): DestinationCheck {
  if (!d.localPath && !d.remotePath) {
    return { ok: false, error: 'provide localPath, remotePath, or both.' };
  }
  if (d.localPath && !isAbsolute(d.localPath)) {
    return { ok: false, error: `localPath must be an absolute path (got "${d.localPath}").` };
  }
  return { ok: true };
}
