// foundry.ts — THE quarantine.
//
// This is the ONLY file in the codebase that knows Playwright/CDP exists. It owns the
// entire live bridge: launch headless Chromium, wake the (sleeping) Molten box via the
// Magic URL, join the world as the dedicated passwordless MCP user, wait for game.ready,
// inject the page-side domain library (window.__fvtt), and expose a tiny seam:
//
//     foundry.call(name, args)   ->  window.__fvtt[name](args)   (the tool surface)
//     foundry.evaluate(fn, arg)  ->  page.evaluate(fn, arg)      (escape hatch)
//
// Everything else in the tree calls foundry.call() and never sees a Page. The irreducible
// "Foundry is a live, locked DB" complexity lives here and nowhere else.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * The seam the rest of the codebase depends on. Tools import THIS (a type),
 * never the Playwright-backed `Foundry` class, so nothing outside foundry.ts
 * pulls in Playwright. `call(name, args)` mirrors the legacy
 * foundryClient.query('foundry-mcp-bridge.<name>', data) 1:1.
 */
export interface FoundryBridge {
  call<T = any>(name: string, args?: unknown): Promise<T>;
}

export interface FoundryConfig {
  /** Base world URL, e.g. https://eoh-test.moltenhosting.com (MOLTEN_SERVER_URL). */
  serverUrl: string;
  /** Molten "Server Startup / Magic URL" (…?s=token) — GET to wake a sleeping box. */
  magicUrl?: string;
  /** Dedicated Foundry user to join as (FOUNDRY_USER, e.g. "MCP-Claude"). */
  user: string;
  /** Optional user password; omit for a passwordless user. */
  password?: string;
  /**
   * Foundry admin access key (MOLTEN_ADMIN_KEY). When set (with worldId), a cold box whose
   * VM is up but has no world launched is recovered by authenticating to /setup and launching
   * the world. Omit to keep world-launch a manual step (the bridge then fails with guidance).
   */
  adminKey?: string;
  /** World to launch when the box is up but no world is active (MOLTEN_WORLD_ID). */
  worldId?: string;
  /** Run Chromium headless (default true). */
  headless?: boolean;
  /** Ms to wait for game.ready after submitting the join form (default 120000). */
  readyTimeoutMs?: number;
  /** Overall budget to bring a cold box up (wake + optional launch) before joining (default 600000). */
  wakeTimeoutMs?: number;
}

export interface FoundryLogger {
  debug: (msg: string, meta?: unknown) => void;
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}

const consoleLogger: FoundryLogger = {
  debug: m => console.error(`[foundry] ${m}`),
  info: m => console.error(`[foundry] ${m}`),
  warn: m => console.error(`[foundry] ${m}`),
  error: m => console.error(`[foundry] ${m}`),
};

export class Foundry implements FoundryBridge {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private ready = false;
  private connecting: Promise<void> | undefined;
  private readonly pageBundle: string;

  constructor(
    private readonly cfg: FoundryConfig,
    private readonly log: FoundryLogger = consoleLogger
  ) {
    this.pageBundle = loadPageBundle();
  }

  isReady(): boolean {
    return this.ready && !!this.page && !this.page.isClosed();
  }

  /** Idempotent connect (wake -> join -> game.ready -> inject). Safe to await concurrently. */
  async connect(): Promise<void> {
    if (this.isReady()) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    this.ready = false;
    this.browser ??= await chromium.launch({ headless: this.cfg.headless ?? true });
    this.context ??= await this.browser.newContext({ viewport: { width: 1920, height: 1080 } });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.cfg.readyTimeoutMs ?? 120_000);

    await this.wake();
    await this.ensureWorldReady(this.page);
    await this.joinWorld(this.page);
    await this.injectBundle(this.page);
    this.ready = true;
    this.log.info(`connected as "${this.cfg.user}" — game.ready`);
  }

  /** GET the Magic URL to spin a sleeping Molten box back up (best-effort). */
  private async wake(): Promise<void> {
    if (!this.cfg.magicUrl || !this.page) return;
    this.log.debug('waking via Magic URL');
    await this.page
      .goto(this.cfg.magicUrl, { waitUntil: 'domcontentloaded' })
      .catch(e => this.log.warn(`magic-url nav note: ${this.redact((e as Error).message)}`));
  }

  /**
   * Strip the Magic URL (and any `?s=<token>` startup secret) out of a message before it reaches
   * the logs: a Playwright nav error echoes back the URL it failed to load, which would otherwise
   * leak the wake token. Errors should name the failing thing, never its secret value.
   */
  private redact(msg: string): string {
    let out = msg;
    if (this.cfg.magicUrl) out = out.split(this.cfg.magicUrl).join('<MOLTEN_MAGIC_URL>');
    return out.replace(/([?&]s=)[^\s&"']+/gi, '$1<redacted>');
  }

  /**
   * Bring a cold box to a joinable world. The Magic URL only wakes the VM; if the VM is up
   * but no world is launched, Foundry serves a "no active game session" page indefinitely. So
   * poll /join and, by what we find, either wait out a slow boot (re-pinging the Magic URL) or
   * — when an admin key + world id are configured — launch the world ourselves via /setup.
   */
  private async ensureWorldReady(page: Page): Promise<void> {
    const budget = this.cfg.wakeTimeoutMs ?? 600_000;
    const deadline = Date.now() + budget;
    let lastLaunchAt = 0;
    let lastMagicAt = Date.now(); // wake() just ran
    while (Date.now() < deadline) {
      const state = await this.probeJoinState(page);
      if (state === 'joinable') return;
      if (state === 'no-world') {
        if (this.cfg.adminKey && this.cfg.worldId) {
          // Launch once; retry only if still 'no-world' after a grace period. Stamp the
          // attempt time BEFORE launching so a throwing attempt still honors the grace.
          if (Date.now() - lastLaunchAt > 60_000) {
            lastLaunchAt = Date.now();
            try {
              await this.launchWorld(page);
            } catch (err) {
              const msg = (err as Error).message;
              // Misconfiguration (bad admin key / wrong world id) won't self-heal — fail fast.
              if (/authentication failed|not found on \/setup/i.test(msg)) throw err;
              // Otherwise it may be a transient /setup hiccup; keep retrying within the budget.
              this.log.warn(`launch attempt failed (retrying within budget): ${msg}`);
            }
            continue; // re-probe; the world should now be booting (or retry after the grace)
          }
        } else {
          throw new Error(
            'Foundry world is not launched and no admin key is configured to launch it. ' +
              'Launch the world (Setup → Launch World), or set MOLTEN_ADMIN_KEY + MOLTEN_WORLD_ID.'
          );
        }
      }
      // booting / transient: nudge a still-sleeping box again every ~90s, then wait.
      if (Date.now() - lastMagicAt > 90_000) {
        await this.wake();
        lastMagicAt = Date.now();
      }
      await page.waitForTimeout(5_000);
    }
    throw new Error(
      `Foundry world never became joinable within ${Math.round(budget / 1000)}s ` +
        '(box failed to wake, or the world failed to launch). Check MOLTEN_SERVER_URL/MOLTEN_MAGIC_URL.'
    );
  }

  /** Classify the box by loading /join: ready to join, up-but-no-world, or still booting. */
  private async probeJoinState(page: Page): Promise<'joinable' | 'no-world' | 'booting'> {
    try {
      await page.goto(`${this.base}/join`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      return 'booting'; // connection refused / nav error -> VM still coming up
    }
    // The user <select> is client-rendered after the world loads; give it a brief chance.
    const hasForm = await page
      .waitForSelector('select[name="userid"]', { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (hasForm) return 'joinable';
    // No form: distinguish "VM up, no world active" (Foundry's themed "Critical Failure!" /
    // "no active game session" page) from a world still booting (its own splash). Check BOTH
    // body text and title, so detection doesn't hinge on body innerText being populated.
    const { bodyText, title } = await page
      .evaluate(() => ({ bodyText: document.body?.innerText ?? '', title: document.title ?? '' }))
      .catch(() => ({ bodyText: '', title: '' }));
    if (
      /no active game session|configure the world/i.test(bodyText) ||
      /critical failure/i.test(title)
    )
      return 'no-world';
    return 'booting';
  }

  /** Authenticate to /setup with the admin key and launch the configured world. */
  private async launchWorld(page: Page): Promise<void> {
    this.log.info(`world not active — launching "${this.cfg.worldId}" via admin /setup`);
    await page
      .goto(`${this.base}/setup`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch(() => {});
    await page.waitForSelector('input[name="adminPassword"]', { timeout: 30_000 });
    await page.fill('input[name="adminPassword"]', this.cfg.adminKey ?? '');
    await page.locator('button[name="action"], button[type="submit"]').first().click();
    // Foundry returns to /setup with the world tiles once authenticated. If the tile never
    // appears, disambiguate the cause so the operator gets an actionable error (not a raw
    // selector timeout): a persistent password gate = rejected admin key; otherwise a wrong
    // world id. ensureWorldReady fails fast on both (neither self-heals).
    const tile = `li[data-package-id="${this.cfg.worldId}"]`;
    const appeared = await page
      .waitForSelector(tile, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      const stillGated = await page
        .locator('input[name="adminPassword"]')
        .count()
        .catch(() => 0);
      throw new Error(
        stillGated
          ? 'Foundry admin authentication failed — check MOLTEN_ADMIN_KEY'
          : `world "${this.cfg.worldId}" not found on /setup — check MOLTEN_WORLD_ID`
      );
    }
    // Prefer Foundry's own setup POST helper: the "Launch World" button calls
    // game.post({action:'launchWorld', world}) internally. It's robust (no hover/visibility
    // games) but only valid while no world is active. A successful launch navigates away,
    // destroying the eval context — treat that as success. Fall back to clicking the
    // hover-reveal launch control if game.post is unavailable or rejects.
    const world = this.cfg.worldId ?? '';
    const outcome = await page
      .evaluate(async w => {
        const g = (globalThis as { game?: { post?: (d: unknown) => Promise<unknown> } }).game;
        if (typeof g?.post !== 'function') return 'no-api';
        await g.post({ action: 'launchWorld', world: w });
        return 'ok';
      }, world)
      .catch((e: Error) => (/context|destroyed|navigat/i.test(e.message) ? 'ok' : 'error'));
    if (outcome !== 'ok') {
      this.log.warn(`launch via game.post unavailable (${outcome}) — using the UI control`);
      await page
        .locator(tile)
        .hover()
        .catch(() => {});
      const clicked = await page
        .locator(`${tile} [data-action="worldLaunch"]`)
        .click({ force: true, timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) {
        await page.evaluate(w => {
          document
            .querySelector<HTMLElement>(`li[data-package-id="${w}"] [data-action="worldLaunch"]`)
            ?.click();
        }, world);
      }
    }
    this.log.info('worldLaunch dispatched — waiting for the world to boot');
  }

  private get base(): string {
    return this.cfg.serverUrl.replace(/\/$/, '');
  }

  /** Navigate to /join, select the user (force-enabling a stale-active option), submit, await ready. */
  private async joinWorld(page: Page): Promise<void> {
    // The user <select> is rendered by Foundry's client JS AFTER it finishes loading the
    // world (the page first shows a "<world> Version 14 Build NNN" splash). So navigate ONCE
    // and WAIT for the form — do NOT re-goto in a tight loop, which restarts the client-side
    // load and leaves the box perpetually on the splash. Reload only between long waits, to
    // ride out a cold Molten boot where the first hit lands on the "starting" interstitial.
    const perTryMs = 45_000;
    const tries = 6; // up to ~4.5 min total for a cold boot
    let formReady = false;
    for (let attempt = 1; attempt <= tries && !formReady; attempt++) {
      await page.goto(`${this.base}/join`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      try {
        await page.waitForSelector('select[name="userid"]', { timeout: perTryMs });
        formReady = true;
      } catch {
        const title = await page.title().catch(() => '?');
        this.log.debug(
          `/join form not ready (attempt ${attempt}/${tries}; title="${title}") — reloading`
        );
      }
    }
    if (!formReady) {
      throw new Error(
        'Foundry /join form never appeared — world may be inactive (check /setup) or box asleep.'
      );
    }

    const users: string[] = await page.evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>('select[name="userid"]');
      return sel ? [...sel.options].map(o => o.textContent?.trim() ?? '') : [];
    });
    if (!users.includes(this.cfg.user)) {
      throw new Error(`User "${this.cfg.user}" not on /join. Available: ${JSON.stringify(users)}`);
    }

    // Select the user, force-enabling the option if Foundry disabled it (stale active flag).
    await page.evaluate(label => {
      const sel = document.querySelector('select[name="userid"]') as HTMLSelectElement;
      const opt = [...sel.options].find(o => o.textContent?.trim() === label);
      if (!opt) throw new Error('user option vanished');
      opt.disabled = false;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, this.cfg.user);

    if (this.cfg.password) {
      await page.fill('input[name="password"]', this.cfg.password);
    }

    await page.locator('button[name="join"], button[type="submit"]').first().click();

    const timeout = this.cfg.readyTimeoutMs ?? 120_000;
    const outcome = await Promise.race([
      page
        .waitForFunction(
          () => (globalThis as { game?: { ready?: boolean } }).game?.ready === true,
          null,
          { timeout }
        )
        .then(() => 'ready' as const),
      (async () => {
        for (let i = 0; i < Math.ceil(timeout / 2000); i++) {
          const errs = await page
            .evaluate(() =>
              [...document.querySelectorAll('.notification.error, p.error')]
                .map(e => e.textContent?.trim())
                .filter(Boolean)
            )
            .catch(() => [] as string[]);
          if (errs.length) return `error: ${errs.join(' | ')}`;
          await page.waitForTimeout(2000);
        }
        return 'timeout';
      })(),
    ]);
    if (outcome !== 'ready') throw new Error(`Join did not reach game.ready (${outcome}).`);
  }

  /** Inject the bundled page-side domain library, defining window.__fvtt. */
  private async injectBundle(page: Page): Promise<void> {
    await page.addScriptTag({ content: this.pageBundle });
    const ok = await page.evaluate(
      () => typeof window.__fvtt === 'object' && window.__fvtt !== null
    );
    if (!ok) throw new Error('page bundle injected but window.__fvtt is missing');
  }

  /**
   * The tool seam: invoke a page-side domain function by name.
   * Mirrors the legacy foundryClient.query('foundry-mcp-bridge.X', data) 1:1.
   */
  async call<T = unknown>(name: string, args?: unknown): Promise<T> {
    await this.ensureReady();
    try {
      return await this.invoke<T>(name, args);
    } catch (err) {
      // A world reload / "Return to Setup" can wipe the injected window.__fvtt while the page stays
      // open. Distinguish that (the bridge is gone) from a genuine tool error: if the bridge has
      // vanished, recover once (re-inject in place, or full reconnect if the session itself dropped)
      // and retry — so a mid-session reload self-heals instead of wedging until a process restart.
      if (!(await this.bridgeAlive())) {
        this.log.warn(`page bridge missing on '${name}' — recovering and retrying`);
        await this.recover();
        try {
          return await this.invoke<T>(name, args);
        } catch (err2) {
          throw new Error(`foundry.call('${name}') failed: ${(err2 as Error).message}`);
        }
      }
      throw new Error(`foundry.call('${name}') failed: ${(err as Error).message}`);
    }
  }

  /** Single page-side dispatch into the injected window.__fvtt bridge. */
  private async invoke<T>(name: string, args?: unknown): Promise<T> {
    return (await this.page!.evaluate(
      ({ n, a }) => {
        const fn = window.__fvtt?.[n];
        if (typeof fn !== 'function') throw new Error(`Unknown page function: ${n}`);
        return fn(a);
      },
      { n: name, a: args }
    )) as T;
  }

  /** Is the injected page bridge (window.__fvtt) currently present on a live page? */
  private async bridgeAlive(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false;
    return this.page
      .evaluate(() => typeof window.__fvtt === 'object' && window.__fvtt !== null)
      .catch(() => false);
  }

  /** Is the Foundry world ready in the current page (game.ready === true)? */
  private async gameReady(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false;
    return this.page
      .evaluate(() => (globalThis as { game?: { ready?: boolean } }).game?.ready === true)
      .catch(() => false);
  }

  /**
   * Recover a lost page bridge. If the page is still alive and the world is ready (a navigation
   * wiped window.__fvtt but the session survived), re-inject the bundle in place — cheap. Otherwise
   * the session itself is gone, so do a full reconnect (wake -> join -> game.ready -> inject).
   */
  private async recover(): Promise<void> {
    if (this.page && !this.page.isClosed() && (await this.gameReady())) {
      await this.injectBundle(this.page).catch(() => {});
      if (await this.bridgeAlive()) return;
    }
    this.ready = false;
    this.page = undefined;
    await this.connect();
  }

  /** Escape hatch for one-off page logic (used sparingly; prefer named page functions). */
  async evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T> {
    await this.ensureReady();
    // Playwright's PageFunction generic is overly strict here; the escape hatch is rare.
    return this.page!.evaluate(fn as any, arg as any);
  }

  private async ensureReady(): Promise<void> {
    if (this.isReady()) return;
    this.log.warn('page not ready — reconnecting');
    this.ready = false;
    this.page = undefined;
    await this.connect();
  }

  async dispose(): Promise<void> {
    this.ready = false;
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = undefined;
    this.browser = undefined;
    this.page = undefined;
  }
}

function loadPageBundle(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, 'page.bundle.js');
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Page bundle not found at ${path}. Run \`node esbuild.page.mjs\` (or the build) before starting.`
    );
  }
}
