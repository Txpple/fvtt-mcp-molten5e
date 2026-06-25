---
name: cards-builder
description: >-
  Author D&D 5e card decks in Foundry — themed decks (Deck of Many Things, a tarokka deck, encounter
  / event / fate decks, initiative decks) and standard playing-card decks. Use when the user wants to
  "make a deck", "build a card deck", "create a Deck of Many Things", "a tarokka deck", "encounter
  cards", "import a standard deck of cards", or stat out a set of cards. YOU decide the deck's cards —
  their names, face text, art; the tools only STRUCTURE it (the v14 Cards/Card shape) or import a core
  preset deck. Cards have no premium-book compendium, so decks are asset-driven (like scenes): the card
  art is uploaded, the flavor text is yours. Creation only — dealing / drawing / shuffling in play is a
  later phase. Composes create-cards / import-cards / list-cards / delete-cards.
---

# Cards builder

The judgment + content layer for **playable cards** (design.md §5) — Foundry card stacks (decks, hands,
piles) for in-play use: a Deck of Many Things, a tarokka deck, an encounter/fate deck, a standard deck
of cards. As with every authoring skill: **you decide; the tool does.**

## The line that matters — yours vs the tool's

- **You (this skill) decide the deck's CONTENTS** — which cards, each card's name, its face text (the
  outcome/effect/flavor), and which art it uses. That judgment IS the job.
- **The tool only STRUCTURES** — `create-cards` renders your cards into the v14 Cards/Card shape (one
  face per card: `{ name, text?, img? }`); `import-cards` instantiates a core preset deck. Neither
  invents a card.

## Authoring policy — what compendium-first means HERE

Read [`_shared/authoring-policy.md`](../_shared/authoring-policy.md). The big clarification for cards:

- **Cards have NO premium-book compendium** (the MM/PHB/DMG ship no card decks). So **compendium-first
  is N/A** — decks are **asset-driven, like scenes**: the card **art** is an uploaded image asset, and
  the face **text** is yours to write. There is no "copy the book deck" path; `import-cards` only
  instantiates Foundry's built-in **preset** decks (a standard 52-card deck).
- **Don't fabricate canon.** A famous deck's contents ARE canonical — the **Deck of Many Things** card
  list and its effects come from the DMG; transcribe them, don't invent new cards or outcomes. If the
  user wants a deck of content you don't have, **STOP and ASK** rather than making it up. Custom/themed
  decks (an event deck for your adventure) are yours to author.

## Tools

- **`create-cards`** — the structuring creator (your main tool). `{ name, type?, description?,
  folderName?, cards?: [{ name, text?, img? }] }`. Builds a stack with one face per card.
- **`import-cards`** — instantiate a core **preset** deck (`{ preset, name?, folderName? }`), e.g.
  `pokerDark` / `pokerLight` (a standard 52-card deck). The ready-made-deck path.
- **`list-cards`** — list stacks + ids (deck/hand/pile, card count).
- **`delete-cards`** — remove stacks by exact id/name (strict).

## The card model

Each card is `{ name, text?, img? }` plus an optional card-level `description`:

| Field | Use it for |
|---|---|
| `name` | The card's name ("The Sun", "Ace of Spades", "Wolf Pack"). Required. |
| `text` | **Face text shown on the card** (HTML) — the outcome/effect/flavor (e.g. a Deck of Many Things result). Pass `<p>…</p>`. |
| `img` | A Data-relative path to the card's **art** (an uploaded image). |
| `description` | A card-level GM/meta note — **not** shown on the face. |

A card with `text` and/or `img` gets a face; with neither it's a plain named card. Art and text can
combine (illustrated card with a caption).

## Stack type — deck / hand / pile

- **`deck`** (default) — the master set a deck is dealt FROM (the Deck of Many Things, a tarokka deck,
  an encounter deck). Build the canonical/themed set here.
- **`hand`** — a player's held cards (usually created empty; populated in play later).
- **`pile`** — a discard / shared table area.

For authoring (this phase) you almost always build a **deck**.

## Deck kinds — pick the contents

- **Deck of Many Things** — a `deck` of the canonical DMG cards; each card `name` = the card (Sun, Moon,
  Vizier, Talons, Donjon, …) and `text` = its DMG effect (transcribe the book — don't invent). Add card
  art if the user supplies images.
- **Tarokka / fortune deck** — a themed `deck`; each card a name + meaning (`text`) + art.
- **Encounter / event / fate deck** — a `deck` where each card is an event you author (`text`), drawn
  to drive a scene. Card art optional.
- **Standard playing-card deck** — don't hand-build 52 cards; **`import-cards` `preset:"pokerDark"`**.

## Art is an asset (no compendium)

Card art is an uploaded image (upload-asset / the scene-style asset path), not a compendium pull. If
the user gives you images, reference them by their Data-relative path in `img`; otherwise build a
text-only deck (cards still work, they just show text, not a picture).

## Phase boundary — creation only

Build decks now. **Dealing, drawing, shuffling, and passing cards in play are out of scope** (a later,
in-play phase) — `create-cards` / `import-cards` set up the stack; running it at the table comes later.

## Don't

- Don't invent the contents of a **canonical** deck — transcribe the book (Deck of Many Things), or
  **STOP and ASK**.
- Don't fabricate card art — it's an uploaded asset; a text-only deck is fine without it.
- Don't try to deal/draw/shuffle — that's not this phase.
