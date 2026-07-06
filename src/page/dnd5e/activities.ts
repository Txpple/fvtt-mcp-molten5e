// Page-side: the SINGLE dnd5e 5.3.3 Activity builder. Runs inside the headless Foundry page, but is
// pure (no Foundry globals) so it unit-tests offline.
//
// dnd5e "activities" are the rollable things on an item (attack / damage / save / heal / check /
// utility / ...), stored as system.activities keyed by id. buildActivity(type, opts) produces ONE
// such activity object. The attack/save shapes are reproduced byte-for-byte from the live-verified
// inline objects in attacks.ts, so addAttackToActor / addAttackWithSaveToActor route through this one
// builder with no behavioral change (activities.test.ts pins the equivalence). The heal/check/utility/
// damage shapes are lean — dnd5e's DataModel fills every other field on create (live-spiked).

export interface RawDamagePart {
  number: number;
  denomination: number;
  type: string;
}

/** Map a raw damage part to the dnd5e activity-part object shape. */
export function damagePartToActivity(p: RawDamagePart): Record<string, unknown> {
  return {
    types: [p.type],
    number: p.number,
    denomination: p.denomination,
    bonus: '',
    scaling: { mode: '', number: 1 },
    custom: { enabled: false },
  };
}

export interface BuildActivityOpts {
  /** Activity id (caller generates via foundry.utils.randomID(16)). */
  id: string;
  name?: string;
  activationType?: string;
  sort?: number;
  // attack
  attackType?: 'melee' | 'ranged';
  attackBonus?: number;
  /** Attack ability override (the dnd5e 2024 attack.ability field). Omit to leave it ''. */
  ability?: string;
  /** Attack classification ('' for 2024, 'weapon' for 2014). */
  classification?: string;
  includeBase?: boolean;
  /** RAW activity damage parts (caller handles the weapon base part separately). */
  damageParts?: RawDamagePart[];
  // save
  saveAbility?: string;
  saveDC?: number;
  onSave?: 'half' | 'none';
  // heal
  healing?: { number: number; denomination: number; type?: string };
  // check
  checkAbility?: string;
  checkDC?: number;
  skills?: string[];
  // cast (link a real compendium spell — the activity casts it, pulling its measured template / save /
  // attack / effects). The page orchestrator resolves the spell from spellUuid and fills level/
  // spellProperties before calling this pure builder; saveDC/attackBonus drive the challenge override.
  spellUuid?: string;
  /** Cast level (e.g. 3 for Fireball). Resolved from the spell's base level when omitted. */
  level?: number;
  /** The spell's V/S/M components (['vocal','somatic','material']) — resolved from the linked spell. */
  spellProperties?: string[];
  /**
   * Cast consumption. usesOn 'item' (default — the wand pattern): `charges` are consumed FROM the
   * parent item's own pool per cast. usesOn 'activity' (the feature-granted free-cast pattern —
   * required when the parent has no pool): a pool of `charges` uses (number or formula, e.g.
   * "@scale.ranger.favored-enemy") lives ON the activity, recovering per `recoveryPeriod`, and one
   * use is consumed per cast. Omit charges for an at-will cast (no consumption either way).
   */
  charges?: number | string;
  usesOn?: 'item' | 'activity';
  /** Activity-pool recovery (usesOn 'activity' only): lr / sr / day / dawn / dusk. Default 'lr'. */
  recoveryPeriod?: string;
}

/** Build one dnd5e activity object of the given type. */
export function buildActivity(type: string, opts: BuildActivityOpts): Record<string, any> {
  switch (type) {
    case 'attack':
      return buildAttackActivity(opts);
    case 'save':
      return buildSaveActivity(opts);
    case 'damage':
      return buildDamageActivity(opts);
    case 'heal':
      return buildHealActivity(opts);
    case 'check':
      return buildCheckActivity(opts);
    case 'utility':
      return buildUtilityActivity(opts);
    case 'cast':
      return buildCastActivity(opts);
    default:
      throw new Error(
        `Unknown activity type "${type}". Use attack, damage, save, heal, check, utility, or cast.`
      );
  }
}

// --- attack (byte-for-byte the addAttackToActor inline shape) -----------------
function buildAttackActivity(opts: BuildActivityOpts): Record<string, any> {
  const activationType = opts.activationType ?? 'action';
  return {
    _id: opts.id,
    type: 'attack',
    name: opts.name ?? '',
    img: '',
    sort: opts.sort ?? 0,
    description: {},
    activation: { type: activationType, value: 1, condition: '', override: false },
    duration: { units: '', value: '', override: false },
    target: {
      template: {
        count: '',
        contiguous: false,
        type: '',
        size: '',
        width: '',
        height: '',
        units: '',
      },
      affects: { count: '', type: '', choice: false, special: '' },
      prompt: true,
      override: false,
    },
    range: { units: 'self', override: false },
    uses: { spent: 0, max: '', recovery: [] },
    consumption: { targets: [], scaling: { allowed: false, max: '' }, spellSlot: true },
    attack: {
      ability: '',
      bonus: (opts.attackBonus ?? 0) > 0 ? String(opts.attackBonus) : '',
      critical: { threshold: null },
      flat: false,
      type: { value: opts.attackType ?? 'melee', classification: opts.classification ?? '' },
      ...(opts.ability !== undefined ? { ability: opts.ability } : {}),
    },
    damage: {
      critical: { bonus: '' },
      includeBase: opts.includeBase ?? true,
      parts: (opts.damageParts ?? []).map(damagePartToActivity),
    },
    effects: [],
    save: { ability: '', dc: { formula: '', calculation: '' } },
  };
}

// --- save (byte-for-byte the addAttackWithSaveToActor save shape) -------------
function buildSaveActivity(opts: BuildActivityOpts): Record<string, any> {
  const activationType = opts.activationType ?? 'action';
  return {
    _id: opts.id,
    type: 'save',
    name: opts.name ?? '',
    sort: opts.sort ?? 0,
    description: {},
    activation: { type: activationType, value: 1, override: false },
    duration: { units: 'inst', concentration: false, override: false },
    effects: [],
    range: { units: 'self', override: false },
    uses: { spent: 0, recovery: [] },
    consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
    target: {
      template: {
        count: '',
        contiguous: false,
        type: '',
        size: '',
        width: '',
        height: '',
        units: '',
      },
      affects: { count: '1', type: 'creature', choice: false, special: '' },
      override: false,
      prompt: true,
    },
    damage: {
      onSave: opts.onSave ?? 'none',
      parts: (opts.damageParts ?? []).map(damagePartToActivity),
    },
    save: {
      // Guard against a malformed [undefined] entry if a caller omits the ability (the tool layer
      // requires it, but keep the page defensive). addAttackWithSaveToActor always supplies it.
      ability: opts.saveAbility ? [opts.saveAbility] : [],
      dc: { calculation: '', formula: opts.saveDC !== undefined ? String(opts.saveDC) : '' },
    },
  };
}

// --- damage (lean; dnd5e fills defaults) --------------------------------------
function buildDamageActivity(opts: BuildActivityOpts): Record<string, any> {
  return {
    _id: opts.id,
    type: 'damage',
    name: opts.name ?? '',
    sort: opts.sort ?? 0,
    activation: { type: opts.activationType ?? 'action', value: 1, override: false },
    damage: { parts: (opts.damageParts ?? []).map(damagePartToActivity) },
  };
}

// --- heal (lean) --------------------------------------------------------------
function buildHealActivity(opts: BuildActivityOpts): Record<string, any> {
  const h = opts.healing ?? { number: 1, denomination: 4 };
  return {
    _id: opts.id,
    type: 'heal',
    name: opts.name ?? '',
    sort: opts.sort ?? 0,
    activation: { type: opts.activationType ?? 'action', value: 1, override: false },
    healing: {
      number: h.number,
      denomination: h.denomination,
      types: [h.type ?? 'healing'],
      bonus: '',
      custom: { enabled: false },
      scaling: { mode: '', number: 1 },
    },
  };
}

// --- check (lean) -------------------------------------------------------------
function buildCheckActivity(opts: BuildActivityOpts): Record<string, any> {
  return {
    _id: opts.id,
    type: 'check',
    name: opts.name ?? '',
    sort: opts.sort ?? 0,
    activation: { type: opts.activationType ?? 'action', value: 1, override: false },
    check: {
      associated: opts.skills ?? [],
      ability: opts.checkAbility ?? '',
      dc: { calculation: '', formula: opts.checkDC !== undefined ? String(opts.checkDC) : '' },
    },
  };
}

// --- utility (lean; e.g. Multiattack) -----------------------------------------
function buildUtilityActivity(opts: BuildActivityOpts): Record<string, any> {
  return {
    _id: opts.id,
    type: 'utility',
    name: opts.name ?? '',
    sort: opts.sort ?? 0,
    activation: { type: opts.activationType ?? 'action', value: 1, override: false },
  };
}

// --- cast (link a real compendium spell) --------------------------------------
// Mirrors the live DMG Wand of Fireballs / our verified Staff of Minor Bolts cast activity. The
// activity LINKS a spell by uuid (spell.uuid); casting it pulls that spell's measured template
// (fireball sphere, lightning line…), save/attack, and effects FOR FREE — which is why target.template
// stays MINIMAL here (the spell owns the real template; a full override would suppress it).
//
//   challenge: saveDC -> {save, attack:null, override:true} (fixed DC, e.g. the Wand of Fireballs)
//              attackBonus -> {attack:N, override:true}      (fixed spell-attack, e.g. a Witch Bolt staff)
//              neither -> {attack:null, override:false}       (defer DC/attack to the casting actor)
// The page sanitizer strips `save` tree-wide, so a fixed save DC is correct-but-invisible on read-back.
//
//   consumption: spellSlot:false (an item never eats the holder's spell slots) + either an itemUses
//                target of `charges` per cast (usesOn 'item', the wand pattern) or a self-contained
//                pool of `charges` uses ON the activity with one activityUses consumed per cast
//                (usesOn 'activity', the feature free-cast pattern — the sheet's "Additional Spells"
//                row counter reads this pool). Omit charges for an at-will cast (empty targets).
function buildCastActivity(opts: BuildActivityOpts): Record<string, any> {
  const challenge =
    opts.saveDC !== undefined
      ? { save: opts.saveDC, attack: null, override: true }
      : opts.attackBonus !== undefined
        ? { attack: opts.attackBonus, override: true }
        : { attack: null, override: false };
  const hasCharges = opts.charges !== undefined && opts.charges !== null;
  const pooled = hasCharges && opts.usesOn === 'activity';
  const targets = pooled
    ? [{ type: 'activityUses', value: '1', target: '', scaling: { mode: '', formula: '' } }]
    : hasCharges
      ? [
          {
            type: 'itemUses',
            value: String(opts.charges),
            target: '',
            scaling: { mode: '', formula: '' },
          },
        ]
      : [];
  const uses = pooled
    ? {
        spent: 0,
        max: String(opts.charges),
        recovery: [{ period: opts.recoveryPeriod ?? 'lr', type: 'recoverAll' }],
      }
    : { spent: 0, recovery: [], max: '' };
  return {
    _id: opts.id,
    type: 'cast',
    name: opts.name ?? '',
    img: '',
    sort: opts.sort ?? 0,
    spell: {
      uuid: opts.spellUuid ?? '',
      challenge,
      level: opts.level ?? 0,
      properties: opts.spellProperties ?? [],
      spellbook: true,
    },
    activation: { type: opts.activationType ?? 'action', value: null, override: false },
    consumption: { scaling: { allowed: false, max: '' }, spellSlot: false, targets },
    description: { chatFlavor: '' },
    duration: { units: 'inst', concentration: false, override: false },
    range: { override: false, units: 'self' },
    target: {
      template: { contiguous: false, units: 'ft', stationary: false },
      affects: { choice: false },
      override: false,
      prompt: true,
    },
    uses,
    flags: {},
    visibility: {
      level: {},
      requireAttunement: false,
      requireIdentification: false,
      requireMagic: false,
    },
  };
}
