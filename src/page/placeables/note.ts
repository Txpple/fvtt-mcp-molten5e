// Page-side Note descriptor for the placeable CRUD kernel — LIST ONLY.
//
// Note CREATE/UPDATE/DELETE already exist as the bespoke create-scene-notes / update-note / delete-note
// tools (they carry strict journal/page name→id resolution + the icon SUBSTITUTE-BY-DROP policy). What
// was missing was a dedicated READ — notes only appeared shallowly on get-current-scene (active scene
// only). list-notes fills that so the pin-nudge loop can find note ids + current values on ANY scene.
// Dump only.

import { crudList, type PlaceableDescriptor } from '../_placeables.js';

const NOTE_ANCHOR_NAME: Record<number, string> = {
  0: 'center',
  1: 'bottom',
  2: 'top',
  3: 'left',
  4: 'right',
};

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
};

// --- bridge page function (registered in src/page/index.ts) ------------------
export const listSceneNotes = (args: { sceneIdentifier: string }) => crudList(noteDescriptor, args);
