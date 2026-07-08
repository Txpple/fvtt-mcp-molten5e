import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * User-account tools.
 * - list-users: the namespace's read — every user account with role, connection state, and
 *   assigned character.
 * - update-user: GM admin on a user account — role, name, color, pronouns, assigned character.
 * - set-user-avatar: the portrait Foundry shows next to a user's chat messages. Defaults to the
 *   bridge user (MCP-Claude), so it's the simple way to give the MCP's own chat posts a portrait
 *   instead of the default mystery-man.
 */

const ListUsersSchema = z.object({});

const UpdateUserSchema = z
  .object({
    user: z
      .string()
      .min(1)
      .describe(
        'User id or exact name to update (case-insensitive name match allowed). No default — ' +
          'account edits are always explicit.'
      ),
    role: z
      .enum(['none', 'player', 'trusted', 'assistant', 'gamemaster'])
      .optional()
      .describe(
        "Permission role: 'none' (banned) | 'player' | 'trusted' (trusted player) | 'assistant' " +
          "(assistant GM) | 'gamemaster'. Guarded: the bridge user's own role and the world's last " +
          'gamemaster cannot be demoted.'
      ),
    name: z.string().min(1).optional().describe('Rename the user account (their login name).'),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #rrggbb hex string')
      .optional()
      .describe('Player color as #rrggbb — used for cursors, targeting, and chat borders.'),
    pronouns: z.string().optional().describe('Pronouns shown next to the user name.'),
    character: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Actor id or name to assign as the user's character (their default speaker / PC). " +
          'Pass "none" to clear the assignment.'
      ),
  })
  .refine(
    o => o.role !== undefined || o.name || o.color || o.pronouns !== undefined || o.character,
    { message: 'nothing to update — pass at least one of role, name, color, pronouns, character' }
  );

const SetUserAvatarSchema = z.object({
  avatar: z
    .string()
    .min(1)
    .describe(
      'Avatar image: a Data-relative asset path (e.g. "assets/mcp/mcp-claude.jpg"), an https URL, or ' +
        'a Foundry built-in icon path. Upload local files first with upload-asset, then pass the ' +
        'returned path/URL here.'
    ),
  user: z
    .string()
    .optional()
    .describe('User id or exact name to update. Default: the bridge user that posts (MCP-Claude).'),
});

export interface UserToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class UserTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: UserToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'UserTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'list-users',
        description:
          'List every user account in the world: id, name, role (player/trusted/assistant/' +
          'gamemaster), whether they are currently connected, player color, pronouns, avatar, and ' +
          'their assigned character. The read to run before update-user.',
        inputSchema: toInputSchema(ListUsersSchema),
      },
      {
        name: 'update-user',
        description:
          'Update a Foundry user account: permission role (e.g. demote a trusted player to player), ' +
          'login name, player color, pronouns, or assigned character. GM admin — guarded so the ' +
          "bridge user's own role and the world's last gamemaster cannot be demoted.",
        inputSchema: toInputSchema(UpdateUserSchema),
      },
      {
        name: 'set-user-avatar',
        description:
          "Set a Foundry user's avatar — the portrait shown next to that user's chat messages. " +
          "Defaults to the bridge user (MCP-Claude), so this is how you give the MCP's own chat posts " +
          'a portrait instead of the default mystery-man. Pass a Data-relative path or https URL ' +
          '(upload local files with upload-asset first). GM-only.',
        inputSchema: toInputSchema(SetUserAvatarSchema),
      },
    ];
  }

  async handleListUsers(args: any): Promise<string> {
    ListUsersSchema.parse(args ?? {});
    const r = await this.foundry.call('listUsers');
    const users = Array.isArray(r?.users) ? r.users : [];
    const lines = users.map((u: any) => {
      const bits = [
        `role ${u.role} (${u.roleLabel})`,
        u.active ? 'CONNECTED' : 'offline',
        ...(u.character ? [`character: ${u.character.name}`] : []),
        ...(u.isBridgeUser ? ['← bridge user'] : []),
      ];
      return `- **${u.name}** (\`${u.id}\`) — ${bits.join(' · ')}`;
    });
    return `${users.length} user(s):\n${lines.join('\n')}`;
  }

  async handleUpdateUser(args: any): Promise<string> {
    const parsed = UpdateUserSchema.parse(args ?? {});
    const r = await this.foundry.call('updateUser', parsed);
    const applied: string[] = Array.isArray(r?.applied) ? r.applied : [];
    if (applied.length === 0) {
      return `No changes for ${r?.user?.name} — everything already matched.`;
    }
    const changes = applied.map(field => {
      const prev = (r?.previous as any)?.[field];
      const now =
        field === 'role'
          ? `${r?.user?.role} (${r?.user?.roleLabel})`
          : field === 'character'
            ? (r?.user?.character?.name ?? 'none')
            : ((r?.user as any)?.[field] ?? '');
      return `- ${field}: ${prev ?? '(unset)'} → ${now}`;
    });
    const warns = Array.isArray(r?.warnings) ? r.warnings : [];
    const warnSection = warns.length
      ? `\n\n⚠️ ${warns.length} warning(s):\n${warns.map((w: string) => `- ${w}`).join('\n')}`
      : '';
    return `Updated user ${r?.user?.name} (\`${r?.user?.id}\`):\n${changes.join('\n')}${warnSection}`;
  }

  async handleSetUserAvatar(args: any): Promise<string> {
    const parsed = SetUserAvatarSchema.parse(args ?? {});
    const r = await this.foundry.call('setUserAvatar', parsed);
    const warns = Array.isArray(r?.warnings) ? r.warnings : [];
    const warnSection = warns.length
      ? `\n\n⚠️ ${warns.length} warning(s):\n${warns.map((w: string) => `- ${w}`).join('\n')}`
      : '';
    return `Set ${r?.name}'s avatar to ${r?.avatar}.${warnSection}`;
  }
}
