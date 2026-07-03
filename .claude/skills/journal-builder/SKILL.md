---
name: journal-builder
description: >-
  Author D&D 5e journal entries in Foundry — quest logs, player handouts, lore/gazetteer entries,
  read-aloud (boxed) text, GM notes, and session recaps / campaign logs. Use when the user wants to
  "write a quest", "make a handout", "create a journal", "write up the lore / a gazetteer", "boxed /
  read-aloud text", "GM notes", "a session recap", "campaign log", "link this quest to the NPC", or
  pastes adventure text to turn into a journal. YOU write the prose (the words are yours); the tools
  only STRUCTURE it — typed blocks → the house style, per-page player/GM visibility, and real @UUID
  links. Composes create-quest-journal / update-quest-journal / link-quest-to-npc / create-journal /
  update-journal / add-journal-image / list-journals / search-journals with GMing judgment: which page
  kind, what's player-facing vs GM-only, the quest layout, when to link a real NPC / compendium doc.
---

# Journal builder

The judgment + prose layer for the **written** side of an adventure (design.md §5): handouts, lore,
read-aloud (boxed) text, quest logs, GM notes — and the §8 landing zone for **session recaps / campaign
logs**. This is the deliberate inverse of the old behaviour, where the *tool* fabricated quest prose
(read-aloud, NPC dialogue, hooks). Now **you write the words; the tools only structure + style them.**

## The line that matters — yours vs the tool's

- **You (this skill) write every WORD** — the read-aloud boxed text, the lore, the quest hook, the GM
  guidance, the handout copy. Authoring that narrative prose IS the job.
- **The tool only STRUCTURES** — it renders your typed blocks into the `.mcp-journal` house style, sets
  per-page visibility (player vs GM), and inserts real document links. It never writes a word.

## Authoring policy — what compendium-first means HERE

Read [`_shared/authoring-policy.md`](../_shared/authoring-policy.md) (2024 · compendium-first · never
SRD · ask-don't-invent). One journal-specific clarification:

- **Compendium-first / ask-don't-invent govern the game CONTENT a journal REFERENCES** — the monster in
  the ambush, the magic item in the reward, the spell on the trap. Point at the **real** compendium /
  world documents (mix-and-match) and **@UUID-link** them; never invent their stats.
- They do **NOT** constrain the **GM's narrative prose** — the story, the boxed text, the lore — which
  is yours to author. That's the whole point of this skill.
- Still **don't fabricate canon you weren't given** — a new region, a named NPC, a plot turn the user
  didn't ask for. Offer it as a suggestion or **STOP and ASK**; don't silently invent setting facts.

## Tools

- **`create-quest-journal`** — the STRUCTURING creator (your main tool). Takes `pages: [{ name,
  playerVisible?, blocks[] }]` → renders each page's blocks into the house style. Despite the name it
  builds ANY structured journal (handout, lore, notes), not just quests.
- **`update-quest-journal`** — append a new styled section (from `blocks`) to a page, or start a new
  page (`newPageName`). The progress-log / §8 session-recap path.
- **`link-quest-to-npc`** — insert a real `@UUID[Actor.id]{Name}` link to a world NPC, labelled by
  `relationship` (questGiver / target / ally / enemy / contact). Refuses an unknown NPC (no dead links).
- **`create-journal`** / **`update-journal`** — generic pages: raw HTML content (+ per-page
  `playerVisible`). Use when you already have HTML, or want a plain page with no house style. A
  `create-journal` page can also be an **image** page — `{name, kind:"image", src, caption?}` — so a
  mixed text+image or image-only journal (e.g. a map-key pack) builds in one call (set `sort` to order).
- **`add-journal-image`** — append an image page (a map, a handout picture) to an EXISTING journal,
  with an optional `caption` and `playerVisible` (expose it as a handout; default GM-only).
- **`list-journals`** / **`search-journals`** — find/read existing journals + their page ids (needed to
  target `pageId` for updates/links).

## The block vocabulary (what you pass to the structuring tools)

Each page's `blocks` is an ordered list. Every `text`/`html`/`items` value is **your words**:

| Block | Use it for | Shape |
|---|---|---|
| `heading` | A section title | `{type:"heading", text, level?:2\|3}` |
| `lead` | A one-line summary / intro (muted) | `{type:"lead", html}` |
| `paragraph` | Body prose | `{type:"paragraph", html}` |
| `readaloud` | **Boxed read-aloud / player-facing text** | `{type:"readaloud", html}` (pass `<p>…</p>`) |
| `gmnote` | **GM-only callout box** | `{type:"gmnote", html}` (pass `<p>…</p>`) |
| `list` | Bulleted items (objectives, clues) | `{type:"list", items:[…]}` |
| `grid` | Two columns of headed lists (a details box) | `{type:"grid", columns:[{heading?, items:[…]}, …]}` |
| `html` | Escape hatch — a table, anything custom | `{type:"html", html}` |

`readaloud`/`gmnote` are visual boxes on the page; they are **not** access control. To actually hide a
page from players, use `playerVisible` (below).

## Page kinds — pick the blocks + the visibility

- **Player handout** — `playerVisible: true`. Clean prose + `readaloud` for the in-world text; no
  `gmnote` (that box leaks GM info even on a player page — keep secrets on a separate GM page).
- **Lore / gazetteer** — `heading` + `paragraph` (+ `readaloud` for an in-world excerpt). GM-only unless
  it's meant as player reading.
- **Read-aloud / boxed text** — a `readaloud` block (optionally `playerVisible` as a handout).
- **GM notes** — `gmnote` + `list`; GM-only (omit `playerVisible`).
- **Quest log** — the template below; GM-only, often paired with a separate player-handout page.
- **Session recap / campaign log** — see §8 below.

## The quest page-template (you fill every blank with prose)

A quest journal is just a recommended block layout — the "quest" is a template you fill, not something
the tool generates. A solid default GM-only "Quest Log" page:

1. `lead` — one-line summary of the quest.
2. `grid` — `[{heading:"Quest Details", items:["Type: …","Difficulty: …","Location: …","Quest Giver: …"]},
   {heading:"Rewards & Status", items:["Reward: …","Status: Active"]}]` (the facts the user gave you).
3. `heading "Adventure Hook"` + `readaloud` — **the boxed hook you write** (how the party hears of it).
4. `heading "Objectives"` + `list` — the steps, in your words.
5. `heading "GM Notes"` + `gmnote` — pacing, secrets, scaling guidance you write.

Then **`link-quest-to-npc`** for any real NPC the quest involves (the giver, the villain), and a
separate **`playerVisible` "Player Handout"** page if the players get a letter/poster (its prose is the
in-world text only — no GM notes). Track progress with `update-quest-journal` (a `heading "Session N"` +
`paragraph` recap appended to the log).

## Visibility — player-facing vs GM-only (per page)

- `playerVisible: true` → players can **observe** that page (a handout). Omit → **GM-only** (default).
- Keep secrets out of player-visible pages entirely — split into a GM page + a handout page rather than
  relying on a `gmnote` box, which still renders its text to anyone who can open the page.

## Player handouts vs GM keys — separate entries, separate folders

A player handout and a GM key are **two different journal entries**, never two pages of one. This is the
house convention — keep it consistent so the sidebar stays trustworthy at a glance:

- **Player handouts** live in a **`Player Handouts`** folder and hold **only** player-facing pages —
  never a GM-only page, never a `gmnote` block. A `gmnote` renders its text to anyone who can open the
  page, so it leaks even on a page you thought was safe; if a journal contains anything the players
  shouldn't read, it does not belong in Player Handouts. A handout is only what you'd physically hand the
  table.
- **GM material** lives in a **`GM Notes`** folder and each entry is named **`<Name> — GM Key`** (e.g.
  `Daggerford — GM Key`, `Wisp Caves — GM Key`, `Trade Way Ambush — GM Key`). Read-aloud / boxed text the
  GM reads *aloud* is the GM's script — it belongs in the GM key, not in a handout.
- **When one subject needs both,** build two entries: `<Name>` (Player Handouts, player-visible) and
  `<Name> — GM Key` (GM Notes, GM-only). Don't smuggle GM notes into a handout as a "GM-only page."
- **Staging a handout hidden** (revealed later in session): create it with its pages GM-only (omit
  `playerVisible`) so the whole entry is invisible to players; in session, flip the **entry's** default
  ownership to Observer once and every inheriting page reveals at once. Per-page `playerVisible: true`
  makes a page visible **now** — use that only when the players should see it immediately.

## Linking — mix-and-match by reference (never restate stats)

- A world **NPC** the quest involves → `link-quest-to-npc` (a clickable `@UUID[Actor.id]` in a GM note).
  The actor must exist first (build it with `stat-block-builder`); the tool refuses a dead name.
- A **compendium/world item, spell, or monster** the journal references → write a Foundry
  `@UUID[…]{Label}` link in a `paragraph`/`html` block (get the uuid from `search-compendium-*`). Link
  the real document; don't transcribe its stats into the prose.

## Session recaps & logs (§8 landing zone)

design.md §8: later, automated session output (chat + Craig/Whisper transcripts) is **authored as
journals** — this skill's structures are where it lands. Build that now by hand:

- A **"Campaign Log"** journal; each session is a `update-quest-journal` append (`heading "Session N —
  <date>"` + `paragraph` recap) onto one log page, OR a new page per session (`newPageName`).
- Keep recaps GM-only by default; a player-facing **"Previously, on…"** is a separate `playerVisible`
  page (or handout) with just the spoiler-free summary.
