// dnd5e PC leveling engine — page-side. Runs INSIDE the headless Foundry page (dnd5e 5.3.3,
// Foundry v14). This is the ONE place advancement.apply(level, data, {initial}) is ever called, plus
// the build-on-temp → snapshot → Actor.create persist cycle. PCs are a SEPARATE product from NPCs
// (design.md §7): type:character + advancement (which resolves @scale.* natively), never bolted onto
// createNpcActor.
//
// The whole approach is de-risked by scripts/spike-pc-build.mjs (11/11 on sandbox). The non-obvious
// findings it proved, encoded below:
//   • Advancement levels can be STRINGS ("0"/"1") — ALWAYS coerce to Number before matching.
//   • Species + background creation features live at advancement level 0; class features at level 1.
//     So a level-1 PC applies the union of levels {0,1} across class + species + background.
//   • {initial:true} applies FORCED/automatic grants (HP max, mandatory ItemGrant feats, forced
//     Trait profs). It CLOBBERS player picks: TraitAdvancement.apply overwrites `data` with
//     automaticApplicationValue when initial is set. So a player pick is a SECOND apply call with NO
//     initial: Trait → apply(lvl,{chosen:[keys]}); ItemChoice → apply(lvl,{selected:[uuids]}).
//   • Persist is naive-safe: toObject()→Actor.create preserves embedded item _ids, so originalClass
//     stays valid + HP is correct (defensive re-anchor kept as insurance).
//   • Caster L1 spell slots AUTO-DERIVE from class spellcasting progression (no manual slot write).
//   • disableAdvancements must be true during the build (prevents the auto-AdvancementManager render
//     on class embed — which hangs headless); it is restored afterward.
//   • The AdvancementManager is NEVER touched (its .close() prompts a discard Dialog → headless hang).

import { isPremiumBookPack } from '../../utils/compendium-sources.js';
import { updateActor } from '../actors.js';
import {
  findUnresolvedScaleTokens,
  getOrCreateFolder,
  importFromCompendium,
  resolveActorFuzzy,
  toSource,
} from '../_shared.js';
import { addSpellsToActor } from './spells.js';
import { readDarkvision, TOKEN_DISPOSITION, tokenDefaults } from './token-defaults.js';

/**
 * Resolve a PC's target folder to a real Folder **id**. Accepts a folder id OR an exact folder name
 * (type Actor), creating the folder when a name doesn't exist yet; with no `folder` requested, falls
 * back to the default "Foundry MCP Characters" folder. Returns null only if creation fails.
 *
 * WHY THIS EXISTS: the caller passes a folder NAME (e.g. "DM Tools"). The old code used that string
 * directly as `snapshot.folder`, so `Actor.create` received a name where Foundry expects a Folder id
 * and THREW ("An unexpected error occurred"). Resolving the name → id here fixes create-pc /
 * create-pc-from-prefab when a `folder` is supplied.
 */
async function resolvePcFolderId(folder?: string): Promise<string | null> {
  if (folder && folder.trim().length > 0) {
    const f = folder.trim();
    const existing =
      game.folders?.get(f) || game.folders?.find((x: any) => x.name === f && x.type === 'Actor');
    return existing ? existing.id : await getOrCreateFolder(f, 'Actor');
  }
  return getOrCreateFolder('Foundry MCP Characters', 'Actor');
}

// =============================================================================
// Types
// =============================================================================

/** Final ability scores (the SKILL owns point-buy/array/ASI math — design.md §2.1). */
export interface PcAbilities {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

/**
 * Per-source, per-level, per-advancement-id choice data. Shape mirrors what advancement.apply expects:
 *   Trait      → { chosen: string[] }   (trait keys, e.g. "skills:acr")
 *   ItemChoice → { selected: string[] } (item uuids from the pool)
 *   Subclass   → { uuid: string }       (v2 — granted at L3, not advertised in v1)
 * Keyed `choices[levelString][advancementId] = data`. The skill learns the ids + shapes from
 * inspect-pc-advancement (or create-pc's needsChoices dry-run).
 */
export type PcChoiceMap = Record<string, Record<string, Record<string, unknown>>>;

export interface PcBuildPlan {
  name: string;
  className: string;
  species?: string;
  background?: string;
  /** FINAL ability scores (skill owns the math). Omitted → left at the dnd5e defaults. */
  abilities?: PcAbilities;
  choices?: PcChoiceMap;
  /** Caster spell picks by NAME (cantrips always-prepared; leveled go to the spellbook). */
  spells?: { cantrips?: string[]; prepared?: string[] };
  /** Character level 1..20 (v2). The engine loops levels {0..level}; HP/subclass/slots scale with it. */
  level?: number;
  /**
   * Additional classes for a multiclass PC built in ONE call (v4). Each is a SECONDARY class — the
   * `className`/`level` above is the PRIMARY (the originalClass). A secondary class gets the 2024
   * multiclass proficiency SUBSET (via classRestriction) and its first level's HP is the average, not
   * max. Total character level (primary `level` + every multiclass `levels`) must be ≤ 20, and a class
   * may appear only once (use levelUpPc to add further levels to an existing class).
   */
  multiclass?: Array<{ className: string; levels: number }>;
  /** HP per level past the first: 'avg' (2024 fixed average, default) or 'max'. L1 (original class) is always max. */
  hpMode?: 'avg' | 'max';
  sourceRules?: string;
  folder?: string;
  /**
   * When a REQUIRED player choice (a Trait pick / ItemChoice / Subclass) has no supplied data, the
   * tool by default does NOT persist — it returns needsChoices so the skill can fill them and
   * re-call (no litter actor). Set true to proceed anyway, applying only forced defaults for the
   * unsupplied picks (the skill decides proceed-with-defaults vs ask — design.md §2.1).
   */
  acceptDefaults?: boolean;
}

/** One choice point a class/species/background/subclass advancement exposes (descriptive — never auto-picked). */
export interface AdvancementChoice {
  id: string;
  source: 'class' | 'species' | 'background' | 'subclass';
  level: number;
  type: string; // 'Trait' | 'ItemChoice' | 'Subclass'
  title: string;
  /** the key advancement.apply expects this choice's data under. */
  dataKey: 'chosen' | 'selected' | 'uuid';
  /** how many to pick. */
  count: number;
  /** legal options — trait keys (may be wildcard categories like "languages:standard:*") or items. */
  options: Array<{ value: string; label?: string }>;
}

/** A normalized advancement descriptor lifted off a live dnd5e item (one per advancement object). */
interface RawAdvancement {
  id: string;
  type: string;
  title: string;
  levels: number[];
  /** '' (always) | 'primary' (original class only) | 'secondary' (multiclass only) — the 2024 multiclass subset. */
  classRestriction: string;
  /** the live advancement object (carries .apply + .configuration). null in unit mocks. */
  adv: any;
  configuration: any;
}

/** Should an advancement with this classRestriction be applied for a class taken in this role? */
export function allowedForRole(
  classRestriction: string,
  classRole?: 'primary' | 'secondary'
): boolean {
  if (!classRole) return true; // species/background/subclass — restriction never set
  if (classRole === 'primary') return classRestriction !== 'secondary';
  return classRestriction !== 'primary'; // secondary (multiclass) — skip primary-only profs
}

/** What `applyItemAdvancements` decides to do for ONE advancement at ONE level — pure, no side effects. */
export type AdvancementStep =
  | { kind: 'skip'; reason: string }
  | { kind: 'apply'; data: Record<string, unknown>; initial: boolean; result?: string };

export interface AdvancementPlanInput {
  type: string;
  classRestriction: string;
  level: number;
  // `| undefined` (not just optional) so callers can pass the threaded classRole through verbatim under
  // exactOptionalPropertyTypes (species/background/subclass have no role).
  classRole?: 'primary' | 'secondary' | undefined;
  /** the class item carrying this advancement is the originalClass (its L1 HP is max). */
  isOriginalClass: boolean;
  hpMode: 'avg' | 'max';
  /** the supplied choice for this level+advancement (choices[String(level)][id]), if any. */
  choiceData?: { chosen?: unknown; selected?: unknown; uuid?: unknown } | undefined;
}

/**
 * The apply-sequencing DECISION for one advancement, extracted PURE so the subtle ordering (the
 * 2024 multiclass role subset, original-L1-max HP, the ASI skip, and the two-step forced-then-pick
 * apply for Trait/ItemChoice/Subclass) is unit-testable offline. `applyItemAdvancements` executes
 * the returned steps (the only side effect — advancement.apply — stays there). Mirrors design.md's
 * "tools own deterministic correctness." Levels: {initial:true} only sets the original class's L1;
 * every other level passes explicit HP data, else HP under-counts. {initial} clobbers data.chosen for
 * a Trait, so a supplied pick is a SECOND apply with no initial.
 */
export function planAdvancementApply(input: AdvancementPlanInput): AdvancementStep[] {
  const { type, classRestriction, level, classRole, isOriginalClass, hpMode, choiceData } = input;

  if (!allowedForRole(classRestriction, classRole)) {
    return [
      { kind: 'skip', reason: `skipped (${classRestriction}-only; this class is ${classRole})` },
    ];
  }
  if (type === 'HitPoints') {
    const mode = level === 1 && isOriginalClass ? 'max' : hpMode;
    return [{ kind: 'apply', data: { [level]: mode }, initial: false, result: `hp:${mode}` }];
  }
  if (type === 'AbilityScoreImprovement') {
    // The skill owns FINAL ability scores (§2.1); a feat at an ASI tier is composed via add-feature.
    return [{ kind: 'skip', reason: 'skipped (ability scores owned by the skill)' }];
  }

  // 1) forced / automatic grants, then 2) the supplied player pick (no initial — it clobbers data).
  const steps: AdvancementStep[] = [{ kind: 'apply', data: {}, initial: true }];
  const d = choiceData;
  if (d && type === 'Trait' && Array.isArray(d.chosen) && d.chosen.length) {
    steps.push({
      kind: 'apply',
      data: { chosen: d.chosen },
      initial: false,
      result: 'applied (+choice)',
    });
  } else if (d && type === 'ItemChoice' && Array.isArray(d.selected) && d.selected.length) {
    steps.push({
      kind: 'apply',
      data: { selected: d.selected },
      initial: false,
      result: 'applied (+choice)',
    });
  } else if (d && type === 'Subclass' && typeof d.uuid === 'string') {
    steps.push({
      kind: 'apply',
      data: { uuid: d.uuid },
      initial: false,
      result: 'applied (+choice)',
    });
  }
  return steps;
}

export interface PcBuildResult {
  success: boolean;
  actor?: {
    id: string;
    name: string;
    className: string;
    species: string | null;
    background: string | null;
    level: number;
    hp: number | null;
    folder: string | null;
    /** level-up only: the new level IN the leveled class + the full class breakdown (multiclass). */
    classLevel?: number;
    classes?: Array<{ name: string; levels: number }>;
  };
  applied?: Array<{ source: string; level: number; type: string; title: string; result: string }>;
  needsChoices?: AdvancementChoice[];
  unresolvedScale?: Array<{ itemId: string; itemName: string; path: string; formula: string }>;
  /** prefab path only: the source pregen's name, and the update-actor keys layered onto the copy. */
  from?: string;
  modificationsApplied?: string[];
  warnings: string[];
  /**
   * CORRUPTING advancement failures (a forced grant, supplied pick, subclass embed, or HP apply that
   * threw). Distinct from `warnings` (best-effort): a non-empty `errors` means the PC would be silently
   * incomplete, so the build does NOT persist (create) / rolls back (level-up) and returns success:false.
   */
  errors?: string[];
}

// =============================================================================
// PURE helpers (unit-tested in advancement.test.ts) — no Foundry globals.
// =============================================================================

/**
 * Coerce an advancement's levels (which can be strings like "0") to a sorted unique number[].
 * Only numbers and non-empty numeric strings count — `null`/`''`/objects are dropped, NOT coerced
 * to 0 (Number(null)===0 would spuriously make junk apply at level 0).
 */
export function normalizeLevels(levels: unknown): number[] {
  const arr = Array.isArray(levels) ? levels : levels != null ? [levels] : [];
  const nums = arr
    .map(v =>
      typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
    )
    .filter(n => Number.isFinite(n));
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** [0, 1, …, level] — the character levels a v1..vN build walks (species/background sit at 0). */
export function levelsUpTo(level: number): number[] {
  const out: number[] = [];
  for (let l = 0; l <= level; l++) out.push(l);
  return out;
}

/**
 * Summarize ONE advancement into a player-facing choice point, or null if it carries no player pick
 * (forced-only Trait, HP, ScaleValue, ItemGrant, ASI). PURE — reads a RawAdvancement-shaped object,
 * so it is unit-testable with plain mocks. `optionLabels` (uuid→name) is an optional lookup the live
 * caller fills from pack indexes; absent, options carry the raw value only.
 */
export function summarizeChoice(
  raw: Pick<RawAdvancement, 'id' | 'type' | 'title' | 'configuration'>,
  level: number,
  source: AdvancementChoice['source'],
  optionLabels?: Map<string, string>
): AdvancementChoice | null {
  const cfg = raw.configuration ?? {};
  if (raw.type === 'Trait') {
    const groups = Array.isArray(cfg.choices) ? cfg.choices : [];
    let count = 0;
    const options: Array<{ value: string; label?: string }> = [];
    const seen = new Set<string>();
    for (const g of groups) {
      count += Number(g?.count ?? 0);
      for (const key of Array.from(g?.pool ?? []) as string[]) {
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({ value: key });
      }
    }
    if (count <= 0) return null; // forced-only Trait (e.g. fixed saving throws) — no player pick
    return {
      id: raw.id,
      source,
      level,
      type: 'Trait',
      title: raw.title,
      dataKey: 'chosen',
      count,
      options,
    };
  }
  if (raw.type === 'ItemChoice') {
    const lvlChoices = cfg.choices ?? {};
    const count = Number(lvlChoices[level]?.count ?? lvlChoices[String(level)]?.count ?? 0);
    if (count <= 0) return null;
    const options = (Array.isArray(cfg.pool) ? cfg.pool : [])
      .map((p: any) => p?.uuid)
      .filter((u: unknown): u is string => typeof u === 'string')
      .map((uuid: string) => ({ value: uuid, label: optionLabels?.get(uuid) }));
    return {
      id: raw.id,
      source,
      level,
      type: 'ItemChoice',
      title: raw.title,
      dataKey: 'selected',
      count,
      options,
    };
  }
  if (raw.type === 'Subclass') {
    // v2 (L3+) — surfaced descriptively so a too-high level fails loudly rather than silently.
    return {
      id: raw.id,
      source,
      level,
      type: 'Subclass',
      title: raw.title,
      dataKey: 'uuid',
      count: 1,
      options: [],
    };
  }
  return null; // HitPoints / ScaleValue / ItemGrant / AbilityScoreImprovement carry no player pick here
}

/** True if `choices` supplies non-empty data for `spec` under its expected dataKey. PURE. */
export function isChoiceSatisfied(
  spec: AdvancementChoice,
  choices: PcChoiceMap | undefined
): boolean {
  const data = choices?.[String(spec.level)]?.[spec.id];
  if (!data) return false;
  const v = (data as Record<string, unknown>)[spec.dataKey];
  if (spec.dataKey === 'uuid') return typeof v === 'string' && v.length > 0;
  return Array.isArray(v) && v.length > 0;
}

/** The required choices a build is missing (descriptive). PURE. */
export function computeMissingChoices(
  specs: AdvancementChoice[],
  choices: PcChoiceMap | undefined
): AdvancementChoice[] {
  return specs.filter(s => !isChoiceSatisfied(s, choices));
}

// =============================================================================
// LIVE helpers — touch Foundry globals (covered by the verify script, not unit tests).
// =============================================================================

/**
 * Resolve a premium-book Item document by entry `type` ('class'|'race'|'background'|'subclass') and
 * exact name. Premium-gated via compendium-sources.isPremiumBookPack (design.md §2.3 — never an
 * inline pack regex, never the SRD). Returns the live doc + pack id, or null if absent.
 */
async function resolvePremiumDocByType(
  typeName: string,
  name: string
): Promise<{ doc: any; packId: string } | null> {
  for (const pack of game.packs) {
    if (pack.documentName !== 'Item' || !isPremiumBookPack(pack.metadata.id)) continue;
    const idx = await pack.getIndex({ fields: ['type'] });
    const hit = idx.find((e: any) => e.type === typeName && e.name === name);
    if (hit) return { doc: await pack.getDocument(hit._id), packId: pack.metadata.id };
  }
  return null;
}

/** Lift a live item's advancements into normalized RawAdvancement[] (levels coerced to numbers). */
function extractAdvancements(item: any): RawAdvancement[] {
  const byType = item?.advancement?.byType ?? {};
  const out: RawAdvancement[] = [];
  for (const [type, arr] of Object.entries(byType)) {
    for (const adv of arr as any[]) {
      out.push({
        id: adv.id,
        type,
        title: adv.title,
        levels: normalizeLevels(adv.levels ?? (adv.level != null ? [adv.level] : [])),
        classRestriction: adv.classRestriction ?? adv.level?.classRestriction ?? '',
        adv,
        configuration: adv.configuration ?? {},
      });
    }
  }
  return out;
}

/** Best-effort uuid→name labels for an ItemChoice pool, read cheaply from already-loaded pack indexes. */
function labelsForPool(configuration: any): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of (Array.isArray(configuration?.pool) ? configuration.pool : []) as any[]) {
    const uuid: string | undefined = entry?.uuid;
    if (!uuid) continue;
    // Compendium.<pack>.<DocType>.<id>
    const m = /^Compendium\.(.+)\.(?:Item|Actor|JournalEntry)\.([^.]+)$/.exec(uuid);
    if (!m) continue;
    const pack = game.packs.get(m[1]);
    const idxEntry = pack?.index?.get?.(m[2]);
    if (idxEntry?.name) labels.set(uuid, idxEntry.name);
  }
  return labels;
}

/** Premium subclass items whose classIdentifier matches — populates the L3 Subclass choice's options. */
async function findSubclassesFor(
  classIdentifier: string | undefined
): Promise<Array<{ value: string; label?: string }>> {
  if (!classIdentifier) return [];
  const out: Array<{ value: string; label?: string }> = [];
  for (const pack of game.packs) {
    if (pack.documentName !== 'Item' || !isPremiumBookPack(pack.metadata.id)) continue;
    const idx = await pack.getIndex({ fields: ['type', 'system.classIdentifier'] });
    for (const e of idx as any) {
      if (e.type === 'subclass' && e.system?.classIdentifier === classIdentifier) {
        out.push({ value: `Compendium.${pack.metadata.id}.Item.${e._id}`, label: e.name });
      }
    }
  }
  return out;
}

/**
 * Collect the player-facing choice points an item exposes at the given character levels. LIVE
 * (walks item.advancement). The pure summarizeChoice does the per-advancement shaping; this adds
 * live option labels (ItemChoice) + the available subclass list (Subclass), and the level/source
 * framing. ASYNC because the Subclass enrichment scans premium packs for matching subclasses.
 */
export async function collectAdvancementChoices(
  item: any,
  levels: number[],
  source: AdvancementChoice['source'],
  classRole?: 'primary' | 'secondary'
): Promise<AdvancementChoice[]> {
  const want = new Set(levels);
  const out: AdvancementChoice[] = [];
  for (const raw of extractAdvancements(item)) {
    // multiclass: don't surface a choice the class won't actually grant in this role
    if (!allowedForRole(raw.classRestriction, classRole)) continue;
    for (const lvl of raw.levels) {
      if (!want.has(lvl)) continue;
      const labels = raw.type === 'ItemChoice' ? labelsForPool(raw.configuration) : undefined;
      const choice = summarizeChoice(raw, lvl, source, labels);
      if (!choice) continue;
      // Subclass options aren't on the advancement config — scan the books for this class's subclasses.
      if (choice.type === 'Subclass' && source === 'class') {
        choice.options = await findSubclassesFor(item.system?.identifier);
      }
      out.push(choice);
    }
  }
  return out;
}

/**
 * Apply every advancement on one embedded item across `levels`, feeding supplied choice data.
 * The proven two-step: (1) apply({initial:true}) for forced grants, then (2) for a Trait/ItemChoice
 * with supplied picks, a SECOND apply WITHOUT initial carrying {chosen}/{selected}. Background/species
 * AbilityScoreImprovement is SKIPPED — the skill owns final scores (design.md §2.1). Records each
 * step; never throws — a CORRUPTING failure (every apply() here is one: HP, a forced grant, or a
 * supplied Trait/ItemChoice/Subclass pick) is captured in `errors` (and the per-row trail), and the
 * CALLER decides whether to persist. (Role/ASI skips are not failures.)
 */
async function applyItemAdvancements(
  item: any,
  source: 'class' | 'species' | 'background' | 'subclass',
  levels: number[],
  choices: PcChoiceMap | undefined,
  applied: PcBuildResult['applied'],
  errors: string[],
  hpMode: 'avg' | 'max' = 'avg',
  classRole?: 'primary' | 'secondary'
): Promise<void> {
  const want = new Set(levels);
  const todo = extractAdvancements(item)
    .flatMap(raw => raw.levels.filter(l => want.has(l)).map(level => ({ raw, level })))
    .sort((a, b) => a.level - b.level);

  for (const { raw, level } of todo) {
    const rec = { source, level, type: raw.type, title: raw.title, result: 'applied' };
    try {
      // The DECISION (role subset, original-L1-max HP, ASI skip, two-step forced-then-pick) is the pure
      // planAdvancementApply (unit-tested); here we only EXECUTE its steps. The only side effect — the
      // live advancement.apply — stays in this loop.
      const steps = planAdvancementApply({
        type: raw.type,
        classRestriction: raw.classRestriction,
        level,
        classRole,
        isOriginalClass: !!item.isOriginalClass,
        hpMode,
        choiceData: choices?.[String(level)]?.[raw.id] as AdvancementPlanInput['choiceData'],
      });
      for (const step of steps) {
        if (step.kind === 'skip') {
          rec.result = step.reason;
        } else if (step.initial) {
          await raw.adv.apply(level, step.data, { initial: true });
          if (step.result) rec.result = step.result;
        } else {
          await raw.adv.apply(level, step.data);
          if (step.result) rec.result = step.result;
        }
      }
    } catch (e) {
      rec.result = `error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
      errors.push(`Advancement "${raw.title}" (${source}) failed: ${rec.result}`);
    }
    applied?.push(rec);
  }
}

/**
 * Scan a built actor's items for @scale.* tokens that DON'T resolve against the actor's roll data.
 * On a PC, class/racial @scale resolves natively (the scale data exists), so this should be empty —
 * unlike an NPC copy, where the same literal token dangles to 0. (We resolve, not just match the
 * literal token, because the source formula string contains @scale even when it resolves fine.)
 */
function findGenuinelyUnresolvedScale(
  actor: any
): Array<{ itemId: string; itemName: string; path: string; formula: string }> {
  const rd = actor.getRollData();
  const out: Array<{ itemId: string; itemName: string; path: string; formula: string }> = [];
  for (const item of actor.items ?? []) {
    for (const t of findUnresolvedScaleTokens(toSource(item))) {
      const resolved = String(
        Roll.replaceFormulaData(t.formula, rd, { missing: '0', warn: false })
      );
      // still carries @scale, or collapsed to a bare 0 → genuinely unresolved on this actor
      if (/@scale\./.test(resolved) || resolved.trim() === '0') {
        out.push({ itemId: item.id, itemName: item.name, ...t });
      }
    }
  }
  return out;
}

/**
 * Embed ONE class on the build actor at `classLevel`, then apply its advancements across [0..classLevel]
 * — followed by its subclass's OWN advancements (matched by classIdentifier, so a multiclass build
 * applies each class's subclass to the right class). The PRIMARY class is flagged the originalClass
 * BEFORE its HitPoints apply (so its L1 HP is max); a SECONDARY (multiclass) class is not, so its first
 * level's HP is the average and the 2024 classRestriction proficiency subset applies. Returns the
 * embedded class item id. Shared by createPcActor's primary + multiclass paths.
 */
async function embedClassAndApply(
  tmp: any,
  classDoc: any,
  classLevel: number,
  role: 'primary' | 'secondary',
  choices: PcChoiceMap | undefined,
  applied: PcBuildResult['applied'],
  errors: string[],
  hpMode: 'avg' | 'max'
): Promise<string> {
  const classLevels = levelsUpTo(classLevel);
  const classData = classDoc.toObject();
  delete classData._id;
  classData.system = classData.system ?? {};
  classData.system.levels = classLevel;
  const [classItem] = await tmp.createEmbeddedDocuments('Item', [classData]);
  if (role === 'primary') {
    tmp.updateSource({ 'system.details.originalClass': classItem.id });
  }
  await applyItemAdvancements(
    tmp.items.get(classItem.id),
    'class',
    classLevels,
    choices,
    applied,
    errors,
    hpMode,
    role
  );

  // Subclass (level 3+): the class's Subclass advancement EMBEDS the subclass item but does NOT run its
  // own advancements; run them now so subclass features land (proven: scripts/spike-pc-level.mjs).
  // Matched by classIdentifier so a multiclass build never runs class A's subclass against class B.
  const classId = classDoc.system?.identifier;
  const subclassItem = tmp.items.find(
    (i: any) => i.type === 'subclass' && i.system?.classIdentifier === classId
  );
  if (subclassItem) {
    await applyItemAdvancements(
      tmp.items.get(subclassItem.id),
      'subclass',
      classLevels,
      choices,
      applied,
      errors,
      hpMode
    );
  }
  return classItem.id;
}

// =============================================================================
// inspectAdvancementChoices — read-only introspection (backs inspect-pc-advancement).
// =============================================================================

export async function inspectAdvancementChoices(args: {
  className?: string;
  classUuid?: string;
  level?: number;
}): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error(
      `inspectAdvancementChoices requires D&D 5e. Current system: "${game.system.id}".`
    );
  }
  const level = args.level ?? 1;

  let doc: any = null;
  let packId: string | null = null;
  if (args.classUuid) {
    doc = await fromUuid(args.classUuid);
    if (doc?.pack) packId = doc.pack;
  } else if (args.className) {
    const res = await resolvePremiumDocByType('class', args.className);
    if (res) {
      doc = res.doc;
      packId = res.packId;
    }
  }
  if (!doc) {
    throw new Error(
      `Class not found: "${args.className ?? args.classUuid}". Use a premium-book class by exact name ` +
        '(design.md §2.3 — never the SRD). Try search-compendium to find it.'
    );
  }
  if (doc.type !== 'class') {
    throw new Error(`"${doc.name}" is a "${doc.type}", not a class.`);
  }
  if (packId && !isPremiumBookPack(packId)) {
    throw new Error(
      `Refusing to introspect "${doc.name}" from non-premium pack "${packId}" (design.md §2.3). ` +
        'Author only from the premium MM/PHB/DMG books.'
    );
  }

  const choices = await collectAdvancementChoices(doc, levelsUpTo(level), 'class');
  return {
    class: { name: doc.name, identifier: doc.system?.identifier ?? null, pack: packId },
    level,
    choices,
    spellcasting: doc.system?.spellcasting?.progression ?? null,
  };
}

// =============================================================================
// restPcToFull — finish a freshly-CREATED PC fully rested (the deterministic equivalent of a long
// rest), so it reads ready-to-play the instant the build returns — full HP, every spell/pact slot, and
// no spent limited-use features — instead of relying on a later derived-data recompute (right after
// Actor.create a PC can momentarily read partial HP / 0 slots until the dnd5e system re-prepares).
// Manual top-off, NOT the system's Actor#longRest, ON PURPOSE: longRest can render a Rest dialog / post
// a chat card, either of which HANGS headless (same class of hazard as the AdvancementManager render).
// Reads the prepared max values off the reset actor, so it is edition-agnostic about slot tables.
// Best-effort: any failure is a warning, never a build break. CREATE paths only — NOT levelUpPc, where
// the PC keeps its current HP (max just grows) and an auto-heal on "ding" would be wrong.
// =============================================================================

async function restPcToFull(actor: any, warnings: string[]): Promise<void> {
  try {
    actor.reset?.();
    const sys = actor.system ?? {};
    const update: Record<string, unknown> = {};

    // HP → max.
    const hpMax = sys.attributes?.hp?.max;
    if (typeof hpMax === 'number' && hpMax > 0) {
      update['system.attributes.hp.value'] = hpMax;
      update['system.attributes.hp.temp'] = 0;
    }

    // Every spell-level + pact slot → max.
    const spells = sys.spells ?? {};
    for (const key of Object.keys(spells)) {
      const slot = (spells as any)[key];
      if (slot && typeof slot.max === 'number' && slot.max > 0 && slot.value !== slot.max) {
        update[`system.spells.${key}.value`] = slot.max;
      }
    }

    if (Object.keys(update).length > 0) await actor.update(update);

    // Recharge any limited-use feature/item that came out of the build with charges spent.
    const itemUpdates = actor.items
      .filter((i: any) => typeof i.system?.uses?.spent === 'number' && i.system.uses.spent > 0)
      .map((i: any) => ({ _id: i.id, 'system.uses.spent': 0 }));
    if (itemUpdates.length > 0) await actor.updateEmbeddedDocuments('Item', itemUpdates);

    actor.reset?.();
  } catch (e) {
    warnings.push(`Long-rest finalize failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// =============================================================================
// createPcActor — the orchestrator (the page op behind the create-pc tool; parallels createNpcActor).
// =============================================================================

export async function createPcActor(plan: PcBuildPlan): Promise<PcBuildResult> {
  const ActorClass = (globalThis as any).Actor;
  if (game.system.id !== 'dnd5e') {
    throw new Error(`createPcActor requires D&D 5e. Current system: "${game.system.id}".`);
  }

  const level = plan.level ?? 1;
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. Resolve class / species / background by NAME, premium-gated.
  const classRes = await resolvePremiumDocByType('class', plan.className);
  if (!classRes) {
    throw new Error(
      `Class "${plan.className}" not found in the premium books (design.md §2.3 — never the SRD). ` +
        'Use the exact PHB class name; try search-compendium.'
    );
  }
  const speciesRes = plan.species ? await resolvePremiumDocByType('race', plan.species) : null;
  if (plan.species && !speciesRes) {
    throw new Error(
      `Species "${plan.species}" not found in the premium books. Try search-compendium.`
    );
  }
  const backgroundRes = plan.background
    ? await resolvePremiumDocByType('background', plan.background)
    : null;
  if (plan.background && !backgroundRes) {
    throw new Error(
      `Background "${plan.background}" not found in the premium books. Try search-compendium.`
    );
  }

  // Multiclass (v4) — each additional class is a SECONDARY class (gets the 2024 proficiency subset).
  // Resolve premium-gated, reject a class appearing twice + a total level over 20, BEFORE any actor
  // exists (a bad request never litters a junk actor).
  const multiclassRes: Array<{ doc: any; levels: number; name: string }> = [];
  const seenClassIds = new Set<unknown>([classRes.doc.system?.identifier]);
  for (const mc of plan.multiclass ?? []) {
    const res = await resolvePremiumDocByType('class', mc.className);
    if (!res) {
      throw new Error(
        `Multiclass "${mc.className}" not found in the premium books (design.md §2.3 — never the SRD). ` +
          'Use the exact PHB class name; try search-compendium.'
      );
    }
    const id = res.doc.system?.identifier;
    if (seenClassIds.has(id)) {
      throw new Error(
        `Class "${mc.className}" is listed more than once — a PC cannot multiclass into the same class. ` +
          'Use level-up-pc to add further levels to a class the PC already has.'
      );
    }
    seenClassIds.add(id);
    multiclassRes.push({ doc: res.doc, levels: mc.levels, name: res.doc.name });
  }
  const totalLevel = level + multiclassRes.reduce((s, m) => s + m.levels, 0);
  if (totalLevel > 20) {
    throw new Error(
      `Total character level ${totalLevel} exceeds 20 (primary ${classRes.doc.name} ${level}` +
        `${multiclassRes.map(m => ` + ${m.name} ${m.levels}`).join('')}).`
    );
  }

  // 2. Compute required choices + what's missing — from the SOURCE docs, BEFORE any actor exists
  //    (so an incomplete request never litters a junk actor). Each class contributes its own choice
  //    points (primary vs secondary role drives the multiclass proficiency subset); the flat choices
  //    map disambiguates by advancement id, so two classes' same-level picks never collide.
  const levels = levelsUpTo(level);
  const hpMode = plan.hpMode ?? 'avg';
  const choiceSpecs: AdvancementChoice[] = [
    ...(await collectAdvancementChoices(classRes.doc, levels, 'class', 'primary')),
  ];
  for (const mc of multiclassRes) {
    choiceSpecs.push(
      ...(await collectAdvancementChoices(mc.doc, levelsUpTo(mc.levels), 'class', 'secondary'))
    );
  }
  if (speciesRes) {
    choiceSpecs.push(...(await collectAdvancementChoices(speciesRes.doc, levels, 'species')));
  }
  if (backgroundRes) {
    choiceSpecs.push(...(await collectAdvancementChoices(backgroundRes.doc, levels, 'background')));
  }
  const missing = computeMissingChoices(choiceSpecs, plan.choices);
  if (missing.length > 0 && !plan.acceptDefaults) {
    return {
      success: false,
      needsChoices: missing,
      warnings: [
        `${missing.length} required choice(s) need a pick before this PC can be built. Fill the ` +
          '`choices` map (keyed by level → advancement id) and re-call, or pass acceptDefaults:true ' +
          'to build with only the forced defaults.',
      ],
    };
  }

  // 3. Build on a TEMP actor, then snapshot → persist. disableAdvancements true for the build
  //    (prevents the auto-AdvancementManager render on class embed); restored in finally.
  const applied: PcBuildResult['applied'] = [];
  let tmp: any = null;
  let priorDisable: unknown;
  let disableTouched = false;
  try {
    try {
      priorDisable = game.settings.get('dnd5e', 'disableAdvancements');
      await game.settings.set('dnd5e', 'disableAdvancements', true);
      disableTouched = true;
    } catch (e) {
      warnings.push(
        `Could not set disableAdvancements: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    tmp = await ActorClass.create({ name: `__mcp_pc_build_${plan.name}`, type: 'character' });
    if (!tmp) throw new Error('Failed to create the temporary build actor');

    // Primary class — embed at system.levels=`level`, flag the originalClass (so its L1 HP is max),
    // apply its advancements + its subclass's. Multiclass classes follow as SECONDARY (each gets the
    // 2024 proficiency subset; first-level HP is the average).
    await embedClassAndApply(
      tmp,
      classRes.doc,
      level,
      'primary',
      plan.choices,
      applied,
      errors,
      hpMode
    );
    for (const mc of multiclassRes) {
      await embedClassAndApply(
        tmp,
        mc.doc,
        mc.levels,
        'secondary',
        plan.choices,
        applied,
        errors,
        hpMode
      );
    }

    // Species — level-0 racial features (incl. the ItemChoice that yields racial @scale).
    if (speciesRes) {
      const sData = speciesRes.doc.toObject();
      delete sData._id;
      const [sItem] = await tmp.createEmbeddedDocuments('Item', [sData]);
      await applyItemAdvancements(
        tmp.items.get(sItem.id),
        'species',
        levels,
        plan.choices,
        applied,
        errors
      );
    }

    // Background — level-0 feat + skill/tool/language traits (ASI skipped: skill owns scores).
    if (backgroundRes) {
      const bData = backgroundRes.doc.toObject();
      delete bData._id;
      const [bItem] = await tmp.createEmbeddedDocuments('Item', [bData]);
      await applyItemAdvancements(
        tmp.items.get(bItem.id),
        'background',
        levels,
        plan.choices,
        applied,
        errors
      );
    }

    // FINAL ability scores (skill owns the math). Written here so HP/derived stats re-prep with them.
    if (plan.abilities) {
      const abilityUpdate: Record<string, number> = {};
      for (const ab of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
        abilityUpdate[`system.abilities.${ab}.value`] = plan.abilities[ab];
      }
      tmp.updateSource(abilityUpdate);
    }

    // Source rules stamp.
    tmp.updateSource({ 'system.details.source.rules': plan.sourceRules ?? '2024' });

    // Caster spell picks (slots auto-derive from the class; this just imports chosen cantrips/spells).
    const spellNames = [...(plan.spells?.cantrips ?? []), ...(plan.spells?.prepared ?? [])];
    if (spellNames.length > 0) {
      try {
        const spellRes: any = await addSpellsToActor({ actorIdentifier: tmp.id, spellNames });
        if (Array.isArray(spellRes?.notFound) && spellRes.notFound.length) {
          warnings.push(`Spells not found in the premium PHB: ${spellRes.notFound.join(', ')}`);
        }
        for (const w of spellRes?.warnings ?? []) warnings.push(w);
      } catch (e) {
        warnings.push(`Spell import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // A corrupting advancement failed (a forced grant / supplied pick / subclass embed / HP apply that
    // threw). The PC would be silently incomplete, so DON'T persist a broken character — fail loudly so
    // the skill/DM fixes the input and re-calls. No litter: the temp build actor is cleaned in `finally`
    // (mirrors the needsChoices no-persist discipline above). design.md §2.1 — tools fail loudly.
    if (errors.length > 0) {
      return { success: false, errors, applied, warnings };
    }

    // 4. PERSIST — snapshot the built _source and create the real actor (one DB write, embedded items
    //    keep their _ids so originalClass stays valid). File under the PC folder (name → id resolve).
    const folderId = await resolvePcFolderId(plan.folder);
    const snapshot = tmp.toObject();
    delete snapshot._id;
    snapshot.name = plan.name;
    // The temp actor was created as `__mcp_pc_build_<name>`, so Foundry stamped that scratch name
    // onto its prototypeToken too. Re-point it to the real name or every token dragged from this PC
    // (and its combat-tracker entry) shows the build prefix. Then apply the shared token defaults: a
    // PC is friendly, shows its name + HP bar to everyone, and sees by its sheet's vision (darkvision
    // range when the species grants it, else basic).
    if (snapshot.prototypeToken) {
      snapshot.prototypeToken.name = plan.name;
      Object.assign(
        snapshot.prototypeToken,
        tokenDefaults({
          disposition: TOKEN_DISPOSITION.friendly,
          darkvision: readDarkvision(snapshot.system?.attributes?.senses),
          ring: snapshot.prototypeToken.ring,
        })
      );
    }
    if (folderId) snapshot.folder = folderId;
    const real = await ActorClass.create(snapshot);
    if (!real) throw new Error(`Failed to persist PC "${plan.name}"`);

    // Re-fetch FRESH + reset() so derived data (HP, @scale) re-prepares from persisted source.
    let fresh = game.actors.get(real.id);
    fresh.reset?.();
    // Defensive: re-anchor originalClass to the PRIMARY class (matched by identifier) if the persisted
    // class item id drifted — `.find` alone would pick an arbitrary class on a multiclass actor.
    const primaryClassId = classRes.doc.system?.identifier;
    const classOnFresh =
      fresh.items.find((i: any) => i.type === 'class' && i.system?.identifier === primaryClassId) ??
      fresh.items.find((i: any) => i.type === 'class');
    if (classOnFresh && fresh.system?.details?.originalClass !== classOnFresh.id) {
      await fresh.update({ 'system.details.originalClass': classOnFresh.id });
      fresh = game.actors.get(real.id);
      fresh.reset?.();
    }

    // Finish fully rested — full HP, all spell slots, no spent uses (see restPcToFull).
    await restPcToFull(fresh, warnings);

    const unresolvedScale = findGenuinelyUnresolvedScale(fresh);

    return {
      success: true,
      actor: {
        id: fresh.id,
        name: fresh.name,
        className: classRes.doc.name,
        species: speciesRes?.doc.name ?? null,
        background: backgroundRes?.doc.name ?? null,
        level: totalLevel,
        hp: fresh.system?.attributes?.hp?.max ?? null,
        folder: folderId ?? null,
        ...(multiclassRes.length > 0
          ? {
              classes: fresh.items
                .filter((i: any) => i.type === 'class')
                .map((i: any) => ({ name: i.name, levels: i.system?.levels ?? 0 })),
            }
          : {}),
      },
      applied,
      ...(unresolvedScale.length > 0 ? { unresolvedScale } : {}),
      warnings,
    };
  } finally {
    // Delete the temp build actor + restore the advancement setting, whatever happened.
    try {
      if (tmp?.id) {
        const t = game.actors.get(tmp.id);
        if (t) await t.delete();
      }
    } catch (e) {
      warnings.push(`Temp actor cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (disableTouched) {
      try {
        await game.settings.set('dnd5e', 'disableAdvancements', priorDisable);
      } catch {
        /* best-effort restore */
      }
    }
  }
}

// =============================================================================
// levelUpPc — add ONE class level to an existing persisted PC (the page op behind level-up-pc).
//
// Same class as a current one → a single-class level-up; a class the PC doesn't have → a MULTICLASS
// add. Mutates the actor IN PLACE (proven in scripts/spike-pc-v3.mjs): bump/embed the class, apply
// ONLY the new level's advancements (prior value-state is preserved, so L1..N don't re-apply, and the
// classRestriction filter gives a multiclass its 2024 proficiency subset), then persist via
// actor.update(toObject). Ability-score increases at ASI tiers stay the skill's job (final scores +
// update-actor); a feat is added with add-feature.
// =============================================================================

export interface LevelUpPlan {
  actorIdentifier: string;
  className: string;
  choices?: PcChoiceMap;
  hpMode?: 'avg' | 'max';
  acceptDefaults?: boolean;
}

export async function levelUpPc(plan: LevelUpPlan): Promise<PcBuildResult> {
  if (game.system.id !== 'dnd5e') {
    throw new Error(`levelUpPc requires D&D 5e. Current system: "${game.system.id}".`);
  }
  const warnings: string[] = [];
  const errors: string[] = [];
  const hpMode = plan.hpMode ?? 'avg';

  // 1. Resolve the actor — must be an existing character.
  const actor = resolveActorFuzzy(plan.actorIdentifier);
  if (!actor) throw new Error(`PC not found: "${plan.actorIdentifier}". Use the exact name or id.`);
  if (actor.type !== 'character') {
    throw new Error(
      `"${actor.name}" is a ${actor.type}, not a player character — level-up-pc only levels PCs.`
    );
  }

  // 2. Resolve the class by name (premium-gated).
  const classRes = await resolvePremiumDocByType('class', plan.className);
  if (!classRes) {
    throw new Error(
      `Class "${plan.className}" not found in the premium books (design.md §2.3). Try search-compendium.`
    );
  }
  const classIdentifier = classRes.doc.system?.identifier;

  // 3. Existing class → bump; new class → multiclass add. Role: the originalClass is primary, any
  //    other class is a multiclass secondary (drives the classRestriction proficiency subset).
  const existing = actor.items.find(
    (i: any) => i.type === 'class' && i.system?.identifier === classIdentifier
  );
  const isNewClass = !existing;
  const newClassLevel = isNewClass ? 1 : (existing.system?.levels ?? 0) + 1;
  if (newClassLevel > 20) {
    throw new Error(`${classRes.doc.name} is already at level ${newClassLevel - 1} (max 20).`);
  }
  const currentCharLevel = actor.items
    .filter((i: any) => i.type === 'class')
    .reduce((sum: number, i: any) => sum + (i.system?.levels ?? 0), 0);
  if (currentCharLevel >= 20) {
    throw new Error(`"${actor.name}" is already character level 20.`);
  }
  const originalClassId = actor.system?.details?.originalClass;
  const role: 'primary' | 'secondary' =
    !isNewClass && existing.id === originalClassId ? 'primary' : 'secondary';

  // 4. Required choices at the NEW level (from the source doc, BEFORE mutating) — a dry-run / under-
  //    specified call returns needsChoices and does NOT touch the actor.
  const specs = await collectAdvancementChoices(classRes.doc, [newClassLevel], 'class', role);
  const missing = computeMissingChoices(specs, plan.choices);
  if (missing.length > 0 && !plan.acceptDefaults) {
    return {
      success: false,
      needsChoices: missing,
      warnings: [
        `${classRes.doc.name} level ${newClassLevel} needs ${missing.length} choice(s) (e.g. a subclass ` +
          'at level 3). Fill the `choices` map (keyed by level → advancement id) and re-call, or pass ' +
          'acceptDefaults:true.',
      ],
    };
  }

  // 5. Mutate IN PLACE. disableAdvancements true during the apply; restored in finally.
  const applied: PcBuildResult['applied'] = [];
  let priorDisable: unknown;
  let disableTouched = false;
  try {
    try {
      priorDisable = game.settings.get('dnd5e', 'disableAdvancements');
      await game.settings.set('dnd5e', 'disableAdvancements', true);
      disableTouched = true;
    } catch (e) {
      warnings.push(
        `Could not set disableAdvancements: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    let classItemId: string;
    if (isNewClass) {
      const cdata = classRes.doc.toObject();
      delete cdata._id;
      cdata.system = cdata.system ?? {};
      cdata.system.levels = 1;
      const [added] = await actor.createEmbeddedDocuments('Item', [cdata]);
      classItemId = added.id;
    } else {
      await actor.updateEmbeddedDocuments('Item', [
        { _id: existing.id, 'system.levels': newClassLevel },
      ]);
      classItemId = existing.id;
    }
    actor.reset?.();

    await applyItemAdvancements(
      actor.items.get(classItemId),
      'class',
      [newClassLevel],
      plan.choices,
      applied,
      errors,
      hpMode,
      role
    );

    // Subclass features fire AT the new level only (never re-grant lower-level subclass features).
    const subclassItem = actor.items.find((i: any) => i.type === 'subclass');
    if (subclassItem) {
      await applyItemAdvancements(
        actor.items.get(subclassItem.id),
        'subclass',
        [newClassLevel],
        plan.choices,
        applied,
        errors,
        hpMode
      );
    }

    // A corrupting advancement failed. Roll back the ONE persisted mutation (the class embed/bump) and
    // skip the final persist, so the in-memory apply() updateSource changes evaporate on the next read —
    // never leave a half-leveled PC. Symmetric with createPcActor's no-persist-on-error (design.md §2.1).
    if (errors.length > 0) {
      try {
        if (isNewClass) {
          await actor.deleteEmbeddedDocuments('Item', [classItemId]);
        } else {
          await actor.updateEmbeddedDocuments('Item', [
            { _id: existing.id, 'system.levels': newClassLevel - 1 },
          ]);
        }
        game.actors.get(actor.id)?.reset?.();
      } catch (e) {
        warnings.push(
          `Level-up failed and the rollback was incomplete — inspect "${actor.name}": ` +
            `${e instanceof Error ? e.message : String(e)}`
        );
      }
      return { success: false, errors, applied, warnings };
    }

    // 6. Persist the in-memory apply() mutations (apply uses updateSource — in-memory only).
    await actor.update(actor.toObject());
    const fresh = game.actors.get(actor.id);
    fresh.reset?.();
    const unresolvedScale = findGenuinelyUnresolvedScale(fresh);

    return {
      success: true,
      actor: {
        id: fresh.id,
        name: fresh.name,
        className: classRes.doc.name,
        species: null,
        background: null,
        level: fresh.system?.details?.level ?? currentCharLevel + 1,
        hp: fresh.system?.attributes?.hp?.max ?? null,
        folder: fresh.folder?.id ?? null,
        classLevel: newClassLevel,
        classes: fresh.items
          .filter((i: any) => i.type === 'class')
          .map((i: any) => ({ name: i.name, levels: i.system?.levels ?? 0 })),
      },
      applied,
      ...(unresolvedScale.length > 0 ? { unresolvedScale } : {}),
      warnings,
    };
  } finally {
    if (disableTouched) {
      try {
        await game.settings.set('dnd5e', 'disableAdvancements', priorDisable);
      } catch {
        /* best-effort restore */
      }
    }
  }
}

// =============================================================================
// createPcFromPrefab — copy a premium pregenerated character as a base, then modify (the PC family's
// prefab-as-base path; the §6/§7 analog of createActorFromCompendium's modifications, but PC-correct:
// files under the PC folder, never the NPC one, and never bolted onto createNpcActor). The source is a
// complete type:character template (e.g. the PHB class pregens in dnd-players-handbook.actors), so
// @scale resolves natively and no advancement is run — this is COPY + tweak, not build.
// =============================================================================

export interface PcPrefabPlan {
  name: string;
  /** Friendly pregen name (e.g. "Fighter") — resolved across premium Actor packs. */
  prefab?: string;
  /** Explicit source (alternative to `prefab`): the premium pack + actor id. */
  packId?: string;
  actorId?: string;
  /** FINAL ability scores overriding the pregen's array (skill owns the math). */
  abilities?: PcAbilities;
  /** update-actor-shaped stat edits layered onto the COPY only (mirrors create-actor-from-compendium). */
  modifications?: Record<string, any>;
  folder?: string;
}

/**
 * Resolve a premium-book pregenerated CHARACTER to copy — by friendly name across premium Actor packs,
 * or by explicit packId+actorId. Premium-gated (design.md §2.3 — never the SRD) and type:character only.
 */
async function resolvePremiumCharacter(plan: PcPrefabPlan): Promise<{
  packId: string;
  actorId: string;
  name: string;
}> {
  if (plan.packId && plan.actorId) {
    if (!isPremiumBookPack(plan.packId)) {
      throw new Error(
        `Refusing to copy from non-premium pack "${plan.packId}" (design.md §2.3 — never the SRD). ` +
          'Use a premium-book pregen, e.g. dnd-players-handbook.actors.'
      );
    }
    const pack = game.packs.get(plan.packId);
    if (!pack) throw new Error(`Compendium pack not found: "${plan.packId}".`);
    const idx = await pack.getIndex({ fields: ['type'] });
    const entry = idx.get(plan.actorId);
    if (!entry) throw new Error(`Actor "${plan.actorId}" not found in pack "${plan.packId}".`);
    if (entry.type !== 'character') {
      throw new Error(
        `"${entry.name}" is a ${entry.type}, not a character — prefab PCs must be type:character ` +
          'pregens. (For an NPC prefab use create-actor-from-compendium.)'
      );
    }
    return { packId: plan.packId, actorId: plan.actorId, name: entry.name };
  }

  if (plan.prefab) {
    const wanted = plan.prefab.toLowerCase();
    const matches: Array<{ packId: string; actorId: string; name: string }> = [];
    for (const pack of game.packs) {
      if (pack.documentName !== 'Actor' || !isPremiumBookPack(pack.metadata.id)) continue;
      const idx = await pack.getIndex({ fields: ['type'] });
      for (const e of idx as any) {
        if (e.type === 'character' && e.name?.toLowerCase() === wanted) {
          matches.push({ packId: pack.metadata.id, actorId: e._id, name: e.name });
        }
      }
    }
    if (matches.length === 0) {
      throw new Error(
        `No premium character pregen named "${plan.prefab}" found. The PHB class pregens ` +
          '(Barbarian, Bard, … Wizard) live in dnd-players-handbook.actors; pass packId+actorId for ' +
          'a specific one.'
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple premium pregens named "${plan.prefab}" (${matches
          .map(m => m.packId)
          .join(', ')}) — pass packId+actorId to disambiguate.`
      );
    }
    return matches[0];
  }

  throw new Error('Provide either `prefab` (a pregen name) or both `packId` and `actorId`.');
}

export async function createPcFromPrefab(plan: PcPrefabPlan): Promise<PcBuildResult> {
  const ActorClass = (globalThis as any).Actor;
  if (game.system.id !== 'dnd5e') {
    throw new Error(`createPcFromPrefab requires D&D 5e. Current system: "${game.system.id}".`);
  }
  const warnings: string[] = [];

  // 1. Resolve + copy the premium pregen (whole-document copy primitive: toObject + strip _id).
  const src = await resolvePremiumCharacter(plan);
  const { data } = await importFromCompendium(src.packId, src.actorId);

  // 2. Rename + file under the PC folder (name → id resolve); normalize a remote token texture to local.
  const folderId = await resolvePcFolderId(plan.folder);
  data.name = plan.name;
  if (folderId) data.folder = folderId;
  if (data.prototypeToken?.texture?.src?.startsWith('http')) {
    data.prototypeToken.texture.src = null;
  }

  const real = await ActorClass.create(data);
  if (!real) throw new Error(`Failed to create PC "${plan.name}" from prefab "${src.name}"`);

  // 3. Layer ability overrides + any modifications onto THIS copy via the same updateActor correctness
  //    (resolves game.actors by id, so the compendium source is never touched). Best-effort.
  let modificationsApplied: string[] | undefined;
  const mods: Record<string, any> = { ...(plan.modifications ?? {}) };
  if (plan.abilities) mods.abilities = plan.abilities;
  if (Object.keys(mods).length > 0) {
    try {
      const res: any = await updateActor({ ...mods, actorIdentifier: real.id });
      modificationsApplied = res?.applied;
      for (const w of res?.warnings ?? []) warnings.push(w);
    } catch (e) {
      warnings.push(`Modifications failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4. Re-fetch fresh so derived data re-preps; report any unresolved @scale (empty on a real PC).
  const fresh = game.actors.get(real.id);
  fresh.reset?.();
  // Finish fully rested — full HP, all spell slots, no spent uses (see restPcToFull).
  await restPcToFull(fresh, warnings);
  const unresolvedScale = findGenuinelyUnresolvedScale(fresh);
  const classItems = fresh.items.filter((i: any) => i.type === 'class');
  const primaryClass =
    classItems.find((i: any) => i.id === fresh.system?.details?.originalClass) ?? classItems[0];

  return {
    success: true,
    from: src.name,
    actor: {
      id: fresh.id,
      name: fresh.name,
      className: primaryClass?.name ?? src.name,
      species: fresh.items.find((i: any) => i.type === 'race')?.name ?? null,
      background: fresh.items.find((i: any) => i.type === 'background')?.name ?? null,
      level: fresh.system?.details?.level ?? null,
      hp: fresh.system?.attributes?.hp?.max ?? null,
      folder: folderId ?? null,
      ...(classItems.length > 1
        ? { classes: classItems.map((i: any) => ({ name: i.name, levels: i.system?.levels ?? 0 })) }
        : {}),
    },
    ...(modificationsApplied ? { modificationsApplied } : {}),
    ...(unresolvedScale.length > 0 ? { unresolvedScale } : {}),
    warnings,
  };
}
