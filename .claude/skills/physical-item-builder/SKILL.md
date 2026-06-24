---
name: physical-item-builder
description: >-
  Author D&D 5e physical items — weapons, armor, shields, wondrous items, potions/scrolls, ammunition,
  tools, gems/trade-goods loot, and containers — as Foundry items via the add-item tool. Use when the
  user wants to "make a magic sword", "create a +1 longsword", "add a healing potion", "give this NPC
  some loot / treasure / gear", "stat out this magic item", "build a flame tongue", "fill this chest
  with loot", or pastes a DMG-style item entry. Composes add-item (plus update-actor currency for coins
  and update-actor-item for corrections) with dnd5e judgment: itemType choice, rarity↔price sanity, the
  magic-item rule, attunement defaults, equipped vs carried, identified vs mystery loot, and container
  nesting. The tools own correctness (field paths, shapes, soft validation); this skill owns the parse,
  the choices, and the house rules.
---

# Physical-item builder

A judgment layer over `add-item` (the structured dnd5e physical-item builder). It turns an item
description — a DMG entry, a stat-block "Equipment" line, or "give the boss a flaming greatsword" — into
correctly-shaped Foundry items: weapons, armor, consumables, loot, and containers. It adds NO new
mechanics; `add-item` holds the field shapes and soft validation.

Tools used: `add-item` (the builder), `update-actor` (for actor-level **coins/currency**),
`update-actor-item` (per-item corrections), `get-actor` / `get-actor-entity` (read back). For an item's
*reference* values you may consult `search-compendium` / `get-compendium-entry`, but authoring goes
through `add-item`.

## Target: actor inventory vs world library

- Pass **`actorIdentifier`** to put the item directly on an NPC/PC (its inventory).
- Omit it (optionally pass **`folder`**) to create a reusable world Item in the Items sidebar — the right
  call for a shared treasure library or loot you'll hand out later.

## Step 1 — Parse the item

Pull out: the **kind** (weapon? armor? potion? gem?), whether it's **magic** (and the **+N** bonus),
its **rarity**, **attunement**, **price/weight**, **quantity**, and — for a weapon — its **damage**.
If a value is genuinely ambiguous or clearly homebrew (an invented rarity, a made-up price, an unclear
damage die), **STOP and ASK** rather than inventing it.

## Step 2 — Choose the itemType

| The item is… | `itemType` | Key params |
|---|---|---|
| A weapon (sword, bow, claws) | `weapon` | `damage`, `weaponClass`, `attackType`, `reachFt`/`rangeFt` |
| Body armor | `armor` | `armorType` (light/medium/heavy), `armorValue`, `dex`, `strength` |
| A shield | `shield` | `armorValue` (default +2) |
| A ring / cloak / wondrous item | `wondrous` | `equipmentType`, `magical`, `attunement` |
| Potion / scroll / wand / poison | `consumable` | `consumableType`, `uses` |
| Arrows / bolts / bullets | `consumable` | `consumableType: "ammo"`, `subtype`, `quantity`, `damage` |
| Artisan tools / instrument / kit | `tool` | `toolType`, `ability`, `proficient` |
| Gem / art object / trade good / junk | `loot` | `lootType`, `price` |
| Bag / chest / pouch | `container` | `capacity`, `currency` |

## Step 3 — Apply the house rules

- **Magic items need only `magicalBonus` and/or `magical: true`** — `add-item` adds the `mgc` property
  for you. The numeric `+N` is stored only where dnd5e has a field for it: **weapons, body armor, and
  magic ammunition** (`magicalBonus: 1` → a `+1` longsword). A **wondrous item or potion has no `+N`
  field** — use `magical: true` for the flag and model the actual bonus as an ActiveEffect with
  `manage-effect` (e.g. Cloak of Protection's +1 to AC and saves).
- **Attunement defaults:** most `+N` gear and wondrous items are `attunement: "required"`; potions,
  scrolls, ammunition, mundane gear are `""` (none). Set `attuned: true` only if the owner is actively
  attuned (and within the 3-item limit).
- **Rarity ↔ price sanity** (rough DMG guide — confirm, don't over-precision): common ~50–100 gp,
  uncommon ~101–500, rare ~501–5,000, very rare ~5,001–50,000, legendary 50,000+. Mundane gear uses
  its PHB price and `rarity: ""`.
- **Equipped vs carried:** the weapon/armor an NPC actually uses → `equipped: true` (the default for
  NPCs). Spare loot in a pack → `equipped: false`.
- **Identified vs mystery loot:** treasure the party will discover unidentified → `identified: false`
  (the GM still sees the real item).
- **The weapon a creature fights with must be a real `weapon` item with `withAttack` on** (the default
  when `damage` is given) so its attack derives from the weapon — otherwise a "+1 sword" is cosmetic and
  the to-hit/damage are wrong. Build the sword, don't just describe it.
- **Worn armor and AC:** adding armor does not change an NPC's AC unless the actor derives AC from it.
  Pass `wireAc: true` when you want the NPC's AC to come from the armor you're equipping (it switches
  the actor to the default armor-based AC calc). Leave it off for a monster with natural-armor AC.

## Step 4 — Coins and containers

- **Coins are actor-level, not an item.** Set a creature's purse with `update-actor`
  `currency: { mode: "set"|"add", pp, gp, ep, sp, cp }` — `add` (negatives allowed) for looting/spending,
  `set` to author the starting pile. A container can hold its own coins via the `currency` param on the
  `container` item.
- **Nesting:** create the `container` first, then add items with `container: "<container name or id>"` to
  place them inside it.

## Step 5 — Read back and confirm

`get-actor` for the inventory summary (equipped/attunement/quantity show up) and `get-actor-entity` to
spot-check one item's full system data. Report what was built — each item, its rarity/bonus/attunement,
and any coins — and flag anything you had to ask about or approximate.

## Notes

- **A new tool/param needs a Claude Code restart** to load into the running MCP server; the live
  acceptance script (`scripts/verify-item-tooling.mjs`) bypasses this via `dist/`.
- Authoring only — this does not equip-in-combat, roll attacks, or spend charges/uses.
- For free-form/edge-case `system` data the builder doesn't surface, `create-item` / `grant-to-actor`
  (items) remain the raw passthrough, and `update-actor-item` patches any field by dot-path after the
  fact.
