---
name: stat-block-builder
description: >-
  Build a COMPLETE D&D 5e NPC in Foundry from a pasted/described stat block — not just the mechanics,
  the whole creature: all stats, special traits, actions/attacks, spells, effects, AND its inventory
  (the magic weapon it fights with, worn armor, carried gear, consumables, loot, coins), biography, and
  a finishing pass (art, ownership, folder). Use when the user wants to "build this monster", "make an
  NPC from this stat block", "stat out <creature>", "create a creature from this text", "build the boss
  with its gear and loot", or pastes a Monster-Manual-style block. Composes the actor-authoring tools
  (create-actor, update-actor, add-feature, manage-activity, manage-effect, apply-condition, add-item,
  set-actor-art, set-actor-ownership, move-documents) into one coherent build with dnd5e judgment. The
  tools own correctness (field paths, activity/effect/item shapes, name→id, soft validation); this skill
  owns the parse, the orchestration, and the house rules.
---

# Complete-NPC builder

A judgment layer over the actor-authoring tools. It turns a stat block (pasted text, a Monster Manual
entry, or a freeform description) into a **fully-built, ready-to-play Foundry NPC** — base stats,
defenses, senses, special traits, actions, spellcasting, effects, **its full inventory and loot**,
biography, and a finishing pass — by sequencing the right tool calls. It adds NO new mechanics; every
tool it calls holds its own correctness.

Tools used: `create-actor` (authored), `update-actor`, `add-feature`, `manage-activity`,
`manage-effect`, `apply-condition`, **`add-item`** (inventory/loot — defer item judgment to the
[[physical-item-builder]] skill), `set-actor-art`, `set-actor-ownership`, `move-documents`,
`update-actor-item` (per-item corrections), plus `get-actor` / `get-actor-entity` to read back. Pull
from a compendium instead when the creature or a feature already exists there (Steps 0 and 4).

## House rules (from the project authoring policy)

- **Prefer official 2024 content from PHB / DMG / MM.** If the creature (or a spell/feature it has)
  exists in a compendium, prefer pulling it: `search-compendium-creatures` → `create-actor` (source:
  compendium), `grant-to-actor` compendium-features for named traits, `add-feature` `spells` for real
  spells. Authoring from scratch is for homebrew or when the source isn't installed.
- **If something is ambiguous or clearly homebrew, STOP and ASK** rather than silently inventing values
  (a made-up CR, an invented damage type, a guessed price/rarity, a fabricated save DC).
- Set `sourceRules` to `2024` for new MM-2024 creatures (the default is `2014` — pass `2024` explicitly).
- This is AUTHORING. Don't place tokens on a scene, roll dice, spend charges, or run combat — those are
  out of scope (the prototype-token config travels with the actor, but dropping a token is play).

## Step 0 — Compendium first, then author

Before building by hand, check if the creature is in a compendium (`search-compendium-creatures`). If
it is and the user just wants it in the world, `create-actor` (source: compendium) and you're nearly
done — only fall through to authoring for tweaks, added gear, or genuinely homebrew creatures.

## Step 1 — Parse the stat block into sections

Read the block and pull out, in this order:
- **Header:** name, size, creature type (+ subtype), alignment.
- **Core:** AC (+ how it's derived), HP (average + formula), speeds (walk/fly/swim/climb/burrow, hover).
- **Abilities:** STR/DEX/CON/INT/WIS/CHA. **Saving throws**. **Skills** (proficient vs expertise).
- **Defenses:** damage immunities / resistances / vulnerabilities, condition immunities.
- **Senses:** darkvision/blindsight/tremorsense/truesight + passive Perception; **Languages** (+ telepathy). **CR**.
- **Traits** (passive, no roll): Magic Resistance, Pack Tactics, Regeneration, etc.
- **Actions / Bonus Actions / Reactions:** Multiattack, melee/ranged attacks, save-based abilities, heals.
- **Legendary actions / resistances / lair actions.**
- **Spellcasting** (innate or class-based).
- **Equipment / Gear / Treasure:** the weapon(s) it wields, worn armor/shield, carried items, consumables,
  loot, and coins. (Often only implied — a knight has plate + a sword; infer reasonably or ask.)

If a section is missing or unreadable, ask before guessing.

## Step 2 — Create the base actor

`create-actor` with `source: "authored"` and the `statBlock` (the NPC builder sets abilities, saves,
HP, AC, movement, senses, CR, type, size, skills, languages, defenses in one call).

## Step 3 — Actor-level edits (`update-actor`)

Immediately `update-actor` for anything the base builder doesn't cover or that you want to set precisely:
`telepathy`, `legendaryActions`, `legendaryResistances`, `lair`, 2024 `habitat` / `treasure`,
`biography`, `source`, and **`currency`** (the creature's coin purse — `{mode:"set", gp, sp, …}`). Use
`update-actor` for ALL later actor-level corrections too (Set fields take `mode: replace|add|remove`).

## Step 4 — Special traits (prefer compendium import)

For official, named traits **prefer importing** them so the real text/mechanics come in:
`grant-to-actor` mode `compendium-features` (e.g. Pack Tactics, Nimble Escape, Magic Resistance,
Multiattack). Only author from scratch with `add-feature` `passive` (`featType: "monster"`, prerequisite
in `requirements`) for homebrew traits or ones not in a compendium.

## Step 5 — Actions, attacks, and abilities

Map each action to the right tool:
- **The weapon it fights with** → build it as a REAL `add-item` `weapon` (with `damage`, `magicalBonus`
  if magic, `properties`, `equipped: true`, and the attack activity on by default) so the attack derives
  from the actual weapon — not a generic natural strike. Defer item judgment to [[physical-item-builder]].
- **Natural attacks** (claws/bite/etc.) → `add-feature` `attack` (`weaponClass: "natural"`).
- **Attack that also forces a save** (e.g. Stinger: pierce + CON save) → `add-feature` `attack-with-save`.
- **Save-or-suffer ability** (breath weapon, frightful presence) → `add-feature` `save` (+ `areaType`).
- **Automatic-damage aura** → `add-feature` `aura`.
- **Multiattack** → import it (Step 4) or author a `passive` named "Multiattack" with the text;
  optionally give it a clickable action via `manage-activity` (`utility`).
- For an action that needs a rollable button or a second activity on an existing item → `manage-activity`
  (`add`/`edit`/`remove`/`list`).

## Step 6 — Spells

Class-based → `add-feature` `spellcasting` (sets slots) then `spells` (import the real spells by name).
Innate / homebrew → `add-feature` `homebrew-spell` (`spellMethod: "innate"`, components, optional
`spellActivity`).

## Step 7 — Effects and starting conditions

For ongoing derived modifiers that aren't a base-stat value (a permanent +1 AC aura, granted resistance)
→ `manage-effect` (`create`, `changes: [{key, value, type}]`). Prefer putting *static* defenses (fixed
resistances, a fixed AC) on the actor via `update-actor`; reserve effects for toggleable/derived bonuses.
Conditions the creature *starts* with (rare) → `apply-condition`.

## Step 8 — Inventory, gear & loot (`add-item`)

Build the rest of what the creature carries and drops — defer item judgment to [[physical-item-builder]]:
- **Worn armor / shield** → `add-item` `armor` / `shield`. Pass `wireAc: true` on **body armor** if the
  NPC's AC should derive from it (skip for natural-armor monsters; a shield needs no `wireAc` — its +2
  applies under any AC calc).
- **Carried gear, consumables, loot** → `add-item` `consumable` (potions/scrolls), `loot` (gems/trade
  goods), `tool`, `wondrous` (magic trinkets). Use `equipped: false` for stowed items, `identified:
  false` for mystery loot, `attunement` for magic items.
- **Ammunition** → `add-item` `consumable` `ammo` with a `quantity`.
- **Containers** → create a `container` first, then add items with `container: "<name>"` to nest them.
- **Coins** → already on the actor via `update-actor` `currency` (Step 3).

## Step 9 — Biography

If not set in Step 3, `update-actor` `biography` (HTML) — lore, tactics, appearance, roleplay notes.

## Step 10 — Finishing pass

- **Art** → `set-actor-art` (portrait + token texture from a Data-relative path; upload first if needed).
- **Ownership** → `set-actor-ownership` (most NPCs stay GM-only; grant the party observer access to a
  visible ally if wanted).
- **Folder** → `move-documents` to file the finished NPC somewhere findable.

## Step 11 — Read back and confirm

`get-actor` for the summary (HP/AC/abilities/skills/saves show real derived modifiers; inventory shows
equipped/attunement/quantity; coins show under currency) and `get-actor-entity` to spot-check a specific
item's activities. Report the full build — base stats, traits, each action/attack, spells, effects,
**inventory + loot + coins**, biography, art/ownership/folder — and flag anything you had to ask about
or approximate.

## Notes

- **A new tool/param needs a Claude Code restart** to load into the running MCP server; the live
  acceptance scripts bypass this via `dist/`.
- Names must be unique on the actor — `add-feature` and attacks reject a duplicate name; rename or remove
  first. (`add-item` allows duplicate stacks.)
- Keep `sourceRules` consistent across the build (a 2024 creature: pass `2024` everywhere).
- Per-item corrections after the fact → `update-actor-item` (dot-path patch); per-actor corrections →
  `update-actor`.
