import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { FormattedToolError } from '../utils/error-handler.js';
import { toInputSchema } from '../utils/schema.js';

export interface OwnershipToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

// Foundry ownership permission levels
const OwnershipLevels = {
  NONE: 0,
  LIMITED: 1,
  OBSERVER: 2,
  OWNER: 3,
} as const;

// INHERIT is not a level — it means "no explicit entry for this user", so the actor's
// `ownership.default` applies. It travels to the page as `permission: null`, which
// setActorOwnership implements by REMOVING the user's key. An explicit NONE (0) is a
// different thing: it OVERRIDES a permissive default and actively denies the user.
const ownershipLevelSchema = z.enum(['NONE', 'LIMITED', 'OBSERVER', 'OWNER', 'INHERIT']);

// Single source of truth for each tool's input contract: the handler parses with these
// schemas and getToolDefinitions() advertises toInputSchema(...) of the same schema.
const SetActorOwnershipSchema = z.object({
  actorIdentifier: z
    .string()
    .describe(
      'Actor name, ID, or "all friendly NPCs" for bulk operations. Use "party characters" for all player-owned actors.'
    ),
  playerIdentifier: z
    .string()
    .describe(
      'Player name, character name, or "party" for all connected players. Supports partial matching.'
    ),
  permissionLevel: ownershipLevelSchema.describe(
    "Permission level to assign: LIMITED (basic view), OBSERVER (full view, no control), OWNER (full control), NONE (explicitly DENY — stores a level-0 entry that overrides the actor's default, so it revokes access the player would otherwise inherit), INHERIT (remove the player's entry entirely so the actor's default ownership applies again)"
  ),
  confirmBulkOperation: z
    .boolean()
    .default(false)
    .describe('Required confirmation for bulk operations affecting multiple actors/players'),
});

const ListActorOwnershipSchema = z.object({
  actorIdentifier: z
    .string()
    .optional()
    .describe('Optional: specific actor name/ID to check, or "all" for all actors'),
  playerIdentifier: z
    .string()
    .optional()
    .describe('Optional: specific player name to check ownership for'),
});

export class OwnershipTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: OwnershipToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'OwnershipTools' });
  }

  /**
   * Get tool definitions for ownership management
   */
  getToolDefinitions() {
    return [
      {
        name: 'set-actor-ownership',
        description:
          'Set ownership permissions for actors. Use permissionLevel OWNER/OBSERVER/LIMITED to grant access, NONE to explicitly deny it (a stored level-0 entry that OVERRIDES the actor\'s default ownership), or INHERIT to remove the player\'s entry so the actor\'s default applies again. On an actor whose default is permissive (e.g. a shared party stash defaulting to OWNER), NONE revokes access the player would otherwise inherit and INHERIT is what restores it. Supports individual assignments like "Make John the owner of Aragorn" and bulk operations like "Give the party observer access to all friendly NPCs".',
        inputSchema: toInputSchema(SetActorOwnershipSchema),
      },
      {
        name: 'list-actor-ownership',
        description:
          'List current ownership permissions for actors, showing which players have what access levels.',
        inputSchema: toInputSchema(ListActorOwnershipSchema),
      },
    ];
  }

  /**
   * Handle tool execution
   */
  async handleToolCall(name: string, args: any) {
    switch (name) {
      case 'set-actor-ownership':
        return await this.assignActorOwnership(args);
      case 'list-actor-ownership':
        return await this.listActorOwnership(args);
      default:
        throw new Error(`Unknown ownership tool: ${name}`);
    }
  }

  /**
   * Assign actor ownership permissions
   */
  private async assignActorOwnership(args: any) {
    const { actorIdentifier, playerIdentifier, permissionLevel, confirmBulkOperation } =
      SetActorOwnershipSchema.parse(args ?? {});

    this.logger.info(
      `Assigning ${permissionLevel} ownership of "${actorIdentifier}" to "${playerIdentifier}"`
    );

    // Validate permission level. INHERIT has no numeric level — null tells the page side to
    // DELETE the user's ownership key (falling back to the actor's default) rather than store one.
    const validatedLevel = permissionLevel;
    const numericLevel = validatedLevel === 'INHERIT' ? null : OwnershipLevels[validatedLevel];

    // Resolve actors and players
    const actors = await this.resolveActors(actorIdentifier);
    const players = await this.resolvePlayers(playerIdentifier);

    // Bulk-operation guard: a precondition failure, thrown (like every other tool's guards) so the
    // guidance surfaces verbatim rather than as a masquerading success:false payload.
    const isBulkOperation = actors.length > 1 || players.length > 1;
    if (isBulkOperation && !confirmBulkOperation) {
      throw new FormattedToolError(
        `Bulk operation detected: ${actors.length} actors × ${players.length} players = ${actors.length * players.length} ownership changes. Set confirmBulkOperation to true to proceed.`
      );
    }

    // Apply ownership changes
    const results = [];
    for (const actor of actors) {
      for (const player of players) {
        try {
          const result = await this.foundry.call('setActorOwnership', {
            actorId: actor.id,
            userId: player.id,
            permission: numericLevel,
          });

          results.push({
            actor: actor.name,
            player: player.name,
            permission: validatedLevel,
            success: result.success,
            message: result.message,
            error: result.error,
          });
        } catch (error) {
          results.push({
            actor: actor.name,
            player: player.name,
            permission: validatedLevel,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;

    return {
      success: successCount > 0,
      message: `${successCount} ownership assignments completed${failureCount > 0 ? `, ${failureCount} failed` : ''}`,
      results,
    };
  }

  /**
   * List actor ownership permissions
   */
  private async listActorOwnership(args: any) {
    const { actorIdentifier, playerIdentifier } = ListActorOwnershipSchema.parse(args ?? {});

    this.logger.info(
      `Listing actor ownership for actor: "${actorIdentifier || 'all'}", player: "${playerIdentifier || 'all'}"`
    );

    const ownershipData = await this.foundry.call('getActorOwnership', {
      actorIdentifier,
      playerIdentifier,
    });

    return {
      success: true,
      ownership: ownershipData,
    };
  }

  /**
   * Resolve actors from identifier (supports bulk operations)
   */
  private async resolveActors(identifier: string): Promise<Array<{ id: string; name: string }>> {
    this.logger.debug(`Resolving actors for identifier: ${identifier}`);

    try {
      if (identifier.toLowerCase().includes('all friendly npcs')) {
        // Get all tokens in current scene with friendly disposition
        const actors = await this.foundry.call('getFriendlyNPCs', {});
        this.logger.debug(`Found ${actors.length} friendly NPCs`);
        return actors;
      } else if (identifier.toLowerCase().includes('party characters')) {
        // Get all player-owned characters
        const actors = await this.foundry.call('getPartyCharacters', {});
        this.logger.debug(`Found ${actors.length} party characters`);
        return actors;
      } else {
        // Single actor lookup
        this.logger.debug(`Looking for single actor: ${identifier}`);
        const actor = await this.foundry.call('findActor', {
          identifier,
        });
        this.logger.debug(`Single actor lookup result:`, actor);
        return actor ? [actor] : [];
      }
    } catch (error) {
      this.logger.error(`Failed to resolve actors for "${identifier}":`, error);
      return [];
    }
  }

  /**
   * Resolve players from identifier (supports partial matching)
   */
  private async resolvePlayers(identifier: string): Promise<Array<{ id: string; name: string }>> {
    this.logger.debug(`Resolving players for identifier: ${identifier}`);

    try {
      if (identifier.toLowerCase() === 'party') {
        // Get all connected players (excluding GM)
        const players = await this.foundry.call('getConnectedPlayers', {});
        this.logger.debug(`Found ${players.length} connected players`);
        return players;
      } else {
        // Single player lookup with partial matching
        this.logger.debug(`Looking for single player: ${identifier}`);
        const players = await this.foundry.call('findPlayers', {
          identifier,
          allowPartialMatch: true,
          includeCharacterOwners: true, // Also match by character names they own
        });
        this.logger.debug(`Player lookup result:`, players);
        return players;
      }
    } catch (error) {
      this.logger.error(`Failed to resolve players for "${identifier}":`, error);
      return [];
    }
  }
}
