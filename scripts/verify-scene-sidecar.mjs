// Live acceptance for the NEW create-scene sidecar import (walls + lights from a
// Foundry scene-export sidecar JSON that ships next to a battlemap). It builds
// the real "Eerie Temple" scene from the user's Desktop scene folder
// (map.jpg + map.json), then reads it back to assert the legacy→v14 conversion:
// wall `sense`→`sight`(+`light`) with small-int→spaced enums, and flat light
// fields nested under `config`. The scene is LEFT IN PLACE (it's a deliverable),
// but any prior "Eerie Temple" is deleted first so the script is re-runnable.
//
// Prereq: the map image is already uploaded to BACKGROUND (see upload-asset).
// Build first: npm run build. Run: node scripts/verify-scene-sidecar.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENE_NAME = 'Eerie Temple';
const SIDECAR = 'C:/Users/sippelmc/Desktop/scene/map.json';
const BACKGROUND = 'worlds/sandbox/assets/maps/eerie-temple.jpg';

function loadEnv() {
  const txt = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const foundry = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const results = [];
const pass = (n, s) => {
  results.push({ n, ok: true });
  console.log(`PASS  ${n}${s ? ` -> ${s}` : ''}`);
};
const fail = (n, e) => {
  results.push({ n, ok: false });
  console.log(`FAIL  ${n} -> ${e}`);
};

try {
  const sidecar = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  console.log(
    `Sidecar: ${sidecar.walls?.length ?? 0} walls, ${sidecar.lights?.length ?? 0} lights, ` +
      `${sidecar.width}x${sidecar.height}px, grid ${sidecar.grid}px = ${sidecar.gridDistance}${sidecar.gridUnits}`
  );

  // Idempotency: remove a prior run's scene so we don't accumulate duplicates.
  const del = await foundry.call('deleteScenes', { identifiers: [SCENE_NAME] }).catch(() => null);
  if (del?.deletedCount) console.log(`(removed ${del.deletedCount} prior "${SCENE_NAME}")`);

  // ---- create the scene WITH the sidecar walls + lights ----
  const created = await foundry.call('createScene', {
    name: SCENE_NAME,
    backgroundPath: BACKGROUND,
    width: sidecar.width,
    height: sidecar.height,
    gridSize: sidecar.grid,
    gridType: 1,
    gridDistance: sidecar.gridDistance,
    gridUnits: sidecar.gridUnits,
    padding: sidecar.padding,
    gridColor: sidecar.gridColor,
    gridAlpha: sidecar.gridAlpha,
    globalLight: sidecar.globalLight,
    darkness: sidecar.darkness,
    walls: sidecar.walls,
    lights: sidecar.lights,
    activate: false,
  });
  console.log(
    `create-scene -> id ${created?.sceneId}, walls ${created?.wallsCreated}, lights ${created?.lightsCreated}` +
      (created?.placeableErrors ? `, errs ${JSON.stringify(created.placeableErrors)}` : '')
  );

  created?.sceneId ? pass('scene created', created.sceneId) : fail('scene created', 'no sceneId');
  created?.wallsCreated === sidecar.walls.length
    ? pass('all walls placed', `${created.wallsCreated}/${sidecar.walls.length}`)
    : fail('all walls placed', `${created?.wallsCreated}/${sidecar.walls.length}`);
  created?.lightsCreated === sidecar.lights.length
    ? pass('all lights placed', `${created.lightsCreated}/${sidecar.lights.length}`)
    : fail('all lights placed', `${created?.lightsCreated}/${sidecar.lights.length}`);

  // ---- read back the persisted scene and verify the v14 conversion ----
  const back = await foundry.evaluate(id => {
    const s = game.scenes.get(id);
    if (!s) return null;
    const w0 = s.walls.contents[0];
    const l0 = s.lights.contents[0];
    const o = s.toObject();
    return {
      walls: s.walls.size,
      lights: s.lights.size,
      width: s.width,
      height: s.height,
      gridSize: o.grid?.size,
      gridColor: o.grid?.color,
      gridAlpha: o.grid?.alpha,
      darkness: o.environment?.darknessLevel,
      globalLight: o.environment?.globalLight?.enabled,
      wall0: w0
        ? {
            c: w0.c,
            sight: w0.sight,
            light: w0.light,
            move: w0.move,
            sound: w0.sound,
            door: w0.door,
          }
        : null,
      light0: l0 ? { x: l0.x, y: l0.y, config: l0.config?.toObject?.() ?? l0.config } : null,
    };
  }, created?.sceneId);

  if (!back) {
    fail('read back scene', 'scene not found after create');
  } else {
    console.log('read-back:', JSON.stringify(back, null, 1));

    // dimensions + grid carried from the sidecar
    back.width === sidecar.width && back.height === sidecar.height
      ? pass('dimensions match sidecar', `${back.width}x${back.height}`)
      : fail('dimensions match sidecar', `${back.width}x${back.height}`);
    back.gridSize === sidecar.grid
      ? pass('grid size from sidecar', `${back.gridSize}`)
      : fail('grid size from sidecar', `${back.gridSize}`);

    // wall conversion (match by coords — Foundry's wall collection isn't insertion-ordered,
    // so the read-back wall0 may be any sidecar wall; find the one it came from).
    const w0 = back.wall0;
    const sw0 = sidecar.walls.find(w => JSON.stringify(w.c) === JSON.stringify(w0?.c));
    const expSight = sw0?.sense === 1 ? 20 : sw0?.sense === 2 ? 10 : sw0?.sense === 0 ? 0 : 20;
    sw0
      ? pass('wall coords verbatim (matched a sidecar wall)', JSON.stringify(w0.c))
      : fail('wall coords verbatim', `${JSON.stringify(w0?.c)} not found in sidecar`);
    w0 && sw0 && w0.sight === expSight && w0.light === expSight
      ? pass('wall sense→sight+light remapped', `sense ${sw0.sense} → sight/light ${w0.sight}`)
      : fail(
          'wall sense→sight+light remapped',
          `got sight ${w0?.sight} light ${w0?.light}, want ${expSight}`
        );
    w0 && w0.move === 20 && w0.sound === 20
      ? pass('wall move/sound → 20 (NORMAL)', `move ${w0.move} sound ${w0.sound}`)
      : fail('wall move/sound → 20 (NORMAL)', `move ${w0?.move} sound ${w0?.sound}`);
    w0 && w0.door === sw0.door
      ? pass('wall door type passthrough', `${w0.door}`)
      : fail('wall door type passthrough', `${w0?.door} vs ${sw0.door}`);

    // light conversion: flat -> config{} (match by position, same ordering caveat as walls)
    const l0 = back.light0;
    const sl0 = sidecar.lights.find(l => l.x === l0?.x && l.y === l0?.y) ?? sidecar.lights[0];
    const cfg = l0?.config ?? {};
    l0 && sidecar.lights.some(l => l.x === l0.x && l.y === l0.y)
      ? pass('light x/y verbatim (matched a sidecar light)', `${l0.x},${l0.y}`)
      : fail('light x/y verbatim', `${l0?.x},${l0?.y} not found in sidecar`);
    cfg.dim === sl0.dim && cfg.bright === sl0.bright
      ? pass('light dim/bright → config (verbatim ft)', `dim ${cfg.dim} bright ${cfg.bright}`)
      : fail(
          'light dim/bright → config',
          `dim ${cfg.dim} bright ${cfg.bright} vs ${sl0.dim}/${sl0.bright}`
        );
    typeof cfg.color === 'string' && cfg.color.toLowerCase() === sl0.tintColor.toLowerCase()
      ? pass('light tintColor → config.color', `${cfg.color}`)
      : fail('light tintColor → config.color', `${cfg.color} vs ${sl0.tintColor}`);
    cfg.alpha === sl0.tintAlpha
      ? pass('light tintAlpha → config.alpha', `${cfg.alpha}`)
      : fail('light tintAlpha → config.alpha', `${cfg.alpha} vs ${sl0.tintAlpha}`);
  }
} catch (e) {
  fail('SUITE', e?.stack || e?.message || String(e));
} finally {
  await foundry.dispose?.();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}
