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
        description: z
          .string()
          .optional()
          .describe('Optional GM/meta note for the card (not shown on the face).'),
        text: z
          .string()
          .optional()
          .describe(
            'Optional face text (HTML) shown ON the card — e.g. a Deck of Many Things outcome. A ' +
              'card with `text` and/or `img` gets a face; with neither it is a plain named card.'
          ),
        img: z.string().optional().describe('Optional Data-relative image path for the card face.'),
      })
    )
    .optional()
    .describe('Optional initial cards.'),
});

const ListCardsSchema = z.object({});

const ImportCardsSchema = z.object({
  preset: z
    .string()
    .min(1)
    .describe('Core preset deck key — e.g. "pokerDark" / "pokerLight" (a standard 52-card deck).'),
  name: z.string().min(1).optional().describe('Optional name for the imported stack.'),
  folderName: z
    .string()
    .optional()
    .describe('Optional folder to place the stack in (created if absent).'),
});

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
          'name and optional face `text` (HTML shown on the card — e.g. a Deck of Many Things ' +
          'outcome) and/or `img` (a Data-relative path), plus a card-level `description` (GM/meta ' +
          'note). Use for custom themed decks (Deck of Many Things, tarokka, encounter decks). ' +
          'GM-only.',
        inputSchema: toInputSchema(CreateCardsSchema),
      },
      {
        name: 'import-cards',
        description:
          'Instantiate a core Foundry PRESET deck into the world (e.g. "pokerDark"/"pokerLight" — a ' +
          'standard 52-card deck). Cards have no premium-book compendium, so this is the ready-made ' +
          'deck path; build themed D&D decks with create-cards. GM-only.',
        inputSchema: toInputSchema(ImportCardsSchema),
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

  async handleImportCards(args: any): Promise<string> {
    const parsed = ImportCardsSchema.parse(args ?? {});
    const result = await this.foundry.call('importCardsPreset', parsed);
    return (
      `Imported ${result?.type} "${result?.cardsName}" (${result?.cardsId}) from preset ` +
      `"${result?.preset}" — ${result?.cardCount} card(s).`
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
