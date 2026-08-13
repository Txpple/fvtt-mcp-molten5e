// Build + sync the Soundscape template library on the Molten box (Data/soundscape-sfx).
//
// The private assets repo (Txpple/fvtt-mod-soundscape-sfx, cloned beside this one) is
// SOUNDSCAPE-NATIVE and mirrors the box layout exactly — no conversion happens anywhere:
//
//   interval-sounds/<category-slug>/<set-slug>/     one set: audio files + config.json
//   ambient-loops/<category-slug>/<name>.ogg        one loop template per file
//
// A set's config.json is the module's own schema, stripped to essentials (everything else
// defaults). AUTHORING A NEW SET: make a folder under the right category, drop audio in,
// write a config like { "name": "...", "playStyle": "interval", "interval": 25,
// "intervalVariation": 5, "volume": 1 } — optional extras: volumeVariation,
// pitchVariation, whenToPlay ("day"/"night"), crossfade (loop style). A new AMBIENT LOOP
// is just a file dropped in its category folder (optional <name>.json sidecar to override
// { name, volume, crossfade }). New category = new folder + a display name in
// CATEGORY_NAMES below.
//
// Sync semantics: dest path == repo-relative path. Uploads what is missing or
// size-changed, prunes anything on the box that is no longer in the repo, removes emptied
// directories. Re-runnable; converges. After moving/renaming files, run
// scripts/remap-soundscape-scene-paths.mjs so existing scene sets follow.
//
// Run: node scripts/upload-soundscape-library.mjs [--check] [--emit]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { WebDavClient } from '../dist/tools/molten/webdav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_REPO = join(__dirname, '..', '..', 'fvtt-mod-soundscape-sfx');
const DEST = 'soundscape-sfx';
const checkOnly = process.argv.includes('--check');
const emit = process.argv.includes('--emit');

const AUDIO_TYPES = { '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const isAudio = f => /\.(ogg|wav|mp3)$/i.test(f);
const titleCase = s =>
  s
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[-_]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** Display names for category folders. A new category folder needs an entry here. */
const CATEGORY_NAMES = {
  // Interval Sounds
  'beasts-and-birds': 'Beasts & Birds',
  'crowds-and-commotion': 'Crowds & Commotion',
  'fire-lava-and-steam': 'Fire, Lava & Steam',
  'horror-and-undead': 'Horror & Undead',
  'industry-and-workshop': 'Industry & Workshop',
  'magic-and-planar': 'Magic & Planar',
  monsters: 'Monsters',
  'music-and-drums': 'Music & Drums',
  'tavern-and-inn': 'Tavern & Inn',
  'town-trade-and-ships': 'Town, Trade & Ships',
  'voices-individuals': 'Voices — Individuals',
  water: 'Water',
  'weather-and-wind': 'Weather & Wind',
  'wilderness-and-earth': 'Wilderness & Earth',
  // Ambient Loops
  'battle-and-unrest': 'Battle & Unrest',
  'caves-and-mines': 'Caves & Mines',
  'city-and-town': 'City & Town',
  'dungeons-crypts-and-ruins': 'Dungeons, Crypts & Ruins',
  'forests-and-wilds': 'Forests & Wilds',
  haunted: 'Haunted',
  'homes-and-interiors': 'Homes & Interiors',
  'magical-and-planar': 'Magical & Planar',
  'taverns-and-gatherings': 'Taverns & Gatherings',
};

/* ------------------------------ build the template list ------------------------------ */

const sets = [];
const uploads = []; // { local, dest }
const problems = [];

function categoryName(slugName) {
  if (CATEGORY_NAMES[slugName]) return CATEGORY_NAMES[slugName];
  problems.push(`category folder "${slugName}" has no display name in CATEGORY_NAMES`);
  return titleCase(slugName);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    problems.push(`unreadable JSON: ${path} (${err.message})`);
    return null;
  }
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);

// Interval Sounds: one template per set folder.
const IS_ROOT = join(SRC_REPO, 'interval-sounds');
for (const catSlug of readdirSync(IS_ROOT).sort()) {
  if (!statSync(join(IS_ROOT, catSlug)).isDirectory()) continue;
  const category = categoryName(catSlug);
  for (const setDir of readdirSync(join(IS_ROOT, catSlug)).sort()) {
    const dir = join(IS_ROOT, catSlug, setDir);
    if (!statSync(dir).isDirectory()) continue;
    const cfg = existsSync(join(dir, 'config.json'))
      ? (readJson(join(dir, 'config.json')) ?? {})
      : {};
    const audio = readdirSync(dir).filter(isAudio).sort();
    if (!audio.length) {
      problems.push(`no audio files: interval-sounds/${catSlug}/${setDir}`);
      continue;
    }
    const files = audio.map(f => {
      const dest = posix.join(DEST, 'interval-sounds', catSlug, setDir, f);
      uploads.push({ local: join(dir, f), dest });
      return dest;
    });
    sets.push({
      name: typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : titleCase(setDir),
      section: 'Interval Sounds',
      category,
      playStyle: cfg.playStyle === 'loop' ? 'loop' : 'interval',
      files,
      interval: num(cfg.interval, 25),
      intervalVariation: num(cfg.intervalVariation, 5),
      crossfade: num(cfg.crossfade, 4),
      volume: num(cfg.volume, 0.8),
      volumeVariation: num(cfg.volumeVariation, 0),
      pitchVariation: num(cfg.pitchVariation, 0),
      whenToPlay: ['day', 'night'].includes(cfg.whenToPlay) ? cfg.whenToPlay : 'always',
    });
  }
}
const intervalCount = sets.length;

// Ambient Loops: one loop template per audio file; optional <name>.json sidecar overrides.
const AL_ROOT = join(SRC_REPO, 'ambient-loops');
for (const catSlug of readdirSync(AL_ROOT).sort()) {
  if (!statSync(join(AL_ROOT, catSlug)).isDirectory()) continue;
  const category = categoryName(catSlug);
  for (const file of readdirSync(join(AL_ROOT, catSlug)).sort()) {
    if (!isAudio(file)) continue;
    const sidecarPath = join(AL_ROOT, catSlug, file.replace(/\.[a-z0-9]+$/i, '.json'));
    const cfg = existsSync(sidecarPath) ? (readJson(sidecarPath) ?? {}) : {};
    const dest = posix.join(DEST, 'ambient-loops', catSlug, file);
    uploads.push({ local: join(AL_ROOT, catSlug, file), dest });
    sets.push({
      name: typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : titleCase(file),
      section: 'Ambient Loops',
      category,
      playStyle: 'loop',
      files: [dest],
      crossfade: num(cfg.crossfade, 4),
      volume: num(cfg.volume, 0.8),
      whenToPlay: 'always',
    });
  }
}

sets.sort(
  (a, b) =>
    a.section.localeCompare(b.section) ||
    a.category.localeCompare(b.category) ||
    a.name.localeCompare(b.name)
);
const library = { version: 1, generated: new Date().toISOString(), sets };
const libraryBytes = Buffer.from(JSON.stringify(library, null, 2));

if (emit) {
  console.log(JSON.stringify(sets));
  process.exit(0);
}

const catCounts = {};
for (const s of sets)
  catCounts[`${s.section} / ${s.category}`] = (catCounts[`${s.section} / ${s.category}`] ?? 0) + 1;
console.log(
  `library: ${sets.length} templates (${intervalCount} interval sounds, ${sets.length - intervalCount} ` +
    `ambient loops); ${uploads.length} audio files`
);
for (const [k, n] of Object.entries(catCounts)) console.log(`  ${String(n).padStart(3)}  ${k}`);
for (const p of problems) console.warn(`  WARN ${p}`);
if (problems.length) {
  console.error('problems found — refusing to upload.');
  process.exit(1);
}
if (checkOnly) process.exit(0);

/* ----------------------------------- sync to the box ----------------------------------- */

const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}
if (!env.MOLTEN_WEBDAV_PASSWORD) throw new Error('MOLTEN_WEBDAV_PASSWORD is not set in .env');
const dav = new WebDavClient({
  webdavUrl: env.MOLTEN_WEBDAV_URL,
  user: env.MOLTEN_WEBDAV_USER || 'foundry-ftp',
  password: env.MOLTEN_WEBDAV_PASSWORD,
});

// Pre-create all destination directories serially — concurrent MKCOL of the same parent
// races into 403s (seen live on the first bulk upload).
const dirs = new Set(uploads.map(u => u.dest.slice(0, u.dest.lastIndexOf('/'))));
for (const dir of [...dirs].sort()) await dav.ensureParents(`${dir}/x`);

let done = 0,
  skipped = 0,
  failed = 0;
const queue = [...uploads];
async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    try {
      const local = readFileSync(job.local);
      const remote = await dav.stat(job.dest);
      if (remote && Number(remote.size) === local.length) {
        skipped++;
      } else {
        const ext = job.dest.slice(job.dest.lastIndexOf('.')).toLowerCase();
        await dav.putFile(job.dest, local, AUDIO_TYPES[ext] ?? 'application/octet-stream');
        done++;
      }
    } catch (err) {
      failed++;
      console.error(`  FAIL ${job.dest}: ${err?.message || err}`);
    }
    const n = done + skipped + failed;
    if (n % 100 === 0)
      console.log(`  … ${n}/${uploads.length} (${done} up, ${skipped} skipped, ${failed} failed)`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`audio: ${done} uploaded, ${skipped} already present, ${failed} failed`);

// The library manifest itself — always overwritten, then read back and byte-verified.
const libDest = posix.join(DEST, 'library.json');
await dav.putFile(libDest, libraryBytes, 'application/json');
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 16);
const back = Buffer.from(await dav.getFile(libDest));
console.log(
  `library.json: ${sha(libraryBytes) === sha(back) ? 'byte-identical on the box' : 'MISMATCH after upload!'}`
);

// PRUNE: anything under soundscape-sfx/ that the repo no longer contains goes away.
if (!failed) {
  const keep = new Set([...uploads.map(u => u.dest), libDest]);
  let pruned = 0;
  async function prune(dirPath) {
    const entries = (await dav.propfind(dirPath, '1')).filter(e => e.path !== dirPath);
    let kept = 0;
    for (const e of entries) {
      if (e.isCollection) kept += await prune(e.path);
      else if (keep.has(e.path)) kept++;
      else {
        await dav.delete(e.path);
        pruned++;
      }
    }
    if (kept === 0 && dirPath !== DEST) {
      try {
        await dav.delete(dirPath, true);
      } catch (err) {
        /* leave an empty dir over failing */
      }
    }
    return kept;
  }
  await prune(DEST);
  console.log(`pruned ${pruned} stale file(s)`);
}

// Spot-verify a sample of audio byte sizes.
let sampleOk = true;
for (let i = 0; i < 8; i++) {
  const pick = uploads[Math.floor(Math.random() * uploads.length)];
  const remote = await dav.stat(pick.dest);
  if (!remote || Number(remote.size) !== statSync(pick.local).size) {
    sampleOk = false;
    console.error(`  sample MISMATCH: ${pick.dest}`);
  }
}
console.log(`sample of 8 audio files: ${sampleOk ? 'sizes match' : 'MISMATCH'}`);
console.log('If files moved or renamed, run scripts/remap-soundscape-scene-paths.mjs next.');
process.exit(failed || !sampleOk ? 1 : 0);
