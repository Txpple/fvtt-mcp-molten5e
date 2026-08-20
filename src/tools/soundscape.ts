import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * configure-soundscape — author the per-scene SOUND SETS of house module #6, fvtt-mod-soundscape.
 *
 * Soundscape fills a gap core Foundry has no shape for: AmbientSound placeables are positional
 * single-file loops and Playlists have no concept of *silence with variation*, so neither can do "a
 * crow, then quiet, then a distant dog". A Soundscape set is a POOL of files plus a play style —
 * interval sets play a random member then wait `interval ± variation` seconds; loop sets overlap
 * members under an equal-power crossfade, which makes a single file a seamless bed with no
 * loop-point authoring. A scene carries any number of them, stacked.
 *
 * One action-based tool rather than a CRUD family: the whole surface is one flag array on one
 * document, and folding the template-library browse in beside it keeps a rarely-used authoring path
 * from costing a second tool description in every session. The page layer (configureSoundscape)
 * owns correctness — the set schema, its clamps, set resolution, and the KEEP+WARN asset check.
 */

export interface SoundscapeToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

// Single source of truth for the tool's input contract: the handler parses with this schema and
// getToolDefinitions() advertises toInputSchema(...) of the same schema.
const ConfigureSoundscapeSchema = z.object({
  action: z
    .enum(['list', 'library', 'add', 'update', 'remove'])
    .describe(
      "list = the scene's sound sets (with what would be playing right now); library = browse the " +
        'prebaked template catalog; add/update/remove = author them.'
    ),
  sceneIdentifier: z
    .string()
    .optional()
    .describe(
      'Scene id or exact name. STRICT — no fuzzy matching. Omit to target the ACTIVE scene. ' +
        'Ignored by action "library" (the catalog is world-wide).'
    ),
  setIdentifier: z
    .string()
    .optional()
    .describe(
      'Which set to update/remove — its id or exact name (ids come from action "list"; a name that ' +
        'matches two sets is an error, not a coin flip). On "remove", the literal "all" clears ' +
        'every set from the scene.'
    ),

  // --- library browse / add-from-template -------------------------------------------------------
  template: z
    .string()
    .optional()
    .describe(
      'action "add": copy this LIBRARY template (its exact name, from action "library") — files, ' +
        'play style, and timing all come along. Any other field passed alongside overrides the ' +
        "template's value. Omit to author a set from explicit `files` instead."
    ),
  query: z
    .string()
    .optional()
    .describe('action "library": match on template name, category, or section (e.g. "tavern").'),
  section: z
    .enum(['Interval Sounds', 'Ambient Loops'])
    .optional()
    .describe(
      'action "library": restrict to one section. Interval Sounds = randomized one-shots; ' +
        'Ambient Loops = continuous beds.'
    ),
  category: z
    .string()
    .optional()
    .describe('action "library": restrict to a category (substring match, e.g. "Forest").'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(40)
    .describe('action "library": maximum templates to return (default 40).'),
  verifyFiles: z
    .boolean()
    .default(false)
    .describe(
      'action "list": HEAD-check every pool file and report the missing ones. Off by default ' +
        'because it costs one request per file — turn it on when a set is silent and you want to know why.'
    ),

  // --- set fields (add / update) ----------------------------------------------------------------
  name: z
    .string()
    .optional()
    .describe('Set name. Required when adding from `files`; optional rename on update.'),
  files: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Data-relative audio paths making up the pool (what upload-asset returns). On UPDATE this ' +
        'REPLACES the whole pool. A path that does not resolve is kept and warned about, never swapped.'
    ),
  playStyle: z
    .enum(['interval', 'loop'])
    .optional()
    .describe(
      'interval = a random file, then `interval ± intervalVariation` seconds of silence. ' +
        'loop = a continuous bed, members overlapped under a crossfade. Default interval.'
    ),
  interval: z
    .number()
    .optional()
    .describe('Interval sets: seconds of silence between one-shots (1–3600, default 25).'),
  intervalVariation: z
    .number()
    .optional()
    .describe(
      'Interval sets: ± jitter on the silence, in seconds (default 5). Clamped to never exceed `interval`.'
    ),
  crossfade: z
    .number()
    .optional()
    .describe('Loop sets: overlap between members in seconds (0.5–30, default 4).'),
  volume: z
    .number()
    .optional()
    .describe('Set volume 0–1 (default 0.8), under the Ambient channel.'),
  volumeVariation: z
    .number()
    .optional()
    .describe(
      'Per-play volume jitter 0–1, attenuate-only — never louder than `volume` (default 0).'
    ),
  pitchVariation: z
    .number()
    .optional()
    .describe(
      'Per-play pitch jitter in OCTAVES, 0–1 (default 0). 0.1 is a subtle, natural wobble.'
    ),
  whenToPlay: z
    .enum(['always', 'day', 'night'])
    .optional()
    .describe(
      'Darkness gate, re-evaluated live: day = scene darkness < 0.5, night = ≥ 0.5 (default always).'
    ),
  active: z.boolean().optional().describe('Whether the set runs at all (default true).'),
});

export class SoundscapeTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: SoundscapeToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'SoundscapeTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'configure-soundscape',
        description:
          "Author a scene's atmospheric SOUND SETS — the house module fvtt-mod-soundscape (#6), " +
          'which does what core Foundry cannot: a POOL of small audio files played at randomized ' +
          'intervals with silence between (a crow, quiet, a distant dog), or overlapped into a ' +
          'seamless crossfaded bed. AmbientSound placeables are positional single-file loops and ' +
          'Playlists have no silence-with-variation, so neither covers this. A scene carries any ' +
          'number of sets, stacked and independent. Actions: "list" (what the scene has, plus what ' +
          'would be playing right now and why a set is idle), "library" (browse the prebaked ' +
          'template catalog by section/category/name), "add" (copy a template by name, or author ' +
          'one from explicit `files`), "update" (patch one set — named fields only; `files` ' +
          'replaces the whole pool), "remove" (one set, or "all"). Defaults to the ACTIVE scene ' +
          "when no sceneIdentifier is given. Out-of-range numbers are CLAMPED to the module's " +
          'limits and the clamp is reported, not applied silently. Audio paths are HEAD-checked: a ' +
          '404 is kept and warned about (a track has no sensible substitute). Sets are inert data ' +
          'without the module, so this WARNS when it is missing or disabled instead of reporting a ' +
          'working soundscape. GM-only.',
        inputSchema: toInputSchema(ConfigureSoundscapeSchema),
      },
    ];
  }

  async handleConfigureSoundscape(args: any): Promise<string> {
    const parsed = ConfigureSoundscapeSchema.parse(args ?? {});
    this.logger.info('Configuring soundscape', {
      action: parsed.action,
      scene: parsed.sceneIdentifier ?? '(active)',
    });
    const result = await this.foundry.call('configureSoundscape', parsed);

    switch (result?.action) {
      case 'library':
        return formatLibrary(result);
      case 'list':
        return formatList(result);
      case 'remove':
        return formatRemoval(result);
      default:
        return formatWrite(result);
    }
  }
}

const warningBlock = (warnings?: string[]): string =>
  warnings?.length ? `\n\n⚠️ ${warnings.map(w => `- ${w}`).join('\n')}` : '';

const sceneLine = (scene: any): string =>
  `${scene?.name} (${scene?.id})${scene?.active ? ' — the ACTIVE scene' : ''}` +
  `, darkness ${scene?.darkness}`;

function formatLibrary(result: any): string {
  if (!result.libraryFound) {
    return `📚 No Soundscape template library on this world.${warningBlock(result.warnings)}`;
  }
  const filtered = result.matched !== result.total;
  const head =
    `📚 Soundscape library — ${result.total} template(s) at ${result.libraryPath}` +
    (filtered ? `, ${result.matched} matching` : '');

  const sections = result.sections
    .map(
      (s: any) =>
        `\n  ${s.section} (${s.total}): ` +
        s.categories.map((c: any) => `${c.category} ${c.count}`).join(' · ')
    )
    .join('');

  const matches = result.matches.length
    ? '\n\n' +
      result.matches
        .map(
          (t: any) =>
            `  • "${t.name}" — ${t.section} / ${t.category} · ${t.fileCount} file(s) · ${t.timing}`
        )
        .join('\n')
    : '\n\n  (no template matched)';

  const more = result.truncated
    ? `\n  …and ${result.truncated} more — narrow with query/section/category, or raise limit.`
    : '';

  return (
    head + sections + matches + more + '\n\n  Add one with action "add" + template "<exact name>".'
  );
}

function formatList(result: any): string {
  const mod = result.module?.installed
    ? result.module.enabled
      ? `module v${result.module.version ?? '?'} enabled`
      : 'module DISABLED'
    : 'module NOT INSTALLED';

  if (!result.sets.length) {
    return (
      `🔇 No sound sets on ${sceneLine(result.scene)} — ${mod}.` +
      '\n  Browse action "library" for a prebaked set, or add one from explicit files.' +
      warningBlock(result.warnings)
    );
  }

  const playing = result.sets.filter((s: any) => s.wouldPlayNow).length;
  const rows = result.sets
    .map((s: any) => {
      const flag = s.wouldPlayNow ? '▶' : '⏸';
      const gate = s.whenToPlay === 'always' ? '' : ` · ${s.whenToPlay} only`;
      const idle = s.idle ? ` — idle: ${s.idle}` : '';
      const missing = s.missingFiles?.length
        ? `\n      ⚠ ${s.missingFiles.length} missing file(s): ${s.missingFiles.join(', ')}`
        : '';
      return (
        `  ${flag} "${s.name}" (${s.id})\n` +
        `      ${s.playStyle} · ${s.fileCount} file(s) · ${s.timing} · vol ${s.volume}${gate}${idle}${missing}`
      );
    })
    .join('\n');

  return (
    `🔊 ${result.sets.length} sound set(s) on ${sceneLine(result.scene)} — ${mod}.\n` +
    `  ${playing} would be playing now for a client viewing this scene` +
    (result.combatDucking ? ' (combat is running — sets are DUCKED under the combat music)' : '') +
    (result.filesVerified ? '' : ' · pass verifyFiles to HEAD-check the pools') +
    `\n${rows}` +
    warningBlock(result.warnings)
  );
}

function formatRemoval(result: any): string {
  if (!result.removed.length) {
    return `Nothing to remove — ${result.scene?.name} has no sound sets.`;
  }
  return (
    `🗑️ Removed ${result.removed.length} sound set(s) from ${sceneLine(result.scene)}: ` +
    result.removed.map((s: any) => `"${s.name}"`).join(', ') +
    `\n  ${result.remaining} set(s) remain.`
  );
}

function formatWrite(result: any): string {
  const set = result.set;
  const verb = result.action === 'add' ? 'Added' : 'Updated';
  const source = result.fromTemplate ? ` from library template "${result.fromTemplate}"` : '';

  const head =
    `🔊 ${verb} sound set "${set.name}" (${set.id})${source} on ${sceneLine(result.scene)}.\n` +
    `  ${set.playStyle} · ${set.files.length} file(s) · ${set.timing} · vol ${set.volume}` +
    (set.whenToPlay === 'always' ? '' : ` · ${set.whenToPlay} only`) +
    (set.active ? '' : ' · INACTIVE') +
    `\n  ${set.wouldPlayNow ? 'Playing now' : 'Not playing right now'} for a client viewing this scene` +
    ` · ${result.total} set(s) on the scene.`;

  const changed =
    result.action === 'update'
      ? result.changed?.length
        ? `\n  changed: ${result.changed.join(', ')}`
        : '\n  nothing actually changed — the set already read that way.'
      : '';

  const clamped = result.clamped?.length
    ? `\n  clamped to the module's limits: ${result.clamped.join(', ')}`
    : '';

  return head + changed + clamped + warningBlock(result.warnings);
}
