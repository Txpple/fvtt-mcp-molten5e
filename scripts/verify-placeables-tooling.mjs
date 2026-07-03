// Live verification for the placeable CRUD kernel — Tile CRUD (create/list/update/delete-tiles).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart) and exercises the page fns
// createSceneTiles / listSceneTiles / updateSceneTiles / deleteSceneTiles through f.call against a
// throwaway scene, asserting the shared kernel + Tile descriptor end to end:
//   • create places tiles (nested texture + occlusion Set-as-array), returns ids, isolates a bad item.
//   • list reads them back with the salient fields (size = width/height, image zoom = texture.scaleX).
//   • update RESIZES (width/height) + MOVES (x/y) + zooms the image (texture.scaleX) via dot-paths.
//   • delete removes by id and reports a missing id, never fatal.
// Fixture scene is deleted in `finally`.
//
// Build first: npm run build.  Run: node scripts/verify-placeables-tooling.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const TAG = 'ZZ-TILE-IT';
let passes = 0;
let fails = 0;
function assert(cond, msg) {
  if (cond) {
    passes++;
    console.log(`  PASS  ${msg}`);
  } else {
    fails++;
    console.log(`  FAIL  ${msg}`);
  }
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let sceneId;
let journalId;

try {
  console.log('[verify-tiles] connecting…');
  await f.connect();
  console.log('[verify-tiles] connected\n');

  sceneId = await f.evaluate(async tag => {
    const s = await Scene.create({
      name: `${tag} Scene`,
      width: 2000,
      height: 2000,
      navigation: false,
    });
    return s.id;
  }, TAG);

  // --- A: create — 2 good tiles + 1 bad (missing width) → isolated ---
  console.log('# A: create-tiles (nested texture/occlusion; per-item error isolation)');
  const created = await f.call('createSceneTiles', {
    sceneIdentifier: sceneId,
    items: [
      {
        src: 'icons/svg/direction.svg',
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        rotation: 45,
        occlusionMode: 1,
      },
      { src: 'icons/svg/hazard.svg', x: 400, y: 100, width: 300, height: 300, scaleX: 1.25 },
      { src: 'icons/svg/bad.svg', x: 0, y: 0 /* missing width/height */ },
    ],
  });
  assert(created?.created === 2, `A — created 2 tiles (got ${created?.created})`);
  assert(
    Array.isArray(created?.errors) && created.errors.some(e => /height|width/.test(e)),
    'A — the bad tile was isolated + reported, not fatal'
  );
  const ids = (created?.items ?? []).map(t => t.id);
  assert(ids.length === 2, 'A — returned 2 created ids');
  // Confirm the occlusion Set + nested texture persisted live.
  const liveOcc = await f.evaluate(
    ({ sId, tId }) => {
      const t = game.scenes.get(sId).tiles.get(tId);
      return {
        modes: t.occlusion?.modes ? [...t.occlusion.modes] : null,
        rot: t.rotation,
        src: t.texture?.src,
      };
    },
    { sId: sceneId, tId: ids[0] }
  );
  assert(
    liveOcc.modes?.[0] === 1,
    `A — occlusion.modes persisted as a Set [1] (got ${JSON.stringify(liveOcc.modes)})`
  );
  assert(liveOcc.rot === 45, 'A — rotation persisted');

  // --- B: list — read back ids + salient fields ---
  console.log('\n# B: list-tiles');
  const listed = await f.call('listSceneTiles', { sceneIdentifier: sceneId });
  assert(
    listed?.found === true && listed?.count === 2,
    `B — lists 2 tiles (count ${listed?.count})`
  );
  const t0 = (listed?.items ?? []).find(t => t.id === ids[0]);
  assert(t0?.width === 200 && t0?.height === 200, 'B — reports size = width/height');
  assert(
    listed.items.find(t => t.id === ids[1])?.scaleX === 1.25,
    'B — reports image zoom = texture.scaleX'
  );

  // --- C: update — resize (w/h) + move (x/y) + image zoom (texture.scaleX) + one bad id ---
  console.log('\n# C: update-tiles (resize + move + image zoom; unresolved id reported)');
  const updated = await f.call('updateSceneTiles', {
    sceneIdentifier: sceneId,
    patches: [
      { id: ids[0], width: 512, height: 512, x: 150, scaleX: 2 },
      { id: 'doesNotExist00', x: 5 },
    ],
  });
  assert(
    updated?.matched === 1 && updated?.updated === 1,
    `C — matched & updated 1 (matched ${updated?.matched})`
  );
  assert(
    updated?.notFoundIds?.includes('doesNotExist00'),
    'C — the bogus id is reported, not fatal'
  );
  const after = await f.evaluate(
    ({ sId, tId }) => {
      const t = game.scenes.get(sId).tiles.get(tId);
      return { w: t.width, h: t.height, x: t.x, scaleX: t.texture?.scaleX };
    },
    { sId: sceneId, tId: ids[0] }
  );
  assert(
    after.w === 512 && after.h === 512,
    `C — RESIZED via width/height (${after.w}x${after.h})`
  );
  assert(after.x === 150, 'C — MOVED via x');
  assert(after.scaleX === 2, 'C — image zoom via texture.scaleX (distinct from resize)');

  // --- D: delete — by id, missing id reported ---
  console.log('\n# D: delete-tiles');
  const deleted = await f.call('deleteSceneTiles', {
    sceneIdentifier: sceneId,
    ids: [ids[0], ids[1], 'ghostTile00'],
  });
  assert(deleted?.deleted === 2, `D — deleted 2 (got ${deleted?.deleted})`);
  assert(deleted?.notFoundIds?.includes('ghostTile00'), 'D — missing id reported');
  const remaining = await f.call('listSceneTiles', { sceneIdentifier: sceneId });
  assert(remaining?.count === 0, `D — 0 tiles remain (got ${remaining?.count})`);

  // --- E: AmbientLight CRUD (config nesting; torch flicker; darkness range) ---
  console.log('\n# E: light CRUD (config nesting + animation + darkness range)');
  const litE = await f.call('createSceneLights', {
    sceneIdentifier: sceneId,
    items: [
      {
        x: 500,
        y: 500,
        dim: 40,
        bright: 20,
        color: '#fcd674',
        animationType: 'torch',
        animationSpeed: 5,
        animationIntensity: 5,
        darknessMin: 0.1,
      },
      { x: 900, y: 500 /* no config — a default point light */ },
    ],
  });
  assert(litE?.created === 2, `E — created 2 lights (got ${litE?.created})`);
  const lightIds = (litE?.items ?? []).map(l => l.id);
  const liveLight = await f.evaluate(
    ({ sId, lId }) => {
      const l = game.scenes.get(sId).lights.get(lId);
      return {
        dim: l.config?.dim,
        color: l.config?.color,
        anim: l.config?.animation?.type,
        dMin: l.config?.darkness?.min,
      };
    },
    { sId: sceneId, lId: lightIds[0] }
  );
  assert(
    liveLight.dim === 40 && liveLight.color === '#fcd674',
    `E — emission nested under config (dim ${liveLight.dim})`
  );
  assert(
    liveLight.anim === 'torch' && liveLight.dMin === 0.1,
    'E — animation + darkness range persisted in config'
  );

  const listedLights = await f.call('listSceneLights', { sceneIdentifier: sceneId });
  assert(listedLights?.count === 2, `E — lists 2 lights (count ${listedLights?.count})`);

  const updL = await f.call('updateSceneLights', {
    sceneIdentifier: sceneId,
    patches: [{ id: lightIds[0], dim: 60, animationType: 'flame' }],
  });
  assert(updL?.updated === 1, 'E — updated 1 light');
  const afterL = await f.evaluate(
    ({ sId, lId }) => {
      const l = game.scenes.get(sId).lights.get(lId);
      return {
        dim: l.config?.dim,
        bright: l.config?.bright,
        anim: l.config?.animation?.type,
        color: l.config?.color,
      };
    },
    { sId: sceneId, lId: lightIds[0] }
  );
  assert(
    afterL.dim === 60 && afterL.anim === 'flame',
    'E — config.dim + config.animation.type patched'
  );
  assert(
    afterL.bright === 20 && afterL.color === '#fcd674',
    'E — partial patch PRESERVED the un-touched config fields'
  );

  const delL = await f.call('deleteSceneLights', { sceneIdentifier: sceneId, ids: lightIds });
  assert(delL?.deleted === 2, `E — deleted 2 lights (got ${delL?.deleted})`);

  // --- F: read-only list-tokens / list-notes (need existing placeables) ---
  console.log('\n# F: list-tokens / list-notes (read-only inspect layer)');
  const fx = await f.evaluate(
    async ({ sId }) => {
      const j = await JournalEntry.create({ name: 'ZZ Probe Journal' });
      const scene = game.scenes.get(sId);
      const [tk] = await scene.createEmbeddedDocuments('Token', [
        {
          name: 'Probe Token',
          x: 100,
          y: 100,
          width: 1,
          height: 1,
          disposition: -1,
          texture: { src: 'icons/svg/mystery-man.svg', scaleX: 1.5 },
        },
      ]);
      const [nt] = await scene.createEmbeddedDocuments('Note', [
        { entryId: j.id, x: 200, y: 200, text: 'Probe Note' },
      ]);
      return { journalId: j.id, tokenId: tk.id, noteId: nt.id };
    },
    { sId: sceneId }
  );
  journalId = fx.journalId;

  const tokens = await f.call('listSceneTokens', { sceneIdentifier: sceneId });
  const tk = (tokens?.items ?? []).find(t => t.id === fx.tokenId);
  assert(tokens?.found === true && tk, 'F — list-tokens finds the placed token');
  assert(
    tk?.disposition === 'hostile' && tk?.scale === 1.5,
    `F — token disposition mapped to name + art scale (${tk?.disposition}, ${tk?.scale})`
  );

  const notes = await f.call('listSceneNotes', { sceneIdentifier: sceneId });
  const nt = (notes?.items ?? []).find(n => n.id === fx.noteId);
  assert(notes?.found === true && nt, 'F — list-notes finds the pin');
  assert(
    nt?.entryId === fx.journalId && nt?.text === 'Probe Note',
    'F — note reports the linked journal + label'
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-tiles] FATAL: ${e?.stack || e?.message || String(e)}`);
} finally {
  if (sceneId || journalId) {
    try {
      await f.evaluate(
        async ({ sId, jId }) => {
          if (sId) await game.scenes.get(sId)?.delete();
          if (jId) await game.journal.get(jId)?.delete();
        },
        { sId: sceneId, jId: journalId }
      );
      console.log('\n[verify-tiles] cleaned up fixture scene + journal');
    } catch (e) {
      console.log(`\n[verify-tiles] cleanup note: ${e?.message || e}`);
    }
  }
  await f.dispose?.();
}

console.log(`\n==== placeable (tile) verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
