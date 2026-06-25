// Page-side: faceted compendium discovery. Runs INSIDE the headless Foundry page.
//
// THE unified discovery engine (design.md §2 + the alignment plan's Phase-4 surface): one
// document-type-parameterized, faceted search that subsumes name-search + creature facets +
// spell/item facets. Built on dnd5e's own Compendium Browser (`CompendiumBrowser.fetch` +
// `dnd5e.Filter`) — the system-maintained, 2024-correct facet engine — with the premium-only /
// never-SRD rule (design.md §2.3) enforced by post-filtering each hit's pack from its uuid.
//
// Ground truth confirmed live (dnd5e 5.3.3): see the spike + [[fvtt-mcp-compendium-lookup-facts]].
// `fetch` returns SRD packs, so excludeSrdPacks-by-uuid is mandatory; a raw getIndex fallback
// covers the (unlikely) absence of the system API.

import { excludeSrdPacks, isSrdPack, packPriority } from '../utils/compendium-sources.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FacetFilter {
  k: string; // dnd5e source key-path
  o: string; // dnd5e.Filter operator (_, in, gte, lte, hasany, …)
  v: unknown;
}

type NumOrRange = number | { min?: number; max?: number };

export interface FacetedSearchArgs {
  documentType: string; // friendly content type — a CONTENT_TYPES key
  name?: string; // case-insensitive substring narrowing
  // creature facets
  challengeRating?: NumOrRange;
  creatureType?: string;
  size?: string; // friendly enum (tiny/small/medium/large/huge/gargantuan)
  hasSpells?: boolean;
  hasLegendaryActions?: boolean;
  // spell facets
  spellLevel?: NumOrRange;
  spellSchool?: string | string[];
  damageType?: string; // two-stage (activity damage parts) — not an index facet
  // gear facets
  rarity?: string | string[];
  itemType?: string | string[]; // the item SUBTYPE (system.type.value): wand/wondrous/ammo/…
  magical?: boolean; // detected via the `mgc` property
  properties?: string[];
  limit?: number;
}

export interface CompendiumHit {
  id: string;
  name: string;
  type: string; // dnd5e document subtype (npc/spell/weapon/…)
  uuid: string;
  pack: string;
  packLabel: string;
  img: string;
  facets: Record<string, unknown>;
}

/** What a friendly documentType resolves to: which Document class + dnd5e subtypes + facet family. */
interface ContentTypeDef {
  documentName: 'Actor' | 'Item';
  dndTypes: string[];
  kind: 'creature' | 'spell' | 'gear';
}

// ---------------------------------------------------------------------------
// Static maps (the curated content model — extends with the library, not per pack)
// ---------------------------------------------------------------------------

/**
 * Friendly content type → its Foundry document class, dnd5e subtype(s), and facet family.
 * Discovery is by TYPE (not pack-id suffix) so it spans every in-scope book automatically
 * (Heroes/Ravenloft lump content into `.options`/`.items`, but the document type is uniform).
 */
export const CONTENT_TYPES: Record<string, ContentTypeDef> = {
  creature: { documentName: 'Actor', dndTypes: ['npc'], kind: 'creature' },
  spell: { documentName: 'Item', dndTypes: ['spell'], kind: 'spell' },
  gear: {
    documentName: 'Item',
    dndTypes: ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container'],
    kind: 'gear',
  },
  weapon: { documentName: 'Item', dndTypes: ['weapon'], kind: 'gear' },
  armor: { documentName: 'Item', dndTypes: ['equipment'], kind: 'gear' },
  consumable: { documentName: 'Item', dndTypes: ['consumable'], kind: 'gear' },
};

/** Friendly size enum → dnd5e stored size KEY (what system.traits.size actually holds). */
const SIZE_TO_DND5E: Record<string, string> = {
  tiny: 'tiny',
  small: 'sm',
  medium: 'med',
  large: 'lg',
  huge: 'huge',
  gargantuan: 'grg',
};

/**
 * Friendly spell-school name → dnd5e stored school KEY (what system.school actually holds).
 * Accepts either the full name ('evocation') or the already-correct key ('evo'), so callers and
 * the spells facade never have to know dnd5e's 3-letter codes — the normalization lives here with
 * the other facet-key maps (correctness, not judgment; design.md §2.1). Unknown values pass through
 * lowercased so a future/unmapped school still filters on whatever the index holds.
 */
const SPELL_SCHOOL_TO_DND5E: Record<string, string> = {
  abjuration: 'abj',
  abj: 'abj',
  conjuration: 'con',
  con: 'con',
  divination: 'div',
  div: 'div',
  enchantment: 'enc',
  enc: 'enc',
  evocation: 'evo',
  evo: 'evo',
  illusion: 'ill',
  ill: 'ill',
  necromancy: 'nec',
  nec: 'nec',
  transmutation: 'trs',
  trs: 'trs',
};

/**
 * Friendly rarity → dnd5e stored rarity KEY (what system.rarity holds). The only footgun is
 * "very rare", whose key is the camelCase `veryRare`; everything else is already its own lowercase
 * key. Lookup is space/case-insensitive; unknown values pass through trimmed (so a future key still
 * filters). Lives here with the other facet-key maps (correctness, not judgment; design.md §2.1).
 */
const RARITY_TO_DND5E: Record<string, string> = {
  common: 'common',
  uncommon: 'uncommon',
  rare: 'rare',
  'very rare': 'veryRare',
  veryrare: 'veryRare',
  legendary: 'legendary',
  artifact: 'artifact',
};

/** Index field paths to request per facet family (so projected hits carry their facet values). */
const INDEX_FIELDS: Record<ContentTypeDef['kind'], string[]> = {
  creature: [
    'system.details.cr',
    'system.details.type.value',
    'system.traits.size',
    'system.attributes.spell.level',
    'system.resources.legact.max',
  ],
  spell: ['system.level', 'system.school'],
  gear: ['system.rarity', 'system.type.value', 'system.properties', 'system.price.value'],
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for offline unit testing)
// ---------------------------------------------------------------------------

/** Derive the pack id from a compendium uuid: `Compendium.<scope>.<pack>.<DocType>.<id>` → `<scope>.<pack>`. */
export function packIdFromUuid(uuid: string | undefined): string | null {
  if (!uuid || typeof uuid !== 'string') return null;
  const p = uuid.split('.');
  return p[0] === 'Compendium' && p.length >= 3 ? `${p[1]}.${p[2]}` : null;
}

/** Push a number-or-range facet as exact (`_`) or as a gte/lte pair onto `out`. */
function pushRange(out: FacetFilter[], key: string, v: NumOrRange | undefined): void {
  if (v === undefined) return;
  if (typeof v === 'number') {
    out.push({ k: key, o: '_', v });
    return;
  }
  if (typeof v.min === 'number') out.push({ k: key, o: 'gte', v: v.min });
  if (typeof v.max === 'number') out.push({ k: key, o: 'lte', v: v.max });
}

/** Normalize a string|string[] facet to a lowercased array (dropping empties). */
function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map(s => String(s)).filter(Boolean);
}

/**
 * Build the dnd5e.Filter `{k,o,v}` array from the normalized facets, for a given content kind.
 * Only INDEX-backed facets become filters; `damageType` (activities) and `hasSpells`/
 * `hasLegendaryActions` (embedded data) are handled by post-filtering, not here. Pure + tested.
 */
export function buildFacetFilters(
  kind: ContentTypeDef['kind'],
  args: FacetedSearchArgs
): FacetFilter[] {
  const out: FacetFilter[] = [];
  if (kind === 'creature') {
    pushRange(out, 'system.details.cr', args.challengeRating);
    if (args.creatureType)
      out.push({ k: 'system.details.type.value', o: 'in', v: [args.creatureType.toLowerCase()] });
    if (args.size) {
      const key = SIZE_TO_DND5E[args.size.toLowerCase()] ?? args.size.toLowerCase();
      out.push({ k: 'system.traits.size', o: 'in', v: [key] });
    }
  } else if (kind === 'spell') {
    pushRange(out, 'system.level', args.spellLevel);
    const schools = toArray(args.spellSchool).map(
      s => SPELL_SCHOOL_TO_DND5E[s.toLowerCase()] ?? s.toLowerCase()
    );
    if (schools.length) out.push({ k: 'system.school', o: 'in', v: schools });
  } else if (kind === 'gear') {
    const rarities = toArray(args.rarity).map(
      r => RARITY_TO_DND5E[r.toLowerCase().trim()] ?? r.trim()
    );
    if (rarities.length) out.push({ k: 'system.rarity', o: 'in', v: rarities });
    const subtypes = toArray(args.itemType);
    if (subtypes.length) out.push({ k: 'system.type.value', o: 'in', v: subtypes });
    const props = toArray(args.properties);
    if (props.length) out.push({ k: 'system.properties', o: 'hasany', v: props });
  }
  return out;
}

/** Project a raw index/document hit into the uniform CompendiumHit shape. Pure + tested. */
export function projectHit(
  entry: any,
  kind: ContentTypeDef['kind'],
  packLabel: string
): CompendiumHit {
  const system = entry?.system ?? {};
  const facets: Record<string, unknown> = {};
  if (kind === 'creature') {
    facets.challengeRating = Number(system.details?.cr) || 0;
    facets.creatureType = String(system.details?.type?.value ?? 'unknown').toLowerCase();
    facets.size = String(system.traits?.size ?? 'med').toLowerCase();
    facets.hasSpells = Number(system.attributes?.spell?.level) > 0;
    facets.hasLegendaryActions = Number(system.resources?.legact?.max) > 0;
  } else if (kind === 'spell') {
    facets.spellLevel = Number(system.level) || 0;
    facets.spellSchool = system.school ?? null;
  } else if (kind === 'gear') {
    facets.rarity = system.rarity || '';
    facets.itemType = system.type?.value ?? null;
    facets.properties = Array.isArray(system.properties) ? system.properties : [];
    facets.magical = Array.isArray(system.properties) && system.properties.includes('mgc');
  }
  return {
    id: entry?._id,
    name: entry?.name,
    type: entry?.type,
    uuid: entry?.uuid,
    pack: packIdFromUuid(entry?.uuid) ?? '',
    packLabel,
    img: entry?.img ?? '',
    facets,
  };
}

/** Post-filter predicates the index can't express (embedded data). Pure + tested. */
export function passesPostFilters(hit: CompendiumHit, args: FacetedSearchArgs): boolean {
  if (
    args.name &&
    !String(hit.name ?? '')
      .toLowerCase()
      .includes(args.name.toLowerCase())
  ) {
    return false;
  }
  if (args.hasSpells !== undefined && hit.facets.hasSpells !== args.hasSpells) return false;
  if (
    args.hasLegendaryActions !== undefined &&
    hit.facets.hasLegendaryActions !== args.hasLegendaryActions
  ) {
    return false;
  }
  if (args.magical !== undefined && hit.facets.magical !== args.magical) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Live engine
// ---------------------------------------------------------------------------

/**
 * The bridge entry point: faceted compendium discovery across the premium books.
 *
 * Dispatch: build filters → run them through dnd5e's CompendiumBrowser.fetch (or a raw-getIndex
 * fallback) → exclude SRD packs (design.md §2.3) → optional two-stage spell-damage refine → apply
 * post-filters (name / hasSpells / hasLegendary / magical) → rank premium-first → cap to limit.
 */
export async function searchCompendiumFaceted(args: FacetedSearchArgs): Promise<CompendiumHit[]> {
  const def = CONTENT_TYPES[args?.documentType];
  if (!def) {
    throw new Error(
      `Unknown documentType "${args?.documentType}". Known: ${Object.keys(CONTENT_TYPES).join(', ')}.`
    );
  }
  const limit = args.limit ?? 50;
  const filters = buildFacetFilters(def.kind, args);
  const indexFields = INDEX_FIELDS[def.kind];

  let rawEntries = await runFetch(def, filters, indexFields);

  // design.md §2.3 — SRD packs are never a source; fetch (and the fallback) can surface them.
  rawEntries = rawEntries.filter(e => {
    const pk = packIdFromUuid(e?.uuid);
    return pk && !isSrdPack(pk);
  });

  // Two-stage: spell damage type lives in the activities Map (not indexable), so refine the
  // (already facet-narrowed) survivor set by loading their documents.
  if (def.kind === 'spell' && args.damageType) {
    rawEntries = await refineByDamageType(rawEntries, args.damageType.toLowerCase());
  }

  const packLabelFor = (pk: string) => game.packs.get(pk)?.metadata?.label ?? pk;
  let hits = rawEntries.map(e =>
    projectHit(e, def.kind, packLabelFor(packIdFromUuid(e?.uuid) ?? ''))
  );
  hits = hits.filter(h => passesPostFilters(h, args));

  // Premium-first, then name. (SRD already excluded; this orders books vs other non-SRD packs.)
  hits.sort((a, b) => {
    const pri = packPriority(a.pack) - packPriority(b.pack);
    if (pri !== 0) return pri;
    return String(a.name).localeCompare(String(b.name));
  });

  return hits.slice(0, limit);
}

/** Run the facet filters via CompendiumBrowser.fetch, falling back to raw per-pack getIndex. */
async function runFetch(
  def: ContentTypeDef,
  filters: FacetFilter[],
  indexFields: string[]
): Promise<any[]> {
  const CB = dnd5e?.applications?.CompendiumBrowser;
  const docClass = CONFIG?.[def.documentName]?.documentClass;
  if (typeof CB?.fetch === 'function' && docClass) {
    const res = await CB.fetch(docClass, {
      types: new Set(def.dndTypes),
      filters,
      index: true,
      indexFields: new Set(indexFields),
    });
    return Array.from(res ?? []);
  }
  return fallbackIndexFetch(def, filters, indexFields);
}

/**
 * Fallback when the system Compendium Browser is unavailable: scan premium packs of the right
 * document type via raw getIndex({fields}) and apply the filters in JS. SRD packs are excluded at
 * enumeration; uuids are synthesized so downstream pack-derivation/exclusion still works.
 */
async function fallbackIndexFetch(
  def: ContentTypeDef,
  filters: FacetFilter[],
  indexFields: string[]
): Promise<any[]> {
  const packs = excludeSrdPacks(
    Array.from(game.packs.values()) as any[],
    (p: any) => p?.metadata?.id
  ).filter((p: any) => p?.metadata?.type === def.documentName);

  const out: any[] = [];
  const docType = def.documentName === 'Actor' ? 'Actor' : 'Item';
  for (const pack of packs) {
    try {
      const index = await pack.getIndex({ fields: indexFields });
      for (const entry of index.values() as IterableIterator<any>) {
        if (!def.dndTypes.includes(entry.type)) continue;
        if (!matchesFilters(entry, filters)) continue;
        out.push({
          ...entry,
          uuid: entry.uuid ?? `Compendium.${pack.metadata.id}.${docType}.${entry._id}`,
        });
      }
    } catch {
      // skip packs that fail to index
    }
  }
  return out;
}

/** Minimal JS evaluation of the {k,o,v} filters for the fallback path. Pure + tested. */
export function matchesFilters(entry: any, filters: FacetFilter[]): boolean {
  for (const f of filters) {
    const actual = getPath(entry, f.k);
    switch (f.o) {
      case '_':
        if (actual !== f.v) return false;
        break;
      case 'gte':
        if (!(Number(actual) >= Number(f.v))) return false;
        break;
      case 'lte':
        if (!(Number(actual) <= Number(f.v))) return false;
        break;
      case 'in':
        if (!Array.isArray(f.v) || !(f.v as unknown[]).includes(actual)) return false;
        break;
      case 'hasany': {
        const arr = Array.isArray(actual) ? actual : [];
        if (!Array.isArray(f.v) || !(f.v as unknown[]).some(x => arr.includes(x))) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

/** Read a dotted key-path off an object. */
function getPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/** Load each survivor's document and keep only those with an activity damage part of `damageType`. */
async function refineByDamageType(entries: any[], damageType: string): Promise<any[]> {
  const kept: any[] = [];
  for (const entry of entries) {
    try {
      const doc = entry.uuid ? await fromUuid(entry.uuid) : null;
      if (!doc) continue;
      const src: any = doc.toObject ? doc.toObject() : doc;
      const activities = src.system?.activities ?? {};
      const hasType = Object.values(activities).some((a: any) =>
        (a?.damage?.parts ?? []).some((pt: any) =>
          (pt?.types ?? []).map((t: string) => String(t).toLowerCase()).includes(damageType)
        )
      );
      if (hasType) kept.push(entry);
    } catch {
      // skip entries whose document can't be loaded
    }
  }
  return kept;
}
