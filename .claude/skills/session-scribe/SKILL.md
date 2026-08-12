---
name: session-scribe
description: >-
  Turn a Craig (Discord) session recording into a speaker-labeled transcript aligned with the
  Foundry chat log, then write the session artifacts: recap.md, gm-notes.md, and an email-ready
  player-safe recap.html — committed to the campaign repo under sessions/YYYY-MM-DD/. Use when the
  user pastes a Craig download link (craig.chat/rec/... or craig.horse), or wants to "process the
  session", "process last night's recording", "transcribe the session", "write the session recap",
  "make the session log", or "run session scribe". The bundled script owns the deterministic work
  (Craig API download, per-track faster-whisper transcription, wall-clock alignment with the chat
  log); this skill owns the judgment: the recap voice, what is player-safe vs GM-only, loot/level
  bookkeeping, and the loose-thread list. The user's ONLY jobs are /join, /stop, and pasting the
  link — never ask them for more ceremony than that.
---

# Session scribe

Craig records the table (one audio track per speaker); Foundry's chat log records the mechanics
(every roll, whisper, and card, each with an epoch-ms timestamp). Craig's recording metadata
carries its own `startTime` — so the two timelines align by pure wall-clock arithmetic. No sync
ritual, no markers, no Discord integration. The user pastes one link; everything else is yours.

**The user's contract (locked 2026-07-06, notes-repo memory `session-recording-pipeline`):**
`/join` Craig at session start → play → `/stop` → paste Claude the link. That is ALL. Do not ask
them to mark, note, export, or download anything. If they said "mark that" aloud during play, it
is IN the transcript — grep for it.

## Machine prerequisites (once per machine)

Run `scripts/setup.ps1` (idempotent — installs ffmpeg + uv via winget, builds the
`~\.session-scribe\venv` with faster-whisper + CUDA wheels, smoke-tests the GPU stack):

```powershell
powershell -ExecutionPolicy Bypass -File .claude\skills\session-scribe\scripts\setup.ps1 -PrefetchModel
```

`SMOKE TEST OK` = CUDA works. `OK (CPU ONLY)` = transcription still works, just slower — on a
new GPU generation this usually means ctranslate2 needs a version bump for the new compute
capability (`uv pip install --python ~\.session-scribe\venv\Scripts\python.exe -U ctranslate2`),
then re-run the smoke test. Machines verified: RTX 4070 laptop ✅ (2026-07-06).

## The pipeline (per session)

Let `PY = %USERPROFILE%\.session-scribe\venv\Scripts\python.exe`,
`SCRIBE = .claude\skills\session-scribe\scripts\session_scribe.py`, and
`SDIR = <campaign-repo>\sessions\YYYY-MM-DD` (the session's real date; campaign repo per the
campaign-repos memory — active: `fvtt-campaign-greenrest`). **Pull the campaign repo first**
(two-machines rule).

1. **Fetch** — `& $PY $SCRIBE fetch "<craig-link>" --session-dir $SDIR`
   Downloads the multitrack FLAC zip via Craig's API (cook → poll → `/dl/`), extracts to
   `audio/tracks/`, writes sanitized `craig-info.json` (startTime, duration, per-track speaker
   names, any Craig `/note` markers — the download key is never persisted). Craig links expire
   after 7 days — if fetch 404/410s, tell the user immediately.
2. **Transcribe** — `& $PY $SCRIBE transcribe --session-dir $SDIR`
   Per-track faster-whisper (default `large-v3-turbo`, VAD on). Long: minutes on a big GPU,
   ~real-time÷8 on CPU — run it in the background and keep working.
3. **Export the chat log** — call the `export-chat-log` MCP tool:
   `format: "json"`, `localPath: <SDIR>\chatlog.json`, and `sinceTimestamp` = Craig's
   `startTime` (from craig-info.json) minus ~10 min, to keep the export lean.
4. **Align** — `& $PY $SCRIBE align --session-dir $SDIR`
   Interleaves speech paragraphs with 🎲 rolls / 💬 chat / 🤫 whispers into `transcript.md`,
   sliced to the recording window. **First run on a new Craig+Foundry pairing:** verify skew —
   find a moment where the DM says a roll aloud ("make a dex save") and compare its speech
   timestamp to the roll's; if they differ by more than ~5s, re-run with `--skew-seconds` and
   record the value in the pipeline memory.
5. **Write the artifacts** (your judgment — read transcript.md fully first):
   - `recap.md` — the canonical session record: what happened, in order, with names. GM voice,
     complete, spoiler-tolerant.
   - `gm-notes.md` — loose threads, unresolved hooks, NPC promises made, loot/XP to apply to
     the live world, rules questions to settle, quotes of the night.
   - `recap.html` — from `templates/recap.html`, filling every placeholder. **Player-safe by
     construction**: written ONLY from what the players saw at the table; nothing that appears
     solely in gm-notes.md or GM whispers may appear here. The user pastes this into an email —
     it must render in Gmail/Outlook (keep the inline-style table structure intact).
     **House style (owner-locked 2026-07-08, session 1):** see "recap.html house style" below.
6. **Snapshot the party (owner directive 2026-08-06)** — write
   `<campaign-repo>\party-snapshots\YYYY-MM-DD.md` (session date) from the LIVE sheets
   (`get-actor` on each party PC — the party roster only, per the campaign repo's PC rules;
   never DM test PCs like Salyth). Per PC: class/subclass + LEVEL, HP max, AC, the six
   ability scores, feats/ASIs taken, weapon masteries, spell slots, attuned + equipped magic
   items, notable consumables. This is the point-in-time record that answers "what did
   <PC> have before?" after level-ups, deaths, or loot disputes — one file per session
   date, diffable against the last.
7. **Commit** — in the campaign repo: `git add sessions/<date> party-snapshots` → commit
   (`session: <date> — <short title>`) → push. `audio/` is gitignored (bulky, and the
   transcript is the durable artifact); tell the user audio stays local and can be deleted
   once they're happy with the transcript.

## Judgment notes

- **Recap voice:** in-world chronicle, not minutes. Lead with the arc, keep table-talk out,
  name PCs and NPCs. The TL;DR paragraph is one breath; section headings are story beats.
- **recap.html house style (owner-locked 2026-07-08, iterated live on session 1):**
  - **Dice as narrative, never numerals.** Weave the blow-by-blow of checks, crits, failed
    saves, and big hits into the prose at FULL detail — but the WORDS carry the magnitude, not
    the numbers. Crit → "his blade found the perfect seam"; nat-20 lore check → "his temple
    schooling surfaced with perfect, word-for-word clarity"; failed save → "neither had the
    will to shake it"; near-death → "beaten to the ragged edge of standing." NO raw numerals
    in the prose (owner tried a numbers version — "27 to hit, 15 radiant" — and rejected it as
    hard to read; the narrative-weave rewrite is the approved form).
  - **Name the mechanics (owner feedback 2026-08-12, session 3).** When a PC or monster
    invokes a spell, feature, feat, maneuver, or mastery, CALL IT BY ITS GAME NAME — Magic
    Missile, Vow of Enmity, Relentless Endurance, Thunderous Smite, Action Surge, Hunter's
    Mark, Displacement — wrapped in a bit of flavor but direct about what was used. Do NOT
    narrate around the ability ("magic that cannot miss", "his oath's enmity", "his orcish
    blood refused the fall"): the session-3 first draft did exactly that and the owner sent it
    back. Approved shape: "Gren answered with Magic Missile — darts that do not argue with
    Displacement" / "his Relentless Endurance refused the fall." Numerals stay out; names go in.
  - **Never surface the DM's narration prompts (owner feedback 2026-08-12).** When the DM asks
    a player to narrate ("how would you like to kill him?"), the OUTPUT of that exchange is
    the fiction — render it as straight narration/quote and never mention the asking. Rejected
    form: "— Thomas, asked how he'd like to finish the alpha." The ask is table process, same
    category as UI talk.
  - **Dreams get bullets and specificity (owner feedback 2026-08-12).** The dream sequences are
    the campaign's central reveal engine — never compress them into a summary paragraph. Give
    the dream section a short framing paragraph, then ONE BULLET PER DREAMER carrying the
    specific content: the imagery, the named people (Lae'zel, the sister, the wife and
    children, the village elders), the emotional turn, and any anomalies (Jetten's moonstone
    necklace glowing, dreaming in trance). Same treatment in the Session Diary page. When a
    night is DREAMLESS, that absence is itself a called-out beat.
  - **Fun endmatter, in-character only.** After Spoils & Progress, add two sections:
    **Quotable Quotes** (the night's best verbatim table lines with dry one-line attributions
    — in-character/in-world only) and **Deeds of the Day** (in-world superlative awards, one
    per PC or so, e.g. "Arrow of the Day", "Finest Masonry in Faerûn"). NO meta, NO player
    names, NO technical-issues talk anywhere in recap.html — UI/audio/browser troubles belong
    in gm-notes.md only.
  - **Register: toned DOWN a notch (owner feedback 2026-07-15, session 2).** Narrative, not
    purple: plain direct sentences, one flourish per paragraph is plenty. The first session-2
    draft was rejected as "a bit too flowery" — cut phrases like "on the lair's own dark
    heartbeat" / "truer than true"; keep the beats and the humor, lose the ornament.
  - **Combat register: PUNCHY (owner feedback 2026-08-12, session 3).** Fight scenes are
    exciting, with strong beats — short sentences, hard verbs, one beat per sentence, momentum
    over ornament. "Thunder cracked across the ruin. The beast flew backward through Morgash's
    reach — his opportunity strike killed it in the air." Long braided clauses and lyrical
    similes are for the quiet scenes; in combat they read as flowery. Pair this with the
    name-the-mechanics rule: named ability + hard verb + consequence is the unit of combat
    prose.
  - **Combat beats must be factually precise and credit smart play.** Who killed what is not
    style-flexible (session-2 corrections: Gren's magic missiles killed the Broodmother, NOT
    the wisp — the wisp escaped; Morgash earned explicit credit for reading the ettercap's
    glances and dashing to block the door BEFORE the Broodmother burst through). When a
    sentence about attacking X sits next to a kill of Y, make the target of each unmistakable.
  - **Quote found-item text verbatim when it matters.** For a plot-loaded item, include the
    full in-world item description — e.g. the Greenrest Tonic's vial description plus its
    label line ("One swallow, seventh-day, as ever. — Selma.") — then note who read it aloud,
    before any paraphrase.
  - recap.md (the canonical GM record) is exempt: exact rolls/damage numbers are welcome there.
  - Reference implementations: campaign repo `sessions/2026-07-14/recap.html` (the approved
    register, after the tone-down) and `sessions/2026-07-07/recap.html` (structure/endmatter;
    its prose runs a notch more florid than the approved register).
- **The Foundry session journal is a standard artifact (established session 2):** after
  recap.html, append ONE player-visible text page to the world's single **`Session Diary`**
  journal (folder *Adventure Log*) — **never a new journal per session** (revised 2026-08-08:
  the per-session journals were consolidated). Page name = `Session N — <title>`, e.g.
  "Session 3 — The Road Interlude"; the date lives in the page body. Use `update-journal` with
  `newPageName` + `playerVisible: true`, then keep the pages in order (they sort by name, so the
  `Session N` prefix does the work). Content is the `mcp-journal` format (p.lead TL;DR →
  h2.spaced story beats → readaloud blocks for item/lore quotes → "Where Things Stand" ul), the
  same player-safe boundary and the SAME toned-down register as recap.html — it's the in-game
  handout twin of the email recap, minus Quotable Quotes / Deeds of the Day. Match the existing
  Session 1/2 pages.
- **Monsters the party fought go in the Bestiary** — after the recap, hand off to the
  `bestiary-builder` skill for anything newly killed; it files a page (MM art + narrative) in the
  single `Bestiary` journal.
- **Attribution is per-speaker-track and trustworthy** — quote players verbatim when it's good
  ("quotes of the night" in gm-notes). Whisper text is GM-only by definition: usable in
  recap.md/gm-notes.md, NEVER in recap.html.
- **Bookkeeping handoff:** loot awarded and levels gained belong in gm-notes.md as a checklist;
  offer to apply them to the live world (physical-item-builder / level-up-pc) as a follow-up.
- **Craig facts:** recordings expire in 7 days; `/recordings` in Discord re-fetches a lost
  link; `craig-info.json.craigNotes` carries any `/note` markers; the API is mapped in the
  script header. If the API shape ever drifts (Craig is open source: CraigChat/craig), the
  manual fallback is: user downloads the flac zip from the Craig page themselves → unzip into
  `SDIR\audio\tracks\` → continue from step 2.
