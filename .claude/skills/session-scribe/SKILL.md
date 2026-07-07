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
6. **Commit** — in the campaign repo: `git add sessions/<date>` → commit
   (`session: <date> — <short title>`) → push. `audio/` is gitignored (bulky, and the
   transcript is the durable artifact); tell the user audio stays local and can be deleted
   once they're happy with the transcript.

## Judgment notes

- **Recap voice:** in-world chronicle, not minutes. Lead with the arc, keep table-talk out,
  name PCs and NPCs. The TL;DR paragraph is one breath; section headings are story beats.
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
