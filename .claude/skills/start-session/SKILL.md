---
name: start-session
description: >-
  Boot the Foundry VTT world for a work session and report its state. Use when
  the user wants to start, wake, launch, or "spin up" the Foundry instance or
  world, or otherwise kick off a session — e.g. "start the world", "boot
  Foundry", "open the table", "fire up the server", "wake the box", "get the
  world up", "let's start a session". Drives the bridge's built-in cold-start
  (Magic-URL wake → world launch), then reports world / system / Foundry
  versions, active users, and the current scene. Read-only and safe to run any
  time — if the world is already up it just reports state.
---

# Start a work session

Bring the Molten-hosted Foundry world up and report its state. This is a thin
orchestration skill: the mechanics (waking the sleeping VM and launching the
world) are already baked into the bridge — **do not re-implement them here.**
Any tool call triggers the bridge's cold-start path automatically.

## How the cold-start actually works (context, not steps)

The headless bridge (`src/foundry.ts`) handles two distinct cold states on its
own, driven by `.env` config (`MOLTEN_MAGIC_URL`, `MOLTEN_ADMIN_KEY`,
`MOLTEN_WORLD_ID`):

1. **VM asleep** → the bridge GETs the Magic URL to wake the EC2 box.
2. **VM up, no world active** → the bridge logs into admin `/setup` and launches
   `MOLTEN_WORLD_ID` (`game.post({action:'launchWorld', ...})`).
3. **World booting** → it waits for the world to become joinable (~25s for the
   heavy dnd5e world, plus VM wake time on a fully cold box).

So you don't drive any of this manually. You just make one tool call and the
bridge does the rest.

## Steps

1. **Set expectations, then trigger the boot.** Tell the user a cold box can
   take ~30–60s (VM wake + ~25s world boot), then call
   `mcp__foundry-molten5e__get-world-info`. This single call wakes + launches as
   needed and returns once the world is live. (If the world was already up, it
   returns immediately.)

2. **Report the state.** Summarize the result clearly — world title/id, system
   + version, Foundry version, and active users (confirm the `MCP-Claude` GM
   bridge user is present, which doubles as a bridge-health check).

3. **Light orientation (optional).** If it's useful for what the user is about
   to do, also call `mcp__foundry-molten5e__get-current-scene` and mention the
   active scene. Keep this brief — don't enumerate the whole world unprompted.

4. **Hand off.** End by asking what they want to work on, or proceed directly if
   the user already stated the next task in the same message.

## If it fails

`get-world-info` failing almost always means the bridge couldn't reach or boot
the box — it is **not** a reason to start clicking around. Diagnose in this
order:

- **Timeout / no response on a cold box** — the VM may still be waking. Wait and
  retry the same call once before concluding anything.
- **Bridge can't wake/launch** (auth or unreachable errors) — confirm `.env` has
  `MOLTEN_MAGIC_URL`, `MOLTEN_ADMIN_KEY`, and `MOLTEN_WORLD_ID` set (check names
  only, never echo secret values). If they're missing, that's why auto-launch
  didn't fire; tell the user, and offer the manual fallback: open the Magic URL
  in a browser to wake the VM, then launch the world from Foundry's `/setup`
  page.
- **Persistent 502 / world won't boot** — the Foundry process or world may be
  broken. Report it plainly with the error; don't keep retrying in a loop.

## Boundaries

- Stay read-only. This skill only *observes* state — never create, edit, or
  delete world content as part of "starting a session."
- Don't duplicate launch logic in prose or scripts; the bridge owns it.
- This skill is just the kickoff. Once the world is up, hand off to whatever the
  user actually wants to do (or the relevant content skill, e.g. the planned
  Encounter Builder).

## ⚠️ LIVE GAME sessions: assist-only (owner directive 2026-07-08)

If the user says this is a **live session** (players at the table, game night),
the mode for the ENTIRE session is **help and assist with tasks** — nothing
else. Do NOT start redoing, recoding, or fixing tools/skills mid-game, no
matter what friction surfaces. A tool gap found live gets **marked down** (the
session's gm-notes / the dev fix-list) and fixed later in a dev session; use a
manual workaround in the moment and keep the game moving. The table's time is
the scarcest resource in the room — a mid-game rebuild risks restarts, broken
state, and lost minutes. (Dev/authoring sessions are the opposite: there,
dogfood friction means fix the tool in-session.)
