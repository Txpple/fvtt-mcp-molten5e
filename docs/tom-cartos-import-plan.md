# Tom Cartos scene-pack import — build plan

> **Status:** DESIGN COMPLETE; decisions locked 2026-06-28. **v1 = modern packs (M1–M4).**
> Authored from a 9-agent research-and-design workflow (run `wf_7d4ffc0d-b35`) whose findings were
> verified against the live repo and sharpened by an adversarial critique pass.

## Decisions locked (2026-06-28)

- **A — Pack reader backend:** **`foundryvtt-cli` child process** (`fvtt package unpack`). No native
  dependency in the server tree; covers **both** LevelDB (v11+) and NeDB (v10) packs — this also
  resolves DECISION B. `fvtt` is invoked off-line, Node-side, by the new `read-pack` tool.
- **B — NeDB backend:** subsumed by A (the cli unpacks NeDB too — no `@seald-io/nedb` needed).
- **v1 scope:** **modern packs first — M1–M4** (modern v13 LevelDB packs end-to-end, incl. teleporters
  + the optional legend→notes feature). Legacy v10/NeDB deferred to **M5**.
- **E — Legacy sample:** the user **has** a real v10-era NeDB Tom Cartos pack and will provide it when
  M5 is reached — validate the legacy branch against the real thing, not a hand-made fixture.
- **C — Asset home (default):** world-scoped `worlds/<world>/assets/tom-cartos/<module-id>/`.
- **D — ID strategy (default):** build create-then-rewrite first (always correct); add `keepId`
  threading as a zero-collision skip-optimization later.

> Per the plan's M0, the A/B reader-backend decision belongs in `design.md` as an architecture note
> when M1 work begins.

---

---

# Build Plan — `tom-cartos-import` skill

**Cross-version importer for Tom Cartos (and Tom-Cartos-shaped) Foundry scene-pack modules**

> Design-only. An engineer should be able to execute this top-to-bottom. Voice/structure match `scene-builder` / `stat-block-builder`; the split obeys design.md §2.1 ("skills decide, tools do") and §3 (the inputSchema contract). Current files of record: `src/tools/scene.ts` → `src/page/scenes.ts`; `src/tools/journal.ts` → `src/page/journals.ts`; `src/tools/asset-bridge.ts` → `src/page/assets.ts`; `src/tools/molten/index.ts` + `webdav.ts` + `dav-access.ts`; `src/page/_shared.ts` (`normalizeAssetPath`).
>
> **Three load-bearing premises were verified against the live repo before this plan and corrected versus the first draft:** (1) `classic-level` is **NOT** a project dependency — prod deps are exactly `@modelcontextprotocol/sdk`, `dotenv`, `zod` (`package.json:28-32`); adding it imports a native compiled toolchain — see **DECISION NEEDED A**. (2) `createScene` calls `SceneClass.create(sceneData)` with **no `keepId`** (`scenes.ts:392`) and regions are created via `createEmbeddedDocuments` **with no `keepId`** — so "Keep-IDs" is currently impossible and **remap is the always-path**, not a fallback (§2c, §3 Stage E, §6.2). (3) NeDB `.db` is **not** safely "newline-JSON" — it has an append log + `$$deleted` tombstones, needing a real datastore lib — see **DECISION NEEDED B**.

---

## 1. Skill identity

**Name:** `tom-cartos-import` (alias-friendly; the description triggers also catch generic "scene pack" language so it isn't Tom-Cartos-only in practice).

**`description` "use when" triggers** (front-matter, mirrors the scene-builder voice):

> Import a Tom-Cartos-style Foundry **scene-pack module** (a folder with a `module.json` and `packs/` compendiums) into the live world — across Foundry versions (older v10-era NeDB packs and newer v13-era LevelDB packs). Use when the user wants to "import a Tom Cartos pack", "install this map module", "bring this scene pack into my world", "import the dungeon/temple/keep module", "import a multi-level map with teleporters/stairs", "import a Foundry module's scenes", or points at a module folder / `module.json`. Detects the pack's Foundry era, extracts its scenes + walls + lights + regions + journals, uploads and re-points all its assets, recreates every scene faithfully (dimensions, grid, background-object, thumbnail, environment, fog), preserves cross-scene teleporter links, and optionally turns the numbered legend keys into clickable GM room-notes. The tools own correctness (extraction, upload, path rewrite, placeable/region/note creation, ID create-then-rewrite); this skill owns the judgment (era branch, variant selection, legend reading, naming/foldering, the opt-in gates).

**Purpose (one paragraph).** Tom Cartos sells battlemap *modules* — a `module.json` plus LevelDB/NeDB compendium packs holding fully-authored Foundry scenes (thousands of walls, hundreds of configured lights, cross-scene teleporter regions) and a journal of numbered legend keys, with every asset path module-relative and URL-encoded. The user wants those scenes **in their own world** without enabling Tom's module as a permanent dependency, and the packs span **two Foundry generations** whose on-disk shapes differ materially. This skill is the judgment layer that reads a pack folder, decides its era, drives a deterministic extract→upload→rewrite→recreate pipeline through the MCP tools, and faithfully reproduces each scene — placeables and teleporters intact — in the live Molten-hosted world.

**Compendium-first ethos — explicitly N/A here, by design.** Scenes/maps (like cards, playlists, audio) have **no premium-book compendium** to source from. This skill is the sanctioned **asset-driven** import exception — same class as `scene-builder` / `cards-builder` / `playlist-builder` — and does not violate the compendium-first rule. (Stated so a reviewer doesn't flag it.)

**How it fits "skills decide / tools do."** Reading a pack's *era* from ambiguous on-disk signals, choosing *which variants* to import (regular vs Night vs Clean), *reading the legend image with vision*, and *naming/foldering* scenes are all judgment — they live in the skill. Extraction (LevelDB/NeDB → docs), byte upload, **asset-path rewriting**, scene/placeable/region/journal/note creation, and cross-scene ID create-then-rewrite are deterministic and unit-testable — they live in tools. The skill never reconstructs a wall, light, or region field-by-field; it passes them **whole** through the tools, honoring the established `fix/scene-import-placeable-field-preservation` rule. (Note one boundary correction from the first draft: **asset-path rewriting moves OUT of the skill into a tool** — §6.11/§11 — so the skill only *chooses* the destination root, and the tool *applies* the rewrite.)

---

## 2. Version detection & branching

### 2a. Era taxonomy

Four load-bearing branch booleans, not four eras — but they cluster into named eras for readability:

| Era | Storage | Walls | Lights | Scene shape | Regions |
|---|---|---|---|---|---|
| **legacy (≤ v9)** | NeDB `.db` | `sense` (combined) | flat `tintColor`/`lightAnimation`/`dim` | `img` string, flat `gridType`/`darkness`/`globalLight` | none |
| **v10–v11 (mid)** | **NeDB `.db`** (v10) → **LevelDB dir** (v11) | split `sight`/`light`/`sound`/`move` | nested `config{}` (no `negative`/`priority`) | `background{}` object, `grid{}` object, **flat** `darkness`/`globalLight`/`fogExploration` | none |
| **modern (v12–v13)** — *the sample* | LevelDB dir | split, whole | `config{}` with `negative`/`priority` | `background{}`, `grid{}`, **`environment{}`**, **`fog{}`** objects | **present** (`teleportToken`) |

The four booleans the pipeline actually branches on (everything else is presentation):
1. **`storage`** ∈ `{nedb, leveldb}` — NeDB `.db` *file* vs LevelDB *directory*.
2. **`needsWallSenseTranslation`** — any wall carries a `sense` key (legacy ≤v9).
3. **`needsLightConfigNesting`** — any light has top-level `tintColor`/`lightAnimation`/flat `dim` and **no** `config{}` (v8-flat; defensive — unlikely in real Tom packs).
4. **`hasRegions`** — `scene.regions` non-empty (v12+).

Plus two scene-shape flags read per-field with fallback: `sceneBackgroundShape ∈ {object, imgString}` and `sceneEnvShape ∈ {environmentObject, flat}`.

### 2b. Detection algorithm (ordered cascade — trust field-shape over declared version)

Run as a tool (`read-pack`, §6.1) that returns a **branch descriptor**; the skill consumes it and confirms with the user before proceeding.

- **Step 0 — locate inputs.** Find `module.json` at the folder root; enumerate `packs[]`, resolve each `path`, record `type` (`Scene` / `JournalEntry` / other).
- **Step 1 — storage.** `path` ends `.db` and is a file ⇒ `nedb`. `path` is a directory with `CURRENT`+`MANIFEST-*`+`*.ldb`/`*.log`+`LOCK` ⇒ `leveldb`.
- **Step 2 — manifest era (declared, cheap, HINT-ONLY).** `minimumCoreVersion`/`compatibleCoreVersion` or top-level `name` (no `id`) ⇒ declaredEra ≤ v9. `compatibility{}` ⇒ read `verified` (fallback `minimum`) as `declaredCore`. **HARD RULE: manifest era is a hint only and NEVER gates the NeDB/`sense`-translation branch.** Tom re-verifies old packs forward (Ostenwold: `minimum:"0.6.6"`, `verified:"13"`), so manifest era and doc era routinely disagree by 6+ versions.
- **Step 3 — `_stats.coreVersion`.** Pull one sample Scene doc; `_stats.coreVersion` (added v10) is the strongest *declared* signal (sample: `13.351`). **Re-packers can strip `_stats` on any era — absence may NOT LOWER the resolved era. Only infer era *up* from positive field-shape signals (Step 4); never infer *down* from a missing `_stats`.**
- **Step 4 — field-shape sniff (AUTHORITATIVE tie-breaker; re-packed packs lie).** On one Scene + its first wall + first light: regions non-empty ⇒ v12+; `environment{}` ⇒ v12+, else `background.src` object ⇒ v10+, else `img` string ⇒ ≤v9; wall `sense` key ⇒ legacy-translate; light no-`config{}` flat ⇒ nest-translate; `config.negative`/`priority` ⇒ v12+.
- **Step 5 — resolve** `era` = max lower-bound across positive signals; reconcile per the matrix above.
- **Step 6 — emit descriptor:** `{ era, storage, needsWallSenseTranslation, needsLightConfigNesting, hasRegions, sceneBackgroundShape, sceneEnvShape, packs:[{name,type,path,storage}], source:{declaredCore, statsCoreVersion} }`. The sample resolves to `{era:"v12+", storage:"leveldb", needsWallSenseTranslation:false, needsLightConfigNesting:false, hasRegions:true, sceneBackgroundShape:"object", sceneEnvShape:"environmentObject"}`.

> **Edge case — LevelDB-but-pre-regions (real v11 / early-v12):** storage=leveldb, no regions, walls already split, lights already `config{}`, `background{}`+`grid{}` but **no** `environment{}`. This must resolve to **mid (v11)**, not v12. Guard: a stray `config.priority` from a re-pack must not by itself promote to v12 — require regions OR `environment{}` for the v12 label. And `buildSceneFields` must tolerate a scene that has **neither** flat `darkness` **nor** `environment{}` (read per-field with fallback, write nothing if absent).

### 2c. What each branch does differently

| Concern | legacy (≤v9) | mid (v10–v11) | modern (v12+) |
|---|---|---|---|
| **Pack read** | NeDB datastore lib (DECISION B) — read `.db` honoring append-log + tombstones | NeDB (v10) or LevelDB (v11) | LevelDB: unpack while unlocked (DECISION A) |
| **Walls** | translate `sense` → `{sight,light}` split (reuse `toV14WallRestriction` / `sidecarWallToV14` at `scenes.ts:110,135`), then pass whole | pass whole (already split) | pass whole |
| **Lights** | nest flat `tintColor→config.color`, `tintAlpha→config.alpha`, `lightAnimation→config.animation`, `dim/bright/angle/darkness→config.*` | pass `config{}` whole | pass `config{}` whole |
| **Scene background** | `img` string → write to `levels[].background.src` via existing `applySceneBackground` | `background{}` object → `.src` to level | same |
| **Scene grid** | flat `gridType`/`gridDistance` → map to `gridType`/`gridSize`/`gridDistance` params | `grid{}` object → unpack to params | same |
| **Scene mood** | flat `darkness`/`globalLight` → `darkness`/`globalLight` params | flat fields → params | read `environment{}`/`fog{}` **wholesale** via typed `.passthrough()` sidecar (§6.5) |
| **Regions/teleporters** | none — skip | none — skip | import + **create-then-rewrite** destination pass (§3 Stage E) |

The skill picks the branch from the descriptor; the tools execute the per-field translation deterministically. **Translation is the only sanctioned mutation** (per the import rule); everything else is whole-object passthrough.

---

## 3. The import pipeline — ordered stages

The skill orchestrates; each stage names the owning tool. Pre-flight: confirm the world is up (`start-session` if asleep — Molten cold-start ~25s) and check `list-scenes`/`list-journals` for a **prior import of this pack** — dedup on the **stamped flag** `flags["tom-cartos-import"].sourceModule`/`.sourceId` (§6 + finding #5), NOT on scene name (variant names like `01 Iris` are not unique across packs).

### Stage A — Detect + extract pack docs (TOOL: `read-pack`, §6.1)
Run `read-pack` on the folder. It returns the branch descriptor **and** the extracted, era-normalized docs: scenes (each with `walls[]`, `lights[]`, `regions[]`, `background`, `thumb`, `grid`, `padding`, `environment`/flat-mood, `fog`, `initial`, original `_id`), and journal entries (each with pages, `src` for image pages). All module-relative `src` values are surfaced verbatim (still `%20`-encoded, still `modules/<id>/...`), each paired with a **decoded local-disk path** resolved against the folder for upload, **and a `rewriteHint`** (the rewritten Data-relative path, computed by the tool given the dest root the skill passes — see §6.11). The skill never touches LevelDB/NeDB directly — this is the one extraction tool.

### Stage B — Upload assets + rewrite all module-relative %20 paths (TOOL: `upload-asset` looped by skill; rewrite by `read-pack`/§6.11)
- **Enumerate** every distinct asset the docs reference: map backgrounds (`images/maps/*.webp`), legend keys (`images/*_Key.webp`), scene **thumbnails** (`assets/scenes/<id>-thumb.webp`), and any tile/sound `src` (rare; tolerate). Drive off the **docs**, not the directory listing (orphan thumbs exist — sample has 8 thumbs for 7 scenes; ignore unreferenced files).
- **Decode `%20`→space** (and `%27`/`%28`/`%29` — apostrophes/parens like "Gilmore's Glorious Goods") before calling `upload-asset` (the WebDAV client re-encodes per-segment; passing `%20` would double-encode to `%2520` — asset finding §3). Use literal-space Data-relative paths end-to-end. **Confirm `normalizeAssetPath`'s `decodeURI` and `encodePath` round-trip `%27`/`%28`/`%29` symmetrically; add to the round-trip test (§8 risks).**
- Choose a destination root: **`worlds/<world>/assets/tom-cartos/<module-id>/`** (mirror the module's `images/`, `images/maps/`, `assets/scenes/` subtree). Per-`<module-id>` namespacing prevents cross-pack filename collision (`TC_..._Key.webp`, generic `<id>-thumb.webp`) **because the rewrite map keys on the full module-relative path**. `upload-asset` auto-creates parents; pass `overwrite:true` for re-runnable uploads. **(DECISION NEEDED C — asset home.)**
- **The rewrite is a TOOL, not skill string-surgery.** `read-pack` emits a `rewriteHint` per asset (original `src` → `<dest-root>/<rel>`, decoded) so the create tools receive **already-correct** Data-relative paths in `background.src`, `thumb`, journal page `src`, tile/sound `src`. No `relink-asset` on a clean import (relink is repair-only). Thumbnails are uploaded **and** wired (via the new `thumb` param §6.3) — but note Foundry may regenerate the thumb on the first in-app edit; the shipped thumb is a nice-to-have, not load-bearing (§6.3 caveat).

> **Gap note:** `upload-asset` is one-file-only. The loop lives in the **skill** (keeps "tools do, skills decide"); a batch `upload-asset-tree` is an optional future tool (§6.10), not required for v1.

### Stage C — Create scenes (TOOL: `create-scene`, extended §6.3/§6.5)
For each scene to import (variant filter from Stage G), one `create-scene`/batch call with the **exact** pack geometry so canvas-pixel placeables stay aligned (auto-size is **disabled** when you pass dims — and you MUST here):
`name`, `backgroundPath` (rewritten), `width`/`height` (4760×3080), `gridSize`/`gridType`/`gridDistance`/`gridUnits` (140/1/5/ft), `padding` (0.25), `thumb` (**new param** §6.3, rewritten thumbnail path), plus mood from the branch: modern → `environment`/`fog` typed-passthrough sidecars (§6.5); mid/legacy → `darkness`/`globalLight`/`fogMode`. Also stamp `flags["tom-cartos-import"]={sourceModule, sourceId}` (§6.2) for dedup/resume. Walls + lights ride along in the **same call** (Stage D) since `create-scene` places them at create time only.

### Stage D — Import walls + lights WHOLE (TOOL: `create-scene` `walls`/`lights` sidecars)
Pass each scene's `walls[]` and `lights[]` arrays **verbatim** into the same call. The existing `SidecarWallSchema` (`.passthrough()`, `scene.ts:86`) + `sidecarWallToV14` and `SidecarLightSchema` + `sidecarLightToV14` already (a) pass modern split walls / `config{}` lights through whole and (b) translate legacy `sense`/flat-light when present — so **no new wall/light code is needed**; the skill just must not cherry-pick fields (the scene-builder cautionary tale: dropped `sight` → solid silhouettes; dropped `config` → blown-out lights). Per-kind error isolation already returns counts + `placeableErrors[]`.

### Stage E — Teleporters / regions + cross-scene destination rewrite (TOOL: new region import + `create-scenes` batch, §6.2/§6.4) — **modern only**
This is the hardest stage and the riskiest tool in the repo. **The critique correctly demolished the draft's "Keep-IDs is the path, remap is the fallback" framing — the current code makes Keep-IDs impossible, so create-then-rewrite is the ALWAYS path:**

- **Why remap is mandatory, not optional:** `createScene` calls `SceneClass.create(sceneData)` with **no `{keepId:true}`** (`scenes.ts:392`) → fresh scene ID. Regions are created by `createEmbeddedDocuments` *after* the scene exists, **also with no `keepId`** → fresh region IDs. So **both** ids in `system.destination = "Scene.<sceneId>.Region.<regionId>"` change on import. There is no path today where the original destination string stays valid.
- **Forward-reference problem:** Scene A's teleporter points at Scene C, created later in the run. You cannot even *write* a valid destination on the create pass — the target's new id doesn't exist yet.

**Therefore `create-scenes` (§6.2) MUST own a genuine two-pass that ends in a WRITE-BACK, not just an id-map:**
1. **Pass 1 — create every scene + every region** (regions passed whole: `shapes[]`, `elevation{}`, `visibility`, `behaviors[]`), building `origScene→newScene` and `origRegion→newRegion` maps as docs are minted.
2. **Pass 2 — rewrite + write back.** For every region behavior whose `system.destination` is `Scene.<old>.Region.<old>`, compute `Scene.<new>.Region.<new>` from the maps and **`updateEmbeddedDocuments('Region', …)`** to persist it. **This update path does not exist in `src/page/scenes.ts` today and must be added** (the one key file the draft missed — finding §8 / critique net-recommendation).
3. **`keepId` is an OPTIMIZATION, not the mechanism.** *If* DECISION D resolves to "thread `keepId:true` through both `Scene.create` and `createEmbeddedDocuments('Region', …, {keepId:true})`" AND zero ids collide with existing world docs, then pass 2 can be **skipped** (destinations already valid). Foundry only honors `keepId` when the supplied `_id` is a valid 16-char id not already in the collection — so collision still forces the rewrite. **Build the create-then-rewrite path first (always correct); add keepId as the skip-optimization second.**

Regions are passed **whole** (same rule as walls/lights), schema-validated against live `CONFIG.RegionBehavior` types before create (a bad `behaviors[].type`/`.system` throws on create). Mid/legacy packs have no regions — skip; legacy tile/Levels-module teleporters are out of scope (report to user, don't swallow — §8 / finding #12).

### Stage F — Recreate journal(s) (TOOL: `create-journal` + `add-journal-image`, extended §6.8)
For each `JournalEntry` pack: recreate the entry with its pages in order. Image-key pages (`type:'image'`, `page.src` = rewritten `*_Key.webp` path) are the sample's content; text pages (richer narrative packs like Ostenwold) carry `text.content`. Use the existing `create-journal` for text pages and `add-journal-image` per image page (or the new one-shot image-pages param §6.8 if built). Stamp the same `flags["tom-cartos-import"]` for dedup. Then **link the journal to its scene(s)** via `create-scene`'s existing `journal` field — the whole-temple overview key (`TC_..._Key.webp`) is the natural `scene.journal`. Decouple "journal pack present?" from "key images present?" — either may be absent.

### Stage G — Variant handling (SKILL judgment)
Enumerate **what's actually in the Scene pack** — never synthesize an expected regular/Night/Clean triad from names (some packs ship Clean-only or Day-only). Group by the `NN <MapName>` prefix; identify variant suffix tokens (`Clean`, `Night`, `Day`, `Gridless`). Then **ask** which to import (default proposal: the **regular** variant of each map; offer Night/Clean as extras). Foldering + naming:
- Create a folder per pack: `move-documents` / `create-folder` → `Tom Cartos — <Module Name>`.
- Scene names keep the pack's `NN <MapName> [<Variant>]` so nav ordering survives (the leading `NN` orders scene-nav). Variants of one map land in the same folder, suffixed (`01 Iris`, `01 Iris (Night)`, `01 Iris (Clean)`).
- **Clean is a different scene** (props removed → fewer walls: Iris 445 vs Iris-Clean 176), not a re-skin — import it as its own scene if chosen, with its own walls.

---

## 4. Optional Key→Notes feature (explicit opt-in) — framed as "draft pins for GM review"

A bolt-on sub-feature after the base import. **Not done unless confirmed.** **The critique was right that the draft oversold this — vision-derived pins are approximate; the EXPECTED outcome is "plausible but 10–30% one room off," and the GM review loop is the norm, not the exception.** The SKILL.md must say "draft pins for review," never "lands in the right room every time."

- **Gate (SKILL).** After import, detect `*_Key.webp` (already imaged into the journal). Ask: *"This pack has labeled legend keys. Want me to turn them into clickable GM room-notes pinned on each scene? (I'll place draft pins for you to review and nudge.)"* Default **no**.
- **Stage 1 — read the legend (SKILL / vision).** Per scene's key image, the skill reads (renders to vision): per numbered room → `number`, `name` (from the legend box), optional `description` (usually blank in Tom keys), and the room's location. **Coordinate caveat (critique #6):** the `_Key.webp` bakes in a **legend box and title banner** that shift/scale the map content relative to the gridless background — so the key's grid is **not guaranteed pixel-aligned** to the scene's 140px engine grid. Prefer reading the **painted red number's normalized x/y on the key**, then snapping to the nearest grid-cell **center validated against the live scene dimensions** (not the key's pixel size). Grid-cell snapping is more robust than raw scaling but is **not** infallible.
- **Stage 2 — GM journal (TOOL).** One GM-only JournalEntry (or one page-per-room), `ownership.default:0` (the `create-journal` default), a text page `"NN — Room Name"` per room; capture each `pageId`. **GM-only secrecy comes from the journal's `ownership.default:0`, NOT a note flag** — players lack permission on the target, so the pins don't render for them. (`note.global` only controls fog/vision occlusion, not permission.)
- **Stage 3 — coordinates (TOOL math).** Convert the read location → canvas px via **live `scene.dimensions`** (new read §6.7), including the `padding:0.25` offset (`sceneX/sceneY`) — read it live, don't hand-compute.
- **Stage 4 — place pins (TOOL: new `create-scene-notes`, §6.6).** Per room: `scene.createEmbeddedDocuments('Note', [{entryId, pageId, x, y, text:"NN — Room Name", texture, iconSize}])`, `texture` passed whole, mirroring the wall/light isolation pattern. Set `text` to **number + name** so a misplaced pin is **self-identifying** on review. Stamp `flags["tom-cartos-import"].sourceKey = "<room-number>"` for idempotent re-runs/cleanup.
- **Stage 5 — confirm/correct (SKILL).** This is the **expected** step, not an exception. Report each pin's room + computed cell; tell the GM to nudge any that look off (v1: manual drag — consistent with the no-place-token reality; v2: `update-note`/`delete-note`, §6.6).

**Automatable vs manual:** detection, journal creation, cell→px math, note creation, GM-secrecy = automatable (tools). The opt-in question, legend reading (vision, not a parser), and final pin-accuracy eyeball = skill/manual.

---

## 5. Strategy decision — RECOMMEND: extract-and-recreate (with a *user-driven, in-app-only* escape hatch)

Two candidate strategies:

**(A) Install-as-module.** Drop the folder into `Data/modules/<id>/`, enable it, drag scenes out of the Scene compendium ticking "Keep Document IDs."

**(B) Extract-and-recreate** through the MCP tools (the pipeline above).

**Recommendation: (B) extract-and-recreate.** Rationale, tied to constraints:

- **Molten "live-DB-untouchable" (hard).** `upload-asset` *refuses* writes under a live world's LevelDB (`worlds/<w>/data/...`, guarded at `dav-access.ts:45-47`, regex `^worlds\/[^/]+\/data(\/|$)`). **A module's enable-state lives in that same world DB.** So you **cannot flip the module-enable flag via WebDAV at all**, and the bridge (Plane A) has **no "enable module + reload" driver**. **Strategy A's "drop a folder + enable it" path therefore dead-ends in this architecture.** B writes only assets (Plane B) + drives document creation through the bridge (Plane A) — exactly the two channels the architecture supports.
- **No permanent dependency (design intent).** B leaves no module enabled; A would leave the world depending on the module folder staying present (and on Molten not pruning it).
- **Cross-version uniformity.** B's `read-pack` normalizes legacy/mid/modern to one shape; A relies on Foundry's *own* migration when enabling — which only works if the module's `compatibility` lets it load on v14 at all (a raw v10 folder may refuse). B reads any era off disk.
- **Teleporters/regions — B preserves them** via §6.2 create-then-rewrite; A preserves them only if the user manually ticks "Keep Document IDs" on every drag.
- **Idempotency/repair.** B dedups against the stamped flag and re-points assets with `relink-asset` if needed; A's drag-import duplicates silently.

**The corrected escape hatch (STRICT):** Foundry-exclusive paid packages sold only inside the in-app browser (Ostenwold, Into the Wilds) have **no public manifest/zip and no on-disk folder** — `read-pack` has nothing to extract. For those, **the USER installs + enables them in-app by hand** (the skill cannot drop/enable a module — see the world-DB guard above). The skill then operates on the **already-imported live scenes** for the asset-agnostic parts only (legend→notes, §4). **Drop any implication that the skill itself installs or enables a module folder.**

---

## 6. Tooling gaps → new/changed tools

Per design.md §3, correctness lives in tools, and every `inputSchema` is generated from a hoisted zod via `toInputSchema`. **House-style rule the critique flagged (#10): prefer minimally-typed `.passthrough()` sidecar schemas (like `SidecarWallSchema`) over `z.any()`. Pure `z.any()` produces a useless generated JSON schema — the exact anti-pattern the convention exists to prevent.** Each entry: target file, zod sketch, TOOL-vs-SKILL.

### 6.1 `read-pack` — extract + detect + emit rewriteHints (**TOOL** · correctness)
**Target:** new `src/tools/pack-reader.ts` (Node-side — off-line, on-disk LevelDB/NeDB, not in-browser). Deterministic, fixture-testable against the scratchpad dump — textbook "tool owns correctness." **The reader's storage backend is gated on DECISION A (LevelDB) and DECISION B (NeDB) — do not write `split('\n').map(JSON.parse)` for NeDB.**
```
ReadPackSchema = z.object({
  modulePath: z.string().min(1),             // abs path to module folder OR module.json
  destRoot: z.string().optional(),           // when set, emit rewriteHint per asset (§6.11)
  packTypes: z.array(z.string()).optional(), // default ['Scene','JournalEntry']
  sample: z.boolean().default(false),        // descriptor-only (cheap) vs full docs
})
// → { descriptor:{era,storage,needsWallSenseTranslation,needsLightConfigNesting,
//      hasRegions,sceneBackgroundShape,sceneEnvShape}, module:{id,title,packs[]},
//      scenes:[{_id,...,walls[],lights[],regions[],
//               assets:[{docSrc,diskPath,rewriteHint?}]}],
//      journals:[{_id,name,pages:[{type,name,src?,content?,diskSrc?,rewriteHint?}]}] }
```

### 6.2 region create + cross-scene teleporter remap (**TOOL** · correctness, = M3)

> **AS BUILT (M3, 2026-06-29) — chose the composable two-tool path over a `create-scenes` mega-tool, and
> flag-reconstruction over agent-shuttled id maps.** The draft proposed one batch `create-scenes` tool
> that wraps N creates and owns the two-pass internally. Built instead: (1) the **existing, live-verified
> `create-scene`** gains a `regions` param (read from the same `placeablesPath` payload as walls/lights),
> creates them whole via `createEmbeddedDocuments('Region', …)`, and **stamps each region's source `_id`
> into `flags["tom-cartos-import"].sourceId`**; (2) a small new **`remap-teleporters {sourceModule}`** tool
> does pass 2. Rationale (kernel-grade bar): the draft's "skill accumulates `origId→newId` maps across N
> calls and passes them to the remap" makes the **LLM agent transcribe 16-char random Foundry ids** out of
> one tool's text and back into another's input — fragile (a wrong id silently breaks a teleporter) and it
> misses scenes from a *prior* resumed run. Instead `remap-teleporters` **reconstructs the old→new scene +
> region maps from world state** (scenes already carry `flags…sourceModule`/`sourceId` from M2; regions now
> carry `sourceId`), so the skill just calls it ONCE with the module id — no id bookkeeping, idempotent, and
> correct across resumes. Page-side write-back is `region.updateEmbeddedDocuments('RegionBehavior', [{_id,
> 'system.destination': newDest}])` (verify the exact nested-embedded path at the e2e). Pure cores
> `sidecarRegionToV14` + `remapTeleportDestination` are unit-tested. `keepId` skip-path (DECISION D) NOT
> built — create-then-rewrite is the always-path, as planned.

**Target:** `src/tools/scene.ts` + `src/page/scenes.ts`. The historical batch-tool sketch below is
superseded by the AS-BUILT note; kept for the design trail.
```
CreateScenesSchema = z.object({   // NOT BUILT — see AS BUILT above
  scenes: z.array(CreateSceneSchema.extend({
    keepId: z.string().optional(),          // original _id; honored only if DECISION D = yes
    regions: z.array(RegionSidecarSchema).optional(),
    sourceModule: z.string().optional(),    // → flags["tom-cartos-import"]
    sourceId: z.string().optional(),
  })).min(1),
  remapCrossSceneRefs: z.boolean().default(true),
})
```

### 6.3 `thumb` param on `create-scene`/`update-scene` (**TOOL** · correctness)
**Target:** `src/tools/scene.ts` (`CreateSceneSchema`/`UpdateSceneSchema`) + `src/page/scenes.ts` (`createScene`/`updateScene` write `scene.thumb`). `z.string().optional()`, Data-relative, `normalizeAssetPath`'d. Closes scene finding §4. **Caveat:** Foundry regenerates thumbs on some saves/background changes — the shipped thumb may be clobbered on first in-app edit; nice-to-have, not load-bearing, don't spend a milestone defending it.

### 6.4 `RegionSidecarSchema` + region import (**TOOL** · correctness — typed `.passthrough()`, NOT `z.any()`)
**Target:** `src/tools/scene.ts` (new sidecar) + `src/page/scenes.ts` `importScenePlaceables` (add `createEmbeddedDocuments('Region', …)`, whole-object, per-kind isolation).
```
RegionSidecarSchema = z.object({
  name: z.string().optional(), color: z.string().optional(),
  shapes: z.array(z.object({ type: z.string().optional() }).passthrough()),
  elevation: z.object({ bottom: z.number().nullable().optional(),
                        top: z.number().nullable().optional() }).passthrough().optional(),
  visibility: z.number().optional(),
  behaviors: z.array(z.object({ type: z.string().optional(),
                                system: z.object({}).passthrough().optional() })
                     .passthrough()).optional(),
  _id: z.string().optional(),             // for keepId optimization
}).passthrough()
```
Add `regions:` to `CreateSceneSchema` alongside `walls`/`lights`.

### 6.5 `environment{}` / `fog{}` / `initial{}` wholesale passthrough (**TOOL** · correctness — typed `.passthrough()`, NOT `z.any()`)
**Target:** `src/tools/scene.ts` + `src/page/scenes.ts` `buildSceneFields`. Today only `environment.darknessLevel`, `environment.globalLight.enabled`, `fog.mode` are settable. Add **typed minimally-modeled `.passthrough()` sidecars** so the modern pack's full mood round-trips (`cycle`, `base`, `dark{hue,luminosity}`, fog colors/overlay) **with a usable generated schema**:
```
SceneEnvironmentSchema = z.object({
  darknessLevel: z.number().min(0).max(1).optional(),
  globalLight: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
  cycle: z.boolean().optional(),
}).passthrough()
SceneFogSchema = z.object({
  exploration: z.boolean().optional(), overlay: z.string().nullable().optional(),
}).passthrough()
// initial{} saved camera: z.object({ x, y, scale }).passthrough().optional()
```
`buildSceneFields` must tolerate a scene with **neither** flat darkness **nor** `environment{}` (write nothing).

### 6.6 `create-scene-notes` — map-note pins (**TOOL** · correctness)
**Target:** `src/tools/scene.ts` (new tool) + `src/page/scenes.ts` (new `createSceneNotes`, mirror `importScenePlaceables` isolation; `texture` whole; defaults from live `CONST.TEXT_ANCHOR_POINTS`/`NoteDocument` schema, never hardcoded).
```
CreateSceneNotesSchema = z.object({
  sceneIdentifier: z.string().min(1),
  notes: z.array(z.object({
    journal: z.string().min(1), page: z.string().optional(),  // name|id strict-resolve
    x: z.number(), y: z.number(), label: z.string().optional(),
    iconSize: z.number().optional(), global: z.boolean().optional(),
  })).min(1),
})
```
*(Optional v2: `update-note`/`delete-note` for the Stage-5 nudge loop.)* — **DONE (M6, `345f2b5`):
`create-scene-notes` returns each created note id (`notes:[{id,journal,label}]`); `update-note`
(move/relabel/restyle/re-point one pin, ≥1 field) + `delete-note` (remove by id) close the loop.*

### 6.7 `scene.dimensions` read (**TOOL** · correctness)
**Target:** `src/page/scenes.ts` (extend `getActiveScene`/add `getSceneDimensions`) → `src/tools/scene.ts`. Returns live padded canvas geometry (`sceneX/sceneY/sceneWidth/sceneHeight/size`) so the skill's cell→px math doesn't hand-roll padding. Feeds §4 Stage 3.

### 6.8 One-shot ordered image pages on `create-journal` (**TOOL** · correctness)

> **AS BUILT (M6, 2026-06-29, commit `1ec8f49`).** `CreateJournalSchema.pages[]` now accepts
> `kind:'text'|'image'` (default text) with `src` (required for image), `caption`, `sort`, and the
> existing `playerVisible`. The page side (`createJournal`) builds a `type:'image'` page
> (`normalizeAssetPath(src)` + `image:{caption}`) vs the text page, carrying `sort`/ownership — so an
> image-only legend journal builds in ONE call with no spurious leading text page. `add-journal-image`
> also gained `playerVisible` (its `caption` was already wired). Unit-tested in journal.test.ts +
> asset-bridge.test.ts.

### 6.9 `path-prefix` mode on `relink-asset` (**TOOL**, optional — repair only)
**Target:** `src/page/assets.ts` `relinkAsset` + `src/tools/asset-bridge.ts`. Add a `pathPrefix` rewrite mode so a whole `modules/<id>/...` prefix can be repointed in one call — **only** needed for repair of an already-installed copy (clean import feeds correct paths directly via §6.11). **Defer.**

### 6.10 `upload-asset-tree` batch upload (**TOOL**)

> **AS BUILT (M6, 2026-06-29, commit `3f8cc33`).** Promoted from the skill loop to a tool when the
> full-pack / tiles imports made the per-file loop chatty. `upload-asset-tree { localRoot, remoteRoot,
> overwrite?, includeExt? }` walks `localRoot` recursively and PUTs each file to `remoteRoot/<rel>`
> (reusing `dav.ensureParents`+`dav.putFile`+`guessContentType`), preserving layout; skips existing
> unless `overwrite`; world-DB-refusal + not-configured guards like upload-asset. Pure `joinRemote`
> (literal chars preserved → no `%2520` double-encode) + `matchesIncludeExt`, both unit-tested; handler
> tested over a temp tree with a mocked DAV. The per-file `upload-asset` loop stays the documented
> fallback for hand-picked subsets.

### 6.12 Standalone TILE discovery on `read-pack` (**TOOL** · correctness)

> **AS BUILT (M6, 2026-06-29, commit `0a7b374`).** Some packs ship a folder of standalone tile images
> (huts/roofs/props the GM drags onto scenes) that aren't referenced by any scene doc, so the doc-driven
> asset walk misses them. `read-pack` now scans the module folder (skipping `packs/`) for tile images by
> the `Tile_<W>x<H>` filename signature — which also distinguishes a tile from a map (`_No Grid_WxH`) or
> a legend `_Key` — parses the grid footprint, and returns a `tiles` block (full on the first page:
> `{count, localDir, relDir, files:[{name, gridWidth, gridHeight, diskPath, dataPath?}]}`; compact
> `{count, dir}` in the `index` survey). Pure `parseTileName`/`discoverTiles`/`summarizeTileDir`
> unit-tested + a gated integration test against the real Hilltop pack. The skill (Step 4b) uploads them
> via `upload-asset-tree` and reports each footprint; placement stays a GM drag (no place-tile tool).

### 6.13 `screenshot-scene` — headless canvas capture for visual QA (**TOOL**)

> **AS BUILT (2026-06-29, post-M6).** Born from the legend→pins review: there was no way to *see* the
> rendered result, so placement could only be eyeballed by the GM. The headless bridge IS Playwright, so
> it can screenshot its own Chromium — and a spike proved headless Chromium **does** render Foundry's
> PIXI/WebGL canvas (renderer type 1 = WebGL), not a black frame. `screenshot-scene { sceneIdentifier,
> fit?, mark?, outputPath? }` views the scene, waits for the canvas to draw, fits the whole map (or keeps
> the saved camera), optionally overlays a numbered marker on each note pin (`mark:true` — view-only, no
> document changes), then captures a PNG to a file (path returned; too big for the 20K response cap, same
> as read-pack payloads). The capture is the one Playwright touch — a new `screenshot(outPath)` on the
> `FoundryBridge` seam in `src/foundry.ts`; the view/fit/overlay is the page fn `prepareSceneShot`
> (`src/page/scenes.ts`). Used live to verify the Hilltop legend pins (13/14 dead-on; one Dock pin nudged
> via `update-note`, re-shot to confirm). **94 tools.** Proof script: `scripts/spike-screenshot.mjs`
> (drives the shipped path against `dist/`). General-purpose visual QA for any scene/import, not just pins.

### 6.11 Asset-path rewrite as a TOOL, not skill string-surgery (**TOOL** · correctness — boundary fix from critique #11)
**Target:** fold into `read-pack` (§6.1) via the `destRoot` param — `read-pack` emits a `rewriteHint` (`modules/<id>/<rel>` → `<destRoot>/<rel>`, decoded) per asset. The skill only **chooses `destRoot`** (judgment); the tool **computes the rewritten path** (deterministic). The skill no longer does string surgery on `background.src`/`thumb`/`src`. (A standalone `rewrite-pack-assets` tool is an alternative; folding into `read-pack` is lighter.)

**Pack-reader: TOOL, not skill-script — decided.** Deterministic, fixture-testable, era-detection is correctness, reused identically per pack. A skill-side `.mjs` would scatter correctness into the skill layer (anti-pattern per §2.1).

---

## 7. The split

| **SKILL owns (judgment)** | **TOOLS own (deterministic)** |
|---|---|
| Confirming the era descriptor + picking the branch | `read-pack` extraction + era detection + `rewriteHint` emission |
| **Variant selection** (regular/Night/Clean — enumerate, ask, default to regular) | LevelDB/NeDB read; `sense`→split + flat-light→`config{}` translation |
| **Naming & foldering** (`Tom Cartos — <Module>` folder, `NN <Map> (Variant)` names) | `create-folder`/`move-documents`; scene/placeable/journal creation |
| **Choosing the asset destination root** + the `%20`/`%27`/`%28`-decode discipline | `upload-asset` (byte PUT, parent-create, content-type, encode); **applying the rewriteHint** |
| The opt-in gates (do the import? do the legend→notes?) | Cross-scene **destination create-then-rewrite** (`create-scenes` two-pass write-back) |
| **Legend reading** (vision: number→name, location) | Region/wall/light/note whole-object creation; `environment`/`fog` typed passthrough |
| Stage-5 pin-accuracy eyeball / nudge instruction | cell→px math inputs (`scene.dimensions` read) |
| Idempotency check (dedup on the stamped `flags` before create) | `flags["tom-cartos-import"]` stamping; GM-only secrecy (journal `ownership.default:0`) |
| Strategy choice (B vs the in-app-only A escape hatch) | Per-kind error isolation + counts; **reporting** skipped placeables (sounds/tiles/foreground) |

---

## 8. Phased build order, risks, open questions

### Build order (smallest-shippable first)
- **M0 — RESOLVE THE THREE S1 DECISIONS FIRST.** Before any code: settle **DECISION A** (native `classic-level` vs `foundryvtt-cli` child-process vs require-pre-unpack), **DECISION B** (NeDB datastore lib — `@seald-io/nedb` or cli), and **DECISION D** (keepId-threading vs always-rewrite). Record A+B in `design.md` (native-dep / CLI architecture note) before adding any reader backend.
- **M1 — single modern scene, no regions.** `read-pack` (descriptor + one scene's docs + rewriteHints) + `thumb` param (§6.3) + reuse existing `create-scene` walls/lights + flag-stamping. Ship: import one Temple-of-Night scene faithfully (dims/grid/bg/thumb/walls/lights). Proves extraction + upload + rewrite + whole-placeable passthrough. *Highest value, lowest risk — the sample is the test.*
- **M2 — full modern pack + variants + journal.** Skill orchestration loop, variant gate + foldering, journal recreation (image pages) + `scene.journal` link. `environment`/`fog`/`initial` typed passthrough (§6.5). Flag-based dedup + **resume-by-skipping-already-imported** (checkpoint mechanism for huge packs — Ostenwold = 120 maps × hundreds of sequential bridge calls on a sleep/wake host). Ship: whole Temple-of-Night pack minus teleporters.
- **M3 — regions/teleporters. ✅ DONE (2026-06-29, offline-gated).** `RegionSidecarSchema` + region import on `create-scene` (§6.4) + the new **`remap-teleporters`** tool (88th) with the page-side `remapSceneTeleporters` write-back via `updateEmbeddedDocuments('RegionBehavior', …)` (§6.2 AS BUILT — chose composable two-tool + flag-reconstruction over a `create-scenes` mega-tool with agent-shuttled maps). Pure cores `sidecarRegionToV14`/`remapTeleportDestination` unit-tested; SKILL.md two-pass flow added. *Highest-risk milestone — the live click-a-stair verify happens at the final e2e (per the batch build approach).*
- **M4 — legend→notes opt-in. ✅ DONE (2026-06-29, offline-gated).** `create-scene-notes` (§6.6, 90th tool) + `get-scene-dimensions` read (§6.7, 89th tool) + the vision/cell pipeline written into SKILL.md ("draft pins for review"). Page-side `createSceneNotes` (per-note isolation, strict journal/page name→id, `texture.src` from an optional icon, GM secrecy via journal ownership not the note) + `getSceneDimensions` (padded canvas: sceneX/sceneY/size/columns/rows, works on a non-active scene). *Live verify deferred to the e2e.*
- **M5 — cross-version (legacy/mid). ✅ DONE (2026-06-29), validated OFFLINE against the user's real v10 pack** (`tomcartos-into-the-wilds-dungeons`, 28 scenes, NeDB `.db`). read-pack is off-line, so the legacy branch was validated against real bytes without a live world. **The real pack broke 5 things the plan predicted ("fix whatever the real pack breaks"), all now fixed:** (1) **DECISION B reversed** — foundryvtt-cli v3's `extractPack` is BROKEN for pure-NeDB (it always also runs `extractClassicLevel`, which throws on a `.db`) and `extractNedb` isn't exported, so NeDB is now **parsed directly** (`parseNedbDocs`: newline-JSON, last-write-wins by `_id`, `$$deleted` tombstones honored — no native binding, no cli for NeDB); (2) leading-slash pack path `/packs/foo.db` → `resolvePackPath` strips it (resolve was jumping to the drive root); (3) `data:` URI thumbs dropped (would blow the manifest cap); (4) era-robust grid+mood projection (`projectSceneGeometry`: flat `grid` number + flat `darkness`/`globalLight`/`tokenVision` ↔ v10+ objects); (5) `sidecarLightToV14` now nests legacy `lightAnimation`→`config.animation` + `darkness`{min,max}→`config.darkness` + strips `t`/`darknessThreshold` (torch flicker was being lost). Plus **manifest pagination** (`offset`/`sceneLimit`/`totalScenes`/`nextOffset`, default page 10) + an **`index:true` survey** (names-only, whole pack, for variant planning) — needed because a 28-scene manifest is 34K > the 20K cap. Pure cores unit-tested; a gated real-pack integration test exercises the live `.db`. *Note: this pack has no regions (legacy has no teleporter regions — inter-level nav was tiles/Levels-module, out of scope); the live click-a-stair verify at the e2e uses the modern Temple-of-Night pack.*
- **M6 — polish. ✅ DONE (2026-06-29, offline-gated).** One-shot/captioned/player-visible image pages
  on `create-journal` (§6.8, `1ec8f49`) · `update-note`/`delete-note` + note-id return (§6.6, `345f2b5`)
  · read-pack stale-temp-dir sweep (`86d73f7`) · `upload-asset-tree` (§6.10, `3f8cc33`) · standalone
  **TILE discovery** on read-pack + skill Step 4b to make them GM-available (§6.12, `0a7b374`). **93
  tools, 916 tests.** `relink-asset` prefix mode (§6.9) STILL deferred (repair-only, no consumer). *Live
  e2e of the new tools is pending a CC restart (they're captured at MCP startup).*

### Risks (none hand-waved)
- **Native-dep regression (S1):** adding `classic-level` turns a pure-JS-dep server into one needing a native build + version-lock against Foundry's LevelDB writer (manifest-drift → "unsupported manifest"). **Resolved via DECISION A**; whichever path is chosen, pin the version and add a CI smoke-unpack of the golden fixture.
- **NeDB is not line-JSON (S1):** append log + `$$deleted` tombstones; a naive reader resurrects deleted docs. **Resolved via DECISION B**; test against a real (or hand-made) v10 fixture before claiming M5.
- **Cross-scene destination rewrite (M3)** is the sharpest edge — a wrong destination silently breaks teleporters with no error, and **remap is the always-path** (not a fallback) until/unless keepId is threaded (DECISION D). Mitigate: build create-then-rewrite first; unit-test the maps + the `updateEmbeddedDocuments` write-back against the dump fixture; verify live by clicking a stair.
- **Region create-throws:** a bad `behaviors[].type`/`.system` throws on `createEmbeddedDocuments('Region')`. Mitigate: validate against live `CONFIG.RegionBehavior`; per-kind isolation so one bad region doesn't void the scene.
- **`%20`/`%27`/`%28` round-trip** — decode before upload/scene/journal calls; add a round-trip test in `src/tools/molten/index.test.ts` covering spaces, apostrophes, and parentheses (no `%2520` double-encode).
- **Idempotent re-import** — `create-scene`/`add-journal-image` are NOT idempotent. Dedup on the **stamped flag**, not the name (variant names collide across packs). The flag also enables checkpoint/resume.
- **Vision pin accuracy (M4)** — approximate by nature; the GM review loop is the **expected** path. Self-identifying pin labels (`NN — Name`). Don't promise pixel-perfect; the key's banner/legend-box framing can offset the read.
- **Foundry re-gens thumbs (§6.3)** — shipped thumb may be clobbered on first in-app edit; non-load-bearing.
- **Silently-dropped placeables** — sounds / tiles / `scene.foreground` (overhead) are out of v1 scope but a faithful-import skill must **report** "N sounds / M tiles / foreground not imported," not swallow them (trust bug otherwise).
- **Molten sleep/wake on huge packs** — hundreds of sequential bridge calls; the M2 flag-resume is the concrete checkpoint mechanism.

### Open questions for the user
1. **DECISION NEEDED A — LevelDB reader backend.** Vendor native `classic-level` (own the build + CI matrix + version-pin against Foundry's writer), shell out to `foundryvtt-cli` (`fvtt package unpack`) as a child process (keeps the native dep out of the server tree — preferred for kernel-grade purity), or require the user to pre-unpack? This must be recorded in `design.md`.
2. **DECISION NEEDED B — NeDB reader backend.** For the legacy (≤v10) branch, use `@seald-io/nedb` (handles append-log + tombstones) or the same `foundryvtt-cli` child process? (A naive line-reader is wrong.) Tie to A's choice if cli covers both.
3. **DECISION NEEDED C — asset home.** `worlds/<world>/assets/tom-cartos/<id>/` (world-scoped) vs a shared `assets/tom-cartos/<id>/` root? Affects the rewrite map and public-URL privacy (assets are world-public, no auth).
4. **DECISION NEEDED D — ID strategy.** Always create-then-rewrite destinations (always correct, but a re-import makes fresh ids), or also thread `keepId:true` through `Scene.create` + `createEmbeddedDocuments('Region')` as a skip-optimization (preserves teleporters byte-for-byte, but collides on re-import)? Recommendation: **build create-then-rewrite first; add keepId as the zero-collision skip.**
5. **DECISION NEEDED E — legacy sample.** Do you have a real older (v10-era / NeDB) Tom Cartos pack on disk to validate the legacy branch (M5)? If not, modern-only is fine for v1 and M5 ships against a hand-made fixture only.
6. **Variants by default** — import only the **regular** variant of each map (proposed), or all of regular/Night/Clean? Clean is a *different* (props-removed) scene — want both?
7. **Legend→notes** — build it in v1 (M4) or defer? It's the only vision-dependent, non-deterministic part, and pins are "draft for review."
8. **In-app-only packages** (Ostenwold/Into the Wilds, no on-disk folder) — in scope for the *user-installs-in-app-then-skill-does-legend→notes* escape hatch, or explicitly out?

---

**Key files an engineer will touch:** `src/tools/pack-reader.ts` (new, Node-side; backend per DECISION A/B) · `src/tools/scene.ts` + `src/page/scenes.ts` (thumb, regions, batch + create-then-rewrite, **new `updateEmbeddedDocuments('Region', …)`**, environment/fog/initial typed passthrough, scene-notes, dimensions read, flag-stamping) · `src/tools/journal.ts` + `src/page/journals.ts` (optional one-shot/captioned/player-visible image pages) · `src/tools/asset-bridge.ts` + `src/page/assets.ts` (optional prefix-relink) · `src/tools/molten/index.ts` + `index.test.ts` (optional batch upload; `%20`/`%27`/`%28` round-trip test) · `design.md` (native-dep / CLI decision record — DECISION A/B) · `.claude/skills/tom-cartos-import/SKILL.md` (new). Reuse-as-is: `sidecarWallToV14`/`sidecarLightToV14`/`toV14WallRestriction` (`scenes.ts:110,135,174`), `applySceneBackground` (`scenes.ts:660`), `normalizeAssetPath` (`_shared.ts:29`), `upload-asset` (`molten/index.ts:332`), `create-journal`/`add-journal-image`.