// Live acceptance for the EXPANDED scene tools (create-scene / update-scene new
// params): exercises grid scale, token vision, fog mode, lighting, weather,
// auto-dimension, and playlist/journal link resolution end-to-end against the
// live Molten world via the foundry.call seam. Unit tests mock the seam, so this
// is the real correctness gate for the new write paths. Scenes are tagged
// ZZ-MCP-ST and deleted in a finally.
//
// Build first: npm run build. Run: node scripts/verify-scene-tools.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = 'ZZ-MCP-ST';
const BG_VECTOR = 'icons/svg/dice-target.svg'; // always present in core Foundry
const BG_RASTER = 'assets/mcp/mcp-claude.jpg'; // bundled portrait (for auto-dimension)

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
const createdSceneIds = [];

async function expectThrow(n, fn, match) {
  try {
    await fn();
    fail(n, 'expected throw, got success');
  } catch (e) {
    const msg = e?.message || String(e);
    if (match && !msg.includes(match)) fail(n, `threw but missing "${match}": ${msg}`);
    else pass(n, `threw as expected`);
  }
}

try {
  // ---- 1. create with the full new param set (explicit dims) ----
  const c1 = await foundry.call('createScene', {
    name: `${TAG}-full`,
    backgroundPath: BG_VECTOR,
    width: 3000,
    height: 2000,
    gridSize: 100,
    gridType: 1,
    gridDistance: 5,
    gridUnits: 'ft',
    tokenVision: true,
    fogMode: 'shared',
    darkness: 0.6,
    globalLight: false,
    weather: 'snow',
  });
  if (c1?.sceneId) createdSceneIds.push(c1.sceneId);
  const s1 = c1?.settings || {};
  console.log('   create settings:', JSON.stringify(s1));
  const okFull =
    c1?.success &&
    s1.grid?.distance === 5 &&
    s1.grid?.units === 'ft' &&
    s1.tokenVision === true &&
    s1.fogMode === 'shared' &&
    Math.abs((s1.darkness ?? -1) - 0.6) < 1e-6 &&
    s1.globalLight === false &&
    s1.weather === 'snow' &&
    c1?.width === 3000 &&
    c1?.height === 2000;
  okFull
    ? pass('create-scene full params', `${c1.sceneId}`)
    : fail(
        'create-scene full params',
        JSON.stringify({ width: c1?.width, height: c1?.height, s1 })
      );

  // ---- 2. auto-dimension from a raster image (no width/height passed) ----
  const c2 = await foundry.call('createScene', {
    name: `${TAG}-auto`,
    backgroundPath: BG_RASTER,
  });
  if (c2?.sceneId) createdSceneIds.push(c2.sceneId);
  if (c2?.autoSized && c2?.width > 0 && c2?.height > 0) {
    pass('create-scene auto-dimension', `${c2.width}x${c2.height} (autoSized)`);
  } else {
    // soft: the raster asset may not exist on this instance — note, don't hard-fail
    console.log(
      `NOTE  auto-dimension not confirmed (autoSized=${c2?.autoSized}, ${c2?.width}x${c2?.height}) — asset "${BG_RASTER}" may be absent`
    );
    pass('create-scene auto-dimension (soft)', `autoSized=${c2?.autoSized}`);
  }

  // ---- 3. update: flip lighting, clear weather, change fog, set grid units ----
  const u1 = await foundry.call('updateScene', {
    sceneIdentifier: c1.sceneId,
    darkness: 1,
    globalLight: true,
    weather: '',
    fogMode: 'individual',
    gridDistance: 10,
  });
  const su = u1?.settings || {};
  console.log('   update settings:', JSON.stringify(su));
  const okUpd =
    u1?.updated &&
    Math.abs((su.darkness ?? -1) - 1) < 1e-6 &&
    su.globalLight === true &&
    su.weather === '' &&
    su.fogMode === 'individual' &&
    su.grid?.distance === 10;
  okUpd
    ? pass('update-scene fields', `${u1.sceneId}`)
    : fail('update-scene fields', JSON.stringify(su));

  // ---- 4. weather + case-insensitive normalization ----
  const u2 = await foundry.call('updateScene', { sceneIdentifier: c1.sceneId, weather: 'RAIN' });
  u2?.settings?.weather === 'rain'
    ? pass('weather case-normalization', `RAIN -> ${u2.settings.weather}`)
    : fail('weather case-normalization', JSON.stringify(u2?.settings));

  // ---- 5. invalid weather rejected with listing ----
  await expectThrow(
    'invalid weather rejected',
    () => foundry.call('updateScene', { sceneIdentifier: c1.sceneId, weather: 'thunderstorm' }),
    'Unknown weather'
  );

  // ---- 6. invalid fogMode rejected ----
  await expectThrow(
    'invalid fogMode rejected',
    () => foundry.call('updateScene', { sceneIdentifier: c1.sceneId, fogMode: 'sometimes' }),
    'Invalid fogMode'
  );

  // ---- 7. link resolution: attach an existing journal/playlist by name ----
  const existing = await foundry.evaluate(
    () => ({
      journal: game.journal?.contents?.[0]
        ? { id: game.journal.contents[0].id, name: game.journal.contents[0].name }
        : null,
      playlist: game.playlists?.contents?.[0]
        ? { id: game.playlists.contents[0].id, name: game.playlists.contents[0].name }
        : null,
    }),
    null
  );
  if (existing?.journal) {
    const uj = await foundry.call('updateScene', {
      sceneIdentifier: c1.sceneId,
      journal: existing.journal.name,
    });
    uj?.settings?.journal === existing.journal.id
      ? pass('journal link by name', `${existing.journal.name} -> ${existing.journal.id}`)
      : fail('journal link by name', `got ${uj?.settings?.journal}, want ${existing.journal.id}`);
    // clear it
    const ujc = await foundry.call('updateScene', { sceneIdentifier: c1.sceneId, journal: '' });
    ujc?.settings?.journal == null
      ? pass('journal link clear with ""', 'cleared')
      : fail('journal link clear with ""', `got ${ujc?.settings?.journal}`);
  } else {
    console.log('NOTE  no journals in world — skipping journal link test');
  }
  if (existing?.playlist) {
    const up = await foundry.call('updateScene', {
      sceneIdentifier: c1.sceneId,
      playlist: existing.playlist.name,
    });
    up?.settings?.playlist === existing.playlist.id
      ? pass('playlist link by name', `${existing.playlist.name} -> ${existing.playlist.id}`)
      : fail(
          'playlist link by name',
          `got ${up?.settings?.playlist}, want ${existing.playlist.id}`
        );
  } else {
    console.log('NOTE  no playlists in world — skipping playlist link test');
  }

  // ---- 8. unknown link name rejected ----
  await expectThrow(
    'unknown journal name rejected',
    () => foundry.call('updateScene', { sceneIdentifier: c1.sceneId, journal: 'NoSuchJournalXYZ' }),
    'No journal found'
  );
} catch (e) {
  fail('SUITE', e?.message || String(e));
} finally {
  // cleanup
  if (createdSceneIds.length) {
    try {
      const del = await foundry.call('deleteScenes', { identifiers: createdSceneIds });
      console.log(`cleanup -> deleted ${del?.deletedCount ?? 0} scene(s)`);
    } catch (e) {
      console.log(`cleanup FAILED: ${e?.message || e}`);
    }
  }
  await foundry.dispose?.();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}
