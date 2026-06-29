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
import { join, resolve } from 'node:path';
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
  sceneBackgroundShape: 'object' | 'imgString';
  sceneEnvShape: 'environmentObject' | 'flat';
  statsCoreVersion?: string;
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
  const sceneBackgroundShape: 'object' | 'imgString' =
    scene?.background && typeof scene.background === 'object' ? 'object' : 'imgString';
  const sceneEnvShape: 'environmentObject' | 'flat' =
    scene?.environment && typeof scene.environment === 'object' ? 'environmentObject' : 'flat';
  const lightHasV12 =
    !!firstLight?.config &&
    (firstLight.config.negative !== undefined || firstLight.config.priority !== undefined);

  let era: PackEraDescriptor['era'];
  // Require regions OR an environment{} object OR v12-only light fields for the v12+ label,
  // so a stray re-packed field can't over-promote a real v11 pack (build plan §2b edge case).
  if (hasRegions || sceneEnvShape === 'environmentObject' || lightHasV12) era = 'v12+';
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
 * slashes/backslashes so the pack path stays module-relative. Pure/exported for unit testing.
 */
export function resolvePackPath(moduleDir: string, packPath: string): string {
  return resolve(moduleDir, String(packPath).replace(/^[/\\]+/, ''));
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
  'compendium packs) and return its era-normalized documents for import. OFF-LINE and Node-only: ' +
  "it reads files, never the live world. Detects the pack's Foundry era from field shape (older " +
  'v10/NeDB vs newer v13/LevelDB), extracts each Scene (dimensions, grid, background, thumbnail, ' +
  'walls, lights, regions/teleporters) and JournalEntry (pages), strips cli pack artifacts, and — ' +
  'when given the destination root the skill chose — emits per-asset path REWRITE HINTS (the ' +
  'module-relative %-encoded src → a clean Data-relative path). The heavy per-scene ' +
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

    const packs: any[] = Array.isArray(manifest.packs) ? manifest.packs : [];
    const scenePacks = packs.filter(
      p => p?.type === 'Scene' && (!packName || p?.name === packName)
    );
    const journalPacks = packs.filter(
      p => p?.type === 'JournalEntry' && (!packName || p?.name === packName)
    );

    this.logger.info('read-pack: extracting', {
      moduleId,
      scenePacks: scenePacks.length,
      journalPacks: journalPacks.length,
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
    const totalScenes = allSceneDocs.length;

    const journalDocs: any[] = [];
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
      const bgSrc = d.background?.src ?? (typeof d.img === 'string' ? d.img : undefined);
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
        // Geometry + mood, normalized across eras (legacy flat grid/mood ↔ v10+ objects).
        ...projectSceneGeometry(d),
        background: leanAsset(noteAsset(bgSrc) ?? { docSrc: bgSrc }),
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
      payloadDir, // temp dir holding the per-scene {walls,lights,regions} files; safe to delete after import
    };
  }
}
