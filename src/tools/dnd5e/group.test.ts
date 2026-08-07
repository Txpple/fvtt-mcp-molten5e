/**
 * Unit tests for DnD5eGroupTools — schema validation + response formatting over a mocked
 * bridge. The live behavior (Actor.create, system.addMember/removeMember, the primaryParty
 * setting) is covered by scripts/verify-group-tooling.mjs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5eGroupTools } from './group.js';
import { makeFoundry, makeLogger } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

// detectGameSystem caches module-wide; clear it and answer getWorldInfo with the dnd5e marker.
beforeEach(() => clearSystemCache());

function makeTool(response: any = {}) {
  const { foundry, calls } = makeFoundry((name: string) =>
    name === 'getWorldInfo' ? { system: 'dnd5e' } : response
  );
  const tool = new DnD5eGroupTools({ foundry, logger: makeLogger() });
  return { tool, calls };
}

const CREATED = {
  success: true,
  group: {
    id: 'G1',
    name: 'The Party',
    img: 'systems/dnd5e/icons/svg/group.svg',
    folderId: null,
    defaultOwnership: 'OWNER',
  },
  members: [
    { id: 'A1', name: 'Gren Greenmantle', type: 'character' },
    { id: 'A2', name: 'Jetten Elisedil', type: 'character' },
  ],
};

describe('tool definitions', () => {
  it('advertises all four tools with generated inputSchemas', () => {
    const { tool } = makeTool();
    const defs = tool.getToolDefinitions();
    expect(defs.map(d => d.name)).toEqual([
      'create-group',
      'manage-group-members',
      'get-group',
      'set-primary-party',
    ]);
    for (const def of defs) {
      expect(def.inputSchema).toBeTruthy();
      expect(Array.isArray((def.inputSchema as any).required)).toBe(true);
    }
    expect((defs[0].inputSchema as any).required).toContain('name');
    expect((defs[1].inputSchema as any).required).toContain('groupIdentifier');
    expect((defs[2].inputSchema as any).required).toContain('groupIdentifier');
    expect((defs[3].inputSchema as any).required).toEqual([]);
  });
});

describe('create-group', () => {
  it('forwards the parsed args and formats the created group', async () => {
    const { tool, calls } = makeTool(CREATED);
    const out = await tool.handleCreateGroup({
      name: 'The Party',
      members: ['Gren', 'Jetten'],
      defaultOwnership: 'owner',
    });
    const [name, args] = calls.find(c => c[0] === 'createGroupActor')!;
    expect(name).toBe('createGroupActor');
    expect(args.name).toBe('The Party');
    expect(args.members).toEqual(['Gren', 'Jetten']);
    expect(args.defaultOwnership).toBe('owner');
    expect(args.makePrimaryParty).toBe(false);
    expect(out).toContain('✅ Created group **The Party** (`G1`)');
    expect(out).toContain('**Members:** Gren Greenmantle, Jetten Elisedil');
    expect(out).toContain('**Default ownership:** OWNER');
  });

  it('reports a primary-party crowning with the previous holder', async () => {
    const { tool } = makeTool({
      ...CREATED,
      primaryParty: { previous: { id: 'G0', name: 'Old Party' } },
    });
    const out = await tool.handleCreateGroup({ name: 'The Party', makePrimaryParty: true });
    expect(out).toContain('**Primary party:** now this group (was Old Party)');
  });

  it('surfaces page warnings (dropped 404 img)', async () => {
    const { tool } = makeTool({ ...CREATED, warnings: ['Supplied img "x.png" was not found'] });
    const out = await tool.handleCreateGroup({ name: 'The Party' });
    expect(out).toContain('⚠️ Supplied img "x.png" was not found');
  });

  it('rejects a negative coin amount (zod)', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleCreateGroup({ name: 'X', currency: { gp: -5 } })
    ).rejects.toThrow();
  });

  it('rejects a missing name (zod)', async () => {
    const { tool } = makeTool();
    await expect(tool.handleCreateGroup({})).rejects.toThrow();
  });
});

describe('manage-group-members', () => {
  it('formats added / removed / skipped and the final roster', async () => {
    const { tool, calls } = makeTool({
      success: true,
      group: { id: 'G1', name: 'The Party' },
      added: [{ id: 'A3', name: 'Wolf', type: 'npc' }],
      removed: [{ id: 'A1', name: 'Gren Greenmantle' }],
      skipped: [{ identifier: 'Nobody', reason: 'not-found' }],
      members: [
        { id: 'A2', name: 'Jetten Elisedil', type: 'character' },
        { id: 'A3', name: 'Wolf', type: 'npc' },
      ],
    });
    const out = await tool.handleManageGroupMembers({
      groupIdentifier: 'The Party',
      add: ['Wolf', 'Nobody'],
      remove: ['Gren'],
    });
    expect(calls.find(c => c[0] === 'manageGroupMembers')![1].groupIdentifier).toBe('The Party');
    expect(out).toContain('**Added:** Wolf');
    expect(out).toContain('**Removed:** Gren Greenmantle');
    expect(out).toContain('⚠️ Skipped "Nobody" — not-found');
    expect(out).toContain('**Roster now:** Jetten Elisedil, Wolf');
  });

  it('renders a dangling removal by id when the actor no longer exists', async () => {
    const { tool } = makeTool({
      success: true,
      group: { id: 'G1', name: 'The Party' },
      added: [],
      removed: [{ id: 'DEAD1', name: null }],
      skipped: [],
      members: [],
    });
    const out = await tool.handleManageGroupMembers({
      groupIdentifier: 'The Party',
      remove: ['DEAD1'],
    });
    expect(out).toContain('**Removed:** `DEAD1`');
    expect(out).toContain('**Roster now:** (none)');
  });

  it('rejects a call with neither add nor remove (zod refine)', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleManageGroupMembers({ groupIdentifier: 'The Party' })
    ).rejects.toThrow(/at least one actor/);
  });
});

describe('get-group', () => {
  it('passes the read through untouched (structured contract)', async () => {
    const info = {
      id: 'G1',
      name: 'The Party',
      isPrimaryParty: true,
      members: [{ id: 'A1', name: 'Gren Greenmantle', type: 'character' }],
      currency: { pp: 0, gp: 25, ep: 0, sp: 10, cp: 0 },
      inventory: [{ id: 'I1', name: 'Rope', type: 'loot', quantity: 2 }],
      ownership: { default: 'OWNER', users: [] },
    };
    const { tool } = makeTool(info);
    const out = await tool.handleGetGroup({ groupIdentifier: 'The Party' });
    expect(out).toEqual(info);
  });
});

describe('set-primary-party', () => {
  it('no arguments → reports the current primary party', async () => {
    const { tool, calls } = makeTool({
      success: true,
      changed: false,
      current: { id: 'G1', name: 'The Party' },
    });
    const out = await tool.handleSetPrimaryParty({});
    expect(calls.find(c => c[0] === 'configurePrimaryParty')![1].clear).toBe(false);
    expect(out).toBe('**Primary party:** **The Party** (`G1`)');
  });

  it('a change echoes previous → current', async () => {
    const { tool } = makeTool({
      success: true,
      changed: true,
      previous: null,
      current: { id: 'G1', name: 'The Party' },
    });
    const out = await tool.handleSetPrimaryParty({ groupIdentifier: 'The Party' });
    expect(out).toBe('✅ Primary party: (none) → **The Party** (`G1`)');
  });

  it('re-crowning the current holder reads as already set', async () => {
    const { tool } = makeTool({
      success: true,
      changed: false,
      current: { id: 'G1', name: 'The Party' },
    });
    const out = await tool.handleSetPrimaryParty({ groupIdentifier: 'The Party' });
    expect(out).toBe('✅ Already set — primary party is **The Party** (`G1`).');
  });

  it('clear renders the unset transition', async () => {
    const { tool } = makeTool({
      success: true,
      changed: true,
      previous: { id: 'G1', name: 'The Party' },
      current: null,
    });
    const out = await tool.handleSetPrimaryParty({ clear: true });
    expect(out).toBe('✅ Primary party: **The Party** (`G1`) → (none)');
  });

  it('rejects groupIdentifier + clear together (zod refine)', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleSetPrimaryParty({ groupIdentifier: 'The Party', clear: true })
    ).rejects.toThrow(/OR clear/);
  });
});
