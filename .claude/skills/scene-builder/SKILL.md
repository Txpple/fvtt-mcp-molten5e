---
name: scene-builder
description: >-
  Turn a map image into a ready-to-play Foundry scene. Use when the user wants to "build a scene",
  "make a scene from this map", "set up this battlemap", "turn this image into a scene", "create a
  scene", "import a map", or asks to set scene mood/lighting/weather/fog (e.g. "make it night", "add
  snow", "make this a dark cave", "attach this playlist/journal to the scene"). Prompts for a map if
  none is given, auto-sizes the scene to the image, looks at the map to suggest big-brush mood
  (weather / darkness / vision), and offers to attach a playlist or journal. The tools own
  correctness (field paths, enum mapping, name→id, image probing); this skill owns the judgment.
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

## Step 1 — Dimensions are automatic

**Do NOT compute or ask for width/height.** `create-scene` auto-detects the image's pixel size when
you omit `width`/`height` — that's the intended path. Only pass explicit dimensions if the user
specifically wants a non-native size. (The tool reports the detected size in its result.)

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

To adjust an existing scene later, use `update-scene` with the same fields (and `""` to clear a
`playlist`/`journal` link).

## Boundaries

- Never proceed without a background image; offer upload or pick-from-assets instead.
- Don't hand-compute dimensions — let `create-scene` auto-detect them.
- Mood is suggested and confirmed, never silently applied. Keep it to big strokes (1–2 effects).
- Scene-document only: this skill never places or moves tokens/walls/lights (out of scope). If a tool
  returns a refusal or reason (e.g. unknown weather, ambiguous link name), surface it rather than
  working around it.
