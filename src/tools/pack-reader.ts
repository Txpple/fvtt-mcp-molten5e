import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';

// ---------------------------------------------------------------------------
// read-pack — the deterministic "tool does" half of the tom-cartos-import skill
// (design.md §2.1 "skills decide, tools do"; build plan docs/tom-cartos-import-plan.md §6.1).
//
// It reads a Tom-Cartos-style Foundry SCENE-PACK MODULE off disk — a `module.json` + LevelDB/NeDB
// compendium packs — and returns era-normalized documents the create-scene/journal tools consume.
// It is Node-only and OFF-LINE: it never touches the headless Foundry page (the packs are files,
// not live documents). Per DECISION A (docs/…-plan.md), the LevelDB/NeDB read is delegated to
// `@foundryvtt/foundryvtt-cli`'s `extractPack` run in a CHILD node process, so the native
// `classic-level` binding never loads in this server's own process — only in the throwaway child.
//
// What it owns (correctness): unpack → JSON, era detection, artifact stripping, and (given a dest
// root the SKILL chooses) the asset path-rewrite hints. What it does NOT own (judgment, → the skill):
// which variant to import, naming/foldering, the asset destination, the legend→notes opt-in.
// ---------------------------------------------------------------------------

const ReadPackSchema = z.object({
  modulePath: z
    .string()
    .min(1)
    .describe('Absolute path to the unzipped module folder OR directly to its module.json.'),
  destRoot: z
    .string()
    .optional()
    .describe(
      'Data-relative asset destination root the skill chose (e.g. ' +
        '"worlds/<world>/assets/tom-cartos/<module-id>"). When set, every referenced asset gets a ' +
        '`dataPath` rewrite hint (modules/<id>/<rel> → <destRoot>/<rel>, percent-decoded) so the ' +
        'create tools receive already-correct paths. Omit to get the decoded module-relative paths only.'
    ),
  packName: z
    .string()
    .optional()
    .describe(
      'Only read this pack (matched against module.json packs[].name). Default: all packs.'
    ),
  sceneLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Page size: how many Scene records to return this call (default 10). The manifest must fit ' +
        'the MCP response cap, so a big pack is read in pages — import a page, then call again with ' +
        '`offset` advanced by the returned count until `nextOffset` is null.'
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Index of the first Scene to return (for paging a big pack). Default 0.'),
  index: z
    .boolean()
    .optional()
    .describe(
      'Survey mode: return ONLY the lightweight scene list ({sourceId, name, counts}) + descriptor + ' +
        'journal names — no paths, payloads, or assets. Call this ONCE to plan variant selection and ' +
        'dedup across the whole pack before paging the full import (the full manifest is capped/paged).'
    ),
});

/** Default scene page size — keeps the manifest comfortably under the ~20K response cap. */
const DEFAULT_SCENE_PAGE = 10;

// --- pure, unit-testable helpers --------------------------------------------

/**
 * Recursively strip the foundryvtt-cli pack artifact `_key` (e.g. "!scenes!<id>",
 * "!scenes.walls!<id>.<wid>") from an extracted document and its embedded arrays.
 * Real Foundry `_id`/`_stats` are KEPT — the skill needs the source `_id` for the
 * cross-scene teleporter remap (build plan §3 Stage E); the create path mints fresh
 * ids regardless (Foundry ignores a supplied `_id` without `{keepId:true}`).
 */
export function stripPackArtifacts<T>(value: T): T {
  if (Array.isArray(value)) return value.map(v => stripPackArtifacts(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '_key') continue;
      out[k] = stripPackArtifacts(v);
    }
    return out as T;
  }
  return value;
}

export interface PackEraDescriptor {
  era: 'legacy' | 'v10-v11' | 'v12+';
  storage: 'leveldb' | 'nedb';
  hasRegions: boolean;
  needsWallSenseTranslation: boolean;
  needsLightConfigNesting: boolean;
  sceneBackgroundShape: 'level' | 'object' | 'imgString';
  sceneEnvShape: 'environmentObject' | 'flat';
  statsCoreVersion?: string;
}

/**
 * Resolve a Scene doc's background image src across ALL eras. v14 moved the background onto a
 * LEVEL — `levels[<initialLevel>].background.src`; there is NO top-level Scene.background in
 * v14-packed data (see the fvtt-mcp-scene-v14-schema ground truth) — while v10–v13 use the
 * `background:{src}` object and ≤v9 a flat `img` string. Pure/exported for unit testing.
 */
export function sceneBackgroundSrc(d: any): string | undefined {
  const levels: any[] = Array.isArray(d?.levels) ? d.levels : [];
  const initial = levels.find(l => l?._id === d?.initialLevel) ?? levels[0];
  const fromLevel = initial?.background?.src;
  if (typeof fromLevel === 'string' && fromLevel) return fromLevel;
  const fromObject = d?.background?.src;
  if (typeof fromObject === 'string' && fromObject) return fromObject;
  return typeof d?.img === 'string' && d.img ? d.img : undefined;
}

/**
 * Decide a pack's Foundry era from the FIELD SHAPE of a sample Scene doc, not the
 * declared manifest version (Tom re-verifies ancient packs forward to v13, so the
 * manifest lies — build plan §2b). Only ever infers era UP from positive signals.
 */
export function detectPackEra(scene: any, storage: 'leveldb' | 'nedb'): PackEraDescriptor {
  const walls: any[] = Array.isArray(scene?.walls) ? scene.walls : [];
  const firstLight = Array.isArray(scene?.lights) ? scene.lights[0] : undefined;

  const hasRegions = Array.isArray(scene?.regions) && scene.regions.length > 0;
  const needsWallSenseTranslation = walls.some(w => w && w.sense !== undefined);
  const needsLightConfigNesting =
    !!firstLight &&
    firstLight.config === undefined &&
    (firstLight.dim !== undefined || firstLight.tintColor !== undefined);
  const sceneBackgroundShape: 'level' | 'object' | 'imgString' =
    Array.isArray(scene?.levels) && scene.levels.some((l: any) => l?.background?.src)
      ? 'level'
      : scene?.background && typeof scene.background === 'object'
        ? 'object'
        : 'imgString';
  const sceneEnvShape: 'environmentObject' | 'flat' =
    scene?.environment && typeof scene.environment === 'object' ? 'environmentObject' : 'flat';
  const lightHasV12 =
    !!firstLight?.config &&
    (firstLight.config.negative !== undefined || firstLight.config.priority !== undefined);

  let era: PackEraDescriptor['era'];
  // Require regions OR an environment{} object OR v12-only light fields OR a v14 background-on-Level
  // for the v12+ label, so a stray re-packed field can't over-promote a real v11 pack (§2b edge case).
  if (
    hasRegions ||
    sceneEnvShape === 'environmentObject' ||
    lightHasV12 ||
    sceneBackgroundShape === 'level'
  )
    era = 'v12+';
  else if (needsWallSenseTranslation || sceneBackgroundShape === 'imgString') era = 'legacy';
  else era = 'v10-v11';

  return {
    era,
    storage,
    hasRegions,
    needsWallSenseTranslation,
    needsLightConfigNesting,
    sceneBackgroundShape,
    sceneEnvShape,
    statsCoreVersion:
      typeof scene?._stats?.coreVersion === 'string' ? scene._stats.coreVersion : undefined,
  };
}

/** Percent-decode a module-relative asset path segment-by-segment (handles %20, %27, %28…). */
/**
 * Resolve a manifest pack `path` against the module folder. Some older manifests (e.g. Tom's v10
 * Into-the-Wilds) declare an absolute-style `/packs/foo.db`; a leading slash makes `path.resolve`
 * jump to the FILESYSTEM ROOT (`C:\packs\foo.db`), losing the module folder. Strip leading
 * slashes/backslashes so the pack path stays module-relative. Additionally, a v11+ module often
 * still DECLARES the legacy `packs/foo.db` while shipping a LevelDB DIRECTORY `packs/foo/` —
 * Foundry normalizes that at load; mirror it by falling back to the extensionless directory when
 * the declared path doesn't exist. Pure/exported for unit testing.
 */
export function resolvePackPath(moduleDir: string, packPath: string): string {
  const declared = resolve(moduleDir, String(packPath).replace(/^[/\\]+/, ''));
  if (existsSync(declared)) return declared;
  const levelDbDir = declared.replace(/\.db$/i, '');
  if (levelDbDir !== declared && existsSync(levelDbDir)) return levelDbDir;
  return declared; // let the caller's statSync raise the natural ENOENT
}

/**
 * Harvest the embedded Scene and JournalEntry docs out of extracted Adventure documents. A modern
 * premium pack (e.g. tomcartos-ostenwold 2.x) often ships ONE `type:"Adventure"` compendium whose
 * single Adventure doc embeds every scene/journal, instead of separate Scene/JournalEntry packs.
 * The embedded docs carry the same shape (own `_id`, walls/lights/regions, pages) as pack-level
 * docs, so everything downstream (era detection, payloads, rewrites) consumes them unchanged.
 *
 * Two multi-Adventure realities (Ostenwold ships a Day AND a Night Adventure in one pack):
 *  - scenes repeat NAMES across adventures (same "The Sanguine Dawn Inn (Roof)" in each) — every
 *    harvested scene is stamped `sourceAdventure: {id, name}` so a selection can tell them apart;
 *  - the SAME journal doc (same `_id`) is embedded in every adventure — journals are deduped by
 *    `_id` (first adventure wins).
 * Pure/exported for unit testing.
 */
export function harvestAdventureDocs(adventures: any[]): { scenes: any[]; journals: any[] } {
  const scenes: any[] = [];
  const journals: any[] = [];
  const seenJournalIds = new Set<string>();
  for (const adv of adventures) {
    const sourceAdventure = { id: adv?._id, name: adv?.name };
    if (Array.isArray(adv?.scenes))
      scenes.push(...adv.scenes.map((s: any) => ({ ...s, sourceAdventure })));
    for (const j of Array.isArray(adv?.journal) ? adv.journal : []) {
      if (typeof j?._id === 'string' && seenJournalIds.has(j._id)) continue;
      if (typeof j?._id === 'string') seenJournalIds.add(j._id);
      journals.push({ ...j, sourceAdventure });
    }
  }
  return { scenes, journals };
}

/**
 * Parse a Foundry NeDB compendium (.db) file into its live documents. A NeDB pack is an append-only
 * newline-JSON log: each non-empty line is a full document, a `{$$deleted:true,_id}` tombstone, or a
 * `{$$indexCreated|$$indexRemoved}` control line. We apply last-write-wins by `_id` and honor
 * tombstones (so a deleted doc doesn't resurrect — the trap a naive `split('\n').map(JSON.parse)`
 * hits), preserving first-seen order. Unparseable lines are skipped. Pure/exported for unit testing.
 *
 * Why parse it ourselves: foundryvtt-cli v3's `extractPack` is broken for pure-NeDB packs — after
 * `extractNedb` it ALWAYS also runs the LevelDB extractor, which throws on a `.db` file — and its
 * `extractNedb` is not exported. Direct parsing is correct, needs no native binding, and is
 * offline-testable. (LevelDB/modern packs still go through the cli child process.)
 */
export function parseNedbDocs(content: string): any[] {
  const byId = new Map<string, any>();
  const order: string[] = [];
  for (const line of content.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let doc: any;
    try {
      doc = JSON.parse(s);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    if (doc.$$deleted) {
      byId.delete(doc._id);
      continue;
    }
    if (doc.$$indexCreated || doc.$$indexRemoved) continue;
    if (typeof doc._id !== 'string') continue;
    if (!byId.has(doc._id)) order.push(doc._id);
    byId.set(doc._id, doc);
  }
  return order.filter(id => byId.has(id)).map(id => byId.get(id));
}

/**
 * Project a raw extracted Scene doc's geometry + mood to flat create-scene fields, ROBUST across
 * eras: grid is a v10+ object `{size,type,distance,units,color,alpha}` OR legacy flat (a `grid`
 * NUMBER = px size, plus sibling `gridType`/`gridDistance`/`gridUnits`/`gridColor`/`gridAlpha`);
 * darkness/globalLight come from the v12+ `environment{}` OR legacy/mid flat fields. Only defined
 * values are included (so a modern scene gets no spurious flat fields, and create-scene only
 * receives what the pack actually set). Pure/exported for unit testing.
 */
export function projectSceneGeometry(d: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null) out[k] = v;
  };
  put('width', d?.width);
  put('height', d?.height);
  put('padding', d?.padding);
  put('gridSize', typeof d?.grid === 'number' ? d.grid : d?.grid?.size);
  put('gridType', d?.grid?.type ?? d?.gridType);
  put('gridDistance', d?.grid?.distance ?? d?.gridDistance);
  put('gridUnits', d?.grid?.units ?? d?.gridUnits);
  put('gridColor', d?.grid?.color ?? d?.gridColor);
  put('gridAlpha', d?.grid?.alpha ?? d?.gridAlpha);
  const darkness =
    typeof d?.environment?.darknessLevel === 'number'
      ? d.environment.darknessLevel
      : typeof d?.darkness === 'number'
        ? d.darkness
        : undefined;
  put('darkness', darkness);
  const gl = d?.environment?.globalLight?.enabled ?? d?.globalLight;
  put('globalLight', typeof gl === 'boolean' ? gl : undefined);
  put('tokenVision', typeof d?.tokenVision === 'boolean' ? d.tokenVision : undefined);
  return out;
}

/** Percent-decode a module-relative asset path segment-by-segment (handles %20, %27, %28…). */
export function decodeAssetSegments(p: string): string {
  return p
    .split('/')
    .map(seg => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

export interface AssetRewrite {
  docSrc: string; // original, as authored (modules/<id>/…, still %-encoded)
  rel?: string; // decoded path relative to the module root (images/maps/foo.webp)
  diskPath?: string; // absolute on-disk source for upload
  dataPath?: string; // rewritten Data-relative path (only when destRoot given)
}

/**
 * Resolve one authored `modules/<id>/<rel>` src into { rel, diskPath, dataPath }.
 * A src that is not under this module's prefix (a core/system asset) is surfaced
 * verbatim with no rewrite so the caller can decide.
 */
export function computeAssetRewrite(
  docSrc: string,
  moduleId: string,
  moduleDir: string,
  destRoot?: string
): AssetRewrite {
  const prefix = `modules/${moduleId}/`;
  if (typeof docSrc !== 'string' || !docSrc.startsWith(prefix)) return { docSrc };
  const rel = decodeAssetSegments(docSrc.slice(prefix.length));
  const out: AssetRewrite = { docSrc, rel, diskPath: join(moduleDir, ...rel.split('/')) };
  if (destRoot) out.dataPath = `${destRoot.replace(/\/+$/, '')}/${rel}`;
  return out;
}

/** OS-tmp dir-name prefixes read-pack creates: payload dirs (this tool) + cli unpack dirs (child). */
const TMP_DIR_PREFIX = /^tc-(scene-payloads|pack)-/;
/** Sweep temp dirs older than this (read-pack leaves a payload dir per call; OS-cleaned eventually). */
const TMP_SWEEP_MAX_AGE_MS = 60 * 60 * 1000; // 1h

/**
 * Pick the STALE read-pack temp dirs to sweep: name matches a read-pack temp prefix
 * (`tc-scene-payloads-*` from this tool, `tc-pack-*` from the cli child) AND older than `maxAgeMs`.
 * read-pack deliberately leaves its payload dir behind (create-scene reads it server-side after the
 * call, and a resumed import may re-read it), so a fresh dir is never swept — only old leftovers, to
 * keep OS tmp from accumulating across many imports. Pure/exported for unit testing.
 */
export function staleTmpDirs(
  entries: Array<{ name: string; mtimeMs: number }>,
  nowMs: number,
  maxAgeMs: number
): string[] {
  return entries
    .filter(e => TMP_DIR_PREFIX.test(e.name) && nowMs - e.mtimeMs > maxAgeMs)
    .map(e => e.name);
}

// --- tile assets (standalone props the GM drags onto scenes) -----------------
//
// Some scene-pack modules ship a folder of TILE images — individual building/prop pieces (a hut, a
// temple, a roof) separate from the full battlemaps. They are NOT referenced by any scene doc, so the
// doc-driven asset walk never finds them; they're discovered by scanning the module folder. Tom
// Cartos bakes each tile's grid footprint into the filename as `Tile_<W>x<H>` (e.g. `Tile_10x7`),
// which also distinguishes a tile from a map (`_No Grid_WxH`) or a legend key (`_Key`). The skill
// uploads them so the GM can browse + drag them onto scenes (the WxH tells them how big to size it).

export interface TileAsset {
  name: string; // file name
  rel: string; // module-relative path (e.g. images/assets/TC_… Tile_10x7.webp)
  diskPath: string; // absolute on-disk source (for upload)
  dataPath?: string; // rewritten Data-relative path (only when destRoot given)
  gridWidth: number; // cells wide (from the filename)
  gridHeight: number; // cells tall
}

/**
 * Parse a tile image filename's baked-in grid footprint (`…Tile_<W>x<H>.<ext>`). Returns the cell
 * dimensions, or null when the name is not a tile image (a map's `_No Grid_WxH`, a `_Key`, or a
 * non-image all return null — the `Tile_` token + trailing position is the discriminator).
 * Pure/exported for unit testing.
 */
export function parseTileName(filename: string): { gridWidth: number; gridHeight: number } | null {
  const m = filename.match(/Tile_(\d+)x(\d+)\.(?:webp|png|jpe?g)$/i);
  if (!m) return null;
  return { gridWidth: Number(m[1]), gridHeight: Number(m[2]) };
}

/**
 * Recursively find tile images under a module folder (skips the compendium `packs/` dir and dotfiles).
 * Each tile carries its module-relative path, on-disk path, parsed grid footprint, and — given the
 * dest root the skill chose — a rewrite hint mirroring the module subtree. Returns [] when the pack
 * ships no tiles. Exported for unit testing (deterministic given a folder).
 */
export function discoverTiles(moduleDir: string, destRoot?: string): TileAsset[] {
  const out: TileAsset[] = [];
  const walk = (dir: string, relParts: string[]): void => {
    // Loop inside the try so TS infers Dirent<string> (a withFileTypes annotation defaults the
    // Dirent generic to Buffer); an unreadable dir is simply skipped.
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) {
          if (relParts.length === 0 && e.name === 'packs') continue; // skip the compendium DBs
          walk(join(dir, e.name), [...relParts, e.name]);
        } else if (e.isFile()) {
          const dims = parseTileName(e.name);
          if (!dims) continue;
          const rel = [...relParts, e.name].join('/');
          const tile: TileAsset = {
            name: e.name,
            rel,
            diskPath: join(dir, e.name),
            gridWidth: dims.gridWidth,
            gridHeight: dims.gridHeight,
          };
          if (destRoot) tile.dataPath = `${destRoot.replace(/\/+$/, '')}/${rel}`;
          out.push(tile);
        }
      }
    } catch {
      /* unreadable dir — skip */
    }
  };
  walk(moduleDir, []);
  return out;
}

/**
 * If every discovered tile shares ONE parent directory (the common case — Tom packs put them all in
 * one `images/assets`), return that dir (absolute + module-relative) so the skill can upload the whole
 * folder in one upload-asset-tree call. Spread across dirs → {} (skill falls back to per-file). Pure.
 */
export function summarizeTileDir(tiles: TileAsset[]): { localDir?: string; relDir?: string } {
  if (tiles.length === 0) return {};
  const relDirs = new Set(tiles.map(t => t.rel.split('/').slice(0, -1).join('/')));
  if (relDirs.size !== 1) return {};
  return { relDir: [...relDirs][0], localDir: dirname(tiles[0].diskPath) };
}

/**
 * Best-effort sweep of OLD read-pack temp dirs from the OS tmp dir. NEVER throws — a cleanup failure
 * must not block a read. Runs at the start of handleReadPack. (Regular Node fs/time, fine here.)
 */
function sweepStaleTmpDirs(): void {
  try {
    const root = tmpdir();
    const now = Date.now();
    const entries = readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && TMP_DIR_PREFIX.test(e.name))
      .map(e => {
        try {
          return { name: e.name, mtimeMs: statSync(join(root, e.name)).mtimeMs };
        } catch {
          return { name: e.name, mtimeMs: now }; // unreadable → treat as fresh, skip
        }
      });
    for (const name of staleTmpDirs(entries, now, TMP_SWEEP_MAX_AGE_MS)) {
      try {
        rmSync(join(root, name), { recursive: true, force: true });
      } catch {
        /* ignore — best-effort */
      }
    }
  } catch {
    /* ignore — never block a read on cleanup */
  }
}

// --- I/O: extract a pack via the foundryvtt-cli child process ----------------

const execFileAsync = promisify(execFile);

/** Resolve `@foundryvtt/foundryvtt-cli`'s entry from THIS module's location (cwd-independent). */
function resolveCliEntry(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@foundryvtt/foundryvtt-cli');
}

/**
 * Read a compendium pack's documents off disk. Two storage backends:
 *  - **NeDB** (`.db` file, legacy v10): parsed DIRECTLY via parseNedbDocs (the foundryvtt-cli's
 *    extractPack is broken for pure-NeDB — see that helper — and a NeDB pack is just newline-JSON).
 *  - **LevelDB** (directory, v11+): unpacked via foundryvtt-cli's `extractPack` in a CHILD node
 *    process (DECISION A) so the native classic-level binding loads only in the throwaway child.
 */
export async function extractPackDocs(
  packDir: string,
  opts: { nedb?: boolean; cliEntry?: string } = {}
): Promise<any[]> {
  if (opts.nedb) return parseNedbDocs(readFileSync(packDir, 'utf8'));

  const cliEntry = opts.cliEntry ?? resolveCliEntry();
  // Dynamic import() needs a file:// URL on Windows (a bare "C:\…" path is read as a URL scheme).
  const cliUrl = pathToFileURL(cliEntry).href;
  const outDir = mkdtempSync(join(tmpdir(), 'tc-pack-'));
  const childScript = [
    'const [cli, src, dest] = process.argv.slice(1);',
    'import(cli)',
    '  .then(m => m.extractPack(src, dest, { log: false }))',
    '  .then(() => process.stdout.write("OK"))',
    '  .catch(e => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });',
  ].join('\n');
  try {
    await execFileAsync(process.execPath, ['-e', childScript, cliUrl, packDir, outDir], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const docs: any[] = [];
    for (const name of readdirSync(outDir)) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      docs.push(JSON.parse(readFileSync(join(outDir, name), 'utf8')));
    }
    return docs;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// --- tool --------------------------------------------------------------------

const READ_PACK_DESCRIPTION =
  'Read a Tom-Cartos-style Foundry SCENE-PACK MODULE off disk (a `module.json` + LevelDB/NeDB ' +
  'compendium packs — Scene/JournalEntry packs AND modern `type:"Adventure"` packs whose single ' +
  'Adventure doc embeds every scene/journal) and return its era-normalized documents for import. ' +
  'OFF-LINE and Node-only: ' +
  "it reads files, never the live world. Detects the pack's Foundry era from field shape (older " +
  'v10/NeDB vs newer v13/LevelDB), extracts each Scene (dimensions, grid, background, thumbnail, ' +
  'walls, lights, regions/teleporters) and JournalEntry (pages), strips cli pack artifacts, and — ' +
  'when given the destination root the skill chose — emits per-asset path REWRITE HINTS (the ' +
  'module-relative %-encoded src → a clean Data-relative path). Also discovers any standalone TILE ' +
  'images the pack ships (building/prop pieces with a `Tile_<W>x<H>` grid footprint in the name, not ' +
  'referenced by any scene) so the skill can make them available for the GM to drop onto scenes. The heavy per-scene ' +
  'walls/lights/regions are written to PAYLOAD FILES and referenced by `placeablesPath` (NOT inline — ' +
  'the response cap truncates them at scene scale); pass that path to create-scene, which reads it ' +
  'server-side. The skill then uploads the assets, recreates the scenes/journals, and (modern packs) ' +
  'remaps the cross-scene teleporters. Handles all eras: modern v13/LevelDB (via the ' +
  '`@foundryvtt/foundryvtt-cli` child process) AND legacy v10/NeDB `.db` (parsed directly — no cli ' +
  'needed). The full manifest is PAGED to fit the response cap: returns `totalScenes` + a page of ' +
  'scenes + `nextOffset` (call again with `offset` until null). Pass `index:true` first for a tiny ' +
  'names-only survey of the whole pack (variant planning + dedup) before paging the heavy import.';

export interface PackReaderToolsOptions {
  logger: Logger;
}

export class PackReaderTools {
  private logger: Logger;

  constructor({ logger }: PackReaderToolsOptions) {
    this.logger = logger.child({ component: 'PackReaderTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'read-pack',
        description: READ_PACK_DESCRIPTION,
        inputSchema: toInputSchema(ReadPackSchema),
      },
    ];
  }

  async handleReadPack(args: any): Promise<any> {
    const { modulePath, destRoot, packName, sceneLimit, offset, index } = ReadPackSchema.parse(
      args ?? {}
    );

    // Best-effort hygiene: clear OLD read-pack temp dirs (payload + cli unpack) before this run.
    sweepStaleTmpDirs();

    // Resolve the module folder + manifest.
    const asPath = resolve(modulePath);
    const moduleDir = existsSync(asPath) && statSync(asPath).isFile() ? join(asPath, '..') : asPath;
    const manifestPath = join(moduleDir, 'module.json');
    if (!existsSync(manifestPath)) {
      throw new Error(
        `No module.json found at ${manifestPath} — point read-pack at a module folder.`
      );
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const moduleId: string = manifest.id ?? manifest.name ?? 'unknown-module';

    // Standalone TILE images (props the GM drags onto scenes) live in the module folder, not in any
    // scene doc — discover them by scanning (cheap; bounded to the module's asset dirs). Module-global.
    const tiles = discoverTiles(moduleDir, destRoot);
    const tileDir = summarizeTileDir(tiles);
    const tilesBlock =
      tiles.length > 0
        ? {
            count: tiles.length,
            localDir: tileDir.localDir,
            relDir: tileDir.relDir,
            files: tiles.map(t => ({
              name: t.name,
              gridWidth: t.gridWidth,
              gridHeight: t.gridHeight,
              diskPath: t.diskPath,
              ...(t.dataPath ? { dataPath: t.dataPath } : {}),
            })),
          }
        : null;

    const packs: any[] = Array.isArray(manifest.packs) ? manifest.packs : [];
    const scenePacks = packs.filter(
      p => p?.type === 'Scene' && (!packName || p?.name === packName)
    );
    const journalPacks = packs.filter(
      p => p?.type === 'JournalEntry' && (!packName || p?.name === packName)
    );
    const adventurePacks = packs.filter(
      p => p?.type === 'Adventure' && (!packName || p?.name === packName)
    );

    this.logger.info('read-pack: extracting', {
      moduleId,
      scenePacks: scenePacks.length,
      journalPacks: journalPacks.length,
      adventurePacks: adventurePacks.length,
    });

    // Resolve the cli once — needed for LevelDB packs only (NeDB .db packs are parsed directly).
    // Non-fatal if absent: the friendly error is raised lazily, and only if a LevelDB pack needs it.
    let cliEntry: string | undefined;
    try {
      cliEntry = resolveCliEntry();
    } catch {
      cliEntry = undefined;
    }
    const requireCli = (): string => {
      if (!cliEntry)
        throw new Error(
          'read-pack needs the `@foundryvtt/foundryvtt-cli` dependency to read LevelDB packs. ' +
            'Install it (npm i @foundryvtt/foundryvtt-cli) and retry. (NeDB `.db` packs are read ' +
            'directly and do not need it.)'
        );
      return cliEntry;
    };

    const assets = new Map<string, AssetRewrite>();
    const noteAsset = (src?: unknown) => {
      if (typeof src !== 'string' || !src) return undefined;
      if (!assets.has(src))
        assets.set(src, computeAssetRewrite(src, moduleId, moduleDir, destRoot));
      return assets.get(src);
    };
    // Lean projection for the manifest: only the upload source + destination the skill needs.
    // Dropping docSrc/rel keeps the whole manifest under the MCP response cap (a full pack's
    // background/thumb/key paths otherwise blow past ~20K on their own).
    const leanAsset = (a: Partial<AssetRewrite> | undefined) => {
      if (!a) return null;
      return a.diskPath ? { diskPath: a.diskPath, dataPath: a.dataPath } : { docSrc: a.docSrc };
    };

    // --- gather all docs first (era detection, the survey, AND paging all need the full list) ---
    // A big pack's full manifest blows the ~20K response cap, so the heavy import is PAGED (below);
    // the survey (index) mode and era detection still need every scene doc, so extract them all here.
    let descriptor: PackEraDescriptor | undefined;
    const allSceneDocs: any[] = [];
    for (const pack of scenePacks) {
      const packDir = resolvePackPath(moduleDir, pack.path);
      const storage = statSync(packDir).isDirectory() ? 'leveldb' : 'nedb';
      // Keep only primary Scene docs — a pack may also extract compendium FOLDER docs as top-level
      // files; their cli `_key` is "!folders!…", not "!scenes!…". (Tolerate a missing _key.)
      const raw = (
        await extractPackDocs(
          packDir,
          storage === 'nedb' ? { nedb: true } : { cliEntry: requireCli() }
        )
      ).filter(d => typeof d?._key !== 'string' || d._key.startsWith('!scenes!'));
      const docs = raw.map(d => stripPackArtifacts(d));
      if (!descriptor && docs[0]) descriptor = detectPackEra(docs[0], storage);
      allSceneDocs.push(...docs);
    }

    const journalDocs: any[] = [];

    // Adventure packs: ONE compendium doc embedding every scene/journal (modern premium format).
    // Harvest the embedded docs into the same streams — same shape, same downstream handling.
    for (const pack of adventurePacks) {
      const packDir = resolvePackPath(moduleDir, pack.path);
      const storage = statSync(packDir).isDirectory() ? 'leveldb' : 'nedb';
      const raw = (
        await extractPackDocs(
          packDir,
          storage === 'nedb' ? { nedb: true } : { cliEntry: requireCli() }
        )
      ).filter(d => typeof d?._key !== 'string' || d._key.startsWith('!adventures!'));
      const { scenes: advScenes, journals: advJournals } = harvestAdventureDocs(
        raw.map(d => stripPackArtifacts(d))
      );
      if (!descriptor && advScenes[0]) descriptor = detectPackEra(advScenes[0], storage);
      allSceneDocs.push(...advScenes);
      journalDocs.push(...advJournals);
    }
    const totalScenes = allSceneDocs.length;
    for (const pack of journalPacks) {
      const packDir = resolvePackPath(moduleDir, pack.path);
      const storage = statSync(packDir).isDirectory() ? 'leveldb' : 'nedb';
      const raw = (
        await extractPackDocs(
          packDir,
          storage === 'nedb' ? { nedb: true } : { cliEntry: requireCli() }
        )
      ).filter(d => typeof d?._key !== 'string' || d._key.startsWith('!journal!'));
      journalDocs.push(...raw.map(x => stripPackArtifacts(x)));
    }

    // Survey mode: a tiny planning view (names + counts) over the WHOLE pack, for variant selection +
    // dedup before paging the heavy import. No paths, payloads, or assets — fits the cap for any pack.
    if (index) {
      return {
        module: { id: moduleId, title: manifest.title, version: manifest.version },
        descriptor: descriptor ?? null,
        totalScenes,
        sceneIndex: allSceneDocs.map(d => ({
          sourceId: d._id,
          name: d.name,
          ...(d.sourceAdventure?.name ? { adventure: d.sourceAdventure.name } : {}),
          counts: {
            walls: d.walls?.length ?? 0,
            lights: d.lights?.length ?? 0,
            regions: d.regions?.length ?? 0,
          },
        })),
        journals: journalDocs.map(d => ({
          sourceId: d._id,
          name: d.name,
          pageCount: Array.isArray(d.pages) ? d.pages.length : 0,
        })),
        // Compact tile presence for planning ("this pack has N tiles" → offer to make them available).
        tiles: tilesBlock ? { count: tilesBlock.count, dir: tilesBlock.relDir } : null,
      };
    }

    // Heavy placeable arrays (hundreds of walls/lights per scene) are written to per-scene payload
    // FILES here and referenced by `placeablesPath`, NOT returned inline — the MCP tool-response cap
    // truncates them at scene scale, and routing them through the agent doesn't scale. create-scene
    // reads the file server-side (both tools share this process's filesystem).
    const payloadDir = mkdtempSync(join(tmpdir(), 'tc-scene-payloads-'));

    // --- scenes (paged) ---
    const start = offset ?? 0;
    const page = typeof sceneLimit === 'number' ? sceneLimit : DEFAULT_SCENE_PAGE;
    const batch = allSceneDocs.slice(start, start + page);
    const nextOffset = start + batch.length < totalScenes ? start + batch.length : null;

    const scenes: any[] = batch.map(d => {
      const bgSrc = sceneBackgroundSrc(d); // era-aware: v14 Level → v10+ object → legacy img
      // Legacy packs store the nav thumb as an inline `data:` URI, not a file path — never surface
      // it as an uploadable asset: it can't be uploaded, and a base64 blob per scene would blow the
      // manifest response cap. Foundry regenerates the thumb anyway, so dropping it is harmless.
      const thumbSrc =
        typeof d.thumb === 'string' && !d.thumb.startsWith('data:') ? d.thumb : undefined;
      const placeablesPath = join(payloadDir, `${d._id}.json`);
      writeFileSync(
        placeablesPath,
        JSON.stringify({
          walls: Array.isArray(d.walls) ? d.walls : [],
          lights: Array.isArray(d.lights) ? d.lights : [],
          regions: Array.isArray(d.regions) ? d.regions : [],
        })
      );
      return {
        sourceId: d._id,
        name: d.name,
        ...(d.sourceAdventure?.name ? { adventure: d.sourceAdventure.name } : {}),
        // Geometry + mood, normalized across eras (legacy flat grid/mood ↔ v10+ objects).
        ...projectSceneGeometry(d),
        background: leanAsset(noteAsset(bgSrc) ?? (bgSrc ? { docSrc: bgSrc } : undefined)),
        thumb: thumbSrc ? leanAsset(noteAsset(thumbSrc)) : null,
        // v12+ mood objects (absent on legacy/mid — the flat fields above carry those eras).
        environment: d.environment,
        fog: d.fog,
        initial: d.initial,
        // Walls/lights/regions live in this file (see payloadDir note) — pass it to create-scene.
        placeablesPath,
        counts: {
          walls: d.walls?.length ?? 0,
          lights: d.lights?.length ?? 0,
          regions: d.regions?.length ?? 0,
        },
      };
    });

    // --- journals (full projection — image/text pages + asset rewrite hints) ---
    const journals: any[] = journalDocs.map(d => ({
      sourceId: d._id,
      name: d.name,
      pages: (Array.isArray(d.pages) ? d.pages : []).map((p: any) => ({
        name: p.name,
        type: p.type,
        sort: p.sort,
        src: p.src ? leanAsset(noteAsset(p.src) ?? { docSrc: p.src }) : null,
        textLength: p.text?.content?.length ?? 0,
        text: p.text?.content,
      })),
    }));

    return {
      module: { id: moduleId, title: manifest.title, version: manifest.version },
      descriptor: descriptor ?? null,
      scenes,
      // Pagination cursor: import these scenes, then call again with offset=nextOffset until it's null.
      totalScenes,
      offset: start,
      returnedScenes: scenes.length,
      nextOffset,
      ...(nextOffset !== null
        ? {
            note:
              `Returned scenes ${start + 1}–${start + scenes.length} of ${totalScenes}. ` +
              `Import this page, then call read-pack again with offset=${nextOffset} for the rest ` +
              `(the manifest is paged to fit the response cap).`,
          }
        : {}),
      journals,
      assets: [...assets.values()].map(leanAsset),
      // Tile assets are module-global → returned once on the FIRST page (not repeated while paging).
      ...(start === 0 && tilesBlock ? { tiles: tilesBlock } : {}),
      payloadDir, // temp dir holding the per-scene {walls,lights,regions} files; safe to delete after import
    };
  }
}
