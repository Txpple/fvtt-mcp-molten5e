// Page-side: scene reads + writes. Runs inside the Foundry page.
//
// Reads are pure against game.scenes. Writes (create/update/delete) perform
// awaited Foundry document mutations and are best-effort (no rollback). No
// permission/transaction/audit scaffolding — the bridge is always GM. The
// Node-side tools (src/tools/scene.ts, src/tools/asset-bridge.ts) own all output
// shaping; these functions return the raw structured values those tools (and
// their tests) expect. Write shapes match the old data-access.ts oracle
// (createScene @7255 / updateScene @7434 / deleteScenes @7514) exactly.

import { normalizeAssetPath } from './_shared.js';

// Foundry document class (Scene) and CONST live in the page global scope but are
// not declared in foundry-globals.d.ts; reach them off globalThis (loosely typed).
const SceneClass: any = (globalThis as any).Scene;
const CONST_: any = (globalThis as any).CONST;

/**
 * Map a token's disposition to a number. Foundry stores it as a number already;
 * anything else falls back to neutral (0). The Node tool maps the number to a
 * name (-1 hostile / 0 neutral / 1 friendly).
 */
function tokenDisposition(disposition: unknown): number {
  if (typeof disposition === 'number') {
    return disposition;
  }
  return 0; // neutral
}

/**
 * Information about the currently active scene, including tokens, notes and
 * element counts. Mirrors the old data-access.getActiveScene shape.
 * Throws if there is no active scene.
 */
export function getActiveScene(): unknown {
  const scene = game.scenes?.current;
  if (!scene) {
    throw new Error('Scene not found');
  }

  return {
    id: scene.id,
    name: scene.name,
    img: scene.img || undefined,
    background: scene._source?.background?.src || undefined,
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    active: scene.active,
    navigation: scene.navigation,
    tokens: scene.tokens.map((token: any) => ({
      id: token.id,
      name: token.name,
      x: token.x,
      y: token.y,
      width: token.width,
      height: token.height,
      actorId: token.actorId || undefined,
      img: token.texture?.src || '',
      hidden: token.hidden,
      disposition: tokenDisposition(token.disposition),
    })),
    walls: scene.walls.size,
    lights: scene.lights.size,
    sounds: scene.sounds.size,
    notes: scene.notes.map((note: any) => ({
      id: note.id,
      text: note.text || '',
      x: note.x,
      y: note.y,
    })),
  };
}

/**
 * List scenes in the world, optionally filtered by name substring or to active
 * scenes only. Each entry carries id, name, active flag, dimensions, grid size,
 * background and element counts. Mirrors the old data-access.listScenes shape.
 */
export function listScenes(args?: { filter?: string; includeActiveOnly?: boolean }): unknown {
  let scenes: any[] = game.scenes?.contents || [];

  if (args?.includeActiveOnly) {
    scenes = scenes.filter((scene: any) => scene.active);
  }

  if (args?.filter) {
    const filterLower = args.filter.toLowerCase();
    scenes = scenes.filter((scene: any) => scene.name.toLowerCase().includes(filterLower));
  }

  return scenes.map((scene: any) => ({
    id: scene.id,
    name: scene.name,
    active: scene.active,
    dimensions: {
      width: scene.dimensions?.width || scene.width || 0,
      height: scene.dimensions?.height || scene.height || 0,
    },
    gridSize: scene.grid?.size || 100,
    background: scene._source?.background?.src || scene.img || '',
    walls: scene.walls?.size || 0,
    tokens: scene.tokens?.size || 0,
    lighting: scene.lights?.size || 0,
    sounds: scene.sounds?.size || 0,
    navigation: scene.navigation || false,
  }));
}

// --- writes ------------------------------------------------------------------

/**
 * Create a new Scene from a name + background image path. The renderable
 * background lives on the scene's initial level in v14 (levels[].background.src),
 * so we create the document then set the background there. Optionally activates
 * the new scene. Mirrors the old data-access.createScene shape.
 */
export async function createScene(args: {
  name: string;
  backgroundPath: string;
  width?: number;
  height?: number;
  gridSize?: number;
  gridType?: number;
  padding?: number;
  activate?: boolean;
}): Promise<unknown> {
  if (!args.name || !args.backgroundPath) {
    throw new Error('name and backgroundPath are both required');
  }

  try {
    const src = normalizeAssetPath(args.backgroundPath);
    const sceneData: any = {
      name: args.name,
      // Legacy field — harmless on v14 (ignored), correct on Foundry < 14.
      background: { src },
      grid: {
        size: typeof args.gridSize === 'number' ? args.gridSize : 100,
        type: typeof args.gridType === 'number' ? args.gridType : (CONST_?.GRID_TYPES?.SQUARE ?? 1),
      },
    };
    if (typeof args.width === 'number') sceneData.width = args.width;
    if (typeof args.height === 'number') sceneData.height = args.height;
    if (typeof args.padding === 'number') sceneData.padding = args.padding;

    const scene = await SceneClass.create(sceneData);
    // v14: the renderable background lives on the scene's initial level — set it there.
    await applySceneBackground(scene, src);
    if (args.activate && scene) await scene.activate();

    return {
      success: true,
      sceneId: scene?.id,
      sceneName: scene?.name,
      active: scene?.active ?? false,
      background: readSceneBackground(scene),
    };
  } catch (error) {
    throw new Error(
      `Failed to create scene: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Update an existing Scene's document fields. Folds in the background swap
 * (set-scene-background) plus the common scene-document properties: name,
 * navigation label/flag, dimensions, grid, padding. STRICT resolution
 * (resolveSceneStrict) — no fuzzy matching. Scene-document only; never touches
 * placeables (walls/lights/tokens) or activates the scene. Mirrors the old
 * data-access.updateScene shape.
 */
export async function updateScene(args: {
  sceneIdentifier: string;
  name?: string;
  navName?: string;
  navigation?: boolean;
  backgroundPath?: string;
  width?: number;
  height?: number;
  gridSize?: number;
  gridType?: number;
  padding?: number;
}): Promise<unknown> {
  if (!args?.sceneIdentifier) {
    throw new Error('sceneIdentifier is required');
  }

  const scene = resolveSceneStrict(args.sceneIdentifier);
  if (!scene) {
    return { success: true, updated: false, notFound: args.sceneIdentifier };
  }

  const update: any = {};
  if (typeof args.name === 'string' && args.name.trim().length > 0) update.name = args.name.trim();
  if (typeof args.navName === 'string') update.navName = args.navName;
  if (typeof args.navigation === 'boolean') update.navigation = args.navigation;
  if (typeof args.width === 'number') update.width = args.width;
  if (typeof args.height === 'number') update.height = args.height;
  if (typeof args.padding === 'number') update.padding = args.padding;
  if (typeof args.gridSize === 'number') update['grid.size'] = args.gridSize;
  if (typeof args.gridType === 'number') update['grid.type'] = args.gridType;

  const hasDocUpdate = Object.keys(update).length > 0;
  const hasBackground =
    typeof args.backgroundPath === 'string' && args.backgroundPath.trim().length > 0;

  if (!hasDocUpdate && !hasBackground) {
    throw new Error(
      'Provide at least one field to update (name, navName, navigation, backgroundPath, width, height, gridSize, gridType, padding)'
    );
  }

  try {
    if (hasDocUpdate) await scene.update(update);
    if (hasBackground) {
      await applySceneBackground(scene, normalizeAssetPath(args.backgroundPath!));
    }

    return {
      success: true,
      updated: true,
      sceneId: scene.id,
      sceneName: scene.name,
      background: readSceneBackground(scene),
    };
  } catch (error) {
    throw new Error(
      `Failed to update scene: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Permanently delete one or more Scene documents by exact id or exact name.
 * STRICT resolution (resolveSceneStrict) — no fuzzy matching. Deleting the
 * active scene is allowed; Foundry handles deactivation. Mirrors the old
 * data-access.deleteScenes shape.
 */
export async function deleteScenes(args: { identifiers: string[] }): Promise<{
  success: boolean;
  deletedCount: number;
  deleted: Array<{ id: string; name: string }>;
  notFound?: string[];
}> {
  if (!Array.isArray(args?.identifiers) || args.identifiers.length === 0) {
    throw new Error('identifiers array is required and must contain at least one entry');
  }

  try {
    const deleted: Array<{ id: string; name: string }> = [];
    const notFound: string[] = [];

    for (const identifier of args.identifiers) {
      const scene = resolveSceneStrict(identifier);
      if (scene) {
        const info = { id: scene.id ?? identifier, name: scene.name ?? '' };
        await scene.delete();
        deleted.push(info);
      } else {
        notFound.push(identifier);
      }
    }

    return {
      success: true,
      deletedCount: deleted.length,
      deleted,
      ...(notFound.length > 0 ? { notFound } : {}),
    };
  } catch (error) {
    throw new Error(
      `Failed to delete scene(s): ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

// --- local helpers -----------------------------------------------------------

/** Resolve a scene by exact id, then exact name; null when neither matches. */
function resolveSceneStrict(identifier: string): any {
  return (
    game.scenes?.get(identifier) || game.scenes?.find((s: any) => s.name === identifier) || null
  );
}

/**
 * Set a scene's renderable background. v14 stores it on the initial level
 * (levels[].background.src); fall back to the legacy top-level background.src
 * for Foundry < 14. Mirrors the old data-access.applySceneBackground.
 */
async function applySceneBackground(scene: any, src: string): Promise<void> {
  const o = scene.toObject();
  const levels: any[] = Array.isArray(o.levels) ? o.levels : [];
  if (levels.length) {
    let idx = levels.findIndex((l: any) => l._id === o.initialLevel);
    if (idx < 0) idx = 0;
    if (levels[idx]?.background) {
      levels[idx].background.src = src;
      await scene.update({ levels });
      return;
    }
  }
  await scene.update({ 'background.src': src }); // Foundry < 14
}

/** Read a scene's renderable background `src` (v14 level first, then legacy top-level). */
function readSceneBackground(scene: any): string | undefined {
  const o: any = scene._source || scene.toObject?.() || {};
  const levels: any[] = Array.isArray(o.levels) ? o.levels : [];
  if (levels.length) {
    const lvl = levels.find((l: any) => l._id === o.initialLevel) || levels[0];
    if (lvl?.background?.src) return lvl.background.src;
  }
  return o.background?.src || undefined;
}
