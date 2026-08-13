// After a soundscape-sfx layout change: sweep every scene's Soundscape sets and repoint
// file paths at the library's NEW locations, matching by basename (slug-prefixed names are
// globally unique in the library). Only paths under soundscape-sfx/ that no longer resolve
// are touched; world-asset paths are left alone. Reports every rewrite; read-only with --dry.
//
// Run: node scripts/remap-soundscape-scene-paths.mjs [--dry]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dry = process.argv.includes('--dry');
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

try {
  console.log('[remap] connecting…');
  await f.connect();
  const report = await f.evaluate(async dry => {
    const MOD = 'fvtt-mod-soundscape';
    const res = await fetch('soundscape-sfx/library.json', { cache: 'no-cache' });
    if (!res.ok) return { error: `library.json fetch failed: HTTP ${res.status}` };
    const lib = await res.json();
    const valid = new Set();
    const byBasename = new Map();
    for (const t of lib.sets) {
      for (const p of t.files) {
        valid.add(p);
        byBasename.set(p.split('/').pop(), p);
      }
    }
    const out = { scenes: [], orphans: [], rewrites: 0 };
    for (const scene of game.scenes.contents) {
      const sets = scene.flags?.[MOD]?.sets;
      if (!Array.isArray(sets) || !sets.length) continue;
      let changed = false;
      const next = sets.map(s => ({
        ...s,
        files: (s.files ?? []).map(p => {
          if (!p.startsWith('soundscape-sfx/') || valid.has(p)) return p;
          const to = byBasename.get(p.split('/').pop());
          if (!to) {
            out.orphans.push(`${scene.name} / ${s.name}: ${p}`);
            return p;
          }
          changed = true;
          out.rewrites++;
          return to;
        }),
      }));
      if (changed) {
        out.scenes.push(scene.name);
        if (!dry) await scene.setFlag(MOD, 'sets', next);
      }
    }
    return out;
  }, dry);
  if (report.error) {
    console.error(report.error);
    process.exit(1);
  }
  console.log(
    `${dry ? '[dry] would rewrite' : 'rewrote'} ${report.rewrites} path(s) across ` +
      `${report.scenes.length} scene(s)${report.scenes.length ? `: ${report.scenes.join(', ')}` : ''}`
  );
  for (const o of report.orphans) console.warn(`  ORPHAN (no new home found): ${o}`);
  process.exit(report.orphans.length ? 1 : 0);
} finally {
  await f.disconnect?.();
}
