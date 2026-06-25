// Phase-3 READ-ONLY MILESTONE: exercise the REWIRED Node tools end-to-end against
// the live Molten world. This proves the whole spine — login -> inject -> foundry.call
// seam -> rewired Node tool -> shaped response — not just the raw page library.
//
// Build first: `npm run build`. Run: node scripts/verify-read-tools.mjs
// Needs the live box + secrets in gitignored .env (first call wakes a cold box).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Foundry } from '../dist/foundry.js';
import { SceneTools } from '../dist/tools/scene.js';
import { ActorTools } from '../dist/tools/actor.js';
import { CompendiumTools } from '../dist/tools/compendium.js';
import { QuestCreationTools } from '../dist/tools/quest-creation.js';
import { AssetBridgeTools } from '../dist/tools/asset-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Minimal Logger stand-in (src/logger.ts shape): child() returns itself, methods are no-ops.
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

const env = loadEnv();
const foundry = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'MCP-Claude',
});

const scene = new SceneTools({ foundry, logger });
const character = new ActorTools({ foundry, logger });
const compendium = new CompendiumTools({ foundry, logger });
const quest = new QuestCreationTools({ foundry, logger });
const asset = new AssetBridgeTools({ foundry, logger });

const results = [];
async function check(name, fn, ok) {
  try {
    const out = await fn();
    const passed = ok(out);
    results.push({ name, passed, summary: summarize(out) });
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name} -> ${summarize(out)}`);
    return out;
  } catch (e) {
    results.push({ name, passed: false, summary: `THREW: ${e?.message || e}` });
    console.log(`FAIL  ${name} -> THREW: ${e?.message || e}`);
    return undefined;
  }
}
function summarize(v) {
  if (v == null) return String(v);
  if (typeof v === 'string') return `${v.length} chars`;
  if (Array.isArray(v)) return `array(${v.length})`;
  const keys = Object.keys(v);
  const counts = keys
    .filter(k => Array.isArray(v[k]))
    .map(k => `${k}=${v[k].length}`)
    .join(',');
  return counts || `{${keys.slice(0, 6).join(',')}}`;
}

let firstActorName;
try {
  console.log('[milestone] connecting (this wakes a cold Molten box; can take ~1 min)…');
  await foundry.connect();
  console.log('[milestone] connected — running read tools\n');

  await check(
    'get-world-info',
    () => scene.handleGetWorldInfo({}),
    o => o && (o.system || o.worldId || o.title)
  );
  const list = await check(
    'list-actors',
    () => character.handleListCharacters({}),
    o => o && Array.isArray(o.characters)
  );
  firstActorName = list?.characters?.[0]?.name;
  if (firstActorName) {
    await check(
      `get-actor("${firstActorName}")`,
      () => character.handleGetCharacter({ identifier: firstActorName }),
      o => o && o.name
    );
  }
  await check(
    'search-compendium("goblin")',
    () => compendium.handleSearchCompendium({ query: 'goblin' }),
    o => o != null
  );
  await check(
    'list-scenes',
    () => asset.handleListScenes({}),
    o => typeof o === 'string' || o != null
  );
  await check(
    'list-journals',
    () => quest.handleListJournals({}),
    o => o != null
  );
  await check(
    'list-playlists',
    () => asset.handleListPlaylists({}),
    o => typeof o === 'string' || o != null
  );
} catch (e) {
  console.error('[milestone] FATAL:', e?.message || e);
} finally {
  await foundry.dispose();
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\n[milestone] ${passed}/${total} read tools passed`);
  process.exit(passed === total && total >= 6 ? 0 : 1);
}
