/**
 * Unit tests for TableTools (create-rolltable, list-rolltables,
 * update-rolltable, roll-on-table, delete-rolltable).
 *
 * Covers the two things these handlers own before the bridge is reached:
 *   1. zod input validation — required fields, non-empty strings/arrays,
 *      result-entry shape are enforced (bad input throws, never hits the bridge).
 *   2. response formatting — the human-readable string built from the bridge
 *      result, including notFound / not-rolled branches.
 */

import { describe, it, expect } from 'vitest';
import { TableTools } from './tables.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new TableTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('TableTools.getToolDefinitions', () => {
  it('exposes exactly the seven rolltable tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual([
      'create-rolltable',
      'delete-rolltable',
      'get-rolltable',
      'import-rolltable',
      'list-rolltables',
      'roll-on-table',
      'update-rolltable',
    ]);
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('handleCreateRollTable', () => {
  it('forwards a valid request and formats the result', async () => {
    const { tools, calls } = build({
      tableName: 'Loot',
      tableId: 't1',
      formula: '1d6',
      resultCount: 3,
    });
    const out = await tools.handleCreateRollTable({
      name: 'Loot',
      results: [{ text: 'Gold' }, { text: 'Sword' }, { text: 'Gem' }],
    });
    expect(calls[0][0]).toBe('createRollTable');
    expect(calls[0][1]).toMatchObject({
      name: 'Loot',
      results: [{ text: 'Gold' }, { text: 'Sword' }, { text: 'Gem' }],
    });
    expect(out).toBe('Created roll table "Loot" (t1) — formula 1d6, 3 result(s).');
  });

  it('passes optional fields and weighted/ranged results through', async () => {
    const { tools, calls } = build({
      tableName: 'Enc',
      tableId: 'e1',
      formula: '1d20',
      resultCount: 1,
    });
    await tools.handleCreateRollTable({
      name: 'Enc',
      description: 'encounters',
      formula: '1d20',
      replacement: false,
      displayRoll: false,
      folderName: 'Tables',
      results: [{ text: 'Goblin', weight: 2, range: [1, 10] }],
    });
    expect(calls[0][1]).toMatchObject({
      description: 'encounters',
      formula: '1d20',
      replacement: false,
      displayRoll: false,
      folderName: 'Tables',
      results: [{ text: 'Goblin', weight: 2, range: [1, 10] }],
    });
  });

  it('rejects a missing name', async () => {
    const { tools } = build();
    await expect(tools.handleCreateRollTable({ results: [{ text: 'x' }] })).rejects.toThrow();
  });

  it('rejects an empty name', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateRollTable({ name: '', results: [{ text: 'x' }] })
    ).rejects.toThrow();
  });

  it('rejects an empty results array', async () => {
    const { tools } = build();
    await expect(tools.handleCreateRollTable({ name: 'X', results: [] })).rejects.toThrow();
  });

  it('rejects a result with empty text', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateRollTable({ name: 'X', results: [{ text: '' }] })
    ).rejects.toThrow();
  });

  it('rejects a result with neither text nor uuid', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateRollTable({ name: 'X', results: [{ weight: 2 }] })
    ).rejects.toThrow();
  });

  it('forwards uuid-referencing results (compendium loot links)', async () => {
    const { tools, calls } = build({
      tableName: 'Hoard',
      tableId: 'h1',
      formula: '1d2',
      resultCount: 2,
    });
    await tools.handleCreateRollTable({
      name: 'Hoard',
      results: [
        {
          uuid: 'Compendium.dnd-dungeon-masters-guide.equipment.Item.dmgRubyOfTheWarM',
          name: 'Ruby of the War Mage',
        },
        {
          text: 'A pouch holding {{link}} and 2d6 gp',
          uuid: 'Compendium.dnd-players-handbook.equipment.Item.x',
        },
      ],
    });
    expect(calls[0][0]).toBe('createRollTable');
    expect(calls[0][1].results[0]).toMatchObject({
      uuid: 'Compendium.dnd-dungeon-masters-guide.equipment.Item.dmgRubyOfTheWarM',
      name: 'Ruby of the War Mage',
    });
    expect(calls[0][1].results[1]).toMatchObject({
      text: 'A pouch holding {{link}} and 2d6 gp',
      uuid: 'Compendium.dnd-players-handbook.equipment.Item.x',
    });
  });
});

describe('handleImportRollTable', () => {
  it('forwards a valid import and formats the result', async () => {
    const { tools, calls } = build({
      tableName: 'Arcana - Common',
      tableId: 'imp1',
      formula: '1d100',
      resultCount: 50,
    });
    const out = await tools.handleImportRollTable({
      packId: 'dnd-dungeon-masters-guide.tables',
      itemId: 'dmgArcanaCommon0',
      folderName: 'DMG Treasure',
    });
    expect(calls[0][0]).toBe('importRollTable');
    expect(calls[0][1]).toMatchObject({
      packId: 'dnd-dungeon-masters-guide.tables',
      itemId: 'dmgArcanaCommon0',
      folderName: 'DMG Treasure',
    });
    expect(out).toBe(
      'Imported roll table "Arcana - Common" (imp1) — formula 1d100, 50 result(s). Roll it with roll-on-table.'
    );
  });

  it('rejects a missing packId', async () => {
    const { tools } = build();
    await expect(tools.handleImportRollTable({ itemId: 'x' })).rejects.toThrow();
  });

  it('rejects a missing itemId', async () => {
    const { tools } = build();
    await expect(
      tools.handleImportRollTable({ packId: 'dnd-dungeon-masters-guide.tables' })
    ).rejects.toThrow();
  });
});

describe('handleListRollTables', () => {
  it('formats a populated list', async () => {
    const { tools, calls } = build([
      { name: 'Loot', id: 't1', formula: '1d6', resultCount: 3 },
      { name: 'Enc', id: 'e1', formula: '1d20', resultCount: 5 },
    ]);
    const out = await tools.handleListRollTables({});
    expect(calls[0][0]).toBe('listRollTables');
    expect(out).toBe(
      'Roll tables (2):\n' +
        '  - "Loot" (t1) — 1d6, 3 result(s)\n' +
        '  - "Enc" (e1) — 1d20, 5 result(s)'
    );
  });

  it('reports when no tables exist', async () => {
    const { tools } = build([]);
    const out = await tools.handleListRollTables({});
    expect(out).toBe('No roll tables found.');
  });

  it('reports when the bridge returns null', async () => {
    const { tools } = build(null);
    const out = await tools.handleListRollTables({});
    expect(out).toBe('No roll tables found.');
  });
});

describe('handleUpdateRollTable', () => {
  it('forwards a valid update and formats the result', async () => {
    const { tools, calls } = build({
      tableName: 'Loot v2',
      tableId: 't1',
      resultCount: 4,
    });
    const out = await tools.handleUpdateRollTable({
      identifier: 't1',
      name: 'Loot v2',
    });
    expect(calls[0][0]).toBe('updateRollTable');
    expect(calls[0][1]).toMatchObject({ identifier: 't1', name: 'Loot v2' });
    expect(out).toBe('Updated roll table "Loot v2" (t1) — 4 result(s).');
  });

  it('reports not-found when the bridge says updated:false', async () => {
    const { tools } = build({ updated: false, notFound: 'Ghost Table' });
    const out = await tools.handleUpdateRollTable({ identifier: 'Ghost Table' });
    expect(out).toBe('Roll table not found: "Ghost Table". Nothing changed.');
  });

  it('falls back to the identifier when notFound is absent', async () => {
    const { tools } = build({ updated: false });
    const out = await tools.handleUpdateRollTable({ identifier: 'missing' });
    expect(out).toBe('Roll table not found: "missing". Nothing changed.');
  });

  it('rejects a missing identifier', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateRollTable({ name: 'X' })).rejects.toThrow();
  });

  it('rejects an empty identifier', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateRollTable({ identifier: '' })).rejects.toThrow();
  });

  it('rejects a result with empty text', async () => {
    const { tools } = build();
    await expect(
      tools.handleUpdateRollTable({ identifier: 't1', results: [{ text: '' }] })
    ).rejects.toThrow();
  });
});

describe('handleRollOnTable', () => {
  it('forwards a valid roll and formats the drawn results', async () => {
    const { tools, calls } = build({
      total: 7,
      tableName: 'Loot',
      results: [{ text: 'Gold' }, { text: 'Gem' }],
    });
    const out = await tools.handleRollOnTable({ identifier: 'Loot' });
    expect(calls[0][0]).toBe('rollOnTable');
    expect(calls[0][1]).toEqual({ identifier: 'Loot' });
    expect(out).toBe('Rolled 7 on "Loot" → "Gold", "Gem"');
  });

  it('reports "(no result matched)" when no results come back', async () => {
    const { tools } = build({ total: 3, tableName: 'Loot', results: [] });
    const out = await tools.handleRollOnTable({ identifier: 'Loot' });
    expect(out).toBe('Rolled 3 on "Loot" → (no result matched)');
  });

  it('prettifies @UUID enrichers and lists importable item links', async () => {
    const uuid = 'Compendium.dnd-dungeon-masters-guide.equipment.Item.dmgRubyOfTheWarM';
    const { tools } = build({
      total: 68,
      tableName: 'Arcana - Common',
      results: [
        {
          text: `@UUID[${uuid}]{Ruby of the War Mage}`,
          links: [{ uuid, label: 'Ruby of the War Mage' }],
        },
      ],
    });
    const out = await tools.handleRollOnTable({ identifier: 'Arcana - Common' });
    expect(out).toBe(
      'Rolled 68 on "Arcana - Common" → "Ruby of the War Mage"\n' +
        `  importable: Ruby of the War Mage [${uuid}]`
    );
  });

  it('reports not-found when the bridge says rolled:false', async () => {
    const { tools } = build({ rolled: false, notFound: 'Ghost' });
    const out = await tools.handleRollOnTable({ identifier: 'Ghost' });
    expect(out).toBe('Roll table not found: "Ghost".');
  });

  it('rejects a missing identifier', async () => {
    const { tools } = build();
    await expect(tools.handleRollOnTable({})).rejects.toThrow();
  });

  it('rejects an empty identifier', async () => {
    const { tools } = build();
    await expect(tools.handleRollOnTable({ identifier: '' })).rejects.toThrow();
  });
});

describe('handleGetRollTable', () => {
  it('formats the table header and every entry, prettifying links', async () => {
    const { tools, calls } = build({
      found: true,
      id: 't1',
      name: 'Loot',
      formula: '1d3',
      replacement: true,
      displayRoll: true,
      description: '',
      results: [
        { range: [1, 1], text: 'Gold', links: [] },
        { range: [2, 3], text: '@UUID[u]{Ruby}', links: [{ uuid: 'u', label: 'Ruby' }] },
      ],
    });
    const out = await tools.handleGetRollTable({ identifier: 'Loot' });
    expect(calls[0][0]).toBe('getRollTable');
    expect(calls[0][1]).toEqual({ identifier: 'Loot' });
    expect(out).toBe(
      'Roll table "Loot" (t1) — 1d3, 2 result(s) [replacement on, displayRoll on]\n' +
        '  [1] Gold\n' +
        '  [2-3] Ruby\n' +
        '      → Ruby [u]'
    );
  });

  it('shows a description line and the no-replacement flag', async () => {
    const { tools } = build({
      found: true,
      id: 't2',
      name: 'Rumors',
      formula: '1d4',
      replacement: false,
      displayRoll: true,
      description: 'Tavern <em>gossip</em>.',
      results: [{ range: [1, 4], text: 'A rumor', links: [] }],
    });
    const out = await tools.handleGetRollTable({ identifier: 't2' });
    expect(out).toBe(
      'Roll table "Rumors" (t2) — 1d4, 1 result(s) [replacement off, displayRoll on]\n' +
        'Tavern <em>gossip</em>.\n' +
        '  [1-4] A rumor'
    );
  });

  it('reports not-found when the bridge says found:false', async () => {
    const { tools } = build({ found: false, notFound: 'Ghost' });
    const out = await tools.handleGetRollTable({ identifier: 'Ghost' });
    expect(out).toBe('Roll table not found: "Ghost".');
  });

  it('rejects a missing identifier', async () => {
    const { tools } = build();
    await expect(tools.handleGetRollTable({})).rejects.toThrow();
  });

  it('rejects an empty identifier', async () => {
    const { tools } = build();
    await expect(tools.handleGetRollTable({ identifier: '' })).rejects.toThrow();
  });
});

describe('handleDeleteRollTable', () => {
  it('forwards a valid delete and lists the removed tables', async () => {
    const { tools, calls } = build({
      deletedCount: 2,
      deleted: [
        { name: 'Loot', id: 't1' },
        { name: 'Enc', id: 'e1' },
      ],
      notFound: [],
    });
    const out = await tools.handleDeleteRollTable({ identifiers: ['t1', 'e1'] });
    expect(calls[0][0]).toBe('deleteRollTables');
    expect(calls[0][1]).toEqual({ identifiers: ['t1', 'e1'] });
    expect(out).toBe('Deleted 2 roll table(s):\n  - "Loot" (t1)\n  - "Enc" (e1)');
  });

  it('appends a not-found list when ids do not resolve', async () => {
    const { tools } = build({
      deletedCount: 0,
      deleted: [],
      notFound: ['nope'],
    });
    const out = await tools.handleDeleteRollTable({ identifiers: ['nope'] });
    expect(out).toContain('not found: nope');
  });

  it('rejects a missing identifiers array', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteRollTable({})).rejects.toThrow();
  });

  it('rejects an empty identifiers array', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteRollTable({ identifiers: [] })).rejects.toThrow();
  });

  it('rejects an identifier that is an empty string', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteRollTable({ identifiers: [''] })).rejects.toThrow();
  });
});
