import { z } from 'zod';
import { toInputSchema } from '../../utils/schema.js';
import { AddToActorItemsSchema } from '../items.js';
import { AddFeatureSchema } from './add-feature.js';
import { AddFeaturesFromCompendiumSchema } from './features.js';

/**
 * The unified `add-feature` tool definition.
 *
 * add-feature is the single MCP entry point for adding content to an existing actor; the dispatch
 * (registry.ts) routes its `mode` to one of three handlers: author a feature from scratch, import
 * named features from a compendium, or attach world items. Each mode's parameters ARE the zod schema
 * the owning handler parses with — AddFeatureSchema (add-feature.ts), AddFeaturesFromCompendiumSchema
 * (features.ts), and AddToActorItemsSchema (items.ts) — composed here into ONE wrapper schema and
 * advertised via toInputSchema(). So the model gets each mode's complete parameter guidance without
 * those handlers being exposed as standalone MCP tools, and there is no hand-written JSON schema: the
 * advertised contract is generated from the same zod the handlers enforce. (Historically named
 * `grant-to-actor`; renamed to match how the skills/docs refer to it. The filename is kept to avoid
 * churn.)
 *
 * NOTE on actorIdentifier: it is required at the top level (the dispatch merges it into each mode's
 * args). The `feature`/`compendiumFeatures` sub-schemas also carry their own actorIdentifier — a
 * harmless redundancy the descriptions paper over, preserved from the prior hand-written schema.
 */
const AddFeatureWrapperSchema = z.object({
  actorIdentifier: z.string().min(1).describe('Target actor (exact name or ID).'),
  mode: z
    .enum(['compendium-features', 'feature', 'items'])
    .describe(
      "Which granting path to use. 'compendium-features' (preferred) imports named features from a " +
        "pack; 'feature' authors one from scratch; 'items' attaches world items."
    ),
  feature: AddFeatureSchema.optional().describe(
    "Parameters when mode='feature' — author a feature/attack/spellcasting/spells. Select " +
      'feature.featureType; actorIdentifier is taken from the top level.'
  ),
  compendiumFeatures: AddFeaturesFromCompendiumSchema.optional().describe(
    "Parameters when mode='compendium-features' — import named features from a compendium pack. " +
      'actorIdentifier is taken from the top level.'
  ),
  items: AddToActorItemsSchema.optional().describe(
    "World items to attach when mode='items'. Each needs a name and a valid dnd5e item type (e.g. " +
      "'weapon', 'equipment', 'consumable', 'feat'); pass system-specific data via system."
  ),
});

export function buildAddFeatureTool() {
  return {
    name: 'add-feature',
    description:
      'Add a feature/spell/ability to an existing actor (NPC or PC). Set mode:\n' +
      "• 'compendium-features' — import named class/monster features from an official compendium " +
      '(PREFERRED for official content, e.g. Pack Tactics, Multiattack, Spellcasting). Params under compendiumFeatures.\n' +
      "• 'feature' — author a feature/attack/spellcasting setup/spells from scratch (use only when not " +
      'available in a compendium). Params under feature (select feature.featureType).\n' +
      "• 'items' — attach world items by raw data. For real GEAR prefer import-item (copy from a " +
      'compendium, keeps art+stats) or add-item (author); use this mode only for free-form item data. Params under items[].\n' +
      'actorIdentifier (exact name or ID) is always required — find it with list-actors / get-actor.',
    inputSchema: toInputSchema(AddFeatureWrapperSchema),
  };
}
