// Page-side: shared plumbing for dnd5e `cast` activities — the spell-link resolver and the
// cached-spellbook-copy settler. Lives in its own module because BOTH manage-activity (generic
// activity CRUD) and free-cast (the feature-granted free-cast policy tool) need it, and importing
// either from the other would cycle.
//
// Ground truth (dnd5e 5.3.3, read from source 2026-07-05): a cast activity with
// `spell.spellbook: true` on an actor-embedded item makes the system project a CACHED SPELL item
// into the sheet's native "Additional Spells" spellbook section (DND5E.CAST.SECTIONS.Spellbook).
// The copy is minted asynchronously by ActivitiesTemplate#onUpdateActivities / onCreateActivities
// (flag `dnd5e.cachedFor` = the activity's relativeUUID), lazily by CastActivity#use, and is
// auto-deleted with its activity. Under Foundry v14 we observed MULTI-MINTING (three copies from a
// single update, single client — live 2026-07-05), so settleCachedSpellCopies() exists to make the
// outcome deterministic: wait for the mint, mint via the system's own getCachedSpellData() if it
// never lands, dedupe to exactly ONE, and optionally apply a house-convention name.

import { DEFAULT_SPELL_PACKS, isSrdPack } from '../../utils/compendium-sources.js';

/** Facts a pure cast-activity builder needs about the linked spell, plus the live compendium doc. */
export interface CastSpellFacts {
  uuid: string;
  name: string;
  level: number;
  /** V/S/M casting-component property keys (concentration/ritual are the spell's business). */
  properties: string[];
  /** The spell's own casting time ('action' | 'bonus' | 'reaction' | ...) — casts inherit it. */
  activationType: string;
  /** The resolved compendium document (for repertoire imports via fromCompendium). */
  doc: any;
}

/**
 * Resolve + validate a spell uuid for a `cast` activity (the activity LINKS a real compendium
 * spell — design.md §2.3 / authoring-policy: an item's referenced spell is reached by COPYING a
 * book spell, never by hand-rolling a fake save/damage activity). It NEVER invents — an off-book
 * or SRD spell throws so the skill STOPs and ASKs instead of fabricating.
 */
export async function resolveCastSpell(spellUuid: string | undefined): Promise<CastSpellFacts> {
  if (!spellUuid) {
    throw new Error(
      'A cast activity requires `spellUuid` — the Compendium uuid of the spell to link ' +
        '(e.g. "Compendium.dnd-players-handbook.spells.Item.phbsplFireball00").'
    );
  }
  const spell: any = await fromUuid(spellUuid);
  if (!spell) {
    throw new Error(
      `Spell not found for uuid "${spellUuid}". A cast activity must LINK a real compendium spell ` +
        '(mirror the Wand of Fireballs). If the spell is not in the premium books, STOP and ASK — ' +
        'substitute a book spell, drop it, or get explicit homebrew permission; do not hand-roll a ' +
        'fake save/damage activity to simulate an off-book spell (design.md §2.3).'
    );
  }
  if (spell.documentName !== 'Item' || spell.type !== 'spell') {
    throw new Error(
      `uuid "${spellUuid}" resolves to a ${spell.documentName}/${spell.type ?? '?'}, not a spell.`
    );
  }
  const packId: string = spell.pack ?? '';
  if (isSrdPack(packId)) {
    throw new Error(
      `Refusing to link an SRD spell (pack "${packId}") into a cast activity — author from the ` +
        'premium books only (design.md §2.3). Use the dnd-players-handbook.spells equivalent.'
    );
  }
  const src = typeof spell.toObject === 'function' ? spell.toObject() : spell;
  const rawProps = src?.system?.properties;
  const allProps: string[] = Array.isArray(rawProps) ? rawProps : Array.from(rawProps ?? []);
  // The cast activity carries only the V/S/M casting COMPONENTS (not concentration/ritual/etc).
  const COMPONENTS = new Set(['vocal', 'somatic', 'material']);
  const properties = allProps.filter(p => COMPONENTS.has(p));
  return {
    uuid: spellUuid,
    level: typeof src?.system?.level === 'number' ? src.system.level : 0,
    properties,
    name: spell.name ?? 'Spell',
    activationType: src?.system?.activation?.type || 'action',
    doc: spell,
  };
}

/**
 * Resolve a premium-pack spell uuid by exact name (case-insensitive) — the fallback when an
 * embedded spell copy carries no `_stats.compendiumSource` (raw toObject() imports don't set it).
 */
export async function resolveSpellUuidByName(name: string): Promise<string | null> {
  const wanted = String(name ?? '')
    .trim()
    .toLowerCase();
  if (!wanted) return null;
  for (const packId of DEFAULT_SPELL_PACKS) {
    const pack = (game as any).packs.get(packId);
    if (pack?.metadata.type !== 'Item') continue;
    if (!pack.indexed) await pack.getIndex({});
    for (const entry of pack.index.values()) {
      if ((entry.name ?? '').toLowerCase() === wanted) {
        return `Compendium.${packId}.Item.${entry._id}`;
      }
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export interface SettledCachedSpell {
  /** Id of the ONE cached spellbook copy kept for this activity (null if none could be built). */
  cachedId: string | null;
  cachedName: string | null;
  /** Who created the kept copy: the system's own async mint, or this tool's deterministic mint. */
  mintedBy: 'system' | 'tool' | null;
  /** Duplicate cached copies deleted (the v14 multi-mint). */
  removedDuplicates: number;
  warnings: string[];
}

/**
 * Make the cached "Additional Spells" copy for one cast activity DETERMINISTIC. dnd5e mints copies
 * asynchronously and the stream can trickle (each mint awaits a compendium load) and multi-fire
 * (observed under v14: three copies from one update) — so this waits for the copy population to
 * STABILIZE, mints via the system's own CastActivity#getCachedSpellData() when nothing ever lands,
 * converges to exactly ONE copy (optionally titled `desiredName`), then verifies once more to
 * catch photo-finish arrivals.
 */
export async function settleCachedSpellCopies(
  actor: any,
  featureItem: any,
  activityId: string,
  desiredName?: string,
  opts: { waitMs?: number; pollMs?: number; stableMs?: number } = {}
): Promise<SettledCachedSpell> {
  const waitMs = opts.waitMs ?? 5000;
  const pollMs = opts.pollMs ?? 150;
  const stableMs = opts.stableMs ?? 700;
  const warnings: string[] = [];

  const activity = featureItem?.system?.activities?.get?.(activityId);
  if (!activity) {
    throw new Error(`Activity "${activityId}" not found on "${featureItem?.name}" while settling`);
  }
  if (activity.type !== 'cast') {
    throw new Error(`Activity "${activityId}" on "${featureItem?.name}" is not a cast activity`);
  }

  const rel: string = activity.relativeUUID; // `.Item.<itemId>.Activity.<activityId>`
  const findCopies = (): any[] =>
    (actor.items?.filter?.(
      (i: any) => i.type === 'spell' && i.getFlag?.('dnd5e', 'cachedFor') === rel
    ) ?? []) as any[];

  // Wait until the copy population holds still for stableMs (or the deadline passes). Returns the
  // stable set. Waiting for merely the FIRST copy is how the trickle-mint produced duplicates.
  const waitForStability = async (deadline: number): Promise<any[]> => {
    let copies = findCopies();
    let lastCount = copies.length;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      await sleep(pollMs);
      copies = findCopies();
      if (copies.length !== lastCount) {
        lastCount = copies.length;
        stableSince = Date.now();
      } else if (copies.length > 0 && Date.now() - stableSince >= stableMs) {
        break;
      }
    }
    return copies;
  };

  // Converge the current population to exactly one copy, preferring one already carrying the
  // convention name (stable ids for player favorites/macros). Returns the kept copy (or null).
  const convergeToOne = async (copies: any[]): Promise<{ keep: any; removed: number }> => {
    if (copies.length === 0) return { keep: null, removed: 0 };
    const sorted = [...copies].sort((a, b) => {
      const aNamed = desiredName && a.name === desiredName ? 0 : 1;
      const bNamed = desiredName && b.name === desiredName ? 0 : 1;
      return aNamed - bNamed;
    });
    const keep = sorted[0];
    const extras = sorted.slice(1);
    if (extras.length > 0) {
      await actor.deleteEmbeddedDocuments(
        'Item',
        extras.map((i: any) => i.id)
      );
    }
    if (desiredName && keep.name !== desiredName) {
      await actor.updateEmbeddedDocuments('Item', [{ _id: keep.id, name: desiredName }]);
    }
    return { keep: actor.items?.get?.(keep.id) ?? keep, removed: extras.length };
  };

  // Mint through the SYSTEM's own builder so the copy is byte-identical to a native one
  // (spellchanges enchantment, cachedFor flag, sourceItem, compendium source).
  const toolMint = async (): Promise<any | null> => {
    const data = await activity.getCachedSpellData?.();
    if (!data) return null;
    if (desiredName) data.name = desiredName;
    const [created] = await actor.createEmbeddedDocuments('Item', [data]);
    return created ?? null;
  };

  // Phase 1: let the system's mint stream settle.
  let copies = await waitForStability(Date.now() + waitMs);
  let mintedBy: 'system' | 'tool' | null = copies.length > 0 ? 'system' : null;
  if (copies.length === 0) {
    const created = await toolMint();
    if (!created) {
      warnings.push(
        'Cached spellbook copy could not be built (linked spell unresolved?) — dnd5e will mint it ' +
          'on first use instead.'
      );
      return { cachedId: null, cachedName: null, mintedBy: null, removedDuplicates: 0, warnings };
    }
    mintedBy = 'tool';
    copies = await waitForStability(Date.now() + stableMs + pollMs); // sweep photo-finish arrivals
  }

  // Phase 2: converge to one named copy.
  let { keep, removed } = await convergeToOne(copies);
  let removedTotal = removed;

  // Phase 3: verify — late arrivals (or dnd5e's own delete-then-remint on a spell.uuid change)
  // can still land after convergence; reconcile once more.
  copies = await waitForStability(Date.now() + stableMs + pollMs);
  if (copies.length === 0) {
    const created = await toolMint();
    if (created) {
      keep = created;
      mintedBy = mintedBy ?? 'tool';
    }
  } else if (copies.length > 1 || (keep && !copies.some((c: any) => c.id === keep.id))) {
    const again = await convergeToOne(copies);
    keep = again.keep;
    removedTotal += again.removed;
  }

  if (removedTotal > 0) {
    warnings.push(
      `Deduped ${removedTotal} duplicate cached cop${removedTotal === 1 ? 'y' : 'ies'} of the ` +
        `spellbook entry (the v14 multi-mint).`
    );
  }
  if (!keep) {
    return { cachedId: null, cachedName: null, mintedBy, removedDuplicates: removedTotal, warnings };
  }
  const kept = actor.items?.get?.(keep.id) ?? keep;
  return {
    cachedId: kept.id,
    cachedName: kept.name,
    mintedBy,
    removedDuplicates: removedTotal,
    warnings,
  };
}
