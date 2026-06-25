# Alignment plan — getting tools + skills to the north star

> Working tracker for aligning the **current (Phase-1, NPC-era) tools + skills** to
> [`design.md`](../design.md). Derived from the analysis in
> [`architecture-review.md`](architecture-review.md); this file is the *actionable* view. Ordering is
> **current-state-first** (NPCs → journals), **PCs last**. Check items off as they land.

## Locked decisions (2026-06-24)

- The **target operating model** below is agreed.
- **Scenes stay asset-only** — no compendium-first path. (DMG prefab scenes are out, by user call.)
  "Compendium-first N/A" for scenes is deliberate, not a gap.
- **0.4 (type the tool↔page seam) lives in Foundations** as a parallel track — a guardrail that makes
  the rename/move/add churn of Phases 1–3 safe (a wrong `foundry.call` name becomes a compile error,
  not a live-session failure).
- **PCs are deliberately last** (Phase 5); only a reserved seam until Phases 0–3 land. Never fuse a PC
  path into `handleCreateNpc`.
- From the review's adversarial pass: **don't split `add-feature`** (generate its schema from zod
  instead); **do** split `create-actor`; **rename** `CharacterTools`→`ActorTools`; cards' in-play
  verbs are Phase-2, not a Phase-1 gap.

## The spine + three invariants

**Spine:** every **tool** is deterministic correctness; every **skill** is judgment/composition;
**compendium-first is a property of the tools**, not something a skill must remember.

1. **No tool ever invents D&D content** — no prose, no values, no voice.
2. **Tools are 2024 + compendium-first by construction** — no `2014` default; the source is the
   **premium MM/PHB/DMG books, NEVER the SRD** (`dnd5e.*24` or older `dnd5e.*`); copying a book entry
   is the spine primitive, not a skill-selected option. If it isn't in the books → STOP and ASK.
3. **Exactly one judgment skill per building block.**

## Target operating model (per current building block)

| Block | Tools own (deterministic correctness) | Skill owns (judgment) | Compendium-first enforced where | Aligned today? |
|---|---|---|---|---|
| **Scenes** | create/update/delete-scene; light/weather/fog enums; image-dimension probe; name→id | `scene-builder`: map→scene, mood, what to attach | n/a — **asset-only by design** | ✅ (minor: delegate playlist authoring out) |
| **NPCs** (+ items/loot) | create-actor (**copy = default**, authored = gated), update-actor, add-feature, add-item, import-item, manage-activity/effect, apply-condition; **`@scale` detection as a reported fact**; 2024 default | `stat-block-builder` (§6 ladder) + `physical-item-builder` (gear/loot) | create-actor defaults to compendium; central copy primitive; authoring needs the ASK gate | ⚠️ Partial |
| **Journals** | create/update/delete-journal; **quest = structuring only**; add-journal-image; link-quest-to-npc; page model (format/sort/category/ownership) | `journal-builder` **(missing)**: handout/lore/read-aloud/quest *prose* | n/a (authored; can UUID-link compendium refs) | ❌ Gap |
| **Tables** | create/update/roll/delete; **v14 `description` schema**; compendium-referencing results; draw/normalize | `table-builder` **(missing)**: contents, weighting, themed loot | results reference real compendium items (mix-and-match loot) | ❌ Gap |
| **Cards** | create/import **decks** (Phase-1 = creation; deal/draw = Phase-2) | `cards-builder` **(missing)** | import preset/compendium decks | ❌ Gap |
| **Playlists** | create/update/delete-playlist; sound/asset paths | `playlist-builder` **(missing)**; scene-builder delegates here | n/a (audio assets) | ❌ Gap |
| **PCs** | *reserved seam only* | — | — | 🧭 Out of scope now (Phase 5) |

**Cross-cutting tissue:** one compendium-copy primitive (the spine of mix-and-match) · one shared
authoring-policy snippet all authoring skills reference · the tool↔page seam typed.

## Execution discipline

- One coherent unit at a time; **a tool change lands with its skill change** (no orphaned half-states).
- **Full gate** (biome · tsc · vitest · build · knip) **+ adversarial verify** on every substantive
  unit; commit direct to `master`; tree stays green and shippable throughout.
- **Live-verify** the items that need it (sandbox is up): the copy-primitive swap (0.2), a table roll (3.1).
- Every authoring tool gets a **"never invents D&D values" test**; every rename ships with its skill
  edits **+ a one-release deprecation alias**.

## Plan (check off as landed)

### Phase 0 — Foundations (make the invariants real)
- [x] **0.1 — 2024 by default** (Inv. 2, tool, S) — **landed `master`.** Flipped every `sourceRules`
  2014→2024 default (create-actor authored schema, `addPassiveFeature`, 3 attack builders, spell +
  weapon-item builders); reconciled the two feature-add paths (both default 2024); regression test
  asserts the authored-NPC default is 2024 and an explicit 2014 override still works. Gate green (625
  tests). *(Minor follow-up noted: `addSaveFeatureToActor` is hard-2024 — can't be overridden to 2014
  because its mode doesn't thread `sourceRules`; not a 2024-default issue.)*
- [x] **0.1b — Premium books only, NEVER the SRD** (Inv. 2, tool+skill, M) — **landed `master`.**
  Single source-of-truth `src/utils/compendium-sources.ts` (SRD deny-list `dnd5e.*` + the extensible
  premium-book set MM/PHB/DMG — a future book is a one-line add there; never SRD). Flipped every
  authoring default to premium (`add-feature` spell/feature schemas + the page-side fallbacks in
  `features`/`spells`/`compendium-features` that defaulted to 2014 SRD); added premium-first ranking to
  both searches (`compendium.ts`, `creature-index.ts`); rewrote every tool description + both builder
  skills to premium-only / never-SRD; test asserts the defaults are SRD-free + premium-first ordering.
  Full sweep confirms zero SRD-pull paths remain. Gate green (648 tests).
- [x] **0.1c — Active SRD-rejection guard** (Inv. 1+2, tool, S) — **landed `master`.** `assertNoSrdPacks`
  in `compendium-sources.ts`, wired into all four PULL entry points (`create-actor` compendium,
  `import-item`, `add-feature` spells + compendium-features) — a caller/skill that names an SRD pack is
  now *refused* with a message pointing at the premium equivalent. "Never SRD" is enforced BY
  CONSTRUCTION, not just by defaults/ranking/prose. Tests cover the guard; gate green (652).
- [x] **0.2 — One copy primitive** (Inv. 2, tool, M) — **landed `master`.** New page primitive
  `importFromCompendium` in `src/page/_shared.ts` (game.packs.get → getDocument → toObject → strip
  `_id`, with an optional `requirePackType` pre-fetch guard). Both whole-document copy paths route
  through it: `createActorFromCompendium` (uses `pack`+`source`, keeps its per-quantity `toObject()`)
  and `importItemFromCompendium` (uses the copy-ready `data`). Embedded-item copy
  (spells/compendium-features) keeps its hand-roll, as planned. Unit test added (`_shared.test.ts`);
  **parity verified live on `sandbox`** via new `scripts/verify-copy-primitive.mjs` (23/23 — content +
  art + all embedded items copied, fresh `_id`, guards fire). Gate green (693 tests).
- [x] **0.3 — Shared authoring-policy snippet** (cross-cutting, skill, S) — **landed `master`.** New
  single source `.claude/skills/_shared/authoring-policy.md` (2024-default · compendium-first/never-SRD ·
  copy→modify→rename · ask-don't-invent · authoring-not-play, tracing to design.md §2.3–§2.4/§6). Both
  authoring skills (`stat-block-builder`, `physical-item-builder`) now point to it instead of restating
  it inline; skill-specific bits (the NPC `@scale` fix, item-shaping rules) stay in their skills.
- [x] **0.4 — Type the tool↔page seam** (infra, tool, M/L) — **landed `master`.** `src/page/index.ts`
  now derives `export type PageApi = typeof api` (the `api` object carries a
  `satisfies Record<string, (...args) => unknown>` guardrail instead of a widening annotation);
  `FoundryBridge.call` narrows `name` to `keyof PageApi` (`T` stays first, so `call<Shape>('m', …)`
  sites are unchanged). A wrong/removed method name is now a `tsc` error across all ~110 tool call
  sites — proven to bite via a throwaway `@ts-expect-error` fixture. Runtime backstop:
  `src/foundry.seam.test.ts` parses the registration and asserts every `foundry.call('X')` targets a
  registered method. Zero call-site fallout; gate green (695 tests).

### Phase 1 — NPCs fully aligned (live block #1)
- [x] **1.1 — Prefab-first as a code path** (tool, M) — **landed `master`.** create-actor (compendium)
  gains an optional `modifications` passthrough — update-actor-shaped stat edits layered onto the
  instantiated WORLD COPY via the existing updateActor correctness (world-copy-only by construction;
  target pinned to the fresh copy after the spread so a stray `actorIdentifier` can't redirect it).
  Best-effort per actor; applies to every copy; the response reports what was layered on + warnings.
  create-actor description now advertises the three rungs in order. Live-verified 8/8 on sandbox
  (`verify-prefab-bridge.mjs`): edits land on the copy, the **source compendium entry is provably
  unchanged**, warn-not-block preserved.
- [x] **1.2 — `@scale` detection as a fact** (tool, M) — **landed `master`.** New pure helper
  `findUnresolvedScaleTokens` (deep `@scale.` scan → `{path, formula}`) wired into all three copy
  paths (addFeaturesFromCompendium / importItemFromCompendium / createActorFromCompendium); surfaced
  via one shared `formatUnresolvedScale` advisory (reports the token, proposes no value). Live-verified
  10/10 (`verify-scale-report.mjs`) — the real 2024 Breath Weapon hides its token in
  `damage.parts[].custom.formula`, confirming the scan-all-strings design; reported paths resolve on
  the live item; clean features not flagged.
- [x] **1.3 — Realign `stat-block-builder` + `physical-item-builder`** (skill, M) — **landed `master`.**
  stat-block-builder Step 0 rewritten as the explicit §6 ladder (prefab → prefab-as-base via
  `modifications` → authored-last); `@scale` guidance now consumes the reported fact (corrected the
  live "Breath Weapon" name + `custom.formula` patch path). physical-item-builder consumes the
  `import-item` `unresolvedScale` report. Shipped with 1.1/1.2.

### Phase 2 — Journals fully aligned (live block #2 + §8 landing zone)
- [x] **2.1 — De-leak the quest tool** (tool, M) — **landed `master`.** Deleted the prose generators
  (`quest/quest-content.ts` + the prose assembler in `quest-template.ts`, both files removed); new pure
  typed-block renderer `src/tools/journal/blocks.ts` (heading/lead/paragraph/readaloud/gmnote/list/grid/
  html → the `.mcp-journal` house style, `<script>`-stripped). `create-quest-journal` is now
  structuring-only (`pages[].blocks` + `playerVisible`); `update-quest-journal` appends a styled section
  from blocks; `link-quest-to-npc` inserts a real `@UUID[Actor.id]` link (refuses an unknown NPC).
  Deepened the page model: per-page ownership in `createJournal`/`updateJournalContent` (handout vs
  GM-only), `playerVisible` surfaced in the page manifest; removed the quest-specific `createJournalEntry`.
  Gate green (723 tests); live-verified 15/15 on `sandbox` (`verify-journal-tooling.mjs` — per-page
  ownership PERSISTS in v14, blocks round-trip, @UUID link resolves, recap append).
- [x] **2.2 — `journal-builder` skill** (skill, L) — **landed `master`.** New
  `.claude/skills/journal-builder/SKILL.md`: the judgment/prose layer (you write the words, the tool
  structures) — page kinds (handout/lore/read-aloud/GM-notes/quest/session-recap), the quest
  page-template, player-vs-GM visibility, `@UUID` linking, the §8 session-log path; references
  `_shared/authoring-policy.md` with the journal-prose clarification. Shipped with 2.1.

### Phase 3 — Remaining content blocks
- [x] **3.1 — Tables** (tool+skill, M/L) — **landed `master`.** **3.1a** (`23ce79a`): fixed the v14
  `TableResult` bug (the canonical field is `description`, not the v14-dropped `text` — spike
  `scripts/spike-rolltable-schema.mjs`); compendium-referencing results (`uuid` → book-style
  `@UUID[…]{Name}` enricher with premium-only + resolvable guards, `{{link}}` mixed-loot placeholder);
  `roll-on-table` surfaces drawn @UUID links as importable; new `table-builder` skill. **3.1b**
  (`a287030`): `import-rolltable` copies a published compendium table into the world (the table copy
  primitive via §0.2 `importFromCompendium`) — unblocks the DMG-treasure workflow (roll-on-table is
  world-only). Gate green (729); live-verified 19/19 on `sandbox` (`verify-table-tooling.mjs`).
- [x] **3.2 — Cards** (tool+skill, M) — **landed `master`.** Cards have NO premium-book compendium
  (asset-driven like scenes — compendium-first N/A). Enhanced `create-cards` with per-card face `text`
  (v14 face `{name, text?, img?}`) so a themed deck (Deck of Many Things) renders effect text;
  `import-cards` instantiates a core PRESET deck (`pokerDark`/`pokerLight` = a standard 52-card deck —
  the only "ready-made deck" path, no compendium); new `cards-builder` skill. Spike
  `scripts/spike-cards-schema.mjs`. Gate green (731); live-verified 7/7 (`verify-cards-tooling.mjs`).
- [x] **3.3 — Playlists** (skill, S/M) — **landed `master`.** Tools were already v14-correct (spike
  `scripts/spike-playlist-schema.mjs` confirmed the PlaylistSound file field is still `path`), so this
  is skill-only: new `playlist-builder` skill (mode judgment sequential/shuffle/simultaneous/soundboard,
  volume/repeat/fade, scene-ambience vs combat-music vs SFX, asset-driven audio); `scene-builder` now
  **delegates** new-playlist authoring to it (keeps the scene `playlist` link wiring). Audio has no
  compendium (asset-driven like scenes). Live-verified 8/8 (`verify-playlist-tooling.mjs`).

### Phase 4 — Continuous correctness hardening (parallel, non-blocking)
- [ ] Generate `add-feature` schema from zod (don't split it); split `create-actor` →
  `create-actor-from-compendium` + `author-npc`; rename `CharacterTools`→`ActorTools`; structured error
  taxonomy; offline pure-builder tests.

### Phase 5 — PCs (LAST, separate effort)
- [ ] Reserved until 0–3 land. Re-run the advancement spike, then build the parallel
  `create-pc`/`pc-builder` family.

---
*Phase 0 (Foundations) **COMPLETE**. Phase 1 (NPCs) **COMPLETE** (live-verified 10/10 + 8/8). Phase 2
(Journals) **COMPLETE** (15/15). Phase 3 (Remaining content blocks) **COMPLETE** — 3.1 Tables (v14
`description` results + compendium `@UUID` loot links + `import-rolltable` + `table-builder`, 19/19) ·
3.2 Cards (face text + `import-cards` presets + `cards-builder`, 7/7) · 3.3 Playlists (`playlist-builder`
+ scene-builder delegation, tools v14-verified, 8/8), all landed on `master`. **Every design.md §5
content building block now has its judgment skill + verified tools.** Next: **Phase 4 — continuous
correctness hardening** (parallel/non-blocking: generate `add-feature` schema, split `create-actor`,
rename `CharacterTools`→`ActorTools`, **extract `ItemTools`**) — then **Phase 5 — PCs** (last).*
