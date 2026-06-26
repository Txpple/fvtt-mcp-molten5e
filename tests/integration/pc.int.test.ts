// PC build + advancement (live). The PC/advancement engine (src/page/dnd5e/advancement.ts) is the most
// intricate logic in the repo and — before this suite — had ZERO automated coverage of its live
// orchestration (it was proven only by off-by-default scripts/verify-pc-build.mjs). This drives create-pc
// end-to-end through the real bridge and INSPECTS the persisted dnd5e actor (HP, spell slots, embedded
// class/subclass items, @scale) via the page-eval escape hatch — the correctness gate the seam-mocking
// unit tests cannot provide. The failure-posture (success:false + no-persist on a corrupting advancement)
// is validated deterministically offline in the page mock harness; this suite covers the happy paths.
//
// OFF by default (RUN_LIVE + .env — see setup.ts). Everything is built on disposable PCs, deleted in afterAll.
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Foundry } from '../../dist/foundry.js';
import { DnD5ePcTools } from '../../dist/tools/dnd5e/pc.js';
import { LIVE, foundryConfig, noopLogger, CONNECT_TIMEOUT_MS, TAG } from './setup.js';

interface InspectedPc {
  type?: string;
  hpMax?: number;
  spell1Max?: number;
  classCount: number;
  subclassCount: number;
  totalLevel?: number;
}

describe.skipIf(!LIVE)('dnd5e PC build + advancement (live)', () => {
  const WIZ = `${TAG} Wizard`;
  const MC = `${TAG} Fighter-Wizard`;
  const ABIL = { str: 10, dex: 14, con: 14, int: 16, wis: 12, cha: 10 };

  let foundry: Foundry;
  let pc: DnD5ePcTools;
  const createdNames: string[] = [];
  let wizOut: any;
  let mcOut: any;

  beforeAll(async () => {
    foundry = new Foundry(foundryConfig(), noopLogger);
    await foundry.connect();
    pc = new DnD5ePcTools({ foundry, logger: noopLogger });
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    for (const name of createdNames) {
      try {
        await foundry.call('deleteActor', { identifiers: [name], removeEmptyFolder: false });
      } catch {
        /* best-effort cleanup */
      }
    }
    await foundry?.dispose();
  });

  /** Resolve a PC by name and read the persisted/derived data model directly in the page. */
  async function inspect(name: string): Promise<InspectedPc | null> {
    const found = await foundry.call<{ id?: string }>('findActor', { identifier: name });
    if (!found?.id) return null;
    return foundry.evaluate((id: string) => {
      const g = (globalThis as { game?: { actors?: { get(id: string): unknown } } }).game;
      const live: any = g?.actors?.get(id);
      if (!live) return null;
      const a = live.toObject();
      return {
        type: a.type,
        // HP/slots are DERIVED — read the live doc (the source carries value, not the computed max).
        hpMax: live.system?.attributes?.hp?.max,
        spell1Max: live.system?.spells?.spell1?.max ?? 0,
        classCount: (a.items ?? []).filter((i: any) => i.type === 'class').length,
        subclassCount: (a.items ?? []).filter((i: any) => i.type === 'subclass').length,
        totalLevel: live.system?.details?.level,
      };
    }, found.id);
  }

  it('create-pc builds a level-1 Wizard (persists, no unresolved @scale)', async () => {
    wizOut = await pc.handleCreatePc({
      name: WIZ,
      className: 'Wizard',
      level: 1,
      abilities: ABIL,
      acceptDefaults: true,
    });
    expect(wizOut?.success).toBe(true);
    if (wizOut?.success) createdNames.push(WIZ);
    expect((wizOut?.unresolvedScale ?? []).length).toBe(0);
  });

  it('the Wizard reads ready-to-play: HP > 0 and a level-1 spell slot', async ctx => {
    if (!wizOut?.success) return ctx.skip();
    const got = await inspect(WIZ);
    expect(got?.type).toBe('character');
    expect((got?.hpMax ?? 0) > 0).toBe(true);
    expect((got?.spell1Max ?? 0) > 0).toBe(true);
  });

  it('create-pc builds a multiclass Fighter 3 (subclass) / Wizard 1 in one call', async () => {
    // Discover the level-3 subclass choice via the needsChoices dry-run (nothing is persisted), then
    // pick the first legal subclass and build with acceptDefaults for the remaining picks.
    const dry = await pc.handleCreatePc({
      name: MC,
      className: 'Fighter',
      level: 3,
      abilities: ABIL,
    });
    const sub = (dry?.needsChoices ?? []).find((c: any) => c.type === 'Subclass');
    const choices = sub?.options?.[0]?.value
      ? { '3': { [sub.id]: { uuid: sub.options[0].value } } }
      : {};

    mcOut = await pc.handleCreatePc({
      name: MC,
      className: 'Fighter',
      level: 3,
      multiclass: [{ className: 'Wizard', levels: 1 }],
      abilities: ABIL,
      choices,
      acceptDefaults: true,
    });
    expect(mcOut?.success).toBe(true);
    if (mcOut?.success) createdNames.push(MC);
    expect((mcOut?.unresolvedScale ?? []).length).toBe(0);
  });

  it('the multiclass PC has both classes, a subclass, and total level 4', async ctx => {
    if (!mcOut?.success) return ctx.skip();
    const got = await inspect(MC);
    expect(got?.classCount).toBe(2);
    expect((got?.subclassCount ?? 0) >= 1).toBe(true);
    expect(got?.totalLevel).toBe(4);
  });
});
