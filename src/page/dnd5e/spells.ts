// Page-side dnd5e WRITE: spellcasting setup + spell import. Runs INSIDE the
// headless Foundry page (dnd5e 5.3.3, Foundry v14).
//
// setActorSpellcasting writes system.spells slot levels + the casting ability
// off SRD slot tables (full / half / artificer / warlock pact). addSpellsToActor
// imports named spell Items from compendium packs into an actor. Both are
// best-effort Foundry document mutations (no rollback) and reproduce the exact
// dnd5e system-data shape + return shape the Node tools + tests expect. No module
// scaffolding (validateFoundryState / auditLog / permissions / sockets).

import { resolveActorFuzzy as findActorByIdentifier } from '../_shared.js';

// =============================================================================
// Spellcasting slot tables — used by setActorSpellcasting.
//
// Each array has 20 entries (index 0 = level 1 … index 19 = level 20).
// Each entry is a 9-element tuple: [L1, L2, L3, L4, L5, L6, L7, L8, L9].
// Source: SRD 5.1 spell slot tables.
// =============================================================================

// biome-ignore format: hand-aligned spell-slot table
const FULL_CASTER_SLOTS: number[][] = [
  //  L1  L2  L3  L4  L5  L6  L7  L8  L9
  [   2,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  1
  [   3,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  2
  [   4,   2,   0,   0,   0,   0,   0,   0,   0 ], // level  3
  [   4,   3,   0,   0,   0,   0,   0,   0,   0 ], // level  4
  [   4,   3,   2,   0,   0,   0,   0,   0,   0 ], // level  5
  [   4,   3,   3,   0,   0,   0,   0,   0,   0 ], // level  6
  [   4,   3,   3,   1,   0,   0,   0,   0,   0 ], // level  7
  [   4,   3,   3,   2,   0,   0,   0,   0,   0 ], // level  8
  [   4,   3,   3,   3,   1,   0,   0,   0,   0 ], // level  9
  [   4,   3,   3,   3,   2,   0,   0,   0,   0 ], // level 10
  [   4,   3,   3,   3,   2,   1,   0,   0,   0 ], // level 11
  [   4,   3,   3,   3,   2,   1,   0,   0,   0 ], // level 12
  [   4,   3,   3,   3,   2,   1,   1,   0,   0 ], // level 13
  [   4,   3,   3,   3,   2,   1,   1,   0,   0 ], // level 14
  [   4,   3,   3,   3,   2,   1,   1,   1,   0 ], // level 15
  [   4,   3,   3,   3,   2,   1,   1,   1,   0 ], // level 16
  [   4,   3,   3,   3,   2,   1,   1,   1,   1 ], // level 17
  [   4,   3,   3,   3,   3,   1,   1,   1,   1 ], // level 18
  [   4,   3,   3,   3,   3,   2,   1,   1,   1 ], // level 19
  [   4,   3,   3,   3,   3,   2,   2,   1,   1 ], // level 20
];

// biome-ignore format: hand-aligned spell-slot table
/** Paladin / Ranger — half-caster (rounds down). Level 1 = no slots. */
const HALF_CASTER_SLOTS: number[][] = [
  //  L1  L2  L3  L4  L5  L6  L7  L8  L9
  [   0,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  1 — no slots
  [   2,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  2
  [   3,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  3
  [   3,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  4
  [   4,   2,   0,   0,   0,   0,   0,   0,   0 ], // level  5
  [   4,   2,   0,   0,   0,   0,   0,   0,   0 ], // level  6
  [   4,   3,   0,   0,   0,   0,   0,   0,   0 ], // level  7
  [   4,   3,   0,   0,   0,   0,   0,   0,   0 ], // level  8
  [   4,   3,   2,   0,   0,   0,   0,   0,   0 ], // level  9
  [   4,   3,   2,   0,   0,   0,   0,   0,   0 ], // level 10
  [   4,   3,   3,   0,   0,   0,   0,   0,   0 ], // level 11
  [   4,   3,   3,   0,   0,   0,   0,   0,   0 ], // level 12
  [   4,   3,   3,   1,   0,   0,   0,   0,   0 ], // level 13
  [   4,   3,   3,   1,   0,   0,   0,   0,   0 ], // level 14
  [   4,   3,   3,   2,   0,   0,   0,   0,   0 ], // level 15
  [   4,   3,   3,   2,   0,   0,   0,   0,   0 ], // level 16
  [   4,   3,   3,   3,   1,   0,   0,   0,   0 ], // level 17
  [   4,   3,   3,   3,   1,   0,   0,   0,   0 ], // level 18
  [   4,   3,   3,   3,   2,   0,   0,   0,   0 ], // level 19
  [   4,   3,   3,   3,   2,   0,   0,   0,   0 ], // level 20
];

// biome-ignore format: hand-aligned spell-slot table
/** Artificer — half-caster (rounds UP). Starts at level 1. Max 5th-level slots. */
const ARTIFICER_SLOTS: number[][] = [
  //  L1  L2  L3  L4  L5  L6  L7  L8  L9
  [   2,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  1
  [   2,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  2
  [   3,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  3
  [   3,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  4
  [   4,   2,   0,   0,   0,   0,   0,   0,   0 ], // level  5
  [   4,   2,   0,   0,   0,   0,   0,   0,   0 ], // level  6
  [   4,   3,   0,   0,   0,   0,   0,   0,   0 ], // level  7
  [   4,   3,   0,   0,   0,   0,   0,   0,   0 ], // level  8
  [   4,   3,   2,   0,   0,   0,   0,   0,   0 ], // level  9
  [   4,   3,   2,   0,   0,   0,   0,   0,   0 ], // level 10
  [   4,   3,   3,   0,   0,   0,   0,   0,   0 ], // level 11
  [   4,   3,   3,   0,   0,   0,   0,   0,   0 ], // level 12
  [   4,   3,   3,   1,   0,   0,   0,   0,   0 ], // level 13
  [   4,   3,   3,   1,   0,   0,   0,   0,   0 ], // level 14
  [   4,   3,   3,   2,   0,   0,   0,   0,   0 ], // level 15
  [   4,   3,   3,   2,   0,   0,   0,   0,   0 ], // level 16
  [   4,   3,   3,   3,   1,   0,   0,   0,   0 ], // level 17
  [   4,   3,   3,   3,   1,   0,   0,   0,   0 ], // level 18
  [   4,   3,   3,   3,   2,   0,   0,   0,   0 ], // level 19
  [   4,   3,   3,   3,   2,   0,   0,   0,   0 ], // level 20
];

// biome-ignore format: hand-aligned spell-slot table
/** Warlock Pact Magic — slot count and slot level per warlock level. */
const WARLOCK_PACT_TABLE: Array<{ max: number; level: number }> = [
  { max: 1, level: 1 }, // level  1
  { max: 2, level: 1 }, // level  2
  { max: 2, level: 2 }, // level  3
  { max: 2, level: 2 }, // level  4
  { max: 2, level: 3 }, // level  5
  { max: 2, level: 3 }, // level  6
  { max: 2, level: 4 }, // level  7
  { max: 2, level: 4 }, // level  8
  { max: 2, level: 5 }, // level  9
  { max: 2, level: 5 }, // level 10
  { max: 3, level: 5 }, // level 11
  { max: 3, level: 5 }, // level 12
  { max: 3, level: 5 }, // level 13
  { max: 3, level: 5 }, // level 14
  { max: 3, level: 5 }, // level 15
  { max: 3, level: 5 }, // level 16
  { max: 4, level: 5 }, // level 17
  { max: 4, level: 5 }, // level 18
  { max: 4, level: 5 }, // level 19
  { max: 4, level: 5 }, // level 20
];

// ---------------------------------------------------------------------------
// setActorSpellcasting — configure spell slots + casting ability.
// ---------------------------------------------------------------------------

export async function setActorSpellcasting(data: any): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error('setActorSpellcasting requires the dnd5e game system');
  }

  // 1. Resolve actor
  const actor = findActorByIdentifier(data.actorIdentifier);
  if (!actor) {
    throw new Error(`Actor not found: "${data.actorIdentifier}"`);
  }

  const cls = data.spellcastingClass as string;
  const lvl = data.spellcastingLevel as number;
  const ability = data.effectiveAbility as string;
  // The slot tables have exactly 20 rows; an out-of-range/non-integer level would index past
  // the end and throw an opaque "cannot read max of undefined". Fail with a clear message instead.
  if (!Number.isInteger(lvl) || lvl < 1 || lvl > 20) {
    throw new Error(`spellcastingLevel must be an integer 1-20 (got ${JSON.stringify(lvl)})`);
  }
  const idx = lvl - 1; // 0-based index into slot tables
  const warnings: string[] = [];

  // 2. Build flat updates object for a single actor.update() call
  const updates: Record<string, unknown> = {};

  // Spellcasting ability
  updates['system.attributes.spellcasting'] = ability;

  if (cls === 'warlock') {
    // ── Pact Magic ────────────────────────────────────────────────────────
    // All regular slots set to 0; pact slots from table
    for (let i = 1; i <= 9; i++) {
      updates[`system.spells.spell${i}.max`] = 0;
      updates[`system.spells.spell${i}.value`] = 0;
    }
    const pact = WARLOCK_PACT_TABLE[idx];
    updates['system.spells.pact.max'] = pact.max;
    updates['system.spells.pact.value'] = pact.max;
    updates['system.spells.pact.level'] = pact.level;
  } else {
    // ── Regular spell slots ───────────────────────────────────────────────
    let slotRow: number[];

    if (cls === 'artificer') {
      slotRow = ARTIFICER_SLOTS[idx];
    } else if (cls === 'paladin' || cls === 'ranger') {
      slotRow = HALF_CASTER_SLOTS[idx];
      if (lvl === 1) {
        warnings.push(`${cls} level 1 has no spell slots — use level 2+ to unlock spellcasting`);
      }
    } else {
      // Full casters: wizard, cleric, druid, sorcerer, bard
      slotRow = FULL_CASTER_SLOTS[idx];
    }

    for (let i = 1; i <= 9; i++) {
      const n = slotRow[i - 1];
      updates[`system.spells.spell${i}.max`] = n;
      updates[`system.spells.spell${i}.value`] = n;
    }
  }

  // 3. Single update call
  await actor.update(updates);

  // 4. Build response. NOTE: keyed `spell1..spell9` (+ `pact`) to mirror dnd5e's own
  // system.spells shape; the READ side (actors.ts extractDnd5eSpellSlots) uses `level1..level9`.
  // The two output contracts are intentionally different — see the note there.
  const slots: Record<string, unknown> = {};
  if (cls === 'warlock') {
    const pact = WARLOCK_PACT_TABLE[idx];
    slots.pact = { max: pact.max, level: pact.level };
  } else {
    const slotRow =
      cls === 'artificer'
        ? ARTIFICER_SLOTS[idx]
        : cls === 'paladin' || cls === 'ranger'
          ? HALF_CASTER_SLOTS[idx]
          : FULL_CASTER_SLOTS[idx];

    for (let i = 1; i <= 9; i++) {
      (slots as Record<string, number>)[`spell${i}`] = slotRow[i - 1];
    }
  }

  return {
    actor: { id: actor.id, name: actor.name },
    spellcasting: { ability, slots },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// addSpellsToActor — import named spells from compendium packs onto an actor.
// ---------------------------------------------------------------------------

export async function addSpellsToActor(data: any): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error('addSpellsToActor requires the dnd5e game system');
  }

  // 1. Resolve actor
  const actor = findActorByIdentifier(data.actorIdentifier);
  if (!actor) {
    throw new Error(`Actor not found: "${data.actorIdentifier}"`);
  }

  const spellNames: string[] = data.spellNames;
  const compendiumPacks: string[] = data.compendiumPacks ?? ['dnd5e.spells'];
  const warnings: string[] = [];

  // ── Phase A: deduplicate input (case-insensitive) ─────────────────────
  const seen = new Set<string>();
  const unique: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const name of spellNames) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ name, reason: 'duplicate in input' });
    } else {
      seen.add(key);
      unique.push(name);
    }
  }

  // ── Phase B: build pack index maps (once per pack) ────────────────────
  interface PackMap {
    packId: string;
    packLabel: string;
    nameMap: Map<string, string>; // lowercase name → _id
  }
  const packMaps: PackMap[] = [];

  for (const packId of compendiumPacks) {
    const pack = game.packs.get(packId);
    if (!pack) {
      warnings.push(`Compendium pack "${packId}" not found — skipped`);
      continue;
    }

    // Q6: type guard — Item packs only
    if (pack.metadata.type !== 'Item') {
      warnings.push(`Pack "${packId}" has type "${pack.metadata.type}", expected "Item" — skipped`);
      continue;
    }

    if (!pack.indexed) {
      await pack.getIndex({});
    }

    const nameMap = new Map<string, string>();
    for (const entry of pack.index.values() as IterableIterator<any>) {
      if (entry.name) {
        nameMap.set((entry.name as string).toLowerCase(), entry._id as string);
      }
    }

    packMaps.push({ packId, packLabel: pack.metadata.label as string, nameMap });
  }

  if (packMaps.length === 0) {
    throw new Error(
      'No valid compendium packs available — check the compendiumPacks parameter. ' +
        'Valid pack IDs for D&D 5e: "dnd5e.spells" (2014) or "dnd5e.spells24" (2024).'
    );
  }

  // ── Phase C: per-spell search + import ───────────────────────────────
  const added: Array<{ name: string; packId: string; packLabel: string; itemId: string }> = [];
  const notFound: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const name of unique) {
    const normalizedName = name.toLowerCase();

    // 1. Duplicate check on actor (only items of type 'spell')
    const existing = (actor.items as any[]).find(
      (i: any) => i.type === 'spell' && i.name?.toLowerCase() === normalizedName
    );
    if (existing) {
      skipped.push({ name, reason: 'already on actor' });
      continue;
    }

    // 2. Lookup across packs — first-pack-wins
    let found: { packId: string; packLabel: string; entryId: string } | null = null;
    for (const pm of packMaps) {
      const entryId = pm.nameMap.get(normalizedName);
      if (entryId) {
        found = { packId: pm.packId, packLabel: pm.packLabel, entryId };
        break;
      }
    }

    if (!found) {
      notFound.push(name);
      continue;
    }

    // 3. Fetch full document from compendium
    const pack = game.packs.get(found.packId);
    const document = await pack.getDocument(found.entryId);

    if (!document) {
      // Entry was in index but document is missing (shouldn't happen, defensive)
      notFound.push(name);
      warnings.push(
        `"${name}" found in index but document missing in pack "${found.packId}" — skipped`
      );
      continue;
    }

    // 4. Prepare data for embedding
    const spellData = document.toObject() as Record<string, unknown>;
    delete spellData._id; // Let Foundry assign a new local id; prevents id clash

    // 5. Embed individually — per-spell error isolation
    try {
      const [created] = (await actor.createEmbeddedDocuments('Item', [spellData])) as any[];
      added.push({
        name,
        packId: found.packId,
        packLabel: found.packLabel,
        itemId: created.id,
      });
    } catch (embedErr) {
      failed.push({
        name,
        error: embedErr instanceof Error ? embedErr.message : 'Unknown error',
      });
    }
  }

  // ── Phase D: return ───────────────────────────────────────────────────
  return {
    actor: { id: actor.id, name: actor.name },
    added,
    skipped,
    notFound,
    failed,
    warnings,
  };
}
