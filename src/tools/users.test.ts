import { describe, it, expect } from 'vitest';
import { UserTools } from './users.js';
import { makeFoundry, makeLogger } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new UserTools({ foundry, logger: makeLogger() });
  return { tools, calls };
}

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
