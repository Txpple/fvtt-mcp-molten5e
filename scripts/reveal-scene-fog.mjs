// Pre-seed "explored" fog so a scene's ARCHITECTURE reads through the fog of war from the start
// (owner-directed 2026-07-08, Greenrest/Ostenwold maps): every user's FogExploration document for
// the scene is written with an all-white exploration texture, so the whole map renders in the
// dim "explored" state — exactly the look of a previously-seen area — while TOKENS remain hidden
// until they enter actual vision (explored-but-not-visible never draws actors; that's core fog).
//
// Why a script: Foundry v14 core has no "pre-explore" button, no translucent unexplored fog
// (fog.colors have no alpha; the v10 fog-overlay-texture trick was removed), and exploration is
// per-user server-side data — so we write the FogExploration docs directly over the bridge.
//
//   node scripts/reveal-scene-fog.mjs                      # all tomcartos-ostenwold-flagged scenes
//   node scripts/reveal-scene-fog.mjs <sceneIdOrName>...   # specific scenes (exact id or name)
//   node scripts/reveal-scene-fog.mjs --revert [scenes...] # delete the fog docs (re-hides all;
//                                                          #   also wipes any REAL exploration)
//
// Notes:
//   - Seeds EVERY user (GMs included, so the GM sees it while controlling a token without
//     needing gm-vision).
//   - The in-app "Reset Fog" button deletes these docs — re-run after any fog reset.
//   - New users joining the world later need a re-run to be seeded.
//   - A viewer already on the scene must switch scenes and back to reload fog.
//   - Run AFTER importing new Ostenwold scenes (no args = picks up the import flags).
//
// Build first if dist is stale: npm run build.
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

const args = process.argv.slice(2);
const revert = args.includes('--revert');
const sceneArgs = args.filter(a => a !== '--revert');

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

try {
  console.log('[reveal-fog] connecting…');
  await f.connect();
  console.log('[reveal-fog] connected\n');

  const result = await f.evaluate(
    async ({ sceneArgs, revert }) => {
      // Resolve target scenes: explicit ids/names, else every tomcartos-ostenwold import.
      const scenes = sceneArgs.length
        ? sceneArgs.map(a => game.scenes.get(a) ?? game.scenes.getName(a)).filter(Boolean)
        : game.scenes.filter(
            s => s.flags?.['tom-cartos-import']?.sourceModule === 'tomcartos-ostenwold'
          );
      if (!scenes.length) return { error: 'no matching scenes' };

      // A tiny solid-white texture: the exploration sprite stretches it over the whole fog
      // canvas, marking every pixel explored.
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 256, 256);
      const white = c.toDataURL('image/png');

      const report = [];
      for (const scene of scenes) {
        const line = { scene: scene.name, id: scene.id, created: 0, reset: false, errors: [] };
        // Existing fog docs for this scene (server query — the collection isn't preloaded).
        let existing = [];
        try {
          existing = await FogExploration.database.get(FogExploration, {
            query: { scene: scene.id },
            broadcast: false,
          });
        } catch (e) {
          line.errors.push(`query: ${e.message}`);
        }

        // Pre-existing docs (a user's real exploration, or a prior seed) can't be updated or
        // deleted through the client collection — it only holds the CURRENT user's fog. The one
        // supported whole-scene wipe is Foundry's own Reset Fog: view the scene, canvas.fog.reset().
        if (existing.length || revert) {
          try {
            await scene.view();
            await canvas.fog.reset();
            line.reset = true;
          } catch (e) {
            line.errors.push(`reset: ${e.message}`);
            report.push(line);
            continue;
          }
        }
        if (revert) {
          report.push(line);
          continue;
        }

        for (const user of game.users.contents) {
          try {
            await FogExploration.create({ scene: scene.id, user: user.id, explored: white });
            line.created++;
          } catch (e) {
            line.errors.push(`${user.name}: ${e.message}`);
          }
        }
        report.push(line);
      }
      return { report, users: game.users.contents.map(u => u.name) };
    },
    { sceneArgs, revert }
  );

  if (result.error) throw new Error(result.error);
  if (!revert) console.log(`users seeded: ${result.users.join(', ')}\n`);
  let errors = 0;
  for (const line of result.report) {
    const verb = revert
      ? `fog reset${line.reset ? '' : ' FAILED'}`
      : `${line.reset ? 'fog reset, ' : ''}created ${line.created}`;
    console.log(`  ${line.errors.length ? 'WARN' : 'OK  '}  ${line.scene} (${line.id}) — ${verb}`);
    for (const err of line.errors) {
      console.log(`          ! ${err}`);
      errors++;
    }
  }
  console.log(
    `\n==== reveal-scene-fog: ${errors ? `${errors} error(s)` : revert ? 'REVERTED' : 'SEEDED'} ====`
  );
  process.exitCode = errors ? 1 : 0;
} finally {
  await f.dispose().catch(() => {});
}
