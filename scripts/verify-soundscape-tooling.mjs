// LIVE acceptance for configure-soundscape (house module #6, fvtt-mod-soundscape).
//
// Driven through the TOOL REGISTRY, not the page seam — the set-landing-scene lesson was that a
// tool is not done when the page function returns the data, it is done when the FORMATTER shows
// it (list-users returned `landingScene` and never printed it). So every check below asserts on
// the string a caller actually reads back, with the zod parse in front of it.
//
// The load-bearing claim under test is the MIRROR: src/page/soundscape.ts re-implements the
// module's own scripts/engine.js#normalizeSet so the tool can report clamps. Check "mirror" reads
// the sets back through the MODULE's api and asserts the module agrees field-for-field with what
// the tool wrote — if that ever drifts, this is where it surfaces.
//
// SAFE: it snapshots the target scene's soundscape flag and restores it in `finally`, so the
// scene ends exactly as it started. Defaults to the LOCAL sandbox; --prod targets Molten.
//
// Build first: npm run build.
// Run: node scripts/verify-soundscape-tooling.mjs [--prod] [--scene "<name>"]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';
import { buildToolRegistry } from '../dist/registry.js';
import { Logger } from '../dist/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const argv = process.argv.slice(2);
const prod = argv.includes('--prod');
const sceneIdx = argv.indexOf('--scene');
const sceneArg = sceneIdx >= 0 ? argv[sceneIdx + 1] : null;

const MODULE_ID = 'fvtt-mod-soundscape';
// Seeded in the sandbox's Data root; its audio resolves, so the clean-add path is provable.
const RESOLVING_TEMPLATE = 'Combat Muffled 1';

const f = new Foundry(
  prod
    ? {
        serverUrl: env.MOLTEN_SERVER_URL,
        magicUrl: env.MOLTEN_MAGIC_URL,
        user: env.FOUNDRY_USER || 'DM Assistant',
        password: env.FOUNDRY_PASSWORD,
        adminKey: env.MOLTEN_ADMIN_KEY,
        worldId: env.MOLTEN_WORLD_ID,
      }
    : {
        serverUrl: env.LOCAL_SERVER_URL || 'http://localhost:30000',
        user: env.LOCAL_FOUNDRY_USER || env.FOUNDRY_USER || 'DM Assistant',
        password: env.LOCAL_FOUNDRY_PASSWORD ?? env.FOUNDRY_PASSWORD,
        adminKey: env.LOCAL_ADMIN_KEY,
        worldId: env.LOCAL_WORLD_ID || env.MOLTEN_WORLD_ID,
      }
);

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? `\n        ${detail}` : ''}`);
  }
};
/** Assert the formatted output contains each fragment — the caller-visible contract. */
const contains = (label, out, ...fragments) => {
  const missing = fragments.filter(x => !out.includes(x));
  check(label, missing.length === 0, missing.length ? `missing: ${missing.join(' | ')}` : '');
};
const rejects = async (label, fn, pattern) => {
  try {
    await fn();
    check(label, false, 'expected a throw, got a result');
  } catch (err) {
    check(label, pattern.test(err.message), `message was: ${err.message}`);
  }
};

const registry = buildToolRegistry({
  foundry: f,
  logger: new Logger({ level: 'error', format: 'simple' }),
});
const call = args => registry.dispatch('configure-soundscape', args);

let scene = null;
let snapshot;

try {
  console.log(`\n[verify-soundscape] connecting to ${prod ? 'PROD' : 'the LOCAL sandbox'}…`);
  await f.connect();

  const world = await f.evaluate(
    () => ({
      user: game.user.name,
      scene: game.scenes.active?.name ?? null,
      module: (() => {
        const m = game.modules.get('fvtt-mod-soundscape');
        return m ? { installed: true, active: !!m.active, version: m.version } : { installed: false };
      })(),
    }),
    null
  );
  scene = sceneArg || world.scene;
  console.log(
    `[verify-soundscape] bridge=${world.user} · scene="${scene}" · module=${JSON.stringify(world.module)}\n`
  );
  if (!scene) throw new Error('No target scene — pass --scene "<name>".');

  // Snapshot, so the scene is handed back exactly as it was found.
  snapshot = await f.evaluate(
    ({ name, moduleId }) => {
      const s = game.scenes.get(name) || game.scenes.getName(name);
      return s ? (s.flags?.[moduleId]?.sets ?? null) : null;
    },
    { name: scene, moduleId: MODULE_ID }
  );
  console.log(`[verify-soundscape] snapshot: ${snapshot ? `${snapshot.length} set(s)` : 'no flag'}\n`);

  /* --- 1. list ------------------------------------------------------------------------------ */
  console.log('— list —');
  const list0 = await call({ action: 'list', sceneIdentifier: scene });
  contains('list names the scene and the module state', list0, scene, 'module');
  contains('list offers the verify flag when pools were not checked', list0, 'pass verifyFiles');

  /* --- 2. library --------------------------------------------------------------------------- */
  console.log('\n— library —');
  const lib = await call({ action: 'library' });
  contains(
    'library prints the catalog and both sections',
    lib,
    'Soundscape library',
    'Interval Sounds',
    'Ambient Loops',
    'Add one with action "add"'
  );
  const total = Number(/(\d+) template\(s\)/.exec(lib)?.[1] ?? 0);
  check(`library found ${total} templates`, total > 100, `only ${total} — is the Data-root manifest present?`);

  const libQ = await call({ action: 'library', query: 'tavern' });
  contains('library reports a filtered count', libQ, 'matching');

  const libTrunc = await call({ action: 'library', limit: 2 });
  contains('library names its truncation instead of quietly cutting', libTrunc, '…and', 'more');

  const libSection = await call({ action: 'library', section: 'Ambient Loops', limit: 5 });
  check(
    'library section filter excludes the other section from the matches',
    !libSection.split('\n\n')[1]?.includes('Interval Sounds'),
    'an Interval Sounds template survived an Ambient Loops filter'
  );

  /* --- 3. add from a template whose audio resolves ------------------------------------------- */
  console.log('\n— add (from library) —');
  const addLoop = await call({
    action: 'add',
    sceneIdentifier: scene,
    template: RESOLVING_TEMPLATE,
  });
  contains(
    'add copies the template and reports the resulting set',
    addLoop,
    `from library template "${RESOLVING_TEMPLATE}"`,
    'loop ·',
    'crossfade'
  );
  check(
    'a template whose audio resolves produces NO 404 warning',
    !addLoop.includes('was not found on the server'),
    addLoop
  );
  const loopId = /\(([a-z0-9]{4,12})\)/.exec(addLoop)?.[1];
  check('add reports the new set id', !!loopId, addLoop);

  /* --- 4. KEEP+WARN: a template whose audio is absent ---------------------------------------- */
  const absent = await f.evaluate(async ({ resolving }) => {
    const res = await fetch(foundry.utils.getRoute('soundscape-sfx/library.json'));
    const sets = (await res.json()).sets;
    // Any template other than the seeded one — the sandbox only carries audio for that one.
    return sets.find(s => s.name !== resolving && s.files?.length === 1)?.name ?? null;
  }, { resolving: RESOLVING_TEMPLATE });

  if (absent) {
    const addMissing = await call({ action: 'add', sceneIdentifier: scene, template: absent });
    contains(
      'a 404 audio path is KEPT and warned about, never swapped',
      addMissing,
      'was not found on the server',
      `from library template "${absent}"`
    );
  } else {
    check('KEEP+WARN probe found a template to test with', false, 'no single-file template available');
  }

  /* --- 5. add from explicit files ------------------------------------------------------------ */
  console.log('\n— add (explicit files) —');
  const addRaw = await call({
    action: 'add',
    sceneIdentifier: scene,
    name: 'VERIFY Crows',
    files: ['soundscape-sfx/ambient-loops/battle-and-unrest/combat-muffled-1.ogg'],
    playStyle: 'interval',
    interval: 40,
    intervalVariation: 10,
    whenToPlay: 'night',
    volume: 0.6,
  });
  contains(
    'explicit-file add reports interval timing and the gate',
    addRaw,
    'VERIFY Crows',
    'every 40 ± 10s',
    'night only',
    'vol 0.6'
  );
  await rejects(
    'add without template refuses without both name and files',
    () => call({ action: 'add', sceneIdentifier: scene, name: 'Nameless' }),
    /needs either `template`|both `name` and a non-empty `files`/
  );
  await rejects(
    'an unknown template names the closest matches instead of failing blankly',
    () => call({ action: 'add', sceneIdentifier: scene, template: 'Definitely Not A Real Set' }),
    /No library template named/
  );

  /* --- 6. update ----------------------------------------------------------------------------- */
  console.log('\n— update —');
  const upd = await call({
    action: 'update',
    sceneIdentifier: scene,
    setIdentifier: 'VERIFY Crows',
    volume: 0.3,
    whenToPlay: 'always',
  });
  contains('update lists the fields that actually changed', upd, 'changed:', 'volume', 'whenToPlay');

  const noop = await call({
    action: 'update',
    sceneIdentifier: scene,
    setIdentifier: 'VERIFY Crows',
    volume: 0.3,
  });
  contains('a patch matching the stored values reads as a no-op', noop, 'nothing actually changed');

  const clampOut = await call({
    action: 'update',
    sceneIdentifier: scene,
    setIdentifier: 'VERIFY Crows',
    interval: 9000,
  });
  contains('an out-of-range value is clamped AND reported', clampOut, 'clamped', 'interval 9000 → 3600');

  // Lowering the interval must drag an oversized variation down with it — the negative-gap trap.
  const clampVar = await call({
    action: 'update',
    sceneIdentifier: scene,
    setIdentifier: 'VERIFY Crows',
    interval: 6,
  });
  contains('lowering the interval re-clamps the variation', clampVar, 'intervalVariation');

  await rejects(
    'update with no fields refuses instead of writing nothing',
    () => call({ action: 'update', sceneIdentifier: scene, setIdentifier: 'VERIFY Crows' }),
    /named no fields to change/
  );
  await rejects(
    'an unknown set names what IS on the scene',
    () => call({ action: 'update', sceneIdentifier: scene, setIdentifier: 'Nope', volume: 0.5 }),
    /No sound set "Nope"/
  );

  /* --- 7. ambiguity is an error, not a coin flip ---------------------------------------------- */
  console.log('\n— ambiguity + verifyFiles —');
  await call({
    action: 'add',
    sceneIdentifier: scene,
    name: 'VERIFY Crows',
    files: ['soundscape-sfx/ambient-loops/battle-and-unrest/combat-muffled-1.ogg'],
  });
  await rejects(
    'a name matching two sets throws and names both ids',
    () => call({ action: 'update', sceneIdentifier: scene, setIdentifier: 'VERIFY Crows', volume: 0.9 }),
    /matches 2 sound sets/
  );

  /* --- 8. list with verifyFiles + idle reasons ------------------------------------------------ */
  const listFull = await call({ action: 'list', sceneIdentifier: scene, verifyFiles: true });
  contains('verifyFiles surfaces the missing pool files', listFull, 'missing file(s)');
  check(
    'verifyFiles suppresses the "pass verifyFiles" nudge',
    !listFull.includes('pass verifyFiles'),
    listFull
  );

  /* --- 9. THE MIRROR: the module agrees with what the tool wrote ------------------------------ */
  console.log('\n— mirror (module normalizeSet vs. ours) —');
  const mirror = await f.evaluate(
    ({ name, moduleId }) => {
      const s = game.scenes.get(name) || game.scenes.getName(name);
      const api = game.modules.get(moduleId)?.api;
      if (!api) return { moduleApi: false };
      return {
        moduleApi: true,
        stored: s.flags?.[moduleId]?.sets ?? [],
        normalized: api.getSets(s),
      };
    },
    { name: scene, moduleId: MODULE_ID }
  );
  if (!mirror.moduleApi) {
    check('module api is available for the mirror check', false, 'module absent or disabled');
  } else {
    check(
      'the module re-normalizes our sets to EXACTLY what we stored (no drift)',
      JSON.stringify(mirror.stored) === JSON.stringify(mirror.normalized),
      `stored:     ${JSON.stringify(mirror.stored).slice(0, 400)}\n        normalized: ${JSON.stringify(mirror.normalized).slice(0, 400)}`
    );
  }

  /* --- 10. default scene + strict resolution -------------------------------------------------- */
  console.log('\n— scene resolution —');
  const activeName = await f.evaluate(() => game.scenes.active?.name ?? null, null);
  const defaulted = await call({ action: 'list' });
  check(
    'omitting sceneIdentifier targets the ACTIVE scene',
    !activeName || defaulted.includes(activeName),
    defaulted.split('\n')[0]
  );
  await rejects(
    'an unknown scene is a clear error, not a silent default',
    () => call({ action: 'list', sceneIdentifier: 'No Such Scene At All' }),
    /Scene not found/
  );

  /* --- 11. remove ----------------------------------------------------------------------------- */
  console.log('\n— remove —');
  if (loopId) {
    const rm = await call({ action: 'remove', sceneIdentifier: scene, setIdentifier: loopId });
    contains('remove by id names what went and what remains', rm, 'Removed 1 sound set(s)', 'remain');
  }
  const rmAll = await call({ action: 'remove', sceneIdentifier: scene, setIdentifier: 'all' });
  contains('remove "all" clears the scene', rmAll, 'Removed', '0 set(s) remain');

  const empty = await call({ action: 'list', sceneIdentifier: scene });
  contains('an emptied scene points the caller at the library', empty, 'No sound sets', 'action "library"');

  const rmEmpty = await call({ action: 'remove', sceneIdentifier: scene, setIdentifier: 'all' });
  contains('removing from an empty scene is an honest no-op', rmEmpty, 'Nothing to remove');
} finally {
  // Hand the scene back exactly as found — including "there was no flag at all".
  if (scene) {
    try {
      await f.evaluate(
        async ({ name, moduleId, sets }) => {
          const s = game.scenes.get(name) || game.scenes.getName(name);
          if (!s) return;
          if (sets === null) await s.unsetFlag(moduleId, 'sets');
          else await s.setFlag(moduleId, 'sets', sets);
        },
        { name: scene, moduleId: MODULE_ID, sets: snapshot ?? null }
      );
      console.log(`\n[verify-soundscape] restored "${scene}" to its snapshot.`);
    } catch (err) {
      console.error(`\n[verify-soundscape] ⚠️ RESTORE FAILED for "${scene}": ${err.message}`);
    }
  }
  await f.dispose();
  console.log(`\n[verify-soundscape] ${pass} passed, ${fail} failed.`);
  // The bridge holds a live browser; without this the script hangs instead of exiting.
  process.exit(fail === 0 ? 0 : 1);
}
