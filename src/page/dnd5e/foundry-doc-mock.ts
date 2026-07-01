// Offline mock of the slice of the Foundry document + compendium API that the page-side PC engine
// (advancement.ts) drives, so its ORCHESTRATION can be unit-tested with NO browser/live world. It does
// NOT simulate real dnd5e advancement math — advancement behaviors are injected per test (an `apply`
// that mutates the mock actor, or one that throws) — so assertions target control flow: persist-once,
// no-persist-on-error, level-up rollback, and the rest-to-full top-off. The real dnd5e math is gated
// live by tests/integration/pc.int.test.ts.
//
// Test-only (not imported by src/page/index.ts, so it never enters the page bundle). Co-located as a
// normal .ts — typechecked by the gate, like src/tools/test-helpers.ts — and installs onto globalThis,
// which advancement.ts reads at call time (bare `game`/`Roll`/`fromUuid` + globalThis.Actor).

/** An advancement behavior a test attaches to a fake class — its apply() effect (or a throw). */
export interface AdvBehaviorSpec {
  id: string;
  type: string; // 'HitPoints' | 'ItemGrant' | 'Trait' | 'Subclass' | 'AbilityScoreImprovement' | …
  title: string;
  levels: number[];
  classRestriction?: string;
  /** Mutate the owning actor when applied (e.g. bump HP, add an item, set spell slots). */
  effect?: (actor: MockActor, level: number, data: any, opts: any) => void;
  /** When true, apply() throws — to exercise the corrupting-failure path. */
  throws?: boolean;
}

/** A fake premium-book class/species/background document. */
export interface FakeDocSpec {
  name: string;
  type: 'class' | 'race' | 'background' | 'subclass';
  identifier: string;
  packId: string;
  advancements?: AdvBehaviorSpec[];
  /** Base system data merged onto an embedded copy (e.g. seed spell slots to test rest top-off). */
  system?: Record<string, any>;
}

let nextId = 1000;
const genId = (): string => `mock${nextId++}`;

/** Deep-clone plain data the way toObject() would (no functions, no live refs). */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null));
}

function setPath(obj: any, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = cur[keys[i]] ?? {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

/** A live advancement bound to its owning actor — what extractAdvancements lifts and calls .apply on. */
function buildAdvancement(spec: AdvBehaviorSpec, actor: MockActor): any {
  return {
    id: spec.id,
    title: spec.title,
    levels: spec.levels,
    classRestriction: spec.classRestriction ?? '',
    configuration: {},
    apply: async (level: number, data: any, opts: any) => {
      if (spec.throws) throw new Error(`mock advancement "${spec.title}" rejected`);
      spec.effect?.(actor, level, data, opts);
    },
  };
}

export class MockItem {
  id: string;
  name: string;
  type: string;
  system: any;
  isOriginalClass = false;
  /** the registry key for this item's advancement behaviors — preserved through persist so a level-up
   *  on a re-read actor can still apply them (real Foundry reconstructs advancements from stored data). */
  advKey?: string;
  /** the advancement behaviors this item carries (a class/species/background) — bound when embedded. */
  private behaviors: AdvBehaviorSpec[];
  private actor: MockActor;

  constructor(data: any, actor: MockActor, behaviors: AdvBehaviorSpec[]) {
    this.id = data._id ?? genId();
    this.name = data.name ?? '';
    this.type = data.type ?? 'feat';
    this.system = clone(data.system ?? {});
    this.behaviors = behaviors;
    this.actor = actor;
    if (data.__advKey) this.advKey = data.__advKey;
  }

  /** byType map the engine reads via extractAdvancements; apply() closes over the owning actor. */
  get advancement(): any {
    const byType: Record<string, any[]> = {};
    for (const b of this.behaviors) {
      byType[b.type] = byType[b.type] ?? [];
      byType[b.type].push(buildAdvancement(b, this.actor));
    }
    return { byType };
  }

  toObject(): any {
    return {
      _id: this.id,
      name: this.name,
      type: this.type,
      system: clone(this.system),
      ...(this.advKey ? { __advKey: this.advKey } : {}),
    };
  }
}

export class MockActor {
  id: string;
  name: string;
  type: string;
  system: any;
  /** Foundry stamps prototypeToken.name from the actor name at creation when none is supplied — the
   *  mock mirrors that so the createPcActor persist path (which must re-point it off the scratch name)
   *  can be regression-tested. */
  prototypeToken: any;
  folder: { id: string } | null = null;
  private _items: MockItem[] = [];
  private store: MockStore;

  constructor(data: any, store: MockStore) {
    this.id = data._id ?? genId();
    this.name = data.name ?? '';
    this.type = data.type ?? 'character';
    this.system = clone(data.system ?? { attributes: { hp: {} }, spells: {}, details: {} });
    this.prototypeToken = data.prototypeToken ? clone(data.prototypeToken) : { name: this.name };
    this.store = store;
    // Rehydrate persisted items, re-attaching advancement behaviors via the preserved __advKey so a
    // later level-up on this re-read actor can still apply them (mirrors Foundry reconstructing them).
    for (const it of data.items ?? []) {
      const behaviors = it.__advKey ? (store.behaviors[it.__advKey] ?? []) : [];
      this._items.push(new MockItem(it, this, behaviors));
    }
  }

  /** Array-like items collection with the get/find/filter the engine uses. */
  get items(): any {
    const arr = this._items;
    return {
      get: (id: string) => arr.find(i => i.id === id),
      find: (fn: (i: MockItem) => boolean) => arr.find(fn),
      filter: (fn: (i: MockItem) => boolean) => arr.filter(fn),
      map: (fn: (i: MockItem) => unknown) => arr.map(fn),
      [Symbol.iterator]: () => arr[Symbol.iterator](),
      get length() {
        return arr.length;
      },
    };
  }

  reset(): void {
    /* derived-data recompute — no-op in the mock */
  }

  getRollData(): any {
    return {};
  }

  updateSource(update: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(update)) setPath(this, k, v);
  }

  async update(update: Record<string, unknown>): Promise<void> {
    this.store.calls.push({ op: 'update', actor: this.id });
    for (const [k, v] of Object.entries(update)) {
      // `items` is a getter-backed embedded collection (already mutated in place) and `_id` is
      // immutable — the engine's `actor.update(actor.toObject())` persist includes both; skip them.
      if (k === 'items' || k === '_id') continue;
      setPath(this, k, v);
    }
  }

  async createEmbeddedDocuments(_type: string, dataArr: any[]): Promise<MockItem[]> {
    this.store.calls.push({ op: 'createEmbeddedDocuments', actor: this.id, count: dataArr.length });
    const created: MockItem[] = [];
    for (const data of dataArr) {
      const behaviors = data.__advKey ? (this.store.behaviors[data.__advKey] ?? []) : [];
      const item = new MockItem(data, this, behaviors);
      this._items.push(item);
      created.push(item);
    }
    return created;
  }

  async updateEmbeddedDocuments(_type: string, updates: any[]): Promise<void> {
    this.store.calls.push({ op: 'updateEmbeddedDocuments', actor: this.id, count: updates.length });
    for (const u of updates) {
      const item = this._items.find(i => i.id === u._id);
      if (!item) continue;
      for (const [k, v] of Object.entries(u)) {
        if (k === '_id') continue;
        setPath(item, k, v);
      }
    }
  }

  async deleteEmbeddedDocuments(_type: string, ids: string[]): Promise<void> {
    this.store.calls.push({ op: 'deleteEmbeddedDocuments', actor: this.id, ids });
    this._items = this._items.filter(i => !ids.includes(i.id));
  }

  async delete(): Promise<void> {
    this.store.actors.delete(this.id);
  }

  toObject(): any {
    // Persisted items are data-only — no advancements re-run after the build, so we don't carry __advKey.
    return {
      _id: this.id,
      name: this.name,
      type: this.type,
      system: clone(this.system),
      prototypeToken: clone(this.prototypeToken),
      items: this._items.map(i => i.toObject()),
    };
  }
}

interface MockStore {
  actors: Map<string, MockActor>;
  settings: Map<string, unknown>;
  behaviors: Record<string, AdvBehaviorSpec[]>;
  calls: Array<{ op: string; [k: string]: unknown }>;
}

export interface MockHandle {
  store: MockStore;
  /** number of persisted (non-deleted) actors — the temp build actor is deleted in finally. */
  persistedActorCount(): number;
  /** the calls recorded against actors, for asserting orchestration (persist/rollback/etc.). */
  calls(): Array<{ op: string; [k: string]: unknown }>;
  uninstall(): void;
}

/**
 * Install the mock onto globalThis (game/Actor/Roll/fromUuid). Returns a handle + uninstall.
 * `docs` are the fake premium-book class/species/background entries the engine resolves by name.
 */
export function installFoundryMock(docs: FakeDocSpec[]): MockHandle {
  const store: MockStore = {
    actors: new Map(),
    settings: new Map([['dnd5e.disableAdvancements', false]]),
    behaviors: {},
    calls: [],
  };

  // Register each fake doc's advancement behaviors under a per-doc key the embedded data carries.
  const indexByPack: Record<string, Array<{ _id: string; name: string; type: string }>> = {};
  const docById: Record<string, FakeDocSpec & { _id: string; advKey: string }> = {};
  for (const d of docs) {
    const _id = genId();
    const advKey = `${d.type}:${d.identifier}`;
    store.behaviors[advKey] = d.advancements ?? [];
    docById[_id] = { ...d, _id, advKey };
    indexByPack[d.packId] = indexByPack[d.packId] ?? [];
    indexByPack[d.packId].push({ _id, name: d.name, type: d.type });
  }

  /** A fake premium-book pack exposing the iterate/get/getIndex/getDocument surface the engine uses. */
  function makePack(packId: string) {
    return {
      documentName: 'Item',
      metadata: { id: packId },
      async getIndex() {
        return indexByPack[packId] ?? [];
      },
      async getDocument(_id: string) {
        const d = docById[_id];
        if (!d) return null;
        // A live source doc: toObject() carries the __advKey so an embedded copy rehydrates behaviors.
        return {
          name: d.name,
          type: d.type,
          system: { identifier: d.identifier, ...(d.system ?? {}) },
          toObject: () => ({
            name: d.name,
            type: d.type,
            system: { identifier: d.identifier, ...clone(d.system ?? {}) },
            __advKey: d.advKey,
          }),
        };
      },
    };
  }

  const packs: any[] = Object.keys(indexByPack).map(makePack);
  (packs as any).get = (id: string) => packs.find(p => p.metadata.id === id);

  const g = globalThis as any;
  const saved = { game: g.game, Actor: g.Actor, Roll: g.Roll, fromUuid: g.fromUuid };

  g.game = {
    system: { id: 'dnd5e' },
    packs,
    actors: { get: (id: string) => store.actors.get(id) },
    settings: {
      get: (scope: string, key: string) => store.settings.get(`${scope}.${key}`),
      set: async (scope: string, key: string, value: unknown) => {
        store.settings.set(`${scope}.${key}`, value);
      },
    },
  };
  g.Actor = {
    create: async (data: any) => {
      const actor = new MockActor(data, store);
      store.actors.set(actor.id, actor);
      return actor;
    },
  };
  g.Roll = { replaceFormulaData: (formula: string) => formula };
  g.fromUuid = async () => null;

  return {
    store,
    persistedActorCount: () =>
      [...store.actors.values()].filter(a => !a.name.startsWith('__mcp_pc_build_')).length,
    calls: () => store.calls,
    uninstall: () => {
      g.game = saved.game;
      g.Actor = saved.Actor;
      g.Roll = saved.Roll;
      g.fromUuid = saved.fromUuid;
    },
  };
}
