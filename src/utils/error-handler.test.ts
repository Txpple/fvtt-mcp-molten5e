/**
 * Unit tests for ErrorHandler — the keyword-based classifier every tool failure now routes through
 * (centrally in index.ts, plus the five tools that curate their own errors). Previously untested
 * despite being pure and order-dependent.
 */

import { describe, it, expect } from 'vitest';
import { ErrorHandler, FormattedToolError } from './error-handler.js';

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

  it('adds the create-actor tip on validation errors for that tool', () => {
    const msg = eh.toUserMessage(new Error('actor not found'), 'create-actor');
    expect(msg).toContain('Invalid request or missing data');
    expect(msg).toContain('search-compendium');
  });
});

describe('ErrorHandler.toUserMessage — never degrades already-specific messages', () => {
  it('passes ZodError messages through verbatim (not flattened to the validation template)', () => {
    const zodish = Object.assign(new Error('Invalid input: expected string, received number'), {
      name: 'ZodError',
    });
    expect(eh.toUserMessage(zodish, 'create-actor')).toBe(
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

describe('ErrorHandler.handleToolError', () => {
  it('throws a FormattedToolError carrying the curated message', () => {
    expect(() => eh.handleToolError(new Error('access denied'), 'create-actor', 'ctx')).toThrow(
      FormattedToolError
    );
    try {
      eh.handleToolError(new Error('access denied'), 'create-actor', 'ctx');
    } catch (e) {
      expect((e as Error).message).toContain('Permission denied');
      expect(e).toBeInstanceOf(Error);
    }
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
