# Architecture & design-alignment review

> Point-in-time review of the tool + skill surface against [`design.md`](../design.md), with a
> long-term-architecture roadmap. Produced 2026-06-24 by a multi-agent pass (5 code-review
> dimensions + 2 Foundry/dnd5e API-research streams → lead-architect synthesis → adversarial
> verification). **Verdict: Sound-with-revisions.** State reviewed: `master` @ `c304aa9`, ~76 tools,
> 623 unit tests green. **The MCP was pointed at the old (deleted) world during the review, so every
> finding is source/API-level, not live-executed** — items needing a live check after a Claude Code
> restart are listed in §7.

---

## 1. Headline findings

1. **The foundation is solid — this is a base to build on, not a rewrite.** The three load-bearing
   structural bets are exactly what the design demands: the single `foundry.call()` Playwright
   quarantine (`src/foundry.ts`), the derive-don't-duplicate registry (`src/registry.ts`), and the
   single-zod schema generation (`src/utils/schema.ts`). The NPC↔PC seam (§7) is **not** corrupted —
   the actor core is type-agnostic and NPC-only fields are already fenced behind a `npcOnly()` gate.

2. **Compendium-first (§2.3) is the project's core principle, and today it is a *convention the skill
   must remember*, not a *property the architecture enforces*.** This is the dominant theme. Evidence:
   the NPC skill leads with `source:"authored"` instead of prefab-first; the authored NPC defaults to
   `sourceRules:'2014'` (a §2.3/§4 violation at the root document); rungs 1 (prefab) and 2
   (mix-and-match) are disjoint with no "copy a prefab, then customize" bridge.

3. **Two judgment-in-a-tool leaks violate §2.1.** (a) **Severe:** `create-quest-journal` *fabricates
   creative content* — read-aloud boxed text, NPC dialogue, hooks — inside the tool layer, even
   branching on `questDescription.includes('blight')`. That is D&D authoring masquerading as
   deterministic correctness. (b) **Softer:** the `@scale` dangle is left entirely to skill vigilance
   when *detection* is mechanical and belongs in the tool (the tool should *report the unresolved
   token as a fact*; the skill still *chooses the die*).

4. **The PC builder (§7) is 100% greenfield, and the path is research-validated but needs a live
   spike.** `dnd5e.documents.advancement.AdvancementManager.forNewItem(actor, classItemData,
   {render:false})` is the supported, headless-capable seam that makes 2024 features resolve `@scale`
   natively. The one open question (Med confidence): does that flow *complete* non-interactively, or
   need an explicit step-drive? **Spike this before committing the PC architecture.** The PC product
   must be its own tool+skill family — never a branch bolted onto `handleCreateNpc`.

5. **Skill coverage is lopsided: only 2 of 6 content building blocks (§5) have a judgment layer.**
   Scenes, NPCs/items, and chat have skills; **journals, tables, cards, and playlists have none.**
   Journals are the worst gap — current-phase scope *and* the explicit Phase-2 landing zone (§8). A
   `journal-builder` skill is the single highest-value addition.

6. **Two latent correctness bugs to fix regardless of roadmap.** (a) **RollTable / v14:**
   `buildTableResults()` writes the deprecated `TableResult.text` field; v13 renamed it to
   `description` and v14 removed the migration shim — a core building block is one point-release from
   silently producing empty results. *(Corrected by the adversarial pass: the code writes a **string**
   `type:'text'`, not a numeric shim — so the fix is **only** `text`→`description`, no numeric-type
   hunt.)* (b) **2024 default:** authoring paths default `sourceRules:'2014'` (`tools/dnd5e/npc.ts:214`,
   `page/dnd5e/features.ts:189`), and the two feature-add paths disagree with each other.

7. **One HIGH structural debt to pay before the PC phase: the Node↔page seam is untyped string
   dispatch with no contract check.** ~81 `foundry.call('name')` literals vs ~83 page keys, with zero
   static or unit verification — a typo or rename passes the entire green gate and fails only in a
   live session. The registry already proves the can't-drift pattern; the seam needs the same.

8. **The adversarial pass tightened the plan.** It confirmed the core findings against source, then
   **cut** four pieces of over-reach (see §6 "Cut"). The roadmap below already incorporates its
   corrections.

---

## 2. Alignment scorecard

| design.md principle / section | Rating | Reason |
|---|---|---|
| §1 Mission + phasing | **Aligned** | Phase-1 content tools present; chat/export kept thin as the clean Phase-2 seed. |
| §2.1 "Skills decide, tools do" | **Partial** | `create-quest-journal` fabricates prose in-tool; `@scale` detection left to skill — two leaks. |
| §2.3 Compendium-first, mix-and-match | **Partial** | Great copy tools, but prefab-first is convention not structure; 2014 default; no prefab→customize bridge. |
| §2.4 Ask, don't invent | **Aligned** | Authoring skills carry explicit STOP-and-ASK / no-silent-2014 gates. (Must stay a cross-cutting criterion as new authoring tools land.) |
| §5/§7 NPC↔PC are different products | **Aligned (seam) / Gap (PC unbuilt)** | Type-agnostic core + `npcOnly()` honor the split; no PC product yet, nothing blocks it. |
| §6 NPC authoring ladder | **Partial** | Every rung's *tools* are strong; the *ladder ordering* (prefab-first, gated custom) is softer in the skill than §6 demands; rungs 1↔2 are a cliff. |
| §5 Journals as content + §8 landing zone | **Gap** | Quest content fabricated in-tool; thin page model; no journal skill. |
| §5 Other blocks (scenes/tables/cards/playlists) | **Partial** | Scenes solid; tables/cards/playlists creatable but shallow and skill-less. |
| §9 Core architecture | **Partial** | Quarantine + registry + schema-gen exemplary; weakened by the untyped seam, one hand-written schema, `globalThis` doc refs, substring error classification. |

---

## 3. Current-state map (SOLID / THIN / MISSING)

- **NPCs** — *SOLID tools* (`create-actor`, `update-actor`+`npcOnly()`, `add-feature`, `add-item`,
  `import-item`, `manage-activity/effect`, `apply-condition`, `update-actor-item`), *THIN doctrine
  enforcement* (skill leads with authoring; 2014 default; no `@scale` affordance; no prefab-as-base).
- **PCs** — *MISSING* (no `type:character` builder, no advancement logic). Note: the type-agnostic
  core can already clone a `type:character` compendium actor today — a free "prefab PC" rung.
- **Journals/Quests** — *THIN tools + a judgment leak; MISSING skill.* The §8 landing zone.
- **Scenes** — *SOLID* (skill + tools). Minor: it also authors playlists (responsibility creep).
- **Tables** — *THIN + the v14 latent break; MISSING skill.* No compendium-referencing results.
- **Cards** — *THIN; MISSING skill.* Create/list/delete only (correct for Phase 1 — see §6 E3).
- **Playlists** — *THIN; MISSING skill.* Authored as a side-effect of `scene-builder`.
- **Chat / DM-assist (Phase-2 seed)** — *SOLID for its phase*; correctly minimal. Leave it thin.
- **Core infra** — *SOLID with named debts* (untyped seam; `page/actors.ts` ~1750 lines &
  `add-feature.ts` ~1450 lines monoliths; one hand-written schema in `grant-to-actor.ts`;
  `CharacterTools` naming collision; substring `ErrorHandler`; `globalThis` doc-class refs).

---

## 4. Prioritized gaps

| # | Gap | Sev | Against |
|---|---|---|---|
| G1 | `create-quest-journal` fabricates prose/dialogue/hooks in-tool | **High** | §2.1 |
| G2 | Compendium-first is convention not structure (skill leads with authoring; no prefab→customize bridge) | **High** | §2.3/§6 |
| G3 | Node↔page seam is unchecked string dispatch | **High** | §9 |
| G4 | `sourceRules` defaults to 2014 in authoring; two feature-add paths disagree | **High (cheap)** | §2.3/§4 |
| G5 | `@scale` dangle has no tool affordance (detection only in prose) | **High** | §2.1/§6 |
| G6 | No journal/table/cards/playlist/PC skills | **High** (journals) / Med | §5/§8 |
| G7 | RollTable writes deprecated v14 `text` field | **High** | §3 |
| G8 | Umbrella tools front multiple contracts (`create-actor`, `add-feature`); `add-feature` schema is hand-written | **Med** | §3/§9 |
| G9 | `CharacterTools` naming collides with the future PC product | **Med (→High at PC)** | §2.5 |
| G10 | Page-layer correctness under-covered offline; `globalThis` refs; substring errors; monolith files | **Med** | §9 |
| G11 | Generic-system bleed vs dnd5e-only scope | **Low** | §9 |
| G12 | Duplicated policy prose; stale-bundle footgun; scattered dnd5e quirks | **Low** | §9 |

---

## 5. Target architecture (the "solid base")

**Tools own deterministic correctness only.** Evict the leaks: reduce `create-quest-journal` to a
*structuring* tool (accept structured pages → emit styled HTML; delete the prose generators in
`quest/quest-content.ts`); add an `@scale` *detection* affordance that **reports** unresolved tokens
as a fact (`unresolvedScale:[{itemId, activityId, path, formula}]`) — the die choice stays in the
skill.

**Skills own judgment.** Pack ids, the `add-feature` mode-shape, and item field-name tables move out
of skill prose into tool defaults/schemas — a dnd5e pack rename becomes a one-line tool change.

**NPC pipeline — compendium-first *by default*, structurally:** prefab-first is the spine
(`search-compendium-creatures` → `create-actor-from-compendium`, authoring is the gated *else*); add a
**prefab-as-base bridge** that layers modifications onto the *instantiated world copy* (never the
source document); 2024 default enforced by a unit assertion.

**Copy primitives — two, not one:** adopt `importFromCompendium`/`importDocument` for **whole-document
instantiation** (actors, journals, world-items); **keep** a *centralized* `toObject()+delete _id` for
**embedded-item copy** onto an existing actor (`add-feature`, spells) — these are different operations
and must not be conflated.

**PC/advancement — shared thin core, separate composition layers.** Share the actor-shape-neutral
correctness core (copy/import primitive, embedded-item/activity/effect editors, currency, identity/
art/ownership). Diverge into a new `pc.ts` page module + `create-pc`/`add-class` tool family +
`pc-builder` skill, parallel to `npc.ts` — **never extend `handleCreateNpc` to emit `type:character`**.
The advancement engine drives `AdvancementManager.forNewItem(..., {render:false})`; the *choices* live
in the skill. Ship incrementally: prefab PC (free today) → copy-and-relevel → full advancement build.

**Skill catalog — one judgment layer per building block:** keep the 5 existing (realign
`stat-block-builder` to the ladder; trim `scene-builder`'s playlist authoring; thin
`physical-item-builder`'s field tables). Add: **`journal-builder`** (top priority), **`table-builder`**,
**`cards-builder`**, **`playlist-builder`**, **`pc-builder`** (stub now, build later), and one shared
**authoring-policy snippet** all authoring skills reference.

**Leave alone (load-bearing):** `foundry.ts` quarantine; `registry.ts` derive-from-handlers +
`registry.test.ts`; `schema.ts` single-source; `_shared.ts` `toSource`/sanitizer chokepoint; the
pure-builder/applier split; lazy-connect self-heal; the CI gate; the thin chat/export plumbing; the
`@scale` honesty in tool descriptions.

---

## 6. Reconciled roadmap (adversarial corrections applied)

**Spike (do NOW, parallel — needs a Claude Code restart for live access):**
- **S1 — PC advancement live-spike.** Confirm `AdvancementManager.forNewItem(actor, classItemData,
  {render:false})` *completes* headlessly and `@scale` resolves on a live PC. The make-or-break unknown
  for the entire PC product — run it first, decoupled from its dependencies. *Size: S (spike).*

**P0 — Foundational correctness & doctrine (cheap, high-value, first):**
- **P0a — 2024 default everywhere** (G4). Flip the defaults; **reconcile the two disagreeing
  feature-add paths**; expect fixture churn; add a regression assertion. *S/M.*
- **P0b — RollTable v14 fix** (G7). Write `description` instead of `text` (keep the string `type`; **no
  numeric-shim hunt** — it isn't there). **Live roll-test before merge.** *S.*
- **P0c — Type the Node↔page seam** (G3). `satisfies` + derived `PageApi` + a name-coverage unit test.
  Touches every tool file; will surface latent mismatches. *M/L.*
- **P0d — Evict quest prose from the tool** (G1). Reduce to a structuring tool; delete the generators.
  **Must land adjacent to P2a** so the capability isn't dark for a phase. *M.*

**P1 — Compendium-first becomes structural + NPC hardening:**
- **P1a — `@scale` detection affordance** (G5). Tool *reports* unresolved tokens; skill resolves the
  die. *M.*
- **P1b — Whole-document import primitive** (G2). Adopt `importFromCompendium`/`importDocument` for
  whole-doc instantiation **only**; keep the centralized hand-roll for embedded-item copy. **Blocking
  live parity-gate inside this item; hand-roll stays as fallback until parity is proven.** *M.*
- **P1c — Reorder `stat-block-builder` to the §6 ladder** (G2). Prefab-first as Step 1; move pack ids
  into tool defaults. Ships *with* the skill edit. *M.*
- **P1d — Prefab-as-base bridge** (G2). Acceptance criterion: operates on the instantiated world copy
  only; the source compendium doc is never opened for write. *M.*
- **P1e — Rename `CharacterTools`→`ActorTools`/`WorldItemTools`** (G9); reserve "Character"/"PC" for
  the §7 product. Land with dependent skill edits + a one-release deprecation alias. *(Dropped from
  here per the adversarial pass: `characterOnly()` → P3b; the 5-way `page/actors.ts` carve → P4.)* *M.*

**P2 — Journal capability + the missing skills (current scope + §8 foundation):**
- **P2a — `journal-builder` skill + deepened journal page model** (G6, §8). Category/sort/ownership/
  explicit `text.format`/page-aware read; quest as a *page template*. Pairs with P0d. *L.*
- **P2b — `table-builder` (+ compendium-referencing results), `cards-builder` (create/import decks
  ONLY — in-play deal/draw/shuffle are Phase-2, cut here), `playlist-builder` (scene-builder delegates
  to it).** *L.*
- **P2c — Shared authoring-policy snippet; `pc-builder` stub** reserving the split. *S.*

**P3 — PC builder (the §7 product):**
- **P3b — Advancement seam tool** (`add-class`/`apply-advancement`) + introduce `characterOnly()`
  here + a shallow advancement read-projection on `get-actor-entity`. *Deps: S1, P1b, P1e. L.*
- **P3c — `create-pc`/`author-pc` family + `pc-builder` skill** (the leveling pipeline). Ship the
  prefab-PC rung early. *Deps: P3b. L.*

**P4 — Continuous core hardening (not phase-gating):**
- Generate the `add-feature` schema from zod **(do NOT split it into per-mode tools)**; split the
  `create-actor` umbrella into `create-actor-from-compendium` + `author-npc` (a real product
  boundary); structured error taxonomy (code, not substring); doc-class accessor + `globalThis`
  migration; the 5-way `page/actors.ts` split (demoted here); offline pure-builder tests; page-bundle
  freshness guard; prune generic-system bleed; indexed `creature-index.ts`.

**Cut entirely (adversarial pass):** splitting `add-feature` into 7 tools (generate its schema
instead); `characterOnly()` before any PC code exists; in-play card verbs in Phase 1 (phasing
violation); the `page/actors.ts` carve as a *pre-PC prerequisite* (only a new `pc.ts` is required).

**Cross-cutting acceptance criteria:** (1) every new authoring tool ships a test that the *tool* never
invents D&D values, and every authoring skill preserves the STOP-and-ASK gate (§2.4); (2) every tool
rename/split lands with its dependent skill edits in the *same* change (+ a deprecation alias for one
release); (3) live-verify checkpoints are wired into S1, P0b, and P1b — not deferred.

---

## 7. Needs live verification (after a Claude Code restart)

The running MCP captured the old world id at startup; `.env`/`LOCAL.md` now say `sandbox`, but a
restart is required before any of these can be checked live:

1. **`AdvancementManager.forNewItem({render:false})` headless completion** (S1) — highest stakes;
   gates the whole PC product.
2. **`@scale` resolution** on a live PC (embed advancement-bearing class item → token populates).
3. **RollTable write** (P0b) — a written table rolls correctly; confirm the compendium-result
   `documentUuid` form.
4. **`importFromCompendium`/`importDocument` parity** (P1b) — embedded items/effects/prototypeToken
   travel; cleaning options behave as documented.
5. **Version pins** — confirm the live Foundry (v14) + dnd5e (5.3.x) before acting on any
   deprecation-driven change (`globalThis` doc classes, spell-prep shape, activities Map).
6. **Sandbox compendium inventory** — design.md §2.3 assumes the premium 2024 MM/PHB/DMG packs are
   "always installed"; the freshly recreated `sandbox` world must be confirmed to actually have them
   (and the `*24` SRD packs), or the whole compendium-first doctrine has no library to draw from.

---

## 8. Open product question

Collapse the quest tool family entirely into the generic journal tools (quest = a journal *page
template*) during P0d/P2a, or keep a thin distinct `create-quest-journal` structuring tool? Both
satisfy §2.1; the collapse is cleaner long-term but a larger surface change. **Recommend deciding at
the start of P2a.**
