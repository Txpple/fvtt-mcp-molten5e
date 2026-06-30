import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';
import { ErrorHandler, FormattedToolError } from '../utils/error-handler.js';

/**
 * User-account tools. Currently: set-user-avatar — the portrait Foundry shows next to a user's chat
 * messages. Defaults to the bridge user (MCP-Claude), so it's the simple way to give the MCP's own
 * chat posts a portrait instead of the default mystery-man.
 */

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
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: UserToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'UserTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
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

  async handleSetUserAvatar(args: any): Promise<string> {
    try {
      const parsed = SetUserAvatarSchema.parse(args ?? {});
      const r = await this.foundry.call('setUserAvatar', parsed);
      const warns = Array.isArray(r?.warnings) ? r.warnings : [];
      const warnSection = warns.length
        ? '\n\n⚠️ ' + warns.length + ' warning(s):\n' + warns.map((w: string) => '- ' + w).join('\n')
        : '';
      return `Set ${r?.name}'s avatar to ${r?.avatar}.` + warnSection;
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'set-user-avatar', 'setting avatar');
    }
  }
}
