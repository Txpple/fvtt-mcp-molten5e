---
name: stat-block-builder
description: >-
  Build a complete D&D 5e creature in Foundry from a pasted/described stat block. Use when the user
  wants to "build this monster", "make an NPC from this stat block", "stat out <creature>", "create a
  creature from this text", "add this monster to the world", or pastes a Monster-Manual-style block and
  wants it as a Foundry actor. Composes the actor-authoring tools (create-actor, update-actor,
  add-feature, manage-activity, manage-effect, apply-condition) into one coherent build with dnd5e
  judgment. The tools own correctness (field paths, activity/effect shapes, name→id, soft validation);
  this skill owns the parse + the orchestration + the house rules.
---

# Stat-block builder

A judgment layer over the actor-authoring tools. It turns a stat block (pasted text, a Monster Manual
entry, or a freeform description) into a fully-built Foundry NPC — base stats, defenses, senses,
features, attacks, spellcasting, and persistent effects — by sequencing the right tool calls. It adds
NO new mechanics; every tool it calls holds its own correctness.

Tools used: `create-actor` (authored), `update-actor`, `add-feature`, `manage-activity`,
`manage-effect`, `apply-condition`, plus `get-actor` / `get-actor-entity` to read back. Pull from
compendium instead when the creature already exists there (see Step 0).

## House rules (from the project authoring policy)

- **Prefer official 2024 content from PHB / DMG / MM.** If the creature (or a spell it casts) exists in
  a compendium, prefer pulling it: `search-compendium-creatures` → `create-actor` (source: compendium),
  or `add-feature` featureType `spells` to import real spells. Authoring from scratch is for homebrew or
  when the source isn't available.
- **If something is ambiguous or clearly homebrew, STOP and ASK** rather than silently inventing values
  (a made-up CR, an invented damage type, a guessed save DC).
- Set `sourceRules` to `2024` for new MM-2024 creatures (the default is `2014` — pass `2024` explicitly).
- This is AUTHORING. Don't place tokens, roll dice, or run combat — those are out of scope.

## Step 0 — Compendium first, then author

Before building by hand, check if the creature is in a compendium (`search-compendium-creatures`). If
it is and the user just wants it in the world, `create-actor` (source: compendium) and you're done —
only fall through to authoring for tweaks or genuinely homebrew creatures.

## Step 1 — Parse the stat block into sections

Read the block and pull out, in this order:
- **Header:** name, size, creature type (+ subtype), alignment.
- **Core:** AC (+ how it's derived), HP (average + formula), speeds (walk/fly/swim/climb/burrow, hover).
- **Abilities:** STR/DEX/CON/INT/WIS/CHA. **Saving throws** (proficient abilities). **Skills**
  (proficient vs expertise).
- **Defenses:** damage immunities / resistances / vulnerabilities, condition immunities.
- **Senses:** darkvision / blindsight / tremorsense / truesight + passive Perception; **Languages**
  (+ telepathy). **CR**.
- **Traits** (passive, no roll): Magic Resistance, Pack Tactics, Regeneration, etc.
- **Actions / Bonus Actions / Reactions:** Multiattack, melee/ranged attacks, save-based abilities
  (breath weapons), heals.
- **Legendary actions / resistances / lair actions.**
- **Spellcasting** (innate or class-based).

If a section is missing or unreadable, ask before guessing.

## Step 2 — Create the base actor

`create-actor` with `source: "authored"` and the `statBlock` (the NPC builder sets abilities, saves,
HP, AC, movement, senses, CR, type, size, skills, languages, defenses in one call). Then immediately
`update-actor` for anything the base builder doesn't cover or that you want to set precisely:
`telepathy`, `legendaryActions`, `legendaryResistances`, `lair`, 2024 `habitat` / `treasure`,
`biography`, `source`. Use `update-actor` for ALL later corrections too — it's the single editor for
the stat block (Set fields take `mode: replace|add|remove`).

## Step 3 — Add features, attacks, and abilities (`add-feature`)

Map each action/trait to the right `add-feature` mode:
- **Passive trait** (no roll) → `passive` (e.g. Magic Resistance, Pack Tactics). Use `featType`
  `"monster"` and put any prerequisite in `requirements`.
- **Multiattack** → `passive` named "Multiattack" with the text. Optionally also give it a clickable
  action button via `manage-activity` (Step 4).
- **Weapon attack** (to-hit + damage) → `attack` (`weaponClass: "natural"` for claws/bite/etc).
- **Attack that also forces a save** (e.g. Stinger: pierce + CON save or poison) → `attack-with-save`.
- **Save-or-suffer ability** (breath weapon, frightful presence) → `save` (with an `areaType` if it's a
  cone/sphere/etc).
- **Automatic-damage aura** (damage to everything in range, no roll) → `aura`.
- **Spellcasting:** class-based → `spellcasting` (sets slots) then `spells` (import the real spells by
  name). Innate / homebrew spells → `homebrew-spell` (set `spellMethod: "innate"`, components, and an
  optional `spellActivity` for its mechanics).

## Step 4 — Activities for actions that need a button (`manage-activity`)

For an action whose feature was created as a passive/`feat` but should be *rollable* (e.g. a
Multiattack with a utility action, or adding a second activity to an existing item), use
`manage-activity` (`action: "add"`, `type: attack|save|damage|heal|check|utility`). Use
`action: "list"` to find activity ids, then `edit`/`remove` by id.

## Step 5 — Persistent mechanical bonuses (`manage-effect`)

For ongoing numeric/derived modifiers that aren't a base-stat value — e.g. a permanent +1 AC aura, a
shield-of-faith-style bonus, a resistance granted by an effect — author an **ActiveEffect** with
`manage-effect` (`action: "create"`, `changes: [{key, value, type}]`). Prefer putting *static* defenses
(fixed damage resistances, a fixed AC) directly on the actor via `update-actor`; reserve effects for
things modeled as toggleable/derived modifiers.

(Conditions the creature *starts* with — rare for a stat block — use `apply-condition`.)

## Step 6 — Read back and confirm

`get-actor` for the summary (HP/AC/abilities/skills/saves now show real derived modifiers) and
`get-actor-entity` to spot-check a specific item's activities. Report what was built — base stats,
each feature/attack, spellcasting, effects — and flag anything you had to ask about or approximate.

## Notes

- **A new tool/param needs a Claude Code restart** to load into the running MCP server; the live
  acceptance script bypasses this via `dist/`.
- Names must be unique on the actor — `add-feature` and attacks reject a duplicate name; rename or
  remove first.
- Keep `sourceRules` consistent across the build (a 2024 creature: pass `2024` everywhere).
