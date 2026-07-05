// Page-side: asset-management writes (Group C reference integrity + Group D
// composition). Runs inside the Foundry page.
//
// Write functions over the bridge. Shapes match the old data-access.ts oracle
// (6f9612e:packages/foundry-module/src/data-access.ts: findAssetReferences
// @7066-7107, relinkAsset @7107-7173, setActorArt @7321-7371, addJournalImage
// @7371-7434, plus asset helpers @6793-6834 and collectAssetSlots @6866-7060)
// and the contracts the Node tools (src/tools/asset-bridge.ts,
// src/tools/molten/index.ts) and their tests expect.
//
// Paths are Data-relative — exactly what Foundry stores in src/img fields, so
// no conversion is needed. Writes are best-effort (no rollback). The bridge is
// always GM, so the permission checks in the oracle are no-ops here.

import { normalizeAssetPath, basename, isVideoPath, resolveJournalStrict } from './_shared.js';
import { imgResolves, badAssetWarning } from './img-resolve.js';
import { resolveCreatureIcon } from './dnd5e/icons.js';

/**
 * Group C — find every document that references the given asset path(s).
 * Read-only. Returns { references: { path: hits[] }, totalReferences }.
 *
 * Match semantics differ by slot kind, by design: non-text fields (scene background, token/actor
 * art, playlist sound paths) match by exact normalized-path equality (assetPathsEqual), while text
 * journal pages match by case-insensitive SUBSTRING of the path inside the page HTML. The substring
 * path can OVER-report (a page mentioning `a/b/x.png.bak` matches a query for `a/b/x.png`) but never
 * under-reports an exact path. Because the destructive callers (delete/move-asset) fail CLOSED on
 * any hit — the user overrides with `force` — over-reporting is safe-by-design; only a false
 * NEGATIVE would be dangerous, and the exact-equality branch avoids that for non-text fields.
 */
export async function findAssetReferences(data: { paths: string[] }): Promise<unknown> {
  const paths = Array.isArray(data.paths) ? data.paths.filter(p => typeof p === 'string') : [];
  if (paths.length === 0) {
    throw new Error('paths array is required and must contain at least one asset path');
  }

  const slots = collectAssetSlots();
  const references: Record<string, any[]> = {};
  let total = 0;

  for (const path of paths) {
    const targetNorm = normalizeAssetPath(path).toLowerCase();
    const hits: any[] = [];
    for (const slot of slots) {
      let isMatch = false;
      if ((slot as any)._textPage) {
        // Text page: substring match of the Data-relative path inside the HTML content.
        isMatch = normalizeAssetPath(slot.value).toLowerCase().includes(targetNorm);
      } else {
        isMatch = assetPathsEqual(slot.value, path);
      }
      if (isMatch) {
        hits.push({
          documentType: slot.documentType,
          documentId: slot.documentId,
          documentName: slot.documentName,
          field: slot.field,
        });
      }
    }
    references[path] = hits;
    total += hits.length;
  }

  return { success: true, references, totalReferences: total };
}

/**
 * Group C — rewrite every reference from oldPath to newPath. dryRun reports
 * without writing. Returns { dryRun, changedCount, changed }.
 */
export async function relinkAsset(data: {
  oldPath: string;
  newPath: string;
  dryRun?: boolean;
}): Promise<unknown> {
  if (!data.oldPath || !data.newPath) {
    throw new Error('oldPath and newPath are both required');
  }
  const dryRun = data.dryRun === true;

  const slots = collectAssetSlots();
  const oldNorm = normalizeAssetPath(data.oldPath);
  const newNorm = normalizeAssetPath(data.newPath);
  const changed: any[] = [];

  for (const slot of slots) {
    const textPage = (slot as any)._textPage;
    if (textPage) {
      const content: string = slot.value;
      if (!content.toLowerCase().includes(oldNorm.toLowerCase())) continue;
      const updated = content.split(oldNorm).join(newNorm);
      if (updated === content) continue;
      changed.push({
        documentType: slot.documentType,
        documentId: slot.documentId,
        documentName: slot.documentName,
        field: slot.field,
      });
      if (!dryRun) await textPage.update({ 'text.content': updated });
    } else if (assetPathsEqual(slot.value, data.oldPath)) {
      changed.push({
        documentType: slot.documentType,
        documentId: slot.documentId,
        documentName: slot.documentName,
        field: slot.field,
      });
      if (!dryRun) await slot.update(newNorm);
    }
  }

  return { success: true, dryRun, changedCount: changed.length, changed };
}

/**
 * Group D — set an actor's portrait (and, by default, its prototype token art).
 *
 * Two Foundry field categories are in play: `actor.img` (the portrait) accepts a STILL IMAGE ONLY,
 * while `prototypeToken.texture.src` (the token) accepts IMAGE **or** VIDEO. Writing a video to `img`
 * makes Foundry reject the ENTIRE update — which used to fail silently (the tool reported success but
 * nothing changed). So a video `imagePath` is kept off the portrait (with a warning), and `tokenImagePath`
 * lets the token carry an animated `.webm`/`.mp4` while the portrait stays a valid still. When no
 * `tokenImagePath` is given, the token defaults to `imagePath` (the common "same art on both" call).
 */
export async function setActorArt(data: {
  actorIdentifier: string;
  imagePath: string;
  tokenImagePath?: string;
  applyToToken?: boolean;
}): Promise<unknown> {
  if (!data.actorIdentifier || !data.imagePath) {
    throw new Error('actorIdentifier and imagePath are both required');
  }

  const actor = resolveActorStrict(data.actorIdentifier);
  if (!actor) {
    return { success: true, updated: false, notFound: data.actorIdentifier };
  }

  const applyToToken = data.applyToToken !== false;
  const warnings: string[] = [];
  const creatureType =
    actor.type === 'npc' ? actor.system?.details?.type?.value || 'humanoid' : 'humanoid';

  // Portrait (actor.img) — IMAGE ONLY. A video path can't live here, so keep it off img (warn) rather
  // than let it abort the whole update. A 404 still-image path substitutes a real floor icon (rule 8).
  let img: string | undefined = normalizeAssetPath(data.imagePath);
  if (isVideoPath(img)) {
    warnings.push(
      `Portrait "${img}" is a video — an actor portrait must be a still image, so it was NOT set as ` +
        'the portrait' +
        (applyToToken && !data.tokenImagePath ? ' (used only for the token texture).' : '.')
    );
    img = undefined; // leave the existing portrait untouched
  } else if (img && !(await imgResolves(img))) {
    warnings.push(badAssetWarning('imagePath', img, true));
    img = resolveCreatureIcon(creatureType);
  }

  // Token texture (prototypeToken.texture.src) — accepts IMAGE or VIDEO. Defaults to imagePath so the
  // common call is unchanged; tokenImagePath overrides it (e.g. an animated JB2A webm).
  let tokenSrc: string | undefined;
  if (applyToToken) {
    tokenSrc = normalizeAssetPath(data.tokenImagePath ?? data.imagePath);
    if (tokenSrc && !(await imgResolves(tokenSrc))) {
      warnings.push(
        badAssetWarning(data.tokenImagePath ? 'tokenImagePath' : 'imagePath', tokenSrc, true)
      );
      tokenSrc = resolveCreatureIcon(creatureType);
    }
  }

  const update: any = {};
  if (img !== undefined) update.img = img;
  if (tokenSrc !== undefined) update['prototypeToken.texture.src'] = tokenSrc;

  if (Object.keys(update).length === 0) {
    // Nothing valid to write (e.g. a video imagePath with applyToToken:false).
    return {
      success: true,
      updated: false,
      actorId: actor.id,
      actorName: actor.name,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  await actor.update(update);
  return {
    success: true,
    updated: true,
    actorId: actor.id,
    actorName: actor.name,
    img,
    tokenSrc,
    appliedToToken: applyToToken,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Group D — append an image page to a journal entry.
 */
export async function addJournalImage(data: {
  journalIdentifier: string;
  imagePath: string;
  pageName?: string;
  caption?: string;
  playerVisible?: boolean;
}): Promise<unknown> {
  if (!data.journalIdentifier || !data.imagePath) {
    throw new Error('journalIdentifier and imagePath are both required');
  }

  const journal = resolveJournalStrict(data.journalIdentifier);
  if (!journal) {
    return { success: true, updated: false, notFound: data.journalIdentifier };
  }

  const src = normalizeAssetPath(data.imagePath);
  const warnings: string[] = [];
  // KEEP+WARN: a content image has nothing to swap to — create the page with the original src,
  // but warn if the path 404s so the user knows it will render broken until uploaded/fixed.
  if (src && !(await imgResolves(src))) {
    warnings.push(badAssetWarning('imagePath', src, false));
  }
  const pageData: any = {
    type: 'image',
    name: data.pageName || basename(src),
    src,
  };
  if (data.caption) pageData.image = { caption: data.caption };
  // playerVisible -> page ownership OBSERVER (2); omitted inherits the journal's GM-only default.
  if (data.playerVisible) pageData.ownership = { default: 2 };
  const created = await journal.createEmbeddedDocuments('JournalEntryPage', [pageData]);
  const page = created?.[0];
  return {
    success: true,
    updated: true,
    journalId: journal.id,
    journalName: journal.name,
    pageId: page?.id,
    pageName: page?.name,
    src,
    ...(warnings.length ? { warnings } : {}),
  };
}

// --- local helpers -----------------------------------------------------------

function assetPathsEqual(a: string, b: string): boolean {
  return normalizeAssetPath(a).toLowerCase() === normalizeAssetPath(b).toLowerCase();
}

function resolveActorStrict(identifier: string): any {
  return game.actors?.get(identifier) || game.actors?.getName(identifier) || null;
}

/**
 * Collect every asset-bearing field across all world collections as a list of
 * "slots" — each with a current value and an update closure that rewrites it.
 * Text journal pages carry a `_textPage` marker; relink handles those with a
 * string replace instead of the slot's (no-op) update closure.
 */
function collectAssetSlots(): Array<{
  documentType: string;
  documentId: string;
  documentName: string;
  field: string;
  value: string;
  update: (newValue: string) => Promise<void>;
}> {
  const slots: Array<{
    documentType: string;
    documentId: string;
    documentName: string;
    field: string;
    value: string;
    update: (newValue: string) => Promise<void>;
  }> = [];
  const push = (
    documentType: string,
    doc: any,
    field: string,
    value: any,
    update: (newValue: string) => Promise<void>
  ): void => {
    if (value && typeof value === 'string') {
      slots.push({
        documentType,
        documentId: doc?.id ?? '',
        documentName: doc?.name ?? '',
        field,
        value,
        update,
      });
    }
  };

  // Scenes: background/foreground + embedded tokens/tiles/sounds/notes.
  // v14 moved the renderable background/foreground into the per-level `levels[]` array
  // (Scene#background is deprecated). We scan each level's background/foreground.src and update via
  // a whole-array `scene.update({ levels })`. The legacy top-level `background.src` is also scanned
  // (read) for scenes migrated from <14, though v14 ignores writes to it.
  try {
    for (const scene of game.scenes || []) {
      const src: any = scene._source || {};
      const levels: any[] = Array.isArray(src.levels) ? src.levels : [];
      levels.forEach((lvl: any, i: number) => {
        if (lvl?.background?.src) {
          push(
            'Scene',
            scene,
            `level "${lvl.name}".background.src`,
            lvl.background.src,
            async v => {
              const o = scene.toObject();
              if (o.levels?.[i]?.background) {
                o.levels[i].background.src = v;
                await scene.update({ levels: o.levels });
              }
            }
          );
        }
        if (lvl?.foreground?.src) {
          push(
            'Scene',
            scene,
            `level "${lvl.name}".foreground.src`,
            lvl.foreground.src,
            async v => {
              const o = scene.toObject();
              if (o.levels?.[i]?.foreground) {
                o.levels[i].foreground.src = v;
                await scene.update({ levels: o.levels });
              }
            }
          );
        }
      });
      if (src.background?.src) {
        push('Scene', scene, 'background.src (legacy)', src.background.src, v =>
          scene.update({ 'background.src': v })
        );
      }
      for (const token of scene.tokens || []) {
        push('Scene', scene, `token "${token.name}".texture.src`, token.texture?.src, v =>
          token.update({ 'texture.src': v })
        );
      }
      for (const tile of scene.tiles || []) {
        push('Scene', scene, `tile ${tile.id}.texture.src`, tile.texture?.src, v =>
          tile.update({ 'texture.src': v })
        );
      }
      for (const sound of scene.sounds || []) {
        push('Scene', scene, `ambient sound ${sound.id}.path`, sound.path, v =>
          sound.update({ path: v })
        );
      }
      for (const note of scene.notes || []) {
        push('Scene', scene, `note ${note.id}.texture.src`, note.texture?.src, v =>
          note.update({ 'texture.src': v })
        );
      }
    }
  } catch (e) {
    console.warn('[fvtt-mcp] asset scan: scenes failed', e);
  }

  // Actors: portrait, prototype token, embedded items.
  try {
    for (const actor of game.actors || []) {
      push('Actor', actor, 'img', actor.img, v => actor.update({ img: v }));
      push('Actor', actor, 'prototypeToken.texture.src', actor.prototypeToken?.texture?.src, v =>
        actor.update({ 'prototypeToken.texture.src': v })
      );
      for (const item of actor.items || []) {
        push('Actor', actor, `item "${item.name}".img`, item.img, v => item.update({ img: v }));
      }
    }
  } catch (e) {
    console.warn('[fvtt-mcp] asset scan: actors failed', e);
  }

  // World items.
  try {
    for (const item of game.items || []) {
      push('Item', item, 'img', item.img, v => item.update({ img: v }));
    }
  } catch (e) {
    console.warn('[fvtt-mcp] asset scan: items failed', e);
  }

  // Journals: image pages (src) + text pages (embedded <img src> in content).
  try {
    for (const journal of game.journal || []) {
      for (const page of journal.pages || []) {
        if (page.type === 'image') {
          push('JournalEntry', journal, `page "${page.name}".src`, page.src, v =>
            page.update({ src: v })
          );
        } else if (page.type === 'text' && page.text?.content) {
          // Tracked as a text-content reference; relink does a string replace below.
          const content: string = page.text.content;
          push(
            'JournalEntry',
            journal,
            `page "${page.name}".text.content`,
            content,
            async (_v: string) => {
              /* content replace is handled specially in relinkAsset */
            }
          );
          // Stash the page + content on the last slot for the text-replace path.
          (slots[slots.length - 1] as any)._textPage = page;
        }
      }
    }
  } catch (e) {
    console.warn('[fvtt-mcp] asset scan: journals failed', e);
  }

  // Playlists: each sound's path.
  try {
    for (const playlist of game.playlists || []) {
      for (const sound of playlist.sounds || []) {
        push('Playlist', playlist, `sound "${sound.name}".path`, sound.path, v =>
          sound.update({ path: v })
        );
      }
    }
  } catch (e) {
    console.warn('[fvtt-mcp] asset scan: playlists failed', e);
  }

  // Macros + roll tables.
  try {
    for (const macro of game.macros || []) {
      push('Macro', macro, 'img', macro.img, v => macro.update({ img: v }));
    }
  } catch (e) {
    console.warn('[fvtt-mcp] asset scan: macros failed', e);
  }
  try {
    for (const table of game.tables || []) {
      push('RollTable', table, 'img', table.img, v => table.update({ img: v }));
      for (const result of table.results || []) {
        push('RollTable', table, `result ${result.id}.img`, result.img, v =>
          result.update({ img: v })
        );
      }
    }
  } catch (e) {
    console.warn('[fvtt-mcp] asset scan: tables failed', e);
  }

  return slots;
}
