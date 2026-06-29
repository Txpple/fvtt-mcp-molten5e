/**
 * Unit tests for MoltenTools (molten/index.ts) — the Plane-B file channel.
 *
 * Focus: the SAFETY surface, which is the highest-risk code in the package.
 *   - world-DB write refusal (writing into a live LevelDB store corrupts it)
 *   - reference-aware delete/move (won't break scene/actor/journal pointers)
 *   - "not configured" behaviour when MOLTEN_WEBDAV_PASSWORD is unset
 *   - pure path mapping (asset-url / public URL) and zod validation
 *
 * The WebDavClient is mocked so no network happens; `config.molten` is mutated
 * per-test to toggle the configured/not-configured state. guessContentType and
 * the other real exports of ./webdav.js are preserved via importActual.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- mock the WebDAV client; keep the real pure helpers -------------------
const davInstance = {
  propfind: vi.fn(),
  stat: vi.fn(),
  exists: vi.fn(),
  putFile: vi.fn(),
  mkcol: vi.fn(),
  ensureParents: vi.fn(),
  delete: vi.fn(),
  move: vi.fn(),
  copy: vi.fn(),
  getFile: vi.fn(),
};
vi.mock('./webdav.js', async importActual => {
  const actual = (await importActual()) as any;
  return {
    ...actual,
    WebDavClient: vi.fn(() => davInstance),
  };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MoltenTools, joinRemote, matchesIncludeExt } from './index.js';
import { config } from '../../config.js';

const makeLogger = (): any => {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  l.child = () => l;
  return l;
};

function build(opts: { configured?: boolean; foundry?: any } = {}) {
  const { configured = true, foundry } = opts;
  config.molten.webdavPassword = configured ? 'test-password' : undefined;
  config.molten.serverUrl = 'https://eoh-test.moltenhosting.com';
  config.molten.webdavUrl = 'https://eoh-test.webdav.moltenhosting.com';
  const tools = new MoltenTools({ logger: makeLogger(), foundry });
  return tools;
}

beforeEach(() => {
  for (const fn of Object.values(davInstance)) (fn as any).mockReset();
});
afterEach(() => {
  config.molten.webdavPassword = undefined;
});

describe('getToolDefinitions', () => {
  it('exposes the ten Plane-B file tools', () => {
    const names = build()
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(
      [
        'asset-info',
        'asset-url',
        'copy-asset',
        'create-asset-folder',
        'delete-asset',
        'download-asset',
        'list-assets',
        'move-asset',
        'upload-asset',
        'upload-asset-tree',
      ].sort()
    );
  });
});

describe('joinRemote (pure — literal chars preserved, no double-encode)', () => {
  it('joins root + rel with a single slash and strips dupes', () => {
    expect(joinRemote('worlds/w/assets/tiles', 'a/b.webp')).toBe('worlds/w/assets/tiles/a/b.webp');
    expect(joinRemote('worlds/w/assets/tiles/', '/a.webp')).toBe('worlds/w/assets/tiles/a.webp');
    expect(joinRemote('root', '')).toBe('root');
  });

  it('keeps spaces / # / & LITERAL (the WebDAV client encodes once on PUT)', () => {
    const out = joinRemote('worlds/w/tom-cartos', '#48 - Throne & Hall/TC_Big Tile_10x7.webp');
    expect(out).toBe('worlds/w/tom-cartos/#48 - Throne & Hall/TC_Big Tile_10x7.webp');
    expect(out).not.toContain('%23'); // not pre-encoded → no %2520 double-encode downstream
    expect(out).not.toContain('%20');
  });

  it('normalizes backslashes in the relative path', () => {
    expect(joinRemote('root', 'sub\\file.webp')).toBe('root/sub/file.webp');
  });
});

describe('matchesIncludeExt (pure)', () => {
  it('accepts everything when the filter is omitted/empty', () => {
    expect(matchesIncludeExt('a.txt')).toBe(true);
    expect(matchesIncludeExt('a.txt', [])).toBe(true);
  });
  it('matches by extension case-insensitively, dot optional in the filter', () => {
    expect(matchesIncludeExt('Tile.WEBP', ['webp'])).toBe(true);
    expect(matchesIncludeExt('Tile.webp', ['.webp', '.png'])).toBe(true);
    expect(matchesIncludeExt('notes.txt', ['webp', 'png'])).toBe(false);
  });
});

describe('asset-url (pure mapping, no network)', () => {
  it('maps a Data-relative path to the public server-root URL', async () => {
    const out = await build().handleAssetUrl({ remotePath: 'worlds/w/maps/x.webp' });
    expect(out).toBe('https://eoh-test.moltenhosting.com/worlds/w/maps/x.webp');
  });
  it('tolerates and strips a leading Data/ prefix', async () => {
    const out = await build().handleAssetUrl({ remotePath: '/Data/assets/a.png' });
    expect(out).toBe('https://eoh-test.moltenhosting.com/assets/a.png');
  });
  it('rejects an empty remotePath', async () => {
    await expect(build().handleAssetUrl({ remotePath: '' })).rejects.toThrow();
  });
});

describe('world-DB write refusal (corruption guard)', () => {
  const DB_PATH = 'worlds/my-world/data/actors.db';

  it('upload-asset refuses a live world-DB path BEFORE any WebDAV call', async () => {
    const out = await build().handleUploadAsset({ localPath: '/tmp/x', remotePath: DB_PATH });
    expect(out).toMatch(/Refused/);
    expect(out).toMatch(/LevelDB/);
    expect(davInstance.putFile).not.toHaveBeenCalled();
  });

  it('create-asset-folder refuses a live world-DB path', async () => {
    const out = await build().handleCreateAssetFolder({ remotePath: 'worlds/w/data/sub' });
    expect(out).toMatch(/Refused/);
    expect(davInstance.mkcol).not.toHaveBeenCalled();
  });

  it('delete-asset refuses a live world-DB path', async () => {
    const out = await build().handleDeleteAsset({ remotePath: DB_PATH });
    expect(out).toMatch(/Refused/);
    expect(davInstance.delete).not.toHaveBeenCalled();
  });

  it('move-asset refuses when either endpoint is a world-DB path', async () => {
    const fromBad = await build().handleMoveAsset({ fromPath: DB_PATH, toPath: 'assets/x' });
    expect(fromBad).toMatch(/Refused/);
    const toBad = await build().handleMoveAsset({ fromPath: 'assets/x', toPath: DB_PATH });
    expect(toBad).toMatch(/Refused/);
    expect(davInstance.move).not.toHaveBeenCalled();
  });

  it('allows a normal assets path (not flagged as world-DB)', async () => {
    // assets/ under a world is fine; only `worlds/<w>/data/` is the live DB.
    davInstance.stat.mockResolvedValue(null);
    davInstance.exists.mockResolvedValue(false);
    const out = await build().handleCreateAssetFolder({
      remotePath: 'worlds/w/assets/audio',
    });
    expect(out).not.toMatch(/Refused/);
    expect(davInstance.mkcol).toHaveBeenCalled();
  });

  it('rejects a `..` traversal that would resolve into the world DB (guard cannot be bypassed)', async () => {
    // Pre-canonicalization this slipped past the `^worlds/<w>/data/` regex; now it is refused
    // outright because toDataRelative throws on the `..` segment before any WebDAV call.
    await expect(
      build().handleUploadAsset({
        localPath: '/tmp/x',
        remotePath: 'assets/../worlds/my-world/data/actors.db',
      })
    ).rejects.toThrow(/traversal/i);
    expect(davInstance.putFile).not.toHaveBeenCalled();
  });

  it('refuses the bare world-data DIRECTORY itself (worlds/<w>/data)', async () => {
    const out = await build().handleCreateAssetFolder({ remotePath: 'worlds/w/data' });
    expect(out).toMatch(/Refused/);
    expect(davInstance.mkcol).not.toHaveBeenCalled();
  });

  it('refuses a `.`-segment path that canonicalizes into the world DB', async () => {
    const out = await build().handleDeleteAsset({ remotePath: 'worlds/w/./data/actors.db' });
    expect(out).toMatch(/Refused/);
    expect(davInstance.delete).not.toHaveBeenCalled();
  });
});

describe('not-configured behaviour (no WebDAV password)', () => {
  it('list-assets returns a configuration hint and makes no WebDAV call', async () => {
    const out = await build({ configured: false }).handleListAssets({ remotePath: 'assets' });
    expect(out).toMatch(/not configured/);
    expect(out).toMatch(/MOLTEN_WEBDAV_PASSWORD/);
    expect(davInstance.propfind).not.toHaveBeenCalled();
  });
  it('upload-asset (non-DB path) still reports not-configured', async () => {
    const out = await build({ configured: false }).handleUploadAsset({
      localPath: '/tmp/x',
      remotePath: 'assets/x.png',
    });
    expect(out).toMatch(/not configured/);
  });
});

describe('reference-aware delete-asset', () => {
  it('refuses to delete a file still referenced by a document (no force)', async () => {
    davInstance.stat.mockResolvedValue({
      path: 'assets/x.png',
      name: 'x.png',
      isCollection: false,
    });
    const foundry = {
      call: vi.fn(async () => ({
        references: {
          'assets/x.png': [
            { documentType: 'Scene', documentName: 'Cave', documentId: 's1', field: 'background' },
          ],
        },
      })),
    };
    const out = await build({ foundry }).handleDeleteAsset({ remotePath: 'assets/x.png' });
    expect(out).toMatch(/still referenced/);
    expect(out).toMatch(/Scene "Cave"/);
    expect(davInstance.delete).not.toHaveBeenCalled();
  });

  it('refuses when the bridge is unavailable to verify references', async () => {
    davInstance.stat.mockResolvedValue({
      path: 'assets/x.png',
      name: 'x.png',
      isCollection: false,
    });
    // no foundry → findReferences returns checked:false
    const out = await build().handleDeleteAsset({ remotePath: 'assets/x.png' });
    expect(out).toMatch(/couldn't verify references/);
    expect(davInstance.delete).not.toHaveBeenCalled();
  });

  it('deletes when no references exist', async () => {
    davInstance.stat.mockResolvedValue({
      path: 'assets/x.png',
      name: 'x.png',
      isCollection: false,
    });
    const foundry = {
      call: vi.fn(async () => ({ references: { 'assets/x.png': [] } })),
    };
    const out = await build({ foundry }).handleDeleteAsset({ remotePath: 'assets/x.png' });
    expect(out).toMatch(/Deleted Data\/assets\/x\.png/);
    expect(davInstance.delete).toHaveBeenCalledWith('assets/x.png', false);
  });

  it('deletes with force:true without consulting references', async () => {
    davInstance.stat.mockResolvedValue({
      path: 'assets/x.png',
      name: 'x.png',
      isCollection: false,
    });
    const foundry = { call: vi.fn() };
    const out = await build({ foundry }).handleDeleteAsset({
      remotePath: 'assets/x.png',
      force: true,
    });
    expect(out).toMatch(/Deleted/);
    expect(foundry.call).not.toHaveBeenCalled();
  });

  it('refuses a directory delete unless recursive:true', async () => {
    davInstance.stat.mockResolvedValue({ path: 'assets/dir', name: 'dir', isCollection: true });
    const out = await build({ foundry: { call: vi.fn() } }).handleDeleteAsset({
      remotePath: 'assets/dir',
    });
    expect(out).toMatch(/recursive:true/);
    expect(davInstance.delete).not.toHaveBeenCalled();
  });
});

describe('upload-asset happy path', () => {
  it('rejects an empty localPath at validation', async () => {
    await expect(
      build().handleUploadAsset({ localPath: '', remotePath: 'assets/x.png' })
    ).rejects.toThrow();
  });

  it('refuses to overwrite an existing file unless overwrite:true', async () => {
    // readFile of a real-ish path: use this test file itself so readFile succeeds.
    davInstance.exists.mockResolvedValue(true);
    const out = await build().handleUploadAsset({
      localPath: __filename,
      remotePath: 'assets/x.png',
    });
    expect(out).toMatch(/already exists/);
    expect(davInstance.putFile).not.toHaveBeenCalled();
  });
});

describe('upload-asset-tree', () => {
  let root: string;
  beforeEach(() => {
    // Build a small local tree, incl. a subfolder whose name has a space + `#` + `&` (Tom's "#48 …").
    root = mkdtempSync(join(tmpdir(), 'uat-test-'));
    writeFileSync(join(root, 'a.webp'), 'A');
    writeFileSync(join(root, 'notes.txt'), 'skip me with includeExt');
    const sub = join(root, '#48 - Throne & Hall');
    mkdirSync(sub);
    writeFileSync(join(sub, 'TC_Big Tile_10x7.webp'), 'B');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('uploads every file under the root, preserving the subtree with LITERAL paths', async () => {
    davInstance.exists.mockResolvedValue(false);
    davInstance.putFile.mockResolvedValue(undefined);
    davInstance.ensureParents.mockResolvedValue(undefined);

    const out = await build().handleUploadAssetTree({
      localRoot: root,
      remoteRoot: 'worlds/w/assets/tom-cartos/tiles',
    });

    expect(out).toMatch(/Uploaded 3 file\(s\)/);
    const remotePaths = davInstance.putFile.mock.calls.map((c: any[]) => c[0]).sort();
    expect(remotePaths).toContain('worlds/w/assets/tom-cartos/tiles/a.webp');
    // the spaced/#/& subfolder path stays LITERAL (the client encodes once → no %2520)
    const nested = remotePaths.find((p: string) => p.includes('Throne'));
    expect(nested).toBe(
      'worlds/w/assets/tom-cartos/tiles/#48 - Throne & Hall/TC_Big Tile_10x7.webp'
    );
    expect(nested).not.toContain('%23');
    expect(nested).not.toContain('%20');
  });

  it('filters by includeExt (skips the .txt)', async () => {
    davInstance.exists.mockResolvedValue(false);
    davInstance.putFile.mockResolvedValue(undefined);
    const out = await build().handleUploadAssetTree({
      localRoot: root,
      remoteRoot: 'worlds/w/tiles',
      includeExt: ['webp'],
    });
    expect(out).toMatch(/Uploaded 2 file\(s\)/);
    expect(davInstance.putFile).toHaveBeenCalledTimes(2);
  });

  it('skips files that already exist unless overwrite:true', async () => {
    davInstance.exists.mockResolvedValue(true); // everything "exists"
    const out = await build().handleUploadAssetTree({
      localRoot: root,
      remoteRoot: 'worlds/w/tiles',
    });
    expect(out).toMatch(/Uploaded 0 file\(s\) → Data\/worlds\/w\/tiles \(3 skipped/);
    expect(davInstance.putFile).not.toHaveBeenCalled();
  });

  it('refuses a live world-DB remoteRoot before any upload', async () => {
    const out = await build().handleUploadAssetTree({
      localRoot: root,
      remoteRoot: 'worlds/w/data',
    });
    expect(out).toMatch(/Refused/);
    expect(davInstance.putFile).not.toHaveBeenCalled();
  });

  it('reports not-configured when no password is set', async () => {
    const out = await build({ configured: false }).handleUploadAssetTree({
      localRoot: root,
      remoteRoot: 'worlds/w/tiles',
    });
    expect(out).toMatch(/not configured/);
  });

  it('errors clearly when the local directory is missing', async () => {
    const out = await build().handleUploadAssetTree({
      localRoot: join(root, 'does-not-exist'),
      remoteRoot: 'worlds/w/tiles',
    });
    expect(out).toMatch(/Cannot read local directory/);
  });
});

describe('list-assets formatting', () => {
  it('reports not-found when PROPFIND yields nothing', async () => {
    davInstance.propfind.mockResolvedValue([]);
    const out = await build().handleListAssets({ remotePath: 'ghost' });
    expect(out).toMatch(/does not exist/);
  });

  it('lists children (folders first) with a count summary', async () => {
    davInstance.propfind.mockResolvedValue([
      { path: 'assets', name: 'assets', isCollection: true }, // the collection itself — dropped
      { path: 'assets/maps', name: 'maps', isCollection: true },
      {
        path: 'assets/a.png',
        name: 'a.png',
        isCollection: false,
        size: 1024,
        contentType: 'image/png',
      },
    ]);
    const out = await build().handleListAssets({ remotePath: 'assets' });
    expect(out).toMatch(/1 folder\(s\), 1 file\(s\)/);
    expect(out).toMatch(/\[DIR \] maps\//);
    expect(out).toMatch(/\[FILE\] a\.png/);
    expect(out).toMatch(/https:\/\/eoh-test\.moltenhosting\.com\/assets\/a\.png/);
  });
});
