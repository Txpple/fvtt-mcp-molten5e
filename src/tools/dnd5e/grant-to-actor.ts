/**
 * The unified `add-feature` tool definition.
 *
 * add-feature is the single MCP entry point for adding content to an existing actor; the dispatch
 * (registry.ts) routes its `mode` to one of three handlers: author a feature from scratch, import
 * named features from a compendium, or attach world items. The 'feature' and 'compendium-features'
 * mode params ARE the full input schemas of DnD5eAddFeatureTool / DnD5eFeaturesFromCompendiumTools —
 * passed in here via each tool's getInputSchema() and nested under `feature` / `compendiumFeatures` —
 * so the model gets each mode's complete parameter guidance without those two tools being exposed as
 * standalone MCP tools. (Historically named `grant-to-actor`; renamed to match how the skills/docs
 * refer to it. The filename is kept to avoid churn.)
 */
export function buildAddFeatureTool(
  featureModeSchema: Record<string, unknown>,
  compendiumFeatureModeSchema: Record<string, unknown>
) {
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
    inputSchema: {
      type: 'object',
      properties: {
        actorIdentifier: {
          type: 'string',
          description: 'Target actor (exact name or ID).',
        },
        mode: {
          type: 'string',
          enum: ['compendium-features', 'feature', 'items'],
          description:
            "Which granting path to use. 'compendium-features' (preferred) imports named features " +
            "from a pack; 'feature' authors one from scratch; 'items' attaches world items.",
        },
        feature: {
          ...featureModeSchema,
          description:
            "Parameters when mode='feature' — author a feature/attack/spellcasting/spells. " +
            'Select feature.featureType; actorIdentifier is taken from the top level.',
        },
        compendiumFeatures: {
          ...compendiumFeatureModeSchema,
          description:
            "Parameters when mode='compendium-features' — import named features from a compendium " +
            'pack. actorIdentifier is taken from the top level.',
        },
        items: {
          type: 'array',
          description:
            "World items to attach when mode='items'. Each needs a name and a valid dnd5e item type " +
            "(e.g. 'weapon', 'equipment', 'consumable', 'feat'); pass system-specific data via system.",
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Display name of the item' },
              type: { type: 'string', description: 'dnd5e item type (weapon, equipment, …)' },
              img: { type: 'string', description: 'Optional icon path' },
              system: { type: 'object', additionalProperties: true },
            },
            required: ['name', 'type'],
          },
        },
      },
      required: ['actorIdentifier', 'mode'],
    },
  };
}
