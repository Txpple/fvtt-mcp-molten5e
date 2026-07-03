// Page-side Token descriptor for the placeable CRUD kernel — LIST ONLY.
//
// Placed-token MUTATION stays in the bespoke update-token tool (updateSceneTokens): its actor→all-copies
// matching and the lockRotation auto-unlock gotcha don't fit a generic id-keyed patch, and token
// create/delete are the actor's lifecycle, not a scene edit. What was missing was a READ: you can't feed
// update-token a token id without first seeing what's on the map. list-tokens fills that (works on ANY
// scene by id/name, not just the active one like get-current-scene). Dump only.

import { crudList, type PlaceableDescriptor } from '../_placeables.js';

const DISPOSITION_NAME: Record<number, string> = {
  [-2]: 'secret',
  [-1]: 'hostile',
  0: 'neutral',
  1: 'friendly',
};

function dump(doc: any): Record<string, unknown> {
  return {
    id: doc.id,
    name: doc.name,
    x: doc.x,
    y: doc.y,
    width: doc.width,
    height: doc.height,
    rotation: doc.rotation,
    elevation: doc.elevation,
    hidden: doc.hidden,
    lockRotation: doc.lockRotation,
    disposition: DISPOSITION_NAME[doc.disposition] ?? doc.disposition,
    actorId: doc.actorId || null,
    src: doc.texture?.src,
    scale: doc.texture?.scaleX,
    sort: doc.sort,
  };
}

export const tokenDescriptor: PlaceableDescriptor = {
  docName: 'Token',
  collection: (scene: any) => scene.tokens,
  dump,
};

// --- bridge page function (registered in src/page/index.ts) ------------------
export const listSceneTokens = (args: { sceneIdentifier: string }) =>
  crudList(tokenDescriptor, args);
