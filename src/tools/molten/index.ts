import { z } from 'zod';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { Logger } from '../../logger.js';
import { config } from '../../config.js';
import type { MoltenConfig } from '../../config.js';
import type { FoundryBridge } from '../../foundry.js';
import { WebDavClient, guessContentType, toDataRelative, type DavEntry } from './webdav.js';
import {
  makeDavClient,
  buildPublicUrl as davPublicUrl,
  notConfiguredMessage,
  worldDbRefusal as davWorldDbRefusal,
  looksLikeWorldDbPath as davLooksLikeWorldDbPath,
  davErrorMessage as davError,
  humanSize,
} from './dav-access.js';
import { toInputSchema } from '../../utils/schema.js';

/**
 * Plane-B — Molten Hosting file tools (the asset-management library, Groups A/B).
 *
 * These talk to Molten's file channel directly (WebDAV / public HTTPS) — NOT to the Foundry bridge —
 * so they take only config + logger. (The old host-lifecycle tools `wake-server`/`sleep-watch`/
 * `keep-awake` were removed: the operator only ever drives the bridge while the server is already up.)
 *
 * GROUPS:
 *  - A (discover, read-only): `asset-url` (pure mapping), `list-assets`, `asset-info`, `download-asset`.
 *  - B (manage files, write): `upload-asset`, `create-asset-folder`. (delete/move/copy land in a later
 *    phase, wired to bridge-side reference-checking so they can't silently break the game.)
 *
 * WebDAV is standard Apache `mod_dav` + HTTP Basic auth (user `foundry-ftp`, password =
 * MOLTEN_WEBDAV_PASSWORD); see ./webdav.ts. Write tools no-op with a clear message when the password
 * is unset.
 *
 * HARD SAFETY RULES baked in (DESIGN §3/§5/§6):
 *  - The live world DB (LevelDB under `Data/worlds/<world>/data/`) is UNTOUCHABLE via the file channel
 *    while the server runs — WebDAV writes there corrupt it permanently. Write tools REFUSE such paths.
 *    Mass DB ops are a separate offline job (stop → Create Backup → fvtt unpack → edit → pack → start).
 *  - Anything under `Data/` is served PUBLICLY over HTTPS with no auth → privacy caveat surfaced on
 *    upload: never put anything sensitive under `Data/`.
 */

interface MoltenToolsOptions {
  logger: Logger;
  /**
   * Optional bridge client. When present, the destructive file tools (delete/move-asset) consult
   * find-asset-references first so they don't silently break the game; when absent (or the bridge is
   * down), they refuse unless `force` is set.
   */
  foundry?: FoundryBridge;
}

// Single source of truth for each tool's input contract: the handler parses with these schemas and
// getToolDefinitions() advertises toInputSchema(...) of the same schema.

const ListAssetsSchema = z.object({
  remotePath: z
    .string()
    .default('')
    .describe(
      'Directory path relative to the Foundry `Data/` root (a leading "Data/" or "/" is ' +
        'tolerated). Omit or "" for the Data/ root, e.g. "assets" or "worlds/your-world".'
    ),
});

const AssetInfoSchema = z.object({
  remotePath: z
    .string()
    .min(1)
    .describe(
      'Path relative to the Foundry `Data/` root, e.g. ' +
        '"worlds/your-world/assets/maps/cavern.webp".'
    ),
});

const DownloadAssetSchema = z.object({
  remotePath: z.string().min(1).describe('Source path relative to the Foundry `Data/` root.'),
  localPath: z
    .string()
    .min(1)
    .describe('Absolute local destination path. Parent directories are created if missing.'),
});

const UploadAssetSchema = z.object({
  localPath: z.string().min(1).describe('Absolute path to the local file to upload.'),
  remotePath: z
    .string()
    .min(1)
    .describe(
      'Destination path RELATIVE TO the Foundry `Data/` root, e.g. ' +
        '"worlds/your-world/assets/maps/cavern.webp". Must be an asset location, never ' +
        "inside a world's `data/` (LevelDB) directory."
    ),
  overwrite: z
    .boolean()
    .default(false)
    .describe('Allow overwriting an existing file at remotePath.'),
});

const UploadAssetTreeSchema = z.object({
  localRoot: z
    .string()
    .min(1)
    .describe('Absolute path to a LOCAL directory; every file under it (recursive) is uploaded.'),
  remoteRoot: z
    .string()
    .min(1)
    .describe(
      'Destination directory RELATIVE TO the Foundry `Data/` root, e.g. ' +
        '"worlds/your-world/assets/tom-cartos/<id>/tiles". Each local file lands at ' +
        "remoteRoot/<path-relative-to-localRoot>. Never inside a world's `data/` (LevelDB) dir."
    ),
  overwrite: z
    .boolean()
    .default(false)
    .describe('Overwrite existing files (otherwise an already-present file is skipped).'),
  includeExt: z
    .array(z.string())
    .optional()
    .describe(
      'Only upload files with these extensions (no dot, case-insensitive), e.g. ' +
        '["webp","png","jpg"]. Omit to upload every file.'
    ),
});

const CreateAssetFolderSchema = z.object({
  remotePath: z
    .string()
    .min(1)
    .describe(
      'Folder path relative to the Foundry `Data/` root, e.g. ' +
        '"worlds/your-world/assets/audio/tavern".'
    ),
});

const DeleteAssetSchema = z.object({
  remotePath: z.string().min(1).describe('Path relative to the Foundry `Data/` root to delete.'),
  recursive: z
    .boolean()
    .default(false)
    .describe('Required to delete a directory (and everything under it).'),
  force: z
    .boolean()
    .default(false)
    .describe('Delete even if references exist or the bridge is unavailable to check them.'),
});

const MoveAssetSchema = z.object({
  fromPath: z.string().min(1).describe('Current Data-relative path.'),
  toPath: z.string().min(1).describe('New Data-relative path.'),
  overwrite: z
    .boolean()
    .default(false)
    .describe('Allow overwriting an existing file at the destination.'),
  relink: z
    .boolean()
    .default(false)
    .describe('After moving, rewrite all references from the old path to the new one.'),
  force: z
    .boolean()
    .default(false)
    .describe('Move even if references exist (without relinking) or the bridge is down.'),
});

const CopyAssetSchema = z.object({
  fromPath: z.string().min(1).describe('Source Data-relative path.'),
  toPath: z.string().min(1).describe('Destination Data-relative path.'),
  overwrite: z
    .boolean()
    .default(false)
    .describe('Allow overwriting an existing file at the destination.'),
});

const AssetUrlSchema = z.object({
  remotePath: z
    .string()
    .min(1)
    .describe(
      'Path relative to the Foundry `Data/` root (a leading "Data/" or "/" is tolerated ' +
        'and stripped), e.g. "worlds/your-world/assets/maps/cavern.webp".'
    ),
});

/**
 * Join a Data-relative remote root with a forward-slash relative path. LITERAL chars (spaces, `#`,
 * `&`, apostrophes) are PRESERVED — the WebDAV client encodes each segment exactly once on PUT, so
 * passing already-encoded text here would double-encode (`%20`→`%2520`). Pure/exported for testing.
 */
export function joinRemote(remoteRoot: string, rel: string): string {
  const root = remoteRoot.replace(/\/+$/, '');
  const cleanRel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  return cleanRel ? `${root}/${cleanRel}` : root;
}

/** Does a filename's extension match the includeExt filter? (undefined/empty = accept all.) */
export function matchesIncludeExt(name: string, includeExt?: string[]): boolean {
  if (!includeExt || includeExt.length === 0) return true;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return includeExt.some(e => e.toLowerCase().replace(/^\./, '') === ext);
}

export class MoltenTools {
  private logger: Logger;
  private molten: MoltenConfig;
  private foundry: FoundryBridge | undefined;
  private davClient: WebDavClient | null = null;

  constructor(options: MoltenToolsOptions) {
    this.logger = options.logger;
    this.molten = config.molten;
    this.foundry = options.foundry;
  }

  getToolDefinitions() {
    return [
      {
        name: 'list-assets',
        description:
          'Plane B (file channel, read-only). List the immediate contents of a directory under the ' +
          'Foundry `Data/` root over WebDAV (folders + files, with size / type / public URL). Use to ' +
          'browse uploaded assets, e.g. `worlds/your-world/assets/audio`. Empty/omitted path lists the ' +
          '`Data/` root.',
        inputSchema: toInputSchema(ListAssetsSchema),
      },
      {
        name: 'asset-info',
        description:
          'Plane B (file channel, read-only). Report whether a single path under the Foundry `Data/` ' +
          'root exists, and (for files) its size, content-type, last-modified, and public HTTPS URL. ' +
          'A cheap existence/metadata check before uploading or linking.',
        inputSchema: toInputSchema(AssetInfoSchema),
      },
      {
        name: 'download-asset',
        description:
          'Plane B (file channel, read-only). Download a file from under the Foundry `Data/` root ' +
          '(over WebDAV) to a local path on this machine. For grabbing an existing asset to inspect ' +
          'or re-process.',
        inputSchema: toInputSchema(DownloadAssetSchema),
      },
      {
        name: 'upload-asset',
        description:
          'Plane B (file channel, write). Upload an ASSET (map/token/audio/handout image) from a ' +
          'local file to the Foundry data area over WebDAV and return its public HTTPS URL, so large ' +
          'media bypass the bridge entirely. Missing parent folders are created automatically. ' +
          'ASSETS ONLY — never world-DB files (LevelDB writes while the server runs corrupt it; such ' +
          'paths are refused). PRIVACY: anything under Data/ is served publicly with no auth — do not ' +
          'upload anything sensitive. Requires MOLTEN_WEBDAV_PASSWORD.',
        inputSchema: toInputSchema(UploadAssetSchema),
      },
      {
        name: 'upload-asset-tree',
        description:
          'Plane B (file channel, write). Recursively upload a LOCAL directory tree of ASSETS to ' +
          'the Foundry data area over WebDAV, preserving the subtree layout (each file → ' +
          'remoteRoot/<rel>), creating parent folders as needed. Use for BULK imports — a scene ' +
          "pack's images, a tiles folder — instead of one upload-asset per file. Skips files that " +
          'already exist unless overwrite:true; optional includeExt filter (e.g. ["webp"]). ASSETS ' +
          'ONLY — refuses live world-DB paths. Reports uploaded/skipped/error counts. PRIVACY: ' +
          'anything under Data/ is served publicly with no auth. Requires MOLTEN_WEBDAV_PASSWORD.',
        inputSchema: toInputSchema(UploadAssetTreeSchema),
      },
      {
        name: 'create-asset-folder',
        description:
          'Plane B (file channel, write). Create a folder (and any missing parents) under the ' +
          'Foundry `Data/` root over WebDAV. Idempotent — succeeds if the folder already exists. ' +
          'Refuses paths inside a live world DB. Requires MOLTEN_WEBDAV_PASSWORD.',
        inputSchema: toInputSchema(CreateAssetFolderSchema),
      },
      {
        name: 'delete-asset',
        description:
          'Plane B (file channel, write). Delete a file under the Foundry `Data/` root over WebDAV. ' +
          'REFERENCE-AWARE: consults find-asset-references first and REFUSES if any scene/actor/' +
          'journal/playlist still points at it (pass force:true to override). Deleting a directory ' +
          'requires recursive:true. Refuses live world-DB paths. Requires MOLTEN_WEBDAV_PASSWORD.',
        inputSchema: toInputSchema(DeleteAssetSchema),
      },
      {
        name: 'move-asset',
        description:
          'Plane B (file channel, write). Move/rename a file under the Foundry `Data/` root over ' +
          'WebDAV. REFERENCE-AWARE: by default REFUSES with a report if anything references the ' +
          'source (moving would break those pointers). Pass relink:true to move AND rewrite all ' +
          'references (old→new), or force:true to move without relinking. Refuses live world-DB ' +
          'paths. Requires MOLTEN_WEBDAV_PASSWORD.',
        inputSchema: toInputSchema(MoveAssetSchema),
      },
      {
        name: 'copy-asset',
        description:
          'Plane B (file channel, write). Copy a file under the Foundry `Data/` root over WebDAV. ' +
          '(Copying does not affect existing references, so no reference check is needed.) Refuses ' +
          'live world-DB destination paths. Requires MOLTEN_WEBDAV_PASSWORD.',
        inputSchema: toInputSchema(CopyAssetSchema),
      },
      {
        name: 'asset-url',
        description:
          'Plane B (file channel). Return the public HTTPS URL for a file under the Foundry `Data/` ' +
          'root. Pure mapping (no network): everything under Data/ is served at the server root ' +
          '(DESIGN §6), e.g. Data/worlds/w/maps/x.jpg → <serverUrl>/worlds/w/maps/x.jpg. Useful for ' +
          'turning an uploaded/known asset path into a link Foundry or a player can load.',
        inputSchema: toInputSchema(AssetUrlSchema),
      },
    ];
  }

  // --- handlers -------------------------------------------------------------

  async handleListAssets(args: any): Promise<string> {
    const { remotePath } = ListAssetsSchema.parse(args ?? {});
    const clean = toDataRelative(remotePath);

    const dav = this.dav();
    if (!dav) return this.notConfigured('list-assets');

    try {
      const entries = await dav.propfind(clean, '1');
      if (entries.length === 0) {
        return `Not found: "Data/${clean}" does not exist (or is not a directory).`;
      }
      // Depth-1 PROPFIND includes the collection itself first — drop it; keep children.
      const children = entries.filter(e => e.path !== clean);
      if (children.length === 0) {
        return `Data/${clean || '(root)'} is empty.`;
      }
      children.sort((a, b) => {
        if (a.isCollection !== b.isCollection) return a.isCollection ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const lines = children.map(e => this.formatEntryLine(e));
      const dirs = children.filter(e => e.isCollection).length;
      const files = children.length - dirs;
      return `Data/${clean || '(root)'} — ${dirs} folder(s), ${files} file(s):\n${lines.join('\n')}`;
    } catch (err) {
      return this.davErrorMessage('list-assets', err);
    }
  }

  async handleAssetInfo(args: any): Promise<string> {
    const { remotePath } = AssetInfoSchema.parse(args ?? {});
    const clean = toDataRelative(remotePath);

    const dav = this.dav();
    if (!dav) return this.notConfigured('asset-info');

    try {
      const entry = await dav.stat(clean);
      if (!entry) return `Does not exist: "Data/${clean}".`;
      if (entry.isCollection) {
        return `Data/${clean} — FOLDER${entry.lastModified ? ` (modified ${entry.lastModified})` : ''}.`;
      }
      const parts = [
        `Data/${clean} — FILE`,
        entry.size !== undefined ? `size ${humanSize(entry.size)} (${entry.size} B)` : null,
        entry.contentType ? `type ${entry.contentType}` : null,
        entry.lastModified ? `modified ${entry.lastModified}` : null,
        `public URL: ${this.buildPublicUrl(clean)}`,
      ].filter(Boolean);
      return parts.join('\n  ');
    } catch (err) {
      return this.davErrorMessage('asset-info', err);
    }
  }

  async handleDownloadAsset(args: any): Promise<string> {
    const { remotePath, localPath } = DownloadAssetSchema.parse(args ?? {});
    const clean = toDataRelative(remotePath);

    const dav = this.dav();
    if (!dav) return this.notConfigured('download-asset');

    try {
      const bytes = await dav.getFile(clean);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, bytes);
      this.logger.info('download-asset', { remotePath: clean, localPath, bytes: bytes.length });
      return `Downloaded Data/${clean} → "${localPath}" (${humanSize(bytes.length)}, ${bytes.length} B).`;
    } catch (err) {
      return this.davErrorMessage('download-asset', err);
    }
  }

  async handleUploadAsset(args: any): Promise<string> {
    const { localPath, remotePath, overwrite } = UploadAssetSchema.parse(args ?? {});
    const clean = toDataRelative(remotePath);

    // Guard against the cardinal Plane-B sin: writing into a live world's LevelDB store.
    if (this.looksLikeWorldDbPath(clean)) {
      return this.worldDbRefusal(remotePath);
    }

    const dav = this.dav();
    if (!dav) return this.notConfigured('upload-asset');

    let bytes: Uint8Array;
    try {
      bytes = await readFile(localPath);
    } catch (err) {
      return `Cannot read local file "${localPath}": ${(err as Error).message}`;
    }

    try {
      if (!overwrite && (await dav.exists(clean))) {
        return (
          `Refused: "Data/${clean}" already exists. Pass overwrite:true to replace it ` +
          '(or choose a different remotePath).'
        );
      }
      await dav.ensureParents(clean);
      await dav.putFile(clean, bytes, guessContentType(localPath));
      const publicUrl = this.buildPublicUrl(clean);
      this.logger.info('upload-asset', { localPath, remotePath: clean, bytes: bytes.length });
      return (
        `Uploaded "${localPath}" (${humanSize(bytes.length)}) → Data/${clean}.\n` +
        `  Data-relative path: ${clean}\n` +
        `  Public URL: ${publicUrl}\n` +
        '  NOTE: this URL is publicly accessible with no auth — do not upload anything sensitive.'
      );
    } catch (err) {
      return this.davErrorMessage('upload-asset', err);
    }
  }

  async handleUploadAssetTree(args: any): Promise<string> {
    const { localRoot, remoteRoot, overwrite, includeExt } = UploadAssetTreeSchema.parse(
      args ?? {}
    );
    const root = toDataRelative(remoteRoot);

    // The root guard covers the whole subtree (every leaf is remoteRoot/<rel>, no `..`).
    if (this.looksLikeWorldDbPath(root)) return this.worldDbRefusal(remoteRoot);

    const dav = this.dav();
    if (!dav) return this.notConfigured('upload-asset-tree');

    // Enumerate local files (recursive). A missing/non-directory localRoot is a clear up-front error.
    let files: string[];
    try {
      const entries = await readdir(localRoot, { recursive: true, withFileTypes: true });
      files = entries
        .filter(e => e.isFile() && matchesIncludeExt(e.name, includeExt))
        // Dirent.parentPath (Node 20.12+); fall back to the deprecated .path for safety.
        .map(e => join((e as any).parentPath ?? (e as any).path, e.name));
    } catch (err) {
      return `Cannot read local directory "${localRoot}": ${(err as Error).message}`;
    }

    if (files.length === 0) {
      const filt = includeExt?.length ? ` matching {${includeExt.join(', ')}}` : '';
      return `No files${filt} found under "${localRoot}".`;
    }

    let uploaded = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const localPath of files) {
      // rel is always a forward descent under localRoot — pass LITERAL chars; the dav client encodes once.
      const rel = relative(localRoot, localPath)
        .split(/[/\\]+/)
        .join('/');
      const remote = joinRemote(root, rel);
      try {
        if (!overwrite && (await dav.exists(remote))) {
          skipped++;
          continue;
        }
        const bytes = await readFile(localPath);
        await dav.ensureParents(remote);
        await dav.putFile(remote, bytes, guessContentType(localPath));
        uploaded++;
      } catch (err) {
        errors.push(`${rel}: ${(err as Error).message}`);
      }
    }

    this.logger.info('upload-asset-tree', {
      localRoot,
      remoteRoot: root,
      uploaded,
      skipped,
      errors: errors.length,
    });
    const lines = [
      `Uploaded ${uploaded} file(s) → Data/${root} (${skipped} skipped, ${errors.length} error(s)).`,
      `  Public root: ${this.buildPublicUrl(root)}`,
      '  NOTE: anything under Data/ is publicly accessible with no auth — do not upload anything sensitive.',
    ];
    for (const e of errors.slice(0, 20)) lines.push(`  ⚠ ${e}`);
    if (errors.length > 20) lines.push(`  …and ${errors.length - 20} more error(s)`);
    return lines.join('\n');
  }

  async handleCreateAssetFolder(args: any): Promise<string> {
    const { remotePath } = CreateAssetFolderSchema.parse(args ?? {});
    const clean = toDataRelative(remotePath);

    if (this.looksLikeWorldDbPath(clean)) {
      return this.worldDbRefusal(remotePath);
    }

    const dav = this.dav();
    if (!dav) return this.notConfigured('create-asset-folder');

    try {
      const existing = await dav.stat(clean);
      if (existing) {
        if (existing.isCollection) return `Already exists: folder Data/${clean}.`;
        return `Refused: "Data/${clean}" already exists as a FILE, not a folder.`;
      }
      await dav.ensureParents(clean); // create any missing parents above the target
      await dav.mkcol(clean); // then the target folder itself
      this.logger.info('create-asset-folder', { remotePath: clean });
      return `Created folder Data/${clean}.`;
    } catch (err) {
      return this.davErrorMessage('create-asset-folder', err);
    }
  }

  async handleDeleteAsset(args: any): Promise<string> {
    const { remotePath, recursive, force } = DeleteAssetSchema.parse(args ?? {});
    const clean = toDataRelative(remotePath);

    if (this.looksLikeWorldDbPath(clean)) return this.worldDbRefusal(remotePath);
    const dav = this.dav();
    if (!dav) return this.notConfigured('delete-asset');

    try {
      const entry = await dav.stat(clean);
      if (!entry) return `Nothing to delete: "Data/${clean}" does not exist.`;

      if (entry.isCollection && !recursive) {
        return (
          `Refused: "Data/${clean}" is a directory. Pass recursive:true to delete it and everything ` +
          'inside (deliberately not the default).'
        );
      }

      if (!force) {
        if (entry.isCollection) {
          return (
            `Refused: directory deletes can't be reference-checked per-file. Re-run with force:true ` +
            'if you are sure nothing in it is still used by a scene/actor/journal/playlist.'
          );
        }
        const { refs, checked } = await this.findReferences(clean);
        if (!checked) {
          return (
            `Refused: couldn't verify references for "Data/${clean}" (the Foundry bridge isn't ` +
            'connected). Open the world, or pass force:true to delete without checking.'
          );
        }
        if (refs.length > 0) {
          return `Refused: "Data/${clean}" is still referenced by ${refs.length} document(s):\n${this.formatRefs(
            refs
          )}\nRelink or remove those first, or pass force:true to delete anyway.`;
        }
      }

      await dav.delete(clean, entry.isCollection);
      this.logger.info('delete-asset', { remotePath: clean, recursive, force });
      return `Deleted Data/${clean}${entry.isCollection ? ' (directory)' : ''}.`;
    } catch (err) {
      return this.davErrorMessage('delete-asset', err);
    }
  }

  async handleMoveAsset(args: any): Promise<string> {
    const { fromPath, toPath, overwrite, relink, force } = MoveAssetSchema.parse(args ?? {});
    const cleanFrom = toDataRelative(fromPath);
    const cleanTo = toDataRelative(toPath);

    if (this.looksLikeWorldDbPath(cleanFrom)) return this.worldDbRefusal(fromPath);
    if (this.looksLikeWorldDbPath(cleanTo)) return this.worldDbRefusal(toPath);
    const dav = this.dav();
    if (!dav) return this.notConfigured('move-asset');

    try {
      const entry = await dav.stat(cleanFrom);
      if (!entry) return `Nothing to move: "Data/${cleanFrom}" does not exist.`;
      if (!overwrite && (await dav.exists(cleanTo))) {
        return `Refused: "Data/${cleanTo}" already exists. Pass overwrite:true to replace it.`;
      }

      let refs: any[] = [];
      if (entry.isCollection) {
        if (!force) {
          return (
            `Refused: directory moves can't be reference-checked per-file. Re-run with force:true ` +
            '(then relink any affected references manually).'
          );
        }
      } else {
        const check = await this.findReferences(cleanFrom);
        refs = check.refs;
        if (!force && !relink) {
          if (!check.checked) {
            return (
              `Refused: couldn't verify references for "Data/${cleanFrom}" (bridge not connected). ` +
              'Pass relink:true (to move + rewrite once the world is open) or force:true (move only).'
            );
          }
          if (refs.length > 0) {
            return (
              `Refused: "Data/${cleanFrom}" is referenced by ${refs.length} document(s) — moving ` +
              `would break them:\n${this.formatRefs(refs)}\n` +
              'Re-run with relink:true to move AND fix the references, or force:true to move anyway.'
            );
          }
        }
      }

      await dav.move(cleanFrom, cleanTo, overwrite, entry.isCollection);
      this.logger.info('move-asset', { fromPath: cleanFrom, toPath: cleanTo, relink, force });

      let relinkNote = '';
      if (relink && !entry.isCollection && this.foundry) {
        try {
          const r = await this.foundry.call('relinkAsset', {
            oldPath: cleanFrom,
            newPath: cleanTo,
          });
          relinkNote = `\nRelinked ${r?.changedCount ?? 0} reference(s).`;
        } catch (err) {
          relinkNote = `\nWARNING: move succeeded but relink failed (${(err as Error).message}). References may be broken — run relink-asset manually.`;
        }
      }
      return `Moved Data/${cleanFrom} → Data/${cleanTo}.${relinkNote}`;
    } catch (err) {
      return this.davErrorMessage('move-asset', err);
    }
  }

  async handleCopyAsset(args: any): Promise<string> {
    const { fromPath, toPath, overwrite } = CopyAssetSchema.parse(args ?? {});
    const cleanFrom = toDataRelative(fromPath);
    const cleanTo = toDataRelative(toPath);

    // Guard BOTH ends: a live world's LevelDB must not be read or written over the file channel.
    if (this.looksLikeWorldDbPath(cleanFrom)) return this.worldDbRefusal(fromPath);
    if (this.looksLikeWorldDbPath(cleanTo)) return this.worldDbRefusal(toPath);
    const dav = this.dav();
    if (!dav) return this.notConfigured('copy-asset');

    try {
      const entry = await dav.stat(cleanFrom);
      if (!entry) return `Nothing to copy: "Data/${cleanFrom}" does not exist.`;
      if (!overwrite && (await dav.exists(cleanTo))) {
        return `Refused: "Data/${cleanTo}" already exists. Pass overwrite:true to replace it.`;
      }
      await dav.copy(cleanFrom, cleanTo, overwrite, entry.isCollection);
      this.logger.info('copy-asset', { fromPath: cleanFrom, toPath: cleanTo });
      return `Copied Data/${cleanFrom} → Data/${cleanTo}.`;
    } catch (err) {
      return this.davErrorMessage('copy-asset', err);
    }
  }

  /** Fully implemented — pure mapping, no network. */
  async handleAssetUrl(args: any): Promise<string> {
    const { remotePath } = AssetUrlSchema.parse(args ?? {});
    return this.buildPublicUrl(toDataRelative(remotePath));
  }

  // --- helpers --------------------------------------------------------------

  /** Lazily build the WebDAV client; null when no password is configured. */
  private dav(): WebDavClient | null {
    if (!this.davClient) this.davClient = makeDavClient(this.molten, this.logger);
    return this.davClient;
  }

  private notConfigured(tool: string): string {
    return notConfiguredMessage(tool, this.molten.webdavUser);
  }

  private worldDbRefusal(remotePath: string): string {
    return davWorldDbRefusal(remotePath);
  }

  private davErrorMessage(tool: string, err: unknown): string {
    return davError(tool, err, this.logger);
  }

  /** Ask the bridge what references an asset path. `checked:false` = bridge unavailable. */
  private async findReferences(dataRelPath: string): Promise<{ refs: any[]; checked: boolean }> {
    if (!this.foundry) return { refs: [], checked: false };
    try {
      const result = await this.foundry.call('findAssetReferences', {
        paths: [dataRelPath],
      });
      return { refs: result?.references?.[dataRelPath] ?? [], checked: true };
    } catch (err) {
      this.logger.warn('reference check failed (bridge down?)', { error: (err as Error).message });
      return { refs: [], checked: false };
    }
  }

  private formatRefs(refs: any[]): string {
    return refs
      .map(r => `    - ${r.documentType} "${r.documentName}" (${r.documentId}) :: ${r.field}`)
      .join('\n');
  }

  private formatEntryLine(e: DavEntry): string {
    if (e.isCollection) return `  [DIR ] ${e.name}/`;
    const meta = [humanSize(e.size), e.contentType].filter(Boolean).join(', ');
    return `  [FILE] ${e.name}${meta ? `  (${meta})` : ''}  → ${this.buildPublicUrl(e.path)}`;
  }

  /** Public HTTPS URL for a path relative to `Data/` (DESIGN §6: served at the server root). */
  private buildPublicUrl(dataRelativePath: string): string {
    return davPublicUrl(this.molten.serverUrl, dataRelativePath);
  }

  /** Heuristic: is this path inside a world's live LevelDB store (`worlds/<w>/data/...`)? */
  private looksLikeWorldDbPath(dataRelativePath: string): boolean {
    return davLooksLikeWorldDbPath(dataRelativePath);
  }
}
