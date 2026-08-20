---
name: soundscape-builder
description: >-
  Give a Foundry scene ATMOSPHERIC SOUND — the house module fvtt-mod-soundscape (#6): a continuous
  ambient bed plus pools of one-shots that fire at randomized intervals with silence between (a crow,
  quiet, a distant dog). Use when the user wants to "add ambience to this scene", "make this scene
  sound alive / creepy / busy", "sound for the crypt / tavern / forest", "random crows and wolf
  howls", "atmosphere for this map", "day and night sounds", "why is this scene silent", or to tune /
  audit an existing soundscape. NOT for music — a track, a theme, a boss cue, or anything with a
  melody is `playlist-builder` (Soundscape never touches Playlists); a sound emitted from ONE SPOT on
  the map (that waterfall, this hearth) is an AmbientSound placeable via `create-sounds`. YOU decide
  which of the ~400 library templates belong, how many to layer, the timing, the mix, and the
  day/night gates; `configure-soundscape` only STRUCTURES it (the per-scene flag array).
---

# Soundscape builder

The judgment layer over **`configure-soundscape`** — house module **#6, `fvtt-mod-soundscape`**. The
module fills a hole core Foundry has no shape for: AmbientSound placeables are *positional* single-file
loops and Playlists have no concept of **silence with variation**, so neither can do "a crow, then
quiet, then a distant dog." A **sound set** is a *pool* of files plus a play style; a scene carries
several, stacked and independent.

Per design.md §2.1: **the tool owns correctness** — the flag schema, the clamps, set resolution, the
KEEP+WARN 404 check. **This skill owns the judgment** — what a place should sound like, how many
layers before it turns to mud, the timing, the mix, and the day/night gates. Read
[`_shared/authoring-policy.md`](../_shared/authoring-policy.md); the audio clarification from
`playlist-builder` applies here too — **audio has no compendium**, so this is asset-driven work.

## First: is this even Soundscape's job?

Three different audio systems, three owners. Getting this wrong is the most common failure.

| The user wants | Owner | Why |
|---|---|---|
| Music — a theme, a track, a boss cue, exploration music, a soundboard | **`playlist-builder`** | Playlists stay the music system. Soundscape's design.md lists playlist integration as an explicit **non-goal** — it never touches them. |
| Ambience: a bed + random one-shots, "make it *sound* like a place" | **this skill** | Scene-global pools with randomized silence. Nothing else does it. |
| A sound coming from **one spot** on the map — *that* waterfall, *this* hearth, the door at the end of the hall | **`create-sounds`** (AmbientSound placeable) | Soundscape sets are scene-global **by design** ("no positional interval sounds" — non-goal). A point emitter with a radius is a placeable. |

They compose: a crypt can have a Soundscape bed, a positional AmbientSound at the fountain, and a
Playlist that starts when the fight does. Build each with its own owner.

## Step 0 — Look at the scene before you pick a single sound

Never pick from a name. Find out what the place *is*:

- **`configure-soundscape { action: "list" }`** — what it already has. If the scene is at 4+ sets,
  you are **re-mixing**, not adding (see the budget below).
- **`get-current-scene`** / **`list-scenes`** — the **darkness level** (this decides the day/night
  question), weather, and whether it's the active scene.
- **`screenshot-scene`**, or read the background image directly — it renders to you. This is the step
  that actually earns the skill: *look at the map.*
- **`list-tokens`** — what **lives** here. A crypt with five wights in it is not the same soundscape
  as an empty crypt; a market with forty townsfolk needs voices, an abandoned one needs wind.
- The scene's attached journal / notes, if any — the fiction often names the sound ("water drips
  somewhere below").

Answer these five before choosing anything:

1. **Interior or exterior?** — decides the bed (room tone vs weather/wildlife).
2. **Enclosed or open?** — a small crypt and a large cavern are different templates, not different volumes.
3. **Inhabited by what?** — people, beasts, monsters, or nothing.
4. **Working or abandoned?** — a forge running vs a forge cold is the whole character of the room.
5. **Does the light change here?** — only a *yes* justifies day/night gating (Step 5).

## Step 1 — Browse the library; never guess a template name

**`configure-soundscape { action: "library", query | section | category }`** is the only source of
exact names. `add` matches the template name **exactly**, so a half-remembered name is an error, not a
near-miss.

> ⚠️ **The section is a shelf, not a play style.** "Interval Sounds" is where the *pools* live, but
> **93 of its 287 templates are `playStyle: "loop"`** — the fireplaces, lava pools, streams, waterfalls
> and magic crystals are continuous beds filed under their subject. Read the `timing` field the
> `library` action prints (`loop · 4s crossfade` vs `every 25 ± 5s`), not the section header.

`section` and `category` narrow **both** actions — they filter the `library` browse, and they pick
which template an `add` resolves when a name lives in more than one section (five do; see Traps).

### The library at a glance — 400 templates

**Interval Sounds** — 287 templates in 14 categories (194 interval pools · 93 loops):

| Category | Sets | int/loop | Reach for it when |
|---|---|---|---|
| Beasts & Birds | 34 | 27/7 | crows, owls, wolves, dogs, rats, bats, frogs, crickets, livestock |
| Crowds & Commotion | 34 | 34/0 | market calls, cheers, chants, riots, panic — groups, outdoors and in |
| Voices — Individuals | 34 | 34/0 | coughs, laughs, screams, snores, wails — one person at a time |
| Fire, Lava & Steam | 28 | 3/25 | **beds**: campfires, hearths, forges, furnaces, lava, steam |
| Water | 28 | 8/20 | **beds**: streams, waterfalls, surf, fountains, sewers; drips are the pools |
| Industry & Workshop | 26 | 24/2 | hammering, sawing, chiseling, pulleys, mine carts, creaking wood |
| Magic & Planar | 21 | 2/19 | **beds**: portals, crystals, cauldrons, arcane hum |
| Weather & Wind | 17 | 9/8 | gusts, thunder claps, rain — the interval *gusts* layer over a wind bed |
| Town, Trade & Ships | 14 | 12/2 | bells, criers, merchants, dock and ship creaks, windmills |
| Wilderness & Earth | 12 | 12/0 | twig snaps, leaf and grass rustles, rock falls, low rumbles, ice |
| Horror & Undead | 11 | 7/4 | crypt moans, zombie moans, ghosts, chain rattles, heartbeats |
| Monsters | 10 | 10/0 | dragon roars, cave spiders, ogre/orc/ratkin grunts, reptile hisses |
| Music & Drums | 10 | 4/6 | war drums, horns, throne-room pieces — see the pitch rule below |
| Tavern & Inn | 8 | 8/0 | bartender, barmaid, glass clinks, claps, tavern men/women |

**Ambient Loops** — 113 templates in 10 categories, all continuous beds:

| Category | Loops | What's in it |
|---|---|---|
| Forests & Wilds | 18 | forest day/night (incl. "scary" variants), desert day/night, winter, sea surf |
| Weather & Wind | 14 | rain light→storm, sandstorms, wind soft/medium/strong/forest/grass/chasm/cavern |
| Caves & Mines | 12 | cave small/medium/large, cave evil ×3, cave insects, crystals, mines |
| Dungeons, Crypts & Ruins | 12 | crypts, evil dungeons small/medium/large, sewers, wet and rumbling ruins |
| Homes & Interiors | 12 | houses, castle interiors, kitchens, blacksmith shop, monastery |
| City & Town | 11 | city/town day-crowded, day-sparse, night; slums; market; temple district |
| Taverns & Gatherings | 11 | commoner and noble tavern talk, rowdy tavern, whispers, group talk by size |
| Magical & Planar | 10 | elemental labs (air/earth/fire/water), plane of fire, frozen hell, magical interiors |
| Haunted | 7 | haunted interiors ×3, evil drone, pit cries, haunted ruins |
| Battle & Unrest | 6 | combat and riot, muffled (through walls) or outside — **see the combat note** |

Note the **size and mood variants** — `small` / `medium` / `large`, `evil`, `scary`, `sparse` /
`crowded`. Those are the choices that make a soundscape read as *this* room. Pick the variant that
matches the map you looked at in Step 0; don't take the first hit.

## Step 2 — Build the stack: four slots, hard ceiling six

The module's design.md sets the aesthetic ceiling: N sets cost a timer and ≤2 audio nodes apiece, so
**the limit is mud, not performance — "mud past ~6 layers."** Treat that as binding.

Build by **slot**, not by "what else could I add":

| Slot | How many | Style | What it is |
|---|---|---|---|
| **1. The bed** | exactly 1 | loop | The room tone. The sound the place makes with nobody in it. Never skip it — one-shots over silence sound like a broken speaker, not a place. |
| **2. The texture** | 0–1 | loop | A second continuous element the map actually shows: the fire, the stream, the rain, the wind. Only if you can point at it on the map. |
| **3. The life** | 1–2 | interval | The inhabitants. Voices, animals, work. This is what makes it feel occupied. |
| **4. The punctuation** | 0–1 | interval | The rare, loud, story-carrying one — a distant scream, a dragon's roar, a bell. Long interval; it must stay an event. |

**Start at three sets** (bed + life + one more) and only add a fourth or fifth if the room genuinely
has more going on. Five is a rich scene. Six is the wall. Nothing about a corridor needs six.

Two beds is the classic mistake: two loops both trying to be the room tone smear into a wash and you
lose both. If you want a second continuous layer, make it a **texture** that's clearly a different
thing (a *fire* under a *cave*), and drop its volume (Step 4).

## Step 3 — Timing: how often is it a place, not a machine

Interval sets carry `interval` (seconds of silence) ± `intervalVariation`. The library's own authoring
converges on 25 ± 5 for most pools and 10 ± 5 for busy ones — use that as the spine:

| The set is… | interval | variation | Why |
|---|---|---|---|
| A busy room's constant chatter (rowdy tavern, market) | **10** | 5 | Frequent enough to read as a crowd |
| The default life layer (birds, voices, work, drips) | **25** | 5 | The library's workhorse |
| Sparse atmosphere (a lone owl, a distant dog, far thunder) | **45–90** | 15–30 | Silence is the point |
| Punctuation (a scream, a roar, a bell tower) | **120–300** | 30–60 | It has to stay rare to keep landing |

Rules of thumb:

- **Variation ≈ 20–30% of the interval.** Too little and the ear locks onto the pulse — the exact
  failure that makes a soundscape sound like a machine. The tool **clamps variation to ≤ interval**,
  so you cannot ask for negative silence.
- **Small pool ⇒ longer interval.** A 2-file pool on a 10s interval repeats itself inside a minute.
  The `library` output prints `fileCount` — use it. Under ~4 files, push the interval up or accept the
  repetition as a signature (a bell tower *should* sound the same).
- **Loop sets ignore `interval` entirely** — they take `crossfade` (0.5–30s, default 4). Leave 4
  unless the bed has an obvious rhythm or a hard transient at its edges; then go longer (6–10) to hide
  the seam. A single-file loop set crossfades into **itself**, which is what makes any file seamless —
  you never need to hunt for a loop-point-authored asset.

## Step 4 — Volume: every template ships hot ⚠️

**This is the step that most needs a human's judgment, because the library gives you no help:**

- **284 of the 287 Interval Sounds templates ship at `volume: 1`** — maximum.
- **All 113 Ambient Loops ship at `0.8`** (the builder's default; only one has a sidecar, and it only
  sets crossfade).

So a stack copied straight from templates is a bed at 0.8 with four one-shot pools at 1.0 firing over
it — everything shouting, nothing in front. **Always pass `volume` on `add`; never take the
template's.** Starting points, to be tuned by ear:

| Slot | Start at | Reasoning |
|---|---|---|
| Bed | **0.35–0.5** | Should be subliminal — you notice it when it *stops* |
| Texture | **0.4–0.6** | Under the one-shots unless the map makes it the feature (a roaring forge: 0.7) |
| Life | **0.5–0.7** | Has to sit clearly on top of the bed without becoming the bed |
| Punctuation | **0.8–1.0** | It is supposed to make someone look up |

Two more rules:

- **Every added continuous layer pulls the others down.** Two loops at 0.5 are louder *and* muddier
  than one at 0.6. If you add a texture, drop the bed.
- **The DM's Ambient channel slider is the master** — the set volume multiplies under it. Balance the
  stack so it works at any master position. "Just turn it down" is not a mix.

**`volumeVariation`** (0–1, attenuate-only — never louder than `volume`) is the cheapest realism there
is on a distance-varying pool: dogs, birds, voices, gusts. **0.2–0.3** reads as "some are further
away." Leave it 0 on anything that should sound like it's in the room with you.

**`pitchVariation`** is in **octaves** (0–1). The library's practice, and the rule to follow:

| Source | pitch | Note |
|---|---|---|
| Human voices, crowds, animals, tools, town | **0.2** | The workhorse — 154 templates use it |
| Hard mechanical impacts: chains, doors, rock falls, monster grunts | **0.3** | Wider is fine on noise |
| Music, bells, horns, drums, chants | **0 (0.1 max)** | Pitch-shifting **detunes** it. The library keeps its 10 music templates at 0 or 0.1. |
| **Any loop set** | **0** | **All 93 loop-style templates ship 0.** Shifting a bed detunes it against its own crossfade tail. |

## Step 5 — Day / night: yours to decide, always ⚠️

`whenToPlay` gates on scene darkness: **`day` = darkness < 0.5, `night` = darkness ≥ 0.5**,
re-evaluated live, so a GM sliding the sun down hears the crickets take over.

> ⚠️ **No template ships gated. All 400 are `whenToPlay: "always"`** — including the ones *named* for
> it ("Animal Cries Day", "Animal Cries Night", "Forest Night 1"). The name is a hint about the
> content; the gate is entirely your call, and you must pass it explicitly on `add`.

**Gate only when the darkness on that scene actually moves.** The pay-off is a scene that changes
character when the DM slides the sun — which never happens on a scene whose darkness is fixed.

| The scene | Do |
|---|---|
| Exterior the party occupies across a day (town, camp, road, wilderness) | **Gate in pairs** — a `day` set and a `night` set in the same slot. They count as **one** slot against the six, since only one plays at a time. |
| A crypt, cave, or interior at fixed darkness | **`always`.** Gating here produces a permanently silent set. |
| A one-scene ambush or a set-piece at a fixed hour | **`always`** — bake the hour into the choice of template instead. |

The pairing pattern (one slot, two sets):

- Life: `Animal Cries Day` → `whenToPlay: "day"` · `Animal Cries Night` → `whenToPlay: "night"`
- Bed: `Forest Day 1` → `day` · `Forest Night 1` → `night`

If you gate a set on a fixed-darkness scene, the tool tells you plainly — `action: "list"` prints
`⏸ … idle: gated to day (scene darkness 0.85)`. **Read that line; it is the check on this step.**

## Step 6 — Verify, then report honestly

Finish with **`configure-soundscape { action: "list", verifyFiles: true }`** and actually read it:

- **`▶` vs `⏸`** — how many would be playing right now, and the `idle:` reason for each that isn't.
  A stack where three of five are idle is a bug in your gating, not a rich scene.
- **`⚠ N missing file(s)`** — a 404 pool. See the sandbox trap below.
- **`module NOT INSTALLED` / `module DISABLED`** — the sets are written but **nothing plays them**.
  Say that to the user rather than reporting a working soundscape.
- **`clamped to the module's limits: …`** — the tool took a different number than you asked for.
  Surface it; don't quietly ship a value you didn't choose.

Report what you built as a **stack** — slot, template, timing, volume, gate — not as a list of five
tool calls.

## Worked example — a busy tavern, day

Looked at the map: interior, medium common room, hearth on the north wall, ~15 patrons, daytime.
Four sets: bed + texture + two life. Darkness is fixed, so no gates.

```
configure-soundscape { action: "add", sceneIdentifier: "The Rusty Flagon",
  template: "Commoner Tavern Talk", volume: 0.45 }                        // 1. bed
configure-soundscape { action: "add", sceneIdentifier: "The Rusty Flagon",
  template: "Fireplace", volume: 0.4 }                                    // 2. texture (the hearth)
configure-soundscape { action: "add", sceneIdentifier: "The Rusty Flagon",
  template: "Tavern Glass Clinks", interval: 20, intervalVariation: 6,
  volume: 0.6, volumeVariation: 0.25, pitchVariation: 0.2 }               // 3. life (close work)
configure-soundscape { action: "add", sceneIdentifier: "The Rusty Flagon",
  template: "Laughs Men", interval: 45, intervalVariation: 15,
  volume: 0.55, volumeVariation: 0.3, pitchVariation: 0.2 }               // 3. life (the patrons)
```

No punctuation slot here — a tavern's drama is the players'. The two life layers are deliberately at
different rates (20s and 45s) so they don't lock into a shared pulse.

Deliberately **not** added: `Rowdy Tavern` (it's a 15-file pool that *is* the whole room — it fights
the bed; use it *instead of* slots 1+3 for a brawl-loud inn), and a music template (that's
`playlist-builder`).

## Worked example — the wight crypt

Looked at the map: small stone crypt, water damage, five wights placed. Three sets. Sparse on purpose
— horror is mostly silence, and the punctuation has to land.

```
configure-soundscape { action: "add", sceneIdentifier: "The Hollow — Crypt",
  template: "Crypt Small", volume: 0.4 }                                  // 1. bed
configure-soundscape { action: "add", sceneIdentifier: "The Hollow — Crypt",
  template: "Water Drips", interval: 30, intervalVariation: 10,
  volume: 0.5, volumeVariation: 0.3 }                                     // 3. life (the wet stone)
configure-soundscape { action: "add", sceneIdentifier: "The Hollow — Crypt",
  template: "Crypt Moans", interval: 150, intervalVariation: 45,
  volume: 0.85, volumeVariation: 0.2, pitchVariation: 0.2 }               // 4. punctuation
```

`Crypt Moans` at 150 ± 45s is doing the work: rare enough that the table stops talking when it
happens. Dropped to 25s it becomes wallpaper and the room stops being frightening.

## Traps ⚠️

1. **Five template names exist twice — pass `section` when you use one.** `Crow Caws`, `Owl Hoots`,
   `Rain Light`, `Sea Surf Large`, `Sea Surf Small` each name both an Interval Sounds pool and an
   Ambient Loops bed. A bare `add` on one of those throws and names both candidates; `section` (or
   `category`) narrows it:

   ```
   configure-soundscape { action: "add", template: "Crow Caws",
     section: "Ambient Loops", volume: 0.4 }        // the bed, not the interval pool
   ```

   Two escape hatches if a name is still ambiguous: pick a non-colliding sibling (`Crow Caws 2`,
   `Owl Hoots Night`), or add with explicit `files` — the library layout is stable, so `list-assets`
   gets you the paths (`soundscape-sfx/interval-sounds/<category-slug>/<set-slug>/*`,
   `soundscape-sfx/ambient-loops/<category-slug>/<name>.ogg`).

2. **On the local SANDBOX, expect a 404 warning on nearly every pool.** `soundscape-sfx/` is a
   Data-**root** sibling of the folders the prod→local mirror copies (`worlds/<id>`, `systems`,
   `modules`, `assets`), so it is **never mirrored** — whatever is there was hand-seeded for testing.
   The seeded sandbox carries the **full 400-template `library.json` but only a couple of audio
   files**, which means:
   - `action: "library"` works normally and lists all 400.
   - `action: "add"` from a template **succeeds** — and every file in the pool warns as missing.
     That is the KEEP+WARN policy working as designed: an audio track has no sensible substitute, so
     a 404 is authored faithfully and reported, never swapped.
   - On a sandbox with **no** seed at all, `library` reports none and a template `add` throws
     ("Cannot add from template: no library at …") before any 404 check.

   So **author soundscapes against prod**, and use the sandbox to exercise the *shape* (add / update
   / remove / list), reading past the file warnings. Never "fix" a sandbox 404 by swapping in a path
   that resolves — you'd be authoring the wrong file into prod.

3. **`update` with `files` REPLACES the whole pool.** There is no append. To extend a set, `list` it,
   take its `files`, and pass the full new array.

4. **Lowering `interval` re-clamps `intervalVariation`.** Normalization runs on the *merged* set, so
   dropping `interval` to 10 on a set with `intervalVariation: 15` clamps the variation to 10. The
   tool reports it under `clamped:` — read it, and pass both when you change either.

5. **Never author a "combat" set.** The module already ducks — interval sets to silence, loop sets low —
   whenever combat is running, so `combatplus` and the fight music own that moment. The Battle &
   Unrest loops are for combat happening **somewhere else** (a riot two streets over, a battle heard
   through a wall), which is exactly why they come in `muffled` and `outside` variants.

6. **Sets are per-scene flags — nothing is inherited or shared.** There's no "copy soundscape to
   scene B". To reuse one: `list` the source scene (its `files` arrays come back in full) and `add`
   each set on the target.

7. **`remove` with `setIdentifier: "all"` clears the entire scene.** Only on an explicit ask, and say
   what you're about to delete first.

8. **If the library files ever move**, existing scene sets break. `scripts/remap-soundscape-scene-paths.mjs`
   (`--dry` first) repoints every scene by basename — that's a maintenance script, not something to
   run mid-authoring.

## Boundaries

- **Never music.** No theme, no melody, no boss cue, no soundboard. Hand off to `playlist-builder`.
- **Never positional.** "The fountain in the courtyard" is `create-sounds`, not a scene-global set.
- **Look at the scene before choosing** — screenshot/read the map and `list-tokens`. A soundscape
  picked from a scene's *name* is a guess.
- **Never invent a file path or a template name.** Templates come from `action: "library"`, paths from
  `list-assets` / `upload-asset`. A path that doesn't resolve is kept and warned about — it is not
  quietly substituted, and neither should you substitute.
- **Always pass `volume`; never inherit the template's.** The library ships at 0.8–1.0 across the board.
- **Always decide `whenToPlay`.** Every template ships `always`; a gate is never given to you.
- **Six sets is the ceiling, three is a good scene.** If a request implies more, mix down — replace
  two thin layers with the one template that already contains both.
- **Surface every warning the tool returns** — missing module, 404 pools, clamps. Don't report a
  working soundscape over a disabled module.
- **Authoring, not live mixing.** Building and tuning a scene's sets is this phase; riding volumes
  during play is not.
