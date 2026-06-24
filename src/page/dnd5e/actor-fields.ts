// Shared dnd5e 5.3.3 actor-field mappers + canonical value sets. Pure (no Foundry globals), so it
// unit-tests offline in Node. Extracted from npc.ts so NPC creation (createNpcActor) and actor
// editing (updateActor) validate/normalize the same way and can't drift. All sets are the live
// CONFIG.DND5E values (live-verified on the box); they back SOFT validation only (warn, never block).

import { DAMAGE_TYPES } from '../_shared.js';

export { DAMAGE_TYPES };

/** dnd5e size codes. Accepts the long names (medium) and the stored short codes (med). */
const SIZE_MAP: Record<string, string> = {
  tiny: 'tiny',
  sm: 'sm',
  small: 'sm',
  med: 'med',
  medium: 'med',
  lg: 'lg',
  large: 'lg',
  huge: 'huge',
  grg: 'grg',
  gargantuan: 'grg',
};

/** Normalize a size to its stored short code (med/sm/...). Returns undefined for an unknown size. */
export function normalizeSize(input: string): string | undefined {
  return SIZE_MAP[input?.trim().toLowerCase()];
}

/** Full skill name → dnd5e skill key. */
const SKILL_NAME_TO_KEY: Record<string, string> = {
  acrobatics: 'acr',
  'animal handling': 'ani',
  arcana: 'arc',
  athletics: 'ath',
  deception: 'dec',
  history: 'his',
  insight: 'ins',
  intimidation: 'itm',
  investigation: 'inv',
  medicine: 'med',
  nature: 'nat',
  perception: 'prc',
  performance: 'prf',
  persuasion: 'per',
  religion: 'rel',
  'sleight of hand': 'slt',
  stealth: 'ste',
  survival: 'sur',
};

/** The 18 dnd5e skill keys. */
export const SKILL_KEYS = new Set(Object.values(SKILL_NAME_TO_KEY));

/** Normalize a skill (full name OR key) to its dnd5e key. Returns undefined for an unknown skill. */
export function normalizeSkill(input: string): string | undefined {
  const s = input?.trim().toLowerCase();
  if (!s) return undefined;
  if (SKILL_KEYS.has(s)) return s;
  return SKILL_NAME_TO_KEY[s];
}

/** Parse a CR string ("1/4", "5") or number to a float. */
export function normalizeCR(input: string | number): number {
  if (typeof input === 'number') return input;
  if (input.includes('/')) {
    const [num, den] = input.split('/').map(Number);
    return num / den;
  }
  return parseInt(input, 10);
}

/** Format a CR float back to its canonical label (1/8, 1/4, 1/2, else rounded integer). */
export function formatCR(value: number): string {
  if (value === 0) return '0';
  if (value === 0.125) return '1/8';
  if (value === 0.25) return '1/4';
  if (value === 0.5) return '1/2';
  return String(Math.round(value));
}

/** dnd5e 5.3.3 ability keys. */
export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

/** CONFIG.DND5E.creatureTypes (14). */
export const CREATURE_TYPES = new Set([
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
]);

/** CONFIG.DND5E.conditionTypes (26). */
export const CONDITION_TYPES = new Set([
  'bleeding',
  'blinded',
  'burning',
  'charmed',
  'cursed',
  'deafened',
  'dehydration',
  'diseased',
  'exhaustion',
  'falling',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'malnutrition',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'silenced',
  'stunned',
  'suffocation',
  'surprised',
  'transformed',
  'unconscious',
]);

/** CONFIG.DND5E.armorClasses calculation keys (the `attributes.ac.calc` values). */
export const ARMOR_CALC = new Set([
  'flat',
  'natural',
  'default',
  'mage',
  'draconic',
  'unarmoredMonk',
  'unarmoredBarb',
  'unarmoredBard',
  'custom',
]);
