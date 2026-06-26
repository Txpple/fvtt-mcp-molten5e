import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDdbCharacter, unwrapDdb } from './parse.js';

// ---------------------------------------------------------------------------
// Synthetic inputs — a controlled oracle for the hard math (ability scores, the per-class modifier
// duplication, choose-an-ability-score resolution, proficiency derivation). We construct minimal
// DDB-shaped payloads so the expected output is hand-verifiable, independent of any real character.
// ---------------------------------------------------------------------------

function baseStats(values: number[]) {
  return values.map((value, i) => ({ id: i + 1, value }));
}
const nullStats = () => [1, 2, 3, 4, 5, 6].map(id => ({ id, value: null }));

function minimalCharacter(overrides: any = {}): any {
  return {
    id: 1,
    name: 'Test',
    stats: baseStats([10, 15, 12, 13, 14, 8]),
    bonusStats: nullStats(),
    overrideStats: nullStats(),
    modifiers: { race: [], class: [], background: [], item: [], feat: [], condition: [] },
    choices: { race: [], class: [], background: [], feat: [], choiceDefinitions: [] },
    options: { race: [], class: [], background: [], feat: [] },
    classes: [],
    race: {},
    background: { definition: { name: 'Soldier' }, hasCustomBackground: false },
    inventory: [],
    feats: [],
    currencies: { cp: 0, sp: 0, gp: 0, ep: 0, pp: 0 },
    spells: { race: [], class: [], feat: [], item: [], background: [] },
    classSpells: [],
    preferences: {},
    ...overrides,
  };
}

describe('parseDdbCharacter — ability scores', () => {
  it('sums concrete <ability>-score bonuses and dedupes per-class duplication', () => {
    const c = minimalCharacter({
      modifiers: {
        race: [
          {
            id: 'a',
            componentId: 1,
            type: 'bonus',
            subType: 'dexterity-score',
            value: 1,
            restriction: '',
          },
        ],
        // DDB lists availableToMulticlass mods once per class — same componentId/subType/value, distinct id.
        class: [
          {
            id: 'b1',
            componentId: 5,
            type: 'bonus',
            subType: 'dexterity-score',
            value: 1,
            restriction: null,
          },
          {
            id: 'b2',
            componentId: 5,
            type: 'bonus',
            subType: 'dexterity-score',
            value: 1,
            restriction: null,
          },
        ],
        background: [],
        item: [],
        feat: [],
        condition: [],
      },
    });
    const plan = parseDdbCharacter(c);
    // base 15 + race 1 + class (deduped to a single +1) = 17, NOT 18.
    expect(plan.abilities.dex).toBe(17);
    expect(plan.abilities.str).toBe(10);
  });

  it('resolves choose-an-ability-score via its matching choice (optionValue -> ability)', () => {
    const c = minimalCharacter({
      modifiers: {
        race: [],
        class: [
          { id: 99, componentId: 7, type: 'bonus', subType: 'choose-an-ability-score', value: 1 },
        ],
        background: [],
        item: [],
        feat: [],
        condition: [],
      },
      // choice id is "<type>-<modifierId>"; optionValue 3522 = CON.
      choices: { class: [{ id: '2-99', optionValue: 3522 }], choiceDefinitions: [] },
    });
    const plan = parseDdbCharacter(c);
    expect(plan.abilities.con).toBe(13); // 12 + 1
    expect(plan.abilityNotes).toHaveLength(0);
  });

  it('notes (does not guess) an unresolved choose-an-ability-score', () => {
    const c = minimalCharacter({
      modifiers: {
        race: [],
        class: [
          { id: 99, componentId: 7, type: 'bonus', subType: 'choose-an-ability-score', value: 1 },
        ],
        background: [],
        item: [],
        feat: [],
        condition: [],
      },
      choices: { class: [], choiceDefinitions: [] }, // no resolving choice
    });
    const plan = parseDdbCharacter(c);
    expect(plan.abilities.con).toBe(12); // unchanged
    expect(plan.abilityNotes.length).toBeGreaterThan(0);
  });

  it('computes max HP as base + bonus + conMod*level, honoring an override', () => {
    const lvl1 = minimalCharacter({
      baseHitPoints: 8, // DDB base EXCLUDES con; con 12 -> +1, level 1 -> 9
      classes: [{ level: 1, isStartingClass: true, definition: { name: 'Bard', hitDice: 8 } }],
    });
    expect(parseDdbCharacter(lvl1).hp.max).toBe(9);

    const overridden = minimalCharacter({
      baseHitPoints: 8,
      overrideHitPoints: 30,
      classes: [{ level: 1, isStartingClass: true, definition: { name: 'Bard' } }],
    });
    expect(parseDdbCharacter(overridden).hp.max).toBe(30);
  });

  it('honors overrideStats and a set floor; skips restricted bonuses', () => {
    const c = minimalCharacter({
      overrideStats: [{ id: 1, value: 20 }, ...[2, 3, 4, 5, 6].map(id => ({ id, value: null }))],
      modifiers: {
        race: [
          { id: 'set', componentId: 3, type: 'set', subType: 'intelligence-score', value: 19 },
          {
            id: 'r',
            componentId: 4,
            type: 'bonus',
            subType: 'wisdom-score',
            value: 2,
            restriction: 'while raging',
          },
        ],
        class: [],
        background: [],
        item: [],
        feat: [],
        condition: [],
      },
    });
    const plan = parseDdbCharacter(c);
    expect(plan.abilities.str).toBe(20); // override wins
    expect(plan.abilities.int).toBe(19); // set floor raises 13 -> 19
    expect(plan.abilities.wis).toBe(14); // restricted bonus skipped
  });
});

describe('parseDdbCharacter — proficiencies', () => {
  it('derives skills, expertise, saves, languages, armor, weapons; resolves a generic skill choice', () => {
    const c = minimalCharacter({
      modifiers: {
        race: [{ id: 'l', componentId: 1, type: 'language', subType: 'elvish' }],
        class: [
          { id: 's', componentId: 2, type: 'proficiency', subType: 'athletics' },
          { id: 'e', componentId: 3, type: 'expertise', subType: 'stealth' },
          { id: 'sv', componentId: 4, type: 'proficiency', subType: 'dexterity-saving-throws' },
          { id: 'a', componentId: 5, type: 'proficiency', subType: 'light-armor' },
          { id: 'w', componentId: 6, type: 'proficiency', subType: 'martial-weapons' },
          { id: 'g', componentId: 7, type: 'proficiency', subType: 'choose-a-skill' },
        ],
        background: [],
        item: [],
        feat: [],
        condition: [],
      },
      choices: {
        class: [{ id: '2-g', optionValue: 9001 }],
        choiceDefinitions: [{ id: 'x', options: [{ id: 9001, label: 'Arcana' }] }],
      },
    });
    const plan = parseDdbCharacter(c);
    expect(plan.proficiencies.skills).toContain('ath');
    expect(plan.proficiencies.skills).toContain('arc'); // resolved from the generic choice
    expect(plan.proficiencies.expertise).toContain('ste');
    expect(plan.proficiencies.saves).toContain('dex');
    expect(plan.proficiencies.languages).toContain('Elvish');
    expect(plan.proficiencies.armor).toContain('light-armor');
    expect(plan.proficiencies.weapons).toContain('martial-weapons');
  });
});

describe('parseDdbCharacter — biography', () => {
  it('maps DDB notes/traits/identity to labeled bio blocks (non-empty only, HTML stripped)', () => {
    const c = minimalCharacter({
      notes: { organizations: 'A member of the <b>league of shadows</b>.', backstory: null },
      traits: { ideals: 'Freedom.', bonds: '   ' },
      faith: 'Lathander',
      alignmentId: 3,
    });
    const plan = parseDdbCharacter(c);
    const labels = plan.bio.entries.map(e => e.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Organizations', 'Ideals', 'Faith', 'Alignment'])
    );
    expect(plan.bio.entries.find(e => e.label === 'Organizations')?.text).toBe(
      'A member of the league of shadows.' // HTML stripped
    );
    expect(plan.bio.entries.find(e => e.label === 'Alignment')?.text).toBe('Chaotic Good');
    expect(labels).not.toContain('Bonds'); // whitespace-only dropped
    expect(labels).not.toContain('Backstory'); // null dropped
  });

  it('emits an empty bio when DDB has no notes/traits', () => {
    expect(parseDdbCharacter(minimalCharacter()).bio.entries).toEqual([]);
  });
});

describe('unwrapDdb', () => {
  it('unwraps the v5 envelope and accepts a bare data object', () => {
    const bare = minimalCharacter();
    expect(unwrapDdb({ success: true, data: bare }).name).toBe('Test');
    expect(unwrapDdb(bare).name).toBe('Test');
  });

  it('throws on a non-character payload', () => {
    expect(() => parseDdbCharacter({ foo: 'bar' })).toThrow(/D&D Beyond character/);
  });
});

// ---------------------------------------------------------------------------
// Golden fixture — a real (public) v5 payload: "Vladimir Poutine", Variant-Human Fighter 8 (Arcane
// Archer) / Ranger 3 (Monster Slayer), 2014-legacy, homebrew-enabled. A deliberate hard case for the
// STRUCTURE (multiclass, two subclasses, the modifier/choice machinery) and the homebrew/legacy
// unresolved path. Its ability VALUES are the algorithm's faithful output for this (cheesed) sheet,
// not a claim about a "legal" build — the synthetic tests above own the math oracle.
// ---------------------------------------------------------------------------

describe('parseDdbCharacter — fixture: character-25755022 (multiclass, legacy, homebrew)', () => {
  const env = JSON.parse(
    readFileSync(new URL('./__fixtures__/character-25755022.json', import.meta.url), 'utf8')
  );
  const plan = parseDdbCharacter(env);

  it('identity, classes, multiclass split, subclasses', () => {
    expect(plan.name).toBe('Vladimir Poutine');
    expect(plan.totalLevel).toBe(11);
    // primary (isStarting) first
    expect(plan.classes[0]).toMatchObject({
      name: 'Fighter',
      level: 8,
      isStarting: true,
      subclass: 'Arcane Archer',
    });
    expect(plan.classes[1]).toMatchObject({ name: 'Ranger', level: 3, subclass: 'Monster Slayer' });
  });

  it('species + edition flagged legacy', () => {
    expect(plan.species.fullName).toBe('Variant Human');
    expect(plan.species.isLegacy).toBe(true);
    expect(plan.edition).not.toBe('2024');
  });

  it('ability scores (algorithm output: deduped per-class dex, race +1 int, unresolved homebrew boon noted)', () => {
    expect(plan.abilities).toMatchObject({ str: 10, dex: 18, con: 12, int: 14, wis: 14, cha: 8 });
    expect(plan.abilityNotes.length).toBeGreaterThan(0); // the comp-195 choose-an-ability-score is unresolved
  });

  it('proficiencies derived from the six modifier buckets', () => {
    expect(plan.proficiencies.saves).toEqual(expect.arrayContaining(['str', 'con', 'dex']));
    expect(plan.proficiencies.skills).toEqual(expect.arrayContaining(['acr', 'prc']));
    expect(plan.proficiencies.languages).toEqual(expect.arrayContaining(['Common', 'Elvish']));
  });

  it('resolved option picks (fighting style split out)', () => {
    expect(plan.options.fightingStyle).toContain('Archery');
    expect(plan.options.other).toEqual(expect.arrayContaining(['Piercing Arrow', 'Humanoids']));
  });

  it('spells: cantrips and prepared/known by name', () => {
    expect(plan.spells.cantrips).toContain('Druidcraft');
    expect(plan.spells.prepared).toEqual(expect.arrayContaining(["Hunter's Mark", 'Cure Wounds']));
  });

  it('inventory with the +N magic-variant raw name and flags', () => {
    expect(plan.inventory.length).toBe(21);
    const longbowPlus = plan.inventory.find(i => i.name === 'Longbow, +1');
    expect(longbowPlus).toMatchObject({ isMagic: true, equipped: true });
  });

  it('feats, currency, hp override', () => {
    expect(plan.feats.map(f => f.name)).toEqual(expect.arrayContaining(['Mobile', 'Sharpshooter']));
    expect(plan.feats.every(f => typeof f.description === 'string')).toBe(true);
    expect(plan.currency.gp).toBe(15);
    expect(plan.hp.max).toBe(73); // overrideHitPoints wins
  });

  it('unresolved flags the legacy species; does NOT false-positive definitionKeyNameMap entries', () => {
    expect(plan.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'species', name: 'Variant Human', reason: 'legacy-2014' }),
      ])
    );
    // definitionKeyNameMap is NOT a homebrew signal — its entries (here "Hero's Journey Boon",
    // "Dark Bargain") must NOT be auto-flagged; the skill's compendium lookup catches anything not
    // in the premium books. (Regression guard for the dogfood false-positive on "Magic Initiate".)
    expect(plan.unresolved.some(u => u.name === "Hero's Journey Boon")).toBe(false);
    expect(plan.unresolved.some(u => u.name === 'Dark Bargain')).toBe(false);
    expect(plan.flags.useHomebrew).toBe(true);
    expect(plan.warnings.some(w => /homebrew content/i.test(w))).toBe(true);
  });
});
