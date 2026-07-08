import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';
import { ErrorHandler, FormattedToolError } from '../utils/error-handler.js';

/**
 * Macro tools — world Macro documents and user hotbar pins.
 * - create-macro: author a script/chat macro, grant a player OWNER access, and pin it to their
 *   hotbar in one call — the "hand a player a one-click button" op.
 * - list-macros: the namespace's read — every macro with its type, author, command preview, and
 *   every user hotbar slot it occupies.
 * - delete-macro: remove macros and scrub any user hotbar slots that pointed at them.
 */

const CreateMacroSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe('Macro name — the hotbar tooltip and its Macro Directory entry.'),
    command: z
      .string()
      .min(1)
      .describe(
        "The macro body. For type 'script': JavaScript run as the clicking user — e.g. " +
          'dnd5e.documents.macro.rollItem("Graze") rolls the item named Graze on that user\'s ' +
          "assigned character. For type 'chat': text posted to chat verbatim (inline rolls like " +
          '[[/roll 1d6]] work).'
      ),
    type: z
      .enum(['script', 'chat'])
      .default('script')
      .describe("'script' (default) executes JavaScript; 'chat' posts its text to the chat log."),
    img: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Icon path or URL for the hotbar button. Omit for Foundry's stock macro icon. A path " +
          'that does not resolve on the server is replaced with the stock icon (rule 8) with a warning.'
      ),
    owner: z
      .string()
      .min(1)
      .optional()
      .describe(
        'User id or name granted OWNER on the macro. The hotbarUser is always granted OWNER — ' +
          'pass this only to grant a DIFFERENT user as well.'
      ),
    hotbarUser: z
      .string()
      .min(1)
      .optional()
      .describe(
        "User id or name whose hotbar gets the button (also granted OWNER so it's theirs to see " +
          'and edit). Omit to create the macro without pinning it anywhere.'
      ),
    hotbarSlot: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Hotbar slot 1–50 (page 1 = slots 1–10). Default: the first free slot. An occupied slot ' +
          'is replaced with a warning.'
      ),
  })
  .refine(o => o.hotbarSlot === undefined || o.hotbarUser !== undefined, {
    message: 'hotbarSlot requires hotbarUser',
  });

const ListMacrosSchema = z.object({});

const DeleteMacroSchema = z.object({
  macros: z
    .array(z.string().min(1))
    .min(1)
    .describe('Macro ids or exact names (case-insensitive) to delete. Find them with list-macros.'),
});

export interface MacroToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class MacroTools {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: MacroToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'MacroTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-macro',
        description:
          'Create a world Macro — a hotbar button. type "script" (default) runs JavaScript as the ' +
          'clicking user (e.g. dnd5e.documents.macro.rollItem("Graze") rolls that item on their ' +
          'assigned character); type "chat" posts its text to chat. Optionally grant a player ' +
          'OWNER access and pin the button to their hotbar (hotbarUser + optional hotbarSlot, ' +
          'default first free slot) in the same call — the way to hand a player a one-click ' +
          'ability. GM-only.',
        inputSchema: toInputSchema(CreateMacroSchema),
      },
      {
        name: 'list-macros',
        description:
          'List every macro in the world: id, name, type (script/chat), author, icon, a command ' +
          'preview, and every user hotbar slot it is pinned to. The read to run before ' +
          'delete-macro.',
        inputSchema: toInputSchema(ListMacrosSchema),
      },
      {
        name: 'delete-macro',
        description:
          'Delete world macros by id or exact name, scrubbing any user hotbar slots that pointed ' +
          'at them so no dead buttons are left behind. GM-only.',
        inputSchema: toInputSchema(DeleteMacroSchema),
      },
    ];
  }

  async handleCreateMacro(args: any): Promise<string> {
    try {
      const parsed = CreateMacroSchema.parse(args ?? {});
      const r = await this.foundry.call('createMacro', parsed);
      const lines = [
        `✅ Created ${r?.macro?.type} macro "${r?.macro?.name}" (\`${r?.macro?.id}\`)`,
      ];
      if (r?.hotbar) {
        lines.push(`**Hotbar:** ${r.hotbar.userName}'s slot ${r.hotbar.slot}`);
      }
      const warns = Array.isArray(r?.warnings) ? r.warnings : [];
      if (warns.length) {
        lines.push('', `⚠️ ${warns.length} warning(s):`, ...warns.map((w: string) => `- ${w}`));
      }
      return lines.join('\n');
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'create-macro', 'creating macro');
    }
  }

  async handleListMacros(args: any): Promise<string> {
    try {
      ListMacrosSchema.parse(args ?? {});
      const r = await this.foundry.call('listMacros');
      const macros = Array.isArray(r?.macros) ? r.macros : [];
      if (macros.length === 0) return 'No macros in this world.';
      const lines = macros.map((m: any) => {
        const pins = Array.isArray(m.hotbar) ? m.hotbar : [];
        const pinText = pins.length
          ? ` · hotbar: ${pins.map((p: any) => `${p.userName} slot ${p.slot}`).join(', ')}`
          : '';
        return `- **${m.name}** (\`${m.id}\`) — ${m.type}${m.author ? ` · by ${m.author}` : ''}${pinText}`;
      });
      return `${macros.length} macro(s):\n${lines.join('\n')}`;
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'list-macros', 'listing macros');
    }
  }

  async handleDeleteMacros(args: any): Promise<string> {
    try {
      const parsed = DeleteMacroSchema.parse(args ?? {});
      const r = await this.foundry.call('deleteMacros', parsed);
      const deleted = Array.isArray(r?.deleted) ? r.deleted : [];
      const lines = [
        `🗑️ Deleted ${deleted.length} macro(s): ${deleted.map((m: any) => `"${m.name}"`).join(', ')}`,
      ];
      const scrubbed = Array.isArray(r?.scrubbedHotbarSlots) ? r.scrubbedHotbarSlots : [];
      if (scrubbed.length) {
        lines.push(
          `**Hotbar slots scrubbed:** ${scrubbed
            .map((s: any) => `${s.userName} slot ${s.slot}`)
            .join(', ')}`
        );
      }
      const missing = Array.isArray(r?.missing) ? r.missing : [];
      if (missing.length) {
        lines.push(`⚠️ Not found (skipped): ${missing.join(', ')}`);
      }
      return lines.join('\n');
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'delete-macro', 'deleting macros');
    }
  }
}
