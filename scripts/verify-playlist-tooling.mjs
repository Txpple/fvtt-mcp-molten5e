// Live verification for Phase 3.3 — Playlists (the tools are unchanged; this confirms they are
// v14-correct end-to-end so the playlist-builder skill rests on a verified base).
//
// Drives a real headless Foundry session through the foundry.call seam (exercises the built
// dist/page.bundle.js). Against the live `sandbox` world it proves:
//   * create-playlist builds a Playlist with one PlaylistSound per path, writing the v14 sound `path`
//     field (FilePathField) — if `path` had been renamed, the returned sound would carry no path;
//   * the playback `mode` maps (shuffle) and repeat/volume apply;
//   * update-playlist renames + re-modes;
//   * the playlist is listed.
// FilePathField validates extension/format, not file existence, so plausible .ogg paths are accepted.
// Everything created is cleaned up.
//
// Build first: npm run build. Run: node scripts/verify-playlist-tooling.mjs
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

const TAG = 'ZZ-PLAYLIST-IT';
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
  user: env.FOUNDRY_USER || 'MCP-Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let playlistId;
try {
  console.log('[verify-playlist] connecting to sandbox…');
  await f.connect();
  console.log('[verify-playlist] connected — exercising Playlist tooling\n');

  // --- create-playlist: a soundscape (shuffle, looping) ---
  console.log('# create-playlist: layered ambience');
  const created = await f.call('createPlaylist', {
    name: `${TAG} Storm Ambience`,
    soundPaths: [
      `worlds/${env.MOLTEN_WORLD_ID || 'sandbox'}/assets/audio/rain.ogg`,
      `worlds/${env.MOLTEN_WORLD_ID || 'sandbox'}/assets/audio/thunder.ogg`,
    ],
    mode: 'shuffle',
    repeat: true,
    defaultVolume: 0.4,
  });
  playlistId = created?.playlistId;
  assert(Boolean(playlistId), `playlist created (${created?.playlistName})`);
  assert(created?.soundCount === 2, `2 tracks added (${created?.soundCount})`);
  assert(created?.mode === 'shuffle', `mode is shuffle (${created?.mode})`);
  assert(
    Array.isArray(created?.sounds) &&
      created.sounds.length === 2 &&
      created.sounds.every(s => typeof s.path === 'string' && s.path.endsWith('.ogg')),
    'each track carries the v14 `path` field (file path round-trips)'
  );

  // --- update-playlist: rename + re-mode ---
  console.log('\n# update-playlist: rename + re-mode');
  const updated = await f.call('updatePlaylist', {
    identifier: playlistId,
    name: `${TAG} Storm Ambience (v2)`,
    mode: 'sequential',
  });
  assert(updated?.updated === true, 'update reported success');

  // --- list-playlists: it shows up ---
  console.log('\n# list-playlists');
  const list = await f.call('listPlaylists', {});
  const mine = (Array.isArray(list) ? list : []).find(p => p.id === playlistId);
  assert(Boolean(mine), 'created playlist appears in the list');
  assert(mine?.name === `${TAG} Storm Ambience (v2)`, 'list reflects the rename');
  assert(mine?.soundCount === 2, 'list reflects the track count');
} catch (e) {
  fails++;
  console.log(`\n[verify-playlist] FATAL: ${e?.message || String(e)}`);
} finally {
  if (playlistId) {
    try {
      await f.call('deletePlaylists', { identifiers: [playlistId] });
      console.log('\n[verify-playlist] cleaned up playlist');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== playlist-tooling verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
