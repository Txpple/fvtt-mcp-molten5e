/**
 * Compendium Search Filter Schemas (D&D 5e)
 *
 * Defines the D&D 5e creature/actor search filter schema. This project is
 * D&D 5e only.
 */

import { z } from 'zod';
import type { GameSystem } from './system-detection.js';

/**
 * D&D 5e creature types
 */
export const DnD5eCreatureTypes = [
  'aberration',
  'beast',
  'celestial',
  'construct',
  'dragon',
  'elemental',
  'fey',
  'fiend',
  'giant',
  'humanoid',
  'monstrosity',
  'ooze',
  'plant',
  'undead',
] as const;

export type DnD5eCreatureType = (typeof DnD5eCreatureTypes)[number];

/**
 * Common creature sizes
 */
export const CreatureSizes = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'] as const;
export type CreatureSize = (typeof CreatureSizes)[number];

/**
 * D&D 5e filter schema
 */
export const DnD5eFiltersSchema = z.object({
  challengeRating: z
    .union([
      z.number(),
      z.object({
        min: z.number().optional(),
        max: z.number().optional(),
      }),
    ])
    .optional(),
  creatureType: z.enum(DnD5eCreatureTypes).optional(),
  size: z.enum(CreatureSizes).optional(),
  alignment: z.string().optional(),
  hasLegendaryActions: z.boolean().optional(),
  spellcaster: z.boolean().optional(),
});

export type DnD5eFilters = z.infer<typeof DnD5eFiltersSchema>;

/**
 * Generic filter schema (D&D 5e). Kept as the public filter shape used by the
 * compendium search tools; accepts any string creatureType and validates per
 * system downstream.
 */
export const GenericFiltersSchema = z.object({
  challengeRating: z
    .union([
      z.number().describe('Exact CR value (e.g., 12)'),
      z.object({
        min: z.number().optional().describe('Minimum CR'),
        max: z.number().optional().describe('Maximum CR'),
      }),
    ])
    .optional(),

  // Accept any string, validate per system.
  creatureType: z
    .string()
    .optional()
    .describe(
      'Creature type (e.g., "humanoid", "dragon", "beast", "undead", "fey", "fiend", "celestial", "construct", "elemental", "giant", "monstrosity", "ooze", "plant")'
    ),
  size: z
    .enum(CreatureSizes)
    .optional()
    .describe('Creature size (e.g., "medium", "large", "huge")'),
  alignment: z
    .string()
    .optional()
    .describe('Creature alignment (e.g., "lawful good", "chaotic evil", "neutral")'),

  hasLegendaryActions: z
    .boolean()
    .optional()
    .describe('Filter for creatures with legendary actions'),
  spellcaster: z
    .boolean()
    .optional()
    .describe('Filter for creatures that can cast spells (D&D 5e)'),
});

export type GenericFilters = z.infer<typeof GenericFiltersSchema>;

/**
 * Get appropriate filter schema for a game system
 */
export function getFilterSchema(system: GameSystem) {
  if (system === 'dnd5e') {
    return DnD5eFiltersSchema;
  }
  // For unsupported systems, use generic schema (best effort)
  return GenericFiltersSchema;
}

/**
 * Validate creature type for a given system
 */
export function isValidCreatureType(creatureType: string, system: GameSystem): boolean {
  if (system === 'dnd5e') {
    return DnD5eCreatureTypes.includes(creatureType as DnD5eCreatureType);
  }
  return false;
}

/**
 * Build human-readable filter description for tool responses
 */
export function describeFilters(filters: GenericFilters, system: GameSystem): string {
  const parts: string[] = [];

  if (system === 'dnd5e') {
    if (filters.challengeRating !== undefined) {
      if (typeof filters.challengeRating === 'number') {
        parts.push(`CR ${filters.challengeRating}`);
      } else {
        const min = filters.challengeRating.min ?? 0;
        const max = filters.challengeRating.max ?? 30;
        parts.push(`CR ${min}-${max}`);
      }
    }

    if (filters.creatureType) parts.push(filters.creatureType);
    if (filters.size) parts.push(filters.size);
    if (filters.alignment) parts.push(filters.alignment);
    if (filters.hasLegendaryActions) parts.push('legendary');
    if (filters.spellcaster) parts.push('spellcaster');
  }

  return parts.length > 0 ? parts.join(', ') : 'no filters';
}
