import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { ErrorHandler } from '../../utils/error-handler.js';
import { assertDnd5e } from '../../utils/system-detection.js';
import { formatImportReport } from '../../utils/format.js';
import { toInputSchema } from '../../utils/schema.js';
import { DEFAULT_FEATURE_PACKS } from '../../utils/compendium-sources.js';

// Single source of truth for this tool's input contract: the handler parses with this schema and
// getToolDefinitions() advertises toInputSchema(...) of the same schema, so the advertised and
// enforced contracts cannot drift. The add-feature tool composes this via getInputSchema().
const AddFeaturesFromCompendiumSchema = z.object({
  actorIdentifier: z
    .string()
    .min(1, 'actorIdentifier cannot be empty')
    .describe('Name or ID of the target actor (partial name match supported)'),
  featureNames: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe(
      'English feature names to import (exact match, case-insensitive). Maximum 50 per call.'
    ),
  compendiumPacks: z
    .array(z.string().min(1))
    .default([...DEFAULT_FEATURE_PACKS])
    .describe(
      'Premium-book pack IDs to search, in priority order (first match wins). ' +
        'Defaults to ["dnd-monster-manual.features", "dnd-players-handbook.classes"] — MM monster ' +
        'features, then PHB class features (the classes pack also holds the individual feature feats). ' +
        'SOURCE ONLY from the premium MM/PHB/DMG books — NEVER the dnd5e.* SRD packs (design.md §2.3). ' +
        'CAVEAT: a class/racial feature copied onto an NPC may carry an unresolved @scale.* damage/' +
        'uses formula (its ScaleValue comes from the PC class/species advancement, absent on an NPC) — ' +
        'verify and replace the formula with an explicit value after import.'
    ),
});

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface DnD5eFeaturesFromCompendiumToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class DnD5eFeaturesFromCompendiumTools {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: DnD5eFeaturesFromCompendiumToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eFeaturesFromCompendiumTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  /** This tool's JSON-Schema. Exposed so the add-feature tool can compose the 'compendium-features' mode params. */
  getInputSchema(): Record<string, unknown> {
    return this.getToolDefinitions()[0].inputSchema as Record<string, unknown>;
  }

  getToolDefinitions() {
    return [
      {
        name: 'add-features-from-compendium',
        description:
          '[D&D 5e only] Import class features and monster features from an official compendium ' +
          'pack onto an actor (NPC or PC). Each feature is looked up by EXACT name ' +
          '(case-insensitive) and embedded onto the actor as-is from the compendium data.\n\n' +
          'USE THIS TOOL when you need to:\n' +
          '  - Add monster features by name (e.g. "Pack Tactics", "Nimble Escape", "Multiattack")\n' +
          '  - Add class features to an NPC caster (e.g. "Spellcasting", "Action Surge", "Font of Magic")\n' +
          '  - Mix features from monster and class compendiums on a custom NPC\n' +
          '  - Example: "add Spellcasting, Font of Magic and Metamagic to this sorcerer NPC"\n\n' +
          '⚠️ IMPORTANT — feature names must be in English: the compendium uses English names. ' +
          'Translate BEFORE calling if the user provided names in another language.\n\n' +
          'compendiumPacks controls which premium-book pack(s) to search (priority order, first match wins):\n' +
          '  - Default ["dnd-monster-manual.features", "dnd-players-handbook.classes"] → MM monster ' +
          'features, then PHB class features\n' +
          '  - SOURCE ONLY from the premium MM/PHB/DMG books — NEVER the dnd5e.* SRD packs (design.md §2.3)\n\n' +
          'NOTE: CLASS features ARE importable — the individual feature feats live in the classes ' +
          'pack (dnd-players-handbook.classes) alongside the class items. But a ' +
          'class/racial feature copied onto an NPC may carry an unresolved @scale.* formula (its ' +
          'ScaleValue comes from the absent PC class/species advancement) — verify + fix it after import.\n\n' +
          'DO NOT USE THIS TOOL for:\n' +
          '  - Importing spell items → use add-feature with featureType "spells" instead\n' +
          '  - Setting up spellcasting class or spell slots → use add-feature with featureType "spellcasting"\n' +
          '  - Creating custom/homebrew features from scratch → compendium-only, no homebrew\n' +
          '  - Non-dnd5e systems → this tool is dnd5e-exclusive\n\n' +
          'Returns a detailed report: features added ✅, skipped (already on actor) ⏭️, ' +
          'not found in compendium ❌, and failed during import ⚠️.\n' +
          'Use list-actors or get-actor first to find the actorIdentifier.',
        inputSchema: toInputSchema(AddFeaturesFromCompendiumSchema),
      },
    ];
  }

  async handleAddFeaturesFromCompendium(args: any): Promise<any> {
    const parsed = AddFeaturesFromCompendiumSchema.parse(args);

    this.logger.info('Adding features to D&D 5e actor from compendium', {
      actorIdentifier: parsed.actorIdentifier,
      featureCount: parsed.featureNames.length,
      packs: parsed.compendiumPacks,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'add-features-from-compendium');

      const result = await this.foundry.call('addFeaturesFromCompendium', parsed);

      this.logger.info('Features import complete', {
        actorId: result.actor?.id,
        added: result.added?.length,
        skipped: result.skipped?.length,
        notFound: result.notFound?.length,
        failed: result.failed?.length,
      });

      return formatImportReport(result, parsed.featureNames.length, 'Features');
    } catch (error) {
      this.errorHandler.handleToolError(error, 'add-features-from-compendium', 'feature import');
    }
  }
}
