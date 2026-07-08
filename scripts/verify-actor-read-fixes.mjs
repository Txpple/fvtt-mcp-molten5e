// Live verification for the 2026-07-08 actor-read/folder-guard fixes (four in one pass):
//
//   1. TOKEN-ID READS — getCharacterInfo (the page fn behind get-actor AND get-actor-entity) now
//      resolves via the shared fuzzy resolver, so a PLACED TOKEN id reaches that token's
//      ActorDelta-backed actor (the path its tool description always advertised; it used to throw
//      "Character not found"). Proves delta isolation: the token read differs from the base read.
//   2. FOLDER GUARD — mcpGenerated is now provenance for BRIDGE-INVENTED housekeeping folders
//      only. A user-named folder minted by create-actor-from-compendium's folder param survives
//      deleteActor cleanup (the `_DM` incident); a staged legacy housekeeping folder (flag +
//      palette color) is still removed; a staged legacy folder the user RE-COLORED is kept
//      (adoption veto); an explicit createFolder is not flagged.
//   3. @SCALE ON CHARACTER COPIES — copying a PHB pregen (type:character) no longer reports
//      unresolved @scale (class ScaleValue advancement is intact, roll data resolves natively).
//      NPC reporting is covered by verify-scale-report.mjs + unit tests (unchanged literal path).
//   4. ITEM FLAGS READ — getCharacterInfo items now carry sanitized module `flags` (the
//      item-piles NaN forensic read path; get-actor-entity surfaces them, get-actor drops them).
//
// Drives a real headless session through the foundry.call seam (fresh dist/, no CC restart).
// foundry.evaluate is used ONLY to stage fixtures (place a token, mint legacy-shaped folders,
// write a probe flag) — every behavior under test goes through the seam. Everything created is
// namespaced with TAG and cleaned up in `finally`.
//
// Build first: npm run build.  Run: node scripts/verify-actor-read-fixes.mjs
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

const TAG = 'ZZ-READFIX';
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

let npcId; // fixture NPC (MM copy)
let pregenId; // fixture character (PHB pregen copy)
let tokenId; // fixture token on the active scene
let keepFolderId; // user-named folder minted by the copy's folder param
let explicitFolderId; // folder from the explicit createFolder tool
let adoptedFolderId; // staged legacy folder (flagged + re-colored)
let housekeepFolderId; // staged legacy housekeeping folder (flagged + palette color)

try {
  console.log('[verify-readfix] connecting…');
  await f.connect();
  console.log('[verify-readfix] connected\n');

  // --- fixture: copy an MM creature into a USER-NAMED folder --------------------------------
  const creatures = await f.call('searchCompendiumFaceted', { documentType: 'creature', limit: 1 });
  const cHit = (Array.isArray(creatures) ? creatures : [])[0];
  if (!cHit?.pack) throw new Error('could not resolve a source creature');
  const npcOut = await f.call('createActorFromCompendium', {
    packId: cHit.pack,
    itemId: cHit.id,
    customNames: [`${TAG} Npc`],
    quantity: 1,
    addToScene: false,
    folder: `${TAG} UserKeep`,
  });
  npcId = npcOut?.actors?.[0]?.id;
  keepFolderId = npcOut?.folder?.id;
  assert(Boolean(npcId), `fixture NPC created (${npcOut?.actors?.[0]?.name})`);
  assert(
    npcOut?.folder?.name === `${TAG} UserKeep`,
    `filed into the minted user-named folder ("${npcOut?.folder?.name}")`
  );

  // --- 2a. a user-named folder is NOT marked auto-removable ---------------------------------
  console.log('\n# folder param mints an UNFLAGGED folder (the _DM fix)');
  const keepFlags = await f.evaluate(id => game.folders?.get(id)?.flags ?? null, keepFolderId);
  assert(
    keepFlags?.world?.mcpGenerated === false,
    `user-named folder carries mcpGenerated=false (got ${JSON.stringify(keepFlags?.world?.mcpGenerated)})`
  );

  // --- 1. token-id reads through getCharacterInfo -------------------------------------------
  console.log('\n# getCharacterInfo resolves a PLACED TOKEN id (get-actor/get-actor-entity path)');
  tokenId = await f.evaluate(async id => {
    const actor = game.actors.get(id);
    const scene = game.scenes.active;
    const td = await actor.getTokenDocument({ x: 100, y: 100, hidden: true });
    const [tok] = await scene.createEmbeddedDocuments('Token', [td.toObject()]);
    return tok.id;
  }, npcId);
  assert(Boolean(tokenId), `fixture token placed on the active scene (${tokenId})`);

  const baseRead = await f.call('getCharacterInfo', { characterName: npcId });
  const baseHp = baseRead?.system?.attributes?.hp?.value;
  const tokenRead = await f.call('getCharacterInfo', { characterName: tokenId });
  assert(
    tokenRead?.name === `${TAG} Npc`,
    `token id resolves to the token's actor ("${tokenRead?.name}")`
  );

  // Delta isolation: wound ONLY the token instance, then re-read both sides.
  const woundedHp = Math.max(1, (baseHp ?? 2) - 1);
  await f.evaluate(
    async arg => {
      const tok = game.scenes.active.tokens.get(arg.tokenId);
      await tok.actor.update({ 'system.attributes.hp.value': arg.hp });
    },
    { tokenId, hp: woundedHp }
  );
  const tokenRead2 = await f.call('getCharacterInfo', { characterName: tokenId });
  const baseRead2 = await f.call('getCharacterInfo', { characterName: npcId });
  assert(
    tokenRead2?.system?.attributes?.hp?.value === woundedHp,
    `token-id read sees the token's OWN delta (hp ${tokenRead2?.system?.attributes?.hp?.value})`
  );
  assert(
    baseRead2?.system?.attributes?.hp?.value === baseHp,
    `base-actor read is untouched by the token wound (hp ${baseRead2?.system?.attributes?.hp?.value})`
  );

  // Negative control: a 16-char id that is neither actor nor token still throws.
  let threw = false;
  try {
    await f.call('getCharacterInfo', { characterName: 'ZZZZZZZZZZZZZZZZ' });
  } catch {
    threw = true;
  }
  assert(threw, 'an unknown 16-char id still throws Character not found');

  // --- 4. item flags surfaced by getCharacterInfo -------------------------------------------
  console.log('\n# item module flags reach the read payload (flag-forensics path)');
  const probeItemId = await f.evaluate(async id => {
    const item = game.actors.get(id)?.items?.contents?.[0];
    if (!item) return null;
    await item.update({ 'flags.world.zzReadfixProbe': 42 });
    return item.id;
  }, npcId);
  if (probeItemId) {
    const flagged = await f.call('getCharacterInfo', { characterName: npcId });
    const probed = (flagged?.items ?? []).find(i => i.id === probeItemId);
    assert(
      probed?.flags?.world?.zzReadfixProbe === 42,
      `item flags read back through getCharacterInfo (flags.world.zzReadfixProbe=${probed?.flags?.world?.zzReadfixProbe})`
    );
  } else {
    console.log('  SKIP  fixture NPC has no items — flags probe skipped');
  }

  // --- 3. @scale suppressed on a type:character copy ----------------------------------------
  console.log('\n# @scale on a character copy resolves natively (no false warning)');
  const hits = await f.call('searchCompendium', { query: 'Bard' });
  const pregenHit = (Array.isArray(hits) ? hits : []).find(h => h.type === 'character');
  if (pregenHit) {
    const pOut = await f.call('createActorFromCompendium', {
      packId: pregenHit.pack,
      itemId: pregenHit.id,
      customNames: [`${TAG} Pregen`],
      quantity: 1,
      addToScene: false,
      folder: `${TAG} UserKeep`,
    });
    pregenId = pOut?.actors?.[0]?.id;
    assert(Boolean(pregenId), `pregen character copied (${pOut?.actors?.[0]?.name})`);
    // The suppression must not be vacuous: the copy's items DO carry literal @scale tokens…
    const carries = await f.evaluate(id => {
      const rx = /@scale\./;
      const walk = n => {
        if (typeof n === 'string') return rx.test(n);
        if (n === null || typeof n !== 'object') return false;
        return Object.values(n).some(walk);
      };
      return (game.actors.get(id)?.items?.contents ?? []).some(i => walk(i.toObject().system));
    }, pregenId);
    // …and its roll data resolves them (class ScaleValue advancement intact on the copy).
    const scaleKeys = await f.evaluate(
      id => Object.keys(game.actors.get(id)?.getRollData?.()?.scale ?? {}),
      pregenId
    );
    assert(carries, 'the pregen copy carries literal @scale tokens in its items');
    assert(scaleKeys.length > 0, `roll data resolves them natively (scale.${scaleKeys[0]}.*)`);
    const reported = pOut?.actors?.[0]?.unresolvedScale;
    assert(
      !reported || reported.length === 0,
      `no unresolved-@scale warning on the character copy (got ${reported?.length ?? 0})`
    );
  } else {
    console.log('  SKIP  no type:character pregen found for "Bard" — @scale block skipped');
  }

  // --- 2b. housekeeping cleanup still fires; adoption veto holds ----------------------------
  console.log('\n# deleteActor cleanup: housekeeping folder removed, adopted folder kept');
  // Stage two LEGACY-shaped folders (flag stamped true, as old bridge versions did):
  // one still wearing the bridge palette, one the user re-colored.
  const staged = await f.evaluate(async tag => {
    const mk = (name, color) =>
      Folder.create({
        name,
        type: 'Actor',
        color,
        flags: { world: { mcpGenerated: true, createdAt: new Date().toISOString() } },
      });
    const housekeep = await mk(`${tag} Housekeep`, '#4a90e2');
    const adopted = await mk(`${tag} Adopted`, '#ff5500');
    return { housekeepId: housekeep.id, adoptedId: adopted.id };
  }, TAG);
  housekeepFolderId = staged?.housekeepId;
  adoptedFolderId = staged?.adoptedId;

  // Remove the fixture token first (its base actor is about to go), then file the actors.
  await f.evaluate(
    async id => game.scenes.active.deleteEmbeddedDocuments('Token', [id]),
    tokenId
  );
  tokenId = undefined;
  await f.evaluate(
    async arg => game.actors.get(arg.actorId).update({ folder: arg.folderId }),
    { actorId: npcId, folderId: housekeepFolderId }
  );
  const delNpc = await f.call('deleteActor', { identifiers: [npcId] });
  npcId = undefined;
  const removedNames = (delNpc?.removedFolders ?? []).map(x => x.name);
  assert(
    removedNames.includes(`${TAG} Housekeep`),
    `emptied palette-colored housekeeping folder auto-removed (${JSON.stringify(removedNames)})`
  );
  const housekeepAlive = await f.evaluate(id => Boolean(game.folders?.get(id)), housekeepFolderId);
  assert(!housekeepAlive, 'housekeeping folder is really gone');
  if (!housekeepAlive) housekeepFolderId = undefined;

  if (pregenId) {
    await f.evaluate(
      async arg => game.actors.get(arg.actorId).update({ folder: arg.folderId }),
      { actorId: pregenId, folderId: adoptedFolderId }
    );
    const delPregen = await f.call('deleteActor', { identifiers: [pregenId] });
    pregenId = undefined;
    const adoptedAlive = await f.evaluate(id => Boolean(game.folders?.get(id)), adoptedFolderId);
    assert(
      (delPregen?.removedFolders ?? []).length === 0 && adoptedAlive,
      're-colored legacy folder KEPT despite empty + mcpGenerated (user-adoption veto)'
    );
  }

  // The user-named folder from the copy param must also have survived its emptying.
  const keepAlive = await f.evaluate(id => Boolean(game.folders?.get(id)), keepFolderId);
  assert(keepAlive, `user-named "${TAG} UserKeep" survived deleteActor cleanup (the _DM scenario)`);

  // --- 2c. explicit createFolder is deliberate org structure --------------------------------
  console.log('\n# explicit createFolder is not flagged auto-removable');
  const made = await f.call('createFolder', { name: `${TAG} Explicit`, type: 'Actor' });
  explicitFolderId = made?.folderId;
  const explicitFlags = await f.evaluate(
    id => game.folders?.get(id)?.flags ?? null,
    explicitFolderId
  );
  assert(
    explicitFlags?.world?.mcpGenerated === false,
    `createFolder stamps mcpGenerated=false (got ${JSON.stringify(explicitFlags?.world?.mcpGenerated)})`
  );
} catch (e) {
  fails++;
  console.log(`\n[verify-readfix] FATAL: ${e?.stack || e?.message || String(e)}`);
} finally {
  try {
    if (tokenId) {
      await f.evaluate(async id => game.scenes.active.deleteEmbeddedDocuments('Token', [id]), tokenId);
    }
    const actorIds = [npcId, pregenId].filter(Boolean);
    if (actorIds.length) await f.call('deleteActor', { identifiers: actorIds });
    for (const [id, type] of [
      [keepFolderId, 'Actor'],
      [adoptedFolderId, 'Actor'],
      [housekeepFolderId, 'Actor'],
      [explicitFolderId, 'Actor'],
    ]) {
      if (id) {
        await f
          .call('deleteFolder', { identifier: id, type, deleteContents: true })
          .catch(() => {});
      }
    }
    console.log('\n[verify-readfix] cleaned up fixtures');
  } catch (e) {
    console.log(`\n[verify-readfix] cleanup note: ${e?.message || e}`);
  }
  await f.dispose?.();
}

console.log(`\n==== actor-read-fixes verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
