/**
 * Game System Detection Utilities
 *
 * This project targets D&D 5e exclusively. These helpers confirm the active
 * Foundry world is dnd5e and provide D&D 5e data-path mappings; any other
 * system resolves to 'other' (unsupported).
 */

import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';

/**
 * Supported game systems (D&D 5e only; 'other' = unsupported fallback)
 */
export type GameSystem = 'dnd5e' | 'other';

/**
 * Cache for system detection (avoid repeated queries)
 */
let cachedSystem: GameSystem | null = null;
let cachedSystemId: string | null = null;

/**
 * Detect the active Foundry game system
 * Results are cached to avoid repeated queries
 */
export async function detectGameSystem(
  foundry: FoundryBridge,
  logger?: Logger
): Promise<GameSystem> {
  if (cachedSystem) {
    return cachedSystem;
  }

  try {
    const worldInfo = await foundry.call('getWorldInfo');
    const systemId = (worldInfo.system ?? '').toLowerCase();

    cachedSystemId = systemId;

    cachedSystem = systemId === 'dnd5e' ? 'dnd5e' : 'other';

    if (logger) {
      logger.info('Game system detected', { systemId, detectedAs: cachedSystem });
    }

    return cachedSystem;
  } catch (error) {
    if (logger) {
      logger.error('Failed to detect game system, defaulting to other', { error });
    }
    cachedSystem = 'other';
    return cachedSystem;
  }
}

/**
 * Assert the active Foundry world is D&D 5e, or throw a tool-labelled error.
 * Centralises the up-front guard every dnd5e authoring tool runs.
 */
export async function assertDnd5e(
  foundry: FoundryBridge,
  logger: Logger,
  toolLabel: string
): Promise<void> {
  const system = await detectGameSystem(foundry, logger);
  if (system !== 'dnd5e') {
    throw new Error(
      `${toolLabel} requires D&D 5e. Detected system: "${getCachedSystemId() ?? 'unknown'}".`
    );
  }
}

/**
 * Get the raw system ID string (e.g., "dnd5e")
 */
export function getCachedSystemId(): string | null {
  return cachedSystemId;
}

/**
 * Clear cached system detection (useful for testing or world switches)
 */
export function clearSystemCache(): void {
  cachedSystem = null;
  cachedSystemId = null;
}

/**
 * System-specific data paths for creature/actor stats (D&D 5e)
 */
export const SystemPaths = {
  dnd5e: {
    // D&D 5e specific paths
    challengeRating: 'system.details.cr',
    creatureType: 'system.details.type.value',
    size: 'system.traits.size',
    alignment: 'system.details.alignment',
    level: 'system.details.level.value', // For NPCs/characters
    hitPoints: 'system.attributes.hp',
    armorClass: 'system.attributes.ac.value',
    abilities: 'system.abilities',
    skills: 'system.skills',
    spells: 'system.spells',
    legendaryActions: 'system.resources.legact',
    legendaryResistances: 'system.resources.legres',
  },
} as const;

/**
 * Get system-specific data paths based on detected system.
 *
 * Returns null for unsupported systems ('other'). Callers must branch on
 * `system` for those — falling back to dnd5e paths silently produces wrong
 * values when called against a non-dnd5e actor.
 */
export function getSystemPaths(system: GameSystem) {
  if (system === 'dnd5e') {
    return SystemPaths.dnd5e;
  }
  return null;
}

/**
 * Extract a value from system data using a path string
 * Handles both simple and nested paths (e.g., "system.details.cr")
 */
export function extractSystemValue(data: any, path: string | null): any {
  if (!path || !data) {
    return undefined;
  }

  const parts = path.split('.');
  let value = data;

  for (const part of parts) {
    if (value === undefined || value === null) {
      return undefined;
    }
    value = value[part];
  }

  return value;
}

/**
 * Get creature level/CR based on system (D&D 5e)
 */
export function getCreatureLevel(actorData: any, system: GameSystem): number | undefined {
  if (system === 'dnd5e') {
    // D&D 5e: Try CR first, then level
    const cr = extractSystemValue(actorData, SystemPaths.dnd5e.challengeRating);
    if (cr !== undefined) return Number(cr);

    const level = extractSystemValue(actorData, SystemPaths.dnd5e.level);
    if (level !== undefined) return Number(level);
  }

  return undefined;
}

/**
 * Get creature type based on system (D&D 5e: single creature-type string)
 */
export function getCreatureType(actorData: any, system: GameSystem): string | string[] | undefined {
  if (system === 'dnd5e') {
    return extractSystemValue(actorData, SystemPaths.dnd5e.creatureType);
  }

  return undefined;
}

/**
 * Check if creature has spellcasting based on system (D&D 5e)
 */
export function hasSpellcasting(actorData: any, system: GameSystem): boolean {
  if (system === 'dnd5e') {
    // D&D 5e: Check for spells object or spellcasting level
    const spells = extractSystemValue(actorData, SystemPaths.dnd5e.spells);
    const spellLevel = extractSystemValue(actorData, 'system.details.spellLevel');
    return !!(spells || spellLevel);
  }

  return false;
}

/**
 * Format system-specific error messages
 */
export function formatSystemError(system: GameSystem, systemId: string | null): string {
  if (system === 'other') {
    return `This tool supports D&D 5e only. Your world uses system: "${systemId || 'unknown'}".`;
  }
  return 'Unknown system error';
}
