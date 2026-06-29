---
name: tom-cartos-import
description: >-
  Import a Tom-Cartos-style Foundry SCENE-PACK MODULE (an unzipped folder with a `module.json` and
  `packs/` compendiums) into the live world. Use when the user wants to "import a Tom Cartos pack",
  "install this map module", "bring this scene pack into my world", "import the dungeon/temple/keep
  module", "import a Foundry module's scenes", or points at a module folder / a `module.json`. Reads
  the pack off disk, detects its Foundry era, uploads and re-points all its assets, and recreates each
  scene faithfully — dimensions, grid, background, thumbnail, environment/fog mood, every wall and
  light, and the cross-scene teleporters (stairs between levels) — plus the pack's journal of legend
  keys. The tools own correctness (extraction, era detection, path rewrite, whole-placeable creation,
  teleporter remap); this skill owns the judgment: which variants to import, naming/foldering, the asset
  destination, the import order, and dedup.
---

# Tom Cartos import

A judgment layer over `read-pack` + the scene/journal/asset tools that turns a **Tom-Cartos-style
scene-pack module** — a `module.json` plus LevelDB/NeDB compendiums holding fully-authored scenes
(thousands of walls, hundreds of configured lights, a journal of numbered legend keys) — into real
scenes **in the user's own world**, without enabling the module as a permanent dependency.

Strategy is **extract-and-recreate**, not install-as-module: Molten's hosting blocks flipping a
module's enable-flag and the bridge has no enable-module driver, so "drop the folder and enable it"
dead-ends. We read the pack off disk, upload its images, and recreate the documents through the tools.
See [`docs/tom-cartos-import-plan.md`](../../../docs/tom-cartos-import-plan.md) for the full design.

Tools used: **`read-pack`** (the off-line extractor/detector — owns all the LevelDB/NeDB reading,
era detection, and asset path-rewrite math), `upload-asset` (Plane B), `create-scene`,
**`remap-teleporters`** (the second-pass teleporter fixer), `create-journal` / `add-journal-image`,
`create-folder` / `move-documents`, `list-scenes` / `list-journals`. To boot the world first, hand off
to **`start-session`**.

> **Scope — all eras:** this skill imports **modern** (v13/LevelDB), **mid** (v10–v11), and **legacy**
> (≤v9 / NeDB `.db`) packs. `read-pack` detects the era and normalizes the on-disk shape for you: a
> modern pack's split walls / `config{}` lights / `environment{}` mood and cross-scene **teleporters**
> (the stairs/portals), or a legacy pack's `sense` walls, flat torch lights, flat grid/mood, and `img`
> background. The only piece that's still opt-in is the legend→map-pins feature (below). **Never
> reconstruct a wall, light, or region field-by-field** — `read-pack` hands them back whole; pass them
> through whole (the dropped-`sight`/blown-out-lights trap).

## Step 0 — Boot the world and locate the module

- Make sure the world is up (the tools need the live bridge). If unsure, run the **`start-session`**
  skill (Molten cold-start is ~25 s).
- Get the **absolute path to the unzipped module folder** (the one containing `module.json`). Ask for
  it if the user only described the pack. Everything else flows from `read-pack`.

## Step 1 — Read the pack (one tool call owns the hard part)

Choose the **asset destination root** first (judgment — Step 4), then call `read-pack` with it so every
asset comes back with a ready-to-use rewrite hint:

```
read-pack { modulePath: "<abs module folder>",
            destRoot: "worlds/<world>/assets/tom-cartos/<module-id>" }
```

It returns `{ module, descriptor, scenes[], totalScenes, nextOffset, journals[], assets[] }`:
- `descriptor.era` — `v12+`, `v10-v11`, or `legacy` (`storage:"nedb"`). **All proceed.** Era only changes
  which fields carry the mood (see Step 6): modern → `environment`/`fog`; legacy/mid → flat
  `darkness`/`globalLight`/`tokenVision`. `read-pack` has already normalized the rest.
- each `scenes[]` entry carries `name`, `width/height`, the normalized
  `gridType/gridSize/gridDistance/gridUnits/gridColor/gridAlpha`, `padding`, flat
  `darkness`/`globalLight`/`tokenVision` (when the pack set them), `background`/`thumb` (each with a
  `dataPath` rewrite + on-disk `diskPath`; `thumb` is `null` for legacy packs — they ship a data-URI
  thumb Foundry regenerates anyway), `environment`/`fog`/`initial` (modern only), `sourceId`, a per-scene
  `placeablesPath` (the off-manifest file holding `walls[]`/`lights[]`/`regions[]`), and `counts`.
- `assets[]` — every referenced file for THIS page as `{ diskPath, dataPath }`, deduped + percent-decoded.

> **Paging (big packs):** the manifest is **paged** to fit the response cap — `read-pack` returns
> `totalScenes`, the page of `scenes[]` (default 10), and `nextOffset`. If `nextOffset` is not null,
> **import this page fully, then call `read-pack` again with `offset: <nextOffset>`** and repeat until
> `nextOffset` is null (it also prints a `note` reminding you). Each page's `assets[]` covers only that
> page's scenes. (A ≤10-scene pack returns everything in one call, `nextOffset: null`.)

## Step 2 — Survey the whole pack, then choose which variants to import (ASK)

To plan across a paged pack, first take the **survey** — one cheap call that lists every scene's name +
counts without paths/payloads:

```
read-pack { modulePath: "<abs module folder>", index: true }
```

Tom ships each map in **variants** — a lit "regular", sometimes a **Night** render, and a **Clean**
(props/lighting removed) version (legacy packs also use `- Bottom`, `- C/D/E`, etc.). Don't assume a
fixed set; group the survey's `sceneIndex[]` by the `NN <Map Name>` prefix and spot the variant suffix
tokens. A **Clean** scene is a *different* scene (fewer walls, no lights), not a re-skin.

- **Propose the regular/lit variant of each map** as the default, and offer the Night/Clean ones as
  extras. Confirm the selection before creating anything. Hold the chosen `sourceId`s — you'll import
  the scenes whose `sourceId` is in that set as you page through the full read in Step 6.

## Step 3 — Skip anything already imported (dedup)

`create-scene` is not idempotent. `list-scenes` and skip any scene already stamped with
`flags["tom-cartos-import"].sourceId` equal to a survey `sceneIndex[].sourceId` you're about to import
(re-runs and resumes are safe this way). Dedup on the **stamped flag**, never the name — variant names
like `01 Iris` collide across packs.

## Step 4 — Upload the assets

Default destination root: **`worlds/<world>/assets/tom-cartos/<module-id>/`** (world-scoped, namespaced
per module so two packs can't collide). For each entry in `assets[]` you actually need (the backgrounds
+ thumbnails of the chosen scenes, plus the journal key images):

```
upload-asset { localPath: <asset.diskPath>, remotePath: <asset.dataPath>, overwrite: true }
```

`upload-asset` auto-creates parent folders and content-types. `overwrite:true` keeps re-imports clean.
(Note: assets are world-public, no auth — fine for map art.)

## Step 5 — Recreate the journal(s) and keep their links

For each `journals[]` entry, recreate it so the legend keys travel with the scenes:
- Build it in ONE `create-journal` call: pass each page in `pages[]` as either a text page
  (`{name, content}`) or an **image** page (`{name, kind:"image", src}`, where `src` = the page's
  rewritten `dataPath`, plus an optional `caption`). Keep the pack's page order (or set `sort`). An
  image-only legend journal now builds cleanly with **no spurious leading "Map Keys" text page** and
  no per-image `add-journal-image` loop. (Use `add-journal-image` only to append to an EXISTING journal.)
- Stamp the same `flags["tom-cartos-import"]` for dedup.
- This entry is what you'll link as each scene's `journal` in Step 6 (the GM opens the keys from the
  scene). Follow the **`journal-builder`** conventions for page kinds/visibility.

## Step 6 — Create each scene (pass the exact geometry + everything whole)

Now page the **full** read (`read-pack` with `destRoot`, default page 10; advance `offset` to
`nextOffset` until null — see Step 1). For each returned scene whose `sourceId` is in your chosen set
(Step 2) and not already imported (Step 3), one `create-scene`. Pass the pack's **exact** geometry —
auto-size is disabled when you pass dimensions, and you MUST here, or the canvas-pixel walls/lights
won't align:

```
create-scene {
  name: "<NN Map (Variant)>",
  backgroundPath: <scene.background.dataPath>,
  width: <scene.width>, height: <scene.height>,
  gridSize: <scene.gridSize>, gridType: <scene.gridType>,
  gridDistance: <scene.gridDistance>, gridUnits: <scene.gridUnits>,
  gridColor: <scene.gridColor>, gridAlpha: <scene.gridAlpha>,
  padding: <scene.padding>,
  thumb: <scene.thumb?.dataPath>,        // omit when thumb is null (legacy)
  // MOOD — pass whichever the pack provided (read-pack gives one or the other by era):
  //  modern → environment/fog/initial ; legacy/mid → darkness/globalLight/tokenVision
  environment: <scene.environment>, fog: <scene.fog>, initial: <scene.initial>,
  darkness: <scene.darkness>, globalLight: <scene.globalLight>, tokenVision: <scene.tokenVision>,
  placeablesPath: <scene.placeablesPath>,
  journal: "<the journal entry from Step 5>",
  flags: { "tom-cartos-import": { sourceModule: <module.id>, sourceId: <scene.sourceId> } }
}
```

Pass only the fields `read-pack` actually returned for the scene (it omits what the pack didn't set):
a **modern** scene carries `environment`/`fog`/`initial`; a **legacy/mid** scene carries flat
`darkness`/`globalLight`/`tokenVision` and a `null` `thumb` (skip the `thumb` arg). Don't invent values.

- **Placeables go via `placeablesPath`, never inline.** `read-pack` wrote each scene's hundreds of
  walls/lights **and its regions** to a payload file and gave you the path; `create-scene` reads it
  server-side and places all three. Passing the arrays inline is infeasible — a single scene's walls
  overflow the tool-response cap, and they'd bloat the agent context. Everything in that file is already
  whole (wall threshold/animation, light config, region shapes/behaviors preserved); never reconstruct
  them. `create-scene` reports the counts placed (walls/lights/**regions**) and ⚠-warns on dropped
  `sight`. When a scene has regions, it prints a hint to run `remap-teleporters` afterward (Step 8).
- **Teleporters are created here but not yet linked.** Each scene's teleporter regions ride along in the
  payload, but their destinations still point at the *pack's* scene/region ids — the import mints fresh
  ids, so the links are stale until the Step-8 remap. Don't try to fix them per-scene; that's a single
  batch pass once every scene exists.

## Step 7 — Folder and name

- Create one folder per pack with `create-folder`: **`Tom Cartos — <Module Title>`**, and `move-documents`
  the new scenes into it.
- Keep the pack's `NN <Map Name> [Variant]` scene names — the leading `NN` drives scene-nav order; land
  variants of one map together (`01 Iris`, `01 Iris (Night)`, `01 Iris (Clean)`).

## Step 8 — Link the teleporters (second pass — ONE call, after all scenes exist)

Once **every** chosen scene is created (so all the new scene + region ids exist), make a single call:

```
remap-teleporters { sourceModule: <module.id> }
```

This finds all scenes you stamped with that `sourceModule`, reconstructs the old→new scene/region id
maps from the provenance flags they carry, and rewrites every teleporter destination so the stairs jump
to the right new scene. You do **not** pass or transcribe any ids — the tool reads them from world state.

- It's **idempotent** — safe to re-run, and re-running after a resumed/partial import fixes whatever's
  newly present.
- If a teleporter points at a scene you **chose not to import** (e.g. you took the regular variant but a
  stair targets the Night one), it's reported as **unresolved** (left as-is, not dropped). Tell the user;
  the fix is to import the missing variant and re-run `remap-teleporters`.
- Only modern (v12+) packs have regions; if `counts.regions` was 0 across the import, this is a no-op and
  you can skip it.

## Step 9 — Report what landed (and what didn't)

Summarize: scenes created (with wall/light/**region** counts), **teleporters linked** (and any
unresolved ones from Step 8), the journal, the asset count + destination, and — **explicitly, never
silently** — anything skipped: any `sounds`/`tiles`/`foreground` the pack carried that v1 doesn't
import, and the legend→pins follow-up (still opt-in/deferred). A faithful-import skill reports its gaps.

## Optional follow-up — legend keys → GM map-pins (opt-in; DRAFT pins for review)

Many packs ship a numbered **legend key** image (`*_Key.webp`, already imaged into the pack journal in
Step 5). This follow-up turns each numbered room into a clickable **GM map-note pin** on the scene. It is
**opt-in and approximate** — vision-read pin positions land in roughly the right cell, but expect a few to
be a room off. Frame it that way; the GM review/nudge at the end is the **norm**, not an exception.

**Gate (ASK, default no).** Only after the base import: *"This pack has a numbered legend key. Want me to
drop GM-only room-note pins on the scene? I'll place draft pins for you to review and nudge — they're
approximate."* If no, stop here.

If yes, per scene that has a key:

1. **Read the legend with vision (SKILL).** Look at the `*_Key.webp` and extract, per numbered room:
   its `number`, its `name` (from the legend box), and **where the red number sits on the map** as a
   normalized fraction (col/row, or x/y in 0–1 of the *map content* — NOT the key's pixels: the key bakes
   in a title banner / legend box that offsets and rescales the map relative to the gridless background).
2. **Get the live geometry (TOOL).** `get-scene-dimensions { sceneIdentifier }` → `sceneX/sceneY`
   (the padding offset), `size` (px/cell), `columns/rows`. Compute each pin's canvas pixel from the room's
   cell, snapping to the **cell center**: `x = sceneX + (col + 0.5) * size`, `y = sceneY + (row + 0.5) * size`.
   Validate cells against `columns`/`rows` — never against the key image's own pixel size.
3. **Build the GM journal (TOOL).** `create-journal` a GM-only entry (e.g. `"<NN Map> — Room Keys"`); its
   default `ownership.default:0` IS the secrecy (players can't open it, so the pins don't render for them).
   Add one text page per room named `"NN — Room Name"` with the key's blurb (follow `journal-builder`).
4. **Place the pins (TOOL).** `create-scene-notes { sceneIdentifier, notes:[{ journal, page:"NN — Name",
   x, y, label:"NN — Name" }, …] }`. The `label` carries number + name so a misplaced pin is
   self-identifying on review. (GM secrecy is the journal's ownership — do **not** rely on `global`, which
   only controls fog occlusion.)
5. **Report + hand off the nudge (SKILL).** List each pin's room + the cell you computed, and tell the GM
   to drag any that look off (v1 has no update-note — moving a pin is a manual in-app drag). Don't claim
   pixel accuracy.

## The split — what this skill decides vs what the tools do

- **Skill (judgment):** which variants to import; the asset destination root; naming/foldering; the
  import order (all scenes, *then* the single remap); the dedup check; confirming the era is in scope;
  reporting the gaps + unresolved teleporters.
- **Tools (correctness):** `read-pack` does all extraction, era detection, artifact stripping, and the
  asset path-rewrite math; `upload-asset` does the byte upload + content-type; `create-scene` writes the
  scene + places walls/lights/regions whole + stamps flags; `remap-teleporters` reconstructs the id maps
  from world state and rewrites every cross-scene teleporter destination; `create-journal`/
  `add-journal-image` build the journal; `create-folder`/`move-documents` organize. The skill never
  parses a `.db`/LevelDB file, rewrites a path string, or transcribes a document id by hand.
