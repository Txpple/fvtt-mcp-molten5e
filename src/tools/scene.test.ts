/**
 * Unit tests for SceneTools (get-current-scene, get-world-info).
 *
 * These handlers own two things before/after the bridge:
 *   1. zod input parsing (booleans with defaults — no required fields).
 *   2. response shaping — the structured object built from the bridge result,
 *      including token formatting, disposition mapping, note truncation, and
 *      the user roll-ups for world info.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SceneTools } from './scene.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new SceneTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('SceneTools.getToolDefinitions', () => {
  it('exposes the scene reads + authoring tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(
      [
        'create-region',
        'create-scene',
        'create-scene-notes',
        'create-teleporter',
        'delete-note',
        'delete-region',
        'delete-scene',
        'get-current-scene',
        'get-scene-dimensions',
        'get-world-info',
        'list-regions',
        'list-scenes',
        'remap-teleporters',
        'screenshot-scene',
        'update-note',
        'update-region',
        'update-scene',
        'update-token',
      ].sort()
    );
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('handleGetCurrentScene', () => {
  const sceneData = {
    id: 'scene1',
    name: 'Tavern',
    active: true,
    width: 4000,
    height: 3000,
    padding: 0.25,
    background: 'tavern.webp',
    navigation: true,
    walls: 12,
    lights: 3,
    sounds: 1,
    notes: [{ id: 'n1', text: 'A short note', x: 10, y: 20 }],
    tokens: [
      {
        id: 't1',
        name: 'Bartender',
        x: 100,
        y: 200,
        width: 1,
        height: 1,
        actorId: 'a1',
        disposition: 1,
        hidden: false,
        img: 'bartender.webp',
      },
      {
        id: 't2',
        name: 'Sneak Thief',
        x: 300,
        y: 400,
        width: 1,
        height: 1,
        actorId: null,
        disposition: -1,
        hidden: true,
        img: null,
      },
    ],
  };

  it('forwards the getActiveScene bridge call', async () => {
    const { tools, calls } = build(sceneData);
    await tools.handleGetCurrentScene({});
    expect(calls[0][0]).toBe('getActiveScene');
  });

  it('shapes the scene response with dimensions, elements and background flag', async () => {
    const { tools } = build(sceneData);
    const out = await tools.handleGetCurrentScene({});
    expect(out.id).toBe('scene1');
    expect(out.name).toBe('Tavern');
    expect(out.active).toBe(true);
    expect(out.dimensions).toEqual({ width: 4000, height: 3000, padding: 0.25 });
    expect(out.hasBackground).toBe(true);
    expect(out.navigation).toBe(true);
    expect(out.elements).toEqual({ walls: 12, lights: 3, sounds: 1, notes: 1 });
  });

  it('includes tokens and a token summary by default, excluding hidden tokens', async () => {
    const { tools } = build(sceneData);
    const out = await tools.handleGetCurrentScene({});
    // includeTokens defaults true, includeHidden defaults false → only t1
    expect(out.tokens).toHaveLength(1);
    expect(out.tokens[0]).toMatchObject({
      id: 't1',
      name: 'Bartender',
      position: { x: 100, y: 200 },
      size: { width: 1, height: 1 },
      actorId: 'a1',
      disposition: 'friendly',
      hidden: false,
      hasImage: true,
    });
    expect(out.tokenSummary).toMatchObject({
      total: 1,
      byDisposition: { friendly: 1, neutral: 0, hostile: 0, unknown: 0 },
      hasActors: 1,
      withoutActors: 0,
    });
  });

  it('includes hidden tokens and maps their disposition when includeHidden is true', async () => {
    const { tools } = build(sceneData);
    const out = await tools.handleGetCurrentScene({ includeHidden: true });
    expect(out.tokens).toHaveLength(2);
    const thief = out.tokens.find((t: any) => t.id === 't2');
    expect(thief.disposition).toBe('hostile');
    expect(thief.hasImage).toBe(false);
    expect(out.tokenSummary).toMatchObject({
      total: 2,
      byDisposition: { friendly: 1, neutral: 0, hostile: 1, unknown: 0 },
      hasActors: 1,
      withoutActors: 1,
    });
  });

  it('omits tokens entirely when includeTokens is false', async () => {
    const { tools } = build(sceneData);
    const out = await tools.handleGetCurrentScene({ includeTokens: false });
    expect(out.tokens).toBeUndefined();
    expect(out.tokenSummary).toBeUndefined();
  });

  it('formats notes with position', async () => {
    const { tools } = build(sceneData);
    const out = await tools.handleGetCurrentScene({});
    expect(out.notes).toEqual([{ id: 'n1', text: 'A short note', position: { x: 10, y: 20 } }]);
  });

  it('truncates long note text to 100 chars with an ellipsis', async () => {
    const longText = 'x'.repeat(150);
    const { tools } = build({ ...sceneData, notes: [{ id: 'n1', text: longText, x: 0, y: 0 }] });
    const out = await tools.handleGetCurrentScene({});
    expect(out.notes[0].text).toHaveLength(100);
    expect(out.notes[0].text.endsWith('...')).toBe(true);
  });

  it('rejects a non-boolean includeTokens', async () => {
    const { tools } = build();
    await expect(tools.handleGetCurrentScene({ includeTokens: 'yes' })).rejects.toThrow();
  });

  it('wraps bridge errors with a descriptive message', async () => {
    const { foundry, calls } = makeFoundry(() => {
      throw new Error('no active scene');
    });
    const tools = new SceneTools({ foundry, logger: makeLogger() });
    await expect(tools.handleGetCurrentScene({})).rejects.toThrow(
      'Failed to get current scene: no active scene'
    );
    expect(calls[0][0]).toBe('getActiveScene');
  });
});

describe('handleGetWorldInfo', () => {
  const worldData = {
    id: 'world1',
    title: 'My Test World',
    system: 'dnd5e',
    systemVersion: '5.3.3',
    foundryVersion: '14.364',
    users: [
      { id: 'u1', name: 'GM', isGM: true, active: true },
      { id: 'u2', name: 'Alice', isGM: false, active: true },
      { id: 'u3', name: 'Bob', isGM: false, active: false },
    ],
  };

  it('forwards the getWorldInfo bridge call', async () => {
    const { tools, calls } = build(worldData);
    await tools.handleGetWorldInfo({});
    expect(calls[0][0]).toBe('getWorldInfo');
  });

  it('shapes the world response with system, foundry and user roll-ups', async () => {
    const { tools } = build(worldData);
    const out = await tools.handleGetWorldInfo({});
    expect(out.id).toBe('world1');
    expect(out.title).toBe('My Test World');
    expect(out.system).toEqual({ id: 'dnd5e', version: '5.3.3' });
    expect(out.foundry).toEqual({ version: '14.364' });
    expect(out.users).toEqual({ total: 3, active: 2, gms: 1, players: 2 });
  });

  it('lists only active users in activeUsers', async () => {
    const { tools } = build(worldData);
    const out = await tools.handleGetWorldInfo({});
    expect(out.activeUsers).toEqual([
      { id: 'u1', name: 'GM', isGM: true },
      { id: 'u2', name: 'Alice', isGM: false },
    ]);
  });

  it('defaults user counts to zero when no users are present', async () => {
    const { tools } = build({ id: 'w', title: 't', system: 'dnd5e' });
    const out = await tools.handleGetWorldInfo({});
    expect(out.users).toEqual({ total: 0, active: 0, gms: 0, players: 0 });
    expect(out.activeUsers).toEqual([]);
  });

  it('wraps bridge errors with a descriptive message', async () => {
    const { foundry } = makeFoundry(() => {
      throw new Error('bridge down');
    });
    const tools = new SceneTools({ foundry, logger: makeLogger() });
    await expect(tools.handleGetWorldInfo({})).rejects.toThrow(
      'Failed to get world information: bridge down'
    );
  });
});

describe('handleCreateScene', () => {
  it('forwards a valid scene and formats result', async () => {
    const { tools, calls } = build({
      sceneName: 'Cavern',
      sceneId: 'sc1',
      active: false,
      background: 'maps/cavern.webp',
    });
    const out = await tools.handleCreateScene({
      name: 'Cavern',
      backgroundPath: 'maps/cavern.webp',
    });
    expect(calls[0][0]).toBe('createScene');
    expect(calls[0][1]).toMatchObject({
      name: 'Cavern',
      backgroundPath: 'maps/cavern.webp',
      activate: false,
    });
    expect(out).toBe('Created scene "Cavern" (sc1)\n  background: maps/cavern.webp');
  });

  it('appends [active] when the scene is activated', async () => {
    const { tools } = build({ sceneName: 'C', sceneId: 'sc1', active: true, background: 'b.webp' });
    const out = await tools.handleCreateScene({
      name: 'C',
      backgroundPath: 'b.webp',
      activate: true,
    });
    expect(out).toBe('Created scene "C" (sc1) [active]\n  background: b.webp');
  });

  it('rejects an empty name', async () => {
    const { tools } = build();
    await expect(tools.handleCreateScene({ name: '', backgroundPath: 'b.webp' })).rejects.toThrow();
  });

  it('rejects a missing backgroundPath', async () => {
    const { tools } = build();
    await expect(tools.handleCreateScene({ name: 'X' })).rejects.toThrow();
  });

  it('rejects a non-integer width', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateScene({ name: 'X', backgroundPath: 'b', width: 12.5 })
    ).rejects.toThrow();
  });

  it('rejects padding above 0.5', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateScene({ name: 'X', backgroundPath: 'b', padding: 0.9 })
    ).rejects.toThrow();
  });

  it('forwards the new scene fields to the bridge', async () => {
    const { tools, calls } = build({ sceneName: 'X', sceneId: 'sc1', background: 'b' });
    await tools.handleCreateScene({
      name: 'X',
      backgroundPath: 'b',
      gridDistance: 5,
      gridUnits: 'ft',
      tokenVision: true,
      fogMode: 'shared',
      darkness: 0.4,
      globalLight: false,
      weather: 'snow',
      playlist: 'Ambience',
      journal: 'Read-Aloud',
    });
    expect(calls[0][1]).toMatchObject({
      gridDistance: 5,
      gridUnits: 'ft',
      tokenVision: true,
      fogMode: 'shared',
      darkness: 0.4,
      globalLight: false,
      weather: 'snow',
      playlist: 'Ambience',
      journal: 'Read-Aloud',
    });
  });

  it('rejects an invalid fogMode', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateScene({ name: 'X', backgroundPath: 'b', fogMode: 'sometimes' })
    ).rejects.toThrow();
  });

  it('rejects darkness above 1', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateScene({ name: 'X', backgroundPath: 'b', darkness: 2 })
    ).rejects.toThrow();
  });

  it('reports auto-detected dimensions and effective settings', async () => {
    const { tools } = build({
      sceneName: 'Cavern',
      sceneId: 'sc1',
      background: 'maps/cavern.webp',
      width: 4000,
      height: 3000,
      autoSized: true,
      settings: {
        grid: { size: 100, type: 1, distance: 5, units: 'ft' },
        tokenVision: true,
        fogMode: 'individual',
        darkness: 0.5,
        globalLight: false,
        weather: 'fog',
        playlist: null,
        journal: null,
      },
    });
    const out = await tools.handleCreateScene({
      name: 'Cavern',
      backgroundPath: 'maps/cavern.webp',
    });
    expect(out).toContain('dimensions: 4000×3000px (auto from image)');
    expect(out).toContain('grid 100px = 5 ft');
    expect(out).toContain('vision on');
    expect(out).toContain('fog individual');
    expect(out).toContain('darkness 0.5');
    expect(out).toContain('weather fog');
    expect(out).not.toContain('global light on');
  });

  it('forwards folder + navigation to the bridge', async () => {
    const { tools, calls } = build({ sceneName: 'X', sceneId: 'sc1', background: 'b' });
    await tools.handleCreateScene({
      name: 'X',
      backgroundPath: 'b',
      folder: 'Maps',
      navigation: false,
    });
    expect(calls[0][1]).toMatchObject({ folder: 'Maps', navigation: false });
  });

  it('reports the folder and an auto-generated thumbnail', async () => {
    const { tools } = build({
      sceneName: 'X',
      sceneId: 'sc1',
      background: 'b',
      folderName: 'Maps',
      autoThumbnail: true,
    });
    const out = await tools.handleCreateScene({ name: 'X', backgroundPath: 'b', folder: 'Maps' });
    expect(out).toContain('folder: Maps');
    expect(out).toContain('thumbnail: auto-generated');
  });

  it('renders gridless + navigation state in the settings line', async () => {
    const { tools } = build({
      sceneName: 'World',
      sceneId: 'sc1',
      background: 'b',
      settings: {
        grid: { size: 100, type: 0, distance: 5, units: 'ft' },
        tokenVision: false,
        fogMode: 'disabled',
        navigation: false,
        globalLight: true,
        weather: '',
        playlist: null,
        journal: null,
      },
    });
    const out = await tools.handleCreateScene({ name: 'World', backgroundPath: 'b' });
    expect(out).toContain('gridless');
    expect(out).not.toContain('grid 100px');
    expect(out).toContain('nav off');
  });

  it('reads walls/lights from placeablesPath server-side and strips the path before the bridge call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-scene-test-'));
    const file = join(dir, 'p.json');
    writeFileSync(
      file,
      JSON.stringify({
        walls: [{ c: [0, 0, 5, 5], sight: 20 }],
        lights: [{ x: 1, y: 2, config: { dim: 30 } }],
      })
    );
    const { tools, calls } = build({ sceneName: 'P', sceneId: 'sc1', background: 'b' });
    await tools.handleCreateScene({ name: 'P', backgroundPath: 'b', placeablesPath: file });
    const sent = calls[0][1];
    expect(sent.walls).toHaveLength(1);
    expect(sent.walls[0].c).toEqual([0, 0, 5, 5]);
    expect(sent.lights).toHaveLength(1);
    expect(sent).not.toHaveProperty('placeablesPath'); // page-side createScene never sees it
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges placeablesPath walls/lights after any inline ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-scene-test-'));
    const file = join(dir, 'p.json');
    writeFileSync(file, JSON.stringify({ walls: [{ c: [9, 9, 9, 9], sight: 10 }], lights: [] }));
    const { tools, calls } = build({ sceneName: 'P', sceneId: 'sc1', background: 'b' });
    await tools.handleCreateScene({
      name: 'P',
      backgroundPath: 'b',
      walls: [{ c: [0, 0, 1, 1], sight: 20 }],
      placeablesPath: file,
    });
    expect(calls[0][1].walls).toHaveLength(2); // inline + file
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws a clear error when placeablesPath cannot be read', async () => {
    const { tools } = build({ sceneName: 'P', sceneId: 'sc1', background: 'b' });
    await expect(
      tools.handleCreateScene({
        name: 'P',
        backgroundPath: 'b',
        placeablesPath: 'C:/no/such/file.json',
      })
    ).rejects.toThrow(/could not read placeablesPath/);
  });

  it('reads regions from placeablesPath server-side and forwards them to the bridge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-scene-test-'));
    const file = join(dir, 'p.json');
    writeFileSync(
      file,
      JSON.stringify({
        walls: [],
        lights: [],
        regions: [{ _id: 'reg1', name: 'Stairs', shapes: [], behaviors: [] }],
      })
    );
    const { tools, calls } = build({ sceneName: 'P', sceneId: 'sc1', background: 'b' });
    await tools.handleCreateScene({ name: 'P', backgroundPath: 'b', placeablesPath: file });
    const sent = calls[0][1];
    expect(sent.regions).toHaveLength(1);
    expect(sent.regions[0]._id).toBe('reg1');
    expect(sent).not.toHaveProperty('placeablesPath');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports imported region count and the teleporter-remap hint', async () => {
    const { tools } = build({
      sceneName: 'Iris',
      sceneId: 'sc1',
      background: 'b',
      wallsCreated: 445,
      lightsCreated: 88,
      regionsCreated: 2,
    });
    const out = await tools.handleCreateScene({ name: 'Iris', backgroundPath: 'b' });
    expect(out).toContain('imported: 445 wall(s), 88 light(s), 2 region(s)');
    expect(out).toContain('remap-teleporters');
  });

  it('surfaces a bad-backgroundPath warning from the page result', async () => {
    const { tools } = build({
      sceneName: 'Cavern',
      sceneId: 'sc1',
      background: 'x/nope.webp',
      warnings: [
        'Supplied backgroundPath "x/nope.webp" was not found on the server — the document …',
      ],
    });
    const out = await tools.handleCreateScene({ name: 'Cavern', backgroundPath: 'x/nope.webp' });
    expect(out).toContain('warning(s):');
    expect(out).toContain('not found on the server');
  });
});

describe('handleRemapTeleporters', () => {
  it('forwards sourceModule to the bridge and summarizes the rewrite', async () => {
    const { tools, calls } = build({
      success: true,
      sourceModule: 'tom-cartos-temple',
      scenesScanned: 3,
      behaviorsScanned: 6,
      rewritten: 4,
      unchanged: 0,
      unresolved: [],
    });
    const out = await tools.handleRemapTeleporters({ sourceModule: 'tom-cartos-temple' });
    expect(calls[0][0]).toBe('remapSceneTeleporters');
    expect(calls[0][1]).toEqual({ sourceModule: 'tom-cartos-temple' });
    expect(out).toContain('Teleporter remap for "tom-cartos-temple"');
    expect(out).toContain('scenes scanned: 3');
    expect(out).toContain('teleporters rewritten: 4');
  });

  it('notes already-correct destinations and lists unresolved ones', async () => {
    const { tools } = build({
      success: true,
      sourceModule: 'm',
      scenesScanned: 2,
      rewritten: 1,
      unchanged: 2,
      unresolved: ['01 Iris: Scene.gone.Region.x'],
    });
    const out = await tools.handleRemapTeleporters({ sourceModule: 'm' });
    expect(out).toContain('(2 already correct)');
    expect(out).toContain('point outside this import');
    expect(out).toContain('01 Iris: Scene.gone.Region.x');
  });

  it('rejects an empty sourceModule', async () => {
    const { tools } = build();
    await expect(tools.handleRemapTeleporters({ sourceModule: '' })).rejects.toThrow();
  });
});

describe('handleGetSceneDimensions', () => {
  it('forwards the read and returns the geometry object', async () => {
    const { tools, calls } = build({
      found: true,
      sceneId: 'sc1',
      sceneName: 'Iris',
      width: 5320,
      height: 3640,
      sceneX: 280,
      sceneY: 280,
      sceneWidth: 4760,
      sceneHeight: 3080,
      size: 140,
      distance: 5,
    });
    const out = await tools.handleGetSceneDimensions({ sceneIdentifier: 'Iris' });
    expect(calls[0][0]).toBe('getSceneDimensions');
    expect(out).toMatchObject({ sceneX: 280, sceneY: 280, size: 140 });
  });

  it('reports a not-found scene', async () => {
    const { tools } = build({ found: false, notFound: 'Ghost' });
    const out = await tools.handleGetSceneDimensions({ sceneIdentifier: 'Ghost' });
    expect(out).toBe('Scene not found: "Ghost".');
  });

  it('rejects an empty sceneIdentifier', async () => {
    const { tools } = build();
    await expect(tools.handleGetSceneDimensions({ sceneIdentifier: '' })).rejects.toThrow();
  });
});

describe('handleCreateSceneNotes', () => {
  it('forwards the notes and summarizes how many pins landed', async () => {
    const { tools, calls } = build({
      success: true,
      sceneId: 'sc1',
      sceneName: 'Iris',
      created: 2,
    });
    const out = await tools.handleCreateSceneNotes({
      sceneIdentifier: 'Iris',
      notes: [
        { journal: 'Temple Keys', page: '1 — Entry', x: 100, y: 200, label: '1 — Entry' },
        { journal: 'Temple Keys', page: '2 — Hall', x: 300, y: 400, label: '2 — Hall' },
      ],
    });
    expect(calls[0][0]).toBe('createSceneNotes');
    expect(calls[0][1].notes).toHaveLength(2);
    expect(out).toContain('Placed 2 map-note pin(s) on "Iris" (sc1)');
  });

  it('surfaces the returned note ids (for the update/delete-note loop)', async () => {
    const { tools } = build({
      success: true,
      sceneId: 'sc1',
      sceneName: 'Iris',
      created: 1,
      notes: [{ id: 'note9', journal: 'Temple Keys', label: '1 — Entry' }],
    });
    const out = await tools.handleCreateSceneNotes({
      sceneIdentifier: 'Iris',
      notes: [{ journal: 'Temple Keys', x: 1, y: 2, label: '1 — Entry' }],
    });
    expect(out).toContain('note9');
    expect(out).toContain('1 — Entry');
  });

  it('surfaces per-note errors and the not-found scene branch', async () => {
    const { tools } = build({
      success: true,
      sceneId: 'sc1',
      sceneName: 'Iris',
      created: 1,
      errors: ['note 1 (Missing): No journal found matching "Missing"'],
    });
    const out = await tools.handleCreateSceneNotes({
      sceneIdentifier: 'Iris',
      notes: [{ journal: 'Temple Keys', x: 1, y: 2 }],
    });
    expect(out).toContain('Placed 1 map-note pin(s)');
    expect(out).toContain('⚠ note 1 (Missing)');

    const { tools: t2 } = build({ notFound: 'Ghost' });
    const out2 = await t2.handleCreateSceneNotes({
      sceneIdentifier: 'Ghost',
      notes: [{ journal: 'X', x: 1, y: 2 }],
    });
    expect(out2).toBe('Scene not found: "Ghost". No notes placed.');
  });

  it('rejects an empty notes array', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateSceneNotes({ sceneIdentifier: 'Iris', notes: [] })
    ).rejects.toThrow();
  });

  it('surfaces a dropped-icon warning from the page result', async () => {
    const { tools } = build({
      success: true,
      sceneId: 'sc1',
      sceneName: 'Iris',
      created: 1,
      warnings: [
        'Supplied icon "x/nope.webp" was not found on the server — substituted a real icon …',
      ],
    });
    const out = await tools.handleCreateSceneNotes({
      sceneIdentifier: 'Iris',
      notes: [{ journal: 'Temple Keys', x: 1, y: 2, icon: 'x/nope.webp' }],
    });
    expect(out).toContain('warning(s):');
    expect(out).toContain('not found on the server');
  });
});

describe('handleUpdateNote', () => {
  it('forwards the patch and confirms the update', async () => {
    const { tools, calls } = build({
      success: true,
      updated: true,
      sceneId: 'sc1',
      sceneName: 'Iris',
      noteId: 'note9',
    });
    const out = await tools.handleUpdateNote({
      sceneIdentifier: 'Iris',
      noteId: 'note9',
      x: 150,
      label: '1 — Antechamber',
    });
    expect(calls[0][0]).toBe('updateSceneNote');
    expect(calls[0][1]).toMatchObject({ noteId: 'note9', x: 150, label: '1 — Antechamber' });
    expect(out).toContain('Updated note note9 on "Iris" (sc1)');
  });

  it('reports not-found when the note id does not resolve', async () => {
    const { tools } = build({ success: true, updated: false, notFound: 'note9' });
    const out = await tools.handleUpdateNote({ sceneIdentifier: 'Iris', noteId: 'note9', x: 1 });
    expect(out).toBe('Note not found: "note9". Nothing changed.');
  });

  it('rejects when no updatable field is supplied (refine)', async () => {
    const { tools } = build();
    await expect(
      tools.handleUpdateNote({ sceneIdentifier: 'Iris', noteId: 'note9' })
    ).rejects.toThrow();
  });
});

describe('handleDeleteNote', () => {
  it('forwards the ids and reports the deleted count', async () => {
    const { tools, calls } = build({
      success: true,
      deleted: 2,
      sceneId: 'sc1',
      sceneName: 'Iris',
    });
    const out = await tools.handleDeleteNote({ sceneIdentifier: 'Iris', noteIds: ['a', 'b'] });
    expect(calls[0][0]).toBe('deleteSceneNotes');
    expect(calls[0][1]).toEqual({ sceneIdentifier: 'Iris', noteIds: ['a', 'b'] });
    expect(out).toContain('Deleted 2 note(s) from "Iris" (sc1)');
  });

  it('reports note ids that were not found', async () => {
    const { tools } = build({
      success: true,
      deleted: 1,
      sceneId: 'sc1',
      sceneName: 'Iris',
      notFoundIds: ['ghost'],
    });
    const out = await tools.handleDeleteNote({
      sceneIdentifier: 'Iris',
      noteIds: ['a', 'ghost'],
    });
    expect(out).toContain('1 id(s) not found: ghost');
  });

  it('reports a missing scene', async () => {
    const { tools } = build({ notFound: 'Ghost' });
    const out = await tools.handleDeleteNote({ sceneIdentifier: 'Ghost', noteIds: ['a'] });
    expect(out).toBe('Scene not found: "Ghost". Nothing deleted.');
  });

  it('rejects an empty noteIds array', async () => {
    const { tools } = build();
    await expect(
      tools.handleDeleteNote({ sceneIdentifier: 'Iris', noteIds: [] })
    ).rejects.toThrow();
  });
});

describe('handleScreenshotScene', () => {
  it('preps the scene (fit + mark) then captures to the requested path + reports metadata', async () => {
    const { tools, calls, foundry } = build({
      found: true,
      sceneId: 'sc1',
      sceneName: 'Iris',
      noteCount: 5,
      renderer: 'WebGL',
      dimensions: { width: 4760, height: 7280, sceneX: 840, sceneY: 1260 },
    });
    const out = await tools.handleScreenshotScene({
      sceneIdentifier: 'Iris',
      outputPath: '/tmp/iris.png',
      mark: true,
    });
    expect(calls[0][0]).toBe('prepareSceneShot');
    expect(calls[0][1]).toMatchObject({ sceneIdentifier: 'Iris', fit: true, mark: true });
    expect(foundry.screenshot).toHaveBeenCalledWith('/tmp/iris.png');
    expect(out).toContain('Captured "Iris" (sc1)');
    expect(out).toContain('/tmp/iris.png');
    expect(out).toContain('marked 5 note pin(s)');
    expect(out).toContain('renderer WebGL');
  });

  it('defaults the output path to a temp file named for the scene id', async () => {
    const { tools, foundry } = build({ found: true, sceneId: 'abc123', sceneName: 'X' });
    await tools.handleScreenshotScene({ sceneIdentifier: 'X' });
    expect(foundry.screenshot).toHaveBeenCalledTimes(1);
    expect((foundry.screenshot as any).mock.calls[0][0]).toMatch(/fvtt-scene-abc123\.png$/);
  });

  it('reports not-found and does NOT capture when the scene does not resolve', async () => {
    const { tools, foundry } = build({ found: false, notFound: 'Ghost' });
    const out = await tools.handleScreenshotScene({ sceneIdentifier: 'Ghost' });
    expect(out).toBe('Scene not found: "Ghost". Nothing captured.');
    expect(foundry.screenshot).not.toHaveBeenCalled();
  });

  it('rejects an empty sceneIdentifier', async () => {
    const { tools } = build();
    await expect(tools.handleScreenshotScene({ sceneIdentifier: '' })).rejects.toThrow();
  });
});

describe('handleListScenes', () => {
  it('forwards .listScenes and formats scenes with dimensions + active', async () => {
    const { tools, calls } = build([
      {
        name: 'Cavern',
        id: 'sc1',
        active: true,
        dimensions: { width: 4000, height: 3000 },
        gridSize: 100,
        background: 'maps/cavern.webp',
      },
      { name: 'Empty', id: 'sc2', active: false, gridSize: 50 },
    ]);
    const out = await tools.handleListScenes({});
    expect(calls[0][0]).toBe('listScenes');
    expect(out).toContain('Scenes (2):');
    expect(out).toContain('- "Cavern" (sc1) [active] — 4000×3000px, grid 100');
    expect(out).toContain('background: maps/cavern.webp');
    expect(out).toContain('- "Empty" (sc2) — ?px, grid 50');
  });

  it('passes filter and includeActiveOnly through', async () => {
    const { tools, calls } = build([]);
    await tools.handleListScenes({ filter: 'cav', includeActiveOnly: true });
    expect(calls[0][1]).toMatchObject({ filter: 'cav', includeActiveOnly: true });
  });

  it('reports no scenes for an empty array', async () => {
    const { tools } = build([]);
    const out = await tools.handleListScenes({});
    expect(out).toBe('No scenes found.');
  });

  it('reports no scenes for a non-array result', async () => {
    const { tools } = build(undefined);
    const out = await tools.handleListScenes({});
    expect(out).toBe('No scenes found.');
  });
});

describe('handleUpdateScene', () => {
  it('forwards a valid update and formats result', async () => {
    const { tools, calls } = build({
      updated: true,
      sceneName: 'Cavern',
      sceneId: 'sc1',
      background: 'maps/new.webp',
    });
    const out = await tools.handleUpdateScene({
      sceneIdentifier: 'sc1',
      backgroundPath: 'maps/new.webp',
    });
    expect(calls[0][0]).toBe('updateScene');
    expect(calls[0][1]).toMatchObject({ sceneIdentifier: 'sc1', backgroundPath: 'maps/new.webp' });
    expect(out).toBe('Updated scene "Cavern" (sc1)\n  background: maps/new.webp');
  });

  it('reports not-found branch when updated === false', async () => {
    const { tools } = build({ updated: false, notFound: 'Ghost' });
    const out = await tools.handleUpdateScene({ sceneIdentifier: 'Ghost' });
    expect(out).toBe('Scene not found: "Ghost". Nothing changed.');
  });

  it('rejects an empty sceneIdentifier', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateScene({ sceneIdentifier: '' })).rejects.toThrow();
  });

  it('rejects an empty backgroundPath when provided', async () => {
    const { tools } = build();
    await expect(
      tools.handleUpdateScene({ sceneIdentifier: 's', backgroundPath: '' })
    ).rejects.toThrow();
  });

  it('rejects padding above 0.5', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateScene({ sceneIdentifier: 's', padding: 0.9 })).rejects.toThrow();
  });

  it('forwards the new scene fields and clears links with ""', async () => {
    const { tools, calls } = build({
      updated: true,
      sceneName: 'C',
      sceneId: 'sc1',
      background: 'b',
    });
    await tools.handleUpdateScene({
      sceneIdentifier: 'sc1',
      darkness: 1,
      globalLight: true,
      weather: '',
      playlist: '',
      journal: 'Notes',
    });
    expect(calls[0][1]).toMatchObject({
      darkness: 1,
      globalLight: true,
      weather: '',
      playlist: '',
      journal: 'Notes',
    });
  });

  it('rejects an invalid fogMode', async () => {
    const { tools } = build();
    await expect(
      tools.handleUpdateScene({ sceneIdentifier: 's', fogMode: 'maybe' })
    ).rejects.toThrow();
  });

  it('appends effective settings to the update result', async () => {
    const { tools } = build({
      updated: true,
      sceneName: 'C',
      sceneId: 'sc1',
      background: 'b',
      settings: {
        grid: { size: 100, type: 1, distance: 5, units: 'ft' },
        tokenVision: false,
        fogMode: 'shared',
        darkness: 0,
        globalLight: true,
        weather: '',
        playlist: 'pl1',
        journal: null,
      },
    });
    const out = await tools.handleUpdateScene({ sceneIdentifier: 'sc1', globalLight: true });
    expect(out).toContain('vision off');
    expect(out).toContain('fog shared');
    expect(out).toContain('global light on');
    expect(out).toContain('playlist pl1');
    expect(out).not.toContain('darkness'); // 0 is suppressed
    expect(out).not.toContain('weather'); // empty is suppressed
  });
});

describe('handleDeleteScene', () => {
  it('forwards .deleteScenes and lists deleted', async () => {
    const { tools, calls } = build({
      deletedCount: 1,
      deleted: [{ name: 'Cavern', id: 'sc1' }],
      notFound: [],
    });
    const out = await tools.handleDeleteScene({ identifiers: ['sc1'] });
    expect(calls[0][0]).toBe('deleteScenes');
    expect(calls[0][1]).toMatchObject({ identifiers: ['sc1'] });
    expect(out).toContain('Deleted 1 scene(s):');
    expect(out).toContain('- "Cavern" (sc1)');
    expect(out).not.toContain('not found:');
  });

  it('appends not-found list when some ids do not resolve', async () => {
    const { tools } = build({ deletedCount: 0, deleted: [], notFound: ['ghost'] });
    const out = await tools.handleDeleteScene({ identifiers: ['ghost'] });
    expect(out).toContain('Deleted 0 scene(s):');
    expect(out).toContain('not found: ghost');
  });

  it('rejects an empty identifiers array', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteScene({ identifiers: [] })).rejects.toThrow();
  });

  it('rejects an identifier that is an empty string', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteScene({ identifiers: [''] })).rejects.toThrow();
  });
});

describe('handleCreateTeleporter', () => {
  it('forwards from/to + defaults (twoWay, cells, snap) and reports both regions', async () => {
    const { tools, calls } = build({
      success: true,
      twoWay: true,
      from: {
        sceneId: 's1',
        sceneName: 'Bridge',
        id: 'rA',
        name: 'A',
        behaviors: [{ type: 'teleportToken', destination: 'Scene.s2.Region.rB' }],
      },
      to: {
        sceneId: 's2',
        sceneName: 'Cave',
        id: 'rB',
        name: 'B',
        behaviors: [{ type: 'teleportToken', destination: 'Scene.s1.Region.rA' }],
      },
    });
    const out = await tools.handleCreateTeleporter({
      from: { sceneIdentifier: 'Bridge', x: 100, y: 200 },
      to: { sceneIdentifier: 'Cave', x: 300, y: 400 },
    });
    const call = calls.find(([n]) => n === 'createSceneTeleporter');
    expect(call?.[1].from).toEqual({ sceneIdentifier: 'Bridge', x: 100, y: 200 });
    expect(call?.[1].twoWay).toBe(true);
    expect(call?.[1].widthCells).toBe(1);
    expect(call?.[1].snapToGrid).toBe(true);
    expect(out).toContain('two-way teleporter');
    expect(out).toContain('rA');
    expect(out).toContain('Scene.s2.Region.rB');
  });

  it('reports a one-way teleporter with no return link', async () => {
    const { tools } = build({
      success: true,
      twoWay: false,
      from: {
        sceneId: 's1',
        sceneName: 'Bridge',
        id: 'rA',
        name: 'A',
        behaviors: [{ type: 'teleportToken', destination: 'Scene.s2.Region.rB' }],
      },
      to: { sceneId: 's2', sceneName: 'Cave', id: 'rB', name: 'B', behaviors: [] },
    });
    const out = await tools.handleCreateTeleporter({
      from: { sceneIdentifier: 'Bridge', x: 1, y: 2 },
      to: { sceneIdentifier: 'Cave', x: 3, y: 4 },
      twoWay: false,
    });
    expect(out).toContain('one-way teleporter');
    expect(out).toContain('no return link');
  });

  it('reports scene-not-found without claiming a teleporter was made', async () => {
    const { tools } = build({ success: true, notFound: 'Nowhere' });
    const out = await tools.handleCreateTeleporter({
      from: { sceneIdentifier: 'Nowhere', x: 1, y: 2 },
      to: { sceneIdentifier: 'Cave', x: 3, y: 4 },
    });
    expect(out).toContain('Scene not found');
    expect(out).toContain('No teleporter created');
  });

  it('rejects a non-numeric endpoint coordinate', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateTeleporter({
        from: { sceneIdentifier: 'Bridge', x: 'here', y: 2 },
        to: { sceneIdentifier: 'Cave', x: 3, y: 4 },
      })
    ).rejects.toThrow();
  });
});

describe('handleCreateRegion', () => {
  it('forwards regions and lists created ids', async () => {
    const { tools, calls } = build({
      success: true,
      sceneId: 's1',
      sceneName: 'Cave',
      created: 1,
      regions: [{ id: 'r1', name: 'Trap' }],
    });
    const out = await tools.handleCreateRegion({
      sceneIdentifier: 'Cave',
      regions: [
        { name: 'Trap', shapes: [{ type: 'rectangle', x: 0, y: 0, width: 140, height: 140 }] },
      ],
    });
    const call = calls.find(([n]) => n === 'createSceneRegions');
    expect(call?.[1].regions[0].name).toBe('Trap');
    expect(out).toContain('Created 1 region');
    expect(out).toContain('r1 — Trap');
  });

  it('rejects a region with no shapes', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateRegion({ sceneIdentifier: 'Cave', regions: [{ name: 'X', shapes: [] }] })
    ).rejects.toThrow();
  });

  it('reports scene-not-found', async () => {
    const { tools } = build({ success: true, created: 0, notFound: 'Nowhere' });
    const out = await tools.handleCreateRegion({
      sceneIdentifier: 'Nowhere',
      regions: [{ shapes: [{ type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }] }],
    });
    expect(out).toContain('Scene not found');
  });
});

describe('handleUpdateRegion', () => {
  it('forwards the rect convenience and reports the new shape', async () => {
    const { tools, calls } = build({
      success: true,
      updated: true,
      sceneId: 's1',
      sceneName: 'Cave',
      region: {
        id: 'r1',
        name: 'Trap',
        shapes: [{ type: 'rectangle', x: 700, y: 840, width: 420, height: 140 }],
        behaviors: [],
      },
    });
    const out = await tools.handleUpdateRegion({
      sceneIdentifier: 'Cave',
      regionId: 'r1',
      rect: { x: 910, y: 910, widthCells: 3 },
    });
    const call = calls.find(([n]) => n === 'updateSceneRegion');
    expect(call?.[1].rect.widthCells).toBe(3);
    expect(out).toContain('Updated region r1');
    expect(out).toContain('420×140px');
  });

  it('rejects an update with no fields (refine)', async () => {
    const { tools } = build();
    await expect(
      tools.handleUpdateRegion({ sceneIdentifier: 'Cave', regionId: 'r1' })
    ).rejects.toThrow();
  });

  it('reports region-not-found', async () => {
    const { tools } = build({ success: true, updated: false, notFound: 'rZ' });
    const out = await tools.handleUpdateRegion({
      sceneIdentifier: 'Cave',
      regionId: 'rZ',
      name: 'x',
    });
    expect(out).toContain('Region not found');
  });
});

describe('handleDeleteRegion / handleListRegions', () => {
  it('deletes by id and reports missing ids', async () => {
    const { tools, calls } = build({
      success: true,
      sceneId: 's1',
      sceneName: 'Cave',
      deleted: 1,
      notFoundIds: ['rZ'],
    });
    const out = await tools.handleDeleteRegion({
      sceneIdentifier: 'Cave',
      regionIds: ['r1', 'rZ'],
    });
    expect(calls.find(([n]) => n === 'deleteSceneRegions')).toBeTruthy();
    expect(out).toContain('Deleted 1 region');
    expect(out).toContain('rZ');
  });

  it('list-regions surfaces a not-found scene as a message', async () => {
    const { tools } = build({ found: false, notFound: 'Nope' });
    const out = await tools.handleListRegions({ sceneIdentifier: 'Nope' });
    expect(out).toContain('Scene not found');
  });

  it('list-regions passes through the region list', async () => {
    const { tools } = build({
      found: true,
      sceneId: 's1',
      sceneName: 'Cave',
      regions: [{ id: 'r1', name: 'Trap', shapes: [], behaviors: [] }],
    });
    const out = await tools.handleListRegions({ sceneIdentifier: 'Cave' });
    expect(out.regions[0].id).toBe('r1');
  });
});
