/**
 * Unit tests for the minimal WebDAV client (molten/webdav.ts).
 *
 * Two layers:
 *   1. Pure helpers — toDataRelative / guessContentType (no I/O).
 *   2. WebDavClient — global `fetch` is mocked so the request/redirect/auth
 *      logic is exercised offline. The headline case is the documented Molten
 *      gotcha: a 301 to an http:// Location must be re-issued over https WITH
 *      the Authorization header re-attached (the built-in follower would strip
 *      it on the scheme downgrade → 401).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebDavClient, WebDavError, toDataRelative, guessContentType } from './webdav.js';

const makeLogger = (): any => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child() {
    return this;
  },
});

function client() {
  return new WebDavClient({
    webdavUrl: 'https://eoh-test.webdav.moltenhosting.com/',
    user: 'foundry-ftp',
    password: 'secret',
    logger: makeLogger(),
  });
}

/** Build a minimal Response-like object for the fetch mock. */
function res(status: number, { body = '', headers = {} as Record<string, string> } = {}): any {
  return {
    status,
    statusText: `HTTP ${status}`,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

describe('toDataRelative', () => {
  it('strips leading slashes, a Data/ prefix, and trailing slashes', () => {
    expect(toDataRelative('/Data/assets/maps/x.webp/')).toBe('assets/maps/x.webp');
  });
  it('normalises backslashes to forward slashes', () => {
    expect(toDataRelative('assets\\maps\\x.webp')).toBe('assets/maps/x.webp');
  });
  it('is case-insensitive about the Data/ prefix', () => {
    expect(toDataRelative('data/foo')).toBe('foo');
  });
  it('returns empty string for the root', () => {
    expect(toDataRelative('/')).toBe('');
    expect(toDataRelative('Data/')).toBe('');
  });
  it('leaves an already-clean path unchanged', () => {
    expect(toDataRelative('worlds/w/assets/a.png')).toBe('worlds/w/assets/a.png');
  });
  it('collapses `.` and empty (`//`) segments', () => {
    expect(toDataRelative('a/./b//c')).toBe('a/b/c');
    expect(toDataRelative('worlds/w/./data/x.db')).toBe('worlds/w/data/x.db');
  });
  it('throws on a `..` traversal segment (security boundary)', () => {
    expect(() => toDataRelative('assets/../worlds/w/data/actors.db')).toThrow(WebDavError);
    expect(() => toDataRelative('../etc/passwd')).toThrow(/traversal/i);
    expect(() => toDataRelative('worlds/w/assets/../data/x.db')).toThrow(/traversal/i);
  });
});

describe('guessContentType', () => {
  it('maps common image extensions', () => {
    expect(guessContentType('a/b/c.webp')).toBe('image/webp');
    expect(guessContentType('X.PNG')).toBe('image/png');
    expect(guessContentType('photo.jpeg')).toBe('image/jpeg');
  });
  it('maps audio and video', () => {
    expect(guessContentType('track.mp3')).toBe('audio/mpeg');
    expect(guessContentType('clip.webm')).toBe('video/webm');
  });
  it('falls back to octet-stream for unknown/no extension', () => {
    expect(guessContentType('mystery.xyz')).toBe('application/octet-stream');
    expect(guessContentType('noext')).toBe('application/octet-stream');
  });
});

describe('WebDavClient request/auth/redirect', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches HTTP Basic auth and targets the /Data root', async () => {
    fetchMock.mockResolvedValueOnce(res(207, { body: '<multistatus/>' }));
    await client().stat('assets/x.webp');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://eoh-test.webdav.moltenhosting.com/Data/assets/x.webp');
    expect(init.method).toBe('PROPFIND');
    expect(init.headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('foundry-ftp:secret').toString('base64')}`
    );
    // redirects are followed manually
    expect(init.redirect).toBe('manual');
  });

  it('re-issues a 301 to http:// over https WITH auth preserved (the Molten gotcha)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        res(301, { headers: { location: 'http://eoh-test.webdav.moltenhosting.com/Data/dir/' } })
      )
      .mockResolvedValueOnce(res(207, { body: '<multistatus/>' }));
    await client().propfind('dir', '1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1][0];
    expect(secondUrl).toBe('https://eoh-test.webdav.moltenhosting.com/Data/dir/'); // forced back to https
    expect(fetchMock.mock.calls[1][1].headers.get('Authorization')).toBeTruthy();
  });

  it('stops following after 3 redirect hops', async () => {
    // Always redirect; client should give up and surface the last (redirect) response as non-207.
    fetchMock.mockResolvedValue(
      res(301, { headers: { location: 'http://eoh-test.webdav.moltenhosting.com/Data/loop/' } })
    );
    await expect(client().propfind('loop', '1')).rejects.toBeInstanceOf(WebDavError);
    // initial + 3 hops = 4 calls
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('wraps a fetch connection failure in WebDavError(status 0)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(client().stat('x')).rejects.toMatchObject({ status: 0 });
  });
});

describe('WebDavClient verbs', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('propfind returns [] on 404', async () => {
    fetchMock.mockResolvedValueOnce(res(404));
    expect(await client().propfind('nope', '1')).toEqual([]);
  });

  it('propfind parses a multistatus body into entries', async () => {
    const xml = `<?xml version="1.0"?>
      <D:multistatus xmlns:D="DAV:">
        <D:response>
          <D:href>/Data/assets/</D:href>
          <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
        </D:response>
        <D:response>
          <D:href>/Data/assets/x.webp</D:href>
          <D:propstat><D:prop>
            <D:resourcetype/>
            <D:getcontentlength>2048</D:getcontentlength>
            <D:getcontenttype>image/webp</D:getcontenttype>
          </D:prop></D:propstat>
        </D:response>
      </D:multistatus>`;
    fetchMock.mockResolvedValueOnce(res(207, { body: xml }));
    const entries = await client().propfind('assets', '1');
    expect(entries).toHaveLength(2);
    const file = entries.find(e => e.name === 'x.webp')!;
    expect(file.isCollection).toBe(false);
    expect(file.size).toBe(2048);
    expect(file.contentType).toBe('image/webp');
    expect(entries.find(e => e.path === 'assets')!.isCollection).toBe(true);
  });

  it('putFile treats 201/204/200 as success and other codes as errors', async () => {
    fetchMock.mockResolvedValueOnce(res(201));
    await expect(client().putFile('a.png', new Uint8Array([1]))).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(res(403));
    await expect(client().putFile('a.png', new Uint8Array([1]))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('mkcol treats 405 (already exists) as success', async () => {
    fetchMock.mockResolvedValueOnce(res(405));
    await expect(client().mkcol('dir')).resolves.toBeUndefined();
  });

  it('delete rejects on 404', async () => {
    fetchMock.mockResolvedValueOnce(res(404));
    await expect(client().delete('gone')).rejects.toMatchObject({ status: 404 });
  });

  it('move sends Destination + Overwrite headers', async () => {
    fetchMock.mockResolvedValueOnce(res(201));
    await client().move('a.png', 'b.png', true);
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('MOVE');
    expect(init.headers.get('Destination')).toContain('/Data/b.png');
    expect(init.headers.get('Overwrite')).toBe('T');
  });
});
