/**
 * Unit tests for ErrorHandler — the keyword-based classifier EVERY tool failure routes through, in
 * exactly one place (the central dispatch wrapper in index.ts). Tools no longer map their own
 * errors; they throw FormattedToolError for curated messages and let everything else bubble here.
 * Pure and order-dependent, so tested directly.
 */

import { describe, it, expect } from 'vitest';
import { ErrorHandler } from './error-handler.js';

// Minimal logger stub — ErrorHandler only needs child()/warn/error.
const noopLogger: any = {
  child: () => noopLogger,
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const eh = new ErrorHandler(noopLogger);

describe('ErrorHandler.toUserMessage — enriches bridge/permission/validation failures', () => {
  it('maps connection/cold-box errors to actionable wake guidance', () => {
    const msg = eh.toUserMessage(new Error('net::ERR_CONNECTION_REFUSED'), 'list-actors');
    expect(msg).toContain('Connection to the Foundry world failed');
    expect(msg).toContain('MOLTEN_MAGIC_URL');
  });

  it('maps permission errors', () => {
    const msg = eh.toUserMessage(new Error('User lacks permission for this'), 'create-item');
    expect(msg).toContain('Permission denied for this operation');
  });

  it('adds the search-compendium tip on validation errors across the actor-creation family', () => {
    // The tip fires for both split tools. (The base message differs by branch:
    // 'create-actor-from-compendium' contains the substring "compendium", so the classifier picks
    // the more-specific "Creature not found" wording — fine.)
    for (const tool of ['create-actor-from-compendium', 'author-npc']) {
      const msg = eh.toUserMessage(new Error('actor not found'), tool);
      expect(msg).toContain('use search-compendium first to see available creatures');
    }
    // ...but not for an unrelated tool.
    const other = eh.toUserMessage(new Error('actor not found'), 'update-actor');
    expect(other).not.toContain('use search-compendium first');
  });
});

describe('ErrorHandler.toUserMessage — never degrades already-specific messages', () => {
  it('passes ZodError messages through verbatim (not flattened to the validation template)', () => {
    const zodish = Object.assign(new Error('Invalid input: expected string, received number'), {
      name: 'ZodError',
    });
    expect(eh.toUserMessage(zodish, 'create-actor-from-compendium')).toBe(
      'Invalid input: expected string, received number'
    );
  });

  it('falls back to the raw message for unclassifiable errors (not "An unexpected error occurred")', () => {
    const msg = eh.toUserMessage(new Error('kaboom widget malfunction'), 'roll-on-table');
    expect(msg).toBe('kaboom widget malfunction');
  });

  it('handles non-Error throwables', () => {
    expect(eh.toUserMessage('a string was thrown', 'x')).toBe('a string was thrown');
  });
});

describe('ErrorHandler.mapFoundryError — classification order', () => {
  it('classifies a creature lookup in a compendium context as a creature-not-found validation', () => {
    const mapped = eh.mapFoundryError(new Error('not found'), 'search-compendium creature');
    expect(mapped.type).toBe('validation');
    expect(mapped.message).toBe('Creature not found in compendiums');
  });

  it('prefers permission over the generic system fallback', () => {
    expect(eh.mapFoundryError(new Error('access denied'), 'x').type).toBe('permission');
  });

  it('falls back to a non-recoverable system error for unknown messages', () => {
    const mapped = eh.mapFoundryError(new Error('???'), 'x');
    expect(mapped.type).toBe('system');
    expect(mapped.recoverable).toBe(false);
  });
});
