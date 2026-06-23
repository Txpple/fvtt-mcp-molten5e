import { Logger } from '../../logger.js';

/**
 * Minimal, dependency-free WebDAV client for the Molten file channel.
 *
 * Molten's WebDAV endpoint is standard Apache 2.4 `mod_dav` (DAV class 1,2) behind HTTP Basic auth
 * (user `foundry-ftp`, password = the File-Manager token). The endpoint is rooted at the Foundry
 * CONTAINER root, so the Foundry data dir lives under `/Data/...`. Everything in this codebase speaks
 * "Data-relative" paths (no leading slash, no `Data/` prefix, e.g. `assets/maps/x.webp`); this client
 * maps them to `<webdavUrl>/Data/<path>`. (Verified live 2026-06-21.)
 *
 * Node 22's global `fetch` (undici) accepts the non-standard WebDAV verbs (PROPFIND/MKCOL/COPY/MOVE),
 * so no third-party WebDAV/XML dependency is pulled in. PROPFIND multistatus XML is parsed with a
 * small namespace-prefix-agnostic regex pass (Apache emits `D:`/`lp1:`/`lp2:` prefixes).
 */

export interface DavEntry {
  /** Data-relative path, e.g. `assets/maps/x.webp` (no leading slash, no `Data/` prefix). */
  path: string;
  /** Basename of the path. */
  name: string;
  isCollection: boolean;
  /** Bytes (files only). */
  size?: number;
  contentType?: string;
  /** RFC-1123 string from `getlastmodified`. */
  lastModified?: string;
}

export interface WebDavClientOptions {
  /** WebDAV host root, e.g. `https://eoh-test.webdav.moltenhosting.com`. */
  webdavUrl: string;
  user: string;
  password: string;
  logger: Logger;
  /** Per-request timeout in ms (default 30000). Guards against a half-awake box that never replies. */
  timeoutMs?: number;
}

/**
 * Per-request timeout. A Molten box that accepts the TCP socket but never responds (a half-awake
 * VM) would otherwise hang a tool indefinitely — the same cold-start failure mode the Playwright
 * bridge is explicitly budgeted against. 30s comfortably covers a real PROPFIND/PUT.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Error carrying the HTTP status of a failed WebDAV request, for friendly handler messages. */
export class WebDavError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'WebDavError';
  }
}

/** Encode each path segment but preserve the `/` separators. */
function encodePath(p: string): string {
  return p
    .split('/')
    .map(seg => encodeURIComponent(seg))
    .join('/');
}

/**
 * Canonicalize a path to the Data-relative form this codebase speaks: forward slashes, no leading
 * slash, no `Data/` prefix, no trailing slash, and — crucially — collapse `.`/empty segments and
 * REJECT any `..` segment. Rejecting traversal here is a security boundary, not just tidiness: every
 * request URL is built from this output and the world-DB write guard (looksLikeWorldDbPath) runs on
 * it, so an un-canonicalized `assets/../worlds/<w>/data/x` would otherwise slip past the guard and a
 * normalizing server would resolve it straight into the live LevelDB. No legitimate asset path needs
 * `..`, so we throw rather than silently resolve it.
 */
export function toDataRelative(p: string): string {
  const stripped = p
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^Data\//i, '')
    .replace(/^\/+/, '');
  const segments: string[] = [];
  for (const seg of stripped.split('/')) {
    if (seg === '' || seg === '.') continue; // collapse `//` and `.` segments
    if (seg === '..') {
      throw new WebDavError(`Refused: path traversal ("..") is not allowed in "${p}".`, 400);
    }
    segments.push(seg);
  }
  return segments.join('/');
}

export class WebDavClient {
  private base: string;
  private auth: string;
  private logger: Logger;
  private timeoutMs: number;

  constructor(opts: WebDavClientOptions) {
    this.base = opts.webdavUrl.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`;
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Absolute WebDAV URL for a Data-relative path (collections get a trailing slash). */
  private url(dataRelPath: string, isCollection = false): string {
    const clean = toDataRelative(dataRelPath);
    const suffix = clean.length ? `/${encodePath(clean)}` : '';
    return `${this.base}/Data${suffix}${isCollection ? '/' : ''}`;
  }

  private async request(
    method: string,
    url: string,
    init: RequestInit = {},
    hop = 0
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', this.auth);
    let res: Response;
    try {
      // Follow redirects MANUALLY: Molten's Apache is behind a TLS-terminating proxy and emits
      // self-referential 301s with an http:// scheme (e.g. a directory without a trailing slash →
      // `http://.../dir/`). The built-in follower would downgrade https→http and STRIP the
      // Authorization header → 401. We re-issue against the Location, forced back to https, with
      // auth re-attached and the method/body preserved. AbortSignal.timeout bounds each hop so a
      // half-awake box can't hang the call indefinitely.
      res = await fetch(url, {
        ...init,
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new WebDavError(
          `WebDAV ${method} timed out after ${this.timeoutMs}ms ` +
            '(the Molten box may be asleep or only half-awake; file management needs the VM live).',
          0
        );
      }
      throw new WebDavError(
        `WebDAV ${method} ${url} failed to connect: ${e.message} ` +
          '(is the Molten server awake? file management needs the VM live).',
        0
      );
    }
    if ([301, 302, 307, 308].includes(res.status) && hop < 3) {
      const loc = res.headers.get('location');
      if (loc) {
        const next = new URL(loc, url);
        next.protocol = 'https:';
        return this.request(method, next.toString(), init, hop + 1);
      }
    }
    return res;
  }

  /** PROPFIND a path; returns the entries (depth 1 includes the collection itself + its children). */
  async propfind(dataRelPath: string, depth: '0' | '1'): Promise<DavEntry[]> {
    const isCol = depth === '1';
    const res = await this.request('PROPFIND', this.url(dataRelPath, isCol), {
      headers: { Depth: depth },
    });
    if (res.status === 404) return [];
    if (res.status !== 207) {
      throw new WebDavError(
        `WebDAV PROPFIND ${dataRelPath || '(root)'} → HTTP ${res.status} ${res.statusText}`,
        res.status
      );
    }
    return parseMultistatus(await res.text());
  }

  /** PROPFIND depth 0 of a single path; null if it does not exist. */
  async stat(dataRelPath: string): Promise<DavEntry | null> {
    const entries = await this.propfind(dataRelPath, '0');
    return entries[0] ?? null;
  }

  /** Does the path exist? (cheap PROPFIND depth 0). */
  async exists(dataRelPath: string): Promise<boolean> {
    return (await this.stat(dataRelPath)) !== null;
  }

  /** PUT bytes to a file path. Caller is responsible for parent dirs (see ensureParents). */
  async putFile(dataRelPath: string, body: Uint8Array, contentType?: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (contentType) headers['Content-Type'] = contentType;
    const res = await this.request('PUT', this.url(dataRelPath), {
      body: body as BodyInit,
      headers,
    });
    // 201 Created (new) / 204 No Content (overwrite) / 200 OK are all success.
    if (![200, 201, 204].includes(res.status)) {
      throw new WebDavError(
        `WebDAV PUT ${dataRelPath} → HTTP ${res.status} ${res.statusText}`,
        res.status
      );
    }
  }

  /** Create a single collection (directory). Treats "already exists" (405) as success. */
  async mkcol(dataRelPath: string): Promise<void> {
    const res = await this.request('MKCOL', this.url(dataRelPath, true));
    if (res.status === 201 || res.status === 405) return; // 405 = already a collection
    throw new WebDavError(
      `WebDAV MKCOL ${dataRelPath} → HTTP ${res.status} ${res.statusText}`,
      res.status
    );
  }

  /** MKCOL every missing parent collection of a file/dir path (Apache has no recursive MKCOL). */
  async ensureParents(dataRelPath: string): Promise<void> {
    const clean = toDataRelative(dataRelPath);
    const parts = clean.split('/').slice(0, -1); // drop the leaf (the file/dir being created)
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (!(await this.exists(prefix))) {
        await this.mkcol(prefix);
      }
    }
  }

  /** DELETE a file or (with isCollection) a directory. 404 → throws WebDavError(404). */
  async delete(dataRelPath: string, isCollection = false): Promise<void> {
    const res = await this.request('DELETE', this.url(dataRelPath, isCollection));
    if (![200, 204, 207].includes(res.status)) {
      throw new WebDavError(
        `WebDAV DELETE ${dataRelPath} → HTTP ${res.status} ${res.statusText}`,
        res.status
      );
    }
  }

  /** MOVE (rename) a file/dir to a new Data-relative path. */
  async move(
    fromRel: string,
    toRel: string,
    overwrite: boolean,
    isCollection = false
  ): Promise<void> {
    const res = await this.request('MOVE', this.url(fromRel, isCollection), {
      headers: { Destination: this.url(toRel, isCollection), Overwrite: overwrite ? 'T' : 'F' },
    });
    if (![201, 204].includes(res.status)) {
      throw new WebDavError(
        `WebDAV MOVE ${fromRel} → ${toRel}: HTTP ${res.status} ${res.statusText}`,
        res.status
      );
    }
  }

  /** COPY a file/dir to a new Data-relative path. */
  async copy(
    fromRel: string,
    toRel: string,
    overwrite: boolean,
    isCollection = false
  ): Promise<void> {
    const res = await this.request('COPY', this.url(fromRel, isCollection), {
      headers: { Destination: this.url(toRel, isCollection), Overwrite: overwrite ? 'T' : 'F' },
    });
    if (![201, 204].includes(res.status)) {
      throw new WebDavError(
        `WebDAV COPY ${fromRel} → ${toRel}: HTTP ${res.status} ${res.statusText}`,
        res.status
      );
    }
  }

  /** GET a file's bytes. */
  async getFile(dataRelPath: string): Promise<Uint8Array> {
    const res = await this.request('GET', this.url(dataRelPath));
    if (res.status !== 200) {
      throw new WebDavError(
        `WebDAV GET ${dataRelPath} → HTTP ${res.status} ${res.statusText}`,
        res.status
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Parse a WebDAV multistatus body into DavEntry[] (prefix-agnostic). */
function parseMultistatus(xml: string): DavEntry[] {
  const out: DavEntry[] = [];
  const responses = xml.match(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi) ?? [];
  for (const block of responses) {
    const hrefMatch = block.match(/<(?:\w+:)?href>\s*([^<]*?)\s*<\/(?:\w+:)?href>/i);
    if (!hrefMatch) continue;
    let href: string;
    try {
      href = decodeURIComponent(hrefMatch[1]);
    } catch {
      href = hrefMatch[1];
    }
    const isCollection = /<(?:\w+:)?resourcetype>[\s\S]*?<(?:\w+:)?collection\s*\/?>/i.test(block);
    let path: string;
    try {
      path = toDataRelative(href);
    } catch {
      continue; // a server href with a `..` segment is pathological — skip it rather than fail the listing
    }
    const name = path.split('/').filter(Boolean).pop() ?? '';

    const sizeMatch = block.match(/<(?:\w+:)?getcontentlength>\s*(\d+)\s*</i);
    const typeMatch = block.match(/<(?:\w+:)?getcontenttype>\s*([^<]+?)\s*</i);
    const mtimeMatch = block.match(/<(?:\w+:)?getlastmodified>\s*([^<]+?)\s*</i);

    const entry: DavEntry = { path, name, isCollection };
    if (sizeMatch) entry.size = parseInt(sizeMatch[1], 10);
    if (typeMatch) entry.contentType = typeMatch[1];
    if (mtimeMatch) entry.lastModified = mtimeMatch[1];
    out.push(entry);
  }
  return out;
}

/** Best-effort Content-Type from a file extension (asset-oriented). */
export function guessContentType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    bmp: 'image/bmp',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    webm: 'video/webm',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    json: 'application/json',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    pdf: 'application/pdf',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
  };
  return map[ext] ?? 'application/octet-stream';
}
