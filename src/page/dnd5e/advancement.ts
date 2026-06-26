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
import { findUnresolvedScaleTokens, getOrCreateFolder, toSource } from '../_shared.js';
import { addSpellsToActor } from './spells.js';

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
  /** v1: 1. The engine loops levels {0..level} so v2 widening is data, not new code. */
  level?: number;
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

/** One choice point a class/species/background advancement exposes (descriptive — never auto-picked). */
export interface AdvancementChoice {
  id: string;
  source: 'class' | 'species' | 'background';
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
  /** the live advancement object (carries .apply + .configuration). null in unit mocks. */
  adv: any;
  configuration: any;
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
  };
  applied?: Array<{ source: string; level: number; type: string; title: string; result: string }>;
  needsChoices?: AdvancementChoice[];
  unresolvedScale?: Array<{ itemId: string; itemName: string; path: string; formula: string }>;
  warnings: string[];
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

/**
 * Collect the player-facing choice points an item exposes at the given character levels. LIVE
 * (walks item.advancement). The pure summarizeChoice does the per-advancement shaping; this adds
 * live option labels and the level/source framing.
 */
export function collectAdvancementChoices(
  item: any,
  levels: number[],
  source: AdvancementChoice['source']
): AdvancementChoice[] {
  const want = new Set(levels);
  const out: AdvancementChoice[] = [];
  for (const raw of extractAdvancements(item)) {
    for (const lvl of raw.levels) {
      if (!want.has(lvl)) continue;
      const labels = raw.type === 'ItemChoice' ? labelsForPool(raw.configuration) : undefined;
      const choice = summarizeChoice(raw, lvl, source, labels);
      if (choice) out.push(choice);
    }
  }
  return out;
}

/**
 * Apply every advancement on one embedded item across `levels`, feeding supplied choice data.
 * The proven two-step: (1) apply({initial:true}) for forced grants, then (2) for a Trait/ItemChoice
 * with supplied picks, a SECOND apply WITHOUT initial carrying {chosen}/{selected}. Background/species
 * AbilityScoreImprovement is SKIPPED — the skill owns final scores (design.md §2.1). Records each
 * step; never throws (a single advancement failure is captured as a warning, build continues).
 */
async function applyItemAdvancements(
  item: any,
  source: 'class' | 'species' | 'background',
  levels: number[],
  choices: PcChoiceMap | undefined,
  applied: PcBuildResult['applied'],
  warnings: string[]
): Promise<void> {
  const want = new Set(levels);
  const todo = extractAdvancements(item)
    .flatMap(raw => raw.levels.filter(l => want.has(l)).map(level => ({ raw, level })))
    .sort((a, b) => a.level - b.level);

  for (const { raw, level } of todo) {
    const rec = { source, level, type: raw.type, title: raw.title, result: 'applied' };
    try {
      if (raw.type === 'AbilityScoreImprovement' && source !== 'class') {
        rec.result = 'skipped (skill owns final ability scores)';
        applied?.push(rec);
        continue;
      }
      // 1) forced / automatic grants (HP max, mandatory features, forced profs)
      await raw.adv.apply(level, {}, { initial: true });
      // 2) supplied player picks — NO initial (initial clobbers data.chosen for Trait)
      const data = choices?.[String(level)]?.[raw.id];
      if (
        data &&
        raw.type === 'Trait' &&
        Array.isArray((data as any).chosen) &&
        (data as any).chosen.length
      ) {
        await raw.adv.apply(level, { chosen: (data as any).chosen });
        rec.result = 'applied (+choice)';
      } else if (
        data &&
        raw.type === 'ItemChoice' &&
        Array.isArray((data as any).selected) &&
        (data as any).selected.length
      ) {
        await raw.adv.apply(level, { selected: (data as any).selected });
        rec.result = 'applied (+choice)';
      } else if (data && raw.type === 'Subclass' && typeof (data as any).uuid === 'string') {
        await raw.adv.apply(level, { uuid: (data as any).uuid });
        rec.result = 'applied (+choice)';
      }
    } catch (e) {
      rec.result = `error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
      warnings.push(`Advancement "${raw.title}" (${source}) failed: ${rec.result}`);
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

  const choices = collectAdvancementChoices(doc, levelsUpTo(level), 'class');
  return {
    class: { name: doc.name, identifier: doc.system?.identifier ?? null, pack: packId },
    level,
    choices,
    spellcasting: doc.system?.spellcasting?.progression ?? null,
  };
}

// =============================================================================
// buildPcActor — the orchestrator (backs create-pc).
// =============================================================================

export async function buildPcActor(plan: PcBuildPlan): Promise<PcBuildResult> {
  const ActorClass = (globalThis as any).Actor;
  if (game.system.id !== 'dnd5e') {
    throw new Error(`buildPcActor requires D&D 5e. Current system: "${game.system.id}".`);
  }

  const level = plan.level ?? 1;
  const warnings: string[] = [];

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

  // 2. Compute required choices + what's missing — from the SOURCE docs, BEFORE any actor exists
  //    (so an incomplete request never litters a junk actor).
  const levels = levelsUpTo(level);
  const choiceSpecs: AdvancementChoice[] = [
    ...collectAdvancementChoices(classRes.doc, levels, 'class'),
    ...(speciesRes ? collectAdvancementChoices(speciesRes.doc, levels, 'species') : []),
    ...(backgroundRes ? collectAdvancementChoices(backgroundRes.doc, levels, 'background') : []),
  ];
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

    // Class — embed at system.levels=N, flag original BEFORE applying HitPoints, then apply.
    const classData = classRes.doc.toObject();
    delete classData._id;
    classData.system = classData.system ?? {};
    classData.system.levels = level;
    const [classItem] = await tmp.createEmbeddedDocuments('Item', [classData]);
    tmp.updateSource({ 'system.details.originalClass': classItem.id });
    await applyItemAdvancements(
      tmp.items.get(classItem.id),
      'class',
      levels,
      plan.choices,
      applied,
      warnings
    );

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
        warnings
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
        warnings
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

    // 4. PERSIST — snapshot the built _source and create the real actor (one DB write, embedded items
    //    keep their _ids so originalClass stays valid). File under the PC folder.
    const folderId = plan.folder ?? (await getOrCreateFolder('Foundry MCP Characters', 'Actor'));
    const snapshot = tmp.toObject();
    delete snapshot._id;
    snapshot.name = plan.name;
    if (folderId) snapshot.folder = folderId;
    const real = await ActorClass.create(snapshot);
    if (!real) throw new Error(`Failed to persist PC "${plan.name}"`);

    // Re-fetch FRESH + reset() so derived data (HP, @scale) re-prepares from persisted source.
    let fresh = game.actors.get(real.id);
    fresh.reset?.();
    // Defensive: re-anchor originalClass if the persisted class item id drifted.
    const classOnFresh = fresh.items.find((i: any) => i.type === 'class');
    if (classOnFresh && fresh.system?.details?.originalClass !== classOnFresh.id) {
      await fresh.update({ 'system.details.originalClass': classOnFresh.id });
      fresh = game.actors.get(real.id);
      fresh.reset?.();
    }

    const unresolvedScale = findGenuinelyUnresolvedScale(fresh);

    return {
      success: true,
      actor: {
        id: fresh.id,
        name: fresh.name,
        className: classRes.doc.name,
        species: speciesRes?.doc.name ?? null,
        background: backgroundRes?.doc.name ?? null,
        level,
        hp: fresh.system?.attributes?.hp?.max ?? null,
        folder: folderId ?? null,
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
