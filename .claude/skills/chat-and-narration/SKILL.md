---
name: chat-and-narration
description: >-
  Post to the Foundry chat log with the right visibility, voice, and formatting — narration,
  in-character NPC dialogue, GM whispers, blind/secret notes, player handouts with images, table-wide
  roll requests, and rich dnd5e item/attack cards. Also save/export the chat transcript and prune old
  messages. Use when the user wants to "post to chat", "say (something) in character as <npc>",
  "narrate", "read the boxed text", "whisper the GM", "make it a blind/secret note", "ask everyone for
  a DEX save / Perception check", "show the goblin's attack", "post <npc>'s <feature>", "export/save
  the chat log", "clear the chat", or "purge old messages". Picks the tool + mode for you; the tools
  themselves hold the correctness.
---

# Chat & narration

A judgment layer over the six chat tools. The tools own correctness (visibility mapping, enrichment,
deletes, transcript building); this skill maps the user's intent to the right tool + mode + house
formatting. It adds NO new mechanics.

The tools: `send-chat-message`, `list-chat-messages`, `delete-chat-messages`, `export-chat-log`,
`post-item-card`, `request-roll`.

## Pick the visibility mode from intent

`send-chat-message` takes `visibility` (`public` / `gm` / `blind` / `self`) plus an optional
`speakerActor`. Map intent:

| The user wants… | mode | notes |
|---|---|---|
| Narration, announcements, read-aloud, handouts | `public` | the whole table |
| An NPC to *speak* | `public` + `speakerActor: "<npc>"` | "public as character" — renders as that NPC |
| A GM-only aside / secret note | `gm` | whispered to all GMs |
| A hidden check the GM resolves privately | `blind` | whispers GMs + hides content from others; mainly meaningful for rolls — for plain text it behaves like `gm` |
| A private scratch note to yourself | `self` | only the bridge user sees it |

When in doubt between `gm` and `blind` for plain text, use `gm` — `blind` only differs for dice rolls.

## House formatting

Content is HTML. Keep these shapes consistent:

- **NPC dialogue** — `speakerActor` = the NPC, default `style: ic`. Put the spoken line in `content`;
  use `flavor` for a stage direction if useful. Example:
  `send-chat-message { content: "<p>\"You shall not pass.\"</p>", visibility: "public", speakerActor: "Gandalf" }`
- **Boxed narration / read-aloud** — `public`, wrap in a consistent block, e.g.
  `<blockquote>…</blockquote>` or `<section class="read-aloud">…</section>`.
- **Player handout / image** — use the first-class `images` param; do NOT hand-write `<img>` or guess
  URLs. Each image has an `embed` mode. **If the user gives an image but does NOT make the placement
  clear, ASK which they want before posting** (don't silently pick):
    1. **Embed in the HTML** (`embed: "dataUri"`) — the image bytes are read and inlined into the message
       itself as a base64 `data:` URI. Self-contained, nothing left at a path on the server, but it
       bloats the message in the world DB — keep it for small images.
    2. **Upload to WebDAV at a location** (`embed: "webdav"`, the default) — confirm/choose a
       Data-relative folder (default `worlds/<world>/assets/chat`), upload the file there, and link its
       public URL. Permanent and reusable. ⚠️ Served PUBLICLY with no auth — nothing sensitive.
  If the user already signalled which (e.g. "just embed it" / "put it at worlds/.../maps"), skip the ask
  and do that. Example:
  `send-chat-message { content: "<p>You find a map.</p>", visibility: "public", images: [{ path: "C:/maps/treasure.webp", caption: "The treasure map", embed: "webdav" }] }`

## Rich dnd5e cards and roll requests

- **Show an NPC's attack/feature WITH working buttons** → `post-item-card { actor, item, action: "use" }`.
  This drives the dnd5e Activity system, so the Attack/Damage/Apply-Effects buttons actually work. If
  the item has no activity the tool says so — fall back to a plain `send-chat-message` description card.
- **Ask the table for a roll** → `request-roll { kind: "save"|"check"|"skill", ability/skill, dc }`.
  Posts a clickable prompt players use to roll their own check.
- **Honesty:** only dnd5e activity cards and inline rolls/`@UUID` links are interactive without an
  installed module. Never claim a hand-written custom `<button>` will do anything — it won't.

## Save / export the transcript — EXPORT TO BOTH

When the user wants to save or archive the chat, call `export-chat-log` **once with BOTH
destinations** so it lands on their machine AND in the world's public area:

```
export-chat-log {
  format: "markdown",
  localPath: "C:/Users/<you>/sessions/session-3.md",
  remotePath: "worlds/<world>/exports/session-3.md"
}
```

Then report the local path AND the returned public URL. If `MOLTEN_WEBDAV_PASSWORD` isn't set, the
WebDAV copy is skipped — fall back to local-only and say so. Formats: `markdown`/`plaintext` (readable,
HTML stripped, roll totals kept), `html` (raw markup, unstyled — not the rendered card), `json`
(lossless structured records).

## Chat hygiene

Long chat logs are a known Molten performance drag. To prune:
1. `list-chat-messages` (use `contentMode: "none"` on a big log) to preview.
2. `delete-chat-messages { beforeTimestamp: <ms epoch> }` to purge old noise, or `{ ids: [...] }` for
   specific messages (a single id is just an array of one).
3. **`clearAll` wipes everything and is irreversible** — only use it with explicit user go-ahead, and
   it requires `confirm: true`.

## Boundaries

- Don't invent interactivity. Don't guess image URLs — use the `images` param.
- Get explicit confirmation before `clearAll` or any bulk/`beforeTimestamp` delete that isn't clearly
  what the user asked for.
- This skill composes the tools; if a tool returns a refusal or reason, surface it rather than
  working around it.
