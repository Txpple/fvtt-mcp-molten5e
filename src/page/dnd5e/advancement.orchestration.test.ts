// Offline ORCHESTRATION tests for the PC engine (createPcActor / levelUpPc), driving the REAL functions
// against the in-memory Foundry mock (foundry-doc-mock.ts). These lock in the control flow the live
// suite proves end-to-end but that a green `npm test` otherwise never exercises — most importantly the
// Phase-1 fail-loud posture (no-persist-on-error for create, rollback-on-error for level-up) and the
// rest-to-full top-off. Advancement MATH is not simulated; tests inject simple apply effects.

import { describe, it, expect, afterEach } from 'vitest';
import { createPcActor, levelUpPc } from './advancement.js';
import { installFoundryMock, type FakeDocSpec, type MockHandle } from './foundry-doc-mock.js';

const PACK = 'dnd-players-handbook.classes';

/** A fighter-like class: forced HP (sets max), a forced feature grant, and a spell-slot seeder. */
function fighter(overrides: Partial<FakeDocSpec> = {}): FakeDocSpec {
  return {
    name: 'Fighter',
    type: 'class',
    identifier: 'fighter',
    packId: PACK,
    advancements: [
      {
        id: 'hp1',
        type: 'HitPoints',
        title: 'Hit Points',
        levels: [1],
        effect: actor => {
          actor.system.attributes = actor.system.attributes ?? {};
          actor.system.attributes.hp = { value: 0, max: 10 };
        },
      },
      {
        id: 'grant1',
        type: 'ItemGrant',
        title: 'Second Wind',
        levels: [1],
        effect: actor => {
          actor.system.spells = { spell1: { value: 0, max: 2 } };
        },
      },
    ],
    ...overrides,
  };
}

let mock: MockHandle | undefined;
afterEach(() => {
  mock?.uninstall();
  mock = undefined;
});

describe('createPcActor orchestration', () => {
  it('persists exactly one actor, finishes rested, and reports success on a clean build', async () => {
    mock = installFoundryMock([fighter()]);
    const res: any = await createPcActor({
      name: 'Aria',
      className: 'Fighter',
      level: 1,
      folder: 'fixed-folder', // skip getOrCreateFolder
    });

    expect(res.success).toBe(true);
    expect(res.errors ?? []).toEqual([]);
    expect(mock.persistedActorCount()).toBe(1); // the temp build actor was cleaned up
    expect(res.actor?.hp).toBe(10);

    // restPcToFull topped HP and spell slots to max on the persisted actor.
    const persisted = [...mock.store.actors.values()].find(a => a.name === 'Aria');
    expect(persisted?.system.attributes.hp.value).toBe(10);
    expect(persisted?.system.spells.spell1.value).toBe(2);
  });

  it('re-points the prototype token off the `__mcp_pc_build_` scratch name so dragged tokens read clean', async () => {
    mock = installFoundryMock([fighter()]);
    const res: any = await createPcActor({
      name: 'Aria',
      className: 'Fighter',
      level: 1,
      folder: 'fixed-folder',
    });

    expect(res.success).toBe(true);
    const persisted = [...mock.store.actors.values()].find(a => a.name === 'Aria');
    // The build happens on a temp `__mcp_pc_build_Aria` actor whose prototypeToken inherits that
    // scratch name; persist must reset it to the real name or every placed token shows the prefix.
    expect(persisted?.prototypeToken?.name).toBe('Aria');
    // …and the PC gets the shared table-ready token defaults: friendly, name+bars shown to all, vision on.
    expect(persisted?.prototypeToken?.displayName).toBe(50);
    expect(persisted?.prototypeToken?.displayBars).toBe(50);
    expect(persisted?.prototypeToken?.disposition).toBe(1); // a PC is friendly
    expect(persisted?.prototypeToken?.sight?.enabled).toBe(true);
  });

  it('does NOT persist and returns success:false + errors when a forced advancement throws', async () => {
    const broken = fighter();
    broken.advancements = [
      { id: 'hp1', type: 'HitPoints', title: 'Hit Points', levels: [1], throws: true },
    ];
    mock = installFoundryMock([broken]);

    const res: any = await createPcActor({
      name: 'Doomed',
      className: 'Fighter',
      level: 1,
      folder: 'fixed-folder',
    });

    expect(res.success).toBe(false);
    expect((res.errors ?? []).length).toBeGreaterThan(0);
    expect(res.actor).toBeUndefined();
    // No junk actor: the temp build actor was deleted in finally and nothing was persisted.
    expect(mock.persistedActorCount()).toBe(0);
  });
});

describe('levelUpPc orchestration', () => {
  /** Build a level-1 Fighter, returning its persisted id. */
  async function buildL1(): Promise<string> {
    const res: any = await createPcActor({
      name: 'Climber',
      className: 'Fighter',
      level: 1,
      folder: 'fixed-folder',
    });
    return res.actor.id;
  }

  it('rolls back the class bump and returns success:false when the new level errors', async () => {
    // Fighter L2 advancement throws; L1 is clean so the initial build succeeds.
    mock = installFoundryMock([
      fighter({
        advancements: [
          {
            id: 'hp1',
            type: 'HitPoints',
            title: 'Hit Points',
            levels: [1],
            effect: actor => {
              actor.system.attributes = { hp: { value: 0, max: 10 } };
            },
          },
          { id: 'hp2', type: 'HitPoints', title: 'Hit Points', levels: [2], throws: true },
        ],
      }),
    ]);
    const id = await buildL1();

    const res: any = await levelUpPc({ actorIdentifier: id, className: 'Fighter' });

    expect(res.success).toBe(false);
    expect((res.errors ?? []).length).toBeGreaterThan(0);
    // Rollback: the existing class level was reverted (updateEmbeddedDocuments back to level 1).
    const reverted = mock.calls().some(c => c.op === 'updateEmbeddedDocuments' && c.actor === id);
    expect(reverted).toBe(true);
    const actor = [...mock.store.actors.values()].find(a => a.id === id);
    const fighterItem = actor?.items.find((i: any) => i.type === 'class');
    expect(fighterItem?.system.levels).toBe(1);
  });

  it('rolls back by deleting a newly-embedded multiclass class when its first level errors', async () => {
    mock = installFoundryMock([
      fighter(),
      {
        name: 'Wizard',
        type: 'class',
        identifier: 'wizard',
        packId: PACK,
        advancements: [
          { id: 'whp1', type: 'HitPoints', title: 'Hit Points', levels: [1], throws: true },
        ],
      },
    ]);
    const id = await buildL1();

    const res: any = await levelUpPc({ actorIdentifier: id, className: 'Wizard' });

    expect(res.success).toBe(false);
    // Rollback of a multiclass add deletes the just-embedded class item.
    const deleted = mock.calls().some(c => c.op === 'deleteEmbeddedDocuments' && c.actor === id);
    expect(deleted).toBe(true);
    const actor = [...mock.store.actors.values()].find(a => a.id === id);
    const classCount = actor?.items.filter((i: any) => i.type === 'class').length;
    expect(classCount).toBe(1); // only the original Fighter remains
  });
});
