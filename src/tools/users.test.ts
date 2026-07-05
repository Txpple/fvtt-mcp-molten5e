import { describe, it, expect } from 'vitest';
import { UserTools } from './users.js';
import { makeFoundry, makeLogger } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new UserTools({ foundry, logger: makeLogger() });
  return { tools, calls };
}

describe('list-users', () => {
  it('formats each user with role label, connection state, and character', async () => {
    const { tools, calls } = build({
      count: 2,
      users: [
        {
          id: 'gm1',
          name: 'Matt the DM',
          role: 4,
          roleLabel: 'gamemaster',
          active: true,
          character: null,
          isBridgeUser: false,
        },
        {
          id: 'p1',
          name: 'Tom',
          role: 1,
          roleLabel: 'player',
          active: false,
          character: { id: 'a1', name: 'Thomas' },
          isBridgeUser: false,
        },
      ],
    });
    const out = await tools.handleListUsers({});
    expect(calls[0][0]).toBe('listUsers');
    expect(out).toContain('2 user(s):');
    expect(out).toContain('**Matt the DM** (`gm1`) — role 4 (gamemaster) · CONNECTED');
    expect(out).toContain('**Tom** (`p1`) — role 1 (player) · offline · character: Thomas');
  });

  it('marks the bridge user', async () => {
    const { tools } = build({
      count: 1,
      users: [
        {
          id: 'c1',
          name: 'Claude',
          role: 3,
          roleLabel: 'assistant',
          active: true,
          character: null,
          isBridgeUser: true,
        },
      ],
    });
    const out = await tools.handleListUsers({});
    expect(out).toContain('← bridge user');
  });
});

describe('update-user', () => {
  it('forwards parsed args and formats previous → new per applied field', async () => {
    const { tools, calls } = build({
      user: { id: 'p1', name: 'Tom', role: 1, roleLabel: 'player', character: null },
      applied: ['role'],
      previous: { role: '2 (trusted)' },
    });
    const out = await tools.handleUpdateUser({ user: 'Tom', role: 'player' });
    expect(calls[0][0]).toBe('updateUser');
    expect(calls[0][1]).toMatchObject({ user: 'Tom', role: 'player' });
    expect(out).toContain('Updated user Tom');
    expect(out).toContain('- role: 2 (trusted) → 1 (player)');
  });

  it('formats a character assignment and surfaces warnings', async () => {
    const { tools } = build({
      user: {
        id: 'p1',
        name: 'Tom',
        role: 2,
        roleLabel: 'trusted',
        character: { id: 'a1', name: 'Thomas' },
      },
      applied: ['character'],
      previous: { character: null },
      warnings: ['"Thomas" is type "npc", not a player character (type "character")'],
    });
    const out = await tools.handleUpdateUser({ user: 'Tom', character: 'Thomas' });
    expect(out).toContain('- character: (unset) → Thomas');
    expect(out).toContain('⚠️ 1 warning(s):');
  });

  it('reports a no-op when nothing changed', async () => {
    const { tools } = build({
      user: { id: 'p1', name: 'Tom', role: 1, roleLabel: 'player', character: null },
      applied: [],
      previous: {},
    });
    const out = await tools.handleUpdateUser({ user: 'Tom', role: 'player' });
    expect(out).toContain('No changes for Tom');
  });

  it('rejects an update with no fields (zod refine)', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateUser({ user: 'Tom' })).rejects.toThrow();
  });

  it('rejects a bad color format (zod)', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateUser({ user: 'Tom', color: 'red' })).rejects.toThrow();
  });

  it('rejects an unknown role (zod enum)', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateUser({ user: 'Tom', role: 'admin' })).rejects.toThrow();
  });
});

describe('set-user-avatar', () => {
  it('forwards parsed args to setUserAvatar and formats the result', async () => {
    const { tools, calls } = build({ name: 'MCP-Claude', avatar: 'assets/mcp/mcp-claude.jpg' });
    const out = await tools.handleSetUserAvatar({ avatar: 'assets/mcp/mcp-claude.jpg' });
    expect(calls[0][0]).toBe('setUserAvatar');
    expect(calls[0][1]).toMatchObject({ avatar: 'assets/mcp/mcp-claude.jpg' });
    expect(out).toContain("MCP-Claude's avatar");
    expect(out).toContain('assets/mcp/mcp-claude.jpg');
  });

  it('forwards an explicit user identifier', async () => {
    const { tools, calls } = build({ name: 'Gandalf', avatar: 'https://x/y.png' });
    await tools.handleSetUserAvatar({ avatar: 'https://x/y.png', user: 'Gandalf' });
    expect(calls[0][1]).toMatchObject({ avatar: 'https://x/y.png', user: 'Gandalf' });
  });

  it('rejects empty avatar (zod)', async () => {
    const { tools } = build();
    await expect(tools.handleSetUserAvatar({ avatar: '' })).rejects.toThrow();
  });

  it('surfaces page warnings when the avatar 404s and is substituted', async () => {
    const { tools } = build({
      name: 'MCP-Claude',
      avatar: 'icons/environment/people/commoner.webp',
      warnings: [
        'Supplied avatar "x/nope.webp" was not found on the server — substituted a real icon (rule 8).',
      ],
    });
    const out = await tools.handleSetUserAvatar({ avatar: 'x/nope.webp' });
    expect(out).toContain('not found on the server');
    expect(out).toContain('⚠️ 1 warning(s):');
  });
});
