---
name: token-cutout
description: >-
  Knock a baked-in background off a token image so it has real alpha transparency — for prepping
  tokens/portraits before dropping them on a VTT. Use when the user wants to "remove the background",
  "make the background transparent", "give this token alpha / an alpha channel", "cut out this token",
  "knock out the green screen / white background", "chroma-key this", "this token has no transparency",
  or hands over a token render on a solid green/blue/white/colored plate (or a busy background). Runs a
  bundled local script (rembg AI matte, or an offline chroma-key fallback), verifies the cut against a
  magenta preview, and can upload the result into the world and assign it as an actor's token art.
  Image prep only — no new mechanics; the script owns the pixels, this skill owns the judgment.
---

# Token cutout

A prep helper that turns a background-baked token image (green/blue screen, a flat white or colored
plate, or any busy background) into a transparent RGBA PNG ready to drop on the table — and, if asked,
wires it into the live world as an actor's token art.

There is **no MCP tool for this** — the pixel work is a bundled script,
`token_cutout.py` (next to this file). This skill owns the judgment: which method, whether to keep the
cast shadow, verifying the edge, and the optional Foundry hand-off. The Foundry steps reuse the normal
tools: `upload-asset` (asset in) and `set-actor-art` (assign it).

## Step 0 — Get the image and confirm the goal

Need a local file path (the script reads from disk, not from an uploaded asset). If the user only
gestured at "the token on my Desktop", find it with a glob first — and note the **real extension**: a
`.jpg`/`.jpeg` source has *no* alpha by definition, which is usually the whole reason we're here.

## Step 1 — Pick the method

The script's `--method auto` (default) uses **rembg** if installed, else **chroma**. Override when you
know better:

- **rembg** (AI matte, U^2-Net) — the default and the right call for a **character**: soft edges, hair
  wisps, thin details (bowstrings), and especially a **cast shadow** on the plate. It's also the
  **only** option when the background is **not a flat solid color** (a scene, a gradient, clutter).
  First use triggers a one-time ~176MB model download (`pip install "rembg[cpu]"`).
- **chroma** (offline, instant, deterministic) — best for a **clean flat solid-color plate** (classic
  green/blue screen, or a uniform white/colored back). Auto-detects the key color from the four
  corners. Prefer it when rembg isn't installed, when you want zero downloads, or for a batch where
  every image shares the same clean plate. Pass `--color RRGGBB` to force the key color if
  auto-detect is fooled by a subject that touches a corner.

When unsure for a single hero token, use rembg. For a bulk folder of identically-plated sprites,
chroma is faster and more predictable.

## Step 2 — The cast-shadow decision (ask if it matters)

Token renders often have a drop shadow on the plate. For a VTT token you almost always want it
**gone** (the VTT draws its own token ring/elevation cues; a baked green-tinted shadow looks wrong).
Defaults already do this:
- **rembg** drops the shadow automatically.
- **chroma** keys out a same-hue shadow too (it's just a darker green/blue). Pass **`--keep-shadow`**
  only if the user explicitly wants the shadow retained.

If the source is a *portrait/art* piece rather than a token, the shadow may be wanted — ask.

## Step 3 — Run it

```
python .claude/skills/token-cutout/token_cutout.py INPUT [OUTPUT] [--method ...] [--color RRGGBB] [--keep-shadow] [--erode N]
```

- Output defaults to `INPUT.png`, and it **never overwrites the source** (a same-path collision is
  redirected to `*_cutout.png`). The original stays untouched.
- Output is **always PNG** — the only common token format that carries alpha. (Don't "convert" to JPG
  afterward; JPG has no alpha and will re-bake a background.)
- `--erode N` shrinks the matte N px inward to eat a stubborn fringe (needs scipy; skipped with a note
  if absent). Reach for it only if the preview shows a thin ring.

## Step 4 — Verify against the preview (do not skip)

The script writes `*_preview.png` — the cutout composited over **magenta**. **Read that image.** Magenta
makes two failure modes obvious:
- a **green/color halo** ring (fringe not fully removed → try rembg, or `--erode 1`),
- **over-cut** edges eating into the subject (hair, a thin blade/bowstring → prefer rembg's matte, or
  loosen a chroma `--color`).

Also sanity-check the printed **coverage %** — if "subject coverage" is ~0% or ~100%, the key color was
misread; pass `--color`. Only proceed once the edge looks clean. Delete the `_preview.png` when done so
you don't leave clutter next to the user's file.

## Step 5 — (optional) Put it in Foundry

If the user wants it in the world (not just a clean file on disk):

1. `upload-asset` the PNG to `worlds/<world>/assets/tokens/<name>.png` (get `<world>` from
   `get-world-info`).
2. Assign it. **`set-actor-art` sets the portrait AND the prototype token in one call** — there is no
   "token-texture-only" path, and the actor's current portrait path can't be read back to preserve it.
   So say plainly that **both** get set; if the user wants a different portrait kept, have them supply
   it and set the portrait separately. Find the actor with `list-actors` / `get-actor`.
3. **Prototype vs placed.** Setting the prototype only affects **newly dropped** tokens. A copy already
   sitting on a scene won't change — offer to update the placed token or delete + re-drop it.

## Batch prep

For a folder of same-plate sprites, loop the script over each file (chroma is the predictable choice
here). Report anything with a suspicious coverage % for a manual look rather than silently shipping a
bad cut. Don't upload a batch to Foundry unless asked — usually the user just wants clean files.

## What this skill does NOT do

Retouch/redraw art, upscale, recolor, or crop/recenter the canvas. It removes a background to alpha,
nothing more. (A recenter/trim pass could be added later if it comes up.)
