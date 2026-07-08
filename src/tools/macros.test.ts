import { describe, it, expect } from 'vitest';
import { MacroTools } from './macros.js';
import { makeFoundry, makeLogger } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new MacroTools({ foundry, logger: makeLogger() });
  return { tools, calls };
}

describe('create-macro', () => {
  it('forwards parsed args and formats the created macro with its hotbar pin', async () => {
    const { tools, calls } = build({
      macro: { id: 'm1', name: 'Graze', type: 'script' },
      hotbar: { userId: 'p1', userName: 'Anthony', slot: 1 },
    });
    const out = await tools.handleCreateMacro({
      name: 'Graze',
      command: 'dnd5e.documents.macro.rollItem("Graze")',
      hotbarUser: 'Anthony',
    });
    expect(calls[0][0]).toBe('createMacro');
    expect(calls[0][1]).toMatchObject({
      name: 'Graze',
      command: 'dnd5e.documents.macro.rollItem("Graze")',
      type: 'script',
      hotbarUser: 'Anthony',
    });
    expect(out).toContain('✅ Created script macro "Graze" (`m1`)');
    expect(out).toContain("**Hotbar:** Anthony's slot 1");
  });

  it('formats a macro created without a hotbar pin', async () => {
    const { tools } = build({ macro: { id: 'm1', name: 'Rest', type: 'chat' } });
    const out = await tools.handleCreateMacro({ name: 'Rest', command: 'We rest.', type: 'chat' });
    expect(out).toContain('✅ Created chat macro "Rest" (`m1`)');
    expect(out).not.toContain('**Hotbar:**');
  });

  it('surfaces page warnings (occupied slot, script permission)', async () => {
    const { tools } = build({
      macro: { id: 'm1', name: 'Graze', type: 'script' },
      hotbar: { userId: 'p1', userName: 'Anthony', slot: 3 },
      warnings: ['hotbar slot 3 on "Anthony" held "Old Button" — replaced.'],
    });
    const out = await tools.handleCreateMacro({
      name: 'Graze',
      command: 'x',
      hotbarUser: 'Anthony',
      hotbarSlot: 3,
    });
    expect(out).toContain('⚠️ 1 warning(s):');
    expect(out).toContain('held "Old Button" — replaced.');
  });

  it('rejects a missing command (zod)', async () => {
    const { tools } = build();
    await expect(tools.handleCreateMacro({ name: 'Graze' })).rejects.toThrow();
  });

  it('rejects hotbarSlot without hotbarUser (zod refine)', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateMacro({ name: 'Graze', command: 'x', hotbarSlot: 1 })
    ).rejects.toThrow();
  });

  it('rejects an out-of-range hotbarSlot (zod)', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateMacro({
        name: 'Graze',
        command: 'x',
        hotbarUser: 'Anthony',
        hotbarSlot: 51,
      })
    ).rejects.toThrow();
  });

  it('rejects an unknown type (zod enum)', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateMacro({ name: 'Graze', command: 'x', type: 'aura' })
    ).rejects.toThrow();
  });
});

describe('list-macros', () => {
  it('formats each macro with type, author, and hotbar pins', async () => {
    const { tools, calls } = build({
      count: 2,
      macros: [
        {
          id: 'm1',
          name: 'Graze',
          type: 'script',
          author: 'Claude',
          hotbar: [{ userId: 'p1', userName: 'Anthony', slot: 1 }],
        },
        { id: 'm2', name: 'Rest', type: 'chat', author: null, hotbar: [] },
      ],
    });
    const out = await tools.handleListMacros({});
    expect(calls[0][0]).toBe('listMacros');
    expect(out).toContain('2 macro(s):');
    expect(out).toContain('- **Graze** (`m1`) — script · by Claude · hotbar: Anthony slot 1');
    expect(out).toContain('- **Rest** (`m2`) — chat');
  });

  it('reports an empty world', async () => {
    const { tools } = build({ count: 0, macros: [] });
    const out = await tools.handleListMacros({});
    expect(out).toBe('No macros in this world.');
  });
});

describe('delete-macro', () => {
  it('forwards ids and formats deletions with scrubbed hotbar slots', async () => {
    const { tools, calls } = build({
      deleted: [{ id: 'm1', name: 'Graze', type: 'script' }],
      scrubbedHotbarSlots: [{ userId: 'p1', userName: 'Anthony', slot: 1 }],
    });
    const out = await tools.handleDeleteMacros({ macros: ['m1'] });
    expect(calls[0][0]).toBe('deleteMacros');
    expect(calls[0][1]).toMatchObject({ macros: ['m1'] });
    expect(out).toContain('🗑️ Deleted 1 macro(s): "Graze"');
    expect(out).toContain('**Hotbar slots scrubbed:** Anthony slot 1');
  });

  it('lists identifiers that matched nothing', async () => {
    const { tools } = build({
      deleted: [{ id: 'm1', name: 'Graze', type: 'script' }],
      missing: ['ZZ-nope'],
    });
    const out = await tools.handleDeleteMacros({ macros: ['Graze', 'ZZ-nope'] });
    expect(out).toContain('⚠️ Not found (skipped): ZZ-nope');
  });

  it('rejects an empty macros array (zod)', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteMacros({ macros: [] })).rejects.toThrow();
  });
});
