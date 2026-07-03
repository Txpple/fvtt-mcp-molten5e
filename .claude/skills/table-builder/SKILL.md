---
name: table-builder
description: >-
  Author D&D 5e roll tables in Foundry — random encounter tables, loot/treasure tables, rumor & hook
  tables, name generators, wild-magic / effect tables, weather, and any "roll a d__ and consult the
  list" content. Use when the user wants to "make a roll table", "build a random encounter table", "a
  loot/treasure table", "a table of rumors / hooks", "a name generator", "a wild magic table", "roll
  for loot", or pastes a die-and-list table to recreate. YOU decide the CONTENTS — the entries, their
  weights, the theme; the tools only STRUCTURE it (v14 result rendering, ranges from weights, and real
  @UUID item links — never the SRD). Loot/encounter entries reference REAL compendium items & monsters
  by uuid (mix-and-match), exactly how the published tables are built. Composes create-rolltable /
  update-rolltable / roll-on-table / list-rolltables / delete-rolltable with GMing judgment.
---

# Table builder

The judgment + content layer for **roll tables** (design.md §5) — the random-generation backbone of an
adventure: what wanders out of the woods, what's in the hoard, what the tavern is whispering about. As
with every authoring skill: **you decide; the tool does.**

## The line that matters — yours vs the tool's

- **You (this skill) decide the CONTENTS** — which entries are on the table, their relative weights, the
  theme, the flavor text (rumor wording, names, weather). That judgment IS the job.
- **The tool only STRUCTURES** — it renders each entry into the correct v14 `TableResult` (the
  `description` field), auto-assigns roll ranges from weights, defaults the formula to `1d<total
  weight>`, and **validates + renders real document links** (`@UUID`). It never decides what's on the
  table and never invents an item.

## Authoring policy — what compendium-first means HERE

Read [`_shared/authoring-policy.md`](../_shared/authoring-policy.md) (2024 · compendium-first · never
SRD · ask-don't-invent). Two table-specific clarifications:

- **Compendium-first governs the game CONTENT a result REFERENCES** — the monster that ambushes, the
  magic item in the hoard, the spell a wild-magic surge mimics. Reference the **real** compendium entry
  by `uuid` (mix-and-match) so the table links the actual document with correct stats + art; **never
  transcribe or invent its stats** into the result text. This is *exactly* how the published DMG loot
  tables are built (each entry is an `@UUID` link to a real item).
- It does **NOT** constrain the **flavor text you author** — rumor wording, tavern names, weather, a
  hook's phrasing are yours to write. But don't fabricate *game* facts (a made-up item, a non-existent
  monster). If the user wants a loot table of items that aren't in the books → **STOP and ASK** (or
  offer the closest real items).

## Tools

- **`create-rolltable`** — the structuring creator (your main tool). `{ name, results[], formula?,
  replacement?, displayRoll?, folderName?, description? }`. Ranges auto-assign from weights and the
  formula defaults to `1d<total weight>` unless you pass explicit ones.
- **`import-rolltable`** — copy a whole **published** table from a compendium into the world
  (`{ packId, itemId, folderName? }`). Roll tables are world-only at roll time, so a DMG treasure /
  magic-item table must be imported before you can roll it; its results (and their @UUID item links)
  come along intact. Premium-book packs only. This is the table version of import-item — prefer it over
  hand-rebuilding a book table.
- **`update-rolltable`** — change table fields and/or edit entries, two ways. **To fix ONE entry
  (a typo, a re-link, a weight), use `editResults`** — target it by `roll` (the die face, e.g. 7 on
  a d12) or `resultId` (from get-rolltable) and patch just its `text`/`uuid`/`weight`/`range`; the
  other entries — their ranges and @UUID item links — are left untouched. `text` REPLACES that
  entry's content: copy the raw text from `get-rolltable`, change only what you need, and keep any
  `@UUID[...]` enrichers you want preserved. Supplying `results` instead **replaces the entire set**
  (deletes + recreates all entries with fresh ranges) — right for a full re-theme, wrong for a typo.
- **`roll-on-table`** — preview a draw on a **world** table (evaluates without marking drawn / posting
  to chat). A drawn loot entry's `@UUID` items come back as **importable** (uuid + label) so you can
  pull them into the world with `import-item` (see physical-item-builder).
- **`list-rolltables`** — find tables + their ids (needed to target updates/deletes/rolls).
- **`delete-rolltable`** — remove tables by exact id/name (strict, no fuzzy match).

## The result vocabulary (what you pass in `results[]`)

Each entry is `{ text?, uuid?, name?, weight?, range? }`. Provide `text` **or** `uuid` (or both):

| Field | Use it for |
|---|---|
| `text` | A literal result — a rumor, a name, coins (`"2d6 × 10 gp"`), an instruction (`"Roll twice on this table"`), flavor. HTML / `@UUID` enrichers allowed. |
| `uuid` | Link a **REAL** item / monster / spell from a premium book. Get the uuid from `search-compendium-items` / `-creatures` / `-spells`. The tool resolves its name, refuses SRD / unresolvable refs, and renders the book-style `@UUID[…]{Name}` link. World-doc uuids (`Item.<id>`) are allowed too. |
| `name` | Optional display label for the `uuid` link (default: the resolved document name). |
| `{{link}}` | A placeholder inside `text` that gets replaced by the `uuid` link — for **mixed loot**: `{ text:"A pouch holding {{link}} and 2d6 gp", uuid:"…Item.bagOfHolding" }`. Without a placeholder, the link is appended to the text. |
| `weight` | Relative likelihood (default 1). The tool maps `weight` consecutive roll values to this entry. |
| `range` | Explicit `[low, high]` — use only to mirror a **published** table's exact die bands; otherwise let weights auto-assign. |

**weight vs range:** prefer `weight` and let the tool lay out the ranges (and the `1d<total>` formula).
Reach for explicit `range` + `formula` only when recreating a printed table whose die spread you must
match exactly (e.g. a `d100` table with uneven bands).

## Table kinds — pick the contents + the shape

- **Random encounter table** — entries are real monsters linked by `uuid` (from
  `search-compendium-creatures`); `weight` the common foes higher than the rare ones. Optionally add
  `text` entries for non-combat events ("Tracks, a day old", "Distant horn"). One table per region/tier.
- **Loot / treasure table** — the magic-item idiom: each entry links a **real** DMG/PHB item by `uuid`
  (mix-and-match the hoard from actual book items), with `text` coin/gem lines. A drawn entry is
  importable straight into the world. Weight by rarity (commons heavy, legendaries rare), or mirror a
  published `d100` magic-item table with explicit ranges.
- **Rumor / hook / plot table** — pure `text`; **your prose**. Each entry a rumor the party might hear.
- **Name generator** (taverns, NPCs, ships) — pure `text`, one name per entry.
- **Wild magic / effect table** — mostly `text` describing the effect; `uuid`-link a spell when a surge
  just *is* a real spell ("Caster casts {{link}}", uuid → the spell).
- **Weather / complications** — pure `text`.

## Formula, replacement, display

- **formula** — defaults to `1d<total weight>`. Override to match a printed table (`"1d100"`, `"2d6"`).
  A `2d6`/`3d6` table is bell-curved — set explicit `range`s so the middle results are the likely ones.
- **replacement** — default `true` (each roll independent). Set `false` for **draw-without-repeats**
  (a deck of unique encounters/events that shouldn't recur in a session).
- **displayRoll** — default `true` (shows the die). Set `false` to hide the roll (a "fated" reveal).
- **folderName** — group related tables ("Encounters — Sword Coast", "Hoard Tables") for tidiness.

## Published tables (DMG treasure, magic-item tables)

The books ship ready-made tables (the DMG Arcana/Armaments/Implements/Relics × rarity magic-item
tables, the Treasure table, encounter tables). **Don't rebuild them by hand — copy them in:**

1. **`list-compendium-packs type:RollTable`** → find the pack (e.g. `dnd-dungeon-masters-guide.tables`)
   and the table's id (use `get-compendium-entry` / search to identify the exact `itemId`).
2. **`import-rolltable`** `{ packId, itemId, folderName:"DMG Treasure" }` → the table (with its @UUID
   item links) lands in the world.
3. **`roll-on-table`** on the imported table → each drawn magic item comes back as an importable
   `@UUID` (uuid + label).
4. **`import-item`** (physical-item-builder) each drawn uuid into the world to make the actual loot item.

This is the sanctioned path for "roll on the DMG treasure tables and give me the loot."

## Workflow (building a NEW table)

1. **Decide the contents.** Theme, entries, weights — your judgment. For loot/encounters, **find the
   real documents first** with `search-compendium-items` / `-creatures` (premium-only, so you get
   correct uuids) and reference them by `uuid`.
2. **Create** with `create-rolltable` (weights, or explicit ranges to match a printed table).
3. **Preview** with `roll-on-table` a few times to sanity-check the spread; a loot draw reports the
   importable item uuids.
4. **Refine** with `update-rolltable` — `editResults` for surgical fixes (one entry's text/link/
   weight/range), or `results` to replace the whole set when the table needs a full re-cut.

## Don't

- Don't invent items/monsters to fill a table — link real ones, or **STOP and ASK**.
- Don't transcribe an item's stats into the result text — link the document; the stats live there.
- Don't name an SRD (`dnd5e.*`) uuid — the tool refuses it; use the premium-book equivalent.
