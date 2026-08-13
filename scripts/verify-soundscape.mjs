// Live verification of house module #6, fvtt-mod-soundscape — module active, api surface,
// and the engine actually scheduling on a real client.
//
// The engine waits on game.audio.unlock (the browser autoplay gate) before scheduling.
// Real players cross it with their first click; a headless client never would — so this
// script fires one synthetic Playwright click (trusted input) right after connect. Without
// it, status().running staying empty would be the autoplay gate, not a module bug.
//
// Creates ZZ-prefixed sound sets on the CURRENT scene via the module's own api (volume
// 0.01 — the box is inaudible anyway, but be polite) and removes them in `finally`.
//
// Build first if dist is stale: npm run build.  Run: node scripts/verify-soundscape.mjs
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

let passes = 0;
let fails = 0;
function assert(cond, msg, detail = '') {
  if (cond) {
    passes++;
    console.log(`  PASS  ${msg}`);
  } else {
    fails++;
    console.log(`  FAIL  ${msg}${detail ? ` — ${detail}` : ''}`);
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

const IDS = ['zz-verify-interval', 'zz-verify-loop', 'zz-verify-gated'];

try {
  console.log('[verify-soundscape] connecting…');
  await f.connect();
  // Trusted gesture for the autoplay gate, then a beat for unlock → canvasReady sync.
  await f.page.mouse.click(4, 4);
  await new Promise(r => setTimeout(r, 1500));
  console.log('[verify-soundscape] connected\n');

  const info = await f.evaluate(() => {
    const m = game.modules.get('fvtt-mod-soundscape');
    return {
      active: !!m?.active,
      apiKeys: m?.api ? Object.keys(m.api).sort() : [],
      scene: canvas?.scene?.name ?? null,
      darkness: canvas?.scene?.environment?.darknessLevel ?? canvas?.scene?.darkness ?? 0,
      audioState: game.audio?.environment?.state ?? 'no-context',
      testFile: game.playlists.contents.flatMap(p => p.sounds.contents)[0]?.path ?? null,
    };
  }, null);

  console.log(
    `scene="${info.scene}" darkness=${info.darkness} audio=${info.audioState} ` +
      `testFile=${info.testFile}\n`
  );
  assert(info.active, 'module is installed and ACTIVE in the world');
  assert(
    ['getSets', 'open', 'removeSet', 'status', 'upsertSet'].every(k => info.apiKeys.includes(k)),
    `api surface complete (${info.apiKeys.join(', ')})`
  );
  assert(
    info.audioState === 'running',
    'environment audio context unlocked by the gesture',
    info.audioState
  );
  assert(!!info.testFile, 'found a playlist audio file to schedule with');
  if (!info.testFile || !info.active) throw new Error('cannot continue the dynamic checks');

  // An always-on interval set, an always-on loop bed, and a set gated to whichever side of
  // day/night the scene is currently NOT on — it must stay stopped.
  const wrongSide = info.darkness >= 0.5 ? 'day' : 'night';
  const r1 = await f.evaluate(
    async ({ file, wrongSide }) => {
      const api = game.modules.get('fvtt-mod-soundscape').api;
      const scene = canvas.scene;
      await api.upsertSet(scene, {
        id: 'zz-verify-interval',
        name: 'ZZ Verify Interval',
        files: [file],
        interval: 2,
        intervalVariation: 0,
        volume: 0.01,
      });
      await api.upsertSet(scene, {
        id: 'zz-verify-loop',
        name: 'ZZ Verify Loop',
        files: [file],
        playStyle: 'loop',
        crossfade: 1,
        volume: 0.01,
      });
      await api.upsertSet(scene, {
        id: 'zz-verify-gated',
        name: 'ZZ Verify Gated',
        files: [file],
        interval: 2,
        volume: 0.01,
        whenToPlay: wrongSide,
      });
      await new Promise(r => setTimeout(r, 1000)); // let the updateScene resync land
      return { stored: api.getSets(scene).map(s => s.id), status: api.status() };
    },
    { file: info.testFile, wrongSide }
  );

  assert(
    IDS.every(id => r1.stored.includes(id)),
    `all three sets stored in scene flags (${r1.stored.length} total)`
  );
  assert(r1.status.running.includes('zz-verify-interval'), 'interval scheduler RUNNING');
  assert(r1.status.running.includes('zz-verify-loop'), 'loop scheduler RUNNING');
  assert(
    !r1.status.running.includes('zz-verify-gated'),
    `${wrongSide}-gated set correctly stopped at darkness ${info.darkness}`
  );

  // Let the interval set tick a few times and the bed hold, then look again.
  await new Promise(r => setTimeout(r, 6000));
  const r2 = await f.evaluate(() => game.modules.get('fvtt-mod-soundscape').api.status(), null);
  assert(
    r2.running.includes('zz-verify-interval') && r2.running.includes('zz-verify-loop'),
    'schedulers still alive after 6s of ticking'
  );

  // Flip the gate by moving scene darkness across 0.5 — the gated set must start.
  const flipped = info.darkness >= 0.5 ? 0.1 : 0.9;
  const r3 = await f.evaluate(async darkness => {
    await canvas.scene.update({ environment: { darknessLevel: darkness } });
    await new Promise(r => setTimeout(r, 800));
    return game.modules.get('fvtt-mod-soundscape').api.status();
  }, flipped);
  assert(
    r3.running.includes('zz-verify-gated'),
    `darkness flip to ${flipped} starts the gated set`
  );
  await f.evaluate(async darkness => {
    await canvas.scene.update({ environment: { darknessLevel: darkness } });
  }, info.darkness);
} catch (err) {
  fails++;
  console.error(`\nERROR: ${err?.message || err}`);
} finally {
  try {
    const left = await f.evaluate(async ids => {
      const api = game.modules.get('fvtt-mod-soundscape')?.api;
      if (!api) return null;
      for (const id of ids) await api.removeSet(canvas.scene, id);
      await new Promise(r => setTimeout(r, 600));
      return { sets: api.getSets(canvas.scene).length, status: api.status() };
    }, IDS);
    if (left) {
      assert(
        !left.status.running.some(id => IDS.includes(id)),
        `cleanup: verify sets removed and stopped (${left.sets} set(s) remain on the scene)`
      );
    }
  } catch (err) {
    console.error(`cleanup failed: ${err?.message || err}`);
  }
  await f.close?.();
  console.log(`\n[verify-soundscape] ${passes} pass, ${fails} fail`);
  process.exit(fails ? 1 : 0);
}
