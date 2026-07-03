// Live verification for the COMPLETED placeable library — the types added after the tiles/lights
// focus set (AmbientSound / Drawing / Wall CRUD, place/delete-tokens) plus the Region + Note
// kernel-retrofit regressions (their tools kept their names/schemas but now ride the shared kernel).
//
// Drives a real headless Foundry session (fresh dist/, no CC restart) through f.call against a
// throwaway scene:
//   A  Sound CRUD — nested darkness/effects, dot-path partial patch preserves siblings.
//   B  Drawing CRUD — shape mapping (rect/polygon/text), shape.* resize patch.
//   C  Wall CRUD — door authoring, doorsOnly list filter, ds/door state patch, full-segment move,
//      partial-segment drop-and-warn.
//   D  place-tokens / delete-tokens — prototype-carried placement + disposition override; the
//      sidebar actor SURVIVES delete-tokens.
//   E  Region retrofit — kernel create (items shape + indexed default name), rect update via ctx,
//      delete with the orphaned-teleporter warning.
//   F  Note retrofit — kernel create (journal strict resolve), single-note update loop, delete.
// Fixture scene + journal + actor are deleted in `finally`.
//
// Build first: npm run build.  Run: node scripts/verify-placeables-library.mjs
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

const TAG = 'ZZ-PLACE-LIB';
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
let actorId;

try {
  console.log('[verify-lib] connecting…');
  await f.connect();
  console.log('[verify-lib] connected\n');

  sceneId = await f.evaluate(async tag => {
    const s = await Scene.create({
      name: `${tag} Scene`,
      width: 2000,
      height: 2000,
      grid: { size: 100 },
      navigation: false,
    });
    return s.id;
  }, TAG);

  // --- A: AmbientSound CRUD ---
  console.log('# A: sound CRUD (nested darkness/effects; partial patch preserves siblings)');
  const sndCreate = await f.call('createSceneSounds', {
    sceneIdentifier: sceneId,
    items: [
      {
        path: 'sounds/lock.wav', // ships with core Foundry — resolves without an upload
        x: 500,
        y: 500,
        radius: 30,
        name: 'Probe Fire',
        repeat: true,
        volume: 0.8,
        darknessMin: 0.2,
        baseEffect: 'lowpass',
        baseEffectIntensity: 7,
      },
      { path: 'sounds/lock.wav', x: 900, y: 500 /* missing radius → isolated error */ },
    ],
  });
  assert(sndCreate?.created === 1, `A — created 1 sound (got ${sndCreate?.created})`);
  assert(
    (sndCreate?.errors ?? []).some(e => /radius/.test(e)),
    'A — the radius-less sound was isolated + reported'
  );
  const soundId = sndCreate?.items?.[0]?.id;
  const liveSnd = await f.evaluate(
    ({ sId, id }) => {
      const s = game.scenes.get(sId).sounds.get(id);
      return {
        radius: s.radius,
        repeat: s.repeat,
        dMin: s.darkness?.min,
        eff: s.effects?.base?.type,
        effInt: s.effects?.base?.intensity,
      };
    },
    { sId: sceneId, id: soundId }
  );
  assert(liveSnd.radius === 30 && liveSnd.repeat === true, 'A — radius + repeat persisted');
  assert(
    liveSnd.dMin === 0.2 && liveSnd.eff === 'lowpass' && liveSnd.effInt === 7,
    'A — darkness + effects nested correctly'
  );
  const sndList = await f.call('listSceneSounds', { sceneIdentifier: sceneId });
  assert(
    sndList?.count === 1 && sndList.items[0].baseEffect === 'lowpass',
    'A — list reports the salient sound fields'
  );
  await f.call('updateSceneSounds', {
    sceneIdentifier: sceneId,
    patches: [{ id: soundId, volume: 0.4, darknessMax: 0.9 }],
  });
  const afterSnd = await f.evaluate(
    ({ sId, id }) => {
      const s = game.scenes.get(sId).sounds.get(id);
      return { volume: s.volume, dMin: s.darkness?.min, dMax: s.darkness?.max, eff: s.effects?.base?.type };
    },
    { sId: sceneId, id: soundId }
  );
  assert(afterSnd.volume === 0.4 && afterSnd.dMax === 0.9, 'A — volume + darkness.max patched');
  assert(
    afterSnd.dMin === 0.2 && afterSnd.eff === 'lowpass',
    'A — partial patch PRESERVED darkness.min + effects (dot-paths)'
  );
  const sndDel = await f.call('deleteSceneSounds', { sceneIdentifier: sceneId, ids: [soundId] });
  assert(sndDel?.deleted === 1, 'A — deleted the sound');

  // --- B: Drawing CRUD ---
  console.log('\n# B: drawing CRUD (shape mapping + shape.* resize; text label)');
  const drwCreate = await f.call('createSceneDrawings', {
    sceneIdentifier: sceneId,
    items: [
      {
        x: 300,
        y: 300,
        shapeType: 'rectangle',
        width: 400,
        height: 200,
        text: 'Secret Area',
        fillType: 1,
        fillColor: '#ff0000',
        fillAlpha: 0.2,
        hidden: true,
      },
      { x: 900, y: 300, shapeType: 'polygon', points: [0, 0, 200, 0, 100, 150] },
      { x: 0, y: 0, shapeType: 'circle' /* missing radius → isolated error */ },
    ],
  });
  assert(drwCreate?.created === 2, `B — created 2 drawings (got ${drwCreate?.created})`);
  assert(
    (drwCreate?.errors ?? []).some(e => /radius/.test(e)),
    'B — the radius-less circle was isolated + reported'
  );
  const drwIds = (drwCreate?.items ?? []).map(d => d.id);
  const liveDrw = await f.evaluate(
    ({ sId, id }) => {
      const d = game.scenes.get(sId).drawings.get(id);
      return { type: d.shape?.type, w: d.shape?.width, text: d.text, hidden: d.hidden };
    },
    { sId: sceneId, id: drwIds[0] }
  );
  assert(liveDrw.type === 'r' && liveDrw.w === 400, 'B — rectangle mapped to shape{type:"r",width}');
  assert(liveDrw.text === 'Secret Area' && liveDrw.hidden === true, 'B — text label + hidden persisted');
  const drwList = await f.call('listSceneDrawings', { sceneIdentifier: sceneId });
  assert(
    drwList?.count === 2 &&
      drwList.items.some(d => d.shapeType === 'polygon' && d.pointCount === 3),
    'B — list maps the enum back to friendly names + pointCount'
  );
  await f.call('updateSceneDrawings', {
    sceneIdentifier: sceneId,
    patches: [{ id: drwIds[0], width: 600, text: '' }],
  });
  const afterDrw = await f.evaluate(
    ({ sId, id }) => {
      const d = game.scenes.get(sId).drawings.get(id);
      return { w: d.shape?.width, h: d.shape?.height, text: d.text };
    },
    { sId: sceneId, id: drwIds[0] }
  );
  assert(afterDrw.w === 600 && afterDrw.h === 200, 'B — shape.width patched, height preserved');
  assert(afterDrw.text === '', 'B — text:"" cleared the label');
  const drwDel = await f.call('deleteSceneDrawings', { sceneIdentifier: sceneId, ids: drwIds });
  assert(drwDel?.deleted === 2, 'B — deleted both drawings');

  // --- C: Wall CRUD ---
  console.log('\n# C: wall CRUD (door authoring; doorsOnly filter; state patch; full-segment move)');
  const wallCreate = await f.call('createSceneWalls', {
    sceneIdentifier: sceneId,
    items: [
      { x0: 1000, y0: 1000, x1: 1100, y1: 1000, door: 1, ds: 0, doorSound: 'woodBasic' },
      { c: [1200, 1000, 1300, 1000] /* plain blocking wall */ },
      { x0: 0, y0: 0, x1: 10, y1: 0, move: 5 /* off-enum → isolated error */ },
    ],
  });
  assert(wallCreate?.created === 2, `C — created 2 walls (got ${wallCreate?.created})`);
  assert(
    (wallCreate?.errors ?? []).some(e => /move/.test(e)),
    'C — the off-enum move value was isolated + reported'
  );
  const wallIds = (wallCreate?.items ?? []).map(w => w.id);
  const doorsOnly = await f.call('listSceneWalls', { sceneIdentifier: sceneId, doorsOnly: true });
  assert(
    doorsOnly?.count === 1 && doorsOnly?.totalWalls === 2 && doorsOnly.items[0].door === 1,
    `C — doorsOnly filters to the 1 door of ${doorsOnly?.totalWalls} walls`
  );
  const wallUpd = await f.call('updateSceneWalls', {
    sceneIdentifier: sceneId,
    patches: [
      { id: wallIds[0], door: 2, ds: 2 }, // → secret + locked
      { id: wallIds[1], x0: 1200 /* partial segment → dropped + warned */, sight: 0 },
    ],
  });
  assert(wallUpd?.updated === 2, `C — updated 2 walls (got ${wallUpd?.updated})`);
  assert(
    (wallUpd?.warnings ?? []).some(w => /segment ignored/.test(w)),
    'C — partial segment dropped with a warning (never half-moves)'
  );
  const afterWall = await f.evaluate(
    ({ sId, a, b }) => {
      const s = game.scenes.get(sId);
      const wa = s.walls.get(a);
      const wb = s.walls.get(b);
      return { door: wa.door, ds: wa.ds, bC: [...wb.c], bSight: wb.sight };
    },
    { sId: sceneId, a: wallIds[0], b: wallIds[1] }
  );
  assert(afterWall.door === 2 && afterWall.ds === 2, 'C — door flipped to SECRET + LOCKED');
  assert(
    afterWall.bC[0] === 1200 && afterWall.bSight === 0,
    'C — segment untouched by the dropped partial; sight patched to see-through'
  );
  const moveWall = await f.call('updateSceneWalls', {
    sceneIdentifier: sceneId,
    patches: [{ id: wallIds[1], c: [1400, 1000, 1500, 1000] }],
  });
  assert(moveWall?.updated === 1, 'C — full-segment move applied');
  const wallDel = await f.call('deleteSceneWalls', { sceneIdentifier: sceneId, ids: wallIds });
  assert(wallDel?.deleted === 2, 'C — deleted both walls');

  // --- D: place-tokens / delete-tokens ---
  console.log('\n# D: place-tokens / delete-tokens (prototype-carried placement)');
  actorId = await f.evaluate(async tag => {
    const a = await Actor.create({
      name: `${tag} Hobgoblin`,
      type: 'npc',
      prototypeToken: { texture: { src: 'icons/svg/mystery-man.svg' }, disposition: 0 },
    });
    return a.id;
  }, TAG);
  const placed = await f.call('placeSceneTokens', {
    sceneIdentifier: sceneId,
    items: [
      { actor: actorId, x: 500, y: 500 },
      { actor: `${TAG} Hobgoblin`, x: 700, y: 500, disposition: 'hostile', hidden: true },
      { actor: 'No Such Actor ZZZ', x: 0, y: 0 },
    ],
  });
  assert(placed?.created === 2, `D — placed 2 tokens (got ${placed?.created})`);
  assert(
    (placed?.errors ?? []).some(e => /actor not found/.test(e)),
    'D — the unresolved actor was isolated + reported'
  );
  const tokenIds = (placed?.items ?? []).map(t => t.id);
  const liveTk = await f.evaluate(
    ({ sId, a, b }) => {
      const s = game.scenes.get(sId);
      const ta = s.tokens.get(a);
      const tb = s.tokens.get(b);
      return {
        aName: ta.name,
        aActor: ta.actorId,
        aDisp: ta.disposition,
        bDisp: tb.disposition,
        bHidden: tb.hidden,
      };
    },
    { sId: sceneId, a: tokenIds[0], b: tokenIds[1] }
  );
  assert(
    liveTk.aName === `${TAG} Hobgoblin` && liveTk.aActor === actorId,
    'D — token carries the prototype name + actor link'
  );
  assert(
    liveTk.aDisp === 0 && liveTk.bDisp === -1 && liveTk.bHidden === true,
    'D — prototype disposition kept; per-copy hostile/hidden override applied'
  );
  const tkDel = await f.call('deleteSceneTokens', {
    sceneIdentifier: sceneId,
    ids: [...tokenIds, 'ghostToken00'],
  });
  assert(tkDel?.deleted === 2 && tkDel?.notFoundIds?.includes('ghostToken00'),
    'D — deleted both copies; missing id reported');
  const actorSurvives = await f.evaluate(({ id }) => !!game.actors.get(id), { id: actorId });
  assert(actorSurvives, 'D — the sidebar actor SURVIVES delete-tokens');

  // --- E: Region retrofit (kernel create/update/delete + orphan warning) ---
  console.log('\n# E: region retrofit (kernel shapes; rect update; orphaned-teleporter warning)');
  const regCreate = await f.call('createSceneRegions', {
    sceneIdentifier: sceneId,
    items: [{ shapes: [{ type: 'rectangle', x: 100, y: 100, width: 100, height: 100 }] }],
  });
  assert(
    regCreate?.created === 1 && regCreate?.items?.[0]?.name === 'Region 1',
    `E — kernel create returns items + the indexed default name (got "${regCreate?.items?.[0]?.name}")`
  );
  const regId = regCreate.items[0].id;
  const regUpd = await f.call('updateSceneRegions', {
    sceneIdentifier: sceneId,
    patches: [{ id: regId, name: 'Pit Trap', rect: { x: 555, y: 555, widthCells: 3 } }],
  });
  assert(regUpd?.updated === 1, 'E — rect convenience update applied');
  const afterReg = regUpd?.items?.[0];
  assert(
    afterReg?.name === 'Pit Trap' &&
      afterReg?.shapes?.[0]?.width === 300 &&
      (afterReg?.shapes?.[0]?.x - 0) % 100 === 0,
    `E — renamed + reshaped to a snapped 3-cell rect (${JSON.stringify(afterReg?.shapes?.[0])})`
  );

  const tp = await f.call('createSceneTeleporter', {
    from: { sceneIdentifier: sceneId, x: 250, y: 250 },
    to: { sceneIdentifier: sceneId, x: 1750, y: 1750 },
  });
  const tpFromId = tp?.from?.id;
  const tpToId = tp?.to?.id;
  assert(
    !!tpFromId && !!tpToId && tp?.from?.behaviors?.[0]?.destinations?.length === 1,
    'E — teleporter still creates two cross-linked regions (special op untouched)'
  );
  const regDel = await f.call('deleteSceneRegions', {
    sceneIdentifier: sceneId,
    ids: [tpToId],
  });
  assert(regDel?.deleted === 1, 'E — deleted one teleporter endpoint');
  assert(
    (regDel?.warnings ?? []).some(w => w.includes(tpToId)),
    'E — the surviving endpoint is WARNED as orphaned (points at the deleted region)'
  );
  await f.call('deleteSceneRegions', { sceneIdentifier: sceneId, ids: [tpFromId, regId] });

  // --- F: Note retrofit (kernel create + single-note update + delete) ---
  console.log('\n# F: note retrofit (strict journal resolve; pin-nudge loop)');
  journalId = await f.evaluate(async tag => {
    const j = await JournalEntry.create({ name: `${tag} Journal` });
    return j.id;
  }, TAG);
  const noteCreate = await f.call('createSceneNotes', {
    sceneIdentifier: sceneId,
    items: [
      { journal: `${TAG} Journal`, x: 400, y: 400, label: '1 — Probe' },
      { journal: 'No Such Journal ZZZ', x: 0, y: 0 },
    ],
  });
  assert(noteCreate?.created === 1, `F — created 1 pin (got ${noteCreate?.created})`);
  assert(
    (noteCreate?.errors ?? []).some(e => /No journal found/.test(e)),
    'F — the unresolved journal was isolated + reported'
  );
  const noteId = noteCreate?.items?.[0]?.id;
  assert(
    noteCreate?.items?.[0]?.entryId === journalId,
    'F — pin resolved the journal by exact name'
  );
  const noteUpd = await f.call('updateSceneNotes', {
    sceneIdentifier: sceneId,
    patches: [{ id: noteId, x: 450, label: '1 — Nudged' }],
  });
  assert(noteUpd?.updated === 1, 'F — pin nudged (kernel single-patch)');
  const afterNote = await f.evaluate(
    ({ sId, id }) => {
      const n = game.scenes.get(sId).notes.get(id);
      return { x: n.x, text: n.text };
    },
    { sId: sceneId, id: noteId }
  );
  assert(afterNote.x === 450 && afterNote.text === '1 — Nudged', 'F — move + relabel persisted');
  const noteDel = await f.call('deleteSceneNotes', { sceneIdentifier: sceneId, ids: [noteId] });
  assert(noteDel?.deleted === 1, 'F — deleted the pin');
} catch (e) {
  fails++;
  console.log(`\n[verify-lib] FATAL: ${e?.stack || e?.message || String(e)}`);
} finally {
  if (sceneId || journalId || actorId) {
    try {
      await f.evaluate(
        async ({ sId, jId, aId }) => {
          if (sId) await game.scenes.get(sId)?.delete();
          if (jId) await game.journal.get(jId)?.delete();
          if (aId) await game.actors.get(aId)?.delete();
        },
        { sId: sceneId, jId: journalId, aId: actorId }
      );
      console.log('\n[verify-lib] cleaned up fixture scene + journal + actor');
    } catch (e) {
      console.log(`\n[verify-lib] cleanup note: ${e?.message || e}`);
    }
  }
  await f.dispose?.();
}

console.log(`\n==== placeable library verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
