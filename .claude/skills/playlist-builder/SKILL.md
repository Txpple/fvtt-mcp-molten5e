---
name: playlist-builder
description: >-
  Author D&D 5e audio playlists in Foundry — scene ambiences (tavern, forest, dungeon, storm),
  combat/boss music, exploration music sets, and SFX soundboards. Use when the user wants to "make a
  playlist", "add background music / ambience", "a tavern soundscape", "battle music", "a soundboard
  of effects", "atmosphere for this scene", or to attach audio to a scene. YOU decide the tracks, the
  playback mode, and the mix; the tools only STRUCTURE it (the Playlist/PlaylistSound shape). Audio has
  no premium-book compendium — playlists are asset-driven (like scenes): the sound files are uploaded.
  Composes create-playlist / update-playlist / list-playlists / delete-playlist (+ upload-asset for the
  audio); to attach a playlist to a scene, hand off to scene-builder.
---

# Playlist builder

The judgment + curation layer for **audio** (design.md §5) — the ambience and music that set a scene's
mood: a crackling tavern, a howling blizzard, a boss fight, a soundboard of one-shot effects. As with
every authoring skill: **you decide; the tool does.**

## The line that matters — yours vs the tool's

- **You (this skill) decide the audio** — which tracks belong together, the playback mode, the volume,
  whether it loops. That curation IS the job.
- **The tool only STRUCTURES** — `create-playlist` builds the Playlist + one PlaylistSound per path
  (v14 sound field is `path`); `update-playlist` renames / re-modes / sets crossfade. Neither invents
  audio.

## Authoring policy — what compendium-first means HERE

Read [`_shared/authoring-policy.md`](../_shared/authoring-policy.md). The clarification for audio:

- **Audio has NO premium-book compendium** — so **compendium-first is N/A**: playlists are
  **asset-driven, like scenes**. Every track is an **uploaded** sound file referenced by its
  Data-relative path (`upload-asset` returns one; `list-assets` shows them). There is no "copy the book
  playlist" path.
- **Don't reference audio you don't have.** Every `soundPaths` entry must point at a real uploaded
  file. If the user has no audio for what they want, say so and offer to **upload** files — don't
  invent paths.

## Tools

- **`create-playlist`** — the structuring creator. `{ name, soundPaths[], mode?, defaultVolume?,
  repeat?, fade? }`. Builds the stack with one track per path, in order.
- **`update-playlist`** — rename, change `mode`, or set `fade` (crossfade). Does not add/remove tracks
  (rebuild with create for a different track set).
- **`list-playlists`** — list playlists + ids (mode, track count, whether playing).
- **`delete-playlist`** — remove by exact id/name (strict).
- **`upload-asset`** — bring audio files into `Data/` first; chain the returned paths into `soundPaths`.

## Mode — the core decision

| Mode | Plays | Use it for |
|---|---|---|
| `sequential` | one track after another, in order | a curated music **set** (exploration, a scripted scene) |
| `shuffle` | one at a time, random order | a music **pool** (combat tracks, varied ambience) so it doesn't feel looped |
| `simultaneous` | **all tracks at once, layered** | a **soundscape** — rain + wind + distant thunder, or tavern murmur + hearth + lute |
| `soundboard` | nothing auto; each track triggered **manually** | one-shot **SFX** (door creak, sword clash, horn) |
| `disabled` | nothing | a stack you're staging, not playing |

## Volume · repeat · fade

- **`repeat`** — `true` for **ambience/soundscapes** that should loop forever; `false` for a **music
  set** that advances and stops (or loops the set in shuffle/sequential).
- **`defaultVolume`** (0–1, default 0.5) — applied to **every** track equally (the tool sets one
  volume for the whole list; there's no per-track mix yet). For a layered `simultaneous` soundscape
  where one element should sit lower, pick pre-balanced files or keep the mix simple.
- **`fade`** — crossfade in **milliseconds** (e.g. `2000`) for smooth transitions between tracks; nice
  on `sequential`/`shuffle` music, usually unnecessary on a looping `simultaneous` bed.

## Playlist kinds — pick the mode + the loop

- **Scene ambience / soundscape** (tavern, forest, cave, storm) → `simultaneous`, `repeat: true` — a
  layered bed that loops. Or a single looping track in `sequential`.
- **Combat / boss music** → `shuffle` (a pool so it varies) or `sequential`; `repeat: true` to loop
  through the fight; a `fade` for smooth changes.
- **Exploration / travel music** → `sequential` or `shuffle` set, `repeat` to taste.
- **SFX soundboard** → `soundboard` — a set of one-shot effects the GM fires by hand.

## Attaching to a scene (hand off to scene-builder)

A playlist set on a scene's `playlist` link **auto-plays when the scene is ACTIVATED** (not merely
viewed). So: build the playlist here, then **hand off to `scene-builder`** (or `update-scene`) to set
the scene's `playlist` to this one. Building the audio is this skill; wiring it onto a scene is the
scene's job.

## Phase boundary — authoring, not live mixing

Build and wire playlists now. The playlist plays via **scene activation**; manually starting/stopping
individual tracks, ducking, or live-mixing during a session is **out of scope** (a later, in-play
phase).

## Don't

- Don't invent sound paths — every track is a real uploaded file; offer `upload-asset` if there's none.
- Don't expect per-track volume — one volume covers the list (pre-balance the files instead).
- Don't try to start/stop/duck tracks live — that's not this phase; activation plays the playlist.
