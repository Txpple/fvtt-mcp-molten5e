// Page-side: actor / character reads + writes. Runs INSIDE the headless Foundry page.
//
// Reads are pure against game.* collections. Writes (create-from-compendium,
// delete, add/remove embedded items) perform awaited Foundry document mutations
// and are best-effort (no rollback). No Node, no Playwright, no module
// scaffolding (settings/permissions/transactions/sockets) — the bridge is always
// GM. Each exported function takes a single args object matching the payload the
// Node tools send via foundry.call(name, args) and returns the exact
// JSON-serializable shape the Node tools + their tests already expect.

import {
  resolveActorFuzzy as resolveActor,
  getOrCreateFolder as getOrCreateFolderShared,
  importFromCompendium,
  findUnresolvedScaleTokens,
  MCP_FLAG_SCOPE,
  resolveActorItem,
  toDeletionKey,
  toSource,
  sanitizeDocData as sanitize,
} from './_shared.js';
import {
  ABILITIES,
  ARMOR_CALC,
  CONDITION_TYPES,
  CREATURE_TYPES,
  DAMAGE_TYPES,
  normalizeCR,
  normalizeSize,
  normalizeSkill,
  SKILL_ABILITY,
} from './dnd5e/actor-fields.js';
import { imgResolves, badAssetWarning } from './img-resolve.js';
import { resolveCreatureIcon, GENERIC_ICON } from './dnd5e/icons.js';
import {
  readDarkvision,
  resolveDisposition,
  TOKEN_DISPOSITION,
  tokenDefaults,
} from './dnd5e/token-defaults.js';

// Foundry document class (Actor) lives in the page global scope but is not
// declared in foundry-globals.d.ts; reach it off globalThis (loosely typed).
const ActorClass: any = (globalThis as any).Actor;

// Legacy bridge id — kept ONLY as a console log prefix. The folder flag namespace
// moved to MCP_FLAG_SCOPE ('world') so it stays valid after the foundry-mcp-bridge
// module is uninstalled (an unregistered scope throws on getFlag/setFlag).
const MODULE_ID = 'foundry-mcp-bridge';

// ---------------------------------------------------------------------------
// Local helpers (kept in-file; cross-domain candidates listed in the handoff).
// ---------------------------------------------------------------------------

// dnd5e spell targeting / slot extraction --------------------------------------

function extractDnd5eSpellTargeting(spellSystem: any): {
  range?: string;
  target?: string;
  area?: string;
} {
  const result: { range?: string; target?: string; area?: string } = {};

  const rangeValue = spellSystem?.range?.value;
  const rangeUnits = spellSystem?.range?.units;
  if (rangeUnits === 'self') {
    result.range = 'Self';
  } else if (rangeUnits === 'touch') {
    result.range = 'Touch';
  } else if (rangeUnits === 'spec') {
    result.range = spellSystem?.range?.special || 'Special';
  } else if (rangeValue && rangeUnits) {
    result.range = `${rangeValue} ${rangeUnits}`;
  }

  const targetType = spellSystem?.target?.type;
  const targetValue = spellSystem?.target?.value;
  if (targetType === 'self') {
    result.target = 'self';
  } else if (targetType === 'creature' || targetType === 'ally' || targetType === 'enemy') {
    result.target = targetValue
      ? `${targetValue} ${targetType}${targetValue > 1 ? 's' : ''}`
      : targetType;
  } else if (targetType === 'object') {
    result.target = targetValue ? `${targetValue} object${targetValue > 1 ? 's' : ''}` : 'object';
  } else if (targetType === 'space' || targetType === 'point') {
    result.target = 'point';
  } else if (targetType) {
    result.target = targetType;
  }

  const areaType = spellSystem?.target?.template?.type;
  const areaSize = spellSystem?.target?.template?.size;
  const areaUnits = spellSystem?.target?.template?.units || 'ft';
  if (areaType && areaSize) {
    result.area = `${areaSize}-${areaUnits} ${areaType}`;
    if (!result.target || result.target === 'point') {
      result.target = 'area';
    }
  }

  return result;
}

// NOTE: this READ surface keys slots `level1..level9` (+ `pact`), whereas the WRITE side
// (dnd5e/spells.ts setActorSpellcasting) reports them as `spell1..spell9` (+ `pact`). The two
// are intentionally different output contracts, each matching its own consumer/oracle — don't
// "unify" one to the other without updating that consumer.
function extractDnd5eSpellSlots(
  spellsData: any
): Record<string, { value: number; max: number }> | undefined {
  const slots: Record<string, { value: number; max: number }> = {};

  for (let level = 1; level <= 9; level++) {
    const slotData = spellsData?.[`spell${level}`];
    if (slotData && (slotData.max > 0 || slotData.value > 0)) {
      slots[`level${level}`] = {
        value: slotData.value ?? 0,
        max: slotData.max ?? 0,
      };
    }
  }

  const pactSlot = spellsData?.pact;
  if (pactSlot && (pactSlot.max > 0 || pactSlot.value > 0)) {
    slots.pact = {
      value: pactSlot.value ?? 0,
      max: pactSlot.max ?? 0,
    };
  }

  return Object.keys(slots).length > 0 ? slots : undefined;
}

interface SpellInfo {
  id: string;
  name: string;
  level: number;
  prepared?: boolean | undefined;
  /** dnd5e 5.x casting method: atwill / innate / ritual / pact / spell. */
  method?: string | undefined;
  traits?: string[] | undefined;
  actionCost?: string | undefined;
  range?: string | undefined;
  target?: string | undefined;
  area?: string | undefined;
}

/**
 * Coerce a dnd5e 5.x spell `system.prepared` (0/1/2) — or legacy boolean — to a boolean.
 * Absent → true (the historical default: a spell with no preparation flag reads as prepared).
 */
function coerceSpellPrepared(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'number') return v > 0;
  return !!v;
}

interface SpellcastingEntry {
  id: string;
  name: string;
  type: string;
  ability?: string | undefined;
  slots?: Record<string, { value: number; max: number }> | undefined;
  spells: SpellInfo[];
}

/**
 * Build dnd5e spellcasting entries grouped by spellcasting class (with a general
 * fallback when no class-based entry can be derived but spells exist).
 */
function extractSpellcastingData(actor: any): SpellcastingEntry[] {
  const entries: SpellcastingEntry[] = [];
  const systemId = game.system?.id;
  if (systemId !== 'dnd5e') return entries;

  const spellItems = actor.items.filter((item: any) => item.type === 'spell');
  const classes = actor.items.filter((item: any) => item.type === 'class');
  const spellSlots = actor.system?.spells || {};

  const spellsByClass: Record<string, SpellInfo[]> = {};

  for (const spell of spellItems) {
    const spellSystem = spell.system;
    const spellRaw = spell._source?.system || spellSystem;
    const sourceItem = spellSystem?.sourceItem;
    const sourceClass =
      (sourceItem
        ? typeof sourceItem === 'string'
          ? sourceItem
          : sourceItem.identifier || sourceItem.id
        : spellRaw?.sourceClass) || 'general';

    if (!spellsByClass[sourceClass]) {
      spellsByClass[sourceClass] = [];
    }

    const targeting = extractDnd5eSpellTargeting(spellSystem);
    spellsByClass[sourceClass].push({
      id: spell.id || '',
      name: spell.name || '',
      level: spellSystem?.level || 0,
      prepared: coerceSpellPrepared(spellSystem?.prepared),
      method: spellSystem?.method,
      traits: [],
      actionCost: spellSystem?.activation?.type || undefined,
      range: targeting.range,
      target: targeting.target,
      area: targeting.area,
    });
  }

  for (const classItem of classes) {
    const classSystem = classItem.system;
    if (classSystem?.spellcasting?.progression && classSystem.spellcasting.progression !== 'none') {
      const className = classItem.name || 'Unknown';
      const classSpells =
        spellsByClass[classItem.id || ''] || spellsByClass[className.toLowerCase()] || [];

      entries.push({
        id: classItem.id || '',
        name: `${className} Spellcasting`,
        type: classSystem?.spellcasting?.type || 'prepared',
        ability: classSystem?.spellcasting?.ability || undefined,
        slots: extractDnd5eSpellSlots(spellSlots),
        spells: classSpells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
      });
    }
  }

  if (entries.length === 0 && spellItems.length > 0) {
    const allSpells: SpellInfo[] = [];
    for (const spell of spellItems) {
      const spellSystem = spell.system;
      const targeting = extractDnd5eSpellTargeting(spellSystem);
      allSpells.push({
        id: spell.id || '',
        name: spell.name || '',
        level: spellSystem?.level || 0,
        prepared: coerceSpellPrepared(spellSystem?.prepared),
        method: spellSystem?.method,
        actionCost: spellSystem?.activation?.type || undefined,
        range: targeting.range,
        target: targeting.target,
        area: targeting.area,
      });
    }

    entries.push({
      id: 'spellcasting',
      name: 'Spellcasting',
      type: 'prepared',
      slots: extractDnd5eSpellSlots(spellSlots),
      spells: allSpells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Exported page API.
// ---------------------------------------------------------------------------

/**
 * List world actors as { id, name, type, img? }, optionally filtered by type.
 * (The old module filtered in the query handler; we fold that filter in here.)
 */
export function listActors(args?: { type?: string }): unknown {
  const type = args?.type;
  return Array.from(game.actors ?? [])
    .filter((actor: any) => !type || actor.type === type)
    .map((actor: any) => ({
      id: actor.id || '',
      name: actor.name || '',
      type: actor.type,
      ...(actor.img ? { img: actor.img } : {}),
    }));
}

/**
 * dnd5e 5.x saving throws. The derived total per ability lives at `abilities.<ab>.save.value`
 * (in 5.x `save` is an object field, not the legacy numeric getter). Read it directly off the
 * LIVE actor here — the sanitizer strips the `save` key tree-wide (the legacy getter is
 * deprecated), and reading the authoritative derived value avoids reimplementing dnd5e's save
 * math node-side. `proficient` is 0 / 0.5 / 1 (none / half / proficient).
 */
function extractSaves(
  actor: any
): Record<string, { value: number; proficient: number }> | undefined {
  const abilities = actor?.system?.abilities;
  if (!abilities || typeof abilities !== 'object') return undefined;
  const saves: Record<string, { value: number; proficient: number }> = {};
  for (const [key, ability] of Object.entries(abilities)) {
    const ab = ability as any;
    const value = ab?.save?.value; // 5.x derived total save bonus
    if (typeof value === 'number') {
      saves[key] = { value, proficient: ab.proficient ?? 0 };
    }
  }
  return Object.keys(saves).length > 0 ? saves : undefined;
}

/**
 * dnd5e DERIVED values, read off the LIVE actor (NOT toObject()). The get-actor system blob is
 * sanitized from `toObject().system`, which is the SOURCE data and so omits every prepared/derived
 * field: ability `.mod`, skill `.total`/`.passive`/`.mod`, `attributes.ac.value`,
 * `attributes.init.total`, the available-legendary-actions `legact.value` (= max − spent), and the
 * CR-derived `details.xp.value`. Reading them here (the same way extractSaves reads save totals)
 * lets the Node extractor surface real modifiers instead of zeros. Returns undefined when there is
 * nothing derived to report.
 */
function extractDerived(actor: any): Record<string, any> | undefined {
  const system = actor?.system;
  if (!system || typeof system !== 'object') return undefined;
  const out: Record<string, any> = {};

  if (system.abilities && typeof system.abilities === 'object') {
    const abilities: Record<string, { mod: number }> = {};
    for (const [key, ab] of Object.entries(system.abilities)) {
      const mod = (ab as any)?.mod;
      if (typeof mod === 'number') abilities[key] = { mod };
    }
    if (Object.keys(abilities).length > 0) out.abilities = abilities;
  }

  if (system.skills && typeof system.skills === 'object') {
    const skills: Record<string, { total: number; passive: number; mod: number }> = {};
    for (const [key, sk] of Object.entries(system.skills)) {
      const s = sk as any;
      if (typeof s?.total === 'number') {
        skills[key] = { total: s.total, passive: s.passive ?? 0, mod: s.mod ?? s.total };
      }
    }
    if (Object.keys(skills).length > 0) out.skills = skills;
  }

  const acValue = system.attributes?.ac?.value;
  if (typeof acValue === 'number') out.ac = { value: acValue };

  const initTotal = system.attributes?.init?.total;
  if (typeof initTotal === 'number') out.init = { total: initTotal };

  const legact = system.resources?.legact;
  if (legact && typeof legact.value === 'number') {
    out.legact = { value: legact.value, max: legact.max ?? 0 };
  }

  const xpValue = system.details?.xp?.value;
  if (typeof xpValue === 'number') out.xp = { value: xpValue };

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Detailed character info for one actor, resolved by name or id.
 * Payload mirrors the bridge query: { characterName?, characterId? }.
 * Returns the full CharacterInfo shape the Node character tool consumes:
 * id/name/type, optional img, sanitized system, sanitized items, effects,
 * and (when present) dnd5e spellcasting.
 */
export function getCharacterInfo(args: { characterName?: string; characterId?: string }): unknown {
  const identifier = args?.characterName || args?.characterId;
  if (!identifier) {
    throw new Error('characterName or characterId is required');
  }

  let actor: any;
  // Prefer an exact id when the identifier is a Foundry id length.
  if (identifier.length === 16) {
    actor = game.actors?.get(identifier);
  }
  if (!actor) {
    actor = Array.from(game.actors ?? []).find(
      (a: any) => a.name?.toLowerCase() === identifier.toLowerCase()
    );
  }
  if (!actor) {
    throw new Error(`Character not found: ${identifier}`);
  }

  const characterData: Record<string, any> = {
    id: actor.id || '',
    name: actor.name || '',
    type: actor.type,
    ...(actor.img ? { img: actor.img } : {}),
    // Sanitize toObject() source, not the live document: in dnd5e 5.x system.activities is a Map,
    // and Object.keys() on a Map returns [] — so sanitizing the live `system` silently empties
    // activities (attacks/saves/damage) to {}. toObject() flattens Maps/Collections to plain data.
    system: sanitize(toSource(actor).system),
    items: actor.items.map((item: any) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      ...(item.img ? { img: item.img } : {}),
      system: sanitize(toSource(item).system),
    })),
    effects: actor.effects.map((effect: any) => {
      const dur = effect.duration;
      const durRaw = effect._source?.duration;
      // toObject().changes is plain data ({ key, value, type, ... }); surface it so effects are
      // inspectable from get-actor (the shared sanitizer also preserves changes[].key — see R2).
      const changes = toSource(effect).changes;
      return {
        id: effect.id,
        name: effect.name || effect.label || 'Unknown Effect',
        ...(effect.icon ? { icon: effect.icon } : {}),
        disabled: effect.disabled,
        ...(Array.isArray(changes) && changes.length > 0 ? { changes } : {}),
        ...(dur
          ? {
              duration: {
                type: dur.units ?? durRaw?.type ?? 'none',
                duration: dur.seconds ?? durRaw?.duration,
                remaining: dur.remaining,
              },
            }
          : {}),
      };
    }),
  };

  const spellcastingEntries = extractSpellcastingData(actor);
  if (spellcastingEntries.length > 0) {
    characterData.spellcasting = spellcastingEntries;
  }

  // Saving throws — derived totals read from the live actor (the sanitizer drops `save`).
  const saves = extractSaves(actor);
  if (saves) {
    characterData.saves = saves;
  }

  // Derived values (ability/skill modifiers, AC, init, legendary actions, xp) — read from the
  // LIVE actor because the sanitized `system` blob comes from toObject() (source data) and omits
  // every prepared field. The Node extractor prefers this block over the (absent) source values.
  const derived = extractDerived(actor);
  if (derived) {
    characterData.derived = derived;
  }

  return characterData;
}

/**
 * Fetch a single entity (item, action, or effect) from a character.
 * Payload: { characterIdentifier, entityIdentifier }. Returns a tagged result
 * { success, entityType, entity } whose entity shape varies by type.
 */
export function getCharacterEntity(args: {
  characterIdentifier: string;
  entityIdentifier: string;
}): unknown {
  const { characterIdentifier, entityIdentifier } = args;

  try {
    const character = Array.from(game.actors ?? []).find(
      (actor: any) =>
        actor.id === characterIdentifier ||
        actor.name?.toLowerCase() === characterIdentifier.toLowerCase()
    );

    if (!character) {
      throw new Error(`Character not found: "${characterIdentifier}"`);
    }

    // 1. Items (by id or name).
    const items = (character as any).items?.contents ?? [];
    let entity = items.find(
      (item: any) =>
        item.id === entityIdentifier || item.name?.toLowerCase() === entityIdentifier.toLowerCase()
    );

    if (entity) {
      return {
        success: true,
        entityType: 'item',
        entity: {
          id: entity.id,
          name: entity.name,
          type: entity.type,
          img: entity.img,
          description: entity.system?.description?.value || entity.system?.description || '',
          // toObject() source so dnd5e activity Maps survive serialization (see toSource).
          system: toSource(entity).system,
        },
      };
    }

    // 2. Actions (systems that surface actions as a separate collection).
    if ((character as any).system?.actions) {
      const actions = Array.isArray((character as any).system.actions)
        ? (character as any).system.actions
        : Object.values((character as any).system.actions || {});

      entity = actions.find(
        (action: any) =>
          action.id === entityIdentifier ||
          action.name?.toLowerCase() === entityIdentifier.toLowerCase()
      );

      if (entity) {
        return {
          success: true,
          entityType: 'action',
          entity,
        };
      }
    }

    // 3. Effects (by id or name).
    const effects = (character as any).effects?.contents ?? [];
    entity = effects.find(
      (effect: any) =>
        effect.id === entityIdentifier ||
        effect.name?.toLowerCase() === entityIdentifier.toLowerCase()
    );

    if (entity) {
      return {
        success: true,
        entityType: 'effect',
        entity: {
          id: entity.id,
          name: entity.name || entity.label,
          icon: entity.icon,
          disabled: entity.disabled,
          duration: entity.duration,
          changes: entity.changes,
        },
      };
    }

    throw new Error(
      `Entity not found: "${entityIdentifier}" in character "${(character as any).name}"`
    );
  } catch (error) {
    throw new Error(
      `Failed to get character entity: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Token-efficient search within a character's items, spells, actions, effects.
 * Payload: { characterIdentifier, query?, type?, category?, limit? } (limit 20).
 * Returns { characterId, characterName, query?, type?, category?, matches, totalMatches }.
 */
export function searchCharacterItems(args: {
  characterIdentifier: string;
  query?: string;
  type?: string;
  category?: string;
  limit?: number;
}): unknown {
  const { characterIdentifier, query, type, category, limit = 20 } = args;

  const actor = resolveActor(characterIdentifier);
  if (!actor) {
    throw new Error(`Character not found: ${characterIdentifier}`);
  }

  const systemId = game.system?.id;
  const matches: any[] = [];

  const searchQuery = query?.toLowerCase().trim();
  const searchType = type?.toLowerCase().trim();
  const searchCategory = category?.toLowerCase().trim();

  const matchesQuery = (text: unknown): boolean => {
    if (!searchQuery) return true;
    if (typeof text !== 'string') return false;
    return text.toLowerCase().includes(searchQuery);
  };

  const matchesType = (itemType: string): boolean => {
    if (!searchType) return true;
    return itemType.toLowerCase() === searchType;
  };

  // Items / spells / equipment.
  for (const item of actor.items) {
    const itemSystem = item.system;

    if (!matchesType(item.type)) continue;

    let description = itemSystem?.description?.value || itemSystem?.description;
    if (typeof description !== 'string') description = '';
    if (!matchesQuery(item.name) && !matchesQuery(description)) continue;

    const result: any = {
      id: item.id,
      name: item.name,
      type: item.type,
    };

    if (description) {
      const plainText = description.replace(/<[^>]*>/g, '').trim();
      result.description = plainText.length > 300 ? `${plainText.substring(0, 300)}...` : plainText;
    }

    if (item.type === 'spell') {
      result.level = itemSystem?.level?.value ?? itemSystem?.level ?? itemSystem?.rank ?? 0;
      // dnd5e 5.x: spell preparation is system.prepared (0/1/2) + system.method; the legacy
      // system.preparation.prepared shape is gone.
      result.prepared = itemSystem?.prepared ?? itemSystem?.location?.prepared;
      result.method = itemSystem?.method;
      result.expended = itemSystem?.location?.expended;

      if (systemId === 'dnd5e') {
        const targeting = extractDnd5eSpellTargeting(itemSystem);
        if (targeting.range) result.range = targeting.range;
        if (targeting.target) result.target = targeting.target;
        if (targeting.area) result.area = targeting.area;
        result.actionCost = itemSystem?.activation?.type;
      }

      if (searchCategory) {
        const spellLevel = result.level || 0;
        // dnd5e 5.x system.prepared is 0/1/2 (a number); treat >0 as prepared. (Legacy boolean data
        // still works via the !== false fallback.)
        const isPrepared =
          typeof result.prepared === 'number' ? result.prepared > 0 : result.prepared !== false;
        const isCantrip = spellLevel === 0;

        if (searchCategory === 'cantrip' && !isCantrip) continue;
        if (searchCategory === 'prepared' && !isPrepared) continue;
      }
    }

    if (['weapon', 'armor', 'equipment', 'consumable', 'backpack', 'loot'].includes(item.type)) {
      result.quantity = itemSystem?.quantity ?? 1;
      result.equipped = itemSystem?.equipped ?? false;
      result.invested = itemSystem?.equipped?.invested ?? itemSystem?.invested ?? undefined;

      if (searchCategory) {
        if (searchCategory === 'equipped' && !result.equipped) continue;
        if (searchCategory === 'invested' && !result.invested) continue;
      }
    }

    matches.push(result);

    if (matches.length >= limit) break;
  }

  // Actions (system actions or action-typed items).
  if (!searchType || searchType === 'action') {
    const actions =
      actor.system?.actions || actor.items?.filter((i: any) => i.type === 'action') || [];
    for (const action of actions) {
      if (matches.length >= limit) break;

      const actionName = action.name || action.label || '';
      if (!matchesQuery(actionName)) continue;

      matches.push({
        id: action.id || action.slug || actionName,
        name: actionName,
        type: 'action',
        actionType: action.type || action.actionType || 'action',
      });
    }
  }

  // Effects.
  if (!searchType || searchType === 'effect') {
    const effects = actor.effects || [];
    for (const effect of effects) {
      if (matches.length >= limit) break;

      if (!matchesQuery(effect.name || effect.label)) continue;

      matches.push({
        id: effect.id,
        name: effect.name || effect.label,
        type: 'effect',
        description: effect.description || undefined,
      });
    }
  }

  const result: Record<string, any> = {
    characterId: actor.id || '',
    characterName: actor.name || '',
    matches,
    totalMatches: matches.length,
  };

  if (query) result.query = query;
  if (type) result.type = type;
  if (category) result.category = category;

  return result;
}

/**
 * Resolve an actor by free-text identifier, returning { id, name } or null.
 * Payload: { identifier }.
 */
export function findActor(args: { identifier: string }): unknown {
  try {
    const actor = resolveActor(args.identifier);
    return actor ? { id: actor.id, name: actor.name } : null;
  } catch (error) {
    console.error('Error finding actor:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write helpers (local; no rollback — writes are best-effort in v1).
// ---------------------------------------------------------------------------

/**
 * Resolve or create a folder for organizing MCP-generated content, scoped to a
 * document `type`. Thin wrapper over the shared helper that preserves this
 * file's `[foundry-mcp-bridge]`-prefixed console.warn on failure.
 */
async function getOrCreateFolder(folderName: string, type: string): Promise<string | null> {
  return getOrCreateFolderShared(folderName, type, `[${MODULE_ID}] `);
}

interface TokenPlacement {
  actorIds: string[];
  placement: 'random' | 'grid' | 'center' | 'coordinates';
  hidden: boolean;
  coordinates?: { x: number; y: number }[];
}

/**
 * Compute the position for the index-th token under the given placement mode.
 */
function calculateTokenPosition(
  placement: 'random' | 'grid' | 'center' | 'coordinates',
  scene: any,
  index: number,
  coordinates?: { x: number; y: number }[]
): { x: number; y: number } {
  const gridSize = scene.grid?.size || 100;

  switch (placement) {
    case 'coordinates': {
      if (coordinates?.[index]) {
        return coordinates[index];
      }
      const fallbackCols = Math.ceil(Math.sqrt(index + 1));
      const fallbackRow = Math.floor(index / fallbackCols);
      const fallbackCol = index % fallbackCols;
      return {
        x: gridSize + fallbackCol * gridSize * 2,
        y: gridSize + fallbackRow * gridSize * 2,
      };
    }

    case 'center':
      return {
        x: scene.width / 2 + index * gridSize,
        y: scene.height / 2,
      };

    case 'grid': {
      const cols = Math.ceil(Math.sqrt(index + 1));
      const row = Math.floor(index / cols);
      const col = index % cols;
      return {
        x: gridSize + col * gridSize * 2,
        y: gridSize + row * gridSize * 2,
      };
    }
    default:
      return {
        x: Math.random() * (scene.width - gridSize),
        y: Math.random() * (scene.height - gridSize),
      };
  }
}

/**
 * Place tokens for the given world actors onto the current scene. Best-effort:
 * actors that fail to prepare are collected as errors and skipped. Returns
 * { success, tokensCreated, tokenIds, errors? }.
 */
async function addActorsToScene(placement: TokenPlacement): Promise<{
  success: boolean;
  tokensCreated: number;
  tokenIds: string[];
  errors?: string[];
}> {
  const scene = game.scenes.current;
  if (!scene) {
    throw new Error('No active scene found');
  }

  const tokenData: any[] = [];
  const errors: string[] = [];

  for (const actorId of placement.actorIds) {
    try {
      const actor = game.actors.get(actorId);
      if (!actor) {
        errors.push(`Actor ${actorId} not found`);
        continue;
      }

      const tokenDoc = actor.prototypeToken.toObject();
      const position = calculateTokenPosition(
        placement.placement,
        scene,
        tokenData.length,
        placement.coordinates
      );

      // Clear any lingering remote token texture URL (Foundry may have
      // re-applied the source after our actor-creation fix).
      if (tokenDoc.texture?.src?.startsWith('http')) {
        console.error(
          `[${MODULE_ID}] Token texture still has remote URL, clearing: ${tokenDoc.texture.src}`
        );
        tokenDoc.texture.src = null;
      }

      tokenData.push({
        ...tokenDoc,
        x: position.x,
        y: position.y,
        actorId,
        hidden: placement.hidden,
      });
    } catch (error) {
      errors.push(
        `Failed to prepare token for actor ${actorId}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Never call createEmbeddedDocuments with [] (it can throw), and if the create itself rejects, degrade
  // into the errors[] channel instead of rejecting the whole call — so one un-placeable actor doesn't
  // wipe token placement for the actors that DID prepare (caller: createActorFromCompendium).
  let createdTokens: any[] = [];
  if (tokenData.length > 0) {
    try {
      createdTokens = await scene.createEmbeddedDocuments('Token', tokenData);
    } catch (error) {
      errors.push(
        `Failed to place ${tokenData.length} token(s) on the scene: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  return {
    success: createdTokens.length > 0,
    tokensCreated: createdTokens.length,
    tokenIds: createdTokens.map((token: any) => token.id),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** Count documents + subfolders directly inside a folder (direct children only). */
function folderChildCounts(folder: any): { documents: number; subfolders: number } {
  const documents = folder?.contents?.length || 0;
  const subfolders = (game.folders?.filter((f: any) => f.folder?.id === folder.id) || []).length;
  return { documents, subfolders };
}

/**
 * Delete a folder only if it is empty AND was created by this bridge
 * (mcpGenerated flag). Returns the removed folder's info, or null when kept
 * (not found, non-empty, or user-created). Used by deleteActor cleanup.
 */
async function removeFolderIfEmptyAndMcp(
  folderId: string
): Promise<{ id: string; name: string } | null> {
  const folder = game.folders?.get(folderId);
  if (!folder) return null;

  const { documents, subfolders } = folderChildCounts(folder);
  if (documents > 0 || subfolders > 0) return null;

  const mcpGenerated = folder.flags?.[MCP_FLAG_SCOPE]?.mcpGenerated === true;
  if (!mcpGenerated) return null;

  const info = { id: folder.id ?? folderId, name: folder.name ?? '' };
  await folder.delete();
  return info;
}

// ---------------------------------------------------------------------------
// Exported write API.
// ---------------------------------------------------------------------------

/**
 * Pull the damage TYPES a creature's attacks/abilities deal, from its embedded item SOURCE objects
 * (toSource(item)). create-actor-from-compendium surfaces this so a reskin can't hide the base theme
 * (rule 7): when you copy a creature and re-theme it (a radiant Priest → a necrotic Shar priestess),
 * you must SEE "this base deals radiant" and replace the off-theme abilities with real ones of the new
 * type — not reflavor in prose. PURE — unit-tested in actors.test.ts.
 */
export function extractDamageProfile(sourceItems: any[]): {
  damageTypes: string[];
  attacks: Array<{ name: string; types: string[] }>;
} {
  const all = new Set<string>();
  const attacks: Array<{ name: string; types: string[] }> = [];
  for (const src of sourceItems ?? []) {
    if (src?.type !== 'weapon' && src?.type !== 'feat') continue;
    const sys = src.system ?? {};
    const types = new Set<string>();
    for (const t of sys.damage?.base?.types ?? []) if (t) types.add(t);
    for (const act of Object.values<any>(sys.activities ?? {})) {
      for (const part of act?.damage?.parts ?? []) {
        for (const t of part?.types ?? []) if (t) types.add(t);
      }
    }
    if (types.size > 0) {
      const sorted = [...types].sort();
      attacks.push({ name: src.name ?? '', types: sorted });
      for (const t of sorted) all.add(t);
    }
  }
  return { damageTypes: [...all].sort(), attacks };
}

/**
 * Create one or more world actors by copying a specific compendium entry
 * (resolved by exact packId + itemId). Each copy carries the source's full
 * system data, embedded items, effects, and prototype token (with remote token
 * texture URLs cleared), and is filed under the auto-managed "Foundry MCP
 * Creatures" Actor folder. Optionally places tokens on the current scene.
 * Best-effort: per-actor failures are collected as `errors` rather than aborting.
 * Returns { success, totalCreated, totalRequested, actors, tokensPlaced, errors? }.
 */
export async function createActorFromCompendium(request: {
  packId: string;
  itemId: string;
  customNames: string[];
  quantity?: number;
  addToScene?: boolean;
  placement?: {
    type: 'random' | 'grid' | 'center' | 'coordinates';
    coordinates?: { x: number; y: number }[];
  };
  // Prefab-as-base bridge (design.md §6 step 2): update-actor-shaped stat edits to layer onto each
  // instantiated WORLD COPY (never the source compendium doc). Applied via the same updateActor
  // correctness; same edits applied to every copy.
  modifications?: Record<string, any>;
}): Promise<unknown> {
  const { packId, itemId, customNames, quantity = 1, addToScene = false, placement } = request;
  const modifications = request.modifications;
  const hasMods =
    !!modifications && typeof modifications === 'object' && Object.keys(modifications).length > 0;

  // Resolve + fetch through the shared whole-document copy primitive (validates
  // inputs, resolves the pack, fetches the document). Actor-specific validation
  // runs below on the live `source`; the per-quantity loop re-derives an
  // independent copy via sourceActor.toObject().
  const { pack, source: sourceActor } = await importFromCompendium(packId, itemId);

  // Validate that the document is an Actor.
  if (sourceActor.documentName !== 'Actor') {
    throw new Error(
      `Document "${itemId}" is not an Actor (documentName: ${sourceActor.documentName}, type: ${sourceActor.type})`
    );
  }

  // Validate actor type — support all common actor types including DSA5
  // creatures and Cosmere RPG adversaries.
  const validActorTypes = ['character', 'npc', 'creature', 'adversary'];
  if (!validActorTypes.includes(sourceActor.type)) {
    throw new Error(
      `Document "${itemId}" has unsupported actor type: ${sourceActor.type}. Supported types: ${validActorTypes.join(', ')}`
    );
  }

  // Prepare custom names.
  const names = customNames.length > 0 ? customNames : [`${sourceActor.name} Copy`];
  const finalQuantity = Math.min(quantity, names.length);

  const createdActors: any[] = [];
  const errors: string[] = [];

  // Create actors.
  for (let i = 0; i < finalQuantity; i++) {
    try {
      const customName = names[i] || `${sourceActor.name} ${i + 1}`;

      // Build actor data from the source's full system, items, and effects.
      const sourceData = sourceActor.toObject();
      const actorData = {
        name: customName,
        type: sourceData.type,
        img: sourceData.img,
        system: sourceData.system || sourceData.data || {},
        items: sourceData.items || [],
        effects: sourceData.effects || [],
        folder: null as string | null, // Don't inherit folder.
        prototypeToken: sourceData.prototypeToken, // Include prototype token.
      };

      // Normalize remote prototype-token texture URLs to a local fallback.
      if (actorData.prototypeToken?.texture?.src?.startsWith('http')) {
        actorData.prototypeToken.texture.src = null;
      }

      // The prototype token inherits the SOURCE creature's name (a "Worg" copied as "Gravewidow"
      // keeps "Worg"), so re-point it to the custom name — otherwise every token dragged from the
      // copy, and its combat-tracker entry, reads the source name instead of the rename. Then apply
      // the shared table-ready defaults: name + HP bar shown to everyone, vision on and matching the
      // copied sheet's darkvision, and a disposition (a copied PC pregen is friendly, a copied monster
      // is hostile — the GM flips an allied NPC via update-actor).
      actorData.prototypeToken = actorData.prototypeToken ?? {};
      actorData.prototypeToken.name = customName;
      Object.assign(
        actorData.prototypeToken,
        tokenDefaults({
          disposition:
            sourceData.type === 'character'
              ? TOKEN_DISPOSITION.friendly
              : TOKEN_DISPOSITION.hostile,
          darkvision: readDarkvision(sourceData.system?.attributes?.senses),
        })
      );

      // File created actors under the auto-managed creatures folder.
      const folderId = await getOrCreateFolder('Foundry MCP Creatures', 'Actor');
      if (folderId) {
        actorData.folder = folderId;
      }

      const newActor = await ActorClass.create(actorData);
      if (!newActor) {
        throw new Error(`Failed to create actor "${customName}"`);
      }

      // Report (don't resolve) any @scale.* tokens the copied embedded items carry. A pure MM
      // prefab is clean, but a humanoid built from PC class/racial features dangles them to 0 on an
      // NPC — surface the token + its item so the skill can patch an explicit die (design.md §2.1/§6).
      const unresolvedScale: Array<{
        itemId: string;
        itemName: string;
        path: string;
        formula: string;
      }> = [];
      for (const item of newActor.items ?? []) {
        for (const t of findUnresolvedScaleTokens(toSource(item))) {
          unresolvedScale.push({ itemId: item.id, itemName: item.name, ...t });
        }
      }

      // Prefab-as-base bridge: layer the requested stat edits onto THIS world copy via the same
      // updateActor correctness (resolves game.actors by id, so the source compendium doc is never
      // touched). Best-effort: a mod failure is recorded but doesn't lose the created actor.
      let modifications_applied: string[] | undefined;
      const modifications_warnings: string[] = [];
      if (hasMods) {
        try {
          // Force the target to THIS fresh copy last, so a stray `actorIdentifier` in modifications
          // can never redirect the edit to another actor (updateActor only resolves world actors, so
          // it can't touch the compendium source either — this pins it to the intended copy).
          const res: any = await updateActor({
            ...modifications,
            actorIdentifier: newActor.id,
          });
          modifications_applied = res?.applied;
          if (Array.isArray(res?.warnings)) modifications_warnings.push(...res.warnings);
        } catch (modErr) {
          errors.push(
            `Modifications on "${customName}" failed: ${modErr instanceof Error ? modErr.message : 'Unknown error'}`
          );
        }
      }

      // Rule 7 — surface the base creature's damage themes so a reskin must reconcile (never reflavor).
      const damageProfile = extractDamageProfile(
        (newActor.items ?? []).map((i: any) => toSource(i))
      );

      createdActors.push({
        id: newActor.id,
        name: newActor.name,
        originalName: sourceActor.name,
        sourcePackLabel: pack.metadata.label,
        ...(damageProfile.attacks.length > 0 ? { damageProfile } : {}),
        ...(unresolvedScale.length > 0 ? { unresolvedScale } : {}),
        ...(modifications_applied
          ? { modifications: { applied: modifications_applied, warnings: modifications_warnings } }
          : {}),
      });
    } catch (error) {
      const errorMsg = `Failed to create actor ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      console.error(`[${MODULE_ID}] ${errorMsg}`, error);
    }
  }

  // Add to scene if requested.
  let tokensPlaced = 0;
  if (addToScene && createdActors.length > 0) {
    try {
      const sceneResult = await addActorsToScene({
        actorIds: createdActors.map(a => a.id),
        placement: placement?.type || 'grid',
        hidden: false,
        ...(placement?.coordinates && { coordinates: placement.coordinates }),
      });
      tokensPlaced = sceneResult.success ? sceneResult.tokensCreated : 0;
    } catch (error) {
      errors.push(
        `Failed to add actors to scene: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  return {
    success: createdActors.length > 0,
    totalCreated: createdActors.length,
    totalRequested: finalQuantity,
    actors: createdActors,
    tokensPlaced,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Permanently delete one or more world actors by STRICT identifier (exact id,
 * then exact name — no fuzzy matching). When removeEmptyFolder is not false,
 * any bridge-created folder this deletion leaves completely empty is also
 * removed (only mcpGenerated, empty folders — never a user folder or one with
 * remaining contents). Returns { success, deletedCount, deleted, notFound?,
 * removedFolders? }.
 */
export async function deleteActor(data: {
  identifiers: string[];
  removeEmptyFolder?: boolean;
}): Promise<unknown> {
  // Default ON: if deleting an actor leaves a bridge-created folder empty,
  // remove it (the auto-foldering litter from createActorFromCompendium).
  const removeEmptyFolder = data.removeEmptyFolder !== false;

  try {
    const deleted: Array<{ id: string; name: string }> = [];
    const notFound: string[] = [];
    const touchedFolderIds = new Set<string>();

    for (const identifier of data.identifiers) {
      // STRICT resolution only — exact id, then exact name.
      const actor = game.actors?.get(identifier) || game.actors?.getName?.(identifier);
      if (actor) {
        const info = { id: actor.id ?? identifier, name: actor.name ?? '' };
        const folderId = actor.folder?.id;
        await actor.delete();
        deleted.push(info);
        if (folderId) touchedFolderIds.add(folderId);
      } else {
        notFound.push(identifier);
      }
    }

    // Clean up any bridge-created folder this deletion left completely empty.
    const removedFolders: Array<{ id: string; name: string }> = [];
    if (removeEmptyFolder) {
      for (const folderId of touchedFolderIds) {
        const removed = await removeFolderIfEmptyAndMcp(folderId);
        if (removed) removedFolders.push(removed);
      }
    }

    return {
      success: true,
      deletedCount: deleted.length,
      deleted,
      notFound: notFound.length > 0 ? notFound : undefined,
      removedFolders: removedFolders.length > 0 ? removedFolders : undefined,
    };
  } catch (error) {
    throw new Error(
      `Failed to delete actor(s): ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Add one or more freshly-authored embedded Items to an existing actor (no
 * compendium lookup). name + type are required; type is checked against the
 * active system's declared Item document types when available, then the rest is
 * delegated to Foundry's DataModel layer. Returns { actorId, actorName, created }.
 */
export async function addActorItems(params: {
  actorIdentifier: string;
  items: Array<{
    name: string;
    type: string;
    img?: string;
    system?: Record<string, any>;
  }>;
}): Promise<unknown> {
  const { actorIdentifier, items } = params;

  if (!actorIdentifier) {
    throw new Error('actorIdentifier is required');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items array is required and must contain at least one entry');
  }

  const actor = resolveActor(actorIdentifier);
  if (!actor) {
    throw new Error(`Actor not found: ${actorIdentifier}`);
  }

  // Discover the active system's declared Item types for a useful pre-flight
  // error before the doc reaches Foundry's DataModel layer.
  const itemDocTypes = game.system?.documentTypes?.Item;
  const validTypes: string[] | null =
    itemDocTypes && typeof itemDocTypes === 'object' ? Object.keys(itemDocTypes) : null;

  const payload = items.map((it, idx) => {
    if (!it || typeof it.name !== 'string' || it.name.trim().length === 0) {
      throw new Error(`items[${idx}]: "name" is required and must be a non-empty string`);
    }
    if (typeof it.type !== 'string' || it.type.trim().length === 0) {
      throw new Error(`items[${idx}] ("${it.name}"): "type" is required`);
    }
    if (validTypes && !validTypes.includes(it.type)) {
      throw new Error(
        `items[${idx}] ("${it.name}"): unknown type "${it.type}" for system "${game.system?.id}". ` +
          `Valid Item types: ${validTypes.join(', ')}`
      );
    }

    const doc: Record<string, any> = { name: it.name, type: it.type };
    if (it.img) doc.img = it.img;
    if (it.system && typeof it.system === 'object') doc.system = it.system;
    return doc;
  });

  const created = await actor.createEmbeddedDocuments('Item', payload);

  return {
    actorId: actor.id,
    actorName: actor.name,
    created: (created || []).map((doc: any) => ({
      id: doc.id,
      name: doc.name,
      type: doc.type,
    })),
  };
}

/**
 * Remove embedded Items from an existing actor, identified by id (exact) and/or
 * name (case-insensitive, optionally constrained to a `type`). Identifiers that
 * match nothing are reported in `notFound` rather than silently ignored.
 * Returns { actorId, actorName, removed, notFound }.
 */
export async function removeActorItems(params: {
  actorIdentifier: string;
  itemIds?: string[];
  itemNames?: string[];
  type?: string;
}): Promise<unknown> {
  const { actorIdentifier, itemIds, itemNames, type } = params;

  if (!actorIdentifier) {
    throw new Error('actorIdentifier is required');
  }
  const hasIds = Array.isArray(itemIds) && itemIds.length > 0;
  const hasNames = Array.isArray(itemNames) && itemNames.length > 0;
  if (!hasIds && !hasNames) {
    throw new Error('Provide itemIds and/or itemNames identifying the items to remove');
  }

  const actor = resolveActor(actorIdentifier);
  if (!actor) {
    throw new Error(`Actor not found: ${actorIdentifier}`);
  }

  const typeLower = type?.toLowerCase();
  const toDelete = new Map<string, any>(); // id -> item (dedupes overlap)
  const notFound: string[] = [];

  if (hasIds) {
    for (const id of itemIds) {
      const item = actor.items.get(id);
      if (item) toDelete.set(item.id, item);
      else notFound.push(id);
    }
  }
  if (hasNames) {
    for (const name of itemNames) {
      const nameLower = name.toLowerCase();
      const item = actor.items.find(
        (i: any) => i.name?.toLowerCase() === nameLower && (!typeLower || i.type === typeLower)
      );
      if (item) toDelete.set(item.id, item);
      else notFound.push(name);
    }
  }

  if (toDelete.size === 0) {
    return { actorId: actor.id, actorName: actor.name, removed: [], notFound };
  }

  const removed = Array.from(toDelete.values()).map((i: any) => ({
    id: i.id,
    name: i.name,
    type: i.type,
  }));

  await actor.deleteEmbeddedDocuments(
    'Item',
    removed.map(r => r.id)
  );

  return { actorId: actor.id, actorName: actor.name, removed, notFound };
}

/**
 * Edit an existing actor's own system data (the stat-block fields — NOT its embedded items, which
 * are handled by updateActorItem / add-feature). Resolves the actor fuzzily, then builds ONE
 * `actor.update()` patch from whichever field groups the caller supplied:
 *
 *  - identity:   name, img
 *  - details:    size, cr*, creatureType*, creatureSubtype*, swarmSize*, alignment, biography, source
 *  - abilities:  abilities.<ab>, savingThrows (replace), skills (merge)
 *  - vitals:     hp, ac, initiative
 *  - movement / senses (senses uses the modern `senses.ranges.*` path)
 *  - defenses:   damageImmunities / damageResistances / damageVulnerabilities / conditionImmunities
 *                (Set fields with mode replace|add|remove via read-modify-write), languages, telepathy
 *  - resources*: legendaryActions, legendaryResistances, lair
 *  - 2024*:      habitat, treasure
 *
 * Fields marked * are NPC-only; on a non-NPC actor they are skipped with a warning (we don't grow PC
 * class-progression logic here). Movement values are FormulaField strings, so numbers are coerced.
 * Set fields are replace-whole in dnd5e, so add/remove are done by reading the live Set first.
 * Unknown enum-ish values (damage/condition/creatureType/AC-calc/size/skill) warn but never block.
 * Returns { success, actor:{id,name,type}, applied:[...field names], warnings }.
 */
export async function updateActor(params: any): Promise<unknown> {
  const identifier = params?.actorIdentifier;
  if (!identifier) throw new Error('actorIdentifier is required');
  const actor = resolveActor(identifier);
  if (!actor) throw new Error(`Actor not found: ${identifier}`);

  const isNpc = actor.type === 'npc';
  const update: Record<string, any> = {};
  const warnings: string[] = [];
  const applied: string[] = [];

  const warnUnknown = (label: string, value: string, set: Set<string>) => {
    if (!set.has(value)) {
      warnings.push(`Unknown ${label} "${value}" — verify it matches dnd5e system values`);
    }
  };
  // NPC-only gate: returns true (apply) only for npc actors; otherwise warns + skips.
  const npcOnly = (field: string): boolean => {
    if (!isNpc) {
      warnings.push(`"${field}" is an NPC-only field — skipped on ${actor.type} "${actor.name}"`);
      return false;
    }
    return true;
  };

  // --- identity ---
  if (typeof params.name === 'string' && params.name.trim()) {
    update.name = params.name.trim();
    // Keep the prototype token's name in lockstep with the actor — a renamed actor should read the
    // same on any token dragged from it (and in the combat tracker), not the pre-rename name.
    update['prototypeToken.name'] = params.name.trim();
    applied.push('name');
  }
  if (typeof params.img === 'string' && params.img.trim()) {
    // Rule 8 — never write a broken (404) portrait. A supplied path is honored only if it resolves on
    // the static server; otherwise warn and substitute a real creatureType-keyed floor icon.
    let img = params.img.trim();
    if (!(await imgResolves(img))) {
      warnings.push(badAssetWarning('img', img, true));
      const ct =
        actor.type === 'npc' ? actor.system?.details?.type?.value || 'humanoid' : 'humanoid';
      img = resolveCreatureIcon(ct);
    }
    update.img = img;
    applied.push('img');
  }
  if (params.disposition !== undefined && params.disposition !== null) {
    // Flip friend/foe on the prototype token — e.g. mark a captured or turned NPC friendly. Combat and
    // targeting read disposition, so this is a real state change, not cosmetic.
    update['prototypeToken.disposition'] = resolveDisposition(
      params.disposition,
      TOKEN_DISPOSITION.hostile
    );
    applied.push('disposition');
  }

  // --- details ---
  if (params.size !== undefined) {
    const sz = normalizeSize(String(params.size));
    if (sz) {
      update['system.traits.size'] = sz;
      applied.push('size');
    } else {
      warnings.push(`Unknown size "${params.size}" — left unchanged`);
    }
  }
  if (params.cr !== undefined && npcOnly('cr')) {
    update['system.details.cr'] = normalizeCR(params.cr);
    applied.push('cr');
  }
  if (params.creatureType !== undefined && npcOnly('creatureType')) {
    warnUnknown('creature type', String(params.creatureType), CREATURE_TYPES);
    update['system.details.type.value'] = params.creatureType;
    applied.push('creatureType');
  }
  if (params.creatureSubtype !== undefined && npcOnly('creatureSubtype')) {
    update['system.details.type.subtype'] = params.creatureSubtype;
    applied.push('creatureSubtype');
  }
  if (params.swarmSize !== undefined && npcOnly('swarmSize')) {
    if (params.swarmSize === '') {
      update['system.details.type.swarm'] = '';
      applied.push('swarmSize');
    } else {
      const sz = normalizeSize(String(params.swarmSize));
      if (sz) {
        update['system.details.type.swarm'] = sz;
        applied.push('swarmSize');
      } else {
        warnings.push(`Unknown swarm size "${params.swarmSize}" — left unchanged`);
      }
    }
  }
  if (typeof params.alignment === 'string') {
    update['system.details.alignment'] = params.alignment;
    applied.push('alignment');
  }
  if (typeof params.biography === 'string') {
    update['system.details.biography.value'] = params.biography;
    applied.push('biography');
  }
  if (params.source && typeof params.source === 'object') {
    let touched = false;
    for (const k of ['book', 'page', 'rules'] as const) {
      if (typeof params.source[k] === 'string') {
        update[`system.details.source.${k}`] = params.source[k];
        touched = true;
      }
    }
    if (touched) applied.push('source');
  }

  // --- abilities / saves / skills ---
  if (params.abilities && typeof params.abilities === 'object') {
    let touched = false;
    for (const ab of ABILITIES) {
      if (typeof params.abilities[ab] === 'number') {
        update[`system.abilities.${ab}.value`] = params.abilities[ab];
        touched = true;
      }
    }
    if (touched) applied.push('abilities');
  }
  if (Array.isArray(params.savingThrows)) {
    const set = new Set(params.savingThrows.map(String));
    for (const ab of ABILITIES) {
      update[`system.abilities.${ab}.proficient`] = set.has(ab) ? 1 : 0;
    }
    applied.push('savingThrows');
  }
  if (Array.isArray(params.skills)) {
    let touched = false;
    for (const s of params.skills) {
      const key = normalizeSkill(String(s?.skill ?? ''));
      if (!key) {
        warnings.push(`Unknown skill "${s?.skill}" — skipped`);
        continue;
      }
      update[`system.skills.${key}.value`] =
        s.proficiency === 'expert' ? 2 : s.proficiency === 'proficient' ? 1 : 0;
      // Also pin the governing ability: an authored NPC's skill may have been created
      // without it (older builds), which silently drops the ability mod from the total.
      update[`system.skills.${key}.ability`] = SKILL_ABILITY[key];
      touched = true;
    }
    if (touched) applied.push('skills');
  }

  // --- vitals ---
  if (params.hp && typeof params.hp === 'object') {
    for (const k of ['value', 'max', 'temp', 'tempmax'] as const) {
      if (typeof params.hp[k] === 'number') update[`system.attributes.hp.${k}`] = params.hp[k];
    }
    if (typeof params.hp.formula === 'string')
      update['system.attributes.hp.formula'] = params.hp.formula;
    applied.push('hp');
  }
  if (params.ac && typeof params.ac === 'object') {
    if (typeof params.ac.calc === 'string') {
      warnUnknown('AC calculation', params.ac.calc, ARMOR_CALC);
      update['system.attributes.ac.calc'] = params.ac.calc;
    }
    if (typeof params.ac.flat === 'number') update['system.attributes.ac.flat'] = params.ac.flat;
    if (typeof params.ac.formula === 'string')
      update['system.attributes.ac.formula'] = params.ac.formula;
    applied.push('ac');
  }
  if (params.initiative && typeof params.initiative === 'object') {
    if (typeof params.initiative.bonus === 'number') {
      update['system.attributes.init.bonus'] = String(params.initiative.bonus);
    }
    if (typeof params.initiative.ability === 'string') {
      update['system.attributes.init.ability'] = params.initiative.ability;
    }
    applied.push('initiative');
  }

  // --- movement (FormulaField strings) / senses (ranges.* ints) ---
  if (params.movement && typeof params.movement === 'object') {
    for (const k of ['walk', 'fly', 'swim', 'climb', 'burrow'] as const) {
      const v = params.movement[k];
      if (v !== undefined && v !== null) update[`system.attributes.movement.${k}`] = String(v);
    }
    if (typeof params.movement.units === 'string') {
      update['system.attributes.movement.units'] = params.movement.units;
    }
    if (typeof params.movement.hover === 'boolean') {
      update['system.attributes.movement.hover'] = params.movement.hover;
    }
    applied.push('movement');
  }
  if (params.senses && typeof params.senses === 'object') {
    for (const k of ['darkvision', 'blindsight', 'tremorsense', 'truesight'] as const) {
      if (typeof params.senses[k] === 'number') {
        update[`system.attributes.senses.ranges.${k}`] = params.senses[k];
      }
    }
    if (typeof params.senses.units === 'string') {
      update['system.attributes.senses.units'] = params.senses.units;
    }
    if (typeof params.senses.special === 'string') {
      update['system.attributes.senses.special'] = params.senses.special;
    }
    applied.push('senses');
  }

  // --- defenses (Set fields: replace-whole, so add/remove read the live Set first) ---
  const applySet = (
    path: string,
    current: any,
    field: any,
    validSet: Set<string> | null,
    label: string,
    name: string
  ) => {
    const values: string[] = Array.isArray(field.values) ? field.values.map(String) : [];
    if (validSet) for (const v of values) warnUnknown(label, v, validSet);
    const mode = field.mode ?? 'replace';
    if (mode === 'replace') {
      update[`${path}.value`] = values;
    } else {
      const cur = Array.from((current ?? []) as Iterable<string>).map(String);
      update[`${path}.value`] =
        mode === 'add'
          ? Array.from(new Set([...cur, ...values]))
          : cur.filter(x => !values.includes(x));
    }
    if (typeof field.custom === 'string') update[`${path}.custom`] = field.custom;
    applied.push(name);
  };

  const traits = actor.system?.traits ?? {};
  if (params.damageImmunities) {
    applySet(
      'system.traits.di',
      traits.di?.value,
      params.damageImmunities,
      DAMAGE_TYPES,
      'damage type',
      'damageImmunities'
    );
  }
  if (params.damageResistances) {
    applySet(
      'system.traits.dr',
      traits.dr?.value,
      params.damageResistances,
      DAMAGE_TYPES,
      'damage type',
      'damageResistances'
    );
  }
  if (params.damageVulnerabilities) {
    applySet(
      'system.traits.dv',
      traits.dv?.value,
      params.damageVulnerabilities,
      DAMAGE_TYPES,
      'damage type',
      'damageVulnerabilities'
    );
  }
  if (params.conditionImmunities) {
    applySet(
      'system.traits.ci',
      traits.ci?.value,
      params.conditionImmunities,
      CONDITION_TYPES,
      'condition',
      'conditionImmunities'
    );
  }
  if (params.languages) {
    applySet(
      'system.traits.languages',
      traits.languages?.value,
      params.languages,
      null,
      'language',
      'languages'
    );
  }
  if (
    params.telepathy &&
    typeof params.telepathy === 'object' &&
    typeof params.telepathy.value === 'number'
  ) {
    update['system.traits.languages.communication.telepathy'] = {
      value: params.telepathy.value,
      units: params.telepathy.units ?? 'ft',
    };
    applied.push('telepathy');
  }

  // --- resources (NPC) ---
  if (typeof params.legendaryActions === 'number' && npcOnly('legendaryActions')) {
    update['system.resources.legact.max'] = params.legendaryActions;
    applied.push('legendaryActions');
  }
  if (typeof params.legendaryResistances === 'number' && npcOnly('legendaryResistances')) {
    update['system.resources.legres.max'] = params.legendaryResistances;
    applied.push('legendaryResistances');
  }
  if (params.lair && typeof params.lair === 'object' && npcOnly('lair')) {
    // Providing a lair object marks the creature as having lair actions; initiative is optional.
    update['system.resources.lair.value'] = true;
    if (typeof params.lair.initiative === 'number') {
      update['system.resources.lair.initiative'] = params.lair.initiative;
    }
    applied.push('lair');
  }

  // --- 2024 fields (NPC) ---
  if (Array.isArray(params.habitat) && npcOnly('habitat')) {
    update['system.details.habitat.value'] = params.habitat.map((h: any) =>
      h?.subtype ? { type: h.type, subtype: h.subtype } : { type: h.type }
    );
    applied.push('habitat');
  }
  if (params.treasure && npcOnly('treasure')) {
    applySet(
      'system.details.treasure',
      actor.system?.details?.treasure?.value,
      params.treasure,
      null,
      'treasure',
      'treasure'
    );
  }

  // --- currency (coins; actor-level, applies to NPCs and PCs alike) ---
  if (params.currency && typeof params.currency === 'object') {
    const mode = params.currency.mode === 'add' ? 'add' : 'set';
    const live = actor.system?.currency ?? {};
    let touched = false;
    for (const coin of ['pp', 'gp', 'ep', 'sp', 'cp'] as const) {
      const v = params.currency[coin];
      if (typeof v === 'number' && Number.isFinite(v)) {
        // 'add' adjusts the live pile (negatives spend, clamped at 0); 'set' overwrites.
        const base = mode === 'add' ? Number(live[coin] ?? 0) : 0;
        update[`system.currency.${coin}`] = Math.max(0, Math.round(base + v));
        touched = true;
      }
    }
    if (touched) applied.push('currency');
  }

  if (Object.keys(update).length === 0) {
    const extra = warnings.length ? ` (${warnings.join('; ')})` : '';
    throw new Error(`No applicable fields to update.${extra}`);
  }

  await actor.update(update);

  return {
    success: true,
    actor: { id: actor.id, name: actor.name, type: actor.type },
    applied,
    warnings,
  };
}

/**
 * Edit an embedded Item on an actor by applying a dot-path `patch` (and/or `deletePaths`, and/or a
 * name/img change) via actor.updateEmbeddedDocuments('Item', ...). This is the generic embedded-doc
 * editor: `patch` keys are Foundry dot-paths (e.g. "system.damage.base.number",
 * "system.activities.<id>.attack.bonus") applied as-is — arrays REPLACE whole (dnd5e Sets/arrays are
 * replace-whole). `deletePaths` remove keys via the `-=` form (e.g. to drop an activity by id).
 * Resolves the actor fuzzily and the item by id/name. Returns the item identity + the applied keys.
 */
export async function updateActorItem(params: {
  actorIdentifier: string;
  itemIdentifier: string;
  type?: string;
  name?: string;
  img?: string;
  patch?: Record<string, any>;
  deletePaths?: string[];
}): Promise<unknown> {
  const { actorIdentifier, itemIdentifier } = params ?? ({} as any);
  if (!actorIdentifier) throw new Error('actorIdentifier is required');
  if (!itemIdentifier) throw new Error('itemIdentifier is required');

  const actor = resolveActor(actorIdentifier);
  if (!actor) throw new Error(`Actor not found: ${actorIdentifier}`);
  const item = resolveActorItem(actor, itemIdentifier, params.type);
  if (!item) {
    throw new Error(`Item "${itemIdentifier}" not found on actor "${actor.name}"`);
  }

  const warnings: string[] = [];
  const update: Record<string, any> = { _id: item.id };
  if (typeof params.name === 'string' && params.name.trim()) update.name = params.name.trim();
  if (typeof params.img === 'string' && params.img.trim()) {
    // Rule 8 — never write a broken (404) item icon. Honor a supplied path only if it resolves on the
    // static server; otherwise warn and substitute the neutral real floor icon.
    let img = params.img.trim();
    if (!(await imgResolves(img))) {
      warnings.push(badAssetWarning('img', img, true));
      img = GENERIC_ICON;
    }
    update.img = img;
  }
  if (params.patch && typeof params.patch === 'object') {
    for (const [k, v] of Object.entries(params.patch)) update[k] = v;
  }
  if (Array.isArray(params.deletePaths)) {
    for (const p of params.deletePaths) {
      if (typeof p === 'string' && p.length > 0) update[toDeletionKey(p)] = null;
    }
  }

  const appliedKeys = Object.keys(update).filter(k => k !== '_id');
  if (appliedKeys.length === 0) {
    throw new Error('Provide name, img, patch, or deletePaths to change.');
  }

  await actor.updateEmbeddedDocuments('Item', [update]);

  const updated = actor.items?.get?.(item.id) ?? item;
  return {
    success: true,
    actor: { id: actor.id, name: actor.name },
    item: { id: updated.id, name: updated.name, type: updated.type },
    appliedKeys,
    ...(warnings.length ? { warnings } : {}),
  };
}
