# Compendium-lookup overhaul — plan & tracker

> Crisp, checkbox-driven tracker for reshaping how compendium lookups work, aligned to
> [`design.md`](../design.md). Sub-project of the broader [`alignment-plan.md`](alignment-plan.md).
> Live ground truth (dnd5e 5.3.3 facts the build depends on): the `fvtt-mcp-compendium-lookup-facts`
> memory + the re-runnable probe `scripts/spike-compendium-lookup.mjs`.

## Locked architecture (2026-06-25)

**Unify the *mechanism*, keep the *tools* focused and fully-typed.**

- **One shared engine** (`src/page/compendium-facets.ts`): a document-type-parameterized faceted
  search built on dnd5e's own Compendium Browser (`CompendiumBrowser.fetch` + `dnd5e.Filter`),
  with a raw-`getIndex` fallback. All anti-fragmentation value lives here — no duplicated
  search/SRD/ranking machinery, **no per-pack reasoning** (discovery is by document TYPE, which
  spans every in-scope book; pack-id suffixes are non-uniform across books).
- **Thin, fully-typed tool facades** over the engine — one per content family. Each has a crisp,
  type-specific schema so illegal facet combinations are unrepresentable (design.md §2.1, "a tool
  is a contract") and the LLM selects the right tool by name. This is **not** additive sprawl —
  the facades are ~30-line wrappers over the single engine; the sprawl we reject is *duplicated
  mechanism + pack-reasoning*, which the engine eliminates.
- **never-SRD (design.md §2.3)** is enforced in the engine by deriving each hit's pack from its
  `uuid` and dropping SRD — `fetch` *does* return SRD packs, so this post-filter is mandatory
  (goes no-op once the Assistant GM can't see SRD packs at all).

### End-state tool surface (search side)
| Tool | Query | Facets |
|---|---|---|
| `search-compendium` | broad **name** substring across premium types | — (the #3 name-heuristic filters are deleted) |
| `search-compendium-creatures` | creature facets | CR · type · size · hasSpells · hasLegendary (+name) |
| `search-compendium-spells` | spell facets | level · school · **damageType** (two-stage) (+name) |
| `search-compendium-items` | gear facets | rarity · itemType · properties · magical (+name) |
| `get-compendium-entry` | by pack+id | — (unchanged) |
| `list-compendium-packs` | inventory | — (unchanged) |

All faceted tools return the uniform `CompendiumHit` shape `{id,name,type,uuid,pack,packLabel,img,facets}`,
premium-first ranked. `search-compendium-creatures` is **kept (re-backed by the engine), not deprecated.**

## Done (shipped to `master`, gate green throughout)
- [x] **SRD fully excluded from lookups** (`0be24fe`) — deny-list at every lookup, not last-ranked;
  enforced page + node; forward-compatible with permission-hiding.
- [x] **Index-driven creature discovery** (`f09aa03`) — `buildCreatureIndex` reads `getIndex({fields})`
  not `getDocuments()` (the #4 perf fix) + latent size-filter bug fixed. Adversarially verified.
  *(Interim — its creature-index path is superseded by the engine in step 2c.)*
- [x] **Live ground-truth spike** (`3adcd0f`, `scripts/spike-compendium-lookup.mjs`) — confirmed
  `CompendiumBrowser.fetch`, creature/spell/gear facets + keypaths, getIndex caching, SRD-returned-by-fetch.
- [x] **Faceted engine** (`9c6afd4`, `src/page/compendium-facets.ts`) — `searchCompendiumFaceted`
  (fetch + getIndex fallback), facet→`{k,o,v}` builder, two-stage spell-damage, SRD-exclusion-by-uuid,
  premium-first ranking, uniform `CompendiumHit`. Registered as a bridge method. 12 pure-logic tests.
  *(The composed live path is NOT yet exercised end-to-end — only its primitives are spike-confirmed.)*

## Plan (check off as landed)

### Phase 2 — Node tool facades over the engine *(each: zod schema → `searchCompendiumFaceted` → `CompendiumHit[]`; tests + premium-only descriptions; registered in `src/registry.ts`)*
- [x] **2a — `search-compendium-spells`** (new). Facets: `spellLevel` (num|range), `spellSchool`,
  `damageType` (two-stage), `name`, `limit`. Thin facade on `CompendiumTools` hard-coding
  `documentType:'spell'`; SRD backstop + premium-only description; 77 tools. Added engine-side
  `SPELL_SCHOOL_TO_DND5E` so friendly school names ('evocation') normalize to dnd5e keys ('evo')
  alongside `SIZE_TO_DND5E`. Gate green (690 tests). **Live verify deferred to Phase 4 (restart).**
- [x] **2b — `search-compendium-items`** (new). `documentType` gear|weapon|armor|consumable; facets:
  `rarity`, `itemType` (subtype), `properties`, `magical`, `name`, `limit`. Thin facade on
  `CompendiumTools`; SRD backstop; premium-only description; 78 tools. Engine: added
  `RARITY_TO_DND5E` so friendly "very rare" normalizes to the camelCase `veryRare` key. Gate green
  (698 tests). **Live verify deferred to Phase 4.**
- [x] **2c — Re-back `search-compendium-creatures` on the engine** (`documentType: creature`);
  output is now the uniform `CompendiumHit` shape. **Deleted `src/page/creature-index.ts` + its test**
  (buildCreatureIndex/projectIndexEntry/passesCriteria/listCreaturesByCriteria **and** the unused
  `getEnhancedCreatureIndex`); removed both bridge registrations from `page/index.ts`; dropped the
  orphaned `hasSpellcasting`/`formatCreatureListItem`. Repointed the 4 live harnesses (reads +
  write-cycle integration tests, verify-reads + verify-write-tools scripts) to
  `searchCompendiumFaceted`. Gate green (690 tests). Skill prose realign → 3a. **Live verify → Phase 4.**
- [x] **2d — Reduce `search-compendium` to name-only** (#3): removed the name-heuristic `filters`
  (schema field + `GenericFiltersSchema`/`describeFilters` imports) and the keyword-guess code in
  `src/page/compendium.ts` (the CR/type term-guessing + `calculateRelevanceScore`/`matchesSearchCriteria`/
  `shouldApplyFilters` helpers). **Deleted the now-dead `src/utils/compendium-filters.ts` module.**
  Kept the premium-only name-index scan + premium-first/exact-name ranking. Tool description rewritten
  to point faceted queries at the type-specific tools. Gate green (689 tests).
- [x] **2e — Registry + counts**: 2a/2b were registered in `registry.ts` and `registry.test.ts` count
  bumped to **78** in their own commits; the `CompendiumTools` "six tools" test covers the surface. No
  separate change needed.

### Phase 3 — Skills (ship with their tools)
- [ ] **3a — `stat-block-builder`**: discover via `search-compendium-creatures` / `-spells` by
  type+facet; drop hard-coded pack-id reasoning (the §6 need→pack table is now the tool's job).
- [ ] **3b — `physical-item-builder`**: discover gear via `search-compendium-items` by rarity/type;
  drop pack-id reasoning.

### Phase 4 — Live verification *(needs an MCP restart — the running bundle is stale)*
- [ ] **4a** — restart Claude Code (loads the new `dist/page.bundle.js` + new tools).
- [ ] **4b** — live smoke-test each faceted tool on `sandbox`: creatures (CR/type/size), spells
  (level/school + a `damageType:fire` two-stage), items (rare wondrous). Confirm **no SRD**, premium-first,
  sane counts; re-run `scripts/spike-compendium-lookup.mjs` if a primitive needs re-confirming.
- [ ] **4c** — adversarial-verify the finished surface; confirm full gate green.

## Execution discipline
- One coherent unit per commit (tool + its tests + any skill change together); commit direct to
  `master`; **full gate** (biome · tsc · vitest · build · knip) **+ adversarial verify** each unit.
- **New tool/page code needs a CC restart to go live** in the running MCP; final sign-off is the
  Phase-4 live smoke test, not just the gate.
- Engine + facades return the uniform `CompendiumHit`; tool descriptions state premium-only / never-SRD.

## Key gotchas (so the next session can act cold)
- `CompendiumBrowser.fetch` **returns SRD** → `excludeSrdPacks`-by-uuid (already in the engine).
- Size is a dnd5e **key** (`med`/`lg`/`sm`/`grg`) — `SIZE_TO_DND5E` maps the friendly enum.
- Spell **damageType** lives in the activities Map (not indexable) → two-stage (load survivors).
- `ac.value` is derived/not-indexable; `hasSpells`/`hasLegendary` are index **approximations**
  (`spell.level>0` / `legact.max>0`) — fine for discovery; real detail via `get-compendium-entry`.
- Engine API: `searchCompendiumFaceted({documentType, name?, ...facets, limit?})`; `CONTENT_TYPES`
  maps friendly type → `{documentName, dndTypes, kind}`; extend it (not new tools) for new content.
