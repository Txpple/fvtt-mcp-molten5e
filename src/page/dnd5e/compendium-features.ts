// dnd5e WRITE — add named features from official compendium pack(s) onto an actor.
// Resolves featureNames against pack indices (first-pack-wins), fetches the full
// source documents, and createEmbeddedDocuments('Item', ...) onto the resolved actor.
// Faithful port of data-access.ts addFeaturesFromCompendium (oracle 6603-6793, v0.9.3).

import { resolveActorFuzzy as findActorByIdentifier } from '../_shared.js';

// ---------------------------------------------------------------------------
// Add features from compendium packs to an actor
// ---------------------------------------------------------------------------
export async function addFeaturesFromCompendium(args: {
  actorIdentifier: string;
  featureNames: string[];
  compendiumPacks?: string[];
}): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error('addFeaturesFromCompendium requires the dnd5e game system');
  }

  // 1. Resolve actor
  const actor = findActorByIdentifier(args.actorIdentifier);
  if (!actor) {
    throw new Error(`Actor not found: "${args.actorIdentifier}"`);
  }

  const featureNames: string[] = args.featureNames;
  const compendiumPacks: string[] = args.compendiumPacks ?? [
    'dnd5e.monsterfeatures',
    'dnd5e.classfeatures',
  ];
  const warnings: string[] = [];

  // ── Phase A: deduplicate input (case-insensitive) ─────────────────────
  const seen = new Set<string>();
  const unique: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const name of featureNames) {
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

    // Type guard — Item packs only
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
        'Valid pack IDs for D&D 5e: "dnd5e.monsterfeatures" or "dnd5e.classfeatures" (2014), ' +
        '"dnd5e.monsterfeatures24" (2024 monster features). ' +
        'Note: 2024 class features are embedded in class items and cannot be imported with this tool.'
    );
  }

  // ── Phase C: per-feature search + import ─────────────────────────────
  const added: Array<{ name: string; packId: string; packLabel: string; itemId: string }> = [];
  const notFound: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const name of unique) {
    const normalizedName = name.toLowerCase();

    // 1. Duplicate check on actor — name-only, any item type
    //    (feature names are semantically unique on an actor regardless of stored type)
    const existing = (actor.items as any[]).find(
      (i: any) => i.name?.toLowerCase() === normalizedName
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
    const featureData = document.toObject() as Record<string, unknown>;
    delete featureData._id; // Let Foundry assign a new local id; prevents id clash

    // 5. Embed individually — per-feature error isolation
    try {
      const [created] = (await actor.createEmbeddedDocuments('Item', [featureData])) as any[];
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
