// Pure parser: D&D Beyond character JSON  ->  a typed, name-bearing, judgment-free plan.
//
// This is the "tool does" half of the DDB import (design.md §7). It is a TRANSCRIBER: it reads the
// D&D Beyond v5 character payload and emits a normalized DdbCharacterPlan with RAW DDB names plus
// flags. It performs ZERO compendium lookup, makes ZERO mapping decisions, and NEVER generates
// content (§2.3). All fuzzy/policy work — canonicalizing DDB names to premium-2024 compendium
// entries, the STOP-and-ASK gate, keying create-pc's advancement choices — belongs to the ddb-import
// SKILL. Because the parse is deterministic and side-effect-free, it is unit-tested against a golden
// fixture and synthetic inputs (parse.test.ts), not improvised in skill prose.
//
// The hard part is ability scores. DDB does NOT store final scores — they are base `stats[]` plus a
// scatter of `bonus`/`set` modifiers across six source buckets. Two non-obvious facts drive the math
// (both verified against a real v5 payload):
//   1. `availableToMulticlass` modifiers are listed ONCE PER CLASS, so a 2-class character shows each
//      class ability bonus twice (distinct modifier `id`s, same componentId/subType/value). We dedupe
//      by `bucket|componentId|subType|value` so the per-class duplication does not double-count.
//   2. A `choose-an-ability-score` modifier resolves to a concrete ability via its matching choice
//      (`choice.id === "<choiceType>-<modifier.id>"`, optionValue 3520..3525 = STR..CHA). When no
//      resolving choice exists (homebrew/odd data) we record a note rather than guess.

// ---------------------------------------------------------------------------
// Constants — fixed enum maps only (statId->ability, skill->key, optionValue->ability). These are not
// compendium lookups; they are part of the DDB data format, so the parser may own them.
// ---------------------------------------------------------------------------

export const ABILITY_SHORTS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export const ABILITY_LONGS = [
  'strength',
  'dexterity',
  'constitution',
  'intelligence',
  'wisdom',
  'charisma',
] as const;

/** DDB stat id (1-6) -> ability index (0-5). */
const STAT_ID_TO_INDEX: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 };

/** DDB ability-choice optionValue (3520..3525) -> ability index (0-5). STR,DEX,CON,INT,WIS,CHA. */
const OPTION_VALUE_TO_ABILITY_INDEX: Record<number, number> = {
  3520: 0,
  3521: 1,
  3522: 2,
  3523: 3,
  3524: 4,
  3525: 5,
};

/** DDB skill subType (kebab) -> dnd5e 3-letter skill key. */
const SKILL_SUBTYPE_TO_KEY: Record<string, string> = {
  acrobatics: 'acr',
  'animal-handling': 'ani',
  arcana: 'arc',
  athletics: 'ath',
  deception: 'dec',
  history: 'his',
  insight: 'ins',
  intimidation: 'itm',
  investigation: 'inv',
  medicine: 'med',
  nature: 'nat',
  perception: 'prc',
  performance: 'prf',
  persuasion: 'per',
  religion: 'rel',
  'sleight-of-hand': 'slt',
  stealth: 'ste',
  survival: 'sur',
};

const ARMOR_SUBTYPES = new Set(['light-armor', 'medium-armor', 'heavy-armor', 'shields']);
const WEAPON_CATEGORY_SUBTYPES = new Set(['simple-weapons', 'martial-weapons']);

/** Known 5e fighting styles, to split them out of the resolved-options list for the skill. */
const FIGHTING_STYLES = new Set([
  'archery',
  'defense',
  'dueling',
  'great weapon fighting',
  'protection',
  'two-weapon fighting',
  'blind fighting',
  'interception',
  'superior technique',
  'thrown weapon fighting',
  'unarmed fighting',
  'druidic warrior',
]);

// ---------------------------------------------------------------------------
// Output types — the published seam contract between the parse tool and the ddb-import skill.
// ---------------------------------------------------------------------------

export interface DdbAbilityScores {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export interface DdbClassEntry {
  /** Raw DDB class name (e.g. "Fighter"). */
  name: string;
  level: number;
  /** The originalClass (its first level maxes HP) — DDB's isStartingClass. */
  isStarting: boolean;
  /** Raw DDB subclass name, or null if not chosen yet (pre-L3). */
  subclass: string | null;
  hitDie: number;
  canCastSpells: boolean;
  isLegacy: boolean;
  isHomebrew: boolean;
}

export interface DdbSpecies {
  fullName: string;
  baseRaceName: string;
  subrace: string | null;
  isSubRace: boolean;
  isLegacy: boolean;
  isHomebrew: boolean;
  size: string | null;
}

export interface DdbInventoryItem {
  /** Raw DDB name — e.g. "Longbow, +1" (the skill normalizes to the compendium name). */
  name: string;
  type: string;
  quantity: number;
  equipped: boolean;
  attuned: boolean;
  isHomebrew: boolean;
  isMagic: boolean;
  rarity: string | null;
  /** Nested inside a non-character container (e.g. a Bag of Holding), not the character. */
  inContainer: boolean;
}

export interface DdbFeat {
  name: string;
  isHomebrew: boolean;
}

export interface DdbSpell {
  name: string;
  level: number;
  prepared: boolean;
  alwaysPrepared: boolean;
  /** countsAsKnownSpell — a known-caster spell (sorcerer/ranger) vs a prepared one (cleric/wizard). */
  known: boolean;
  source: 'class' | 'race' | 'feat' | 'item' | 'background';
  className: string | null;
}

export type DdbUnresolvedKind =
  | 'species'
  | 'class'
  | 'subclass'
  | 'background'
  | 'feat'
  | 'item'
  | 'spell'
  | 'optional-feature';

export type DdbUnresolvedReason = 'homebrew' | 'legacy-2014' | 'custom';

export interface DdbUnresolved {
  kind: DdbUnresolvedKind;
  name: string;
  reason: DdbUnresolvedReason;
  detail?: string;
}

export interface DdbProficiencies {
  /** dnd5e skill keys (acr, ath, …). */
  skills: string[];
  expertise: string[];
  /** ability shorts with save proficiency (str, dex, …). */
  saves: string[];
  /** readable language names (Common, Elvish, …). */
  languages: string[];
  /** raw DDB tool/instrument subtypes (flute, thieves-tools, …). */
  tools: string[];
  /** armor categories (light-armor, shields, …). */
  armor: string[];
  /** weapon categories + specific weapons (simple-weapons, longsword, …). */
  weapons: string[];
}

export interface DdbCharacterPlan {
  name: string;
  /** Overall edition lean: '2024', '2014', or 'mixed' (some legacy, some not). */
  edition: '2024' | '2014' | 'mixed';
  abilities: DdbAbilityScores;
  /** Non-blocking ability-math notes (e.g. an unresolved choose-an-ability-score). */
  abilityNotes: string[];
  /** Classes, primary (isStarting) first. */
  classes: DdbClassEntry[];
  totalLevel: number;
  species: DdbSpecies;
  background: { name: string | null; isCustom: boolean };
  proficiencies: DdbProficiencies;
  options: {
    /** Chosen fighting style names. */
    fightingStyle: string[];
    /** Other resolved named picks (arcane shots, favored enemy/terrain, invocations…). */
    other: string[];
  };
  spells: {
    /** Cantrip names (level 0) from every source. */
    cantrips: string[];
    /** Leveled spell names that are prepared / always-prepared / known. */
    prepared: string[];
    /** Full per-spell detail for the skill (source, class, prepared vs known). */
    all: DdbSpell[];
  };
  inventory: DdbInventoryItem[];
  feats: DdbFeat[];
  currency: { cp: number; sp: number; gp: number; ep: number; pp: number };
  hp: { max: number; mode: 'fixed' | 'rolled' };
  art: { avatarUrl: string | null };
  flags: { useHomebrew: boolean; privacyType: number };
  /** Everything the skill must STOP-and-ASK about (§2.4): homebrew, 2014-legacy, custom. */
  unresolved: DdbUnresolved[];
  /** Soft parser notes (lossy points, oddities) — surfaced, never fatal. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Modifier helpers
// ---------------------------------------------------------------------------

interface FlatModifier {
  bucket: string;
  id: unknown;
  type: string;
  subType: string | null;
  value: number | null;
  statId: number | null;
  componentId: unknown;
  restriction: string | null;
  [k: string]: unknown;
}

const MODIFIER_BUCKETS = ['race', 'class', 'background', 'item', 'feat', 'condition'] as const;

function flattenModifiers(data: any): FlatModifier[] {
  const out: FlatModifier[] = [];
  const mods = data?.modifiers ?? {};
  for (const bucket of MODIFIER_BUCKETS) {
    for (const m of mods[bucket] ?? []) {
      out.push({ bucket, ...m });
    }
  }
  return out;
}

/** Build optionValue -> human label across ALL choiceDefinitions (option ids are large + unique). */
function buildOptionLabelMap(data: any): Map<number, string> {
  const map = new Map<number, string>();
  for (const def of data?.choices?.choiceDefinitions ?? []) {
    for (const opt of def?.options ?? []) {
      if (typeof opt?.id === 'number' && typeof opt?.label === 'string' && !map.has(opt.id)) {
        map.set(opt.id, opt.label);
      }
    }
  }
  return map;
}

/** Index every choice (across buckets) by its `id` (e.g. "2-1707") for modifier->choice resolution. */
function buildChoiceById(data: any): Map<string, any> {
  const map = new Map<string, any>();
  for (const bucket of ['race', 'class', 'background', 'feat', 'item'] as const) {
    const arr = data?.choices?.[bucket];
    if (Array.isArray(arr)) {
      for (const c of arr) {
        if (c?.id != null) map.set(String(c.id), c);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Ability scores
// ---------------------------------------------------------------------------

function computeAbilities(
  data: any,
  mods: FlatModifier[],
  choiceById: Map<string, any>
): { scores: DdbAbilityScores; notes: string[] } {
  const notes: string[] = [];
  const stat = (arr: any, idx: number): number | null => {
    const e = (arr ?? []).find((x: any) => STAT_ID_TO_INDEX[x?.id] === idx);
    return e?.value ?? null;
  };

  // Base score per ability: override wins outright; otherwise base + manual misc bonus.
  const overrides = ABILITY_SHORTS.map((_, i) => stat(data?.overrideStats, i));
  const bases = ABILITY_SHORTS.map((_, i) => stat(data?.stats, i) ?? 10);
  const bonuses = ABILITY_SHORTS.map((_, i) => stat(data?.bonusStats, i) ?? 0);

  const sums = [0, 0, 0, 0, 0, 0];
  const setFloor: (number | null)[] = [null, null, null, null, null, null];
  const seen = new Set<string>();

  for (const m of mods) {
    if (m.type !== 'bonus' && m.type !== 'set') continue;
    const sub = m.subType ?? '';

    // Concrete "<ability>-score".
    if (sub.endsWith('-score')) {
      const prefix = sub.slice(0, -'-score'.length);
      const li = (ABILITY_LONGS as readonly string[]).indexOf(prefix);
      if (li >= 0) {
        if (m.restriction) continue; // conditional/situational — not a flat score bump
        if (m.type === 'set') {
          setFloor[li] = Math.max(setFloor[li] ?? 0, m.value ?? 0);
        } else {
          // Dedupe the per-class (availableToMulticlass) duplication.
          const key = `${m.bucket}|${m.componentId}|${sub}|${m.value}`;
          if (!seen.has(key)) {
            seen.add(key);
            sums[li] += m.value ?? 0;
          }
        }
        continue;
      }
    }

    // Generic "choose-an-ability-score" — resolve to a concrete ability via its matching choice.
    if (m.type === 'bonus' && sub === 'choose-an-ability-score') {
      const choice = findAbilityChoice(choiceById, m.id);
      if (choice && OPTION_VALUE_TO_ABILITY_INDEX[choice.optionValue] != null) {
        const li = OPTION_VALUE_TO_ABILITY_INDEX[choice.optionValue];
        const key = `${m.bucket}|${m.componentId}|choose|${m.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          sums[li] += m.value ?? 0;
        }
      } else {
        notes.push(
          `An ability-score increase (componentId ${String(m.componentId)}) could not be resolved ` +
            'to a specific ability from the DDB data — verify the final scores.'
        );
      }
    }
  }

  const scores = {} as DdbAbilityScores;
  ABILITY_SHORTS.forEach((short, i) => {
    let v: number;
    if (overrides[i] != null) {
      v = overrides[i] as number;
    } else {
      v = (bases[i] as number) + (bonuses[i] as number) + sums[i];
      if (setFloor[i] != null) v = Math.max(v, setFloor[i] as number);
    }
    scores[short] = v;
  });
  return { scores, notes };
}

/** A choose-an-ability-score modifier `id` (e.g. 1707) -> its choice (`id` "<type>-1707"). */
function findAbilityChoice(choiceById: Map<string, any>, modId: unknown): any {
  // DDB choice ids are "<choiceType>-<modifierId>"; the type is usually 2 for ability choices.
  for (const type of [2, 1, 3]) {
    const c = choiceById.get(`${type}-${modId}`);
    if (c) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proficiencies
// ---------------------------------------------------------------------------

function resolveGenericChoice(
  choiceById: Map<string, any>,
  optionLabels: Map<number, string>,
  modId: unknown
): string | null {
  const c = findGenericChoice(choiceById, modId);
  if (!c || typeof c.optionValue !== 'number') return null;
  return optionLabels.get(c.optionValue) ?? null;
}

function findGenericChoice(choiceById: Map<string, any>, modId: unknown): any {
  for (const type of [2, 1, 3, 4]) {
    const c = choiceById.get(`${type}-${modId}`);
    if (c) return c;
  }
  return null;
}

function computeProficiencies(
  mods: FlatModifier[],
  choiceById: Map<string, any>,
  optionLabels: Map<number, string>
): DdbProficiencies {
  const skills = new Set<string>();
  const expertise = new Set<string>();
  const saves = new Set<string>();
  const languages = new Set<string>();
  const tools = new Set<string>();
  const armor = new Set<string>();
  const weapons = new Set<string>();

  const labelize = (slug: string): string =>
    slug
      .split('-')
      .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ');

  for (const m of mods) {
    const sub = m.subType ?? '';
    if (m.type === 'proficiency' || m.type === 'expertise' || m.type === 'half-proficiency') {
      // Saving throws.
      if (sub.endsWith('-saving-throws')) {
        const prefix = sub.slice(0, -'-saving-throws'.length);
        const li = (ABILITY_LONGS as readonly string[]).indexOf(prefix);
        if (li >= 0) saves.add(ABILITY_SHORTS[li]);
        continue;
      }
      // Concrete skill.
      if (SKILL_SUBTYPE_TO_KEY[sub]) {
        if (m.type === 'expertise') expertise.add(SKILL_SUBTYPE_TO_KEY[sub]);
        else skills.add(SKILL_SUBTYPE_TO_KEY[sub]);
        continue;
      }
      // Armor / weapon categories.
      if (ARMOR_SUBTYPES.has(sub)) {
        armor.add(sub);
        continue;
      }
      if (WEAPON_CATEGORY_SUBTYPES.has(sub)) {
        weapons.add(sub);
        continue;
      }
      // Generic "choose-a-…" — resolve via the matching choice.
      if (sub.startsWith('choose-')) {
        const label = resolveGenericChoice(choiceById, optionLabels, m.id);
        if (label) {
          const key = SKILL_SUBTYPE_TO_KEY[label.toLowerCase().replace(/ /g, '-')];
          if (/skill/.test(sub) && key) {
            if (m.type === 'expertise') expertise.add(key);
            else skills.add(key);
          } else if (/language/.test(sub)) {
            languages.add(label);
          } else if (/tool|instrument/.test(sub)) {
            tools.add(label);
          } else {
            // best-effort: a chosen skill label that maps to a key, else stash as a tool/other
            if (key) skills.add(key);
            else tools.add(label);
          }
        }
        continue;
      }
      // Anything else proficiency-typed: a tool, instrument, or specific weapon — keep raw-ish.
      if (sub) tools.add(labelize(sub));
    } else if (m.type === 'language') {
      if (sub.startsWith('choose-')) {
        const label = resolveGenericChoice(choiceById, optionLabels, m.id);
        if (label) languages.add(label);
      } else if (sub) {
        languages.add(labelize(sub));
      }
    }
  }

  return {
    skills: [...skills].sort(),
    expertise: [...expertise].sort(),
    saves: [...saves].sort(),
    languages: [...languages].sort(),
    tools: [...tools].sort(),
    armor: [...armor].sort(),
    weapons: [...weapons].sort(),
  };
}

// ---------------------------------------------------------------------------
// Spells
// ---------------------------------------------------------------------------

function computeSpells(data: any): DdbCharacterPlan['spells'] {
  const all: DdbSpell[] = [];
  const classById = new Map<number, string>();
  for (const c of data?.classes ?? []) {
    if (c?.id != null) classById.set(c.id, c?.definition?.name ?? null);
  }

  for (const cs of data?.classSpells ?? []) {
    const className = classById.get(cs?.characterClassId) ?? null;
    for (const s of cs?.spells ?? []) {
      all.push(spellEntry(s, 'class', className));
    }
  }
  // data.spells.* are GRANTED/innate spells (subclass bonus spells, feat/item/race spells) — a store
  // distinct from data.classSpells (the leveled class list). data.spells.class holds class-feature
  // grants (e.g. a subclass's always-prepared spells), so it must be read too.
  for (const src of ['class', 'race', 'feat', 'item', 'background'] as const) {
    const bucket = data?.spells?.[src];
    if (Array.isArray(bucket)) {
      for (const s of bucket) all.push(spellEntry(s, src, null));
    }
  }

  const cantrips = new Set<string>();
  const prepared = new Set<string>();
  for (const s of all) {
    if (s.level === 0) cantrips.add(s.name);
    else if (s.prepared || s.alwaysPrepared || s.known) prepared.add(s.name);
  }

  return { cantrips: [...cantrips].sort(), prepared: [...prepared].sort(), all };
}

function spellEntry(s: any, source: DdbSpell['source'], className: string | null): DdbSpell {
  return {
    name: s?.definition?.name ?? '(unknown spell)',
    level: s?.definition?.level ?? 0,
    prepared: !!s?.prepared,
    alwaysPrepared: !!s?.alwaysPrepared,
    known: !!s?.countsAsKnownSpell,
    source,
    className,
  };
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

/** Accept either the v5 envelope ({success, data}) or a bare `data` object. */
export function unwrapDdb(input: any): any {
  if (
    input &&
    typeof input === 'object' &&
    'data' in input &&
    input.data &&
    'stats' in input.data
  ) {
    return input.data;
  }
  return input;
}

export function parseDdbCharacter(input: any): DdbCharacterPlan {
  const data = unwrapDdb(input);
  if (!data || typeof data !== 'object' || !Array.isArray(data.stats)) {
    throw new Error(
      'Not a D&D Beyond character payload: missing `data.stats`. Pass the v5 response ' +
        '({success, data, …}) or the inner `data` object.'
    );
  }

  const mods = flattenModifiers(data);
  const choiceById = buildChoiceById(data);
  const optionLabels = buildOptionLabelMap(data);
  const warnings: string[] = [];
  const unresolved: DdbUnresolved[] = [];

  const { scores, notes: abilityNotes } = computeAbilities(data, mods, choiceById);

  // Classes — primary (isStarting) first.
  const classes: DdbClassEntry[] = (data.classes ?? []).map((c: any) => ({
    name: c?.definition?.name ?? '(unknown class)',
    level: c?.level ?? 0,
    isStarting: !!c?.isStartingClass,
    subclass: c?.subclassDefinition?.name ?? null,
    hitDie: c?.definition?.hitDice ?? c?.definition?.hitDie ?? 0,
    canCastSpells: !!c?.definition?.canCastSpells,
    isLegacy: !!c?.definition?.isLegacy,
    isHomebrew: !!c?.definition?.isHomebrew,
  }));
  classes.sort((a, b) => Number(b.isStarting) - Number(a.isStarting));
  const totalLevel = classes.reduce((acc, c) => acc + c.level, 0);

  const race = data.race ?? {};
  const species: DdbSpecies = {
    fullName: race.fullName ?? race.baseRaceName ?? '(unknown species)',
    baseRaceName: race.baseRaceName ?? race.fullName ?? '(unknown species)',
    subrace: race.subRaceShortName ?? null,
    isSubRace: !!race.isSubRace,
    isLegacy: !!race.isLegacy,
    isHomebrew: !!race.isHomebrew,
    size: race.size ?? null,
  };

  const background = {
    name: data.background?.definition?.name ?? null,
    isCustom: !!data.background?.hasCustomBackground,
  };

  const proficiencies = computeProficiencies(mods, choiceById, optionLabels);

  // Resolved option picks (fighting style, arcane shots, favored enemy, invocations…). Skip the
  // ability-score-choice noise DDB surfaces here (bare ability names / "Increase two scores …") —
  // those are ASI/background increases already folded into the FINAL abilities, not build picks.
  const fightingStyle: string[] = [];
  const otherOptions: string[] = [];
  for (const bucket of ['race', 'class', 'background', 'feat'] as const) {
    for (const o of data.options?.[bucket] ?? []) {
      const name = o?.definition?.name;
      if (typeof name !== 'string') continue;
      const lower = name.toLowerCase();
      if ((ABILITY_LONGS as readonly string[]).includes(lower)) continue;
      if (/increase .*scores?|ability score (increase|improvement)/i.test(name)) continue;
      if (FIGHTING_STYLES.has(lower)) fightingStyle.push(name);
      else otherOptions.push(name);
    }
  }

  const spells = computeSpells(data);

  const inventory: DdbInventoryItem[] = (data.inventory ?? []).map((i: any) => {
    const def = i?.definition ?? {};
    return {
      name: def.name ?? '(unknown item)',
      type: def.filterType ?? def.type ?? 'Item',
      quantity: i?.quantity ?? 1,
      equipped: !!i?.equipped,
      attuned: !!i?.isAttuned,
      isHomebrew: !!def.isHomebrew,
      isMagic: !!def.magic,
      rarity: def.rarity ?? null,
      inContainer: i?.containerEntityId != null && i.containerEntityId !== data.id,
    };
  });

  const feats: DdbFeat[] = (data.feats ?? []).map((f: any) => ({
    name: f?.definition?.name ?? '(unknown feat)',
    isHomebrew: !!f?.definition?.isHomebrew,
  }));

  const cur = data.currencies ?? {};
  const currency = {
    cp: cur.cp ?? 0,
    sp: cur.sp ?? 0,
    gp: cur.gp ?? 0,
    ep: cur.ep ?? 0,
    pp: cur.pp ?? 0,
  };

  // DDB's baseHitPoints EXCLUDES the Constitution modifier (added per character level at display
  // time), so the max is base + bonus + conMod*totalLevel — unless an explicit override is set.
  const conMod = Math.floor((scores.con - 10) / 2);
  const hpMax =
    data.overrideHitPoints != null
      ? data.overrideHitPoints
      : (data.baseHitPoints ?? 0) + (data.bonusHitPoints ?? 0) + conMod * totalLevel;
  const hp = {
    max: hpMax,
    mode: data.preferences?.hitPointType === 2 ? 'rolled' : 'fixed',
  } as const;

  // ----- Unresolved / STOP-and-ASK collection (flag, never decide) -----
  if (species.isHomebrew)
    unresolved.push({ kind: 'species', name: species.fullName, reason: 'homebrew' });
  else if (species.isLegacy)
    unresolved.push({
      kind: 'species',
      name: species.fullName,
      reason: 'legacy-2014',
      detail: 'DDB marks this species as legacy (2014).',
    });

  for (const c of classes) {
    if (c.isHomebrew) unresolved.push({ kind: 'class', name: c.name, reason: 'homebrew' });
    else if (c.isLegacy) unresolved.push({ kind: 'class', name: c.name, reason: 'legacy-2014' });
    if (c.subclass && (c.isLegacy || c.isHomebrew)) {
      unresolved.push({
        kind: 'subclass',
        name: c.subclass,
        reason: c.isHomebrew ? 'homebrew' : 'legacy-2014',
        detail: `Subclass of ${c.name}.`,
      });
    }
  }

  if (background.isCustom && background.name)
    unresolved.push({ kind: 'background', name: background.name, reason: 'custom' });

  for (const f of feats) {
    if (f.isHomebrew) unresolved.push({ kind: 'feat', name: f.name, reason: 'homebrew' });
  }
  for (const it of inventory) {
    if (it.isHomebrew) unresolved.push({ kind: 'item', name: it.name, reason: 'homebrew' });
  }
  for (const ci of data.customItems ?? []) {
    unresolved.push({ kind: 'item', name: ci?.name ?? '(custom item)', reason: 'custom' });
  }
  // NOTE: definitionKeyNameMap is NOT a homebrew signal — it is just DDB's definitionKey→name lookup
  // and includes ordinary 2024 content (e.g. "Magic Initiate (Cleric)", a background's ASI). Homebrew
  // is detected ONLY via explicit isHomebrew flags above; anything else that isn't in our premium
  // books is caught by the skill's name-canonicalization + STOP-and-ASK, not guessed from a label.

  if (data.preferences?.useHomebrewContent) {
    warnings.push(
      'Character has "use homebrew content" enabled — scan every entry for homebrew, not just the ' +
        'flagged ones.'
    );
  }
  if (spells.all.some(s => s.known) && spells.all.some(s => s.prepared)) {
    warnings.push(
      'Mixes known and prepared spellcasting — create-pc imports all as prepared; verify the split.'
    );
  }

  const anyLegacy = species.isLegacy || classes.some(c => c.isLegacy);
  const allLegacy = species.isLegacy && classes.length > 0 && classes.every(c => c.isLegacy);
  const edition = allLegacy ? '2014' : anyLegacy ? 'mixed' : '2024';

  return {
    name: data.name ?? '(unnamed)',
    edition,
    abilities: scores,
    abilityNotes,
    classes,
    totalLevel,
    species,
    background,
    proficiencies,
    options: { fightingStyle: [...new Set(fightingStyle)], other: [...new Set(otherOptions)] },
    spells,
    inventory,
    feats,
    currency,
    hp,
    art: { avatarUrl: data.decorations?.avatarUrl ?? data.avatarUrl ?? null },
    flags: {
      useHomebrew: !!data.preferences?.useHomebrewContent,
      privacyType: data.preferences?.privacyType ?? 0,
    },
    unresolved,
    warnings,
  };
}
