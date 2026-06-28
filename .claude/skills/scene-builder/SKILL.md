---
name: scene-builder
description: >-
  Turn a map image into a ready-to-play Foundry scene. Use when the user wants to "build a scene",
  "make a scene from this map", "set up this battlemap", "turn this image into a scene", "create a
  scene", "import a map", or asks to set scene mood/lighting/weather/fog (e.g. "make it night", "add
  snow", "make this a dark cave", "attach this playlist/journal to the scene"). Prompts for a map if
  none is given, auto-sizes the scene to the image, **looks for an accompanying sidecar JSON next to
  the map to import its walls + lighting**, looks at the map to suggest big-brush mood (weather /
  darkness / vision), and offers to attach a playlist or journal. The tools own correctness (field
  paths, enum mapping, name→id, image probing); this skill owns the judgment.
---

# Scene builder

A judgment layer over the scene tools — it maps "here's a map, make it playable" into the right
`create-scene` / `update-scene` calls with sensible dnd5e defaults and a couple of confirmable mood
choices. It adds NO new mechanics; the tools hold all correctness (v14 field paths, fog/grid enum
mapping, weather validation against the live `CONFIG.weatherEffects`, playlist/journal name→id
resolution, and **auto-detecting scene dimensions from the image**).

Tools used: `create-scene`, `update-scene`, `list-scenes`, `list-assets`, `upload-asset`,
`list-playlists`, `list-journals` / `search-journals`. To **build** a new playlist or journal to
attach, hand off to the **`playlist-builder`** / **`journal-builder`** skill — scene-builder wires the
link onto the scene; those skills author the content.

## Step 0 — Get a map (don't proceed without one)

A scene without a background is rarely what the user wants. If no image was given:
- Offer to **upload a local file** (`upload-asset` → returns a Data-relative path), or
- **Pick an already-uploaded map** (`list-assets` on the maps folder, e.g. `worlds/<world>/assets/maps`).

Ask for the path/file if you don't have one. The background must be a Data-relative path (what
`upload-asset` returns and `list-assets` shows).

## Step 0.5 — Look for an accompanying sidecar JSON (walls + lighting)

Battlemaps very often ship a **sidecar JSON next to the image** — a `map.jpg` with a `map.json` (or
`<mapname>.json`) beside it — carrying pre-built **walls** and **ambient lights** so the map is
playable on arrival. **Whenever a local map file is given, check its folder for a sidecar** before
creating the scene:

- Look for a JSON with the **same basename** as the map (`cavern.jpg` → `cavern.json`), then any
  single `.json` in the same directory.
- **Read it** and check the shape. This skill + `create-scene` handle the **Foundry scene-export
  sidecar**: a top-level object with `walls` (entries shaped `{ c:[x0,y0,x1,y1], move, sense, sound,
  door }`) and/or `lights` (entries shaped `{ x, y, dim, bright, tintColor, tintAlpha }`), plus scene
  fields like `width`, `height`, `grid`, `gridDistance`, `gridUnits`, `padding`, `gridColor`,
  `gridAlpha`, `globalLight`, `darkness`. Both the legacy and the modern (v14 `sight`/`light`,
  `config{}`) field shapes are accepted — the tool normalizes either to v14. **This is exactly what
  Dungeon Alchemist's "legacy" Foundry export (and similar map packs) produce.**
- **Always import via `create-scene`, NOT Foundry's native right-click "Import Data".** That native
  menu (and the Dungeon Alchemist help page that recommends it) is **stale for Foundry v14**: v14
  removed the legacy-field migration, so importing this shape natively silently DROPS the data — every
  wall falls back to NORMAL vision (wrong for limited/secret/none walls) and lights collapse to
  0-radius with no tint. `create-scene` does the legacy→v14 conversion the native path no longer does
  (verified live, 2026-06-26).
- Pass the sidecar's `walls` and `lights` arrays straight into `create-scene` (`walls:` / `lights:`).
  **Don't transform the coordinates** — they're absolute canvas pixels and the tool writes them
  verbatim. The tool reports how many walls/lights it placed.
- **Pass each wall object WHOLE — never cherry-pick or rename its fields.** Forward every restriction
  channel a wall carries: `c`, `sight`, `light`, `move`, `sound`, `door`, `ds`, `dir`. The trap:
  **v10+ data (Foundry scene exports AND module compendium `packs/*.db` Scene records) uses the split
  `sight`/`light`/`move`/`sound` fields; the pre-v10 single `sense` key is ABSENT.** A remap that copies
  `sense` (e.g. `walls.map(w => ({ c, move, sense, sound }))`) silently DROPS `sight` on this data — and
  a wall with no `sight` defaults to NORMAL (vision-blocking), so every limited/none wall (statues,
  railings, low tombs, see-through props) turns into a solid silhouette the players can't see past
  (`light`/`move` look fine, so shadows and collision mislead you into thinking it worked). If you must
  build the array programmatically, copy `sight` explicitly (or just spread the whole wall). `create-scene`
  now emits a ⚠ warning — "*N wall(s) declared light/move/sound but no sight*" — when it detects this
  dropped-sight signature; **if you see that warning, you lost `sight` upstream — fix the mapping and
  re-import, don't ship it.** (Learned the hard way importing the Tom Cartos Gothic Cemetery pack,
  2026-06-28.)
- **Pass each light's ENTIRE `config` WHOLE too — never flatten it to a few emission fields.** A v10+
  light nests its emission under `config{}`: not just `dim`/`bright`/`color`/`alpha`, but
  **`luminosity`, `attenuation`, `coloration`, `saturation`, `contrast`, `shadows`, `animation`
  (`{type,speed,intensity}`), and `darkness` (`{min,max}`)**. Forward the whole object —
  `lights.map(l => ({ x: l.x, y: l.y, rotation: l.rotation, config: l.config }))` — the tool's
  `SidecarLightSchema` is `.passthrough()` and the page side `Object.assign`s `config` in, so everything
  carries. **The trap:** a remap that keeps only `{x,y,dim,bright,color,alpha}` drops the rest, and
  Foundry fills the gaps with its OWN defaults — which are *brighter and harsher* than most authored
  torchlight: **`luminosity` 0.25 → 0.5 (≈2× brightness), `attenuation` 0.75 → 0.5 (harder falloff),
  `animation` torch → none (no flicker)**. Across dozens of warm-tinted lights overlapping additively in
  a dark scene, that reads as a **blown-out, over-saturated (often yellow) wash** vs. the original
  bitmap's soft pools — the tint color itself is usually fine; it's the doubled luminosity + lost
  attenuation that blow it out. No runtime warning catches this (a genuinely-flat legacy light is
  indistinguishable), so it's on you: **spread the whole light, don't cherry-pick.** (Same Tom Cartos
  import, 2026-06-28 — the walls lost `sight`, the lights lost `config`.)
- **Source is a module compendium pack, not a sidecar?** A map module ships its scenes in
  `packs/<name>.db` (a `type: "Scene"` pack — newline-delimited JSON in v10/v11, a LevelDB dir in v12+).
  Each record is a full Scene with `background.src`, `width`/`height`, `grid`, and its own `walls`/`lights`
  arrays — same shape `create-scene` consumes. Upload the map image (Plane B), then pass that record's
  `walls`/`lights` through **whole** (per the rules above — full wall channels, full light `config`). The
  map's `background.src` points at the module's path (`modules/<id>/maps/…`); repoint it at wherever you
  uploaded the image.
- **Not a Foundry sidecar?** A **Universal VTT** file (`.uvtt` / `.dd2vtt` / `.df2vtt`, or a JSON with
  `resolution`/`pixels_per_grid`/`line_of_sight`/`portals` and a base64 `image`) uses grid-unit
  coordinates and a different schema — `create-scene` does **not** convert that yet. Don't feed it in
  raw (the coordinates would be wrong); tell the user it isn't supported yet rather than mangle it.
- No sidecar found, or the map is a plain illustration? Just skip this step.

## Step 1 — Dimensions: auto, EXCEPT when a sidecar provides them

**Normally do NOT compute or ask for width/height** — `create-scene` auto-detects the image's pixel
size when you omit `width`/`height`. **But when you're importing a sidecar's walls/lights, pass the
sidecar's own `width`, `height`, `gridSize` (its `grid`), `padding`, `gridDistance`, and `gridUnits`
explicitly.** The wall/light coordinates were authored against that exact canvas, so reproducing it
1:1 keeps them aligned. (The tool reports the size it used.)

## Step 2 — Battlemap or illustration? (one up-front question)

Ask this once, because it flips two settings:
- **Battlemap** (a place the party fights/explores on a grid): keep the dnd5e defaults — token vision
  on, fog individual, square grid 100px = 5 ft.
- **Illustration / overland / region / world map** (a picture, not a tactical surface): set
  `tokenVision: false` and `globalLight: true` (and consider `fogMode: "disabled"`); the grid is
  cosmetic.

If it's obvious from context, state your assumption instead of asking.

## Step 3 — Look at the map, suggest mood (big brush, confirm — never silent)

**Read the image file** (it renders to you) and offer at most **2–3** mood suggestions as confirmable
choices, not silent defaults. Keep it to broad strokes:

| What you see | Suggest |
|---|---|
| Snow / ice / tundra | `weather: "snow"` (heavy → `"blizzard"`) |
| Swamp / bog / misty / dark forest | `weather: "fog"`, `darkness: 0.3–0.5` |
| Dungeon / cave / crypt / windowless interior | `globalLight: false`, `darkness: 0.75–1` |
| Bright outdoor day / lit town | `globalLight: true` (or `darkness: 0`) |
| Night exterior / moonlit | `darkness: 0.6–0.8`, `globalLight: false` |
| Rain / storm sky | `weather: "rain"` (heavy → `"rainStorm"`) |

Don't stack five effects. Pick the one or two that define the scene and confirm. Weather keys are
validated live by the tool — if you guess wrong, its error lists the valid keys; case doesn't matter.

## Step 4 — Offer attachments

- **Playlist** — `list-playlists`, offer to set `playlist: "<name or id>"`. It auto-plays **on scene
  activation** (not on view), so pair it with an offer to activate. To build a NEW playlist to attach,
  hand off to the **`playlist-builder`** skill, then set `playlist` to it here.
- **Journal** — `list-journals` / `search-journals`, offer to set `journal: "<name or id>"` (e.g. the
  read-aloud / GM notes for this location).

Both are plain scene-document links; pass the name and the tool resolves it (and errors on an
ambiguous duplicate name — pass the id then).

## Step 5 — Create and report

Make a single `create-scene` call with the assembled params, then report the scene id/name, the
detected dimensions, and what mood/links you set. Offer to **activate** it if the user wants it live
now (or pass `activate: true` when they've already said so).

Typical call (defaults already cover grid 5ft / vision on / fog individual / daylight, so only pass
what's special):

```
create-scene {
  name: "Frostspire Pass",
  backgroundPath: "worlds/<world>/assets/maps/frostspire.webp",
  weather: "snow",            // from the map
  darkness: 0.3,              // dusk
  playlist: "Winter Winds",  // if attaching
  activate: false
}
```

With a sidecar (walls + lighting from `map.json`), pass its placeables and its canvas fields so the
coordinates line up — report back the wall/light counts the tool placed:

```
create-scene {
  name: "Eerie Temple",
  backgroundPath: "worlds/<world>/assets/maps/eerie-temple.jpg",
  width: 13050, height: 6450,         // from the sidecar
  gridSize: 150,                       // sidecar `grid`
  gridDistance: 5, gridUnits: "ft",
  padding: 0, gridColor: "#000000", gridAlpha: 0.2,
  globalLight: true, darkness: 0.3,    // sidecar lighting
  walls:  [ /* sidecar.walls  verbatim */ ],
  lights: [ /* sidecar.lights verbatim */ ],
  activate: false
}
```

To adjust an existing scene later, use `update-scene` with the same fields (and `""` to clear a
`playlist`/`journal` link). `update-scene` is document-only — it does **not** add walls/lights, so
import those at `create-scene` time.

## Boundaries

- Never proceed without a background image; offer upload or pick-from-assets instead.
- Don't hand-compute dimensions — let `create-scene` auto-detect them, **except** when importing a
  sidecar: then pass the sidecar's own width/height/grid/padding so wall/light pixels stay aligned.
- Always check for a sidecar JSON next to a local map; import its `walls`/`lights` verbatim (don't
  rescale coordinates). Decline Universal VTT (`.uvtt`/`.dd2vtt`) sidecars cleanly — not yet supported.
- Mood is suggested and confirmed, never silently applied. Keep it to big strokes (1–2 effects).
- The tool places walls/lights only at create time, only from a supplied sidecar — this skill never
  hand-authors or moves placeables. If a tool returns a refusal or reason (e.g. unknown weather,
  ambiguous link name, skipped walls), surface it rather than working around it.
