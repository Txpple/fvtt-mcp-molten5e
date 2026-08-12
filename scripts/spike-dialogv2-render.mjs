// Spike #4 — what does DialogV2's `render` option actually receive?
//
// verify-partystash-coin.mjs showed the coin dialog's live clamping never wiring up, which
// means the render callback either never fires or is handed something other than an element.
// This probe opens a throwaway DialogV2 with a render callback that records the ARGUMENT
// SHAPES, then reports them, plus DialogV2.wait's own source.
//
// Read-only. Run: node scripts/spike-dialogv2-render.mjs
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

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

try {
  console.log('[spike4] connecting…');
  await f.connect();

  const out = await f.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const res = {};
    const DialogV2 = foundry.applications.api.DialogV2;
    res.waitSource = DialogV2.wait.toString().slice(0, 1800);
    res.protoMethods = Object.getOwnPropertyNames(DialogV2.prototype);
    res.defaultOptions = Object.keys(DialogV2.DEFAULT_OPTIONS ?? {});

    const seen = [];
    const promise = DialogV2.wait({
      classes: ['zz-spike-dialog'],
      window: { title: 'ZZ Spike' },
      content:
        '<div class="zz-coins"><label><input type="number" name="pp" value="0" max="2"></label></div>' +
        '<p class="zz-avail"></p>',
      buttons: [
        { action: 'go', label: 'Go', default: true, callback: () => 'went' },
        { action: 'cancel', label: 'Cancel' },
      ],
      rejectClose: false,
      render: (...args) => {
        seen.push(
          args.map(a => {
            if (a == null) return String(a);
            if (a instanceof Event) return `Event(${a.type})`;
            if (a instanceof HTMLElement) return `HTMLElement<${a.tagName}.${a.className}>`;
            if (a?.constructor?.name) return `obj:${a.constructor.name}`;
            return typeof a;
          })
        );
        // Can we reach the form from each argument?
        for (const a of args) {
          if (a instanceof HTMLElement) {
            seen.push({
              tag: a.tagName,
              cls: a.className,
              hasElements: !!a.elements,
              formViaQuery: !!a.querySelector('form'),
              ppViaElements: !!a.elements?.pp,
              ppViaQuery: !!a.querySelector('[name="pp"]'),
              availViaQuery: !!a.querySelector('.zz-avail'),
            });
          } else if (a && typeof a === 'object' && a.element instanceof HTMLElement) {
            seen.push({
              viaAppInstance: true,
              tag: a.element.tagName,
              cls: a.element.className,
              ppViaQuery: !!a.element.querySelector('[name="pp"]'),
            });
          }
        }
      },
    });

    await sleep(1500);
    const dialog = document.querySelector('.zz-spike-dialog');
    res.dialogFound = !!dialog;
    res.dialogTag = dialog?.tagName;
    res.dialogClass = dialog?.className;
    res.dialogIsForm = dialog?.tagName === 'FORM';
    res.innerFormFound = !!dialog?.querySelector('form');
    res.ppReachable = !!dialog?.querySelector('[name="pp"]');
    // Close it via its own cancel button so nothing is left on screen.
    dialog?.querySelector('button[data-action="cancel"]')?.click();
    await sleep(600);
    document.querySelector('.zz-spike-dialog')?.remove();
    res.renderCallbackArgs = seen;
    res.renderCallbackFired = seen.length > 0;
    await promise.catch(() => {});
    return res;
  }, null);

  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error('[spike4] ERROR:', e?.stack || e);
  process.exitCode = 1;
} finally {
  await f.dispose();
}
