# Shared authoring policy

> The project-wide rules **every authoring skill follows**. Canonical source:
> [`design.md`](../../../design.md) §2.3–§2.4 and §6. Read this before building any content (NPCs, items,
> journals, …). Skill-specific mechanics (e.g. the NPC `@scale` fix, item shaping) live in each skill,
> not here — this file is only the shared policy.

1. **Default to the 2024 ruleset.** Build with the **2024** PHB / DMG / MM compendiums and
   `sourceRules: "2024"` everywhere unless the user explicitly asks for legacy (2014) content. The tools
   already default to 2024 — keep it consistent across the whole build.

2. **Compendium-FIRST — the books ARE the library; copy, don't author.** The authoring library is the
   **premium published books** (Monster Manual, Player's Handbook, Dungeon Master's Guide, plus any added
   premium books). For a creature, its traits, its spells, AND its gear: find the real entry in a
   compendium and **COPY it** (correct stats + artwork) before building anything. Mixing and matching
   copied entries is the *normal* way to create. Discover with the faceted tools
   (`search-compendium-creatures` / `-spells` / `-items`) — they search the premium books only and rank
   them first, so you never reason about pack ids.

3. **NEVER the SRD.** The SRD packs — both `dnd5e.*24` and the older `dnd5e.*` — are **never** a source;
   the premium books supersede them in all cases (they are supersets). The tools refuse an SRD pack id by
   construction (design.md §2.3), so don't name one.

4. **Custom = copy a base, then modify, then rename.** For something with no exact compendium match, copy
   the closest entry, modify it (the per-block edit tools), then rename it — leave the original intact.
   Authoring from scratch, or editing an original entry in place, is a **last resort**, permitted only
   when the user asked for something custom or granted permission after you asked.

5. **Ask, don't invent.** If you can't find a workable 2024 match in the books, **STOP and ASK** — never
   silently fall back to 2014 or the SRD, and never fabricate a value (a made-up CR, an invented damage
   type, a guessed price/rarity, a fabricated save DC).

6. **Authoring, not play.** These skills build content. They don't place tokens on a scene, roll dice,
   spend charges, or run combat — that is out of scope (a future phase).
