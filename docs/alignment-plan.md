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
- [ ] **0.4 — Type the tool↔page seam** (infra, tool, M/L, parallel). `satisfies` + derived `PageApi`
  + coverage test. *Done when:* a wrong `foundry.call` name fails the gate, not a live session.

### Phase 1 — NPCs fully aligned (live block #1)
- [ ] **1.1 — Prefab-first as a code path** (tool, M). Copy-default structural; prefab-as-base path
  (instantiate MM actor → layer mods on the *world copy* only).
- [ ] **1.2 — `@scale` detection as a fact** (tool, M). Copy tools report unresolved `@scale` tokens;
  the skill picks the die, the tool never guesses.
- [ ] **1.3 — Realign `stat-block-builder` + `physical-item-builder`** (skill, M). Prefab search is the
  first move; pack-ids move into tool defaults; copy→modify→rename for items. *Ships with 1.1/1.2.*

### Phase 2 — Journals fully aligned (live block #2 + §8 landing zone)
- [ ] **2.1 — De-leak the quest tool** (tool, M). `create-quest-journal` → structuring-only; delete
  prose generators; deepen the page model.
- [ ] **2.2 — `journal-builder` skill** (skill, L). The judgment layer; quest becomes a page template.
  *Ships with 2.1.*

### Phase 3 — Remaining content blocks
- [ ] **3.1 — Tables** (tool+skill, M/L). Fix v14 `description` schema; compendium-referencing results;
  `table-builder` skill. *Live-verify a roll.*
- [ ] **3.2 — Cards** (tool+skill, M). Create/import decks only (no in-play verbs); `cards-builder`.
- [ ] **3.3 — Playlists** (skill, S/M). `playlist-builder`; `scene-builder` delegates to it.

### Phase 4 — Continuous correctness hardening (parallel, non-blocking)
- [ ] Generate `add-feature` schema from zod (don't split it); split `create-actor` →
  `create-actor-from-compendium` + `author-npc`; rename `CharacterTools`→`ActorTools`; structured error
  taxonomy; offline pure-builder tests.

### Phase 5 — PCs (LAST, separate effort)
- [ ] Reserved until 0–3 land. Re-run the advancement spike, then build the parallel
  `create-pc`/`pc-builder` family.

---
*First unit in flight: **0.1** (2024 by default), paired with **0.3**, with **0.4** started in parallel.*
