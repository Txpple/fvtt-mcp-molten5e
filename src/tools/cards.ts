import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { formatDeletionResult } from '../utils/format.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * Cards tools — create / list / delete. Net-new document type for adventure
 * creation (decks, hands, piles — e.g. a deck of many things, tarokka, custom
 * encounter decks). Runs over the bridge against live Foundry documents, so the
 * world must be loaded and the headless Foundry client connected. GM-only for writes.
 */

// Single source of truth for each tool's input contract: the handler parses with these
// schemas and getToolDefinitions() advertises toInputSchema(...) of the same schema.
const CreateCardsSchema = z.object({
  name: z.string().min(1).describe('Cards stack name.'),
  type: z.enum(['deck', 'hand', 'pile']).optional().describe('Stack type (default "deck").'),
  description: z.string().optional().describe('Optional description.'),
  folderName: z
    .string()
    .optional()
    .describe('Optional folder to place the stack in (created if absent).'),
  cards: z
    .array(
      z.object({
        name: z.string().min(1).describe('Card name.'),
        description: z.string().optional().describe('Optional card description.'),
        img: z.string().optional().describe('Optional Data-relative image path for the card face.'),
      })
    )
    .optional()
    .describe('Optional initial cards.'),
});

const ListCardsSchema = z.object({});

const DeleteCardsSchema = z.object({
  identifiers: z
    .array(z.string().min(1))
    .min(1)
    .describe('Exact ids (preferred) or exact names of Cards stacks to delete.'),
});

export interface CardsToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class CardsTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: CardsToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'CardsTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-cards',
        description:
          'Create a Cards stack (deck, hand, or pile) with optional initial cards. Each card has a ' +
          'name and optional description/image (a Data-relative path becomes the card face). Use for ' +
          'custom decks/encounter cards. GM-only.',
        inputSchema: toInputSchema(CreateCardsSchema),
      },
      {
        name: 'list-cards',
        description: 'List Cards stacks with id, name, type (deck/hand/pile), and card count.',
        inputSchema: toInputSchema(ListCardsSchema),
      },
      {
        name: 'delete-cards',
        description:
          'Permanently delete one or more Cards stacks by exact id or exact name. STRICT resolution ' +
          '— no fuzzy/substring matching. GM-only.',
        inputSchema: toInputSchema(DeleteCardsSchema),
      },
    ];
  }

  async handleCreateCards(args: any): Promise<string> {
    const parsed = CreateCardsSchema.parse(args ?? {});
    const result = await this.foundry.call('createCards', parsed);
    return (
      `Created ${result?.type} "${result?.cardsName}" (${result?.cardsId}) with ` +
      `${result?.cardCount} card(s).`
    );
  }

  async handleListCards(_args: any): Promise<string> {
    const stacks = (await this.foundry.call('listCards', {})) ?? [];
    if (!Array.isArray(stacks) || stacks.length === 0) return 'No card stacks found.';
    const lines = stacks.map(
      (c: any) => `  - "${c.name}" (${c.id}) — ${c.type}, ${c.cardCount} card(s)`
    );
    return `Card stacks (${stacks.length}):\n${lines.join('\n')}`;
  }

  async handleDeleteCards(args: any): Promise<string> {
    const { identifiers } = DeleteCardsSchema.parse(args ?? {});
    const result = await this.foundry.call('deleteCards', { identifiers });
    return formatDeletionResult(result, 'card stack(s)');
  }
}
