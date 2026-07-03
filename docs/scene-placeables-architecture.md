# Scene & Placeable CRUD — Architecture Review & Roadmap

> Status: **recommendation + in-flight build.** Grounds in the live code
> (`src/tools/scene.ts`, `src/page/scenes.ts`, `src/registry.ts`, `src/page/index.ts`) and the
> live v14 schema dump (`scratch-placeables-schema.json`). Honors design.md §2.1 ("skills decide,
> tools do") and §2.2 ("long-term architecture over quick fixes").
>
> **Implementation status (2026-07-02):**
> - ✅ **Phase 0 (teleporter destinations) — DONE + live-verified.** Fixing the singular→plural drift
>   surfaced two more live bugs (see §5.1): the field is a `SetField` (live value is a **Set**, not an
>   Array), and `remap-teleporters`' `flagOf` called `getFlag` on an unregistered scope, which **threw
>   on every world containing a non-imported scene** — so remap never actually ran. All three fixed;
>   11/11 live checks pass (`scripts/verify-teleporter-scene-fields.mjs`).
> - ✅ **Phase 0b (`update-scene` parity) — DONE + live-verified.** `environment`/`fog`/`initial`/`flags`
>   now editable on an existing scene, deep-merged (a partial patch layers on).
> - ✅ **Phase 1 (shared kernel) — DONE.** `src/page/_placeables.ts` (kernel) + `src/utils/placeable-format.ts`
>   (formatter) + `src/tools/placeables.ts` (per-type tools, split out of scene.ts). Region/Note NOT yet
>   retrofitted onto the kernel (additive for now — a later DRY cleanup).
> - ✅ **THE FOCUS SET — DONE + live-verified (28/28, `scripts/verify-placeables-tooling.mjs`).** Owner
>   scoped placeable editing to **tokens / tiles / lights / notes**: **Tile full CRUD**
>   (create/list/update/delete-tiles), **AmbientLight full CRUD** (create/list/update/delete-lights),
>   and read-only **list-tokens** + **list-notes** (the inspect layer that makes the existing
>   update-token / *-note editing loops usable). Tokens are update+read-only, notes keep their existing
>   create/update/delete — both by owner decision. 115 tools total; the 10 new ones need a CC restart.
> - **Wall CRUD: DEFERRED** to the Foundry in-app UI per owner decision (§6, Q1).
> - **Drawings / AmbientSounds / MeasuredTemplates: DROPPED** from the near-term plan (out of the focus set).

---

## 1. Executive summary

We keep a **discoverable, per-type tool surface** (`list-X` / `create-X` / `update-X` / `delete-X`,
mirroring the working Region family) and win DRY **below the schema** with one shared page-side CRUD
kernel plus one shared Node-side output formatter — so each per-type tool is a thin descriptor over
tested machinery, and the LLM still reads a hand-tuned zod schema as the documentation for each type.
A small **pure geometry layer** (promote `gridRectShape`, add `cellToPixel`/`pixelToCell` with an
explicit anchor, add `wallSegment`) becomes the one home for the padding-offset pixel math and the
point-vs-top-left-vs-segment anchor trap. `update-token` stays **bespoke** (its actor→all-copies
matching and the `lockRotation` auto-unlock gotcha do not fit a generic id-keyed patch), and
`create-teleporter` / `remap-teleporters` stay **named special ops outside** generic CRUD (they
cross-reference minted ids). New per-type tools are **gated on real demand** — Tiles first, then Walls
and Lights (highest live population), with Drawings / Sounds / MeasuredTemplates deferred — not a
speculative 9×4 matrix.

**The single most important decision:** _before any CRUD refactor, fix the confirmed live
`system.destinations` teleporter bug (§5.1)._ The code writes and reads `system.destination`
(singular) but Foundry v14 stores `system.destinations` (an array) — verified in the live world's
Bridge⇄Cave teleporter. New teleporters render (Foundry migrates the singular write into the array),
but every **read-back** and **remap** sees `undefined`, so `remap-teleporters` silently skips every
teleporter and `list-regions` reports no destination. Any refactor that carries the current
`dumpRegion`/`createSceneTeleporter`/`remapSceneTeleporters` helpers "unchanged" would fossilize this
bug into the shared core. Fix it first, as its own Phase 0.

---

## 2. Current state

### 2.1 Coverage matrix (what exists today)

Nine v14 placeable types. Coverage is **sporadic** — each existing write path was hand-rolled for the
one feature that needed it (map notes for legend pins, tokens for the corpse-rotation dogfood, regions
for teleporters).

| Placeable (`docName`) | Create | Read / List | Update | Delete | Where |
| --- | :---: | :---: | :---: | :---: | --- |
| **Region** | ✅ `create-region` | ✅ `list-regions` | ✅ `update-region` | ✅ `delete-region` | full family + `create-teleporter` / `remap-teleporters` |
| **Note** | ✅ `create-scene-notes` | ⚠️ counts only¹ | ✅ `update-note` | ✅ `delete-note` | legend→pins pipeline |
| **Token** | ➖ by design² | ⚠️ counts only¹ | ✅ `update-token` | ➖ by design² | placed-token editing |
| **Wall** | ⚠️ import-only³ | ⚠️ count only¹ | ❌ | ❌ | `create-scene` sidecar (`sidecarWallToV14`) |
| **AmbientLight** | ⚠️ import-only³ | ⚠️ count only¹ | ❌ | ❌ | `create-scene` sidecar (`sidecarLightToV14`) |
| **Tile** | ❌ | ❌ | ❌ | ❌ | — (40 live tiles, no tooling) |
| **AmbientSound** | ❌ | ⚠️ count only¹ | ❌ | ❌ | — (no read past a count) |
| **Drawing** | ❌ | ❌ | ❌ | ❌ | — |
| **MeasuredTemplate** | ❌ | ❌ | ❌ | ❌ | — (Phase-2 combat) |

¹ `get-current-scene` returns `walls.size` / `lights.size` / `sounds.size` and dumps only tokens +
notes shallowly. There is **no per-placeable read** for anything but Region (`list-regions` +
`dumpRegion`). ² Tokens are created by dragging an actor / `create-actor-from-compendium`; their
lifecycle is the actor's, so no `create-token` / `delete-token`. ³ Walls/lights are created only inside
`create-scene`'s `importScenePlaceables`, never on an existing scene.

### 2.2 The core problem

- **Duplication.** `createSceneRegions`, `createSceneNotes`, `deleteSceneNotes`, `deleteSceneRegions`,
  and `updateSceneTokens` each re-implement the identical skeleton: `resolveSceneStrict` →
  short-circuit `{notFound}` → per-item build/validate → one `scene.{create,update,delete}EmbeddedDocuments(docName, …)`
  → per-item error isolation → a `{sceneId, sceneName, created/updated/deleted, …, warnings}` shape.
  The delete partition (`present` vs `notFoundIds`) is copy-pasted verbatim between notes and regions.
  The Node handlers (`handleCreateRegion` / `handleListRegions` / …) duplicate the same
  `notFound` / "Created N …" / "⚠ warnings" string shaping.
- **Inconsistency.** Only Region has a read/inspect tool. You cannot get a Tile's or Light's id +
  current fields to edit them — so the "edit a tile's scale" need is unreachable today even in principle.
- **A latent correctness bug** rides in the least-touched corner: the teleporter destinations drift
  (§5.1), masked on create by Foundry's migration and never caught because the 17/17 live-verify only
  exercised **create**.
- **`src/tools/scene.ts` is ~1376 lines.** Adding per-type tools inline would push it past readable.

---

## 3. The conformed architecture

### 3.1 The DRY-vs-discoverable decision (stated explicitly)

> **Decision: keep the tool surface per-type; win DRY strictly below the zod schema.**

We reject a single polymorphic `manage-placeable(docType, op, …)` / `update-placeable` mega-tool. For
an **LLM caller**, the per-type zod schema *is* the documentation — `create-tile`'s fields
(`texture`, `width`, `height`, `occlusionMode`, …) tell the model exactly what a Tile accepts, which a
`type`-discriminated passthrough patch cannot. A discriminated mega-tool also splits token mutation
across two tools (`update-token` vs a token-rejecting generic) and forces the engine to grow a
type-specific branch for the first hard type. The repeated **skeleton**, however, is real and belongs
in exactly one place. So:

- **Discoverable at the top** — per-type tools with hand-tuned schemas (the seam the LLM reads).
- **DRY underneath** — a shared page-side kernel + a shared Node formatter (the seam the maintainer
  reads). The boundary sits precisely at Foundry's `createEmbeddedDocuments(docName, …)` call:
  everything type-**agnostic** (resolve / isolate / batch / partition / shape) is written once;
  everything type-**specific** (field paths, legacy→v14 normalization, name→id resolution, the correct
  anchor) is a small per-type descriptor.

This fits the existing **4-layer seam** (`tools/*` → `foundry.call` → `page/*` → `registry`) with
**zero new dispatch indirection**: each placeable page function stays its own `PageApi` key
(`createSceneTiles`, `listSceneTiles`, …), typed across the bridge exactly like today's
`createSceneRegions`.

### 3.2 Layer 1 — page-side geometry (`src/page/placeable-geometry.ts`, new, pure)

The one home for coordinate math, separately unit-tested (`placeable-geometry.test.ts`). Foundry insets
the background inside a padding border, so a placeable's canvas pixel is **not** `gridCell * size` —
it is offset by `sceneX`/`sceneY` (already surfaced by `getSceneDimensions`). Each type hard-codes its
correct **anchor** so a caller can never pick the wrong corner.

```ts
export interface SceneGeo { size: number; sceneX: number; sceneY: number;
                            distance: number; rows?: number; columns?: number; }

// Promote the private sceneGrid() in scenes.ts; read the padded-canvas offset in ONE place.
export function sceneGeo(scene: any): SceneGeo;

// Padding-aware conversions. anchor selects the corner: point-CENTER (Token/Light/Note/Sound)
// vs TOP-LEFT (Tile / Region-rect). This is the highest-frequency authoring bug — kill it here.
export function cellToPixel(geo: SceneGeo, col: number, row: number,
                            opts?: { anchor?: 'topLeft' | 'center' }): { x: number; y: number };
export function pixelToCell(geo: SceneGeo, x: number, y: number): { col: number; row: number };

// MOVE the existing gridRectShape here (currently private in scenes.ts) so region + tile +
// template + drawing rect authoring share ONE snap implementation. Signature unchanged.
export function gridRectShape(geo: SceneGeo, centerX: number, centerY: number,
                              wCells: number, hCells: number, snap: boolean): Record<string, unknown>;

// Wall is the only SEGMENT-coordinate type. Normalize {x0,y0,x1,y1} | {c:[…]} → [x0,y0,x1,y1].
export function wallSegment(input: { x0?: number; y0?: number; x1?: number; y1?: number;
                                     c?: number[] }): [number, number, number, number] | null;
```

### 3.3 Layer 2 — page-side CRUD kernel (`src/page/_placeables.ts`, new)

The DRY seam. A tiny kernel parameterized by a per-type **descriptor**. Descriptors are **opt-in**: a
type that does not fit (Token) simply stays a bespoke function — the kernel never grows a
type-specific branch.

```ts
export interface SceneCtx { scene: any; geo: SceneGeo; }

export interface PlaceableDescriptor<TCreate, TPatch> {
  docName: 'Tile' | 'Wall' | 'AmbientLight' | 'AmbientSound' | 'Note'
         | 'Region' | 'Drawing' | 'MeasuredTemplate';
  collection: (scene: any) => any;                 // s => s.tiles, s => s.walls, …
  // async-capable: Note icon 404 probe / journal name→id resolution live INSIDE the descriptor.
  toCreateDoc: (input: TCreate, ctx: SceneCtx) => Promise<{ doc?: Record<string, unknown>;
                                                            error?: string; warnings?: string[] }>;
  buildPatch:  (existing: any, patch: TPatch, ctx: SceneCtx) => { patch?: Record<string, unknown>;
                                                                  warnings?: string[]; changed: boolean };
  dump: (doc: any) => Record<string, unknown>;     // read-back serializer (like dumpRegion)
}

// The four ops — each resolves the scene strict, short-circuits {notFound}, batches ONE Foundry call.
export function crudCreate<C, P>(desc: PlaceableDescriptor<C, P>, args: { sceneIdentifier: string; items: C[] }): Promise<CrudCreateResult>;
export function crudList  <C, P>(desc: PlaceableDescriptor<C, P>, args: { sceneIdentifier: string }): Promise<CrudListResult>;
export function crudUpdate<C, P>(desc: PlaceableDescriptor<C, P>, args: { sceneIdentifier: string; patches: Array<{ id: string } & P> }): Promise<CrudUpdateResult>;
export function crudDelete<C, P>(desc: PlaceableDescriptor<C, P>, args: { sceneIdentifier: string; ids: string[] }): Promise<CrudDeleteResult>;
```

Kernel behavior, written **once**:

- **create** — map `items` → `toCreateDoc` (per-item try/catch isolation into `errors[]`, aggregate
  `warnings[]`), then **one** `scene.createEmbeddedDocuments(docName, goodDocs)`; return created count
  + `dump()` of the made docs. (Mirrors `importScenePlaceables` / `createSceneNotes`.)
- **update** — for each patch resolve `collection.get(id)`, run `buildPatch`, keep only `changed`
  patches. **Validate/normalize every patch first, drop-and-report the bad ones, then batch the good
  ones in one call** — because `updateEmbeddedDocuments` is all-or-nothing per Foundry call (one
  malformed patch rejects the whole batch), unlike per-item create isolation.
- **delete** — partition `ids` into `present` vs `notFoundIds` against `collection(scene)`, one
  `scene.deleteEmbeddedDocuments(docName, present)`. (Lifts the notes/regions partition verbatim.)
- **list** — `collection(scene).map(dump)`; ids + bounds + salient fields only (never whole documents —
  a 645-wall list must stay under the MCP response cap).

The existing pure helpers move **unchanged** into the descriptors that use them (tests follow the
move): `sidecarWallToV14` + `countWallsMissingSight` → Wall descriptor; `sidecarLightToV14` → Light
descriptor; `resolveNoteTarget` + the SUBSTITUTE-BY-DROP icon policy → Note descriptor;
`buildTokenUpdate` stays where it is (Token is bespoke). The engine adds **zero** new correctness
surface — it only removes the copied skeleton.

### 3.4 Layer 3 — Node output formatter (`src/utils/placeable-format.ts`, new)

The four string renderers the Region handlers duplicate today, lifted verbatim so a new type's four
handlers become one-liners:

```ts
export function formatCreatePlaceables(result: CrudCreateResult, noun: string): string; // "Created N tile(s) on "Scene" (id)\n  • id — name"
export function formatListPlaceables (result: CrudListResult,   noun: string): any;     // passthrough | "Scene not found"
export function formatUpdatePlaceable(result: CrudUpdateResult, noun: string): string;  // "Updated <id> on …" | "not found"
export function formatDeletePlaceables(result: CrudDeleteResult, noun: string): string; // reuses the notFoundIds tail idiom
```

### 3.5 Layer 4 — Node per-type tools (`src/tools/placeables/*.ts`, new; split out of `scene.ts`)

Each type is one file: a hand-tuned hoisted zod schema (composed from a shared `sceneTarget` base) +
four thin handlers. Placeable tools **move out of** the already-1376-line `scene.ts`; scene-**document**
tools stay in `scene.ts`. `SceneTools` and the new `PlaceableTools` share the same `foundry` bridge
(same constructor deps), registered in `registry.ts` exactly like the existing families.

```ts
// src/tools/placeables/_base.ts
export const sceneTarget = z.object({ sceneIdentifier: z.string().min(1) });

// src/tools/placeables/tile.ts  (the worked example)
export const CreateTilesSchema = z.object({
  sceneIdentifier: z.string().min(1),
  tiles: z.array(z.object({
    texture: z.object({ src: z.string(), tint: z.string().optional(), /* … */ }),
    x: z.number(), y: z.number(), width: z.number(), height: z.number(),
    rotation: z.number().optional(), alpha: z.number().optional(),
    elevation: z.number().optional(), sort: z.number().optional(),
    occlusionMode: z.number().optional(), hidden: z.boolean().optional(), locked: z.boolean().optional(),
  })).min(1),
});
// handler: parse → foundry.call('createSceneTiles', args) → formatCreatePlaceables(r, 'tile')
```

### 3.6 Adding a new placeable type — the ≤5-step recipe

Once the kernel + geometry + formatter exist, a new type is a **descriptor + a schema fragment**:

1. **Descriptor** (`src/page/_placeables.ts` or `src/page/placeables/<type>.ts`) — `docName`,
   `collection`, `toCreateDoc`, `buildPatch`, `dump`. ~40 lines; reuse a geometry anchor + `textureData`.
2. **Page functions** — four thin wrappers (`createSceneXs` / `listSceneXs` / `updateSceneX` /
   `deleteSceneXs`) each `return crud*(descriptor, args)`; register in `src/page/index.ts` `api`.
3. **Node schemas + handlers** (`src/tools/placeables/<type>.ts`) — hoisted zod per op + four handlers
   over `foundry.call` + `formatCreatePlaceables`/etc.
4. **Registry** — four `name → handler` lines in `src/registry.ts`; add the tool defs to `defByName`.
5. **Verify** — a `verify-*.mjs` script runs it against the live world via a fresh `dist/` **before** it
   is relied on over MCP; then a CC restart advertises it.

No skill re-derives a field path; the descriptor owns every one.

---

## 4. Separation of concerns

### 4.1 Scene-document editing vs placeable editing (a hard split, preserved)

Two orthogonal axes. `update-scene` is documented as **"Scene-document only; never touches
placeables"** and that invariant stays load-bearing:

- **Scene-document tools** (`create-scene` / `update-scene` / `delete-scene` / `list-scenes` /
  `get-scene-dimensions` / `get-current-scene` / `screenshot-scene`) mutate the Scene's own fields —
  background, grid, lighting/fog knobs, weather, playlist/journal links. They carry their own
  image-probe / weather-registry / link-resolve concerns and stay in `src/tools/scene.ts`. They are
  **not** folded into the placeable engine. **But `update-scene` is not yet at parity with
  `create-scene`** for scene-document editing — see §4.4, which is the direct answer to the "edit scene
  information directly" half of this work.
- **Placeable tools** mutate only embedded collections (`scene.tiles`, `scene.walls`, …). The kernel
  **only ever** calls `scene.{create,update,delete}EmbeddedDocuments` — **never** `scene.update()` — so
  a placeable edit can never clobber scene mood. Example the split guards: a scene's
  `environment.darknessLevel` is a scene-document field (→ `update-scene`); an individual
  `AmbientLight.config.dim` is a placeable field (→ `update-light`).

### 4.2 Tool vs skill vs leave-to-Foundry-UI

Per design.md §2.1, everything **deterministic** is a tool: pixel↔cell conversion, the padding offset,
wall-segment normalization, `TextureData` shaping, restriction-enum mapping, the destinations array,
name→id resolution, per-item error isolation, the `lockRotation` gotcha. The **skill**
(`scene-builder`, `tom-cartos-import`, and a future Phase-2 session skill) owns judgment: *which*
placeable to author, *where* conceptually, the compose order, house rules ("corpses get randomized
rotation"). Cell-based convenience inputs (`widthCells`, `snapToGrid`, `cell:{col,row}`) live in the
**tool** schema — the conversion is deterministic, so the skill speaks in grid terms and the tool does
the math.

A third bucket the altitude analysis is right about: **leave-to-Foundry-UI.** The bridge is always GM
and a human is at the table; Foundry's in-app tools already do free-form placeable authoring (drag a
wall, drop a light, draw a region) better than any headless tool. We build a tool only where an
agent/skill genuinely needs deterministic, **batch**, or **judgment-driven** mutation — which is why
new type tools are demand-gated (§6), not filled into a symmetric 9×4 matrix.

### 4.3 The read/inspect layer (the missing prerequisite)

> **You MUST inspect a placeable to get its id + current fields before you can edit or delete it.**
> Today only Region has this (`list-regions` + `dumpRegion`).

This is why every new type ships its `list-X` **first-class**, not as an afterthought: the update/delete
loop is impossible without it. `list-X` returns ids + bounds + salient fields (via each descriptor's
`dump`), never whole documents — response-cap safe on high-population scenes. Bulk placement (import)
stays on the server-side file channel `create-scene` already uses; it never round-trips whole documents
through the agent. This read layer is also exactly what the Phase-2 DM-session skill will lean on to
reason about "what is on this map."

### 4.4 Scene-document editing gap — `update-scene` ⊂ `create-scene`

The user's first ask ("more ability to edit scene information directly") is a real gap **independent of
placeables**: `create-scene` accepts richer scene-document inputs than `update-scene` can edit back.
Verified against `src/tools/scene.ts` (`CreateSceneSchema` vs `UpdateSceneSchema`, which share only
`sceneCommonFields`):

| Scene-document field | `create-scene` | `update-scene` | Note |
| --- | :---: | :---: | --- |
| name, grid (size/type/dist/units/color/alpha), padding, tokenVision, fogMode, weather, playlist, journal, thumb, navigation, backgroundPath, width/height | ✅ | ✅ | at parity |
| `darkness` / `globalLight` (flat scalar knobs → `environment.darknessLevel` / `environment.globalLight.enabled`) | ✅ | ✅ | flat knobs only |
| **`environment{}`** full mood object (base/dark hue, luminosity, cycle) | ✅ | ❌ | create-only |
| **`fog{}`** full object (colors, overlay) | ✅ | ❌ | create-only |
| **`initial{}`** saved camera (x, y, scale) | ✅ | ❌ | create-only |
| **`flags`** (provenance/dedup, e.g. `tom-cartos-import`) | ✅ | ❌ | create-only |

The flat `darkness`/`globalLight`/`fogMode` knobs cover the common "make it night / turn the lights on"
cases, so this is a **completeness gap, not a blocker** — but "re-point the saved camera," "re-stamp a
provenance flag," or "apply a full authored day/night mood to an existing scene" are all currently
impossible without a delete-and-recreate. The clean fix is to lift `environment` / `fog` / `initial` /
`flags` from `CreateSceneSchema` into a **shared scene-field base** both schemas compose (the same
`sceneCommonFields` pattern already used), so the two can't drift again. The page-side `updateScene`
already deep-merges `environment`/`fog`/`initial` on create — the merge helper is reusable as-is. This
is small, orthogonal to the placeable work, and belongs in Phase 0/1 (see §6). It is **not** a reason to
fuse scene-document and placeable editing — the §4.1 split holds.

---

## 5. Correctness traps (per-placeable gotchas)

These are the schema traps a naive generic engine silently corrupts. Each descriptor **owns** its
nested paths, anchor, and asset policy; the kernel never sees them.

### 5.1 🔴 Teleporter `system.destinations` — a CONFIRMED LIVE BUG, fix now

**Diagnosis (verified in code + live schema):**

- Code writes/reads **`system.destination`** (singular): `createSceneTeleporter` (`scenes.ts:1196,1204`),
  `dumpRegion` (`scenes.ts:1084`), `remapSceneTeleporters` (`scenes.ts:1899` read, `:1904` write).
- Live v14 stores **`system.destinations`** (an **array**): `scratch-placeables-schema.json:31997`,
  `:32046` — from the world's real Bridge⇄Cave teleporter, `["Scene.9Z9…Region.joR…"]`.
- Foundry migrates the singular **create-write** into the array, so new teleporters *render* and the
  17/17 live-verify passed — a **false negative** (it only tested create). But every **read** sees
  `undefined`: `list-regions` reports no destination, and `remap-teleporters` treats every teleporter as
  no-match and **silently skips it** — a re-import remap is a no-op that leaves stale cross-scene UUIDs.

**Fix (Phase 0, standalone, before any CRUD work):**

- `createSceneTeleporter` writes `system: { destinations: [uuid], choice: false }` (array).
- `dumpRegion` reads `b.system?.destinations?.[0] ?? b.system?.destination` (tolerate the singular on
  read for pre-migration data); surface **all** destinations, not just `[0]` (the field is genuinely
  plural — `choice:true` multi-dest teleporters exist).
- `remapSceneTeleporters` reads `behavior.system.destinations` (falling back to singular), maps each
  entry via a `remapTeleportDestinations` array wrapper around the existing pure
  `remapTeleportDestination`, and writes back the **array**.
- The `create-teleporter` Node output reader reads `.destinations?.[0]`.
- Add a regression test asserting a created teleporter's `destinations[0]` round-trips and that remap
  rewrites an array-shaped destination. Live-verify against the existing Bridge⇄Cave teleporter that
  remap is no longer a no-op.

This is a **tool-correctness bug fixed in the tool** (design.md §2.1). It must land regardless of which
CRUD shape wins — and it must land **before** the kernel absorbs `dumpRegion`, or the shared read
inherits the singular bug.

> **✅ Landed + live-verified (2026-07-02).** Fixing this surfaced **two further live bugs** that the
> create-only 17/17 verify never exercised:
> 1. **`destinations` is a `SetField`** — the live model value is a **`Set`**, not an Array (it's a
>    plain array only via `toObject()`). A read that only checks `Array.isArray` misses it. The
>    normalization now lives in one pure helper `teleportDestinationsOf(system)` that accepts a Set, an
>    Array, or the legacy singular. **Lesson for the kernel:** every descriptor `dump()` that reads a
>    collection-shaped field must tolerate the live `Set`, not just the `toObject()` array.
> 2. **`remap-teleporters` threw, so it never ran.** `flagOf` fell back to `doc.getFlag('tom-cartos-import', …)`,
>    which **throws** ("Flag scope … is not valid or not currently active") for any document lacking the
>    flag when the scope is not a registered module — and the filter runs over *every* scene in the
>    world (the live world's hand-made "Greenrest" scene has no such flag). Now a direct
>    `doc.flags?.[scope]?.[key]` read (safe, sufficient — the import stamps flags there verbatim).
>
> Fixes: `teleportDestinationsOf` + `dumpRegion` + `createSceneTeleporter` + `remapSceneTeleporters` +
> `flagOf` in `src/page/scenes.ts`; the `handleCreateTeleporter` reader + schema descriptions in
> `src/tools/scene.ts`; unit tests in `scenes.test.ts`/`scene.test.ts`; live proof in
> `scripts/verify-teleporter-scene-fields.mjs` (11/11).

### 5.2 Per-placeable trap table

| Placeable | Trap | Owned by / how |
| --- | --- | --- |
| **Region** (teleporter) | `behaviors[]` are embedded sub-docs; a teleport `destination` is a UUID cross-referencing another **minted** region id. A generic "replace behaviors whole" on update orphans the cross-link. | Region `buildPatch` **omits `behaviors`** by default (matches today's `updateSceneRegion`). Add a test asserting `update-region` never emits a `behaviors` key. Teleporter creation + remap stay **named special ops** outside CRUD. |
| **Region** (delete) | Deleting one endpoint orphans the OTHER end's destination (now points at a dead id). | Region `crudDelete` runs a post-delete scan (reuse the destinations parser) and **warns** on any surviving `teleportToken` destination pointing at a just-deleted region id. |
| **Wall** | Position is a **segment** `c:[x0,y0,x1,y1]`, not a point — breaks any generic x/y/rotation patch. Legacy↔v14 restriction enums; the silent sight-default trap (a wall with no `sight` blocks LoS). | Wall descriptor uses `wallSegment()` for coords + `sidecarWallToV14` + `countWallsMissingSight` as a create-time warning. Wall's patchable set is `{c, move, sight, light, sound, door, ds, dir}` — **no** x/y/rotation/scale. |
| **Tile** | Scale is **`width`/`height`** in pixels — **NOT** `texture.scaleX` (that is the Token idiom; copying it silently no-ops a tile resize). `x`/`y` are padding-offset absolute px. Deep nested models: `occlusionMode`, `video{loop,autoplay,volume}`, `texture` TextureData. `occlusionMode` may be a `SetField` needing coercion. | Tile descriptor sizes via `width`/`height`; `x`/`y` via `cellToPixel(anchor:'topLeft')`; nested paths owned explicitly; **live-probe the occlusion Set coercion before building** (the dump shows an array; the live model may be a Set). |
| **AmbientLight** | Emission + animation nest under **`config{}`** (`config.dim`, `config.animation.type`). A flat top-level `dim` on update silently no-ops. | Light descriptor's `buildPatch` writes `config.*` dot-paths; `toCreateDoc` reuses `sidecarLightToV14`. |
| **AmbientSound** | `path` is a `FilePath` that may 404; `radius` units (px vs cells) are ambiguous; effects nest under `effects{base,muffled}`. | Sound descriptor runs `path` through `normalizeAssetPath` + KEEP+WARN; radius resolved via the geometry layer if given in cells; effects owned explicitly. |
| **Note** | `entryId`/`pageId` are **strict** name→id resolutions (ambiguity throws) and the icon probe is **async**; icon 404 → drop-and-warn (fall back to default pin). | Note descriptor's `toCreateDoc`/`buildPatch` are **async** (the descriptor interface is async — this is why); wrap the existing `resolveNoteTarget` + SUBSTITUTE-BY-DROP policy. |
| **Token** | Actor-linked placed instance (`actorLink`/`delta`/`prototypeToken`); targeting is `actorId → ALL copies` OR `tokenId`; the `lockRotation` auto-unlock gotcha; scale IS `texture.scaleX/Y`. Writes must hit the scene `TokenDocument`, never `actor.prototypeToken`. | **Bespoke** `update-token` (kept as-is). The generic `list`/`get` MAY read tokens; **mutation routes through `update-token`**. No `create-token`/`delete-token` in the authoring phase. |
| **Drawing** | `shape.points[]` are **relative to** the drawing's `x`/`y` origin; `shape` is a nested SchemaField. | Drawing descriptor models `shape{type,points[]}` explicitly; shares `gridRectShape` for rect drawings. Deferred (§6). |
| **MeasuredTemplate** | `distance` is in **grid-distance units (feet)**, not pixels — a caller passing `100` (px) instead of `20` (ft) gets a 5×-too-big template. Center `x`/`y` is padding-offset px. | Template descriptor converts `distance` via the geometry layer's `distance`. Deferred to Phase 2 (combat). |

### 5.3 Cross-cutting invariants (apply to every type)

- **Absolute-canvas-pixel + padding offset.** A placeable pixel is offset by `sceneX`/`sceneY`; all
  cell↔px conversion goes through the one `cellToPixel`, and a "nudge N px" operates on the already-
  absolute stored value.
- **Coordinate anchor varies by type** — center (Token/Light/Note/Sound), top-left (Tile/Region-rect),
  segment (Wall), relative-origin (Drawing). Each descriptor hard-codes its anchor; a generic x/y patch
  must never guess.
- **Nested writes via dot-paths.** Light `config.*`, Tile `texture.*`/`occlusion.*`/`video.*`. A flat
  field silently no-ops; the descriptor owns the nesting.
- **Update batch is all-or-nothing.** Validate + drop-and-report per patch **before** the single
  `updateEmbeddedDocuments` call (create isolates per-item; update does not).
- **Asset 404 policy diverges by type** — KEEP+WARN for a tile/background (no substitute) vs
  SUBSTITUTE-BY-DROP for a Note icon (default pin). The per-type descriptor picks its policy via
  `badAssetWarning(…, drop?)`.

---

## 6. Roadmap

Phased and **ranked by real demand / live population**, not matrix symmetry. Each new tool needs a
**CC restart** to be callable over MCP (a `verify-*.mjs` script exercises it via a fresh `dist/`
first). Every phase is behavior-preserving behind the existing tests + the 17/17 live-region checks.

### Phase 0 — Teleporter destinations fix (✅ DONE, live-verified)

- **Fixed** `teleportDestinationsOf` (new pure Set/Array/singular normalizer), `dumpRegion`,
  `createSceneTeleporter`, `remapSceneTeleporters`, `flagOf` (the getFlag-throw), and the
  `create-teleporter` Node reader + schema descriptions (§5.1).
- **Tests** — `teleportDestinationsOf` unit tests incl. the Set case; create-teleporter mocks updated.
- **Live-verified** — `scripts/verify-teleporter-scene-fields.mjs`, 11/11: create writes the Set, and
  remap now actually rewrites (2 destinations, 0 unresolved).
- **Landed:** no new tool (rebuild only, no CC restart).

### Phase 0b — `update-scene` parity with `create-scene` (✅ DONE, live-verified)

- **Landed:** `environment` / `fog` / `initial` / `flags` lifted into a shared `sceneMoodFields` base
  both `CreateSceneSchema` and `UpdateSceneSchema` compose (they can't drift). Page-side `updateScene`
  deep-merges them via a new `applyMoodMerge` helper that expands the flat dot-paths first so a whole
  `environment` object and a `darkness`→`environment.darknessLevel` dot-path can't collide (§4.4).
- **Tests** — Node forwarding test in `scene.test.ts`; live proof (deep-merge layering, camera
  round-trip, flag stamp) in `verify-teleporter-scene-fields.mjs`. No new tool (schema-only, no restart).

### Phase 1 — Extract the shared core (✅ DONE — kernel + formatter shipped; Region/Note retrofit deferred)

- Add `src/page/placeable-geometry.ts` (promote `sceneGrid`→`sceneGeo`, move `gridRectShape`, add
  `cellToPixel`/`pixelToCell`/`wallSegment`) + `placeable-geometry.test.ts`.
- Add `src/page/_placeables.ts` (kernel + `PlaceableDescriptor`) and `src/utils/placeable-format.ts`
  (the four formatters lifted from `scene.ts`).
- **Retrofit** Region + Note page fns + handlers onto the kernel behind their **unchanged** tool
  names/schemas/output; move their pure helpers into descriptors; keep `scenes.test.ts` green as the
  acceptance gate. Refactor `importScenePlaceables` to call the **same** Wall/Light/Region descriptor
  normalizers so import and standalone-create can never drift.
- **Effort:** medium. **Restart:** none (pure internal refactor, no surface change). **Risk:** the
  region source-id↔create-doc alignment through the null filter — wrap-don't-rewrite, gate on tests.

### Phase 2 — Tile CRUD (✅ DONE, live-verified 16/16 — the cited "edit tile scale" need)

- `create-tiles` / `list-tiles` / `update-tiles` / `delete-tiles` — Tile descriptor (`width`/`height`
  sizing, `texture` TextureData, `occlusionMode` with the Set-coercion probe, KEEP+WARN on
  `texture.src` 404). Split placeable tools into `src/tools/placeables/*.ts` now (before the first new
  type) to keep `scene.ts` readable.
- Registry: four lines; `PageApi`: four exports. `scene-builder` / `tom-cartos-import` gain
  "place/scale a prop, roof, overlay, secret-door cover" guidance.
- **Rationale:** 40 live tiles, zero tooling, and "edit a tile's scale" is the literal cited need.
- **Effort:** medium. **Restart:** yes (four new tools).

### Phase 3 — AmbientLight CRUD (✅ DONE, live-verified — Walls DEFERRED to the Foundry UI)

> Also shipped in this focus set, not originally its own phase: read-only **list-tokens** and
> **list-notes** — the inspect layer that makes update-token and the note tools usable on any scene.


- **Walls: DEFERRED** (owner decision, Q1). Walls are drawn in-app or shipped by a pack; nobody
  hand-edits wall #438 through an agent. Not built now; revisit only if a real skill needs to
  programmatically add/edit walls. (The segment-coordinate outlier still gets `wallSegment()` in the
  geometry layer so the option stays cheap later.)
- **Lights:** `list-lights` / `create-lights` / `update-lights` / `delete-lights` — `config.*` nesting
  via the Light descriptor. (56 lights in the Silver Gauntlet Tavern; `sidecarLightToV14` already maps
  the v14 shape, so standalone create is nearly free once the kernel exists.)
- **Effort:** medium (Lights are the nested-`config` outlier). **Restart:** yes.

### Phase 4 — Drawing + AmbientSound (DROPPED from the near-term plan — outside the focus set)

- `create-drawings` / … (GM annotations, secret-area boxes) and `create-sounds` / … (positional audio,
  composes with `playlist-builder`). Build **only when a skill needs them** — the descriptor makes each
  a cheap add.
- **Effort:** small each. **Restart:** yes.

### Phase 5 — MeasuredTemplate (Phase-2 combat; deferred)

- `create-templates` / … for spell/ability AoE areas during live play. `distance` in grid units via the
  geometry layer. Belongs with §8 session assistance, not authoring — defer until Phase-2 work starts.
- Optional capstone: a unified `list-placeables` (counts + per-type summaries via each descriptor's
  `dump`) once every descriptor exists.
- **Effort:** small. **Restart:** yes.

---

## 7. Open questions for the user

1. ~~**Standalone Wall editing — build it, or lean on the Foundry UI?**~~ **RESOLVED (2026-07-02):
   defer to the Foundry UI.** Walls are drawn in-app / shipped by a pack; not built now. Revisit only
   if a real skill needs programmatic wall editing. (`wallSegment()` still lands in the geometry layer
   so the option stays cheap.)

2. **Should the geometry layer accept cell-based convenience inputs on create/update (e.g.
   `cell:{col,row}` + `widthCells`), or only absolute pixels?** Cell inputs make skills speak in grid
   terms (the tool does the padding-aware math), matching how `create-teleporter` already takes
   `widthCells`/`snapToGrid`. The cost is a wider schema per type. **Cell convenience everywhere, or
   pixels-only with cells reserved for rect-shaped types (Region/Tile/Drawing)?**

3. **The occlusion `SetField` coercion (Tile) is unverified** — the schema dump shows an array but the
   live model may be a `SetField` that a naive zod-array→assign fails to coerce. **Should Phase 2 open
   with a quick live probe** (dump a real Tile's `occlusionMode` through the bridge) before committing
   the Tile descriptor's shape, or proceed and fix on first live-verify?

4. **Multi-destination teleporters** — the fixed `destinations` array is genuinely plural (`choice:true`
   lets one region teleport to several). Our `create-teleporter` writes a single-element array. **Do you
   want `create-teleporter` (or a future tool) to support authoring multi-destination "choice"
   teleporters now**, or is 1:1 sufficient and we only make sure `dumpRegion` **reports** all
   destinations (so a hand-authored multi-dest isn't misread)?
