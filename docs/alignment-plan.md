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
2. **Tools are 2024 + compendium-first by construction** — no `2014` default; copying a compendium
   entry is the spine primitive, not a skill-selected option.
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
- [ ] **0.1 — 2024 by default** (Inv. 2, tool, S). Flip every `sourceRules` 2014→2024 default;
  reconcile the disagreeing feature-add paths; regression test. *Done when:* an authored NPC/feature
  is born 2024 with no skill override, asserted by a test.
- [ ] **0.2 — One copy primitive** (Inv. 2, tool, M). Whole-doc copy → `importFromCompendium`; keep
  the centralized hand-roll for embedded-item copy. *Done when:* each copy path routes through one
  primitive; **parity verified live**.
- [ ] **0.3 — Shared authoring-policy snippet** (cross-cutting, skill, S). *Done when:* no skill
  restates the policy inline.
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
