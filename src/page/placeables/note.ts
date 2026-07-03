// Page-side Note (map-pin) descriptor for the placeable CRUD kernel (_placeables.ts).
//
// The legend→pins pipeline: a Note links a spot on the map to a JournalEntry (and optionally one
// page). CORRECTNESS TRAPS this owns:
//  - `entryId`/`pageId` are STRICT name→id resolutions (ambiguity throws — pass the id); re-pointing
//    to an entry with no `page` CLEARS the old page link (pageId: null).
//  - The icon probe is ASYNC and the policy is SUBSTITUTE-BY-DROP: a 404 icon has a sensible fallback
//    (Foundry's default note pin), so the texture is omitted/left alone and the drop is warned —
//    unlike a tile/sound asset, which is KEEP+WARN.
//  - x/y are the pin CENTER in absolute canvas pixels (padding-offset).

import { normalizeAssetPath } from '../_shared.js';
import { imgResolves, badAssetWarning } from '../img-resolve.js';
import {
  crudCreate,
  crudDelete,
  crudList,
  crudUpdate,
  type CreateDocResult,
  type PatchResult,
  type PlaceableDescriptor,
} from '../_placeables.js';

const NOTE_ANCHOR_NAME: Record<number, string> = {
  0: 'center',
  1: 'bottom',
  2: 'top',
  3: 'left',
  4: 'right',
};

export interface NoteInput {
  journal?: string;
  page?: string;
  x?: number;
  y?: number;
  label?: string;
  icon?: string;
  iconSize?: number;
  global?: boolean;
}

/**
 * Resolve a Note's journal target: a JournalEntry by id|exact-name (strict, ambiguity
 * throws) and, optionally, a page within it by id|exact-name. Throws on no match.
 */
export function resolveNoteTarget(
  journal: string,
  page?: string
): { entryId: string; pageId?: string } {
  const coll: any = game.journal;
  const entry =
    coll?.get?.(journal) ??
    (() => {
      const m = Array.from(coll ?? []).filter((d: any) => d?.name === journal);
      if (m.length > 1)
        throw new Error(`Ambiguous journal name "${journal}" (${m.length}). Pass the id.`);
      return m[0];
    })();
  if (!entry) throw new Error(`No journal found matching "${journal}" (by id or exact name).`);

  let pageId: string | undefined;
  if (typeof page === 'string' && page.trim() !== '') {
    const pages: any = entry.pages;
    const p =
      pages?.get?.(page) ??
      (() => {
        const m = Array.from(pages ?? []).filter((x: any) => x?.name === page);
        if (m.length > 1)
          throw new Error(`Ambiguous page name "${page}" in "${entry.name}" (${m.length}).`);
        return m[0];
      })();
    if (!p) throw new Error(`No page "${page}" in journal "${entry.name}".`);
    pageId = p.id;
  }
  // Omit pageId entirely when absent (exactOptionalPropertyTypes — no explicit undefined).
  return pageId ? { entryId: entry.id, pageId } : { entryId: entry.id };
}

async function toCreateDoc(input: NoteInput): Promise<CreateDocResult> {
  if (!input?.journal || typeof input.journal !== 'string') {
    return { error: 'journal is required (JournalEntry id or exact name)' };
  }
  for (const k of ['x', 'y'] as const) {
    if (typeof input[k] !== 'number') return { error: `${k} is required (a number)` };
  }
  const warnings: string[] = [];
  // Strict journal/page resolve — a throw here is caught by the kernel's per-item isolation.
  const { entryId, pageId } = resolveNoteTarget(input.journal, input.page);
  const doc: Record<string, unknown> = { entryId, x: input.x, y: input.y };
  if (pageId) doc.pageId = pageId;
  if (typeof input.label === 'string' && input.label.trim() !== '') doc.text = input.label;
  if (typeof input.iconSize === 'number') doc.iconSize = input.iconSize;
  if (typeof input.global === 'boolean') doc.global = input.global;
  if (typeof input.icon === 'string' && input.icon.trim() !== '') {
    const iconSrc = normalizeAssetPath(input.icon);
    // SUBSTITUTE-BY-DROP: a 404 icon has a sensible fallback (Foundry's default note pin) — omit
    // the texture entirely so the default is used, and warn that we dropped the bad path.
    if (iconSrc && !(await imgResolves(iconSrc)))
      warnings.push(badAssetWarning('icon', iconSrc, true));
    else doc.texture = { src: iconSrc };
  }
  return { doc, ...(warnings.length ? { warnings } : {}) };
}

async function buildPatch(_existing: any, p: NoteInput & { id: string }): Promise<PatchResult> {
  const patch: Record<string, unknown> = {};
  const warnings: string[] = [];
  if (typeof p.x === 'number') patch.x = p.x;
  if (typeof p.y === 'number') patch.y = p.y;
  if (typeof p.label === 'string') patch.text = p.label;
  if (typeof p.iconSize === 'number') patch.iconSize = p.iconSize;
  if (typeof p.global === 'boolean') patch.global = p.global;
  if (typeof p.icon === 'string' && p.icon.trim() !== '') {
    const iconSrc = normalizeAssetPath(p.icon);
    // SUBSTITUTE-BY-DROP: a 404 icon falls back to Foundry's default pin — skip the write + warn.
    if (iconSrc && !(await imgResolves(iconSrc)))
      warnings.push(badAssetWarning('icon', iconSrc, true));
    else patch['texture.src'] = iconSrc;
  }
  if (typeof p.journal === 'string' && p.journal.trim() !== '') {
    const { entryId, pageId } = resolveNoteTarget(p.journal, p.page);
    patch.entryId = entryId;
    patch.pageId = pageId ?? null; // re-pointing to an entry with no page clears the old page link
  }
  return { patch, warnings, changed: Object.keys(patch).length > 0 };
}

function dump(doc: any): Record<string, unknown> {
  return {
    id: doc.id,
    x: doc.x,
    y: doc.y,
    text: doc.text,
    entryId: doc.entryId || null,
    pageId: doc.pageId || null,
    iconSize: doc.iconSize,
    global: doc.global,
    src: doc.texture?.src,
    fontSize: doc.fontSize,
    textAnchor: NOTE_ANCHOR_NAME[doc.textAnchor] ?? doc.textAnchor,
  };
}

export const noteDescriptor: PlaceableDescriptor = {
  docName: 'Note',
  collection: (scene: any) => scene.notes,
  dump,
  toCreateDoc,
  buildPatch,
};

// --- bridge page functions (registered in src/page/index.ts) -----------------
export const createSceneNotes = (args: { sceneIdentifier: string; items: NoteInput[] }) =>
  crudCreate(noteDescriptor, args);
export const listSceneNotes = (args: { sceneIdentifier: string }) => crudList(noteDescriptor, args);
export const updateSceneNotes = (args: {
  sceneIdentifier: string;
  patches: Array<{ id: string } & NoteInput>;
}) => crudUpdate(noteDescriptor, args);
export const deleteSceneNotes = (args: { sceneIdentifier: string; ids: string[] }) =>
  crudDelete(noteDescriptor, args);
