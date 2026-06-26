/**
 * Unit tests for OrganizationTools (create-folder, move-documents, bulk-delete).
 *
 * Covers the two things these handlers own before the bridge is reached:
 *   1. zod input validation — required fields, enum membership, non-empty
 *      strings/arrays are enforced (bad input throws, never hits the bridge).
 *   2. response formatting — the human-readable string built from the bridge
 *      result, including the notFound / root / count branches.
 */

import { describe, it, expect } from 'vitest';
import { OrganizationTools } from './organization.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new OrganizationTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('OrganizationTools.getToolDefinitions', () => {
  it('exposes exactly the three organization tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(['bulk-delete', 'create-folder', 'move-documents']);
  });

  it('every definition has an object inputSchema with required fields', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
      expect(Array.isArray(def.inputSchema.required)).toBe(true);
    }
  });
});

describe('handleCreateFolder', () => {
  it('forwards a valid folder request and formats the result', async () => {
    const { tools, calls } = build({ type: 'Actor', folderName: 'NPCs', folderId: 'abc123' });
    const out = await tools.handleCreateFolder({ name: 'NPCs', type: 'Actor' });
    expect(calls[0][0]).toBe('createFolder');
    expect(calls[0][1]).toMatchObject({ name: 'NPCs', type: 'Actor' });
    expect(out).toBe('Created Actor folder "NPCs" (abc123).');
  });

  it('passes optional parentFolder and color through', async () => {
    const { tools, calls } = build({ type: 'Item', folderName: 'Loot', folderId: 'x' });
    await tools.handleCreateFolder({
      name: 'Loot',
      type: 'Item',
      parentFolder: 'root-id',
      color: '#4a90e2',
    });
    expect(calls[0][1]).toMatchObject({ parentFolder: 'root-id', color: '#4a90e2' });
  });

  it('rejects an empty name', async () => {
    const { tools } = build();
    await expect(tools.handleCreateFolder({ name: '', type: 'Actor' })).rejects.toThrow();
  });

  it('rejects a missing type', async () => {
    const { tools } = build();
    await expect(tools.handleCreateFolder({ name: 'X' })).rejects.toThrow();
  });

  it('rejects an unknown document type', async () => {
    const { tools } = build();
    await expect(tools.handleCreateFolder({ name: 'X', type: 'Widget' })).rejects.toThrow();
  });

  it('rejects undefined args without throwing a non-zod error', async () => {
    const { tools } = build();
    await expect(tools.handleCreateFolder(undefined)).rejects.toThrow();
  });
});

describe('handleMoveDocuments', () => {
  it('forwards a valid move and reports destination + count', async () => {
    const { tools, calls } = build({
      movedCount: 2,
      targetFolderName: 'Archive',
      targetFolderId: 'fold9',
      notFound: [],
    });
    const out = await tools.handleMoveDocuments({
      documentType: 'JournalEntry',
      identifiers: ['a', 'b'],
      targetFolder: 'Archive',
    });
    expect(calls[0][0]).toBe('moveDocuments');
    expect(out).toBe('Moved 2 JournalEntry document(s) → "Archive" (fold9).');
  });

  it('reports "root" when no target folder name comes back', async () => {
    const { tools } = build({ movedCount: 1, notFound: [] });
    const out = await tools.handleMoveDocuments({
      documentType: 'Scene',
      identifiers: ['s1'],
    });
    expect(out).toBe('Moved 1 Scene document(s) → root.');
  });

  it('appends a not-found list when the bridge reports misses', async () => {
    const { tools } = build({ movedCount: 1, notFound: ['ghost'] });
    const out = await tools.handleMoveDocuments({
      documentType: 'Actor',
      identifiers: ['real', 'ghost'],
    });
    expect(out).toContain('not found: ghost');
  });

  it('rejects an empty identifiers array', async () => {
    const { tools } = build();
    await expect(
      tools.handleMoveDocuments({ documentType: 'Actor', identifiers: [] })
    ).rejects.toThrow();
  });

  it('rejects an identifier that is an empty string', async () => {
    const { tools } = build();
    await expect(
      tools.handleMoveDocuments({ documentType: 'Actor', identifiers: [''] })
    ).rejects.toThrow();
  });
});

describe('handleBulkDelete', () => {
  it('forwards a valid delete and lists the removed documents', async () => {
    const { tools, calls } = build({
      deletedCount: 2,
      deleted: [
        { name: 'Goblin', id: 'g1' },
        { name: 'Kobold', id: 'k1' },
      ],
      notFound: [],
    });
    const out = await tools.handleBulkDelete({
      documentType: 'Actor',
      identifiers: ['g1', 'k1'],
    });
    expect(calls[0][0]).toBe('bulkDelete');
    expect(out).toContain('Deleted 2 Actor document(s)');
    expect(out).toContain('"Goblin" (g1)');
    expect(out).toContain('"Kobold" (k1)');
  });

  it('appends a not-found list when ids do not resolve', async () => {
    const { tools } = build({
      deletedCount: 0,
      deleted: [],
      notFound: ['nope'],
    });
    const out = await tools.handleBulkDelete({
      documentType: 'Item',
      identifiers: ['nope'],
    });
    expect(out).toContain('not found: nope');
  });

  it('renders a dry-run preview without claiming anything was deleted', async () => {
    const { tools, calls } = build({
      dryRun: true,
      deletedCount: 0,
      deleted: [],
      wouldDelete: [
        { name: 'Goblin', id: 'g1' },
        { name: 'Kobold', id: 'k1' },
      ],
    });
    const out = await tools.handleBulkDelete({
      documentType: 'Actor',
      identifiers: ['g1', 'k1'],
      dryRun: true,
    });
    expect(calls[0][1].dryRun).toBe(true);
    expect(out).toContain('Dry run — would delete 2 Actor document(s)');
    expect(out).toContain('Goblin (g1)');
    expect(out).not.toContain('Deleted');
  });

  it('rejects a missing documentType', async () => {
    const { tools } = build();
    await expect(tools.handleBulkDelete({ identifiers: ['x'] })).rejects.toThrow();
  });

  it('rejects an empty identifiers array', async () => {
    const { tools } = build();
    await expect(
      tools.handleBulkDelete({ documentType: 'Item', identifiers: [] })
    ).rejects.toThrow();
  });
});
