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

Tools used: `create-actor` (compendium pull or authored), `update-actor`, `add-feature` (features /
compendium-features / spells), **`import-item`** (COPY gear from a compendium — the default for
inventory), `add-item` (author homebrew gear — last resort), `manage-activity`, `manage-effect`,
`apply-condition`, `set-actor-art`, `set-actor-ownership`, `move-documents`, `update-actor-item`
(per-item corrections), `search-compendium` / `search-compendium-creatures` / `get-compendium-entry`
(find things to copy), plus `get-actor` / `get-actor-entity` to read back. Defer item judgment to the
[[physical-item-builder]] skill.

> **`add-feature` invocation shape.** It takes a top-level `mode` — only `feature`,
> `compendium-features`, or `items` — plus nested params. Authoring any single
> feature/attack/save/aura/spellcasting/spells/homebrew-spell is `mode: "feature"` with
> `feature.featureType` set to that value (e.g. `mode:"feature"`, `feature.featureType:"save"`);
> importing named features is `mode: "compendium-features"` with `compendiumFeatures.featureNames`.
> Below, shorthand like "`add-feature` `save`" always means that `mode:"feature"` +
> `feature.featureType` form — `featureType` is NOT a top-level mode.

## House rules — READ FIRST (project authoring policy)

- **Default to the 2024 ruleset.** Build with the PHB / DMG / MM **2024** compendiums and
  `sourceRules: "2024"` everywhere unless the user says otherwise. (The tools now default to 2024 — keep
  it consistent across the whole build.)
- **Compendium-FIRST, everywhere — copy, don't author.** For the creature, its named traits, its spells,
  AND its gear, look in a compendium and COPY the real entry (correct stats + artwork) before authoring:
  `search-compendium-creatures` → `create-actor` (source: compendium); `add-feature` mode
  `compendium-features` for named traits; `add-feature` mode `feature` with `feature.featureType:
  "spells"` to import real spells; **`import-item`** for every piece of equipment. Author from scratch
  only when nothing fits.
- **Custom item = copy a base, then modify, then rename** (a magic weapon/shield with special powers):
  `import-item` the closest base, then `update-actor-item` / `manage-activity` / `manage-effect`, then
  rename. (See [[physical-item-builder]].)
- **If you can't find a workable 2024 match, STOP and ASK** — never silently fall back to 2014 or invent
  a value (a made-up CR, an invented damage type, a guessed price/rarity, a fabricated save DC).
- **⚠️ @scale gotcha when copying PC features onto an NPC.** 2024 class features (from the classes pack)
  and racial features (from the origins pack) are authored for PCs: their damage/uses often use a
  `@scale.*` formula whose value comes from the PC's class/species ADVANCEMENT — which an NPC doesn't
  have, so it resolves to nothing (0 damage). After importing such a feature onto an NPC, READ IT BACK
  (`get-actor-entity`) and replace any `@scale.*` damage formula with an explicit die for the creature's
  level (e.g. a level-3 dragonborn breath weapon → `1d10`). `@prof` resolves fine on NPCs; only
  advancement-fed `@scale.*` dangles. (The full advancement-driven experience belongs to the future
  PC-actor builder — see project notes.)
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

## Step 4 — Special traits, class features & racial abilities (prefer compendium import)

For official, named traits/features **prefer importing** them so the real text/mechanics + art come in,
via `add-feature` mode `compendium-features` (first-match-wins across the packs you pass):
- **Monster traits** (Pack Tactics, Nimble Escape, Magic Resistance, Multiattack) → default
  `dnd5e.monsterfeatures24`; prefer premium `dnd-monster-manual.features` when present.
- **Class features** (Lay on Hands, Channel Divinity, Fighting Style, …) → **2024 class features ARE
  importable**: the individual feature feats live in the **classes pack** (`dnd5e.classes24`, or premium
  `dnd-players-handbook.classes`), alongside the class items. The default now includes `dnd5e.classes24`.
  This is the pattern the official 2024 sample PCs use (each feature is its own `feat`).
- **Racial abilities** (a dragonborn's Breath Weapon, etc.) → copy from the **origins pack**
  (`dnd-players-handbook.origins` / `dnd5e.origins24`). E.g. a breath weapon is a `<Element> Breath
  Weapon` feat (`Fire Breath Weapon`, `Cold Breath Weapon`, …) — `import-item` it (it carries the real
  cone+line save activities, type, uses), then **fix its `@scale.*` damage formula** to an explicit die
  for the creature's level (see the @scale gotcha above). Don't author racial abilities by hand.

Only author from scratch with `add-feature` mode `feature` / `featureType: "passive"` (`featType:
"monster"`, prerequisite in `requirements`) for genuinely homebrew traits with no compendium source.

## Step 5 — Actions, attacks, and abilities

Map each action to the right tool:
- **The weapon it fights with** → COPY the real weapon from a compendium with `import-item` (it arrives
  with its attack activity + artwork), `equipped: true`. For a magic/custom weapon, copy the closest base
  then modify+rename (see [[physical-item-builder]]). Author a `weapon` with `add-item` only for true
  homebrew with no base. Either way it must be a real weapon item with an attack so to-hit/damage derive
  from it — not a generic natural strike.
- **Natural attacks** (claws/bite/etc.) → `add-feature` `attack` (`weaponClass: "natural"`).
- **Attack that also forces a save** (e.g. Stinger: pierce + CON save) → `add-feature` `attack-with-save`.
- **Save-or-suffer ability** (frightful presence, a homebrew breath) → `add-feature` `save` (+ `areaType`).
  But a **racial breath weapon** (dragonborn) should be COPIED from the origins pack (Step 4) — copy the
  `<Element> Breath Weapon` feat, then fix its `@scale.*` damage die — not authored.
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

## Step 8 — Inventory, gear & loot (compendium-first via `import-item`)

Build the rest of what the creature carries and drops — COPY from the 2024 PHB/DMG compendiums first;
defer item judgment to [[physical-item-builder]]:
- **Find then copy:** `search-compendium` the gear (prefer `dnd-players-handbook.equipment`,
  `dnd-dungeon-masters-guide.equipment`, `dnd5e.equipment24`) → `import-item` (`packId` + `itemId`,
  `actorIdentifier`). Copies bring correct stats AND art.
- **Worn armor / shield** → `import-item` the real armor/shield. Copied armor doesn't auto-drive AC; set
  the actor's AC with `update-actor` if needed (a shield's bonus applies under any calc). When you must
  AUTHOR body armor via `add-item`, pass `wireAc: true` to switch the actor to armor-based AC.
- **Carried gear, consumables, loot** → `import-item` potions/scrolls, magic trinkets, tools, gems. Use
  `equipped: false` for stowed items, `identified: false` for mystery loot.
- **Custom magic gear** → copy the closest base, then modify (`update-actor-item` / `manage-activity` /
  `manage-effect`) and rename. Author with `add-item` only as a last resort (and ASK first).
- **Containers** → copy/create a `container` first, then place items with `container: "<name>"`.
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
- Keep `sourceRules` consistent across the build — **2024 by default** (the tools default to 2024; pass
  `2014` only when the user explicitly wants legacy content).
- Per-item corrections after the fact → `update-actor-item` (dot-path patch); per-actor corrections →
  `update-actor`.
