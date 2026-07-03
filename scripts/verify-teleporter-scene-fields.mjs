// Live verification for Phase 0 (teleporter destinations ARRAY) + Phase 0b (update-scene parity).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart) and asserts, against the live
// v14.364 schema, the two correctness fixes (+ the two live bugs they surfaced):
//   Phase 0  — createSceneTeleporter writes the `system.destinations` field (a SetField — the live
//              model value is a Set); the region round-trips it; and remapSceneTeleporters ACTUALLY
//              REWRITES it. Two bugs this caught & fixed: (1) reads assumed a plain Array, missing the
//              live Set; (2) `flagOf` used `doc.getFlag(scope,…)`, which THROWS for any scene lacking
//              the tom-cartos scope — so remap threw on the whole world and never ran.
//   Phase 0b — updateScene deep-merges environment{} / fog{} / initial{} camera / flags onto an EXISTING
//              scene (parity with create-scene), and a partial mood patch LAYERS on (doesn't clobber a
//              previously-set flat knob).
// All fixtures are throwaway scenes, deleted in `finally`.
//
// Build first: npm run build.  Run: node scripts/verify-teleporter-scene-fields.mjs
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

const TAG = 'ZZ-TELE-SCENE-IT';
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

const created = { sceneIds: [] };

try {
  console.log('[verify-tele] connecting…');
  await f.connect();
  console.log('[verify-tele] connected\n');

  // ---- Phase 0 · A: createSceneTeleporter writes the destinations ARRAY ----
  console.log('# A: create-teleporter writes system.destinations[] and round-trips it');
  const scn = await f.evaluate(async tag => {
    const a = await Scene.create({
      name: `${tag} From`,
      width: 1000,
      height: 1000,
      navigation: false,
    });
    const b = await Scene.create({
      name: `${tag} To`,
      width: 1000,
      height: 1000,
      navigation: false,
    });
    return { fromId: a.id, toId: b.id };
  }, TAG);
  created.sceneIds.push(scn.fromId, scn.toId);

  const tele = await f.call('createSceneTeleporter', {
    from: { sceneIdentifier: scn.fromId, x: 300, y: 300 },
    to: { sceneIdentifier: scn.toId, x: 500, y: 500 },
    twoWay: true,
  });
  assert(
    Array.isArray(tele?.from?.behaviors?.[0]?.destinations) &&
      tele.from.behaviors[0].destinations[0] === `Scene.${scn.toId}.Region.${tele.to.id}`,
    'A — returned from-region reports destinations[] pointing at the to-region'
  );
  assert(
    tele?.to?.behaviors?.[0]?.destinations?.[0] === `Scene.${scn.fromId}.Region.${tele.from.id}`,
    'A — returned to-region reports the return destinations[]'
  );
  // Read the LIVE stored behavior. `system.destinations` is a SetField, so spread it page-side (a Set
  // serializes as {} across the bridge). The field must be `destinations` (plural), not the old singular.
  const liveShape = await f.evaluate(
    ({ sceneId, regionId }) => {
      const region = game.scenes.get(sceneId).regions.get(regionId);
      const sys = region.behaviors.contents[0]?.system;
      return {
        destinations: sys?.destinations ? [...sys.destinations] : null,
        isSet: sys?.destinations instanceof Set,
        singular: sys?.destination,
      };
    },
    { sceneId: scn.fromId, regionId: tele.from.id }
  );
  assert(
    liveShape.isSet && liveShape.destinations?.length === 1,
    `A — live behavior stores a destinations SET of 1 (got ${JSON.stringify(liveShape.destinations)})`
  );

  // ---- Phase 0 · B: remapSceneTeleporters REWRITES an array destination ----
  console.log('\n# B: remap-teleporters rewrites array-shaped destinations (the no-op bug)');
  const fx = await f.evaluate(async tag => {
    const rect = {
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      rotation: 0,
      hole: false,
    };
    const flag = (sourceId, sourceModule) =>
      sourceModule
        ? { 'tom-cartos-import': { sourceModule, sourceId } }
        : { 'tom-cartos-import': { sourceId } };
    const sceneA = await Scene.create({
      name: `${tag} Remap A`,
      width: 1000,
      height: 1000,
      navigation: false,
      flags: flag('oldSceneAAAAAAAA', tag),
    });
    const sceneB = await Scene.create({
      name: `${tag} Remap B`,
      width: 1000,
      height: 1000,
      navigation: false,
      flags: flag('oldSceneBBBBBBBB', tag),
    });
    // Each region's teleport points at the OTHER using STALE (old source) ids, in the ARRAY shape.
    const [regA] = await sceneA.createEmbeddedDocuments('Region', [
      {
        name: 'A tele',
        shapes: [rect],
        flags: flag('oldRegAAAAAAAAAA'),
        behaviors: [
          {
            name: 't',
            type: 'teleportToken',
            system: {
              destinations: ['Scene.oldSceneBBBBBBBB.Region.oldRegBBBBBBBBBB'],
              choice: false,
            },
          },
        ],
      },
    ]);
    const [regB] = await sceneB.createEmbeddedDocuments('Region', [
      {
        name: 'B tele',
        shapes: [rect],
        flags: flag('oldRegBBBBBBBBBB'),
        behaviors: [
          {
            name: 't',
            type: 'teleportToken',
            system: {
              destinations: ['Scene.oldSceneAAAAAAAA.Region.oldRegAAAAAAAAAA'],
              choice: false,
            },
          },
        ],
      },
    ]);
    return { sceneAId: sceneA.id, sceneBId: sceneB.id, regAId: regA.id, regBId: regB.id };
  }, TAG);
  created.sceneIds.push(fx.sceneAId, fx.sceneBId);

  const remap = await f.call('remapSceneTeleporters', { sourceModule: TAG });
  assert(remap?.rewritten === 2, `B — remap rewrote 2 destinations (got ${remap?.rewritten})`);
  assert((remap?.unresolved?.length ?? 0) === 0, 'B — no unresolved destinations');
  const remapped = await f.evaluate(({ sceneAId, regAId, sceneBId, regBId }) => {
    // Spread the destinations SET page-side (a Set serializes as {} across the bridge).
    const dest = (sId, rId) => [
      ...game.scenes.get(sId).regions.get(rId).behaviors.contents[0].system.destinations,
    ];
    return {
      a: dest(sceneAId, regAId),
      b: dest(sceneBId, regBId),
      wantA: `Scene.${sceneBId}.Region.${regBId}`,
      wantB: `Scene.${sceneAId}.Region.${regAId}`,
    };
  }, fx);
  assert(
    remapped.a?.[0] === remapped.wantA,
    `B — A→B destination rewritten to live ids (${remapped.a?.[0]})`
  );
  assert(
    remapped.b?.[0] === remapped.wantB,
    `B — B→A destination rewritten to live ids (${remapped.b?.[0]})`
  );

  // ---- Phase 0b · C: update-scene deep-merges mood / camera / flags ----
  console.log('\n# C: update-scene deep-merges environment/fog/initial/flags (parity + layering)');
  const usId = await f.evaluate(async tag => {
    const s = await Scene.create({
      name: `${tag} UpdateFields`,
      width: 800,
      height: 600,
      navigation: false,
    });
    return s.id;
  }, TAG);
  created.sceneIds.push(usId);

  // First set a FLAT knob (globalLight → environment.globalLight.enabled).
  await f.call('updateScene', { sceneIdentifier: usId, globalLight: true });
  // Then a partial environment OBJECT + fog + camera + flags — must LAYER on, not clobber globalLight.
  await f.call('updateScene', {
    sceneIdentifier: usId,
    environment: { darknessLevel: 0.7 },
    fog: { exploration: false },
    initial: { x: 1234, y: 567, scale: 0.5 },
    flags: { [TAG]: { note: 'hello' } },
  });
  const us = await f.evaluate(id => {
    const s = game.scenes.get(id);
    const o = s.toObject();
    return {
      darkness: o.environment?.darknessLevel,
      globalLight: o.environment?.globalLight?.enabled,
      fogExploration: o.fog?.exploration,
      initial: o.initial,
      flag: o.flags?.[Object.keys(o.flags).find(k => k.startsWith('ZZ-')) ?? ''],
    };
  }, usId);
  assert(us.darkness === 0.7, `C — environment.darknessLevel set (${us.darkness})`);
  assert(
    us.globalLight === true,
    'C — earlier flat globalLight SURVIVED the later environment patch (deep-merge)'
  );
  assert(
    us.initial?.x === 1234 && us.initial?.scale === 0.5,
    `C — saved camera round-tripped (${JSON.stringify(us.initial)})`
  );
  assert(us.flag?.note === 'hello', 'C — document flag stamped on update');
} catch (e) {
  fails++;
  console.log(`\n[verify-tele] FATAL: ${e?.stack || e?.message || String(e)}`);
} finally {
  if (created.sceneIds.length) {
    try {
      await f.evaluate(async ids => {
        for (const id of ids) await game.scenes.get(id)?.delete();
      }, created.sceneIds);
      console.log('\n[verify-tele] cleaned up fixture scenes');
    } catch (e) {
      console.log(`\n[verify-tele] cleanup note: ${e?.message || e}`);
    }
  }
  await f.dispose?.();
}

console.log(
  `\n==== teleporter + scene-fields verification: ${passes} passed, ${fails} failed ====`
);
process.exit(fails > 0 ? 1 : 0);
