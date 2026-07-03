// Node-side output formatters for the placeable CRUD kernel (src/page/_placeables.ts).
//
// The four string renderers every per-type placeable tool would otherwise duplicate, lifted from the
// hand-written Region/Note handlers so a new type's four handlers become one-liners. Pure string/JSON
// shaping — no I/O. `noun` is the singular placeable name (e.g. "tile"), rendered as "N tile(s)".

interface CreateResult {
  notFound?: string;
  sceneId?: string;
  sceneName?: string;
  created?: number;
  items?: Array<Record<string, any>>;
  errors?: string[];
  warnings?: string[];
}

interface ListResult {
  found?: boolean;
  notFound?: string;
}

interface UpdateResult {
  notFound?: string;
  sceneId?: string;
  sceneName?: string;
  matched?: number;
  updated?: number;
  notFoundIds?: string[];
  warnings?: string[];
}

interface DeleteResult {
  notFound?: string;
  sceneId?: string;
  sceneName?: string;
  deleted?: number;
  notFoundIds?: string[];
}

function warningBlock(warnings?: string[]): string {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  return `\n\n⚠️ ${warnings.length} warning(s):\n${warnings.map(w => `- ${w}`).join('\n')}`;
}

/** "Created N tile(s) on "Scene" (id)" + one line per created id, + per-item errors + warnings. */
export function formatCreatePlaceables(r: CreateResult, noun: string): string {
  if (r?.notFound) return `Scene not found: "${r.notFound}". No ${noun}s created.`;
  const lines = Array.isArray(r?.items)
    ? r.items.map(it => `\n  • ${it.id}${it.name ? ` — ${it.name}` : ''}`).join('')
    : '';
  const errs = Array.isArray(r?.errors) ? r.errors.map(e => `\n  ⚠ ${e}`).join('') : '';
  return (
    `Created ${r?.created ?? 0} ${noun}(s) on "${r?.sceneName}" (${r?.sceneId})` +
    lines +
    errs +
    warningBlock(r?.warnings)
  );
}

/** List: pass the structured result straight through (ids + fields), or a not-found message. */
export function formatListPlaceables(r: ListResult, noun: string): unknown {
  if (r?.found === false) return `Scene not found: "${r?.notFound}" (no ${noun}s).`;
  return r;
}

/** "Updated N of M matched tile(s) on "Scene" (id)" + unresolved ids + warnings. */
export function formatUpdatePlaceables(r: UpdateResult, noun: string): string {
  if (r?.notFound) return `Scene not found: "${r.notFound}". Nothing changed.`;
  const missing =
    Array.isArray(r?.notFoundIds) && r.notFoundIds.length > 0
      ? `\n  (not found: ${r.notFoundIds.join(', ')})`
      : '';
  if ((r?.matched ?? 0) === 0) {
    return `No ${noun}s matched on "${r?.sceneName}" (${r?.sceneId})${missing}.`;
  }
  return (
    `Updated ${r?.updated ?? 0} of ${r?.matched ?? 0} matched ${noun}(s) on ` +
    `"${r?.sceneName}" (${r?.sceneId})` +
    missing +
    warningBlock(r?.warnings)
  );
}

/** "Deleted N tile(s) from "Scene" (id)" + a not-found-ids tail. */
export function formatDeletePlaceables(r: DeleteResult, noun: string): string {
  if (r?.notFound) return `Scene not found: "${r.notFound}". Nothing deleted.`;
  const missing =
    Array.isArray(r?.notFoundIds) && r.notFoundIds.length > 0
      ? ` (${r.notFoundIds.length} id(s) not found: ${r.notFoundIds.join(', ')})`
      : '';
  return `Deleted ${r?.deleted ?? 0} ${noun}(s) from "${r?.sceneName}" (${r?.sceneId})${missing}.`;
}
