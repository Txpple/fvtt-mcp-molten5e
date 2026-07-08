import { describe, it, expect } from 'vitest';
import { CombatTrackerTools } from './combat-tracker.js';
import { makeFoundry, makeLogger } from './test-helpers.js';

const CONFIG_RESPONSE = {
  success: true,
  config: {
    resource: '',
    skipDefeated: false,
    turnMarker: {
      enabled: true,
      animation: 'spin',
      src: 'worlds/w/assets/ui/turn-marker-custom-02.png',
      disposition: false,
    },
  },
  animations: [
    { value: 'spin', label: 'Spin' },
    { value: 'spinPulse', label: 'Spin Pulse' },
    { value: 'pulse', label: 'Pulse' },
  ],
  fallbackMarker: 'canvas/tokens/turn-marker-square-circle-orange.webp',
};

function build(response: any = CONFIG_RESPONSE) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new CombatTrackerTools({ foundry, logger: makeLogger() });
  return { tools, calls };
}

describe('configure-combat-tracker', () => {
  it('no arguments → reads the current config with the valid animation ids', async () => {
    const { tools, calls } = build();
    const out = await tools.handleConfigureCombatTracker({});
    expect(calls[0][0]).toBe('configureCombatTracker');
    expect(calls[0][1]).toEqual({});
    expect(out).toContain('**Combat tracker config**');
    expect(out).toContain('enabled · animation `spin`');
    expect(out).toContain('`worlds/w/assets/ui/turn-marker-custom-02.png`');
    expect(out).toContain(
      '**Valid animations:** `spin` (Spin), `spinPulse` (Spin Pulse), `pulse` (Pulse)'
    );
  });

  it('formats an update with previous → new per changed field', async () => {
    const { tools, calls } = build({
      ...CONFIG_RESPONSE,
      applied: [
        {
          field: 'turnMarker.src',
          previous: 'worlds/w/assets/ui/turn-marker-custom-01.png',
          next: 'worlds/w/assets/ui/turn-marker-custom-02.png',
        },
      ],
    });
    const out = await tools.handleConfigureCombatTracker({
      turnMarker: { src: 'worlds/w/assets/ui/turn-marker-custom-02.png' },
    });
    expect(calls[0][1]).toEqual({
      turnMarker: { src: 'worlds/w/assets/ui/turn-marker-custom-02.png' },
    });
    expect(out).toContain('✅ Combat tracker updated (1 field(s)):');
    expect(out).toContain(
      '- turnMarker.src: `worlds/w/assets/ui/turn-marker-custom-01.png` → `worlds/w/assets/ui/turn-marker-custom-02.png`'
    );
    expect(out).toContain('**Now:**');
  });

  it('requested-but-identical values read back as a clean no-op', async () => {
    const { tools } = build(); // page returns no `applied` array on a no-op
    const out = await tools.handleConfigureCombatTracker({ skipDefeated: false });
    expect(out).toContain('✅ Already configured — no changes needed.');
  });

  it('renders "" transitions readably (reset to stock marker)', async () => {
    const { tools } = build({
      ...CONFIG_RESPONSE,
      applied: [{ field: 'turnMarker.src', previous: 'worlds/w/old.png', next: '' }],
      config: {
        ...CONFIG_RESPONSE.config,
        turnMarker: { ...CONFIG_RESPONSE.config.turnMarker, src: '' },
      },
    });
    const out = await tools.handleConfigureCombatTracker({ turnMarker: { src: '' } });
    expect(out).toContain('- turnMarker.src: `worlds/w/old.png` → ""');
    expect(out).toContain('(stock — `canvas/tokens/turn-marker-square-circle-orange.webp`)');
  });

  it('rejects a non-boolean skipDefeated (zod)', async () => {
    const { tools } = build();
    await expect(tools.handleConfigureCombatTracker({ skipDefeated: 'yes' })).rejects.toThrow();
  });

  it('rejects an empty-string animation (zod min length)', async () => {
    const { tools } = build();
    await expect(
      tools.handleConfigureCombatTracker({ turnMarker: { animation: '' } })
    ).rejects.toThrow();
  });
});
