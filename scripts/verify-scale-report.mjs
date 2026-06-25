// Live verification for alignment-plan 1.2 — "@scale detection as a reported fact".
//
// The copy paths now DETECT (never resolve) the advancement-fed `@scale.*` tokens a 2024
// class/racial feature carries, and REPORT them so the skill can set an explicit die. This drives
// a real headless Foundry session through the foundry.call seam (exercising the freshly-built
// dist/page.bundle.js without a Claude Code restart) and asserts, against the live `sandbox` world:
//   * copying an @scale-bearing feat onto an NPC reports it on the `added[].unresolvedScale` fact,
//   * every reported { path, formula } actually resolves on the LIVE item (path is real + usable),
//   * the tool REPORTS the token but never invents a die (no `NdM` value appears in the report),
//   * a clean monster feature (no @scale) is NOT flagged (no false positives).
// Discovery-driven: it FINDS a real @scale feat at runtime rather than hard-coding a 2024 name.
// Everything created is namespaced with TAG and cleaned up in `finally`.
//
// Build first: npm run build. Run: node scripts/verify-scale-report.mjs
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

const TAG = 'ZZ-SCALE-IT';
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

// Mirror of findUnresolvedScaleTokens (page side) — used only to DISCOVER a token-bearing feat.
function hasScale(data) {
  let found = false;
  const seen = new WeakSet();
  const walk = node => {
    if (found) return;
    if (typeof node === 'string') {
      if (/@scale\./.test(node)) found = true;
      return;
    }
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const v of Object.values(node)) walk(v);
  };
  walk(data);
  return found;
}

// Navigate a dot-path (rooted at the item doc, e.g. "system.activities.<id>.damage.parts.0.bonus")
// on a live item's { system } read-back (which is rooted at system) — so drop the leading "system.".
function getByPath(systemObj, path) {
  const rel = path.startsWith('system.') ? path.slice('system.'.length) : path;
  let cur = systemObj;
  for (const seg of rel.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

let actorId; // created world actor (cleaned up in finally)

try {
  console.log('[verify-scale] connecting to sandbox…');
  await f.connect();
  console.log('[verify-scale] connected\n');

  // --- 1. Discover a real @scale-bearing feat in the premium books -----------
  console.log('# discover an @scale-bearing feat');
  const QUERIES = ['Breath Weapon', 'Rage', 'Sneak Attack', 'Martial Arts', 'Divine Smite'];
  let scaleFeat = null; // { pack, name }
  for (const q of QUERIES) {
    const hits = await f.call('searchCompendium', { query: q });
    for (const h of (Array.isArray(hits) ? hits : []).filter(x => x.type === 'feat')) {
      const full = await f.call('getCompendiumDocumentFull', { packId: h.pack, documentId: h.id });
      if (hasScale(full?.fullData ?? full?.system ?? {})) {
        scaleFeat = { pack: h.pack, name: h.name };
        break;
      }
    }
    if (scaleFeat) break;
  }
  assert(Boolean(scaleFeat), `found an @scale feat: ${scaleFeat?.name} (${scaleFeat?.pack})`);
  if (!scaleFeat) throw new Error('no @scale-bearing feat found in the premium books');

  // --- 2. Host NPC: copy the first MM creature (a realistic prefab base) ------
  const creatures = await f.call('searchCompendiumFaceted', { documentType: 'creature', limit: 1 });
  const cHit = (Array.isArray(creatures) ? creatures : [])[0];
  if (!cHit?.pack) throw new Error('could not resolve a source creature');
  const aOut = await f.call('createActorFromCompendium', {
    packId: cHit.pack,
    itemId: cHit.id,
    customNames: [`${TAG} Host`],
    quantity: 1,
    addToScene: false,
  });
  actorId = aOut?.actors?.[0]?.id;
  assert(Boolean(actorId), `host NPC created (${aOut?.actors?.[0]?.name})`);

  // --- 3. Copy the @scale feat → the tool must REPORT the dangling token ------
  console.log('\n# copy the @scale feat (addFeaturesFromCompendium)');
  const fr = await f.call('addFeaturesFromCompendium', {
    actorIdentifier: actorId,
    featureNames: [scaleFeat.name],
    compendiumPacks: [scaleFeat.pack],
  });
  const addedFeat = (fr?.added ?? []).find(
    a => a.name.toLowerCase() === scaleFeat.name.toLowerCase()
  );
  assert(Boolean(addedFeat), `feat "${scaleFeat.name}" was added`);
  const tokens = addedFeat?.unresolvedScale ?? [];
  assert(tokens.length > 0, `tool REPORTED ${tokens.length} unresolved @scale token(s)`);
  assert(
    tokens.every(t => typeof t.path === 'string' && /@scale\./.test(t.formula)),
    'each reported token has a path and an @scale formula'
  );
  // The tool reports the literal token; it must NOT invent a die anywhere in the report.
  assert(
    !tokens.some(t => /\b\d+d\d+\b/.test(t.formula) && !/@scale/.test(t.formula)),
    'report contains the @scale token, not a fabricated die'
  );
  for (const t of tokens) console.log(`        ${t.path} = ${t.formula}`);

  // --- 4. Each reported path actually resolves on the LIVE item ---------------
  console.log('\n# reported paths resolve on the live item');
  if (addedFeat?.itemId) {
    const ent = await f.call('getCharacterEntity', {
      characterIdentifier: actorId,
      entityIdentifier: addedFeat.itemId,
    });
    const sys = ent?.entity?.system;
    assert(Boolean(sys), 'read the live feat item back');
    for (const t of tokens) {
      const live = getByPath(sys, t.path);
      assert(
        live === t.formula,
        `path "${t.path}" resolves to the reported formula on the live item`
      );
    }
  }

  // --- 5. Negative control: a clean monster feature is NOT flagged ------------
  console.log('\n# clean feature is not flagged (no false positives)');
  const clean = await f.call('addFeaturesFromCompendium', {
    actorIdentifier: actorId,
    featureNames: ['Pack Tactics'], // default packs = MM features; no @scale
  });
  const cleanAdded = (clean?.added ?? [])[0];
  if (cleanAdded) {
    assert(
      !cleanAdded.unresolvedScale || cleanAdded.unresolvedScale.length === 0,
      'a clean MM feature has no unresolvedScale fact'
    );
  } else {
    console.log('  SKIP  "Pack Tactics" not added (already present / not found) — control skipped');
  }
} catch (e) {
  fails++;
  console.log(`\n[verify-scale] FATAL: ${e?.message || String(e)}`);
} finally {
  if (actorId) {
    try {
      await f.call('deleteActor', { identifiers: [actorId], removeEmptyFolder: true });
      console.log('[verify-scale] cleaned up host NPC');
    } catch {
      /* best-effort */
    }
  }
  await f.dispose?.();
}

console.log(`\n==== @scale-report verification: ${passes} passed, ${fails} failed ====`);
process.exit(fails > 0 ? 1 : 0);
