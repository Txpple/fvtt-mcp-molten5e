---
name: bestiary-builder
description: >-
  Add a monster the party FOUGHT to the world's player-facing Bestiary journal — Monster Manual art
  plus the MM narrative write-up (never the stat block), filed as a page in alphabetical order. Use
  when the user says "add it to the bestiary", "the party killed a <monster> — log it", "bestiary
  entry for <monster>", "add the monsters we fought", "what did we fight? put them in the bestiary",
  or wraps a session and wants the kills recorded. Runs a bundled script that resolves the creature
  in the premium Monster Manual pack, follows its lore embed, harvests the book art, strips the
  non-narrative furniture, and upserts the page with the right ownership. The script owns the
  fetch/parse/sort; this skill owns the judgment: whether it's earned, which creature it really was,
  shared-lore variants, reskins, homebrew, and what stays hidden.
---

# Bestiary builder

The **Bestiary** is one journal — `Bestiary`, in the **Adventure Log** folder — with **one page per
creature, alphabetical**. Players can open it; it is how they learn what they just fought.

The deterministic half is the bundled script `bestiary-entry.mjs` (next to this file). There is **no
MCP tool for this**: reading a compendium journal page and setting *entry-level* journal ownership
both sit outside the tool surface, so the script drives the live session directly through
`dist/foundry.js`. Everything else — `upload-asset`, `list-journals`,
`set-journal-page-visibility` — is normal tooling.

## Step 0 — Has it been earned?

The house rule: **a page goes in after the party has fought the thing**, not when the DM statted it.
The bestiary is the players' trophy shelf and their reference; it must never front-run an encounter.

- **Killed it** → add it, player-visible.
- **Fought it and it got away** (the will-o'-wisp) → still add it; they met it and paid for the
  knowledge.
- **Only glimpsed / heard rumored** → ask the DM before adding.
- **Prepped for a future session** (the displacer beasts) → add it with **`--gm-only`** if the DM
  wants it staged, and reveal it later with `set-journal-page-visibility`.

If a session recap is the source, work from the campaign repo's `sessions/<date>/recap.md` — it names
every creature that took a turn.

## Step 1 — Resolve the real creature

Compendium-first, premium books only (design.md §2.3 — never the SRD). Name it as the **Monster
Manual** names it:

- **Shared lore is normal.** The MM writes one narrative for a family: Hobgoblin Warrior, Captain and
  Warlord all point at **Hobgoblins**; Twig/Vine/Needle/Tree Blight all point at **Blights**. Pass
  any variant and the script lands on the shared page — so a party that fought both twig *and* vine
  blights gets **one** "Blights" page, not two. Re-running for the second variant just refreshes it.
- **Use `--page` when the family name should win.** `--monster "Hobgoblin Warrior" --page
  "Hobgoblins"` titles the page for the family rather than the one variant they killed.
- **Reskins and masked identities.** A world NPC may be a reskin of an MM creature (or wear a
  `trueName` mask). Resolve to the *true* MM creature for the lore, but **do not title the page with
  a name the players haven't earned** — if they only know it as "the thing in the webs", ask the DM
  what to call it.
- **Not in the Monster Manual** (homebrew, a Ravenloft/adventure-pack creature, a custom NPC): the
  script exits with `not in the Monster Manual` or `no lore embed in its biography`. **Stop and ask
  the DM for the narrative** — never invent monster lore, and never paste a stat block. Then build
  the page by hand with `create-journal`/`update-journal` in the same house shape, or run with
  `--no-art` and edit the text in after.

## Step 2 — Art

Default is the **Monster Manual's own journal art** (`modules/dnd-monster-manual/assets/journal-art/…`)
— already installed with the module, so nothing to upload, and it carries the book's caption when it
has one ("Left to Right: Vine Blight, Tree Blight, and Needle Blight").

Override when the DM has their own scan or a higher-res plate:

1. `upload-asset` it to `worlds/<world>/assets/journal/<slug>.png` first;
2. pass `--art "worlds/<world>/assets/journal/<slug>.png::Optional caption"` (repeatable — a
   multi-creature page like Blights takes two, in the order you want them).

`--no-art` for a text-only page.

## Step 3 — Run it

```
node .claude/skills/bestiary-builder/bestiary-entry.mjs --monster "<MM name>" [options]
```

| option | effect |
| --- | --- |
| `--monster <name>` | required; MM creature name (any variant of a shared-lore family) |
| `--page <name>` | page title override (default: the MM lore page name) |
| `--art <src[::caption]>` | Data-relative image instead of the MM art; repeatable |
| `--no-art` | text only |
| `--gm-only` | page stays GM-only (unrevealed monster) |
| `--journal` / `--folder` | defaults `Bestiary` / `Adventure Log` |
| `--dry-run` | print the resolved HTML, write nothing |

**`--dry-run` first** on anything unfamiliar — it shows exactly which art and which paragraphs
survived the strip, before a word reaches the world.

What the script guarantees, so you don't have to check it by hand:

- narrative only — it drops the **habitat/treasure** line, nested art embeds, and any **rollable
  table** the MM hangs off the entry (plus its "Roll on or choose a result…" lead-in and footnote);
- the MM's pull-quotes survive as blockquotes, the italic epithet becomes the house `lead` line, and
  book-only CSS classes are stripped;
- the page is **upserted by name** (safe to re-run) and **every page is re-sorted alphabetically**;
- **ownership**: the journal entry is set to players-OBSERVE, and each page gets an *explicit*
  ownership default. That explicitness matters — a page created without one **inherits** the open
  entry and would leak a GM-only monster. This is also why `create-journal`'s `playerVisible` is not
  enough on its own here: it sets the page but leaves the *entry* GM-only, so players never see the
  journal at all.

## Step 4 — Verify and report

`list-journals` with the Bestiary's `journalId`: confirm the new page is present, the order is
alphabetical, and anything staged reads GM-only. Tell the DM which page was created vs refreshed, and
name any page still hidden from players.
