---
name: pc-builder
description: >-
  Build a COMPLETE D&D 5e player character (type:character) in Foundry — a real leveled PC, not an
  NPC: class + species + background, ability scores, the level-1 player choices (skills, expertise,
  fighting style, draconic ancestry…), spells for casters, starting equipment, and a finishing pass
  (art, the player as owner, folder). Use when the user wants to "make a PC", "build a character",
  "create a level 1 fighter", "roll up a wizard", "make my player's dragonborn paladin", "build a
  character for <player>", or pastes a character concept/sheet. Composes create-pc /
  inspect-pc-advancement (the leveling engine: advancement runs so @scale resolves NATIVELY, unlike
  an NPC) with search-compendium-* / import-item / set-actor-art / set-actor-ownership /
  move-documents and dnd5e judgment. The tools own correctness (name→uuid, advancement.apply
  sequencing, choice-data shapes, persist, @scale reporting); this skill owns the parse, the
  ability-score math, the choices, and the house rules.
---

# Player-character builder

A judgment layer over the **PC leveling engine**. It turns a character concept (a class + a few
choices, a pasted sheet, "a level-1 dragonborn fighter for Sam") into a **fully-built, ready-to-play
Foundry PC** — class/species/background with real advancement, the level-1 choices, ability scores,
spells, starting gear, and a finishing pass — by sequencing the right tool calls. It adds NO new
mechanics; the engine holds the correctness.

**PCs are a different product from NPCs (design.md §7).** A PC is `type:character` + **advancement**:
the class/species features come with `@scale.*` scaling that resolves *natively* from the character's
level (a Barbarian's rage damage, a Rogue's sneak attack, a Dragonborn's breath weapon) — you do NOT
hand-patch dangling `@scale` dice the way [[stat-block-builder]] does for NPCs. If you want a *monster*
that happens to use a PC race, that's the NPC builder; this skill is for actual player characters.

Tools used: **`create-pc`** (build + persist the PC, running advancement), **`inspect-pc-advancement`**
(read-only: what choices a class needs at a level + the legal options), `search-compendium`
(name lookup to confirm a class/species/background/spell exists in the premium books),
`search-compendium-spells` (find spells by facet for casters), **`import-item`** (starting equipment —
copy real gear from the PHB), `set-actor-art`, `set-actor-ownership` (assign the *player* as owner),
`move-documents` (file the PC), `get-actor` / `get-actor-entity` (read back). Defer gear judgment to
[[physical-item-builder]].

## Authoring policy — READ FIRST

**Follow the shared project authoring policy:** read
[`_shared/authoring-policy.md`](../_shared/authoring-policy.md) — 2024 by default · compendium-FIRST
(premium PHB/DMG/MM; copy, don't author) · **never the SRD** · custom = copy→modify→rename · no 2024
match → **STOP and ASK** · authoring, not play. `create-pc` enforces premium-only by construction: a
class/species/background not in the books is an **error, not invented**. If the user wants a class or
species that isn't in the library, stop and ask — don't substitute or fabricate.

> **v1 scope = level 1.** This builds a complete **level-1** PC (subclass comes at level 3; leveling
> 1→N, milestone ASIs/feats, and multiclassing are future versions). If the user asks for a higher
> level, build the level-1 PC and tell them leveling-up isn't wired yet.

## The shape of a build

`create-pc` takes the PC by **name**: `className` (required), optional `species` + `background`, the
**final** `abilities`, a `choices` map (the player picks), optional caster `spells`, and `level` (1).
It runs real advancement, so class/species/background **features, proficiencies, HP, and @scale all
come from the engine** — you don't add them by hand. It returns
`{success, actor, applied[], needsChoices[], unresolvedScale[], warnings[]}`.

Two things are **yours**, not the tool's:
1. **The ability-score math** — `create-pc` takes FINAL scores; you compute them (Step 2).
2. **The player choices** — skills, expertise, fighting style, ancestry, languages (Step 3).

Equipment is also yours (Step 6) — `create-pc` adds **no gear** (starting equipment vs. gold is the
player's call).

## Step 0 — Parse the concept

Pull out, asking when it's not given rather than guessing:
- **Class** (required) — and for a caster, note it (you'll pick spells in Step 5).
- **Species** (e.g. Dragonborn, Elf, Human) and **Background** (e.g. Soldier, Sage, Acolyte).
- **Ability-score method** — point-buy (default), standard array, or rolled; plus how the player wants
  them arranged across the class's key abilities.
- **The player** it's for (for ownership in Step 7) and any **flavor** (name, personality, backstory).
- **Skill / expertise / fighting-style / ancestry preferences**, if the player has them.

Confirm the class/species/background actually exist in the books with `search-compendium` (by name) if
you're unsure — a typo or a non-premium pick should surface here, not as a tool error.

## Step 2 — Ability scores → FINAL numbers (your math)

`create-pc` wants the **final** `{str,dex,con,int,wis,cha}`. Compute them:
1. **Base array** from the chosen method — point-buy (27 points, 8–15 before bonuses), the standard
   array `[15,14,13,12,10,8]`, or rolled (4d6 drop lowest). Assign to abilities to fit the class
   (e.g. a Fighter leads with STR or DEX + CON; a Wizard with INT + CON/DEX).
2. **2024 background ability increases** — in the 2024 rules the **background** grants the ability
   bumps: +2 to one and +1 to another of its three listed abilities, **or** +1/+1/+1. Add those to the
   base array. (Species do **not** grant ability increases in 2024.) `create-pc` deliberately does NOT
   apply the background's ability advancement — you bake the increase into the final numbers here, so
   it isn't double-counted.
3. Hand the result to `create-pc` as `abilities`. HP and every derived modifier re-derive from these
   (e.g. a Fighter with final CON 14 → 10 + 2 = **12 HP** at level 1).

If the user doesn't care about the spread, pick a sensible class-appropriate array and tell them what
you chose.

## Step 3 — Learn the choices, ask the player, fill the map

Level-1 PCs have **player choices** the engine won't invent (per design.md §2.1):

- **`inspect-pc-advancement`** (`className`, `level: 1`) lists the class's choice points — each with an
  **id**, type (`Trait` / `ItemChoice`), how many to pick (`count`), and the legal **options**. Use it
  to plan, and to show the player their options.
- Or just call `create-pc` with what you have; if picks are missing it returns **`success:false` +
  `needsChoices[]`** (the same descriptors, covering class **and** species **and** background) and
  **creates nothing** — no litter. Fill the map and re-call.

Build the `choices` map keyed **level → advancement-id → data**:
- **Trait pick** (skills, expertise, languages, tools, weapon masteries) → `{ chosen: [keys] }`.
  Skill keys are the 3-letter codes: `skills:acr ani arc ath dec his ins itm inv med nat prc prf per
  rel slt ste sur`. When an option is a **wildcard category** (`languages:standard:*`, `tool:game:*`,
  `weapon:mar:*`), supply a **concrete** key in that pattern (e.g. `languages:standard:elvish`); if
  you're unsure of the exact key for a language/tool/weapon, see "defaults" below.
- **ItemChoice pick** (fighting style, draconic ancestry, etc.) → `{ selected: [uuid] }` using a uuid
  from the option list (the options carry readable labels — e.g. "Archery", "Acid Breath Weapon").

Example (Fighter):
```
choices: {
  "1": {
    "<skill-prof-id>":     { chosen: ["skills:ath", "skills:prc"] },
    "<fighting-style-id>": { selected: ["Compendium.dnd-players-handbook.feats.Item.phbfstArchery000"] }
  },
  "0": { "<draconic-ancestry-id>": { selected: ["<an-ancestry-uuid>"] } }   // species choices sit at level 0
}
```

**Ask the player for the meaningful picks** (which skills, which fighting style, which dragon ancestry)
— these define the character; don't silently choose them. For purely flavor picks the player doesn't
care about, choose sensibly and say what you picked.

**Defaults escape hatch.** If some required picks are wildcard languages/tools/weapon-masteries you
can't key exactly, pass **`acceptDefaults: true`** to `create-pc`: it builds with the forced defaults
for the unsupplied picks (granted proficiencies still land) and you tell the player which choices were
left to finish on the sheet. Supply every pick you *can* (especially skills, fighting style, ancestry)
— `acceptDefaults` is for the residue, not a substitute for asking.

## Step 4 — Build the PC (`create-pc`)

Call `create-pc` with `name`, `className`, `species`, `background`, the final `abilities`, the
`choices` map, and `level: 1`. On `success`, the returned `actor` has the class/species/background
features, the chosen skills/feats, correct HP, and **resolved @scale** (empty `unresolvedScale`). If
`needsChoices[]` comes back, fill the gaps (Step 3) and re-call — nothing was created.

## Step 5 — Spells (casters)

Slots are automatic — a caster class sets up its own level-1 spell slots through advancement (a Wizard
gets its 2 first-level slots and INT casting with no extra step). You only choose **which spells**:
pass `spells: { cantrips: [names], prepared: [names] }` to `create-pc` (names from the premium PHB).
Use `search-compendium-spells` (facets: `spellLevel`, `spellSchool`, `damageType`) to find or confirm
spells. Pick the class's level-1 loadout (e.g. a Wizard's 3 cantrips + 6 spellbook spells); ask the
player for signature picks. A name not in the books is reported in `warnings` — fix or ask, don't
invent a spell.

## Step 6 — Starting equipment (your call, via `import-item`)

`create-pc` adds **no gear**. After the PC exists, compose its starting kit by **copying real items**
from the PHB/DMG with `import-item` (`actorIdentifier` = the new PC), `equipped: true` for what it
wears/wields:
- The 2024 class+background starting-equipment package, **or** the gold option if the player would
  rather buy — that's the player's choice; ask.
- Worn armor / shield, the primary weapon(s), a pack's worth of adventuring gear, and any starting
  spellbook/focus. Defer item judgment (which base, magic vs mundane) to [[physical-item-builder]].
- Copied armor doesn't auto-drive AC — if the AC looks off after equipping, set it with `update-actor`
  (a shield bonus applies under any calc).

## Step 7 — Finishing pass

- **Art** → `set-actor-art` (portrait + token from a Data-relative path; upload first if needed).
- **Ownership** → `set-actor-ownership` — assign the **player** as owner (a PC should be controlled by
  its player, not GM-only like an NPC).
- **Folder** → `move-documents` to file the PC (the engine already files new PCs under
  "Foundry MCP Characters"; move it if the table organizes differently).

## Step 8 — Read back and confirm

`get-actor` for the summary (HP/AC/abilities/skills/saves with real derived modifiers; class/species/
background; spell slots; inventory) and `get-actor-entity` to spot-check a feature's activities or a
`@scale` value. **Confirm @scale resolved** — a level-scaling feature (sneak attack, rage, breath
weapon) should show a real die, not `@scale.…` or 0. Report the full build — class/species/background,
final abilities, HP, the chosen skills/feats/fighting-style/ancestry, spells, equipment,
art/ownership/folder — and flag anything you asked about, approximated, or left to `acceptDefaults`.

## Notes

- **A new tool/param needs a Claude Code restart** to load into the running MCP server; the live verify
  script (`scripts/verify-pc-build.mjs`) bypasses this via `dist/`.
- **`@scale` is native on a PC** — do NOT hand-patch it the way the NPC builder does. If `create-pc`
  reports `unresolvedScale`, something is genuinely off (a feature with no advancement behind it);
  surface it rather than papering over it.
- Keep `sourceRules` consistent (**2024 by default**; pass `2014` only if the user explicitly wants
  legacy). The choices map is keyed by **level then advancement-id** — species/background creation
  choices sit at level `"0"`, class choices at `"1"`.
- The skill owns judgment (which class/species/background, the ability math, the picks, the gear); the
  tools own correctness (name→uuid, advancement sequencing, persist, @scale). Don't reach past that
  line — e.g. don't try to set proficiencies or HP directly; let advancement do it.
