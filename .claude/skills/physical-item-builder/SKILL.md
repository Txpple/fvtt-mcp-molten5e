---
name: physical-item-builder
description: >-
  Author D&D 5e physical items — weapons, armor, shields, wondrous items, potions/scrolls, ammunition,
  tools, gems/trade-goods loot, and containers — as Foundry items. Use when the user wants to "make a
  magic sword", "create a +1 longsword", "add a healing potion", "give this NPC some loot / treasure /
  gear", "stat out this magic item", "build a flame tongue", "fill this chest with loot", or pastes a
  DMG-style item entry. COMPENDIUM-FIRST: it copies the real PHB/DMG 2024 item (correct stats + art)
  with import-item, modifies + renames a copied base for custom items, and only authors from scratch
  with add-item as a last resort. Composes import-item / add-item / update-actor (coins) /
  update-actor-item / manage-activity / manage-effect with dnd5e judgment: itemType choice, rarity↔price
  sanity, the magic-item rule, attunement defaults, equipped vs carried, identified vs mystery loot,
  container nesting. The tools own correctness (field paths, shapes, soft validation); this skill owns
  the parse, the choices, and the house rules.
---

# Physical-item builder

A judgment layer for putting D&D 5e gear into Foundry. It turns an item description — a DMG entry, a
stat-block "Equipment" line, or "give the boss a flaming greatsword" — into correctly-shaped, **art-
bearing, edition-correct** Foundry items. It adds NO new mechanics; the tools hold the field shapes.

## Authoring policy — READ FIRST

**Follow the shared project authoring policy:** read
[`_shared/authoring-policy.md`](../_shared/authoring-policy.md) (`.claude/skills/_shared/authoring-policy.md`)
— 2024 by default · compendium-FIRST (copy the real PHB/DMG item with `import-item`, even for plain gear;
don't author) · **never the SRD** · custom = copy a base → modify → rename · can't find a 2024 match →
**STOP and ASK** (never fall back to 2014/SRD, never invent a rarity/price/damage die) · authoring, not
play. The **item-specific** shaping rules are in "House rules for shaping items" below.

Tools: **`import-item`** (copy from a compendium — the default path), **`search-compendium-items`**
(faceted discovery by rarity / subtype / magical — the default way to *find* gear), **`search-compendium`**
(broad name lookup) / **`get-compendium-entry`** (confirm the entry; you copy by the hit's `pack` + `id`),
**`add-item`** (author from scratch — homebrew last resort only), **`update-actor`** (actor
`currency`/coins), **`update-actor-item`** / **`manage-activity`** / **`manage-effect`** (modify a copied
base into a custom item), **`get-actor` / `get-actor-entity`** (read back).

## Target: actor inventory vs world library

- Pass **`actorIdentifier`** to put the item on an NPC/PC (its inventory).
- Omit it (optionally pass **`folder`**) to create a reusable world Item in the sidebar — for a shared
  treasure library or loot handed out later.

## Step 0 — Find it in the compendium (the default path)

Discover the item with **`search-compendium-items`** — faceted by `documentType`
(gear|weapon|armor|consumable), `rarity`, `itemType` (subtype: wondrous / potion / ring / wand / …),
`magical`, and `name`. It searches the **premium books ONLY** (never the `dnd5e.*` SRD, design.md §2.3)
and ranks them first, so you don't reason about pack ids. (For a quick exact-name lookup,
`search-compendium` by name also works.) Confirm a hit with `get-compendium-entry` if you need the full
entry, then copy it with **`import-item`** (`packId` = the hit's `pack`, `itemId` = its `id`, plus
`actorIdentifier` or `folder`). On-copy you can `name`-rename, set `quantity`, `equipped`, `identified`,
or nest in a `container`. Done — it has the right stats and art.

## Step 1 — Custom or magic variant (copy a base, then modify, then rename)

If the exact item isn't in a compendium but a close base IS (the common case for homebrew magic items):

1. **Copy the closest base** with `import-item` — e.g. a `Shield` or `+1 Shield` from the DMG, a plain
   `Mace`, a `Longsword`.
2. **Modify it** to match the concept:
   - `update-actor-item` (dot-path patch) — bump `system.armor.magicalBonus`/weapon `magicalBonus`,
     add `system.uses` (charges, e.g. 1/day at dawn), edit the description, set rarity/price.
   - `manage-activity` — add/edit a rollable activity (an extra damage rider, a utility action).
   - `manage-effect` — model a passive bonus a wondrous item grants (a Cloak of Protection's +1 AC/saves
     has no numeric field; it MUST be an ActiveEffect).
3. **Rename** to the custom name (`import-item`'s `name` on copy, or `update-actor-item`).

> **If `import-item` reports `unresolvedScale`** (rare — a magic-item feature rider whose damage/uses
> use an advancement-fed `@scale.*` formula), it's flagging a dangling token as a fact, just like the
> NPC case. Set an explicit value at the reported `path` with `update-actor-item`; the tool reports the
> token, you choose the die (design.md §2.1).

## Items that cast a spell → a `cast` activity that LINKS the real spell (NOT a hand-rolled one)

A wand/weapon/wondrous item that casts a spell (a Wand of Fireballs, a sword that casts *fireball*, a
shield that casts *shield*) must model the spell as a **`cast` activity that links the REAL book spell** —
**never** a hand-rolled `save`/`damage`/`utility` activity that re-implements it. The cast activity makes
Foundry cast the genuine spell, so its **measured template (sphere/line/cube), save/attack, scaling and
effects all come from the spell for free**. A hand-rolled stand-in has none of that — it shows in the use
menu but does **NOT** actually cast (no template pops). This is the #1 magic-item mistake; don't make it.

- **The spell is compendium-first too.** It MUST be a real 2024 book spell. If a named spell isn't in the
  books (e.g. *Snilloc's Snowball Swarm*), **STOP and ASK** — substitute a real spell, drop it, or get
  explicit homebrew permission. NEVER fabricate a fake activity to stand in for an off-book spell (same
  rule as a monster's off-book feature — see `_shared/authoring-policy.md`, design.md §2.3).
- **Build it by mirroring the DMG Wand of Fireballs (`dmgWandOfFirebal`).** `manage-activity` has **no
  `cast` type**, so write the activity JSON via **`update-item`** `system.activities.<16-char-id>` (it
  deep-merges — the weapon's base Attack is preserved). Get the spell uuid from `search-compendium`
  (it's `Compendium.<pack>.Item.<id>`). Minimal shape:
  ```
  system.activities.<id> = {
    type:"cast", _id:"<16char>", name:"Cast <Spell> (<lvl>, DC <n>)", sort:0,
    spell:{ uuid:"Compendium.dnd-players-handbook.spells.Item.<spellId>",
            challenge:{ save:<DC>, attack:<+N|null>, override:true },  // override:true pins the item's fixed DC/attack; false = defer to the caster
            level:<slot lvl>, properties:[<components>], spellbook:true },
    activation:{ type:"action"|"bonus"|"reaction", value:null, override:false },
    consumption:{ spellSlot:false, scaling:{allowed:false,max:""},
                  targets:[{ type:"itemUses", value:"<charges>", target:"", scaling:{mode:"",formula:""} }] },  // []  == at-will (cantrip)
    range:{units:"self",override:false}, duration:{units:"inst",concentration:false,override:false},
    target:{ template:{contiguous:false,units:"ft",stationary:false}, affects:{choice:false}, override:false, prompt:true },
    uses:{spent:0,recovery:[],max:""}, description:{chatFlavor:""}, img:"", flags:{},
    visibility:{level:{},requireAttunement:false,requireIdentification:false,requireMagic:false} }
  ```
  Charges live on the ITEM (`system.uses.max` + `recovery:[{period:"dawn",type:"recoverAll"|"formula",formula}]`);
  the cast activity's `consumption.targets` spends them. The `save` DC is set but **sanitized from
  read-back** (data is correct; `attack` shows). To swap a wrong activity for a cast: `manage-activity
  remove` the old, then `update-item` add the cast.
- **⚠️ Placed copies do NOT auto-update.** Dragging an item onto an actor makes an independent COPY;
  editing the world item afterward does not touch copies already on actors — they go stale. After any
  fix, **re-drag** the item (or edit the on-actor copy directly). Tell-tale that you're looking at a
  stale copy: the on-sheet activity shows an OLD name/behaviour. Always test on a freshly-placed copy.

## Step 2 — True homebrew with no compendium base (last resort — ASK first)

Only when nothing in any compendium fits, author from scratch with **`add-item`** (pick `itemType`,
supply the fields). Because this skips the compendium (no art, GM-judged stats), **tell the user you're
authoring from scratch and confirm the key values** (rarity, price, damage) rather than inventing them.

### itemType reference (for the add-item author path)

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

## House rules for shaping items (apply to copied OR authored items)

- **Magic items need only `magicalBonus` and/or `magical: true`** — the `mgc` property is added for you.
  The numeric `+N` is stored only where dnd5e has a field: **weapons, body armor, magic ammunition**. A
  **wondrous item or potion has no `+N` field** — flag it `magical` and model the bonus as an
  ActiveEffect (`manage-effect`).
- **Attunement defaults:** most `+N` gear and wondrous items are `attunement: "required"`; potions,
  scrolls, ammo, mundane gear are `""`. Set `attuned: true` only if the owner is actively attuned
  (≤ 3-item limit).
- **Rarity ↔ price sanity** (rough DMG guide): common ~50–100 gp, uncommon ~101–500, rare ~501–5,000,
  very rare ~5,001–50,000, legendary 50,000+. Mundane gear uses its PHB price and `rarity: ""`.
- **Equipped vs carried:** the weapon/armor an NPC uses → `equipped: true`; spare loot → `equipped: false`.
- **Identified vs mystery loot:** treasure discovered unidentified → `identified: false`.
- **The weapon a creature fights with must be a real `weapon` item with an attack** so to-hit/damage
  derive from it — a copied PHB weapon already has its attack activity; an authored one needs `withAttack`
  (the default when `damage` is given).
- **Worn armor and AC:** adding body armor does not change an NPC's AC unless the actor derives AC from
  it. When authoring body armor with `add-item`, pass `wireAc: true` to switch the actor to armor-based
  AC. (A copied armor item is just an item — set the actor's AC calc with `update-actor` if needed; a
  shield's bonus applies under any calc.)

## Coins and containers

- **Coins are actor-level, not an item.** Set a purse with `update-actor`
  `currency: { mode: "set"|"add", pp, gp, ep, sp, cp }`. A container can hold its own coins via the
  `currency` param.
- **Nesting:** create/copy the `container` first, then place items with `container: "<name or id>"`.

## Read back and confirm

`get-actor` for the inventory summary (equipped/attunement/quantity) and `get-actor-entity` to
spot-check one item's full system data (and that copied art/activities came across). Report what was
built — each item, where it was copied from (or that it was authored), its rarity/bonus/attunement, and
any coins — and flag anything you had to ask about or approximate.

## Notes

- **A new tool/param needs a Claude Code restart** to load into the running MCP server; the live
  acceptance script (`scripts/verify-item-tooling.mjs`) bypasses this via `dist/`.
- Authoring only — this does not equip-in-combat, roll attacks, or spend charges/uses.
- `create-item` / `add-feature` (mode `items`) remain the raw `system`-data passthrough for edge cases;
  `update-actor-item` patches any field by dot-path after the fact.
