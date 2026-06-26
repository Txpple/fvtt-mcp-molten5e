---
name: ddb-import
description: >-
  Import a player's D&D Beyond character into Foundry as a real, leveled PC (type:character). Use when
  the user wants to "import my D&D Beyond character", "import from DDB", "bring in my dndbeyond
  character", "build the PC from this D&D Beyond sheet/link", or pastes a dndbeyond.com character URL or
  its character JSON. Composes parse-ddb-character (the deterministic DDB-JSON → plan tool) with
  search-compendium / inspect-pc-advancement / create-pc and the pc-builder finishing pass. The TOOL
  owns the parse (final ability math, the modifier/choice machinery, raw-name extraction, flagging
  homebrew/legacy); this SKILL owns the judgment: canonicalizing DDB names to the premium-2024 books,
  the STOP-and-ASK gate on anything not in the library, keying create-pc's advancement choices, and the
  build. COMPENDIUM-FIRST — never invent content that isn't in the books.
---

# D&D Beyond importer

Turns a player's **D&D Beyond character** (a URL, an id, or pasted JSON) into a **fully-built Foundry
PC** — the same real `type:character` + advancement build that [[pc-builder]] produces, just sourced
from a DDB sheet instead of a typed concept. It adds NO new mechanics: the
[`parse-ddb-character`](../../../src/tools/dnd5e/ddb-import.ts) tool does the deterministic transcription,
this skill does the judgment, and the **[[pc-builder]] back half** (`create-pc` → gear → finishing
pass) does the build.

**The seam (design.md §7 — "skills decide / tools do").** `parse-ddb-character` is a pure transcriber:
it emits a normalized plan with **raw DDB names + flags** and does **zero** compendium lookup. This
skill makes every fuzzy/policy decision the tool deliberately won't: mapping a DDB name to the exact
premium-2024 entry, deciding "trivial spelling delta vs genuine miss", and **stopping to ask** rather
than substituting or inventing.

## Authoring policy — READ FIRST

**Follow the shared project authoring policy:** read
[`_shared/authoring-policy.md`](../_shared/authoring-policy.md) — 2024 by default · compendium-FIRST
(premium PHB/DMG/MM; copy, don't author) · **never the SRD** · custom = copy→modify→rename · no 2024
match → **STOP and ASK**. The importer inherits this hard: `create-pc` resolves class/species/
background **by exact name in the premium books and ERRORS on a miss** (it never falls back to the
SRD), so you must canonicalize DDB names *before* building, and ask on anything that won't resolve.

> **Access — we never touch the player's D&D Beyond account.** A **public** character is fetched by id;
> a **private** one (the common case) is handled by asking the player to set it Public *or* paste/save
> its JSON. We do **not** accept or store a D&D Beyond session ("cobalt") cookie — it is
> account-password-equivalent. `parse-ddb-character` enforces this: it only fetches public characters.

## Step 1 — Ingest the character

Call **`parse-ddb-character`** with exactly one of:
- **`characterId`** (the digits in the sheet URL, e.g. `167582904`) or **`url`** (a dndbeyond.com link)
  — fetches the character if it is **Public**.
- **`json`** — the pasted/saved v5 JSON (the `{success, data, …}` envelope or the inner `data`). Use
  this whenever the player gives you JSON directly.

If the fetch returns **PRIVATE (403)**, tell the player: *"That character is private — on D&D Beyond set
its sharing to Public (Manage → Character Privacy → Public), or paste/save the character JSON and I'll
import that."* Do not ask for their cookie. A **404** means the id is wrong or the character was deleted.

## Step 2 — Read the plan

The tool returns `{ success, plan, message }`. The **`plan`** is the structured import (see
[`ddb/parse.ts`](../../../src/tools/dnd5e/ddb/parse.ts) for the shape):
`name`, `edition` (`2024`/`2014`/`mixed`), `abilities` (**final** scores), `classes[]` (primary first,
each with `subclass`), `species`, `background`, `proficiencies` (skills/expertise/saves/languages/
tools/armor/weapons), `options` (fightingStyle + other named picks), `spells` (cantrips + prepared/
known + per-spell `all`), `inventory[]`, `feats[]`, `currency`, `hp`, `art.avatarUrl`, and crucially
**`unresolved[]`** (every homebrew / 2014-legacy / custom entry) plus `abilityNotes` / `warnings`.

Read the `message` digest aloud to the user (who the character is, level, edition) so they can confirm
it's the right one before you build.

## Step 3 — Canonicalize names to the premium-2024 books

For **every** named entity the build needs — class, each subclass, species, background, each feat,
each spell, each inventory item — map the **raw DDB name** to the **exact** premium-book name. DDB
names won't always match (`"Variant Human"` vs `"Human"`, `"Longbow, +1"` vs the magic-variant entry,
curly apostrophes, casing, renamed subclasses). Use the forgiving front door, then carry the exact
name forward:
- `search-compendium` (substring, premium-first) to find the real entry by name.
- `search-compendium-spells` / `search-compendium-items` (faceted, return a usable uuid) for spells/gear.

**Lineage-split species.** Some 2024 species are **split by sub-lineage in the premium books** while
DDB stores a single species name plus a legacy/lineage *option*. Combine them to get the exact entry:
the plan's `species.fullName` + the matching `options.other` legacy → the real premium name. E.g. DDB
species "Tiefling" + `options.other: ["Infernal Legacy"]` → premium **"Tiefling, Infernal"** (the books
have Tiefling, Abyssal/Chthonic/Infernal — there is no bare "Tiefling"). `search-compendium` the base
name to see the variants, then pass the exact one to `create-pc`. Watch for this on Tiefling (and any
species whose `search-compendium` returns several "<Name>, <lineage>" entries).

**Edition rule (your house rule): confirm the obvious, ask the ambiguous.** When a `2014`/legacy DDB
entity has a **clear** 2024 premium equivalent, canonicalize to it and **tell the user** what you
mapped (e.g. "DDB had the 2014 *Variant Human*; using the 2024 *Human*"). When the match is **ambiguous
or absent**, do not guess — take it to Step 4.

## Step 4 — The STOP-and-ASK gate (§2.4)

Collect into ONE list: every `plan.unresolved[]` entry **plus** anything from Step 3 that wouldn't
canonicalize. For each, present it and ask how to handle it. **Never** substitute a near-name, drop the
entry silently, reach for the SRD, or author a fake to paper over a miss. Options to offer the user,
per the policy:
- **Homebrew / custom** (a homebrew feat, `customBackground`, a custom item): skip it, pick a real
  premium analog *they* name, or — only with explicit permission — author it as a last resort
  (copy→modify→rename).
- **Legacy with no 2024 equivalent** / **a book we don't own**: ask which premium entry to use, or to
  drop it.

Partial coverage + this ask-loop is the **normal** outcome, not a failure — set that expectation.

## Step 5 — Discover advancement ids and key the choices

`create-pc` takes the player picks in a `choices` map keyed **level → advancement-id → data**, and the
ids are pack-specific. The plan gives you the *picks* (names); you bind them to the *ids*:
1. Call **`inspect-pc-advancement`** per class/level (or call `create-pc` with partial choices and read
   the **`needsChoices[]`** dry-run — it persists nothing) to learn each advancement's id, type, and
   legal options.
2. Map the plan onto them:
   - `proficiencies.skills` / `expertise` / `languages` / `tools` / `weapons` (chosen) → **Trait**
     `{ chosen: [keys] }` (skill keys like `skills:ath`; the plan already gives 3-letter skill codes).
   - `options.fightingStyle` / draconic ancestry → **ItemChoice** `{ selected: [uuid] }` (match the
     option label to the right uuid).
   - each class's `subclass` (at its level 3) → **Subclass** `{ uuid }` (the canonicalized premium
     subclass).
   - Abilities are **already final** in `plan.abilities` — pass them straight to `create-pc.abilities`;
     do NOT re-add background/ASI increases (the engine skips that advancement on purpose).

Granted (non-chosen) proficiencies come from advancement automatically — you only key the *chosen*
ones. Use the `needsChoices[]` dry-run to confirm the map is complete before building.

## Step 6 — Build the PC (`create-pc`)

Call **`create-pc`** with `name`, `className` (the **primary** = `plan.classes[0]`), `level`
(its level), `multiclass: [{ className, levels }]` for every other class, `species`, `background`,
`abilities` (= `plan.abilities`), the `choices` map, and `spells: { cantrips, prepared }`
(= `plan.spells.cantrips` / `.prepared`, canonicalized names). On `success`, `@scale` resolves
natively. If `needsChoices[]` comes back, fill the gaps and re-call — nothing was created.

## Step 7 — Equipment, feats, currency

`create-pc` adds no gear/feats. After the PC exists (reuse [[pc-builder]] Step 6, defer item judgment
to [[physical-item-builder]]):
- **Inventory** — for each `plan.inventory[]` line, `search-compendium-items` → **`import-item`**
  (`actorIdentifier` = the new PC, `equipped`/`container` from the line). Normalize `"<item>, +N"` to
  the magic-variant entry. Anything homebrew went through Step 4.
- **Currency** — `update-actor` with `plan.currency`.
- **Feats** — for each genuinely **player-chosen** feat in `plan.feats[]`, **`add-feature`** mode
  `compendium-features` with the canonicalized name. **Skip the noise DDB lists as "feats":** the
  background's **origin feat** (e.g. *Magic Initiate (Cleric)* from Acolyte) is auto-granted by
  `create-pc`'s background advancement — don't re-add it; a *"… Ability Score Improvements"* entry is
  the background/ASI increase, already baked into the final abilities — don't add it either. A named
  feat that isn't in the premium books goes through the Step-4 STOP-and-ASK gate, never invented.

## Step 8 — Finishing pass

- **Art** → `set-actor-art`. Prefer the character's own DDB portrait (`plan.art.avatarUrl`) — download
  it and `upload-asset` to the world, then point `set-actor-art` at the Data-relative path. If there's
  no avatar, fall back to the **deterministic class-pregen default** ([[pc-builder]] Step 7 — the PHB
  pregen art for the **primary** class).
- **Ownership** → `set-actor-ownership` — assign the **player** as owner.
- **Folder** → file the PC (the engine files new PCs under "Foundry MCP Characters"; `move-documents`
  if the table organizes differently).

## Step 9 — Read back and report fidelity honestly

`get-actor` to confirm HP/AC/abilities/skills/saves, class/species/background, spell slots, and
inventory; confirm **@scale resolved** (a real die, not `@scale.…`). Then report the build AND its
**known lossy points** — don't fake fidelity:
- **Prepared-vs-known** is collapsed: `create-pc` imports all spells as prepared from the **PHB only**.
  An exact known/prepared split, prepared-count limits, or a non-PHB spell won't round-trip (out-of-book
  names surface in `create-pc` warnings — fix or ask, don't invent).
- **Live state** is reset: a freshly-built PC is **fully rested** (HP = max, all slots), overwriting the
  DDB sheet's current HP / spent hit dice / death saves / inspiration.
- Echo every name you **canonicalized** (DDB → premium) and every entry you **asked about** or left out.

## Notes

- **The tool parses; the skill decides.** Don't re-derive ability scores or proficiencies yourself —
  trust `plan` for the transcription, and spend your judgment on names, the ask-gate, and the build.
- **Never the cobalt cookie.** If a character is private, the answer is always make-it-Public or paste
  the JSON — never ask for or accept a D&D Beyond session token.
- **A new tool needs a Claude Code restart** to load over MCP; `parse-ddb-character` is already wired
  into the registry but won't be callable until the server reloads.
- **`@scale` is native on a PC** — if `create-pc` reports `unresolvedScale`, surface it; don't patch it
  the way the NPC builder does.
