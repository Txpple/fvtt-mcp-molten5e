import { Logger } from '../logger.js';

export interface MCPError {
  type: 'user' | 'system' | 'permission' | 'validation' | 'connection';
  message: string;
  details?: any;
  suggestions?: string[];
  recoverable: boolean;
}

export class ErrorHandler {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'ErrorHandler' });
  }

  /**
   * Map Foundry errors to user-friendly MCP errors
   */
  mapFoundryError(error: any, context: string): MCPError {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorLower = errorMessage.toLowerCase();

    // Permission errors
    if (errorLower.includes('access denied') || errorLower.includes('permission')) {
      return {
        type: 'permission',
        message: 'Permission denied for this operation',
        details: errorMessage,
        suggestions: [
          'Ensure the MCP user (FOUNDRY_USER) has GM rights in this world',
          "Some operations are GM-only — check the joined user's role",
          "Verify the document's ownership allows this operation",
        ],
        recoverable: true,
      };
    }

    // Connection errors — the headless bridge: launching Chromium, waking the box,
    // joining the world, or the in-page socket dropping.
    if (
      errorLower.includes('connection') ||
      errorLower.includes('websocket') ||
      errorLower.includes('timeout') ||
      errorLower.includes('navigation') ||
      errorLower.includes('net::') ||
      errorLower.includes('target closed') ||
      errorLower.includes('target page') ||
      errorLower.includes('browser') ||
      errorLower.includes('game.ready')
    ) {
      return {
        type: 'connection',
        message: 'Connection to the Foundry world failed',
        details: errorMessage,
        suggestions: [
          'Ensure the world is launched (Setup → Launch World); a sleeping box wakes automatically via MOLTEN_MAGIC_URL',
          'Check MOLTEN_SERVER_URL and MOLTEN_MAGIC_URL, and that the box actually woke',
          'Verify FOUNDRY_USER is a valid, passwordless user that can join this world',
          'A cold box can be slow to wake on the first call — retry once it is up',
        ],
        recoverable: true,
      };
    }

    // Validation errors
    if (
      errorLower.includes('not found') ||
      errorLower.includes('invalid') ||
      errorLower.includes('missing')
    ) {
      if (context.includes('compendium') || context.includes('creature')) {
        return {
          type: 'validation',
          message: 'Creature not found in compendiums',
          details: errorMessage,
          suggestions: [
            'Try searching with a different creature name',
            'Check if the compendium pack is available',
            'Use more specific terms (e.g., "goblin warrior" instead of "goblin")',
          ],
          recoverable: true,
        };
      }

      return {
        type: 'validation',
        message: 'Invalid request or missing data',
        details: errorMessage,
        suggestions: [
          'Check that all required parameters are provided',
          'Verify the data exists in Foundry VTT',
        ],
        recoverable: true,
      };
    }

    // Actor creation specific errors
    if (errorLower.includes('actor creation') || errorLower.includes('create actor')) {
      return {
        type: 'system',
        message: 'Failed to create actor in Foundry VTT',
        details: errorMessage,
        suggestions: [
          'Check that the source compendium entry is valid',
          'Ensure Foundry VTT has sufficient permissions',
          'Try creating actors one at a time instead of in bulk',
        ],
        recoverable: true,
      };
    }

    // Scene errors (scene documents only — token/placeable manipulation is out of scope)
    if (errorLower.includes('scene')) {
      return {
        type: 'system',
        message: 'Failed to read or modify the scene',
        details: errorMessage,
        suggestions: [
          'Check that the target scene exists (use list-scenes)',
          'Verify the MCP user has permission to edit scenes',
          'For background art, confirm the asset path resolves to a public URL',
        ],
        recoverable: true,
      };
    }

    // Transaction/rollback errors
    if (errorLower.includes('rollback') || errorLower.includes('transaction')) {
      return {
        type: 'system',
        message: 'Operation was rolled back due to errors',
        details: errorMessage,
        suggestions: [
          'The system prevented partial failures by undoing changes',
          'Try the operation again with different parameters',
          'Check Foundry VTT console for more details',
        ],
        recoverable: true,
      };
    }

    // Generic system errors
    return {
      type: 'system',
      message: 'An unexpected error occurred',
      details: errorMessage,
      suggestions: [
        'Check Foundry VTT console for more details',
        'Try the operation again',
        'Contact support if the issue persists',
      ],
      recoverable: false,
    };
  }

  /**
   * Build a plain-text error message for the MCP text channel: the mapped message plus any
   * actionable suggestions. No markdown/emoji — index.ts prefixes "Error: " when returning it,
   * and the consumer is a model, not a terminal.
   */
  formatErrorMessage(mcpError: MCPError, toolName: string): string {
    let message = mcpError.message;

    if (mcpError.suggestions && mcpError.suggestions.length > 0) {
      message += ` Try: ${mcpError.suggestions.join('; ')}.`;
    }

    if (mcpError.type === 'validation' && toolName === 'create-actor') {
      message += ' Tip: use search-compendium first to see available creatures.';
    }

    return message;
  }

  /**
   * Log error with appropriate level
   */
  logError(mcpError: MCPError, toolName: string, originalError?: any): void {
    const logData = {
      toolName,
      errorType: mcpError.type,
      message: mcpError.message,
      recoverable: mcpError.recoverable,
      details: mcpError.details,
    };

    switch (mcpError.type) {
      case 'user':
      case 'validation':
        this.logger.warn('User/validation error', logData);
        break;
      case 'permission':
        this.logger.warn('Permission error', logData);
        break;
      case 'connection':
        this.logger.error('Connection error', logData);
        break;
      default:
        this.logger.error('System error', logData);
        if (originalError) {
          this.logger.error('Original error details', originalError);
        }
        break;
    }
  }

  /**
   * Handle tool execution error with proper formatting
   */
  handleToolError(error: any, toolName: string, context: string = ''): never {
    const mcpError = this.mapFoundryError(error, `${toolName} ${context}`.trim());
    this.logError(mcpError, toolName, error);

    const formattedMessage = this.formatErrorMessage(mcpError, toolName);
    throw new Error(formattedMessage);
  }
}

// Note: ErrorHandler should be instantiated with a proper logger, not exported as singleton
