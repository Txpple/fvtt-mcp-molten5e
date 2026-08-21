# Local sandbox — a disposable copy of prod on this machine

The local Foundry install is a **test sandbox imaged from prod (Molten)**. It exists so tool and
module development never touches the live world until it is deliberately pushed, and so test loops
don't pay Molten's wake/latency tax.

## The contract (which way things flow)

| What | Direction | How |
| --- | --- | --- |
| **Content** — world DB (actors, items, journals, scenes…), assets, installed modules & systems | **prod → local, only** | `scripts/pull-prod-to-local.mjs` |
| **Code** — house modules | **local → prod, only** | `scripts/deploy-house-module.mjs` (+ `register-module.mjs` for a new module) |
| **MCP server** (`src/**`) | never deployed anywhere | runs on this machine; point it at whichever instance |

Content authored in the sandbox is **throwaway by definition** — the next refresh overwrites it.
If something built locally turns out to be keeper content, rebuild it against prod with the tools;
never hand-copy world DB files upward. Prod's world DB stays pure.

## Running the sandbox headless (no desktop window)

`scripts/local-foundry.mjs` runs the same server the desktop app wraps — the install's
`resources/app/main.js` under plain Node — with no Electron window (the app pays for a Chromium
instance nobody looks at; the bridge talks HTTP/WebSocket, and a human who wants eyes on the
world opens a browser tab). Same dataPath, same port, same worlds; the desktop app still works
whenever the headless server isn't running (they can't run together — the dataPath lock).

```bash
node scripts/local-foundry.mjs start      # boot server + launch the world (idempotent)
node scripts/local-foundry.mjs stop       # deactivate the world (the DB flush), end the process
node scripts/local-foundry.mjs status
node scripts/local-foundry.mjs restart
```

`start --no-world` boots to Setup only; `stop` refuses while users are connected
(`disconnect-bridge` first) and `--force` overrides. Server console output appends to
`<dataPath>/Logs/headless-console.log`; the pid rides `Logs/headless.pid`. Requires
`LOCAL_ADMIN_KEY` — world launch and world stop are admin-gated — and passes `--adminPassword`
at boot so Foundry rewrites `Config/admin.txt` itself: the installed hash can never drift from
`.env`.

The v14 admin API the launcher rides (read from the app dist 2026-08-21; details in the script
header): admin posts carry `adminPassword` in the JSON body — no `/auth` login, no session
cookie. `launchWorld` is a `/setup` action and the `/setup` action switch only exists while NO
world is active; stopping a world is the `/join` `{action: "shutdown"}` route and exists only
WHILE one is active; and there is no process-exit route at all, so `stop` deactivates the world
(that runs `db.disconnect` + `world.save`) and then ends the Setup-idle process.

## Refreshing the sandbox

```bash
node scripts/pull-prod-to-local.mjs
```

That's the whole process. The script:

1. **Wakes the Molten box** if asleep (Magic URL) — WebDAV needs the VM live.
2. **Guards both LevelDBs**: refuses while prod's world has users connected (mid-write snapshot
   would tear), and refuses while the *local* Foundry has the world active (same risk, receiving
   side). Prod idle-but-active (0 users) and local-on-setup-screen are both fine.
3. **Mirrors** `worlds/<id>` + `systems` + `modules` + `assets` into `LOCAL_FOUNDRY_DATA`:
   incremental (size+mtime — a no-change refresh downloads nothing), and **deletes local files
   that no longer exist on prod**. The delete half is load-bearing for the world: a stale
   `.ldb`/`MANIFEST` mixed into a fresh LevelDB set corrupts it.
4. Remote side is strictly **read-only** (GET/PROPFIND) — a refresh cannot harm prod.

5. **Verifies the world DB is openable** — every LevelDB collection must have exactly one
   `MANIFEST-*` and a `CURRENT` naming a manifest that exists. A half-finished mirror otherwise
   surfaces later as a Foundry error that says nothing about the copy.

Flags: `--dry-run` (show the plan, change nothing), `--force` (override both activity guards),
`--no-delete` (copy without mirroring), `--to <dataRoot>` (override `LOCAL_FOUNDRY_DATA`),
explicit targets (`node scripts/pull-prod-to-local.mjs modules/lootshelf`).

After a refresh: **restart** local Foundry if it was running (Foundry scans the package registry
at process boot — freshly pulled modules/systems won't register into a running process), then
launch the world.

### Refreshing while Foundry is running

The local Foundry must be **fully stopped**, not just returned to Setup. A running process keeps
LevelDB handles open on the very files being replaced, and can write its stale in-memory state
back over the fresh copy after the pull finishes — corrupting the thing you just refreshed. The
script's local guard catches an *active world*, but stopping the process is the actual
requirement. The sequence that works:

1. `curl -s http://localhost:30000/api/status` — is a world active, and how many users?
2. If the MCP bridge is one of them, `disconnect-bridge` first so no Playwright session is
   dangling. (`list-users` shows who is really connected — check no human is mid-session.)
3. Stop the server **gracefully**. Headless: `node scripts/local-foundry.mjs stop`. Desktop
   app: close it with `CloseMainWindow()` on the process, never `Stop-Process` — it shuts the
   world down and releases the LevelDB cleanly; a hard kill risks the local DB and the file
   locks may outlive the process.
4. Confirm the port is free, then run the refresh.
5. Relaunch Foundry and launch the world — headless, that's `node scripts/local-foundry.mjs
   start` again.

Foundry holds an exclusive **lock on the whole data directory** — any second Foundry process
against the same `dataPath` dies with "cannot start in this directory which is already locked by
another process". That is also why CLI flags like `--adminPassword` can't be applied while the
app is up. (A *killed* process leaves `Config/options.json.lock` behind; Foundry treats it as
stale after ~10s, and the launcher's `start` waits that window out automatically.)

With `LOCAL_ADMIN_KEY` set the whole stop→refresh→start loop is scriptable; raw HTTP, if you
need it without the launcher, is `POST /setup {action: "launchWorld", world: <id>, adminPassword:
<LOCAL_ADMIN_KEY>}` (the key rides the JSON body — the old `/auth` cookie dance predates v14's
gates), then poll `/api/status` until `active` is true (~25s for a heavy dnd5e world).

## What is deliberately NOT pulled

- **`Config/`** — license, admin password, `options.json` (port, dataPath) are per-machine. The
  local install keeps its own.
- **`Logs/`, `Backups/`** — prod noise / Molten's own machinery.

World **users ride the world DB**, so the same join identities (GM, MCP-Claude, players) exist in
the sandbox with the same passwords.

## Version rule

The local Foundry **app** must be the same generation as prod at ≥ its build (prod is v14; local
is v14.365). The script prints the pulled world's `coreVersion`/`systemVersion` after every
refresh. The dnd5e system itself is mirrored from prod, so it always matches the world — only the
app binary is a manual install.

## First-time machine setup

1. Install Foundry VTT (same generation as prod), sign the license, set an admin password.
2. Launch it once so `%LOCALAPPDATA%\FoundryVTT\{Config,Data}` exist, then quit.
3. In the repo `.env`, set `LOCAL_FOUNDRY_DATA=<that Data dir>` (see `.env.example`).
4. `node scripts/pull-prod-to-local.mjs` and launch the world.

## Pointing the MCP at the sandbox — instance profiles

The server binary takes a **profile** via the `FOUNDRY_PROFILE` env var (`src/config.ts`), set in
the MCP *registration*, never in `.env` — one `.env` serves every profile:

| Registration (user scope, `~/.claude.json`) | `FOUNDRY_PROFILE` | Targets |
| --- | --- | --- |
| `foundry-molten5e` | *(unset)* | prod (Molten), the `MOLTEN_*` set |
| `foundry-local5e` | `local` | the sandbox: `LOCAL_SERVER_URL` (default `http://localhost:30000`) |

The local profile **inherits** the world id and join user/password from the prod values (a
sandbox is a byte copy of prod — same world id, same users) and accepts `LOCAL_WORLD_ID` /
`LOCAL_FOUNDRY_USER` / `LOCAL_FOUNDRY_PASSWORD` overrides. Both tool namespaces coexist in one
Claude Code session; which instance a call touches is fixed by which server it goes to — there is
no runtime "switch instance" state to get wrong.

Local-profile limits (deliberate):

- **No WebDAV file plane** — the asset file tools report "not configured" rather than ever
  dialing prod from a local-profile process. Asset files reach the sandbox via the refresh pull.
- **No wake plumbing** — a local box doesn't sleep.
- **World launch needs `LOCAL_ADMIN_KEY`** — with it set, the bridge auto-launches a cold
  instance exactly like prod; without it you click Play yourself. Counter-intuitively, an
  admin-*less* Foundry v14 is *less* automatable, not more: it accepts a `launchWorld` POST but
  refuses remote shutdown/return-to-setup with 403 `InvalidAdminKey` (observed live), so there
  is no way back to Setup without the desktop UI.

  To set one on an install that has none, let Foundry hash it for you rather than writing
  `Config/admin.txt` by hand — start it once with `--adminPassword=<pw>` and it writes the file
  itself. That needs the data-dir lock, so the app must be stopped. If it is running and you
  don't want to interrupt it, generate the file from a throwaway data dir
  (`--dataPath=<tmp> --port=30099 --adminPassword=<pw>`) and copy its `Config/admin.txt` across:
  the hash is portable between installs whose `options.json` has `passwordSalt: null` (Foundry
  falls back to a build constant), and it takes effect at the next restart. Put the same
  plaintext in `LOCAL_ADMIN_KEY`. To undo: delete `Config/admin.txt`.

## Testing a sister module against the sandbox

The point of the sandbox is that house-module repos (`fvtt-mod-*`, beside this one) can be
exercised against a *current copy of the real world* without risking prod:

```bash
node scripts/deploy-house-module.mjs fvtt-mod-battleflow --local
```

`--local` writes the module's served files straight into the sandbox's `Data/modules/` (same
byte read-back proof as the prod path) and never touches Molten. The loop is: edit the module →
`--local` → reload the local world → drive assertions through the `foundry-local5e` tools or a
`scripts/verify-*.mjs` run pointed at the sandbox → only when it's green, deploy for real.

Two things to remember:

- **A refresh overwrites your module under test.** `pull-prod-to-local.mjs` mirrors prod's
  `modules/`, so re-run `--local` after every refresh (the script prints this warning).
- **A brand-new module still needs registering** — Foundry scans the package registry at process
  boot, so a module that has never been installed needs `scripts/register-module.mjs` (or a local
  process restart), not just a file drop.

## Known seams

- The Molten module and `fvtt-mod-openserver`'s sleep-watch are prod-environment plumbing that
  rides along in `modules/`; they're harmless locally (no Molten socket to talk to).
