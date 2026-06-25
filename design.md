# design.md — the north star

> The single source of truth for **what this project is for** and **how it is allowed to grow**.
> Every skill, tool, and refactor must trace back to something on this page. When a decision is
> ambiguous, this document wins; if this document is wrong or silent, fix *this document first*,
> then build. We always design for the long-term architecture — never a quick fix.

---

## 1. Mission

**`fvtt-mcp-molten5e` is a Dungeon Master's assistant for Foundry VTT (D&D 5e, 2024 rules).**
It helps a DM **create and run** adventures and campaigns, driven through Claude.

There are two halves to that mission, in priority order:

1. **Content creation** — *the current focus.* Build the stuff of an adventure: scenes, actors
   (NPCs and PCs), tables, cards, playlists. Make it table-ready, edition-correct, and art-bearing.
2. **DM session assistance** — *later.* Monitor a live chat session, interject when useful, and
   afterward turn the session's chat + audio into logs and adventure summaries.

We are building **half 1** now. Every choice we make in half 1 must leave the door open for half 2,
but we do not build half 2 yet.

---

## 2. Guiding principles (binding)

These are not aspirations; they are the rules we hold each other to.

1. **Skills decide, tools do.**
   - **Tools** (the MCP server, `src/**`) have **deterministic outcomes**. A tool owns *correctness* —
     field paths, schema shapes, name→id resolution, validation, idempotency. Given the same input it
     does the same thing. A tool never guesses what the DM "probably meant."
   - **Skills** (`.claude/skills/**`) have **discretion**. A skill owns *judgment and composition* —
     reading intent, parsing a stat block, choosing which compendium to copy from, applying house
     rules, sequencing tool calls. A skill is where D&D wisdom lives.
   - When something goes wrong, first ask **"is this a correctness bug (fix the tool) or a judgment
     gap (fix the skill)?"** Put the fix on the right side of the line. Never paper over a tool
     correctness bug inside a skill, and never hard-code a judgment call into a tool.

2. **Long-term architecture over quick fixes.** We optimize for the shape we'll want in a year, not
   the patch that closes today's ticket. Best practice is the default, not the upsell. If the clean
   path costs more now, we pay it now.

3. **Compendium-first — the books are the library; never the SRD.** Our **entire** authoring library
   is the **premium 2024 published books**: the **Monster Manual**, **Player's Handbook**, and
   **Dungeon Master's Guide** (the `dnd-monster-manual.*`, `dnd-players-handbook.*`,
   `dnd-dungeon-masters-guide.*` packs), assumed always installed.
   **The SRD packs — both the 2024 SRD (`dnd5e.*24`, e.g. `dnd5e.spells24`, `dnd5e.monsterfeatures24`,
   `dnd5e.classes24`) and the older `dnd5e.*` SRD — are NEVER a source. The MM/PHB/DMG supersede them
   in ALL cases.** (The books are supersets of the SRD, so this loses nothing.) **This premium-book set is
   extensible:** today it is the MM/PHB/DMG, but a future premium book release can be *brought into
   scope* by adding it to the **one** definition that names the library — the set lives in a single
   place, never as scattered hard-coded pack ids. **Extensibility applies to premium books ONLY — the
   SRD packs are never brought into scope, no matter what ships.** We build new content by
   **copying and recombining existing book entries** (correct stats *and* art) — mixing and matching is
   the *normal* way we create. We do **not** create net-new items by default. Going ad hoc — authoring
   from scratch, **or editing an original entry in place** — is a **last resort**, permitted only when
   **either** (a) we asked and the user granted permission, **or** (b) the user explicitly asked for
   something custom; even then, prefer **copy → modify → rename** (leave the original intact). If
   something genuinely isn't in the books, **STOP and ASK (§2.4) — never fall back to the SRD.** Default
   `sourceRules: "2024"` everywhere.

4. **Ask, don't invent.** If we can't find it in the **MM/PHB/DMG books**, we **stop and ask the
   user** — we do **not** silently fall back to the SRD or to 2014, and we do not fabricate values.

5. **NPCs and PCs are different products.** They are authored by **separate skill + tool
   architectures** because they are genuinely different problems (see §6 and §7). We never force one
   to masquerade as the other.

---

## 3. The skills ↔ tools contract

This is the architectural backbone that makes principle #1 real.

```
   DM (via Claude)
        │  natural-language intent
        ▼
   ┌─────────────┐   judgment, parsing, house rules, composition
   │   SKILLS    │   .claude/skills/**   (ship in-repo, tracked)
   └─────────────┘
        │  precise, deterministic calls
        ▼
   ┌─────────────┐   correctness: schemas, field paths, validation, name→id
   │    TOOLS    │   src/tools/**  →  src/page/**  (headless Foundry bridge)
   └─────────────┘
        │  foundry.call() over a real browser session
        ▼
     Foundry VTT  (Playwright-driven headless Chromium)
```

- **A tool is a contract.** Its input schema is generated from one zod definition; its output is
  predictable; its behavior is unit-tested. If a skill cannot express something the DM needs, the
  answer is usually a *new or extended tool*, not a skill workaround.
- **A skill is a playbook.** It encodes "how a good DM would do this," not "which property to set." If
  a skill keeps re-deriving the same correctness detail, that detail belongs *down* in a tool.
- **The boundary is the test.** Before adding code, decide which side it's on. Mixed-concern code is
  the thing this contract exists to prevent.

---

## 4. Scope & roadmap

| Area | Sub-area | Phase | Status |
| --- | --- | --- | --- |
| **Content creation** | Scenes | 1 (now) | ✅ working |
| | Actors → **NPCs** | 1 (now) | ✅ aligned (§6 ladder structural; `stat-block-builder`) |
| | Actors → PCs | 1 (later) | 🧭 designed-for, not built |
| | Journals (handouts, lore, quests, notes) | 1 | ✅ done (`journal-builder`; prose de-leaked) |
| | Tables (roll tables) | 1 | ✅ done (`table-builder`; v14 results + `@UUID` loot + import) |
| | Playable cards | 1 | ✅ done (`cards-builder`; face text + preset import) |
| | Playlists | 1 | ✅ done (`playlist-builder`; scene-builder delegates) |
| **DM session assistance** | Chat messages & integration | 2 | ◻️ partial (chat tools exist) |
| | Export chats | 2 | ◻️ partial (`export-chat-log`) |
| | Audio → text (Craig AI + Whisper) | 2 | ⛔ not started |
| | Session + audio → summaries / logs | 2 | ⛔ not started |

Legend: ✅ done · 🔨 active · 🧭 future, architecture must not preclude · ◻️ pieces exist, not the
focus · ⛔ not started.

**We do not start a Phase-2 capability until Phase-1 content creation is where we want it.** The one
exception is that Phase-1 work must not architecturally block Phase-2 (e.g. keep chat/transcript
plumbing clean).

---

## 5. Content creation — the current phase

The DM's adventure is assembled from these building blocks. Each gets its own skill(s) for judgment
and its own deterministic tools for correctness.

- **Scenes** *(working)* — turn a map image into a ready-to-play scene: auto-size to the image, set
  mood/lighting/weather/fog, attach playlists and journals.
- **Actors** *(active)* — the creatures and characters. Split hard into **NPCs** (§6, current) and
  **PCs** (§7, later). This split is the most important structural decision in the content phase.
- **Journals** — the written layer of an adventure: handouts, lore/gazetteer entries, read-aloud
  (boxed) text, quest logs, and the GM's own notes. Includes quest journals and linking quests to the
  NPCs that give them. This is also the **landing zone for Phase-2 session summaries & logs** (§8) — we
  build the journal capability now, and later session output writes into it.
- **Tables** — roll tables for loot, encounters, rumors, wild magic, etc.
- **Playable cards** — Foundry card decks/hands/piles for in-play use.
- **Playlists** — audio ambiences and tracks, attachable to scenes.

Supporting plumbing that serves the above (organization/folders, ownership, asset management) exists to
make the building blocks usable; it is not itself a headline scope item.

---

## 6. NPC authoring doctrine *(current focus — follow this exactly)*

NPCs are **`type: npc`** actors. The skill's job is to produce a complete, table-ready creature using
the **premium 2024 MM/PHB/DMG books** as its library — **never the SRD** (§2.3). There is a strict
decision ladder.

### Step 1 — Prefer a prefabricated Monster Manual actor

**Always first try to pull a ready-made MM actor.** The entire 2024 Monster Manual is available as
prefab actors. Search it before building anything. Creature types to draw from:

> Aberration · Beast · Celestial · Construct · Dragon · Elemental · Fey · Fiend · Giant · Humanoid ·
> Monstrosity · Ooze · Plant · Summon · Swarm · Undead

If a suitable MM actor exists, copy it. Done.

### Step 2 — Build a custom NPC (only if no suitable prefab, or the user wants custom)

When we must build custom, we **mix and match compendium parts** — we never invent item components on
the fly. Net-new authoring, or editing an original compendium entry, is the last-resort path from
§2.3: it requires the user's permission (we ask first) or an explicit request for something custom.

1. **Art first.** Find the best-matching MM creature and use **its graphic** for the custom NPC.
2. **Stat-block base (optional).** Optionally copy a close-matching MM creature as a **base template**
   for the stat block, then modify it — or build the stat block as needed. Tools exist for both.
3. **Abilities — copy, don't fabricate.** Every action, attack, trait, feat, spell, and piece of gear
   is **copied out of a compendium**, by category:

   | Need | Pull from | Categories |
   | --- | --- | --- |
   | Actions, attacks, legendary actions, traits | **Monster Manual** | monster features |
   | Feats, spells | **Player's Handbook** | feats · spells |
   | Mundane gear | **Player's Handbook** | adventuring gear · armor · tools · weapons |
   | Magic & special gear | **Dungeon Master's Guide** | Armor · Blessings · Charms · Consumables · Containers · Equipment · Instruments · Supplemental · Treasure · Weapons |

   *"Pull from" means the **premium book packs** — `dnd-monster-manual.*`, `dnd-players-handbook.*`,
   `dnd-dungeon-masters-guide.*` — **never** the `dnd5e.*24` or older `dnd5e.*` SRD packs.*

   For a **custom ability** with no exact match: copy the closest compendium entry, modify it, and
   rename it — never hand-build from nothing. If nothing reasonable exists, **stop and ask.**

### NPCs with a PC race/species attached

Some NPCs are members of a playable race (a dragonborn captain, an elf archmage). Give them their
**racial abilities** the same way — copy the traits out of the species/origins compendium — then
**patch the scaling by hand**, exactly as we do for copied class features:

- Copy the racial trait (e.g. a dragonborn's **Breath Weapon**) from the origins/species compendium.
- Because an NPC has no species **advancement**, any `@scale.*` damage/uses dangle to 0. Read the
  feature back and set an explicit die/value (sized to the NPC's level or CR), the same `@scale` fix
  used for class features below.
- This is the accepted **NPC-side workaround**. A true PC (§7) resolves the same `@scale.*` natively
  through advancement — which is precisely why the two are separate products.

### NPC authoring — known hard facts

These are correctness truths the tools must honor (carried from prior dogfooding):

- Copied 2024 class/racial features carry `@scale.*` values fed by PC **advancement**; dropped on an
  NPC they dangle to 0 and need an explicit die set. (This is a major reason NPCs and PCs are
  separate — PCs resolve `@scale` natively; NPCs must be patched.)
- Authored NPC skills must carry a per-skill `ability` or the modifier collapses to proficiency-only.
- A magic item needs both the `mgc` property and a numeric magical bonus in the right field; copied
  armor does not auto-wire AC. Attunement is a string plus a separate `attuned` flag.

---

## 7. PC authoring *(future — designed-for, not yet built)*

PCs are a **different product** and get their **own skill + tool architecture**. We are not building
this now, but nothing we do for NPCs may make it harder.

- PCs are **`type: character`**, not `npc`. They are assembled from embedded **class, subclass,
  species, and background** items, plus **advancement**.
- **Advancement is the architectural crux.** With proper advancement attached, 2024 class/racial
  features resolve `@scale.*` damage/uses **natively** — no manual die-patching like NPCs need. A real
  PC builder must attach advancement, not just copy feature items.
- Practical consequence: a PC builder is a *leveling pipeline* (choose class → apply advancement →
  pick options at each level), not a flat stat-block transcription. Keep this in mind so the NPC tools
  and the actor-authoring surface don't bake in npc-only assumptions.

---

## 8. DM session assistance *(future phase)*

When Phase 1 is where we want it, this is next. Captured here so we plumb toward it, not into a
corner.

- **Chat integration** — read and post to the Foundry chat log; monitor a live session and interject
  with narration, NPC dialogue, GM whispers, roll requests, item/attack cards.
- **Export** — capture the session transcript (`export-chat-log` is the seed of this).
- **Audio capture & transcription** — ingest **Craig** (Discord) recordings and run **Whisper**
  speech-to-text to get a spoken transcript alongside the chat transcript.
- **Summaries & logs** — fuse the chat transcript and the Craig/Whisper audio transcript into session
  recaps and ongoing campaign logs, **authored as journals** (the §5 building block): Phase 1 builds
  the journal capability, Phase 2 writes session output into it.

---

## 9. Implementation snapshot (where the architecture stands)

This is *how* the contract in §3 is realized today. (Mechanism, not mission — update as it evolves.)

- **Headless bridge.** Playwright drives a real headless-Chromium Foundry session. `src/foundry.ts` is
  the `foundry.call()` seam; `src/index.ts` is the stdio MCP entry; page-side logic lives in
  `src/page/**` and is bundled into the browser context.
- **One registry.** `src/registry.ts` is the single source of truth wiring tool name → handler; the
  advertised tool list is derived from it so the two can't drift.
- **Generated schemas.** Every tool's input schema is generated from one hoisted zod (`io: 'input'`)
  via `src/utils/schema.ts` — never hand-written JSON schema.
- **Skills ship in-repo.** `.claude/skills/**` is a tracked deliverable, committed alongside the
  tools. Current skills: `start-session`, `scene-builder`, `stat-block-builder`,
  `physical-item-builder`, `chat-and-narration`.
- **Target stack.** Foundry v14, dnd5e 5.3.3, Molten Hosting. D&D-5e-only by design.
- **Quality gate.** biome · `tsc --noEmit` · vitest · build · knip, all green before any commit. No
  pre-commit hook — run `biome check --write .` manually.

---

## 10. How we use this document

- **Before building**, locate the work on this page. If it isn't here, decide whether it's in scope —
  and if so, add it here first.
- **When a skill and a tool seem to overlap**, re-read §2.1 and §3 and put each concern on the correct
  side.
- **When tempted by a shortcut**, re-read §2.2.
- **When this document and the code disagree**, that's a bug in one of them — surface it, don't
  silently diverge.
