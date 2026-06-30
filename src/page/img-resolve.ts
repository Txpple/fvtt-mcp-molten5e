// Shared asset-path existence guard for the authoring tools. IMPURE (browser fetch) — kept apart from
// the PURE icon floor in dnd5e/icons.ts so that file stays unit-testable offline.
//
// WHY THIS EXISTS: a caller-supplied asset path (an item img, an actor portrait / token texture, a scene
// background, an audio track, a journal image, a card face, a user avatar) is written onto a Foundry
// document VERBATIM by the page handlers. Nothing verified the path resolves, so a guessed/typo'd path
// shipped as a broken 404 — isPlaceholderIcon (dnd5e/icons.ts) only catches blank / `icons/svg/`
// placeholders, NOT a non-blank path that 404s. These two helpers close that gap at every authoring site:
//   • imgResolves(path)   — HEAD-check the path against the Foundry static server.
//   • badAssetWarning(..) — the standard, consistent warning text (substituted vs. kept-broken).
//
// Call-site policy (the handler decides, not this module):
//   • Group A (icons / portraits / token textures): on a 404, substitute a real floor icon
//     (resolveAuthoredIcon / resolveCreatureIcon / GENERIC_ICON) and warn(substituted=true).
//   • Group B (content-defining assets — scene background, audio track, journal image, card face): on a
//     404, KEEP the path (there is nothing to swap a map or a song for) and warn(substituted=false).

/**
 * Impure (browser): true when `img` resolves to a real, fetchable asset on the Foundry static server.
 * Remote (http/https/data) URLs live outside our static server and are trusted as-is; on a network
 * ERROR we FAIL OPEN (return true) so a transient hiccup never strips a legitimate path. A genuine 404
 * resolves with `res.ok === false` (it does not throw), so it is correctly rejected.
 */
export async function imgResolves(img: string): Promise<boolean> {
  if (/^(?:https?:|data:)/i.test(img)) return true;
  try {
    const getRoute = (globalThis as any).foundry?.utils?.getRoute;
    const url = typeof getRoute === 'function' ? getRoute(img) : img;
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return true; // network error → don't punish a possibly-valid path
  }
}

/**
 * Standard warning for a caller-supplied asset path that does not resolve on the server.
 * @param label       the field name shown to the user (e.g. "img", "background", "track", "avatar").
 * @param path        the offending path.
 * @param substituted true  → a real fallback icon was swapped in (rule 8 — icon/portrait sites);
 *                    false → the path was kept (content asset) and renders broken until uploaded/fixed.
 */
export function badAssetWarning(label: string, path: string, substituted: boolean): string {
  return substituted
    ? `Supplied ${label} "${path}" was not found on the server — substituted a real icon (rule 8). ` +
        `Omit it to auto-fill, or copy a verified path from a compendium item / upload it first (upload-asset).`
    : `Supplied ${label} "${path}" was not found on the server — the document was created, but this ` +
        `asset will render broken until you upload it (upload-asset) or correct the path.`;
}
