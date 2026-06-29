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

7. **Finish the reskin — swap off-theme content for REAL content; never a "pretend" note.** When you
   copy-and-modify (rule 4) and the result's theme differs from the base — a radiant Priest reused as a
   necrotic Shar priestess, a fire creature reskinned to cold — the base's mismatched abilities are
   **not** resolved by reflavoring them in prose. Go back to the compendium and **replace** them with
   real entries that fit: pull theme-appropriate features from the MM features pack (or a matching
   creature's attack via `add-feature`), real spells of the right damage type, the right gear — and
   **remove** the off-theme originals (`remove-from-actor`). Writing *"treat its Radiant Flame as
   necrotic"* or *"its Light is really gloom"* is a forbidden cop-out: the document must actually BE
   what it claims to be, in its real mechanics, not in a GM note. If the books truly have nothing that
   fits, STOP and ASK (rule 5) — don't paper over the gap.

8. **No blank art — every authored document gets an approximating compendium icon/portrait.** Authoring
   from scratch (`add-item`, `author-npc`, authored features) leaves a generic placeholder
   (`systems/dnd5e/icons/svg/...`); that reads as unfinished and is not acceptable in delivered content.
   Before you finish, set the document's `img` from a **real compendium entry that approximates it** —
   `search-compendium-*` for the closest same-kind/thematic one and copy its `img` (`update-item` /
   `update-actor-item` / `set-actor-art`). Copied documents (`import-item` /
   `create-actor-from-compendium`) already carry real art; this rule is for the **authored** ones.
   **This includes authored FEATURES and abilities** — an `add-feature` passive/attack/etc. shows a
   blank star until you set its `img`. Set each authored feature's icon (with `update-actor-item img`)
   from the compendium feature you are emulating, right after you author it — every row on the sheet
   carries real art, or you are not done.

9. **A magic item you put on an NPC must ALSO exist as a world Item, for loot.** When you give an NPC
   notable gear (a magic weapon, a wondrous item, a special consumable), the on-actor copy is for the
   NPC to wield — but the party loots it afterward. Create a matching **world Item** in a loot folder
   too: `import-item` the same compendium source into the folder, or re-author the custom item with
   `add-item` (`folder`, no `actorIdentifier`) — same stats, same real icon. Plain mundane gear doesn't
   need this; anything magic or loot-worthy does.
