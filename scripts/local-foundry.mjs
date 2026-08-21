// Run the LOCAL Foundry sandbox as a HEADLESS server — the desktop app's server code under
// plain Node, no Electron window. The full sandbox process is documented in docs/local-sandbox.md.
//
// Why: the Electron app pays for a full Chromium instance nobody looks at — the MCP bridge talks
// HTTP/WebSocket and a human who wants eyes on the world opens a browser tab. Headless is the
// same server (the install's resources/app/main.js), the same dataPath, the same port; the
// desktop app still works any time this isn't running (the two can't run together — Foundry
// holds an exclusive lock on the dataPath).
//
//   node scripts/local-foundry.mjs start [--no-world]   # boot server, then launch the world
//   node scripts/local-foundry.mjs stop [--force]       # deactivate world, then end the process
//   node scripts/local-foundry.mjs restart [--force]
//   node scripts/local-foundry.mjs status
//
// start is idempotent: already-up just reports (and still launches the world if it's sitting at
// Setup). stop refuses while users are connected (disconnect-bridge first); --force overrides.
// Server console output appends to <dataPath>/Logs/headless-console.log.
//
// The v14 admin API contract (read from resources/app/dist, 2026-08-21 — do not "improve" this
// back to cookies):
//   - sessions.authenticateAdmin reads `adminPassword` from the REQUEST BODY on every route it
//     guards, so admin posts are stateless JSON — no /auth login, no session cookie to carry.
//   - Launching: POST /setup {action:"launchWorld", world, adminPassword}. The /setup action
//     switch only exists while NO world is active (with one running, every action 403s
//     "You lack server administrator permission" no matter who you are).
//   - Stopping a world: POST /join {action:"shutdown", adminPassword} — the join view's own
//     shutdown case, available exactly while a world IS active. It runs world.deactivate
//     (db.disconnect + world.save — the flush that matters), answering
//     {status:"success"}. On an adminless install this route 403s ERROR.InvalidAdminKey, which
//     is why LOCAL_ADMIN_KEY is required kit.
//   - There is NO process-exit route in v14; the desktop app quits via its Electron shell. So
//     `stop` deactivates the world first, then terminates the Setup-idle node process. A killed
//     process leaves Config/options.json.lock behind; Foundry treats it as stale after ~10s
//     (mtime-based), so `start` retries once when it hits the lock error.
//
// Config comes from the repo .env: LOCAL_FOUNDRY_DATA (the Data dir; its parent is the Foundry
// --dataPath), LOCAL_SERVER_URL (default http://localhost:30000), LOCAL_ADMIN_KEY (required —
// see above), world id from LOCAL_WORLD_ID || MOLTEN_WORLD_ID, and optionally LOCAL_FOUNDRY_APP
// to override the default app install path. --adminPassword is passed at boot so Foundry
// (re)writes Config/admin.txt itself and the installed hash can never drift from .env.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith('--'));
const force = args.includes('--force');
const noWorld = args.includes('--no-world');

// Failures throw (caught at the bottom) rather than process.exit(): exiting hard with live
// fetch sockets trips a libuv teardown assertion on Windows (observed on Node 24).
class Fail extends Error {}
function die(msg) {
  throw new Fail(msg);
}

const dataRoot = env.LOCAL_FOUNDRY_DATA || '';
if (!dataRoot) die('LOCAL_FOUNDRY_DATA missing from .env');
const dataPath = dirname(dataRoot); // .../FoundryVTT/Data -> .../FoundryVTT (what --dataPath wants)
const baseUrl = (env.LOCAL_SERVER_URL || 'http://localhost:30000').replace(/\/+$/, '');
const worldId = env.LOCAL_WORLD_ID || env.MOLTEN_WORLD_ID || '';
const adminKey = env.LOCAL_ADMIN_KEY || '';
const appMain =
  env.LOCAL_FOUNDRY_APP || 'C:\\Program Files\\Foundry Virtual Tabletop\\resources\\app\\main.js';
const logsDir = join(dataPath, 'Logs');
const consoleLog = join(logsDir, 'headless-console.log');
const pidFile = join(logsDir, 'headless.pid');

function readPid() {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearPid() {
  try {
    unlinkSync(pidFile);
  } catch {}
}

function logTail(lines = 25) {
  try {
    return readFileSync(consoleLog, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '(no console log)';
  }
}

async function apiStatus(timeoutMs = 3000) {
  try {
    const res = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function poll(check, deadlineMs, intervalMs = 2000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {}
  return { status: res.status, payload };
}

function requireAdminKey() {
  if (!adminKey) die('LOCAL_ADMIN_KEY missing from .env — launch/stop are admin-gated');
}

function printStatus(status) {
  if (!status) {
    console.log(`server:  down (${baseUrl})`);
    return;
  }
  console.log(`server:  up (${baseUrl}) — Foundry v${status.version ?? '?'}`);
  console.log(
    status.active
      ? `world:   ACTIVE — ${status.world ?? worldId} (${status.system ?? '?'} ${status.systemVersion ?? ''})`.trimEnd()
      : 'world:   none (Setup screen)'
  );
  if (status.users !== undefined) console.log(`users:   ${status.users} connected`);
}

async function launchWorld() {
  if (!worldId) die('no world id (LOCAL_WORLD_ID / MOLTEN_WORLD_ID missing from .env)');
  requireAdminKey();
  console.log(`launching world "${worldId}"…`);
  const { status, payload } = await postJson('/setup', {
    action: 'launchWorld',
    world: worldId,
    adminPassword: adminKey,
  });
  if (status === 403 || payload?.error)
    die(`launchWorld refused: HTTP ${status} ${JSON.stringify(payload)}`);
  const active = await poll(
    async () => {
      const s = await apiStatus();
      return s?.active ? s : null;
    },
    150_000,
    3000
  );
  if (!active) die(`world did not become active within 150s — tail of server log:\n${logTail()}`);
  return active;
}

function spawnServer() {
  mkdirSync(logsDir, { recursive: true });
  const fd = openSync(consoleLog, 'a');
  writeFileSync(fd, `\n===== headless start ${new Date().toISOString()} =====\n`);
  const serverArgs = [appMain, `--dataPath=${dataPath}`];
  if (adminKey) serverArgs.push(`--adminPassword=${adminKey}`);
  const child = spawn(process.execPath, serverArgs, {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  console.log(`spawned headless server (pid ${child.pid}), waiting for ${baseUrl}…`);
  return child.pid;
}

async function start() {
  let status = await apiStatus();
  if (status) {
    console.log('already running.');
  } else {
    if (!existsSync(appMain))
      die(`Foundry app not found at ${appMain} — set LOCAL_FOUNDRY_APP in .env`);
    if (!existsSync(dataRoot)) die(`local Data dir not found: ${dataRoot}`);
    let pid = spawnServer();
    status = await poll(apiStatus, 60_000);
    if (!status && !pidAlive(pid) && logTail(4).includes('already locked')) {
      // A killed predecessor's options.json.lock goes stale after ~10s — wait it out, once.
      console.log('dataPath lock from a dead process — waiting 12s for it to go stale…');
      await new Promise(r => setTimeout(r, 12_000));
      pid = spawnServer();
      status = await poll(apiStatus, 60_000);
    }
    if (!status) {
      const hint = pidAlive(pid) ? 'process is alive but not answering' : 'process exited';
      clearPid();
      die(`server did not come up within 60s (${hint}) — tail of server log:\n${logTail()}`);
    }
  }
  if (!status.active && !noWorld) status = await launchWorld();
  printStatus(status);
}

async function stop() {
  const status = await apiStatus();
  const pid = readPid();
  if (!status) {
    if (pidAlive(pid)) console.log(`port quiet but pid ${pid} alive — leaving it; check manually.`);
    else {
      clearPid();
      console.log('not running.');
    }
    return;
  }
  if (status.active) {
    if (status.users > 0 && !force)
      die(
        `${status.users} user(s) still connected — disconnect-bridge / check no human is mid-session, or --force`
      );
    requireAdminKey();
    console.log('deactivating world…');
    const { status: http, payload } = await postJson('/join', {
      action: 'shutdown',
      adminPassword: adminKey,
    });
    if (http !== 200 || payload?.status !== 'success')
      die(`world shutdown refused: HTTP ${http} ${JSON.stringify(payload)}`);
    const idle = await poll(
      async () => {
        const s = await apiStatus(1500);
        return s && !s.active ? s : null;
      },
      30_000,
      1500
    );
    if (!idle) die('world still active 30s after successful shutdown — investigate');
  }
  // World DB is disconnected and saved (deactivate did the flush); v14 has no process-exit
  // route, so ending the Setup-idle process is the intended exit.
  if (pidAlive(pid)) {
    console.log(`ending server process (pid ${pid})…`);
    try {
      process.kill(pid);
    } catch {}
    await poll(async () => !pidAlive(pid), 15_000, 1000);
    if (pidAlive(pid)) {
      if (!force) die(`pid ${pid} would not exit — retry with --force for taskkill /F`);
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    }
  } else {
    console.log(
      'no tracked pid (server started outside this launcher?) — world deactivated; the process is still up.'
    );
    if (!force)
      die(
        'refusing to guess which process to end — close it yourself, or --force after setting a pid file'
      );
  }
  const gone = await poll(
    async () => ((await apiStatus(1500)) === null ? true : null),
    15_000,
    1500
  );
  if (!gone) die('port still answering after process end — investigate');
  clearPid();
  console.log('stopped.');
}

try {
  switch (command) {
    case 'start':
      await start();
      break;
    case 'stop':
      await stop();
      break;
    case 'restart':
      await stop();
      await start();
      break;
    case 'status': {
      const status = await apiStatus();
      printStatus(status);
      const pid = readPid();
      if (pid) console.log(`pid:     ${pid}${pidAlive(pid) ? '' : ' (stale)'}`);
      break;
    }
    default:
      console.error(
        'usage: node scripts/local-foundry.mjs <start [--no-world] | stop [--force] | restart | status>'
      );
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Fail ? `✗ ${err.message}` : err);
  process.exitCode = 1;
}
