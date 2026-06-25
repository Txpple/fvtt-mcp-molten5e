# fvtt-mcp-molten5e

A **D&D 5e–only**, **[Molten Hosting](https://moltenhosting.com)–optimized** [Model Context
Protocol](https://modelcontextprotocol.io) server for [Foundry VTT](https://foundryvtt.com),
driven by **Claude Code**. It lets an AI GM assistant read and edit a live Foundry world (actors,
items, journals, scenes, compendia, roll tables, cards…) and manage a Molten-hosted server's
static files.

---

> 📐 **Design north star — [`design.md`](design.md).** The mission, scope, the *skills decide, tools
> do* contract, and the NPC authoring doctrine all live there; it's the document every skill, tool,
> and refactor traces back to. **🚧 Still under construction** — actively evolving alongside the
> project, so expect it (and the tool surface) to change.

## Why this shape

Managed Foundry hosts (like Molten) don't expose a general control API and you can't run a process
next to the game server. The only supported way in is Foundry's own authenticated client.

So the MCP server drives a **headless Chromium** client (via [Playwright](https://playwright.dev)):
it wakes the (sleeping) Molten box with the **Magic URL**, joins the world as a dedicated Foundry user, waits for `game.ready`, and injects a page-side library that exposes the
world's own client APIs. Claude Code talks to the MCP server over stdio; the server turns each tool
call into a call inside that live page.

```
Claude Code  ──stdio──>  MCP server  (dist/index.js, on your PC)
                              │  Playwright → headless Chromium (src/foundry.ts)
                              ▼
                    Headless Foundry client
                    (wakes the box, joins the live world as a dedicated GM user)
                              │  the world's own client APIs (window.__fvtt)
                              ▼
                    Foundry VTT world (Molten-hosted)
```

The headless client connects **lazily**: `tools/list` answers without touching Foundry, and the
first actual tool call is what wakes the box and joins the world. The whole tool tree depends on one
seam — `foundry.call(name, args)` — and only `src/foundry.ts` ever imports Playwright.

### Two-plane model

- **Plane A — the live bridge.** World documents (actors, items, journals, scenes, compendia, roll
  tables, cards, ownership). Goes through the headless Foundry client while the server is awake — the
  **only** safe way to read/write live world data.
- **Plane B — Molten files.** Talks to Molten's own file endpoints directly (no bridge):
  upload/serve static assets over WebDAV and map `Data/`-relative paths to public URLs.

**Safety rule baked in:** a running world's database (LevelDB stores under `Data/worlds/<world>/data/`)
must **never** be written over the file channel — that corrupts it. Plane-B file ops are restricted
to static assets and refuse world-DB paths; bulk DB edits are an offline-only flow (stop → Create
Backup → `fvtt unpack` → edit → `fvtt pack` → start, via
[foundryvtt-cli](https://github.com/foundryvtt/foundryvtt-cli)). The Molten **management panel is
never scripted** (their ToU forbids it); only the Magic-URL wake, WebDAV, and the Foundry server are
automated.

## Scope

**In scope:** actors, items, journals, scenes (as _documents_), playlists, roll tables, cards,
compendium manipulation — especially **pulling** content out ("make an actor from the MM owlbear") —
and asset upload. Authoring prefers the **2024** dnd5e data model, sourced from **PHB / DMG / MM**; if
the requested content isn't in those packs the tool says so rather than inventing it.

**Out of scope:** non-5e game systems; maps & active-scene / placeable manipulation (walls, lights,
ambient sounds, placing/moving tokens) and live "running" of play; AI map generation; scripting the
Molten management panel.

---

## Repository layout

```
src/
  index.ts          MCP server entry (stdio) — registers the tools, dispatches to foundry.call()
  foundry.ts        THE Playwright seam: launch headless Chromium → wake → join → inject → call()
  config.ts         env/config loader (reads .env from the repo root)
  tools/            MCP tool classes — Plane A world tools + molten/ (Plane B WebDAV file tools)
  page/             page-side domain library, bundled into dist/page.bundle.js and injected
scripts/            dev/maintenance scripts (verify-*.mjs live acceptance, spike-headless)
tests/              vitest unit tests + gated live integration suites
```

## Requirements

- **Node.js 22+** (developed/tested on Node 24; see `.nvmrc`; CI runs 22 + 24). On Windows, if Node
  isn't on `PATH`, use the full path to `node.exe` (see wiring below).
- A **Chromium for Playwright** — `npx playwright install chromium` (Playwright is a devDependency;
  the headless bridge drives this browser).
- **Foundry VTT 14.x** with the **D&D 5e** system, hosted on **Molten**, plus a dedicated
  **passwordless Foundry user** for the MCP to join as.

## Build

```bash
npm install
npx playwright install chromium   # one-time: the headless browser the bridge drives
npm run build                     # tsc → dist/, then esbuild bundles the in-page library
```

`npm run build` runs `tsc && node esbuild.page.mjs`: TypeScript compiles `src/**` to `dist/`, then
esbuild bundles the page-side library (`src/page/**`) into `dist/page.bundle.js` for injection.
Tests: `npm test` (offline unit suite on vitest). Live integration suites are gated — see
[`vitest.integration.config.ts`](vitest.integration.config.ts) and `npm run test:integration`.

> **Dev watch:** `npm run dev` rebuilds the page bundle once, then runs `tsc --watch` for `src/**`.
> Because the page library is a **separate** esbuild artifact, editing anything under `src/page/**`
> while developing needs `npm run dev:page` (esbuild `--watch`) alongside it — otherwise the running
> server keeps injecting the stale `dist/page.bundle.js`.

## Wire into Claude Code

Register the built MCP server in your Claude Code config. Copy
[`.mcp.json.example`](.mcp.json.example) to a `.mcp.json` Claude Code reads (project-scoped, or your
`~/.claude.json` `mcpServers`) and set **absolute** paths:

```json
{
  "mcpServers": {
    "foundry-molten5e": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/path/to/fvtt-mcp-molten5e/dist/index.js"]
    }
  }
}
```

- Use an **absolute** path to the root `dist/index.js` (Claude Code may launch the server from any
  directory).
- On Windows, point `command` at the full `node.exe` path if Node isn't on `PATH`.
- The server loads its `.env` from the repo root regardless of working directory.
- The headless client connects lazily — the first tool call wakes the Molten box and joins the
  world, so the initial call after a cold box can take a while.

## Configuration

Copy [`.env.example`](.env.example) to `.env` (gitignored) and fill in your instance:

- **Non-secret, per-instance:** `MOLTEN_SERVER_URL`, `MOLTEN_WORLD_ID`, `MOLTEN_WEBDAV_URL`,
  `MOLTEN_FILEBROWSER_URL`, `FOUNDRY_USER` (the dedicated passwordless user to join as; defaults to
  `MCP-Claude`). The committed defaults are neutral `your-server`/`your-world` placeholders.
- **Wake (optional but recommended):** `MOLTEN_MAGIC_URL` — Molten's "Server Startup / Magic URL"
  (`…?s=token`), GET to wake a sleeping box before joining.
- **Secrets (never commit — env only):** `MOLTEN_WEBDAV_PASSWORD` (upload-asset / asset file ops),
  `MOLTEN_ADMIN_KEY`. Read them from your Molten panel → Server Details. Each tool reports which
  variable to set if its secret is missing.

## Tools

**76 tools total: 67 over the headless bridge (Plane A) + 9 Molten WebDAV file tools (Plane B).**

Plane A (bridge) covers world introspection and editing — actors, items, compendium search,
journals & quests, scenes, roll tables, cards, ownership, folders/organization, 5e-specific helpers
(NPC creation, feature/spell granting, structured inventory/loot authoring), **plus the
asset-composition + reference-integrity tools**. Plane B (Molten WebDAV) is the asset file library.

**Plane B — Molten file tools (WebDAV):**

| Tool                  | What it does                                                                     |
| --------------------- | -------------------------------------------------------------------------------- |
| `list-assets`         | List a directory under `Data/` (folders + files, with size/type/public URL)      |
| `asset-info`          | Existence + size/type/mtime/public URL for one path under `Data/`                |
| `download-asset`      | Download a file from under `Data/` to a local path                               |
| `upload-asset`        | Upload a local file under `Data/` (auto-creates parents; refuses world-DB paths) |
| `create-asset-folder` | Create a folder (and missing parents) under `Data/` (idempotent)                 |
| `delete-asset`        | Delete a file (reference-aware; refuses if still used unless `force`)            |
| `move-asset`          | Move/rename a file (refuses or relinks references; `relink`/`force`)             |
| `copy-asset`          | Copy a file under `Data/`                                                        |
| `asset-url`           | Map a `Data/`-relative path to its public HTTPS URL (pure, no network)           |

**Plane A — asset composition + reference integrity (bridge):**

| Tool                    | What it does                                                                 |
| ----------------------- | ---------------------------------------------------------------------------- |
| `find-asset-references` | Find every scene/actor/journal/playlist/… that references an asset path      |
| `relink-asset`          | Rewrite all references from one asset path to another (`dryRun` supported)   |
| `create-playlist`       | Create a Playlist from sound paths (the flagship "upload → playlist" wiring) |
| `create-scene`          | Create a Scene from a background image path                                  |
| `update-scene`          | Update a scene's fields, including swapping its background image             |
| `set-actor-art`         | Set an actor's portrait (+ prototype token) from an image path               |
| `add-journal-image`     | Append an image page to a journal entry                                      |

The remaining Plane A tools cover world CRUD (`create-actor-from-compendium`/`author-npc`, `add-feature` (features / compendium
features / spells), `import-item` (copy a real PHB/DMG item — art + stats — onto an actor or the
sidebar), `add-item` (author structured weapons/armor/consumables/loot/containers), `create-item`,
`create-journal`/`create-quest-journal`, `create-rolltable`, `create-cards`, …), listing/search
(`list-actors`, `search-compendium`, `list-journals`, …), and organization (`create-folder`,
`move-documents`, `bulk-delete`). See the `handlers` map in [`src/registry.ts`](src/registry.ts) for the full dispatch table.

> Plane B file ops run over WebDAV (need `MOLTEN_WEBDAV_PASSWORD`, work whenever the VM is awake).
> Plane A tools run over the headless bridge (need the world joined). Write tools refuse live
> world-DB paths; destructive file ops consult `find-asset-references` first.

## Security

- **Outbound-only, nothing public.** The server and the headless browser run on your machine and make
  only outbound connections (to Foundry on Molten, and to Anthropic); nothing listens for inbound
  traffic, and the headless client authenticates to Foundry exactly as a normal user would.
- **Secrets stay in `.env`** (gitignored), with tight file perms — never commit `MOLTEN_WEBDAV_PASSWORD`,
  `MOLTEN_ADMIN_KEY`, or your Claude token. Errors name the missing variable, never its value.
- **Treat all agent inputs as untrusted** (chat, transcripts, web) — prompt-injection can ride in.
  Plane-A writes are inherently safe because they go through Foundry's own client APIs; Plane-B
  destructive file ops are reference-aware, refuse live world-DB paths (canonicalized, `..`-rejecting),
  and deletes resolve strictly (exact id/name, no fuzzy match).
- **Anything under `Data/` is served publicly over HTTPS with no auth** — don't upload anything
  sensitive.

## Contributing

The project is one package: a Node-side MCP server (`src/`) that drives a headless Foundry page
through the `foundry.call(name, args)` seam, plus a page-side library (`src/page/**`, bundled into
`dist/page.bundle.js` and injected as `window.__fvtt`). Adding a tool touches both halves:

1. **MCP tool class** (`src/tools/<category>.ts`) — add to `getToolDefinitions()` (JSON-Schema
   `inputSchema`) + a `handleX(args)` that `zod.parse`es and calls `foundry.call('<op>', data)`.
2. **Dispatch** (`src/index.ts`) — instantiate the class, spread its definitions into `allTools`, and
   add a `case` in `dispatch()`. (`src/tools/registry.test.ts` guards that every advertised tool has a
   dispatch case.)
3. **Page-side op** (`src/page/<domain>.ts`) — implement `<op>(args)` and register it in
   `src/page/index.ts`. This runs **inside** the live Foundry page (the actual `Document.create` /
   `update` / `delete`): import only browser + Foundry globals here, never Node/Playwright.
4. **Build + verify** — `npm run build`, then `npm test`, then biome (`npm run check`). For live
   changes, `npm run test:integration` against a real world.

---

## Support

Issues: [GitHub Issues](https://github.com/Txpple/fvtt-mcp-molten5e/issues)

## Acknowledgments

Used as a reference:
[adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp) by Adam Dooley.  

## License

MIT License — see [LICENSE](LICENSE) for details.
