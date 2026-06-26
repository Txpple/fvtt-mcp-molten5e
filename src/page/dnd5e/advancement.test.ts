/**
 * Offline unit tests for the PURE leveling-engine helpers (src/page/dnd5e/advancement.ts): level
 * coercion, the per-advancement choice summary, and the choice-satisfaction / missing-choice logic.
 * No Foundry globals — these guard the choice-data contract the engine + inspect-pc-advancement
 * expose, against plain mock advancement descriptors. The build/apply path is page-side and proven
 * live by scripts/spike-pc-build.mjs + scripts/verify-pc-build.mjs.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeLevels,
  levelsUpTo,
  summarizeChoice,
  isChoiceSatisfied,
  computeMissingChoices,
  allowedForRole,
  planAdvancementApply,
  type AdvancementChoice,
  type AdvancementPlanInput,
  type PcChoiceMap,
} from './advancement.js';

describe('normalizeLevels', () => {
  it('coerces string levels (the Dragonborn-ancestry "0" gotcha) to sorted unique numbers', () => {
    expect(normalizeLevels(['0', '1'])).toEqual([0, 1]);
    expect(normalizeLevels(['1'])).toEqual([1]);
    expect(normalizeLevels([5])).toEqual([5]);
    expect(normalizeLevels([1, 1, 0])).toEqual([0, 1]);
    expect(normalizeLevels(0)).toEqual([0]);
    expect(normalizeLevels(undefined)).toEqual([]);
  });

  it('drops non-numeric junk', () => {
    expect(normalizeLevels(['x', '2', null])).toEqual([2]);
  });
});

describe('levelsUpTo', () => {
  it('is the inclusive 0..level walk (species/background sit at 0)', () => {
    expect(levelsUpTo(1)).toEqual([0, 1]);
    expect(levelsUpTo(3)).toEqual([0, 1, 2, 3]);
    expect(levelsUpTo(0)).toEqual([0]);
  });
});

describe('summarizeChoice', () => {
  it('Trait with a choice group → {dataKey:chosen, count, options}', () => {
    const c = summarizeChoice(
      {
        id: 'adv1',
        type: 'Trait',
        title: 'Skill Proficiencies',
        configuration: { grants: [], choices: [{ count: 2, pool: ['skills:acr', 'skills:ath'] }] },
      },
      1,
      'class'
    );
    expect(c).toEqual({
      id: 'adv1',
      source: 'class',
      level: 1,
      type: 'Trait',
      title: 'Skill Proficiencies',
      dataKey: 'chosen',
      count: 2,
      options: [{ value: 'skills:acr' }, { value: 'skills:ath' }],
    });
  });

  it('Trait that is forced-only (grants, no choices) → null (no player pick)', () => {
    const c = summarizeChoice(
      {
        id: 'advSaves',
        type: 'Trait',
        title: 'Saving Throw Proficiencies',
        configuration: { grants: ['saves:str', 'saves:con'], choices: [] },
      },
      1,
      'class'
    );
    expect(c).toBeNull();
  });

  it('Trait with multiple groups sums counts and de-dupes the pooled options', () => {
    const c = summarizeChoice(
      {
        id: 'adv2',
        type: 'Trait',
        title: 'Background Proficiencies',
        configuration: {
          choices: [
            { count: 1, pool: ['tool:game:*'] },
            { count: 2, pool: ['skills:acr', 'tool:game:*'] },
          ],
        },
      },
      0,
      'background'
    );
    expect(c?.count).toBe(3);
    expect(c?.options).toEqual([{ value: 'tool:game:*' }, { value: 'skills:acr' }]);
  });

  it('ItemChoice → {dataKey:selected, count from per-level config, pool uuids}', () => {
    const c = summarizeChoice(
      {
        id: 'advFS',
        type: 'ItemChoice',
        title: 'Fighting Style',
        configuration: { choices: { 1: { count: 1 } }, pool: [{ uuid: 'u1' }, { uuid: 'u2' }] },
      },
      1,
      'class'
    );
    expect(c?.dataKey).toBe('selected');
    expect(c?.count).toBe(1);
    expect(c?.options).toEqual([
      { value: 'u1', label: undefined },
      { value: 'u2', label: undefined },
    ]);
  });

  it('ItemChoice handles string-keyed levels (Draconic Ancestry "0") and applies option labels', () => {
    const labels = new Map([['uAcid', 'Acid Breath Weapon']]);
    const c = summarizeChoice(
      {
        id: 'advAnc',
        type: 'ItemChoice',
        title: 'Draconic Ancestry',
        configuration: { choices: { '0': { count: 1 } }, pool: [{ uuid: 'uAcid' }] },
      },
      0,
      'species',
      labels
    );
    expect(c?.count).toBe(1);
    expect(c?.options).toEqual([{ value: 'uAcid', label: 'Acid Breath Weapon' }]);
  });

  it('Subclass → descriptive {dataKey:uuid} (v2 surface, so a too-high level fails loudly)', () => {
    const c = summarizeChoice(
      { id: 'advSub', type: 'Subclass', title: 'Subclass', configuration: {} },
      3,
      'class'
    );
    expect(c?.dataKey).toBe('uuid');
    expect(c?.count).toBe(1);
  });

  it('non-choice advancement types carry no player pick → null', () => {
    for (const type of ['HitPoints', 'ScaleValue', 'ItemGrant', 'AbilityScoreImprovement']) {
      expect(
        summarizeChoice({ id: 'x', type, title: type, configuration: {} }, 1, 'class')
      ).toBeNull();
    }
  });

  it('Trait/ItemChoice with zero count → null', () => {
    expect(
      summarizeChoice(
        {
          id: 'a',
          type: 'Trait',
          title: 't',
          configuration: { choices: [{ count: 0, pool: [] }] },
        },
        1,
        'class'
      )
    ).toBeNull();
    expect(
      summarizeChoice(
        { id: 'b', type: 'ItemChoice', title: 't', configuration: { choices: {}, pool: [] } },
        1,
        'class'
      )
    ).toBeNull();
  });
});

describe('allowedForRole (the 2024 multiclass proficiency-subset rule)', () => {
  it('species/background/subclass (no role) always apply', () => {
    expect(allowedForRole('', undefined)).toBe(true);
    expect(allowedForRole('primary', undefined)).toBe(true);
    expect(allowedForRole('secondary', undefined)).toBe(true);
  });

  it('a PRIMARY (original) class applies everything except secondary-only advancements', () => {
    expect(allowedForRole('', 'primary')).toBe(true);
    expect(allowedForRole('primary', 'primary')).toBe(true);
    expect(allowedForRole('secondary', 'primary')).toBe(false);
  });

  it('a SECONDARY (multiclass) class skips the primary-only profs, keeps the rest', () => {
    expect(allowedForRole('', 'secondary')).toBe(true);
    expect(allowedForRole('secondary', 'secondary')).toBe(true);
    expect(allowedForRole('primary', 'secondary')).toBe(false);
  });
});

describe('planAdvancementApply (the pure apply-sequencing decision)', () => {
  const base: AdvancementPlanInput = {
    type: 'ItemGrant',
    classRestriction: '',
    level: 1,
    classRole: undefined,
    isOriginalClass: false,
    hpMode: 'avg',
  };

  it('skips an advancement whose classRestriction excludes this role (2024 multiclass subset)', () => {
    expect(
      planAdvancementApply({
        ...base,
        type: 'Trait',
        classRestriction: 'primary',
        classRole: 'secondary',
      })
    ).toEqual([{ kind: 'skip', reason: 'skipped (primary-only; this class is secondary)' }]);
    expect(
      planAdvancementApply({
        ...base,
        type: 'HitPoints',
        classRestriction: 'secondary',
        classRole: 'primary',
      })
    ).toEqual([{ kind: 'skip', reason: 'skipped (secondary-only; this class is primary)' }]);
  });

  it('original class L1 HP is max; a secondary class L1 (and every level past 1) uses hpMode', () => {
    expect(
      planAdvancementApply({
        ...base,
        type: 'HitPoints',
        level: 1,
        classRole: 'primary',
        isOriginalClass: true,
      })
    ).toEqual([{ kind: 'apply', data: { 1: 'max' }, initial: false, result: 'hp:max' }]);
    expect(
      planAdvancementApply({
        ...base,
        type: 'HitPoints',
        level: 1,
        classRole: 'secondary',
        isOriginalClass: false,
      })
    ).toEqual([{ kind: 'apply', data: { 1: 'avg' }, initial: false, result: 'hp:avg' }]);
    // level > 1 follows hpMode even on the original class (only L1 is forced max)
    expect(
      planAdvancementApply({
        ...base,
        type: 'HitPoints',
        level: 5,
        classRole: 'primary',
        isOriginalClass: true,
        hpMode: 'max',
      })
    ).toEqual([{ kind: 'apply', data: { 5: 'max' }, initial: false, result: 'hp:max' }]);
    expect(
      planAdvancementApply({
        ...base,
        type: 'HitPoints',
        level: 3,
        classRole: 'primary',
        isOriginalClass: true,
        hpMode: 'avg',
      })
    ).toEqual([{ kind: 'apply', data: { 3: 'avg' }, initial: false, result: 'hp:avg' }]);
  });

  it('skips ASI — the skill owns final ability scores (§2.1)', () => {
    expect(planAdvancementApply({ ...base, type: 'AbilityScoreImprovement' })).toEqual([
      { kind: 'skip', reason: 'skipped (ability scores owned by the skill)' },
    ]);
  });

  it('a forced-only advancement (no supplied pick) is a single initial:true apply', () => {
    expect(planAdvancementApply({ ...base, type: 'ItemGrant' })).toEqual([
      { kind: 'apply', data: {}, initial: true },
    ]);
    // a Trait/ItemChoice/Subclass with NO (or empty) choice data → forced only, no second apply
    expect(planAdvancementApply({ ...base, type: 'Trait', choiceData: { chosen: [] } })).toEqual([
      { kind: 'apply', data: {}, initial: true },
    ]);
    expect(planAdvancementApply({ ...base, type: 'Subclass' })).toEqual([
      { kind: 'apply', data: {}, initial: true },
    ]);
  });

  it('a supplied Trait pick is forced-then-pick (the {initial} clobber workaround)', () => {
    expect(
      planAdvancementApply({
        ...base,
        type: 'Trait',
        choiceData: { chosen: ['skills:acr', 'skills:ath'] },
      })
    ).toEqual([
      { kind: 'apply', data: {}, initial: true },
      {
        kind: 'apply',
        data: { chosen: ['skills:acr', 'skills:ath'] },
        initial: false,
        result: 'applied (+choice)',
      },
    ]);
  });

  it('a supplied ItemChoice pick uses selected[]; a Subclass pick uses uuid', () => {
    expect(
      planAdvancementApply({ ...base, type: 'ItemChoice', choiceData: { selected: ['u1'] } })
    ).toEqual([
      { kind: 'apply', data: {}, initial: true },
      { kind: 'apply', data: { selected: ['u1'] }, initial: false, result: 'applied (+choice)' },
    ]);
    expect(
      planAdvancementApply({
        ...base,
        type: 'Subclass',
        level: 3,
        choiceData: { uuid: 'Compendium.x.Item.y' },
      })
    ).toEqual([
      { kind: 'apply', data: {}, initial: true },
      {
        kind: 'apply',
        data: { uuid: 'Compendium.x.Item.y' },
        initial: false,
        result: 'applied (+choice)',
      },
    ]);
  });

  it('ignores mismatched choice data (a uuid supplied for a Trait is not applied)', () => {
    expect(planAdvancementApply({ ...base, type: 'Trait', choiceData: { uuid: 'x' } })).toEqual([
      { kind: 'apply', data: {}, initial: true },
    ]);
  });
});

describe('isChoiceSatisfied / computeMissingChoices', () => {
  const trait: AdvancementChoice = {
    id: 'adv1',
    source: 'class',
    level: 1,
    type: 'Trait',
    title: 'Skill Proficiencies',
    dataKey: 'chosen',
    count: 2,
    options: [],
  };
  const item: AdvancementChoice = {
    id: 'advFS',
    source: 'class',
    level: 1,
    type: 'ItemChoice',
    title: 'Fighting Style',
    dataKey: 'selected',
    count: 1,
    options: [],
  };
  const sub: AdvancementChoice = {
    id: 'advSub',
    source: 'class',
    level: 3,
    type: 'Subclass',
    title: 'Subclass',
    dataKey: 'uuid',
    count: 1,
    options: [],
  };

  it('treats a non-empty value under the expected dataKey + level as satisfied', () => {
    const choices: PcChoiceMap = {
      '1': { adv1: { chosen: ['skills:acr', 'skills:ath'] }, advFS: { selected: ['u1'] } },
      '3': { advSub: { uuid: 'Compendium.x.Item.y' } },
    };
    expect(isChoiceSatisfied(trait, choices)).toBe(true);
    expect(isChoiceSatisfied(item, choices)).toBe(true);
    expect(isChoiceSatisfied(sub, choices)).toBe(true);
  });

  it('treats absent / empty / wrong-key data as unsatisfied', () => {
    expect(isChoiceSatisfied(trait, undefined)).toBe(false);
    expect(isChoiceSatisfied(trait, { '1': { adv1: { chosen: [] } } })).toBe(false);
    expect(isChoiceSatisfied(trait, { '1': { adv1: { selected: ['x'] } } })).toBe(false);
    expect(isChoiceSatisfied(item, { '1': { advFS: { selected: [] } } })).toBe(false);
    expect(isChoiceSatisfied(sub, { '3': { advSub: { uuid: '' } } })).toBe(false);
    // right id, wrong level bucket
    expect(isChoiceSatisfied(trait, { '0': { adv1: { chosen: ['skills:acr'] } } })).toBe(false);
  });

  it('computeMissingChoices returns only the unsatisfied specs', () => {
    const choices: PcChoiceMap = { '1': { adv1: { chosen: ['skills:acr', 'skills:ath'] } } };
    const missing = computeMissingChoices([trait, item], choices);
    expect(missing).toEqual([item]);
  });
});
