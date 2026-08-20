// Page-side authoring for house module #6, fvtt-mod-soundscape — per-scene atmospheric SOUND SETS.
//
// WHAT THIS OWNS: a scene's `flags["fvtt-mod-soundscape"].sets` array. Soundscape is flags-only by
// design ("MCP-authorable by construction" — its design.md), so the FLAG is the contract and this
// writes it directly rather than going through `game.modules.get(...).api`. Two reasons that is the
// right seam: the array is the documented data shape, and a direct write still authors correctly
// when the module is missing or disabled (reported as a warning, never as a working set — the
// set-landing-scene precedent).
//
// ⚠️ SOURCE OF TRUTH for the set schema is the module's `scripts/engine.js#normalizeSet`. The
// normalizer below MIRRORS it field-for-field (same defaults, same clamps) and additionally REPORTS
// what it clamped, which is the half a tool owes a caller that a UI does not. If that module's
// schema ever gains a field, this is the file that has to follow.
//
// Set shape (fvtt-mod-soundscape design.md, "Data shape — flags-only"):
//   { id, name, active, files[], playStyle: "interval"|"loop", interval, intervalVariation,
//     crossfade, volume, volumeVariation, pitchVariation, whenToPlay: "always"|"day"|"night" }
//
// The engine is one scheduler with the gap sign flipped: interval sets play a random member then
// wait `interval ± intervalVariation` seconds of silence; loop sets overlap members under an
// equal-power crossfade (a single-file loop set crossfades into itself, so any file is seamless).

import { normalizeAssetPath } from './_shared.js';
import { imgResolves, badAssetWarning } from './img-resolve.js';
import { resolveSceneStrict } from './scenes.js';

export const SOUNDSCAPE_MODULE_ID = 'fvtt-mod-soundscape';

/**
 * The prebaked template manifest, at the Data ROOT rather than inside the module folder — Foundry's
 * installPackage clean-reinstalls `modules/<id>/` on every update and would wipe a library stored
 * there. Written by scripts/upload-soundscape-library.mjs.
 */
export const SOUNDSCAPE_LIBRARY_PATH = 'soundscape-sfx/library.json';

/** Darkness at or above which a scene counts as night (the module's day/night gate). */
export const NIGHT_DARKNESS = 0.5;

export interface SoundscapeSet {
  id: string;
  name: string;
  active: boolean;
  files: string[];
  playStyle: 'interval' | 'loop';
  interval: number;
  intervalVariation: number;
  crossfade: number;
  volume: number;
  volumeVariation: number;
  pitchVariation: number;
  whenToPlay: 'always' | 'day' | 'night';
}

/** A library template is a set plus the two taxonomy fields the picker cascades on. */
export interface SoundscapeTemplate extends Partial<SoundscapeSet> {
  name: string;
  section?: string;
  category?: string;
}

// ⚠️ Mirrors the module's own coercion, sharp edge included: the guard is `Number.isFinite(+v)`,
// and JS turns null / "" / [] into 0 — so those take the ZERO path, not the default, and then land
// on the clamped floor. Faithfulness beats kindness here: the module re-normalizes the flag on
// every read, so a "nicer" fallback would report a value its engine never uses. zod keeps null out
// of the tool path; this only ever bites a set that was already malformed on the scene.
const num = (v: unknown, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Coerce an arbitrary blob into a valid set, mirroring the module's normalizeSet — malformed input
 * is REPAIRED, never thrown on (the module's "fail open, never destructive" family rule).
 *
 * Returns the clamps alongside the set so the tool can say "interval 9000 → 3600" instead of
 * silently storing something the caller did not ask for. `id` is generated when absent, in the
 * module's own format (base-36, 10 chars).
 */
export function normalizeSoundscapeSet(raw: any = {}): {
  set: SoundscapeSet;
  clamped: string[];
} {
  const clamped: string[] = [];
  const note = (field: string, asked: unknown, got: number): void => {
    if (Number.isFinite(Number(asked)) && Number(asked) !== got) {
      clamped.push(`${field} ${Number(asked)} → ${got}`);
    }
  };

  const interval = clamp(num(raw.interval, 25), 1, 3600);
  note('interval', raw.interval, interval);
  // Variation is bounded BY the interval — a ±20s jitter on a 10s interval would ask for silence of
  // negative length. Normalizing the merged set (not the patch) is what keeps this honest when a
  // caller lowers `interval` and leaves an older, larger `intervalVariation` in place.
  const intervalVariation = clamp(num(raw.intervalVariation, 5), 0, interval);
  note('intervalVariation', raw.intervalVariation, intervalVariation);
  const crossfade = clamp(num(raw.crossfade, 4), 0.5, 30);
  note('crossfade', raw.crossfade, crossfade);
  const volume = clamp(num(raw.volume, 0.8), 0, 1);
  note('volume', raw.volume, volume);
  const volumeVariation = clamp(num(raw.volumeVariation, 0), 0, 1);
  note('volumeVariation', raw.volumeVariation, volumeVariation);
  const pitchVariation = clamp(num(raw.pitchVariation, 0), 0, 1);
  note('pitchVariation', raw.pitchVariation, pitchVariation);

  return {
    set: {
      id: typeof raw.id === 'string' && raw.id ? raw.id : Math.random().toString(36).slice(2, 12),
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'New Sound Set',
      active: raw.active !== false,
      files: Array.isArray(raw.files)
        ? raw.files.filter((f: any) => typeof f === 'string' && f)
        : [],
      playStyle: raw.playStyle === 'loop' ? 'loop' : 'interval',
      interval,
      intervalVariation,
      crossfade,
      volume,
      volumeVariation,
      pitchVariation,
      whenToPlay: ['day', 'night'].includes(raw.whenToPlay) ? raw.whenToPlay : 'always',
    },
    clamped,
  };
}

/** Does this set's whenToPlay gate admit the given darkness? (day < 0.5 ≤ night) */
export function gateAllows(set: Pick<SoundscapeSet, 'whenToPlay'>, darkness: number): boolean {
  if (set.whenToPlay === 'always') return true;
  return (set.whenToPlay === 'night') === darkness >= NIGHT_DARKNESS;
}

/** One-line timing summary, matching how the module's own scene-config tab reads. */
export function describeTiming(set: SoundscapeSet): string {
  return set.playStyle === 'loop'
    ? `loop · ${set.crossfade}s crossfade`
    : `every ${set.interval} ± ${set.intervalVariation}s`;
}

/**
 * Resolve a set within a scene's array: exact id, then exact name, then case-insensitive name.
 * Ambiguity THROWS rather than picking one — two sets can legitimately share a name, and silently
 * editing the wrong one is worse than an error that names both ids.
 */
export function resolveSet(sets: SoundscapeSet[], identifier: string): SoundscapeSet {
  const byId = sets.find(s => s.id === identifier);
  if (byId) return byId;
  const exact = sets.filter(s => s.name === identifier);
  if (exact.length === 1) return exact[0];
  const loose = exact.length
    ? exact
    : sets.filter(s => s.name.toLowerCase() === identifier.toLowerCase());
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) {
    throw new Error(
      `"${identifier}" matches ${loose.length} sound sets on this scene — pass the id instead: ` +
        loose.map(s => `${s.id} ("${s.name}")`).join(', ')
    );
  }
  throw new Error(
    `No sound set "${identifier}" on this scene. ` +
      (sets.length
        ? `Present: ${sets.map(s => `"${s.name}" (${s.id})`).join(', ')}`
        : 'The scene has no sound sets yet.')
  );
}

/**
 * Filter the template library. `query` matches the set name, its category, or its section, so
 * "tavern" finds both the Tavern category and any set named for one; ranking puts name matches
 * that START with the query first, which is what a caller typing a half-remembered name wants.
 */
export function matchTemplates(
  templates: SoundscapeTemplate[],
  filters: { query?: string; section?: string; category?: string }
): SoundscapeTemplate[] {
  const q = (filters.query ?? '').trim().toLowerCase();
  const section = (filters.section ?? '').trim().toLowerCase();
  const category = (filters.category ?? '').trim().toLowerCase();

  const hits = templates.filter(t => {
    if (section && (t.section ?? '').toLowerCase() !== section) return false;
    if (category && !(t.category ?? '').toLowerCase().includes(category)) return false;
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      (t.category ?? '').toLowerCase().includes(q) ||
      (t.section ?? '').toLowerCase().includes(q)
    );
  });

  if (!q) return hits;
  const rank = (t: SoundscapeTemplate): number => {
    const n = t.name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    return 3;
  };
  return hits.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * Resolve the ONE library template an `add` call means.
 *
 * Name matching is EXACT — a half-remembered name is an error, not a coin flip — but the caller's
 * `section`/`category` narrowing is applied FIRST. That narrowing is load-bearing, not cosmetic:
 * five names in the shipped library exist in BOTH sections (Crow Caws, Owl Hoots, Rain Light, Sea
 * Surf Large, Sea Surf Small are each an interval pool *and* an ambient bed), and the ambiguity
 * error below tells the caller to narrow — so narrowing has to actually work.
 */
export function resolveTemplate(
  templates: SoundscapeTemplate[],
  template: string,
  filters: { section?: string; category?: string } = {}
): SoundscapeTemplate {
  const scoped = matchTemplates(templates, filters);
  const narrowed = scoped.length !== templates.length;
  const wanted = template.trim().toLowerCase();
  const found = scoped.filter(t => t.name.trim().toLowerCase() === wanted);

  if (found.length === 1) return found[0];

  if (!found.length) {
    // Suggest from the WHOLE library rather than the narrowed slice: "it exists, but in the other
    // section" is the most useful thing to tell someone who just narrowed past their own hit.
    const near = matchTemplates(templates, { query: template })
      .slice(0, 8)
      .map(t => `"${t.name}" (${t.section} / ${t.category})`);
    throw new Error(
      `No library template named "${template}"` +
        (narrowed ? ' in the requested section/category' : '') +
        '.' +
        (near.length
          ? ` Closest: ${near.join(', ')}`
          : ' Browse with action "library" to see what exists.')
    );
  }

  throw new Error(
    `"${template}" matches ${found.length} templates: ` +
      found.map(t => `${t.section} / ${t.category}`).join(', ') +
      (narrowed
        ? '. Pass explicit `files` instead.'
        : '. Narrow it with `section` or `category`, or pass explicit `files`.')
  );
}

/** section → category → count, for orienting a caller who has not named a filter yet. */
export function summarizeLibrary(templates: SoundscapeTemplate[]): Array<{
  section: string;
  total: number;
  categories: Array<{ category: string; count: number }>;
}> {
  const bySection = new Map<string, Map<string, number>>();
  for (const t of templates) {
    const sec = t.section || 'Interval Sounds';
    const cat = t.category || 'Uncategorized';
    if (!bySection.has(sec)) bySection.set(sec, new Map());
    const cats = bySection.get(sec)!;
    cats.set(cat, (cats.get(cat) ?? 0) + 1);
  }
  return [...bySection.entries()]
    .map(([section, cats]) => ({
      section,
      total: [...cats.values()].reduce((a, b) => a + b, 0),
      categories: [...cats.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    }))
    .sort((a, b) => a.section.localeCompare(b.section));
}

/* ---------------------------------------------------------------------------------------------- */
/*  Page-coupled paths                                                                            */
/* ---------------------------------------------------------------------------------------------- */

const rawSets = (scene: any): any[] => scene?.flags?.[SOUNDSCAPE_MODULE_ID]?.sets ?? [];

/** Every set on a scene, repaired. Clamp reports are dropped here — reads never rewrite anything. */
function readSets(scene: any): SoundscapeSet[] {
  return rawSets(scene).map((s: any) => normalizeSoundscapeSet(s).set);
}

/** Scene darkness on v14's environment path, with the legacy fallback (matches the module). */
function darknessOf(scene: any): number {
  return scene?.environment?.darknessLevel ?? scene?.darkness ?? 0;
}

/**
 * The sets are only instructions — the MODULE is what plays them. Say so plainly when nothing is
 * listening, rather than reporting a working soundscape.
 */
function moduleWarnings(): {
  installed: boolean;
  enabled: boolean;
  version: string | null;
  warnings: string[];
} {
  const mod = (globalThis as any).game?.modules?.get?.(SOUNDSCAPE_MODULE_ID);
  const warnings: string[] = [];
  if (!mod) {
    warnings.push(
      `the "${SOUNDSCAPE_MODULE_ID}" module is NOT INSTALLED in this world — the sets are written ` +
        'but NOTHING plays them. Install it (https://github.com/Txpple/fvtt-mod-soundscape).'
    );
  } else if (!mod.active) {
    warnings.push(
      `the "${SOUNDSCAPE_MODULE_ID}" module is installed but DISABLED — the sets are written but ` +
        'nothing plays them. Enable it in Manage Modules.'
    );
  }
  return {
    installed: !!mod,
    enabled: !!mod?.active,
    version: mod?.version ?? null,
    warnings,
  };
}

let libraryCache: SoundscapeTemplate[] | null | undefined;

/** Fetch (and memoize) the Data-root template manifest. Null when it is absent or unreadable. */
async function loadLibrary(): Promise<SoundscapeTemplate[] | null> {
  if (libraryCache !== undefined) return libraryCache;
  try {
    const getRoute = (globalThis as any).foundry?.utils?.getRoute;
    const url =
      typeof getRoute === 'function' ? getRoute(SOUNDSCAPE_LIBRARY_PATH) : SOUNDSCAPE_LIBRARY_PATH;
    const res = await fetch(url, { cache: 'no-cache' });
    const json = res.ok ? await res.json() : null;
    libraryCache = Array.isArray(json?.sets) ? (json.sets as SoundscapeTemplate[]) : null;
  } catch {
    libraryCache = null;
  }
  return libraryCache;
}

/** KEEP+WARN asset policy (Group B): an audio track has no sensible substitute, so a 404 warns. */
async function checkFiles(files: string[]): Promise<{ files: string[]; missing: string[] }> {
  const normalized = files.map(f => normalizeAssetPath(f)).filter(Boolean);
  const missing: string[] = [];
  for (const f of normalized) {
    if (!(await imgResolves(f))) missing.push(f);
  }
  return { files: normalized, missing };
}

/** The scene a call targets: an explicit identifier, else the ACTIVE scene. */
function targetScene(identifier?: string): any {
  if (identifier) {
    const scene = resolveSceneStrict(identifier);
    if (!scene) {
      throw new Error(
        `Scene not found: "${identifier}". Use an exact id or name (list-scenes shows both).`
      );
    }
    return scene;
  }
  const active = (globalThis as any).game?.scenes?.active;
  if (!active) {
    throw new Error(
      'No sceneIdentifier given and there is no ACTIVE scene to fall back on — name a scene.'
    );
  }
  return active;
}

function sceneSummary(scene: any): { id: string; name: string; active: boolean; darkness: number } {
  return {
    id: scene.id,
    name: scene.name,
    active: !!scene.active,
    darkness: darknessOf(scene),
  };
}

/** Persist the whole array in one write; the module's updateScene hook re-syncs every client. */
async function persist(scene: any, sets: SoundscapeSet[]): Promise<void> {
  await scene.setFlag(SOUNDSCAPE_MODULE_ID, 'sets', sets);
}

export interface ConfigureSoundscapeArgs {
  action: 'list' | 'library' | 'add' | 'update' | 'remove';
  sceneIdentifier?: string;
  setIdentifier?: string;
  template?: string;
  query?: string;
  section?: string;
  category?: string;
  limit?: number;
  verifyFiles?: boolean;
  name?: string;
  files?: string[];
  playStyle?: 'interval' | 'loop';
  interval?: number;
  intervalVariation?: number;
  crossfade?: number;
  volume?: number;
  volumeVariation?: number;
  pitchVariation?: number;
  whenToPlay?: 'always' | 'day' | 'night';
  active?: boolean;
}

/** The set fields a caller may supply, in the order they are reported back. */
const SET_FIELDS = [
  'name',
  'files',
  'playStyle',
  'interval',
  'intervalVariation',
  'crossfade',
  'volume',
  'volumeVariation',
  'pitchVariation',
  'whenToPlay',
  'active',
] as const;

/** Only the set fields the caller actually named — absent means "leave alone", not "reset". */
function patchFrom(args: ConfigureSoundscapeArgs): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of SET_FIELDS) {
    if (args[field] !== undefined) patch[field] = args[field];
  }
  return patch;
}

/**
 * configure-soundscape — read and author a scene's Soundscape sound sets, and browse the prebaked
 * template library that feeds them.
 */
export async function configureSoundscape(args: ConfigureSoundscapeArgs): Promise<any> {
  const action = args?.action;

  // ---- library: a read over the Data-root manifest; touches no scene ---------------------------
  if (action === 'library') {
    const templates = await loadLibrary();
    if (!templates) {
      return {
        action,
        libraryPath: SOUNDSCAPE_LIBRARY_PATH,
        libraryFound: false,
        total: 0,
        sections: [],
        matches: [],
        warnings: [
          `no template library at "${SOUNDSCAPE_LIBRARY_PATH}" — sets can still be authored by ` +
            'passing explicit `files` paths. Run scripts/upload-soundscape-library.mjs to publish one.',
        ],
      };
    }
    const limit = Math.max(1, Math.min(200, args.limit ?? 40));
    const hits = matchTemplates(templates, args);
    return {
      action,
      libraryPath: SOUNDSCAPE_LIBRARY_PATH,
      libraryFound: true,
      total: templates.length,
      matched: hits.length,
      truncated: Math.max(0, hits.length - limit),
      sections: summarizeLibrary(templates),
      matches: hits.slice(0, limit).map(t => {
        const { set } = normalizeSoundscapeSet(t);
        return {
          name: t.name,
          section: t.section ?? 'Interval Sounds',
          category: t.category ?? 'Uncategorized',
          playStyle: set.playStyle,
          fileCount: set.files.length,
          timing: describeTiming(set),
          volume: set.volume,
        };
      }),
    };
  }

  const scene = targetScene(args?.sceneIdentifier);
  const status = moduleWarnings();
  const darkness = darknessOf(scene);
  const sets = readSets(scene);

  // ---- list -----------------------------------------------------------------------------------
  if (action === 'list') {
    const combatDucking = !!(globalThis as any).game?.combat?.started;
    const rows = [];
    for (const set of sets) {
      const gated = gateAllows(set, darkness);
      const row: any = {
        id: set.id,
        name: set.name,
        active: set.active,
        playStyle: set.playStyle,
        fileCount: set.files.length,
        files: set.files,
        timing: describeTiming(set),
        volume: set.volume,
        volumeVariation: set.volumeVariation,
        pitchVariation: set.pitchVariation,
        whenToPlay: set.whenToPlay,
        // What a client VIEWING this scene would be doing right now. Deliberately computed from
        // the flags rather than read off the bridge's own engine: the headless client never
        // crosses the browser autoplay gate, so its scheduler list is empty on a healthy world.
        wouldPlayNow: set.active && gated && set.files.length > 0,
      };
      if (!set.files.length) row.idle = 'no files in the pool';
      else if (!set.active) row.idle = 'set is inactive';
      else if (!gated) row.idle = `gated to ${set.whenToPlay} (scene darkness ${darkness})`;
      if (args.verifyFiles) {
        const { missing } = await checkFiles(set.files);
        if (missing.length) row.missingFiles = missing;
      }
      rows.push(row);
    }
    return {
      action,
      scene: sceneSummary(scene),
      module: { installed: status.installed, enabled: status.enabled, version: status.version },
      combatDucking,
      filesVerified: !!args.verifyFiles,
      sets: rows,
      warnings: status.warnings,
    };
  }

  // ---- remove ---------------------------------------------------------------------------------
  if (action === 'remove') {
    const identifier = args?.setIdentifier ?? '';
    if (!identifier)
      throw new Error('remove needs setIdentifier (a set id or exact name, or "all").');
    if (identifier.toLowerCase() === 'all') {
      if (!sets.length) {
        return { action, scene: sceneSummary(scene), removed: [], remaining: 0, warnings: [] };
      }
      await persist(scene, []);
      return {
        action,
        scene: sceneSummary(scene),
        removed: sets.map(s => ({ id: s.id, name: s.name })),
        remaining: 0,
        warnings: [],
      };
    }
    const set = resolveSet(sets, identifier);
    const kept = sets.filter(s => s.id !== set.id);
    await persist(scene, kept);
    return {
      action,
      scene: sceneSummary(scene),
      removed: [{ id: set.id, name: set.name }],
      remaining: kept.length,
      warnings: [],
    };
  }

  // ---- add / update ---------------------------------------------------------------------------
  const patch = patchFrom(args);
  const warnings = [...status.warnings];
  let base: Record<string, unknown>;
  let fromTemplate: string | undefined;
  let before: SoundscapeSet | undefined;

  if (action === 'add') {
    if (args.template) {
      const templates = await loadLibrary();
      if (!templates) {
        throw new Error(
          `Cannot add from template: no library at "${SOUNDSCAPE_LIBRARY_PATH}". Pass explicit ` +
            '`files` instead, or publish a library (scripts/upload-soundscape-library.mjs).'
        );
      }
      const match = resolveTemplate(templates, args.template, args);
      // The taxonomy fields are picker metadata, not part of a scene's set; drop them, and drop the
      // template's id so every copy is its own set (the module's own library picker does the same).
      const { section: _s, category: _c, id: _i, ...template } = match as any;
      base = template;
      fromTemplate = match.name;
    } else {
      if (!args.name || !Array.isArray(args.files) || !args.files.length) {
        throw new Error(
          'add needs either `template` (a library set name — browse with action "library") or ' +
            'both `name` and a non-empty `files` array of Data-relative audio paths.'
        );
      }
      base = {};
    }
  } else if (action === 'update') {
    if (!args.setIdentifier) {
      throw new Error('update needs setIdentifier (a set id or exact name — see action "list").');
    }
    before = resolveSet(sets, args.setIdentifier);
    base = { ...before };
    if (!Object.keys(patch).length) {
      throw new Error(
        `update named no fields to change. Supply at least one of: ${SET_FIELDS.join(', ')}.`
      );
    }
  } else {
    throw new Error(
      `Unknown action "${String(action)}" — expected list, library, add, update, or remove.`
    );
  }

  const merged: Record<string, unknown> = { ...base, ...patch };
  if (before) merged.id = before.id;

  // KEEP+WARN on a 404: a missing track is authored faithfully and reported, never swapped.
  if (Array.isArray(merged.files) && merged.files.length) {
    const { files, missing } = await checkFiles(merged.files as string[]);
    merged.files = files;
    for (const f of missing) warnings.push(badAssetWarning('file', f, false));
  }

  const { set, clamped } = normalizeSoundscapeSet(merged);
  if (!set.files.length) {
    warnings.push('this set has no files — it will stay silent until audio paths are added.');
  }

  const next = before ? sets.map(s => (s.id === set.id ? set : s)) : [...sets, set];
  await persist(scene, next);

  const changed = before
    ? SET_FIELDS.filter(f => JSON.stringify((before as any)[f]) !== JSON.stringify((set as any)[f]))
    : [];

  return {
    action,
    scene: sceneSummary(scene),
    module: { installed: status.installed, enabled: status.enabled, version: status.version },
    fromTemplate,
    set: {
      ...set,
      timing: describeTiming(set),
      wouldPlayNow: set.active && gateAllows(set, darkness) && set.files.length > 0,
    },
    before: before ? { ...before, timing: describeTiming(before) } : undefined,
    changed,
    clamped,
    total: next.length,
    warnings,
  };
}
