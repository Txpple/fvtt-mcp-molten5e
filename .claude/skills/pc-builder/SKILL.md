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

Tools used: **`create-pc`** (build + persist the PC, running advancement), **`create-pc-from-prefab`**
(copy a premium PHB pregen as a base, then tweak — the fast path when a stock build fits),
**`level-up-pc`** (add ONE class level to an existing PC — single-class level-up OR multiclass),
**`inspect-pc-advancement`**
(read-only: what choices a class needs at a level + the legal options), `search-compendium`
(name lookup to confirm a class/species/background/spell exists in the premium books),
`search-compendium-spells` (find spells by facet for casters), **`import-item`** (starting equipment —
copy real gear from the PHB), `add-feature` (a feat taken at an ASI tier), `set-actor-art`,
`set-actor-ownership` (assign the *player* as owner), `move-documents` (file the PC), `get-actor` /
`get-actor-entity` (read back). Defer gear judgment to [[physical-item-builder]].

## Authoring policy — READ FIRST

**Follow the shared project authoring policy:** read
[`_shared/authoring-policy.md`](../_shared/authoring-policy.md) — 2024 by default · compendium-FIRST
(premium PHB/DMG/MM; copy, don't author) · **never the SRD** · custom = copy→modify→rename · no 2024
match → **STOP and ASK** · authoring, not play. `create-pc` enforces premium-only by construction: a
class/species/background not in the books is an **error, not invented**. If the user wants a class or
species that isn't in the library, stop and ask — don't substitute or fabricate.

> **Scope = full PCs, levels 1–20, incl. multiclass.** `create-pc` builds a complete PC at any `level`
> 1–20 (HP, features, **subclass at level 3**, spell slots all scale), including a **multiclass build in
> one call** via `multiclass: [{className, levels}]` (primary = `className`/`level`). **`level-up-pc`**
> adds one class level to an existing PC — the same class (a level-up) or a new class (a **multiclass**).
> **`create-pc-from-prefab`** copies a premium PHB pregen as a base instead of building from scratch.
> See "Levelling up & multiclassing" and "Prefab-as-base" below. Everything PC-side is now wired.

## The shape of a build

`create-pc` takes the PC by **name**: `className` (required), optional `species` + `background`, the
**final** `abilities`, a `choices` map (the player picks), optional caster `spells`, `level` (1–20),
and `hpMode` (`avg` default | `max`). It runs real advancement **across every level up to `level`**, so
class/species/subclass/background **features, proficiencies, HP, and @scale all come from the engine** —
you don't add them by hand. It returns
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
3. **Ability Score Improvements (level 4/8/12/16/19)** — for a PC built **above level 3**, fold any
   ASI ability increases the player took into the final numbers too (the engine SKIPS the ASI
   advancement — the final scores are the source of truth). If the player instead took a **feat** at an
   ASI tier, leave scores as-is and ADD the feat as a separate item after the build (Step 6, like gear)
   — `create-pc` does not grant ASI-feats.
4. Hand the result to `create-pc` as `abilities`. HP and every derived modifier re-derive from these
   (e.g. a Fighter with final CON 14 → 10 + 2 = **12 HP** at level 1; at level 5, 10 + 4×6 + 5×2 = **44**).

If the user doesn't care about the spread, pick a sensible class-appropriate array and tell them what
you chose.

## Step 3 — Learn the choices, ask the player, fill the map

Level-1 PCs have **player choices** the engine won't invent (per design.md §2.1):

- **`inspect-pc-advancement`** (`className`, `level`) lists the class's choice points **up to that
  level** — each with an **id**, type (`Trait` / `ItemChoice` / `Subclass`), how many to pick (`count`),
  and the legal **options** (the Subclass choice is enriched with the class's actual subclasses). Use it
  to plan, and to show the player their options.
- Or just call `create-pc` with what you have; if picks are missing it returns **`success:false` +
  `needsChoices[]`** (the same descriptors, covering class **and** species **and** background **and** the
  L3 subclass) and **creates nothing** — no litter. Fill the map and re-call.

Build the `choices` map keyed **level → advancement-id → data**:
- **Trait pick** (skills, expertise, languages, tools, weapon masteries) → `{ chosen: [keys] }`.
  Skill keys are the 3-letter codes: `skills:acr ani arc ath dec his ins itm inv med nat prc prf per
  rel slt ste sur`. When an option is a **wildcard category** (`languages:standard:*`, `tool:game:*`,
  `weapon:mar:*`), supply a **concrete** key in that pattern (e.g. `languages:standard:elvish`); if
  you're unsure of the exact key for a language/tool/weapon, see "defaults" below.
- **ItemChoice pick** (fighting style, draconic ancestry, etc.) → `{ selected: [uuid] }` using a uuid
  from the option list (the options carry readable labels — e.g. "Archery", "Acid Breath Weapon").
- **Subclass pick** (level 3+) → `{ uuid: "<subclass-uuid>" }`. The needsChoices/inspect Subclass entry
  already lists the class's subclasses (`options: [{value:uuid, label:name}, …]`) — pick the one the
  player wants. Its subclass features are granted automatically; subclass spells (for a subclass caster)
  are added in Step 5/6.

Example (a level-5 Fighter):
```
choices: {
  "0": { "<draconic-ancestry-id>": { selected: ["<an-ancestry-uuid>"] } },  // species choices at level 0
  "1": {
    "<skill-prof-id>":     { chosen: ["skills:ath", "skills:prc"] },
    "<fighting-style-id>": { selected: ["Compendium.dnd-players-handbook.feats.Item.phbfstArchery000"] }
  },
  "3": { "<subclass-id>": { uuid: "Compendium.dnd-players-handbook.classes.Item.phbftrChampion00" } },
  "4": { "<weapon-mastery-id>": { chosen: ["weapon:martial:greatsword"] } }
}
```
Each choice is keyed at the level it's offered — L1 picks at `"1"`, subclass at `"3"`, the L4 weapon
mastery at `"4"`, species/background at `"0"`. ASI tiers (4/8/…) are NOT choices here — ability bumps
ride in the final scores (Step 2) and feats are added separately (Step 6).

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

Slots are automatic — a caster class sets up its own spell slots through advancement (a Wizard gets its
slots and INT casting with no extra step; the count scales with `level`). You only choose **which
spells**: pass `spells: { cantrips: [names], prepared: [names] }` to `create-pc` (names from the premium
PHB). Use `search-compendium-spells` (facets: `spellLevel`, `spellSchool`, `damageType`) to find or
confirm spells. Pick the class's loadout for the level (e.g. a level-1 Wizard's 3 cantrips + 6 spellbook
spells; more at higher levels); ask the player for signature picks. A name not in the books is reported
in `warnings` — fix or ask, don't invent a spell.

## Step 6 — Starting equipment + ASI-feats (your call, via `import-item` / `add-feature`)

`create-pc` adds **no gear and no ASI-feats**. After the PC exists:
- **Equipment** — compose the starting kit by **copying real items** from the PHB/DMG with `import-item`
  (`actorIdentifier` = the new PC), `equipped: true` for what it wears/wields. The 2024 class+background
  starting-equipment package, **or** the gold option if the player would rather buy — ask. Worn armor /
  shield, the primary weapon(s), adventuring gear, any spellbook/focus. Defer item judgment to
  [[physical-item-builder]]. Copied armor doesn't auto-drive AC — if AC looks off, set it with
  `update-actor` (a shield bonus applies under any calc).
- **Feats** — for a PC **above level 3** whose player took a **feat** at an ASI tier (4/8/12/16/19),
  add it now: `add-feature` mode `compendium-features` with the feat name (it copies the real PHB feat),
  or `import-item` for a feat-as-item. (Ability-increase ASIs are already in the final scores — don't
  re-apply them. The Origin feat from the background is granted automatically.)

## Step 7 — Finishing pass

- **Art** → `set-actor-art` (portrait + token from a Data-relative path; upload first if needed).
  - **Default portrait — DETERMINISTIC: the PC's class → that class's PHB pregen art.** A `create-pc`
    build starts with no portrait (unlike a prefab copy, which carries book art). Unless the player gives
    their own image, default the portrait to the **PHB pregen for the PC's class** — a fixed 1:1 mapping,
    not a judgment call (this is the PC analog of the NPC builder's best-match portrait hunt, but for PCs
    it must be *predictable*: same class always → same art). The premium book ships exactly one ready
    pregen per class (Barbarian … Wizard) in `dnd-players-handbook.actors`, each with official class art
    at the deterministic path **`modules/dnd-players-handbook/assets/journal-art/<class>.webp`** (class
    lowercased — `ranger.webp`, `wizard.webp`, …). To be safe, confirm the path by resolving the pregen:
    `search-compendium` `{ query: "<Class>", packType: "Actor" }` → the hit in `dnd-players-handbook.actors`
    (id `phbprg<Class>0000`) → `get-compendium-entry` and read its `imageUrl`. Pass that path to
    `set-actor-art` (sets portrait **and** token).
  - **Multiclass:** use the art of the class whose **first level was selected** — i.e. the **primary
    class** (`create-pc`'s `className` / the originalClass, the one that maxes its first-level HP), NOT
    any later `multiclass[]` entry. Same deterministic rule, keyed on the starting class.
  - Skip the default only when the player supplied their own art.
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

## Prefab-as-base (`create-pc-from-prefab`)

When a stock build fits — a quick pregen for a new player, an NPC-turned-PC, a "just give me a level-1
Fighter" — **copy a premium pregen instead of building from scratch.** The premium PHB ships 12 ready
class pregens (Barbarian, Bard, Cleric, Druid, Fighter, Monk, Paladin, Ranger, Rogue, Sorcerer,
Warlock, Wizard) in `dnd-players-handbook.actors` — each a complete level-1 character with a species,
the class kit, feats, starting gear, and book art. `@scale` resolves natively (it's a real character),
so there's nothing to hand-patch.

- **Call:** `create-pc-from-prefab` `{ name, prefab: "Fighter" }` (resolve by name) or
  `{ name, packId, actorId }` (explicit). Premium books only — copying an SRD character is refused.
- **Tweak the copy, not the source:** pass `abilities` (final scores, overrides the pregen's array)
  and/or any update-actor-shaped `modifications` (e.g. `hp`, `biography`, `currency`). They apply to the
  copy only.
- **Finish:** assign the *player* as owner with `set-actor-ownership`; the art comes from the book
  already. To customise the build further (different species, a subclass earlier, swapped gear), either
  edit the copy with the actor/item tools or build from scratch with `create-pc` instead.
- **When NOT to use it:** if the player wants real choices (their own species, point-buy spread,
  specific skills/spells), build with `create-pc` — the pregen's choices are baked in.

## Levelling up & multiclassing (`level-up-pc`)

`level-up-pc` adds **one class level** to an existing PC and applies just that level's advancement in
place. It's the "ding, you levelled" workflow AND the way to multiclass.

- **Single-class level-up** — `level-up-pc` `{ actorIdentifier, className: <a class the PC already has> }`.
  HP grows by `hpMode` (avg|max), new features land, and the subclass is asked for when that class hits
  **its** level 3. Call once per level (the in-play model); for a big jump, call it repeatedly.
- **Multiclass** — `level-up-pc` `{ actorIdentifier, className: <a NEW class> }`. The PC gains the **2024
  multiclass proficiency subset** (e.g. multiclassing into Wizard grants no skills/saves; into Fighter,
  only some armor/weapons) — the tool handles that automatically. The new class's first level uses **avg**
  HP (never max — only the original class maxes its first level). Spell slots for a multiclass caster
  derive automatically.
- **Multiclass from scratch — two ways:**
  - **One shot (preferred when you know the spread up front)** — `create-pc` with
    `multiclass: [{ className, levels }, …]`. `className`/`level` is the **primary** class (the
    originalClass — its first level maxes HP); each `multiclass[]` entry is a secondary class that gets
    the 2024 proficiency subset and avg first-level HP. The total (primary `level` + every
    `multiclass.levels`) must be ≤ 20; a class may appear only once. The `needsChoices[]` dry-run
    aggregates **all** classes' picks (keyed level → advancement-id; ids disambiguate same-level picks);
    for clarity you can also `inspect-pc-advancement` each class separately. The result reports a
    `classes[]` breakdown when multiclassed. Spell slots for a multiclass caster derive automatically.
  - **Incremental** — `create-pc` the primary class, then `level-up-pc` into the second class one level
    at a time (the in-play path: "I'm dipping a level of Wizard at level 6").
- **Choices on level-up** — same as `create-pc`: call with no/partial `choices` to get a `needsChoices[]`
  dry-run (e.g. the subclass options when the class reaches level 3) — **the PC is NOT changed** — then
  fill `choices` (keyed by the **class** level → advancement-id) and re-call. Ask the player for the
  meaningful picks.
- **Ability scores & feats on level-up** — `level-up-pc` does NOT apply ASI ability bumps. When the
  player takes an **ASI** at 4/8/12/16/19, raise the final scores yourself with `update-actor`; when they
  take a **feat**, add it with `add-feature` (compendium-features). HP re-derives from the new CON.
- **Multiclass spellcasting caveat** — the combined-caster slot table is dnd5e's job and mostly
  auto-derives, but spell *preparation* limits across two casters can get fiddly; read back and sanity-
  check a multiclass caster's slots/prepared, and tell the player what you see.

## Notes

- **A freshly-CREATED PC comes out fully rested — the tool does it, you don't.** `create-pc` and
  `create-pc-from-prefab` finish the build with a long-rest top-off (full HP, every spell/pact slot,
  no spent limited-use features) so the PC reads ready-to-play immediately (`restPcToFull` in
  `advancement.ts`). This is why a brand-new PC shows current HP = max and full slots rather than the
  transient "partial HP / 0 slots" a raw `Actor.create` can momentarily read before derived data
  re-preps. No manual HP/slot fix-up needed. **`level-up-pc` does NOT rest** — on a level-up the PC
  keeps its current HP (max just grows); auto-healing on "ding" would be wrong, so top-off is
  CREATE-only.
- **A new tool/param needs a Claude Code restart** to load into the running MCP server; the live verify
  script (`scripts/verify-pc-build.mjs`) bypasses this via `dist/`.
- **`@scale` is native on a PC** — do NOT hand-patch it the way the NPC builder does. If `create-pc`
  reports `unresolvedScale`, something is genuinely off (a feature with no advancement behind it);
  surface it rather than papering over it.
- Keep `sourceRules` consistent (**2024 by default**; pass `2014` only if the user explicitly wants
  legacy). The choices map is keyed by **level then advancement-id** — species/background creation
  choices sit at level `"0"`, class L1 choices at `"1"`, the subclass at `"3"`, and any higher-level
  Trait/ItemChoice pick at its own level. Re-run `inspect-pc-advancement` at the target `level` to see
  every choice the build will ask for.
- **Levelling:** `create-pc` builds at any `level` 1–20 in one shot; **`level-up-pc`** adds one level to
  an existing PC (same class or a multiclass). See "Levelling up & multiclassing" above. The choices map
  is the same shape for both, keyed by the **class** level.
- The skill owns judgment (which class/species/background/subclass, the ability math, the picks, the
  gear); the tools own correctness (name→uuid, advancement sequencing, persist, @scale, the multiclass
  proficiency subset). Don't reach past that line — e.g. don't try to set proficiencies or HP directly;
  let advancement do it.
