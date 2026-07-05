// Live verification for the region/teleporter authoring tools (create/list/update/delete regions on an
// EXISTING scene + the two-way teleporter convenience). Drives a real headless Foundry session (fresh
// dist/, no CC restart). Creates two throwaway scenes, wires a two-way teleporter between them, and
// asserts: both regions exist, each teleportToken destination cross-links the OTHER region, the trigger
// rectangles snap to the grid (padding-aware), update-region's rect resizes a trigger, create-region
// makes a plain region, list-regions sees them, delete-region removes one, and twoWay:false leaves no
// return link. Everything is cleaned up in `finally` (deleting the scenes removes their regions).
//
// Build first: npm run build. Run: node scripts/verify-region-tooling.mjs
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

const TAG = 'ZZ-REGION-IT';
const BG =
  'worlds/the-broken-heart-of-greenrest/assets/tom-cartos/tomcartos-troll-bridge/maps/TC_Troll Bridge Wreckage_No Grid_22x17.webp';
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

const created = [];

try {
  console.log('[verify-region] connecting…');
  await f.connect();
  console.log('[verify-region] connected\n');

  console.log('# create two throwaway scenes (A: no padding, B: 0.05 padding)');
  const a = await f.call('createScene', {
    name: `${TAG} A`,
    backgroundPath: BG,
    width: 3080,
    height: 2380,
    gridSize: 140,
    padding: 0,
    navigation: false,
  });
  const b = await f.call('createScene', {
    name: `${TAG} B`,
    backgroundPath: BG,
    width: 4760,
    height: 4620,
    gridSize: 140,
    padding: 0.05,
    navigation: false,
  });
  const aId = a?.sceneId ?? a?.id;
  const bId = b?.sceneId ?? b?.id;
  if (!aId || !bId) throw new Error('scene create failed');
  created.push(aId, bId);

  console.log('\n# two-way teleporter A(910,1740) ⇄ B(851,881), 1×1 cell, grid-snapped');
  const tp = await f.call('createSceneTeleporter', {
    from: { sceneIdentifier: aId, x: 910, y: 1740 },
    to: { sceneIdentifier: bId, x: 851, y: 881 },
  });
  assert(tp?.twoWay === true, 'reports two-way');
  const fromId = tp?.from?.id;
  const toId = tp?.to?.id;
  assert(!!fromId && !!toId, 'both endpoint regions created');
  const fromDest = tp?.from?.behaviors?.find(x => x.destinations?.length)?.destinations?.[0];
  const toDest = tp?.to?.behaviors?.find(x => x.destinations?.length)?.destinations?.[0];
  assert(
    fromDest === `Scene.${bId}.Region.${toId}`,
    `A→B teleport points at B's region (${fromDest})`
  );
  assert(
    toDest === `Scene.${aId}.Region.${fromId}`,
    `B→A teleport points at A's region (${toDest})`
  );
  const fs = tp?.from?.shapes?.[0];
  assert(
    fs?.x === 840 && fs?.y === 1680 && fs?.width === 140 && fs?.height === 140,
    `A trigger snaps to cell (840,1680,140,140) — got (${fs?.x},${fs?.y},${fs?.width},${fs?.height})`
  );
  const ts = tp?.to?.shapes?.[0];
  assert(
    ts?.x === 840 && ts?.y === 840 && ts?.width === 140 && ts?.height === 140,
    `B trigger snaps padding-aware to (840,840,140,140) — got (${ts?.x},${ts?.y},${ts?.width},${ts?.height})`
  );

  console.log('\n# update-region: widen B trigger to 3 cells (centered on its cell)');
  // Kernel contract (post-retrofit): batch patches keyed by id; updated docs come back in items[].
  const up = await f.call('updateSceneRegions', {
    sceneIdentifier: bId,
    patches: [{ id: toId, rect: { x: 910, y: 910, widthCells: 3 } }],
  });
  const us = up?.items?.[0]?.shapes?.[0];
  assert(
    us?.x === 700 && us?.width === 420 && us?.y === 840 && us?.height === 140,
    `resized to 3 cells wide (700,840,420,140) — got (${us?.x},${us?.y},${us?.width},${us?.height})`
  );

  console.log('\n# create-region: a plain rectangle region on A');
  const cr = await f.call('createSceneRegions', {
    sceneIdentifier: aId,
    items: [
      {
        name: `${TAG} Trap`,
        color: '#ff3333',
        shapes: [
          { type: 'rectangle', x: 100, y: 100, width: 280, height: 280, rotation: 0, hole: false },
        ],
      },
    ],
  });
  assert(cr?.created === 1, 'created 1 plain region');
  const trapId = cr?.items?.[0]?.id;
  assert(!!trapId, 'plain region has an id');

  console.log('\n# list-regions: A now has the teleporter + the trap');
  const list = await f.call('listSceneRegions', { sceneIdentifier: aId });
  assert(
    Array.isArray(list?.items) && list.items.length === 2,
    `A lists 2 regions (got ${list?.items?.length})`
  );
  assert(
    list.items.some(r => r.id === trapId),
    'list includes the trap region'
  );
  assert(
    list.items.some(r => r.id === fromId),
    'list includes the teleporter region'
  );

  console.log('\n# delete-region: remove the trap, teleporter remains');
  const del = await f.call('deleteSceneRegions', { sceneIdentifier: aId, ids: [trapId] });
  assert(del?.deleted === 1, 'deleted 1 region');
  const list2 = await f.call('listSceneRegions', { sceneIdentifier: aId });
  assert(list2?.items?.length === 1 && list2.items[0].id === fromId, 'only the teleporter remains');

  console.log('\n# one-way teleporter (twoWay:false) leaves no return link');
  const one = await f.call('createSceneTeleporter', {
    from: { sceneIdentifier: aId, x: 300, y: 300 },
    to: { sceneIdentifier: bId, x: 500, y: 500 },
    twoWay: false,
  });
  assert(one?.twoWay === false, 'reports one-way');
  assert(
    !!one?.from?.behaviors?.find(x => x.destinations?.length),
    'one-way from-side has a teleport'
  );
  assert(
    !one?.to?.behaviors?.some(x => x.destinations?.length),
    'one-way to-side has NO return teleport'
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-region] FATAL: ${e?.message || String(e)}`);
} finally {
  if (created.length) {
    try {
      await f.call('deleteScenes', { identifiers: created });
      console.log('\n[verify-region] cleaned up throwaway scenes');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== region-tooling verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
