// Enable/disable world modules by rewriting core.moduleConfiguration through the bridge.
//
// Installing a package (register-module.mjs) registers it with the SERVER; it does not switch
// it on in the WORLD. That is this setting. The change only takes effect on the next world
// boot, so follow this with a bounce — re-running register-module.mjs with the same args is
// the cheapest one (installPackage over an identical version is a no-op, then it relaunches).
//
//   node scripts/configure-modules.mjs --enable fvtt-mod-lootshelf --disable some-module,another-module
//   node scripts/configure-modules.mjs --enable X --dry-run      # show the diff, write nothing
//
// Prints the before/after config and reads it back after writing. If the bridge user lacks
// SETTINGS_MODIFY the write is reported as REFUSED rather than silently dropped.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const arg = n => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const list = s =>
  s
    ? s
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    : [];
const enable = list(arg('enable'));
const disable = list(arg('disable'));
const dryRun = process.argv.includes('--dry-run');
if (!enable.length && !disable.length) {
  console.error('usage: node scripts/configure-modules.mjs --enable a,b --disable c,d [--dry-run]');
  process.exit(2);
}

setTimeout(() => {
  console.error('[modcfg] WATCHDOG: 180s elapsed — hard abort');
  process.exit(3);
}, 180_000);

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

console.log('[modcfg] connecting…');
await f.connect();
console.log('[modcfg] connected');

const result = await f.evaluate(
  async payload => {
    const { enable, disable, dryRun } = payload;
    const KEY = 'moduleConfiguration';
    const before = foundry.utils.deepClone(game.settings.get('core', KEY)) ?? {};

    // Registration check — enabling an id the server does not have installed silently does
    // nothing at boot, so surface it here instead.
    const known = {};
    for (const id of [...enable, ...disable]) {
      const m = game.modules.get(id);
      known[id] = m
        ? { installed: true, version: m.version, active: m.active }
        : { installed: false };
    }

    const next = { ...before };
    for (const id of enable) next[id] = true;
    for (const id of disable) next[id] = false;

    const changes = [];
    for (const id of [...enable, ...disable])
      if (before[id] !== next[id]) changes.push(`${id}: ${before[id]} -> ${next[id]}`);

    let wrote = null;
    let error = null;
    if (!dryRun && changes.length) {
      try {
        await game.settings.set('core', KEY, next);
        wrote = true;
      } catch (e) {
        wrote = false;
        error = String(e?.message || e);
      }
    }

    const after = game.settings.get('core', KEY) ?? {};
    const readback = {};
    for (const id of [...enable, ...disable]) readback[id] = after[id];

    return {
      canModify: game.user.can('SETTINGS_MODIFY'),
      role: game.user.role,
      known,
      changes,
      wrote,
      error,
      readback,
    };
  },
  { enable, disable, dryRun }
);

console.log(`\nbridge user role=${result.role} SETTINGS_MODIFY=${result.canModify}`);
console.log('\n# registration');
for (const [id, k] of Object.entries(result.known))
  console.log(
    `  ${id}: ${k.installed ? `installed v${k.version} (active=${k.active})` : 'NOT INSTALLED'}`
  );

console.log(`\n# changes (${result.changes.length})`);
for (const c of result.changes) console.log(`  ${c}`);
if (!result.changes.length) console.log('  (none — already in the requested state)');

if (dryRun) {
  console.log('\n[modcfg] --dry-run: nothing written');
} else if (result.changes.length) {
  console.log(`\n[modcfg] write: ${result.wrote ? 'OK' : `REFUSED — ${result.error}`}`);
}

console.log('\n# readback');
for (const [id, v] of Object.entries(result.readback)) console.log(`  ${id} = ${v}`);

const bad = Object.entries(result.readback).filter(
  ([id, v]) => (enable.includes(id) && v !== true) || (disable.includes(id) && v !== false)
);
if (!dryRun && bad.length) {
  console.error(
    `\n[modcfg] RESULT: FAIL — not in requested state: ${bad.map(([i]) => i).join(', ')}`
  );
  process.exit(1);
}
console.log(`\n[modcfg] RESULT: PASS${dryRun ? ' (dry run)' : ' — bounce the world to apply'}`);
process.exit(0);
