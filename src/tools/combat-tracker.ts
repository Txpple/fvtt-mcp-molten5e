import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * Combat tracker configuration — the world's core.combatTrackerConfig setting.
 * - configure-combat-tracker: one tool, read AND write. No arguments → report the current
 *   config plus the valid turn-marker animation ids; any argument → apply it and echo
 *   previous → new per changed field.
 *
 * Deliberately narrow: this is the repo's first game-SETTING writer, and it covers exactly one
 * setting with a typed contract (see src/page/combat-tracker.ts for why there is no generic
 * set-world-setting).
 */

const ConfigureCombatTrackerSchema = z.object({
  resource: z
    .string()
    .optional()
    .describe(
      'Actor system attribute shown beside each combatant in the tracker, e.g. "attributes.hp". ' +
        'Pass "" to track nothing.'
    ),
  skipDefeated: z
    .boolean()
    .optional()
    .describe('Skip defeated combatants when advancing the turn order.'),
  turnMarker: z
    .object({
      enabled: z
        .boolean()
        .optional()
        .describe("Show the marker under the active combatant's token."),
      animation: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Animation id, validated against the live registry ' +
            '(CONFIG.Combat.settings.turnMarkerAnimations — modules can add more). ' +
            'Core v14 ships "spin", "spinPulse", "pulse".'
        ),
      src: z
        .string()
        .optional()
        .describe(
          'Marker image/video path under Data/, e.g. "worlds/<world>/assets/ui/marker.png". ' +
            'A path that does not resolve on the server is REJECTED (nothing is written) — ' +
            'upload-asset first. Pass "" to reset to Foundry\'s stock marker.'
        ),
      disposition: z
        .boolean()
        .optional()
        .describe("Tint the marker by the combatant's token disposition."),
    })
    .optional()
    .describe('Turn-marker appearance — the animated ring under the active combatant.'),
});

export interface CombatTrackerToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class CombatTrackerTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: CombatTrackerToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'CombatTrackerTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'configure-combat-tracker',
        description:
          "Read or configure the combat tracker (the world's core.combatTrackerConfig setting): " +
          'the custom TURN MARKER shown under the active combatant (enabled / animation / image ' +
          'src / disposition tint), the tracked resource, and skip-defeated. Call with NO ' +
          'arguments to read the current config and the valid animation ids. Changed fields echo ' +
          'previous → new; re-applying the current value is a clean no-op. GM-only.',
        inputSchema: toInputSchema(ConfigureCombatTrackerSchema),
      },
    ];
  }

  async handleConfigureCombatTracker(args: any): Promise<string> {
    const parsed = ConfigureCombatTrackerSchema.parse(args ?? {});
    const r = await this.foundry.call('configureCombatTracker', parsed);
    const cfg = r?.config ?? {};
    const marker = cfg.turnMarker ?? {};
    const animations = Array.isArray(r?.animations) ? r.animations : [];
    const animationList = animations
      .map((a: any) => `\`${a.value}\`${a.label && a.label !== a.value ? ` (${a.label})` : ''}`)
      .join(', ');

    const configLines = [
      `- **Turn marker:** ${marker.enabled ? 'enabled' : 'disabled'} · animation \`${marker.animation}\` · disposition tint ${marker.disposition ? 'on' : 'off'}`,
      `- **Marker image:** ${marker.src ? `\`${marker.src}\`` : `(stock${r?.fallbackMarker ? ` — \`${r.fallbackMarker}\`` : ''})`}`,
      `- **Tracked resource:** ${cfg.resource ? `\`${cfg.resource}\`` : '(none)'}`,
      `- **Skip defeated:** ${cfg.skipDefeated ? 'yes' : 'no'}`,
    ];

    const applied = Array.isArray(r?.applied) ? r.applied : null;
    if (!applied) {
      const requested = Object.keys(parsed).length > 0;
      const header = requested
        ? '✅ Already configured — no changes needed.'
        : '**Combat tracker config**';
      return [
        header,
        ...configLines,
        ...(animationList ? [`- **Valid animations:** ${animationList}`] : []),
      ].join('\n');
    }

    const fmt = (v: unknown) => (v === '' ? '""' : `\`${v}\``);
    return [
      `✅ Combat tracker updated (${applied.length} field(s)):`,
      ...applied.map((c: any) => `- ${c.field}: ${fmt(c.previous)} → ${fmt(c.next)}`),
      '',
      '**Now:**',
      ...configLines,
    ].join('\n');
  }
}
