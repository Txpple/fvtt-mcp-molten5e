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
import { clearSystemCache } from '../utils/system-detection.js';
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
  it('advertises 133 uniquely-named tools (matches the documented surface)', () => {
    const { tools } = build();
    const names = tools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
    // 115 as of the tiles/lights focus set, + the placeable-library completion (14):
    // + create/list/update/delete-sounds (AmbientSound CRUD)
    // + create/list/update/delete-drawings (Drawing CRUD)
    // + create/list/update/delete-walls (Wall CRUD — doors/sight edit loop)
    // + place-tokens + delete-tokens (placed-token lifecycle; update-token stays bespoke)
    // + list-folders (the folder-tree read/inspect step the write tools were missing)
    // + list-users + update-user (user-account admin: roster read + role/name/color/character)
    // + add-free-cast (feature-granted free casting lives ON the spell — the HM pattern)
    expect(names.length).toBe(133);
  });

  it('registers parse-ddb-character (the DDB import parse tool, design.md §7)', () => {
    const { tools, handlers } = build();
    expect(tools.map(t => t.name)).toContain('parse-ddb-character');
    expect(typeof handlers['parse-ddb-character']).toBe('function');
  });

  it('registers read-pack (the Node-only scene-pack module reader, tom-cartos-import M1)', () => {
    const { tools, handlers } = build();
    expect(tools.map(t => t.name)).toContain('read-pack');
    expect(typeof handlers['read-pack']).toBe('function');
  });

  it('registers remap-teleporters (the scene-pack teleporter remap pass, tom-cartos-import M3)', () => {
    const { tools, handlers } = build();
    expect(tools.map(t => t.name)).toContain('remap-teleporters');
    expect(typeof handlers['remap-teleporters']).toBe('function');
  });

  it('registers the legend→pins tools (get-scene-dimensions + create-scene-notes, tom-cartos-import M4)', () => {
    const { tools, handlers } = build();
    const names = new Set(tools.map(t => t.name));
    expect(names.has('get-scene-dimensions')).toBe(true);
    expect(names.has('create-scene-notes')).toBe(true);
    expect(typeof handlers['get-scene-dimensions']).toBe('function');
    expect(typeof handlers['create-scene-notes']).toBe('function');
  });

  it('registers the map-note pin-nudge tools (update-note + delete-note, tom-cartos-import M6)', () => {
    const { tools, handlers } = build();
    const names = new Set(tools.map(t => t.name));
    expect(names.has('update-note')).toBe(true);
    expect(names.has('delete-note')).toBe(true);
    expect(typeof handlers['update-note']).toBe('function');
    expect(typeof handlers['delete-note']).toBe('function');
  });

  it('registers screenshot-scene (headless canvas capture for visual QA)', () => {
    const { tools, handlers } = build();
    expect(tools.map(t => t.name)).toContain('screenshot-scene');
    expect(typeof handlers['screenshot-scene']).toBe('function');
  });

  it('registers the region/teleporter authoring tools (existing-scene regions)', () => {
    const { tools, handlers } = build();
    const names = new Set(tools.map(t => t.name));
    for (const name of [
      'create-teleporter',
      'create-region',
      'list-regions',
      'update-region',
      'delete-region',
    ]) {
      expect(names.has(name)).toBe(true);
      expect(typeof handlers[name]).toBe('function');
    }
  });

  it('registers update-token (placed-token instance editor)', () => {
    const { tools, handlers } = build();
    expect(tools.map(t => t.name)).toContain('update-token');
    expect(typeof handlers['update-token']).toBe('function');
  });

  it('registers the placeable CRUD tools (Tile + Light full CRUD, Token/Note list) over the kernel', () => {
    const { tools, handlers } = build();
    const names = new Set(tools.map(t => t.name));
    for (const name of [
      'create-tiles',
      'list-tiles',
      'update-tiles',
      'delete-tiles',
      'create-lights',
      'list-lights',
      'update-lights',
      'delete-lights',
      'list-tokens',
      'list-notes',
    ]) {
      expect(names.has(name)).toBe(true);
      expect(typeof handlers[name]).toBe('function');
    }
  });

  it('registers the journal page-visibility tools + update-folder (dogfood tooling gaps)', () => {
    const { tools, handlers } = build();
    const names = new Set(tools.map(t => t.name));
    for (const name of ['set-journal-page-visibility', 'delete-journal-page', 'update-folder']) {
      expect(names.has(name)).toBe(true);
      expect(typeof handlers[name]).toBe('function');
    }
  });

  it('advertises the actor-creation split and fully retires the create-actor alias', () => {
    const { tools } = build();
    const names = new Set(tools.map(t => t.name));
    expect(names.has('create-actor-from-compendium')).toBe(true);
    expect(names.has('author-npc')).toBe(true);
    expect(names.has('create-actor')).toBe(false); // deprecated alias removed
  });

  it('advertises the PC-authoring tools (siblings to author-npc, design.md §7)', () => {
    const { tools } = build();
    const names = new Set(tools.map(t => t.name));
    expect(names.has('create-pc')).toBe(true);
    expect(names.has('inspect-pc-advancement')).toBe(true);
    expect(names.has('level-up-pc')).toBe(true);
    expect(names.has('create-pc-from-prefab')).toBe(true);
    // create-pc's `choices` map is a nested z.record (level → adv-id → data), NOT a zod tuple —
    // the 2020-12-validity sweep above guards it, but pin the advertised shape too.
    const createPc = tools.find(t => t.name === 'create-pc') as any;
    expect(createPc.inputSchema.type).toBe('object');
    expect(createPc.inputSchema.required).toEqual(['name', 'className']);
    expect(Object.keys(createPc.inputSchema.properties)).toContain('choices');
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

  it("generates add-feature's schema from zod with the mode enum + the dispatch properties", () => {
    // The schema is now generated from one zod wrapper (no hand-written JSON). The registry handler
    // dispatches on these exact properties, so lock them in.
    const { tools } = build();
    const af = tools.find(t => t.name === 'add-feature') as any;
    expect(af.inputSchema.type).toBe('object');
    expect(af.inputSchema.required).toEqual(['actorIdentifier', 'mode']);
    expect(Object.keys(af.inputSchema.properties).sort()).toEqual([
      'actorIdentifier',
      'compendiumFeatures',
      'feature',
      'items',
      'mode',
    ]);
    expect(af.inputSchema.properties.mode.enum).toEqual([
      'compendium-features',
      'feature',
      'items',
    ]);
    // items[] composes the canonical ItemTools zod (item shape with name+type required).
    expect(af.inputSchema.properties.items.type).toBe('array');
    expect(af.inputSchema.properties.items.items.required).toEqual(['name', 'type']);
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

  it('dispatches the actor-creation split to the right page ops; the retired alias is unknown', async () => {
    // The sharpest trap is the arg asymmetry: author-npc takes a FLAT stat block (the removed
    // create-actor alias used to unwrap args.statBlock). Exercise both routes, assert which page op
    // each reaches, and confirm the retired alias no longer dispatches.
    clearSystemCache(); // author-npc → assertDnd5e probes getWorldInfo (cached module-globally)
    const { foundry, calls } = makeFoundry((name: string) => {
      if (name === 'getWorldInfo') return { system: 'dnd5e' };
      if (name === 'createActorFromCompendium')
        return { success: true, totalCreated: 1, totalRequested: 1, actors: [{ name: 'X' }] };
      if (name === 'createNpcActor') return { actor: { id: 'a1', name: 'Goblin' } };
      return {};
    });
    const { dispatch } = buildToolRegistry({ foundry, logger: makeLogger() });

    const compendiumArgs = {
      packId: 'dnd-monster-manual.actors',
      itemId: 'owlbear',
      names: ['Hoot'],
    };
    const statBlock = {
      name: 'Goblin',
      creatureType: 'humanoid',
      size: 'small',
      cr: '1/4',
      hpAverage: 7,
      hpFormula: '2d6',
      acMode: 'default',
      abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    };

    await dispatch('create-actor-from-compendium', compendiumArgs);
    await dispatch('author-npc', statBlock); // FLAT
    await expect(
      dispatch('create-actor', { source: 'compendium', ...compendiumArgs })
    ).rejects.toThrow(/Unknown tool/);

    const ops = calls.map(([op]) => op);
    expect(ops.filter(op => op === 'createActorFromCompendium').length).toBe(1);
    expect(ops.filter(op => op === 'createNpcActor').length).toBe(1);
  });

  it('dispatches the PC tools to their page ops (createPcActor / inspectAdvancementChoices)', async () => {
    clearSystemCache(); // assertDnd5e probes getWorldInfo (cached module-globally)
    const { foundry, calls } = makeFoundry((name: string) => {
      if (name === 'getWorldInfo') return { system: 'dnd5e' };
      if (name === 'createPcActor')
        return {
          success: true,
          actor: { id: 'p1', name: 'Aria', className: 'Wizard', level: 1, hp: 8 },
        };
      if (name === 'inspectAdvancementChoices')
        return { class: { name: 'Wizard' }, level: 1, choices: [], spellcasting: 'full' };
      if (name === 'levelUpPc')
        return {
          success: true,
          actor: {
            id: 'p1',
            name: 'Aria',
            className: 'Wizard',
            level: 2,
            classLevel: 2,
            hp: 14,
            classes: [{ name: 'Wizard', levels: 2 }],
          },
        };
      if (name === 'createPcFromPrefab')
        return {
          success: true,
          from: 'Fighter',
          actor: { id: 'p2', name: 'Borin', className: 'Fighter', level: 1, hp: 12 },
        };
      return {};
    });
    const { dispatch } = buildToolRegistry({ foundry, logger: makeLogger() });

    await dispatch('create-pc', { name: 'Aria', className: 'Wizard' });
    await dispatch('inspect-pc-advancement', { className: 'Wizard' });
    await dispatch('level-up-pc', { actorIdentifier: 'Aria', className: 'Wizard' });
    await dispatch('create-pc-from-prefab', { name: 'Borin', prefab: 'Fighter' });

    const ops = calls.map(([op]) => op);
    expect(ops.filter(op => op === 'createPcActor').length).toBe(1);
    expect(ops.filter(op => op === 'inspectAdvancementChoices').length).toBe(1);
    expect(ops.filter(op => op === 'levelUpPc').length).toBe(1);
    expect(ops.filter(op => op === 'createPcFromPrefab').length).toBe(1);
  });
});
