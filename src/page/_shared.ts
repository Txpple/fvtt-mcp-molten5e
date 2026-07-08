// Page-side shared helpers — runs INSIDE the headless Foundry page.
//
// Hoisted from the sibling src/page/** modules to remove cross-file duplication.
// Every helper here is a byte-for-byte port of the per-file copies it replaces;
// nothing about the runtime behavior changes. This module is bundled into
// dist/page.bundle.js by esbuild (it follows the imports from src/page/index.ts),
// so it must remain browser-only: no Node, no Playwright — only browser + Foundry
// globals (see foundry-globals.d.ts).

// Foundry's Folder document class isn't declared in foundry-globals.d.ts; reach
// it off globalThis (the established sibling-page-file pattern).
const FolderClass: any = (globalThis as any).Folder;

/**
 * Flag scope for MCP-generated content (e.g. the mcpGenerated marker on auto-created
 * folders). Uses Foundry's reserved 'world' scope — NOT a module id. The headless
 * design ships no module, and once the old `foundry-mcp-bridge` module is uninstalled
 * Foundry rejects that scope ("Flag scope ... is not valid or not currently active").
 * 'world' is always valid. Written into create-data flags and read via direct
 * property access (folder.flags?.[MCP_FLAG_SCOPE]) so it never trips scope validation.
 */
export const MCP_FLAG_SCOPE = 'world';

/**
 * Normalize an asset path: strip a TRAILING query/fragment, decode percent-encoding, drop a
 * leading host/protocol, convert backslashes, remove a leading slash or `Data/` prefix, and
 * re-encode the URL-structural chars (`#`, `?`) that can appear literally in a path segment.
 * Mirrors the old data-access.normalizeAssetPath.
 */
export function normalizeAssetPath(src: string): string {
  if (!src || typeof src !== 'string') return '';
  // Strip ONLY a trailing ?query / #fragment (a delimiter whose remainder has no more path
  // separators). A `#`/`?` INSIDE a path segment — e.g. Tom Cartos's legacy "#48 - Room/" folders —
  // is a literal filename char, not a URL delimiter, and MUST be preserved. (The old
  // `split('?')[0].split('#')[0]` truncated such a path to its parent dir, losing the file.)
  let s = src.trim().replace(/[?#][^/]*$/, '');
  try {
    s = decodeURI(s);
  } catch {
    /* leave as-is if it isn't valid percent-encoding */
  }
  const urlMatch = s.match(/^https?:\/\/[^/]+\/(.*)$/i);
  if (urlMatch) s = urlMatch[1];
  s = s
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^Data\//i, '')
    .replace(/^\/+/, '');
  // Re-encode the URL-structural chars so Foundry's loader builds a valid texture URL from the stored
  // src: a raw `#` would be read as a fragment (truncating the URL → no image), `?` as a query. Spaces
  // / `&` / apostrophes stay literal — Foundry percent-encodes those itself when it loads the asset.
  return s.replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/** File name (last path segment) of an asset path. */
export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p;
}

/**
 * True when an asset path points at a VIDEO file (by extension). Foundry accepts video on a
 * Token/prototype `texture.src` (categories ["IMAGE","VIDEO"]) but NOT on `actor.img` / `item.img`
 * (["IMAGE"]) — so an animated token texture must be kept OFF the still-image portrait field, or the
 * whole document update is rejected. Pure (extension-only), so it unit-tests offline. Mirrors
 * Foundry's CONST.VIDEO_FILE_EXTENSIONS (mp4, ogg, webm, m4v) plus common ogv/mov.
 */
export function isVideoPath(p: string): boolean {
  return /\.(?:webm|mp4|m4v|ogg|ogv|mov)(?:[?#].*)?$/i.test(p ?? '');
}

/**
 * Return a Foundry Document's plain SOURCE data (`document.toObject()`), or the value
 * unchanged if it isn't a Document. Use this before serializing a document's `system`
 * for inspection: in dnd5e 5.x `system.activities` is a Map/Collection, and
 * `Object.keys()` on a Map returns `[]` — so serializing the LIVE `system` silently
 * empties activities (attacks/saves/damage) to `{}`. `toObject()` flattens Maps and
 * Collections to plain objects, so the inspected shape round-trips.
 */
export function toSource(doc: any): any {
  return typeof doc?.toObject === 'function' ? doc.toObject() : doc;
}

/**
 * dnd5e masks `item.name` with `system.unidentified.name` on EVERY read while
 * `system.identified === false` — even for the GM. The real name survives only in the
 * document SOURCE (`item._source.name` / `toObject().name`), so a rename of an
 * unidentified item reads back as a silent no-op unless the source name is surfaced.
 * Returns the source name while the mask is active, undefined otherwise — so read and
 * write-echo shapes can show the mask AS a mask: `{ name: <masked>, trueName: <source> }`.
 * Pure (no game globals), so it unit-tests offline.
 */
export function unmaskedName(item: any): string | undefined {
  if (item?.system?.identified !== false) return undefined;
  // Only trust REAL source data (_source / toObject()); falling back to the item itself
  // would re-read the masked prepared name and present the mask as the "true" name.
  const srcName =
    item?._source?.name ??
    (typeof item?.toObject === 'function' ? item.toObject()?.name : undefined);
  return typeof srcName === 'string' && srcName.length > 0 ? srcName : undefined;
}

/**
 * Resolve a single document from a compendium pack and return a fresh, copy-ready
 * plain data object. The spine of every WHOLE-DOCUMENT compendium-first copy
 * (design.md §2.3): `createActorFromCompendium` and `importItemFromCompendium` both
 * fetch through here. It performs the universal sequence —
 *   game.packs.get(packId) → pack.getDocument(docId) → toObject() → strip `_id`
 * — and returns `{ pack, source, data }`, so each caller still does its own
 * document-type validation (on `source`) and curates/overrides/creates from `data`
 * (a deep copy with the source `_id` removed so Foundry assigns a fresh local id).
 * A caller that creates MANY copies of one source (the actor path's `quantity`)
 * re-derives an independent copy per item via `source.toObject()`.
 *
 * Embedded-item copy (add-feature spells / compendium-features) keeps its own
 * best-effort, name-indexed hand-roll and intentionally does NOT route through here.
 *
 * `opts.requirePackType` enforces a pack DocumentName (e.g. 'Item') BEFORE the
 * fetch — mirroring `importItemFromCompendium`'s pre-fetch guard.
 */
export async function importFromCompendium(
  packId: string,
  docId: string,
  opts: { requirePackType?: string } = {}
): Promise<{ pack: any; source: any; data: any }> {
  if (!packId || !docId) {
    throw new Error('Both packId and itemId are required');
  }
  const pack = game.packs.get(packId);
  if (!pack) {
    throw new Error(
      `Compendium pack not found: "${packId}". Use list-compendium-packs to find the exact id.`
    );
  }
  if (opts.requirePackType && pack.metadata.type !== opts.requirePackType) {
    throw new Error(
      `Pack "${packId}" is type "${pack.metadata.type}", expected "${opts.requirePackType}" — pick a matching pack.`
    );
  }
  const source = await pack.getDocument(docId);
  if (!source) {
    throw new Error(
      `Document "${docId}" not found in pack "${packId}". ` +
        'Use search-compendium / get-compendium-entry to find the exact packId + itemId.'
    );
  }
  const data: any = source.toObject();
  delete data._id; // let Foundry assign a fresh local id (prevents id clash)
  return { pack, source, data };
}

/**
 * Deep-scan plain SOURCE data for unresolved dnd5e `@scale.*` roll-data tokens — the
 * advancement-fed scaling references a copied 2024 class/racial feature carries (e.g. a
 * dragonborn Breath Weapon's `@scale.dragonborn.breath-damage`). On a PC these resolve through
 * class/species ADVANCEMENT; dropped onto an NPC (which has none) they dangle to 0. This REPORTS
 * each occurrence as a fact — `{ path, formula }` — so a caller/skill can set an explicit die; it
 * NEVER guesses the value (design.md §2.1: tools do correctness, skills decide judgment).
 *
 * It matches the literal `@scale.` token across every string value rather than knowing the
 * shape: the token hides in activity damage `bonus`, `custom.formula`, `scaling.formula`, healing
 * formulas, and `uses.max` / recovery formulas — scanning by field would miss one, scanning by
 * token does not. Pass SOURCE data (`toObject()` / `toSource(doc)`), where dnd5e activity Maps are
 * already plain objects (a live `system` would hide them). `path` is the dot-path to the offending
 * string within `data` (e.g. `system.activities.<id>.damage.parts.0.bonus`). Returns [] when clean.
 */
export function findUnresolvedScaleTokens(data: unknown): Array<{ path: string; formula: string }> {
  const out: Array<{ path: string; formula: string }> = [];
  const seen = new WeakSet<object>();
  const HAS_SCALE = /@scale\./;

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (HAS_SCALE.test(node)) out.push({ path, formula: node });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return; // guard cycles (a live doc can self-reference)
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walk(node[i], path ? `${path}.${i}` : String(i));
      }
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k);
    }
  };

  walk(data, '');
  return out;
}

/**
 * True when EVERY `@scale.*` reference in `formula` resolves to a defined value in the actor's
 * roll data. On a type:character copy the class item's ScaleValue advancement is intact, so
 * `rollData.scale.<class>.<id>` exists and the literal token is NOT a problem to report; on an
 * NPC `rollData.scale` is absent and every reference stays unresolved (the current warning
 * behavior). Pure path-walk (no Roll.replaceFormulaData) so a mixed formula like
 * `1d8 + @scale.monk.die` is judged by its references, not by whether substitution left "0".
 */
export function scaleTokensResolveFor(actor: any, formula: string): boolean {
  const refs = formula.match(/@scale\.[\w.-]+/g) ?? [];
  if (refs.length === 0) return false; // caller found "@scale." somewhere we can't parse — report it
  let rollData: any;
  try {
    rollData = actor?.getRollData?.();
  } catch {
    return false;
  }
  if (!rollData) return false;
  return refs.every(ref => {
    let v: any = rollData;
    for (const seg of ref.slice(1).replace(/\.+$/, '').split('.')) {
      if (v === null || typeof v !== 'object') return false;
      v = v[seg];
    }
    return v !== undefined && v !== null;
  });
}

// --- document sanitizer (single source of truth) ----------------------------
// Hoisted from the byte-identical copies in actors.ts (`sanitize`) and items.ts
// (`sanitizeData`/`removeSensitiveFields`). This is the page layer's single
// credential-stripping / cycle-dropping chokepoint, so one copy beats two that can
// silently drift (e.g. the activities-Map fix would otherwise need applying twice).

/** Fields dropped from sanitized output (sensitive). */
const SENSITIVE_FIELDS = new Set([
  'password',
  'token',
  'secret',
  'key',
  'auth',
  'credential',
  'session',
  'cookie',
  'private',
]);
/** Cyclic / bloat / dangerous-accessor fields dropped from sanitized output. */
const PROBLEMATIC_FIELDS = new Set([
  'parent',
  '_parent',
  'collection',
  'apps',
  'document',
  '_document',
  'constructor',
  'prototype',
  '__proto__',
  'valueOf',
  'toString',
  // dnd5e item leveling metadata; full of cycles back to the actor + other items.
  'advancement',
]);
/** Deprecated dnd5e accessors that log a warning when read (filtered before reading). */
const DEPRECATED_FIELDS = new Set(['save']);
/** dnd5e 5.3 moved these senses.* keys under senses.ranges.*; the legacy getters warn. */
const DEPRECATED_DND5E_SENSE_KEYS = ['darkvision', 'blindsight', 'tremorsense', 'truesight'];

function isExcludedField(key: string): boolean {
  return SENSITIVE_FIELDS.has(key) || PROBLEMATIC_FIELDS.has(key) || DEPRECATED_FIELDS.has(key);
}

/**
 * Produce a deep, plain-JSON-safe copy of a Foundry data object: drop sensitive /
 * problematic / deprecated keys, strip private props (keep only `_id`), guard against
 * cycles + runaway depth, and skip the deprecated dnd5e legacy sense getters when the
 * modern `ranges` shape exists. `Object.keys()` never invokes getters, so deprecated
 * accessors are filtered before their values are read.
 *
 * `keepKeyField` is set only for the entries of an ActiveEffect `changes[]` array: each
 * entry carries a `key` field naming the targeted data path (e.g. "system.attributes.ac.bonus").
 * That field collides with the sensitive `key` name but is structural data, not a credential —
 * blanket-stripping it left every effect read-back with keyless (useless) changes. The flag is
 * scoped to the immediate change entry; it does NOT propagate to nested children.
 */
export function sanitizeDocData(
  data: any,
  visited: WeakSet<object> = new WeakSet(),
  depth = 0,
  keepKeyField = false
): any {
  if (data === null || typeof data !== 'object') {
    return data;
  }
  if (depth > 50) {
    return '[Max depth reached]';
  }
  if (visited.has(data)) {
    return '[Circular Reference]';
  }
  visited.add(data);

  try {
    if (Array.isArray(data)) {
      return data.map(item => sanitizeDocData(item, visited, depth + 1, keepKeyField));
    }

    const out: Record<string, any> = {};
    const keys = Object.keys(data);
    const isDnd5eSensesShape =
      keys.includes('ranges') && keys.some(k => DEPRECATED_DND5E_SENSE_KEYS.includes(k));

    for (const key of keys) {
      // ActiveEffect changes[]: recurse the entries preserving their `key` field (the change
      // target path), which the blanket sensitive-field filter would otherwise drop.
      if (key === 'changes' && Array.isArray(data[key])) {
        out[key] = data[key].map((item: any) => sanitizeDocData(item, visited, depth + 1, true));
        continue;
      }
      if (!(keepKeyField && key === 'key') && isExcludedField(key)) continue;
      if (key.startsWith('_') && key !== '_id') continue; // keep only _id among private props
      if (isDnd5eSensesShape && DEPRECATED_DND5E_SENSE_KEYS.includes(key)) continue;

      out[key] = sanitizeDocData(data[key], visited, depth + 1);
    }

    return out;
  } catch {
    return '[Sanitization failed]';
  }
}

/** Slug identifier for a feat/feature (oracle ~8072). */
export function slugify(name: string, fallback = 'feature'): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '') || fallback
  );
}

/**
 * Resolve a world Actor from a free-text identifier (read path — fuzzy).
 * Order: exact id, exact name, then case-insensitive substring on name.
 * Falls back to a scene-token's (possibly synthetic/delta-backed) actor so an
 * unlinked token can still be resolved by its token id.
 * (Oracle: findActorByIdentifier ~4395-4420 / data-access resolveActor.)
 */
export function resolveActorFuzzy(identifier: string): any {
  const worldActor =
    game.actors?.get(identifier) ||
    game.actors?.getName?.(identifier) ||
    Array.from(game.actors ?? []).find((a: any) =>
      a.name?.toLowerCase().includes(identifier.toLowerCase())
    );
  if (worldActor) return worldActor;

  for (const scene of game.scenes ?? []) {
    const token = scene.tokens?.get(identifier);
    if (token?.actor) return token.actor;
  }
  return undefined;
}

/**
 * Resolve an embedded Item on an actor by exact id, then exact name (case-insensitive), then a
 * case-insensitive substring on name (optionally constrained to a `type`). Returns undefined when
 * nothing matches. Shared by the embedded-item editors (updateActorItem, manageActivity, manageEffect).
 */
export function resolveActorItem(actor: any, identifier: string, type?: string): any {
  if (!identifier) return undefined;
  const byId = actor.items?.get?.(identifier);
  if (byId && (!type || byId.type === type)) return byId;
  const idLower = identifier.toLowerCase();
  const typeOk = (i: any) => !type || i.type === type;
  return (
    actor.items?.find((i: any) => typeOk(i) && i.name?.toLowerCase() === idLower) ??
    actor.items?.find((i: any) => typeOk(i) && i.name?.toLowerCase().includes(idLower))
  );
}

/** Resolve a world Item by exact id, then exact name, then a case-insensitive substring. */
export function resolveWorldItem(identifier: string): any {
  const byId = game.items?.get?.(identifier);
  if (byId) return byId;
  const idLower = identifier.toLowerCase();
  return (
    game.items?.getName?.(identifier) ||
    game.items?.find?.((i: any) => i.name?.toLowerCase() === idLower) ||
    game.items?.find?.((i: any) => i.name?.toLowerCase().includes(idLower))
  );
}

/**
 * Turn a dot-path into a Foundry deletion key by prefixing its LAST segment with `-=`
 * (e.g. "system.activities.abc" -> "system.activities.-=abc"), which removes that key on update.
 */
export function toDeletionKey(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx < 0 ? `-=${path}` : `${path.slice(0, idx)}.-=${path.slice(idx + 1)}`;
}

/** Resolve a JournalEntry by exact id then exact name (STRICT — no fuzzy/substring). */
export function resolveJournalStrict(identifier: string): any {
  return (
    game.journal?.get(identifier) || game.journal?.find((j: any) => j.name === identifier) || null
  );
}

/**
 * Canonical dnd5e damage types for soft validation (warn, never block) in attack / aura /
 * attack-with-save authoring and NPC creation. Re-exported from the single pure source
 * (utils/dnd5e-canonical.ts) so the Node tools and the page layer share ONE definition.
 */
export { DAMAGE_TYPES } from '../utils/dnd5e-canonical.js';

/**
 * The colors getOrCreateFolder stamps at creation. deleteActor's empty-folder cleanup uses them
 * as a user-adoption tripwire: a legacy folder that carries mcpGenerated=true but no longer wears
 * a creation color was re-styled by the user and must be kept (see removeFolderIfEmptyAndMcp).
 */
export const MCP_FOLDER_COLOR_ACTOR = '#4a90e2'; // blue for actors
export const MCP_FOLDER_COLOR_OTHER = '#f39c12'; // orange for everything else
export const MCP_FOLDER_CREATION_COLORS: ReadonlySet<string> = new Set([
  MCP_FOLDER_COLOR_ACTOR,
  MCP_FOLDER_COLOR_OTHER,
]);

/**
 * Resolve or create a Folder by name scoped to the given document type. Returns
 * the folder id, or null when absent and creation fails (so callers create the
 * document without a folder rather than failing outright).
 *
 * `markGenerated` flags the new folder mcpGenerated (auto-removable when empty) and must be
 * true ONLY for bridge-invented housekeeping names ("Foundry MCP Creatures" / "Foundry MCP
 * Characters") — never for a folder name the user supplied (tool folder params, move targets).
 *
 * Hoisted from the five identical per-file copies (actors / journals / collections
 * / organization / dnd5e/npc). Color (#4a90e2 for Actor, #f39c12 otherwise),
 * per-type descriptions, the mcpGenerated flag namespace, and questContext are all
 * identical across those copies. The ONLY thing that differed was the console.warn
 * prefix on failure (some sites prefixed `[foundry-mcp-bridge] `, some did not), so
 * that prefix is parameterized via `warnLabel` to keep each call site byte-identical.
 */
export async function getOrCreateFolder(
  folderName: string,
  type: string,
  warnLabel = '',
  markGenerated = false
): Promise<string | null> {
  try {
    const existingFolder = game.folders?.find((f: any) => f.name === folderName && f.type === type);
    if (existingFolder) {
      return existingFolder.id;
    }

    let description = '';
    if (type === 'Actor') {
      if (folderName === 'Foundry MCP Creatures') {
        description = 'Creatures and monsters created via Foundry MCP';
      } else {
        description = `NPCs and creatures related to: ${folderName}`;
      }
    } else {
      description = `Quest and content for: ${folderName}`;
    }

    const folderData = {
      name: folderName,
      type,
      description,
      color: type === 'Actor' ? MCP_FOLDER_COLOR_ACTOR : MCP_FOLDER_COLOR_OTHER,
      sort: 0,
      parent: null,
      flags: {
        [MCP_FLAG_SCOPE]: {
          // mcpGenerated marks BRIDGE-INVENTED housekeeping folders (safe to auto-remove when
          // empty). A folder minted from a USER-SUPPLIED name is the user's org structure even
          // though the bridge created the document — it must never be auto-removed (the `_DM`
          // incident: an old user-named folder carried the flag and deleteActor cleanup ate it).
          mcpGenerated: markGenerated,
          createdAt: new Date().toISOString(),
          questContext: type === 'JournalEntry' ? folderName : undefined,
        },
      },
    };

    const folder = await FolderClass.create(folderData as any);
    return folder?.id || null;
  } catch (error) {
    console.warn(`${warnLabel}Failed to create folder "${folderName}":`, error);
    return null;
  }
}
