import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toInputSchema } from './schema.js';

describe('toInputSchema', () => {
  it('produces an object schema with properties and a required array', () => {
    const json = toInputSchema(z.object({ name: z.string() }));
    expect(json.type).toBe('object');
    expect(json.properties).toBeTypeOf('object');
    expect(Array.isArray(json.required)).toBe(true);
  });

  it('strips the $schema dialect marker', () => {
    const json = toInputSchema(z.object({ name: z.string() }));
    expect(json.$schema).toBeUndefined();
  });

  it('carries field descriptions through to the JSON Schema', () => {
    const json = toInputSchema(z.object({ query: z.string().describe('Search query to run') }));
    expect((json.properties as any).query.description).toBe('Search query to run');
  });

  it('treats .default() fields as optional (input mode) and advertises the default', () => {
    const json = toInputSchema(
      z.object({
        query: z.string(),
        limit: z.number().min(1).max(50).default(50),
      })
    );
    // The advertised default is the SAME value the handler enforces — this is the
    // whole point of generating from one schema.
    expect((json.properties as any).limit.default).toBe(50);
    expect((json.properties as any).limit.minimum).toBe(1);
    expect((json.properties as any).limit.maximum).toBe(50);
    // A defaulted field is not required in input mode.
    expect(json.required).toEqual(['query']);
  });

  it('normalises an all-optional schema to required: []', () => {
    const json = toInputSchema(z.object({ a: z.string().optional() }));
    expect(json.required).toEqual([]);
  });

  it('preserves required-key order', () => {
    const json = toInputSchema(
      z.object({ packId: z.string(), itemId: z.string(), compact: z.boolean().optional() })
    );
    expect(json.required).toEqual(['packId', 'itemId']);
  });

  it('emits enums and array constraints', () => {
    const json = toInputSchema(
      z.object({
        size: z.enum(['small', 'large']),
        ids: z.array(z.string()).min(1),
      })
    );
    expect((json.properties as any).size.enum).toEqual(['small', 'large']);
    expect((json.properties as any).ids.type).toBe('array');
  });

  it('emits tuples in JSON Schema 2020-12 form (prefixItems, not the draft-7 items array)', () => {
    // The Anthropic API validates every tool input_schema as draft 2020-12 and 400s the ENTIRE
    // request if one is invalid — bricking the session the moment that tool loads. zod's draft-7
    // target emitted the draft-7 tuple shape (`items: [schemaA, schemaB]` + `additionalItems`),
    // which is invalid 2020-12; that bricked a live session via create-rolltable's `range` tuple.
    // 2020-12 uses `prefixItems`. This locks the helper to the dialect the API actually enforces.
    const json = toInputSchema(z.object({ range: z.tuple([z.number().int(), z.number().int()]) }));
    const range = (json.properties as any).range;
    expect(range.type).toBe('array');
    expect(Array.isArray(range.prefixItems)).toBe(true);
    expect(range.prefixItems).toHaveLength(2);
    // The draft-7 forms that the API rejects must be absent.
    expect(Array.isArray(range.items)).toBe(false);
    expect(range.additionalItems).toBeUndefined();
  });
});
