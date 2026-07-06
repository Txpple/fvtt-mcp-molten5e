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

8. **No blank art — the tools now AUTO-FILL a real icon; still prefer a thematic one.** Authoring from
   scratch used to leave a generic placeholder (`systems/dnd5e/icons/svg/...`). The tools now make that
   impossible: `add-item` fills a real icon (a live same-kind compendium match by name/baseItem, else a
   verified core floor), `add-feature` fills a real feature/attack/spell icon **and accepts an `img`**,
   and `author-npc` fills a real creatureType portrait + token. So a blank is off the table — but for a
   *specific* look, still pass `img` (to `add-item` / `add-feature`) or set it afterward from the
   compendium feature/item you are emulating (`search-compendium-*` → copy its `img` via `update-item` /
   `update-actor-item` / `set-actor-art`). Copied documents (`import-item` / `create-actor-from-compendium`)
   already carry real art. Confirm with `content-audit` before you finish.

9. **A magic item you put on an NPC must ALSO exist as a world Item, for loot — now AUTOMATIC.** When you
   `import-item` / `add-item` a magic item onto an actor, the tool mints a matching loose **world Item**
   (same stats + real icon) in a loot folder by default — control it with `lootCopyFolder` (default
   `"Loot"`) and `lootCopy` (`false` to suppress, `true` to force a mundane copy). **Don't hand-create
   the twin too — that double-mints it.** Plain mundane gear doesn't need a twin; `content-audit` flags
   any magic NPC item that's missing one.

10. **Table-ready prototype tokens — the house token rules (EVERY actor, every session).** The tools
    bake name/bars/vision (design.md §7); these table rules are the caller's to enforce on every
    created PC/NPC until the tools grow create-time params:
    - **Disposition follows role, at creation time:** civilians / townsfolk / bystanders → **neutral**;
      actual enemies → hostile; party allies → friendly. Pass `disposition` to
      `create-actor-from-compendium` / `author-npc` when you create — never leave background folk on
      the copied-monster hostile default (fix stragglers with `update-actor` `disposition`).
    - **Auto-rotate ON, dynamic ring OFF, `randomImg` OFF** — the 2024-book prototype tokens ship all
      three the other way; the creation tools now bake the corrections into every created actor
      automatically. Flip an existing actor with `update-actor` `tokenAutoRotate` / `tokenRing`.

11. **Run `content-audit` as the finishing check.** Before declaring a build done, scan what you made
    (`actorIdentifiers` for NPCs + their gear, `itemFolders` / `worldItemIds` for loot) with the
    read-only `content-audit` tool. It flags any placeholder icon (rule 8), GM-fudge / pretend-reskin
    language (rule 7), and magic NPC item with no loot twin (rule 9). Fix each finding and re-run until
    it reports clean — these rules are enforced at the tool floor, and this is the belt-and-suspenders
    check that nothing slipped through a hand edit.

12. **Descriptions are PLAYER-FACING and un-audited — keep them in-world and innocuous; secrets go in a
    GM-only journal.** An item's `system.description` (and any player-visible page/handout) can be read
    by a player the moment they see the thing, and `content-audit` does **not** scan description prose —
    so a leak here is silent. **Never** put GM-only content in a description: no `GM:` asides, no plot
    reveals or spoilers, no meta-instructions to the DM (*"fill in the name"*, *"a ready-made hook"*), no
    naming of the twist / answer / hidden loot. Write **only what the fiction shows in-world**, and keep
    it innocuous — assume a player reads it first. Anything the GM needs (the hook, the secret, the
    intended payoff) belongs in a **GM-only journal** (see [`journal-builder`], page visibility GM-only)
    or the encounter's GM key, linked from there — not in the item. A "sealed letter" / mysterious note
    is the classic trap: keep the item's own text innocuous and put the intent in a GM note elsewhere.
    (Same spirit as rule 7's no-fudge note, but about SECRECY leaking to players, not mechanics.)

13. **Feature-granted FREE CASTS = TWO entries: a normal repertoire spell + a cast activity ON the
    granting feature — use `add-free-cast`, never a tracker feat, never a forward on the spell.**
    (Owner-revised 2026-07-05; supersedes the earlier forward-on-the-spell shape.) When a
    feat/feature lets an actor cast a spell **without a spell slot N times per rest** — Magic
    Initiate, a 2024 lineage grant, Favored Enemy, a magic item's "cast X 1/day" — the sheet gets:
    1. **The repertoire copy** — the spell as a normal **always-prepared** entry (rule 14), castable
       with slots like any other spell. No pools, no extra activities, no use-dialog on click.
    2. **The free cast** — a `cast` activity **on the granting feature item**, linking the premium
       compendium spell, with its own uses pool on the activity (default 1/long rest — the 2024
       wording). dnd5e then projects a cached entry into the sheet's **native "Additional Spells"
       spellbook section**, titled **`<Spell Name> - <granting feature>`** (e.g. *"Bless - Magic
       Initiate"*, *"Hunter's Mark - Favored Enemy"*), whose row counter tracks the pool and whose
       cast never eats a slot.
    The `add-free-cast` tool wires the whole shape in one call — pass the spell (embedded name/id or
    a premium compendium uuid to import it), `grantedBy` (the granting feature ITEM on the actor),
    `uses` (a number or a `@scale.*` formula), and the recovery period. It also MIGRATES the old
    shape off the spell (on-spell pools + `forward` activities — including the premium Hunter's
    Mark's native forward) and dedupes dnd5e's cached spellbook copies. Do **NOT** create a separate
    Features-tab feat item to track the daily use, and do **NOT** put the pool/forward on the spell
    entry (the pre-2026-07-05 shape): both were tried and rejected at this table — the one castable
    thing must read as a regular spell plus one separately-tracked Additional Spells row.

14. **Known casters' spells are ALWAYS PREPARED — cantrips and leveled spells, `prepared: 2`.**
    (Owner house rule, 2026-07-05.) For the 2024 "known"-style casters who swap spells only on
    level-up — **sorcerer, bard, ranger, warlock** — every spell on the sheet is set to *always
    prepared* (`system.prepared: 2`), cantrips included: no prepared-toggle state, no unprepared
    spells lingering in the book. Feature-granted spells (rule 13's repertoire copies, subclass
    always-prepared lists) are `prepared: 2` for everyone. Prepared casters (cleric, druid, wizard,
    paladin) keep the normal prepare/unprepare toggle for their class list.
