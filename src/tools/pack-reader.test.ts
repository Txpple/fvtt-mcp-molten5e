/**
 * Tests for read-pack (src/tools/pack-reader.ts). The pure helpers (era detection, artifact
 * stripping, asset-path rewrite) run offline with inline fixtures; the end-to-end extraction is an
 * integration test gated on the real Tom Cartos "Temple of Night" pack being present on disk (it
 * shells out to the foundryvtt-cli child process, so it is skipped where the pack/cli aren't there).
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computeAssetRewrite,
  decodeAssetSegments,
  detectPackEra,
  PackReaderTools,
  parseNedbDocs,
  projectSceneGeometry,
  resolvePackPath,
  staleTmpDirs,
  stripPackArtifacts,
} from './pack-reader.js';

describe('staleTmpDirs', () => {
  const now = 10_000_000;
  const maxAge = 60 * 60 * 1000; // 1h

  it('returns read-pack temp dirs older than maxAge, by name', () => {
    const out = staleTmpDirs(
      [
        { name: 'tc-scene-payloads-abc', mtimeMs: now - maxAge - 1 }, // old → swept
        { name: 'tc-pack-xyz', mtimeMs: now - maxAge - 5000 }, // old → swept
        { name: 'tc-scene-payloads-fresh', mtimeMs: now - 1000 }, // fresh → kept
      ],
      now,
      maxAge
    );
    expect(out).toEqual(['tc-scene-payloads-abc', 'tc-pack-xyz']);
  });

  it('never touches non-read-pack temp dirs, even when old', () => {
    const out = staleTmpDirs(
      [
        { name: 'npm-cache-123', mtimeMs: 0 },
        { name: 'some-other-tmp', mtimeMs: 0 },
        { name: 'tc-pack-old', mtimeMs: 0 },
      ],
      now,
      maxAge
    );
    expect(out).toEqual(['tc-pack-old']);
  });

  it('keeps everything when nothing is past maxAge', () => {
    expect(staleTmpDirs([{ name: 'tc-pack-recent', mtimeMs: now - 1 }], now, maxAge)).toEqual([]);
  });
});

describe('stripPackArtifacts', () => {
  it('removes the cli _key recursively but keeps _id/_stats and real fields', () => {
    const doc = {
      _id: 'a',
      _key: '!scenes!a',
      name: 'S',
      walls: [{ _id: 'w', _key: '!scenes.walls!a.w', c: [1, 2, 3, 4] }],
      _stats: { coreVersion: '13.351' },
    };
    const out = stripPackArtifacts(doc) as any;
    expect(out).not.toHaveProperty('_key');
    expect(out._id).toBe('a');
    expect(out._stats.coreVersion).toBe('13.351');
    expect(out.walls[0]).not.toHaveProperty('_key');
    expect(out.walls[0]._id).toBe('w'); // real id kept (needed for the teleporter remap)
    expect(out.walls[0].c).toEqual([1, 2, 3, 4]);
  });
});

describe('detectPackEra', () => {
  it('classifies a modern (v12+) scene: regions + environment{} + config.negative', () => {
    const scene = {
      background: { src: 'x' },
      environment: { darknessLevel: 0 },
      regions: [{ behaviors: [{ type: 'teleportToken' }] }],
      walls: [{ c: [0, 0, 1, 1], sight: 20, light: 20 }],
      lights: [{ config: { dim: 10, negative: false, priority: 0 } }],
      _stats: { coreVersion: '13.351' },
    };
    const d = detectPackEra(scene, 'leveldb');
    expect(d.era).toBe('v12+');
    expect(d.hasRegions).toBe(true);
    expect(d.needsWallSenseTranslation).toBe(false);
    expect(d.sceneEnvShape).toBe('environmentObject');
    expect(d.statsCoreVersion).toBe('13.351');
  });

  it('classifies a mid (v10–v11) scene: split walls + config{} lights, no environment{}, no regions', () => {
    const scene = {
      background: { src: 'x' },
      darkness: 0,
      globalLight: true, // flat mood, not environment{}
      regions: [],
      walls: [{ c: [0, 0, 1, 1], sight: 20, light: 20 }],
      lights: [{ config: { dim: 10 } }], // config{} but no negative/priority
    };
    const d = detectPackEra(scene, 'leveldb');
    expect(d.era).toBe('v10-v11');
    expect(d.hasRegions).toBe(false);
    expect(d.sceneEnvShape).toBe('flat');
  });

  it('classifies a legacy (≤v9) scene: img string + sense walls + flat light', () => {
    const scene = {
      img: 'modules/x/map.webp', // no background{} object
      walls: [{ c: [0, 0, 1, 1], sense: 1, move: 1 }],
      lights: [{ x: 0, y: 0, dim: 20, tintColor: '#fff' }],
    };
    const d = detectPackEra(scene, 'nedb');
    expect(d.era).toBe('legacy');
    expect(d.storage).toBe('nedb');
    expect(d.needsWallSenseTranslation).toBe(true);
    expect(d.needsLightConfigNesting).toBe(true);
    expect(d.sceneBackgroundShape).toBe('imgString');
  });
});

describe('decodeAssetSegments', () => {
  it('percent-decodes each path segment (spaces, apostrophes, parens)', () => {
    expect(decodeAssetSegments('images/maps/TC_Temple%20of%20Night.webp')).toBe(
      'images/maps/TC_Temple of Night.webp'
    );
    expect(decodeAssetSegments('images/Gilmore%27s%20Goods%20%28shop%29.webp')).toBe(
      "images/Gilmore's Goods (shop).webp"
    );
  });
});

describe('computeAssetRewrite', () => {
  const moduleId = 'tom-cartos-temple-of-night';
  const moduleDir = '/abs/module';

  it('splits a module-relative src into rel/diskPath/dataPath (with destRoot)', () => {
    const r = computeAssetRewrite(
      'modules/tom-cartos-temple-of-night/images/maps/TC_A%20B_34x22.webp',
      moduleId,
      moduleDir,
      'worlds/w/assets/tom-cartos/tom-cartos-temple-of-night'
    );
    expect(r.rel).toBe('images/maps/TC_A B_34x22.webp');
    expect(r.dataPath).toBe(
      'worlds/w/assets/tom-cartos/tom-cartos-temple-of-night/images/maps/TC_A B_34x22.webp'
    );
    expect(r.diskPath).toContain('images'); // path.join → OS separator
  });

  it('omits dataPath without destRoot, and passes a non-module src through verbatim', () => {
    expect(computeAssetRewrite('modules/x/a.webp', 'x', moduleDir).dataPath).toBeUndefined();
    const core = computeAssetRewrite('icons/svg/mystery-man.svg', moduleId, moduleDir, 'worlds/w');
    expect(core.rel).toBeUndefined();
    expect(core.dataPath).toBeUndefined();
    expect(core.docSrc).toBe('icons/svg/mystery-man.svg');
  });
});

describe('resolvePackPath', () => {
  it('strips a leading slash so an absolute-style pack path stays module-relative', () => {
    // Older Tom manifests (Into-the-Wilds v10) declare "/packs/foo.db"; resolve() would jump to the
    // drive root and lose the module folder.
    const r = resolvePackPath('/abs/module', '/packs/into-the-wilds.db');
    expect(r).toMatch(/module[\\/]packs[\\/]into-the-wilds\.db$/);
    expect(r).not.toMatch(/^[\\/]packs/);
  });

  it('leaves a normal relative pack path module-relative', () => {
    expect(resolvePackPath('/abs/module', 'packs/temple')).toMatch(/module[\\/]packs[\\/]temple$/);
  });
});

describe('parseNedbDocs', () => {
  it('parses newline-JSON docs, applies last-write-wins, and honors $$deleted tombstones', () => {
    const content = [
      JSON.stringify({ _id: 'a', name: 'First' }),
      JSON.stringify({ $$indexCreated: { fieldName: 'name' } }), // control line — skipped
      JSON.stringify({ _id: 'b', name: 'Keep' }),
      JSON.stringify({ _id: 'a', name: 'Updated' }), // supersedes the first 'a'
      JSON.stringify({ $$deleted: true, _id: 'b' }), // tombstone — 'b' must not resurrect
      '', // blank line tolerated
      '{not valid json', // unparseable — skipped
    ].join('\n');
    const docs = parseNedbDocs(content);
    expect(docs).toEqual([{ _id: 'a', name: 'Updated' }]);
  });

  it('preserves first-seen order and returns [] for empty input', () => {
    const content = [
      JSON.stringify({ _id: 'x', n: 1 }),
      JSON.stringify({ _id: 'y', n: 2 }),
      JSON.stringify({ _id: 'x', n: 3 }), // update keeps x's original position
    ].join('\n');
    expect(parseNedbDocs(content).map(d => d._id)).toEqual(['x', 'y']);
    expect(parseNedbDocs('')).toEqual([]);
  });
});

describe('projectSceneGeometry', () => {
  it('reads a LEGACY scene: flat grid number + sibling grid fields + flat mood', () => {
    const d = {
      width: 3080,
      height: 2380,
      padding: 0.25,
      grid: 140, // legacy: grid IS the px size
      gridType: 1,
      gridDistance: 5,
      gridUnits: 'ft',
      gridColor: '#000000',
      gridAlpha: 0.2,
      darkness: 0,
      globalLight: false,
      tokenVision: true,
    };
    expect(projectSceneGeometry(d)).toEqual({
      width: 3080,
      height: 2380,
      padding: 0.25,
      gridSize: 140,
      gridType: 1,
      gridDistance: 5,
      gridUnits: 'ft',
      gridColor: '#000000',
      gridAlpha: 0.2,
      darkness: 0,
      globalLight: false,
      tokenVision: true,
    });
  });

  it('reads a MODERN scene: grid object + environment{} mood', () => {
    const d = {
      width: 4760,
      height: 3080,
      grid: { size: 140, type: 1, distance: 5, units: 'ft', color: '#fff', alpha: 0.1 },
      environment: { darknessLevel: 0.6, globalLight: { enabled: true } },
      tokenVision: true,
    };
    const g = projectSceneGeometry(d);
    expect(g.gridSize).toBe(140);
    expect(g.gridColor).toBe('#fff');
    expect(g.darkness).toBe(0.6);
    expect(g.globalLight).toBe(true);
    expect(g.tokenVision).toBe(true);
  });

  it('omits fields the pack did not set (no spurious nulls/zeros)', () => {
    const g = projectSceneGeometry({ width: 1000, height: 800 });
    expect(g).toEqual({ width: 1000, height: 800 });
    expect(g).not.toHaveProperty('gridSize');
    expect(g).not.toHaveProperty('darkness');
  });
});

// --- integration (real pack on disk) ---------------------------------------

const REAL_PACK = 'C:/Users/sippelmc/Desktop/tom-cartos-temple-of-night';
const have = existsSync(REAL_PACK);
const logger: any = { child: () => ({ info() {}, debug() {}, warn() {}, error() {} }) };

(have ? describe : describe.skip)('read-pack integration (real Temple of Night pack)', () => {
  it('extracts the module, detects v12+, and rewrites asset paths', async () => {
    const tools = new PackReaderTools({ logger });
    const res = await tools.handleReadPack({
      modulePath: REAL_PACK,
      destRoot: 'worlds/test/assets/tom-cartos/tom-cartos-temple-of-night',
    });

    expect(res.module.id).toBe('tom-cartos-temple-of-night');
    expect(res.descriptor.era).toBe('v12+');
    expect(res.descriptor.hasRegions).toBe(true);
    expect(res.scenes.length).toBe(7);

    const iris = res.scenes.find((s: any) => s.name === 'Temple of Night 01 Iris');
    expect(iris.width).toBe(4760);
    expect(iris.height).toBe(3080);
    expect(iris.gridSize).toBe(140);
    expect(iris.gridDistance).toBe(5);
    expect(iris.padding).toBe(0.25);
    expect(iris.counts.walls).toBe(445);
    expect(iris.counts.lights).toBe(88);

    // background rewrite hint resolves to the chosen dest root, percent-decoded
    expect(iris.background.dataPath).toContain(
      'worlds/test/assets/tom-cartos/tom-cartos-temple-of-night/images/maps/'
    );
    expect(iris.background.dataPath).not.toContain('%20');
    expect(iris.thumb.dataPath).toContain('assets/scenes/');

    // Placeables are NOT inline (response-cap fix) — they live in a payload file create-scene reads.
    expect(iris).not.toHaveProperty('walls');
    expect(typeof iris.placeablesPath).toBe('string');
    const placeables = JSON.parse(readFileSync(iris.placeablesPath, 'utf8'));
    expect(placeables.walls.length).toBe(445);
    expect(placeables.lights.length).toBe(88);
    // a wall came through WHOLE (threshold present) with the cli _key stripped
    expect(placeables.walls[0]).not.toHaveProperty('_key');
    expect(placeables.walls[0]).toHaveProperty('threshold');
    // a light kept its full config
    expect(placeables.lights[0].config).toHaveProperty('luminosity');

    // journal pack: the 4 image legend keys
    expect(res.journals.length).toBe(1);
    expect(res.journals[0].pages.length).toBe(4);
    expect(res.journals[0].pages.every((p: any) => p.type === 'image')).toBe(true);
    expect(res.journals[0].pages[0].src.dataPath).toContain(
      'worlds/test/assets/tom-cartos/tom-cartos-temple-of-night/images/'
    );
  }, 30000);
});

const LEGACY_PACK = 'C:/Users/sippelmc/Desktop/tomcartos-into-the-wilds-dungeons';
const haveLegacy = existsSync(LEGACY_PACK);

(haveLegacy ? describe : describe.skip)(
  'read-pack integration (real v10 NeDB Into-the-Wilds pack)',
  () => {
    it('reads the NeDB pack, detects legacy, normalizes flat grid/mood, drops data-URI thumbs, pages', async () => {
      const tools = new PackReaderTools({ logger });
      const dest = 'worlds/test/assets/tom-cartos/tomcartos-into-the-wilds-dungeons';

      // Survey mode — the whole pack's names in one cheap call, no payloads/assets, fits the cap.
      const survey = await tools.handleReadPack({ modulePath: LEGACY_PACK, index: true });
      expect(survey.totalScenes).toBe(28);
      expect(survey.sceneIndex.length).toBe(28);
      expect(survey).not.toHaveProperty('payloadDir');
      expect(JSON.stringify(survey).length).toBeLessThan(20000);

      // Page 1 — default page, must fit the response cap.
      const res = await tools.handleReadPack({ modulePath: LEGACY_PACK, destRoot: dest });
      expect(res.descriptor.storage).toBe('nedb'); // .db file parsed directly (no cli)
      expect(res.descriptor.era).toBe('legacy');
      expect(res.descriptor.needsWallSenseTranslation).toBe(true);
      expect(res.totalScenes).toBe(28);
      expect(res.scenes.length).toBe(10); // default page
      expect(res.nextOffset).toBe(10);
      expect(JSON.stringify(res).length).toBeLessThan(20000); // paged manifest fits the cap

      // Last page.
      const last = await tools.handleReadPack({
        modulePath: LEGACY_PACK,
        destRoot: dest,
        offset: 20,
      });
      expect(last.scenes.length).toBe(8);
      expect(last.nextOffset).toBeNull();

      // Geometry/mood normalized from the legacy flat shape; data-URI thumb dropped; path decoded.
      const all = await tools.handleReadPack({
        modulePath: LEGACY_PACK,
        destRoot: dest,
        sceneLimit: 28,
      });
      const s = all.scenes[0];
      expect(s.gridSize).toBe(140);
      expect(s.gridType).toBe(1);
      expect(typeof s.darkness).toBe('number');
      expect(typeof s.globalLight).toBe('boolean');
      expect(s.environment).toBeUndefined();
      expect(s.thumb).toBeNull(); // legacy data: URI thumb not surfaced as an asset
      expect(s.background.dataPath).not.toContain('%');
    }, 30000);
  }
);
