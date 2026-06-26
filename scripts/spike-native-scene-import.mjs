// Spike: does Foundry v14's NATIVE scene-import / data-model migration still
// transform the LEGACY scene-sidecar shape (wall `sense`→`sight`, flat lights→
// `config{}`) the way the old right-click "Import Data" did — or were those shims
// removed (so a hand-written legacy→v14 converter is required)?
//
// We feed the user's real legacy map.json into several in-page paths WITHOUT
// persisting and report what each produces for wall[0] / light[0]:
//   1. Scene.migrateData(legacy)                       (static migration)
//   2. new Scene({...legacy walls/lights})             (construction-time clean/migrate)
//   3. Scene.fromSource(legacy)                         (the import entrypoint, if present)
// Ground truth to decide: delegate to Foundry's migration, or keep our converter.
//
// Build first: npm run build. Run: node scripts/spike-native-scene-import.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR = 'C:/Users/sippelmc/Desktop/scene/map.json';

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
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

try {
  const legacy = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  console.log(
    `legacy sidecar: wall[0]=${JSON.stringify(legacy.walls[0])}  light[0]=${JSON.stringify(legacy.lights[0])}\n`
  );

  const report = await foundry.evaluate(legacy => {
    const out = { foundryVersion: globalThis.game?.version ?? null };
    const SceneClass = globalThis.Scene ?? globalThis.CONFIG?.Scene?.documentClass ?? null;
    out.hasSceneClass = !!SceneClass;
    out.hasMigrateData = typeof SceneClass?.migrateData === 'function';
    out.hasFromSource = typeof SceneClass?.fromSource === 'function';

    const pickWall = w =>
      w
        ? {
            c: w.c,
            sight: w.sight,
            light: w.light,
            move: w.move,
            sound: w.sound,
            door: w.door,
            sense: w.sense, // legacy key — should be undefined on a migrated doc
          }
        : null;
    const pickLight = l =>
      l
        ? {
            x: l.x,
            y: l.y,
            cfgDim: l.config?.dim,
            cfgBright: l.config?.bright,
            cfgColor: l.config?.color,
            cfgAlpha: l.config?.alpha,
            flatDim: l.dim, // legacy flat — should be undefined on a migrated doc
            flatTint: l.tintColor,
          }
        : null;

    // 1. static migrateData on the raw object
    try {
      const clone = foundry.utils.deepClone(legacy);
      const migrated = SceneClass.migrateData(clone);
      out.migrate_wall0 = migrated?.walls?.[0] ?? null;
      out.migrate_light0 = migrated?.lights?.[0] ?? null;
    } catch (e) {
      out.migrate_err = String(e?.message ?? e);
    }

    // 2. construct a Scene document in-memory (no DB write) from legacy data
    try {
      const tmp = new SceneClass({
        name: 'PROBE-NATIVE',
        width: legacy.width,
        height: legacy.height,
        grid: { size: legacy.grid },
        walls: legacy.walls,
        lights: legacy.lights,
      });
      out.construct_walls = tmp.walls?.size ?? null;
      out.construct_lights = tmp.lights?.size ?? null;
      out.construct_wall0 = pickWall(tmp.walls?.contents?.[0]);
      out.construct_light0 = pickLight(tmp.lights?.contents?.[0]);
    } catch (e) {
      out.construct_err = String(e?.message ?? e);
    }

    // 3. fromSource (the import path used by sidebar "Import Data")
    try {
      if (typeof SceneClass.fromSource === 'function') {
        const doc = SceneClass.fromSource({
          name: 'PROBE-FROMSOURCE',
          width: legacy.width,
          height: legacy.height,
          walls: legacy.walls,
          lights: legacy.lights,
        });
        out.fromSource_wall0 = pickWall(doc.walls?.contents?.[0]);
        out.fromSource_light0 = pickLight(doc.lights?.contents?.[0]);
      }
    } catch (e) {
      out.fromSource_err = String(e?.message ?? e);
    }

    return out;
  }, legacy);

  console.log(JSON.stringify(report, null, 2));

  // Verdict
  const w = report.construct_wall0;
  const l = report.construct_light0;
  console.log('\n--- VERDICT ---');
  if (w && (w.sight === 20 || w.sight === 10) && w.sense === undefined) {
    console.log('NATIVE MIGRATION HANDLES WALLS: legacy sense→sight migrated on construction.');
  } else if (w && w.sense !== undefined) {
    console.log(
      'NATIVE MIGRATION DROPPED: legacy `sense` survives as-is / sight not set — converter REQUIRED.'
    );
  } else {
    console.log('Wall result inconclusive:', JSON.stringify(w));
  }
  if (l && typeof l.cfgDim === 'number') {
    console.log('NATIVE MIGRATION HANDLES LIGHTS: flat dim→config.dim migrated on construction.');
  } else {
    console.log('Light result inconclusive / not migrated:', JSON.stringify(l));
  }
} catch (e) {
  console.error('SPIKE FAILED:', e?.stack || e?.message || String(e));
  process.exitCode = 1;
} finally {
  await foundry.dispose?.();
}
