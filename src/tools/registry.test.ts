/**
 * Registration ↔ dispatch integrity.
 *
 * The tool surface is built by buildToolRegistry (src/registry.ts): the `handlers` map is the
 * single source of truth and the advertised `tools` list is DERIVED from it, so a tool can no
 * longer be advertised-but-not-dispatched. This test imports the real builder (no source scraping)
 * and asserts the surface is complete, consistent, and the documented size. buildToolRegistry
 * itself throws at build time if a handler has no advertised definition, so a successful build is
 * already part of the guarantee.
 */

import { describe, it, expect } from 'vitest';
import { buildToolRegistry } from '../registry.js';
import { makeFoundry, makeLogger } from './test-helpers.js';

function build() {
  const { foundry } = makeFoundry();
  return buildToolRegistry({ foundry, logger: makeLogger() });
}

// Recursively flag the JSON-Schema constructs that are valid in draft-7 but invalid under draft
// 2020-12 — the dialect the Anthropic API enforces on tool input_schema. zod's generator can only
// realistically emit these via `z.tuple(...)`: the draft-7 tuple uses an `items` ARRAY plus
// `additionalItems`, whereas 2020-12 uses `prefixItems` (and folds `additionalItems` into `items`).
// Returns a list of `path: reason` strings; empty means the schema is 2020-12-clean.
function draft2020Violations(node: unknown, path: string): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => draft2020Violations(child, `${path}[${i}]`));
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const here: string[] = [];
    if (Array.isArray(obj.items)) {
      here.push(`${path}.items: array (draft-7 tuple form; 2020-12 uses prefixItems)`);
    }
    if ('additionalItems' in obj) {
      here.push(`${path}.additionalItems: present (removed in 2020-12)`);
    }
    return here.concat(
      Object.entries(obj).flatMap(([k, v]) => draft2020Violations(v, `${path}.${k}`))
    );
  }
  return [];
}

describe('tool registry', () => {
  it('advertises 80 uniquely-named tools (matches the documented surface)', () => {
    const { tools } = build();
    const names = tools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
    expect(names.length).toBe(80);
  });

  it('advertises the actor-editing tools by name', () => {
    const { tools } = build();
    const names = new Set(tools.map(t => t.name));
    expect(names.has('update-actor')).toBe(true);
    expect(names.has('update-actor-item')).toBe(true);
    expect(names.has('manage-activity')).toBe(true);
    expect(names.has('manage-effect')).toBe(true);
    expect(names.has('apply-condition')).toBe(true);
    expect(names.has('add-item')).toBe(true);
    expect(names.has('import-item')).toBe(true);
  });

  it('advertises the unified actor-authoring tool as add-feature (renamed from grant-to-actor)', () => {
    const { tools } = build();
    const names = new Set(tools.map(t => t.name));
    expect(names.has('add-feature')).toBe(true);
    expect(names.has('grant-to-actor')).toBe(false); // old name fully retired
  });

  it('advertises the six chat-log tools by name', () => {
    const { tools } = build();
    const names = new Set(tools.map(t => t.name));
    for (const name of [
      'send-chat-message',
      'list-chat-messages',
      'delete-chat-messages',
      'export-chat-log',
      'post-item-card',
      'request-roll',
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it('every advertised tool has a handler, and every handler is advertised', () => {
    const { tools, handlers } = build();
    const advertised = new Set(tools.map(t => t.name));
    const handlerNames = new Set(Object.keys(handlers));

    const advertisedWithoutHandler = [...advertised].filter(n => !handlerNames.has(n));
    const handlerWithoutDefinition = [...handlerNames].filter(n => !advertised.has(n));
    expect(advertisedWithoutHandler).toEqual([]);
    expect(handlerWithoutDefinition).toEqual([]);
  });

  it('every advertised tool carries a name + inputSchema', () => {
    const { tools } = build();
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it('every advertised tool input schema is valid JSON Schema 2020-12 (no draft-7-only constructs)', () => {
    // The Anthropic API validates each tool input_schema as JSON Schema draft 2020-12 and 400s the
    // ENTIRE request — not just the call — if any one is invalid, silently bricking the session the
    // moment that tool enters the tool list (this actually happened: create-rolltable's `range`
    // tuple emitted the draft-7 `items: [..]` shape and bricked a live session). Sweep every
    // advertised schema for the 2020-12-incompatible constructs zod's generator can emit so a bad
    // dialect can never silently ship again.
    const { tools } = build();
    const offenders = tools.flatMap(t => draft2020Violations(t.inputSchema, t.name));
    expect(offenders).toEqual([]);
  });

  it('dispatch routes a known tool to the bridge and rejects an unknown one', async () => {
    const { foundry, calls } = makeFoundry({ system: 'dnd5e' });
    const { dispatch } = buildToolRegistry({ foundry, logger: makeLogger() });

    await dispatch('get-world-info', {});
    expect(calls.some(([op]) => op === 'getWorldInfo')).toBe(true);

    await expect(dispatch('no-such-tool', {})).rejects.toThrow(/Unknown tool/);
  });
});
