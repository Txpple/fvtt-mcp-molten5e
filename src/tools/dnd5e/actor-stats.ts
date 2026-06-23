/**
 * D&D 5e actor extraction (Node-side).
 *
 * Pure functions that shape the `basicInfo` and `stats` blocks of the get-actor
 * response from a raw Foundry actor document (the result of foundry.call('getCharacterInfo')).
 * This is the single source of truth for get-actor's dnd5e view — it replaced the
 * former SystemAdapter/registry indirection, which carried a multi-system plugin
 * framework with exactly one adapter.
 *
 * Saving throws: in dnd5e 5.x `system.abilities.<ab>.save` is an object whose derived
 * `.value` is the total save bonus (the legacy numeric `save` getter is deprecated and the
 * page sanitizer strips the `save` key). The total is therefore read page-side
 * (getCharacterInfo -> extractSaves) and arrives here as `actorData.saves`; this module
 * just passes it through under `stats.saves`.
 */

/**
 * Common, always-present fields for the response's top-level `basicInfo` block:
 * HP, AC, level, class, race.
 */
export function extractActorBasicInfo(actorData: any): any {
  const basicInfo: any = {};
  const system = actorData.system || {};

  if (system.attributes?.hp) {
    basicInfo.hitPoints = {
      current: system.attributes.hp.value,
      max: system.attributes.hp.max,
      temp: system.attributes.hp.temp || 0,
    };
  }
  if (system.attributes?.ac) {
    basicInfo.armorClass = system.attributes.ac.value;
  }

  if (system.details?.level?.value) {
    basicInfo.level = system.details.level.value;
  } else if (typeof system.level === 'number') {
    basicInfo.level = system.level;
  }

  if (system.details?.class) {
    basicInfo.class = system.details.class;
  }

  // dnd5e 4.x+ stores race as an embedded item document; collapse to its identifying
  // name to avoid dumping the full item (HTML description, advancement, circular refs).
  // Older data may store a plain string, which we pass through.
  if (system.details?.race) {
    const race = system.details.race;
    basicInfo.race =
      typeof race === 'string' ? race : race.name || race.identifier || race._id || 'Unknown';
  } else if (system.details?.ancestry) {
    const ancestry = system.details.ancestry;
    basicInfo.ancestry =
      typeof ancestry === 'string'
        ? ancestry
        : ancestry.name || ancestry.identifier || ancestry._id || 'Unknown';
  }

  return basicInfo;
}

/**
 * The detailed dnd5e `stats` block: name/type, CR or level, HP, AC, abilities,
 * skills, plus NPC-only creature type/size/alignment/legendary actions, and a
 * spellcasting summary.
 */
export function extractActorStats(actorData: any): any {
  const system = actorData.system || {};
  const stats: any = {};

  // Basic info
  stats.name = actorData.name;
  stats.type = actorData.type;

  // Challenge Rating or Level
  const cr = system.details?.cr ?? system.details?.cr?.value ?? system.cr;
  if (cr !== undefined && cr !== null) {
    stats.challengeRating = Number(cr);
  }

  const level = system.details?.level?.value ?? system.details?.level ?? system.level;
  if (level !== undefined && level !== null) {
    stats.level = Number(level);
  }

  // Hit Points
  const hp = system.attributes?.hp;
  if (hp) {
    stats.hitPoints = {
      current: hp.value ?? 0,
      max: hp.max ?? 0,
      temp: hp.temp ?? 0,
    };
  }

  // Armor Class
  const ac = system.attributes?.ac?.value ?? system.attributes?.ac;
  if (ac !== undefined) {
    stats.armorClass = ac;
  }

  // Abilities (STR, DEX, CON, INT, WIS, CHA)
  if (system.abilities) {
    stats.abilities = {};
    for (const [key, ability] of Object.entries(system.abilities)) {
      const abilityData = ability as any;
      stats.abilities[key] = {
        value: abilityData.value ?? 10,
        modifier: abilityData.mod ?? 0,
      };
    }
  }

  // Skills
  if (system.skills) {
    stats.skills = {};
    for (const [key, skill] of Object.entries(system.skills)) {
      const skillData = skill as any;
      stats.skills[key] = {
        value: skillData.value ?? 0,
        modifier: skillData.total ?? skillData.mod ?? 0,
        proficient: skillData.proficient ?? 0,
      };
    }
  }

  // Saving throws (dnd5e 5.x): derived total bonus + proficiency, computed page-side from
  // abilities.<ab>.save.value (the deprecated numeric save getter is avoided). Pass through.
  if (actorData.saves && typeof actorData.saves === 'object') {
    stats.saves = actorData.saves;
  }

  // Creature-specific info (NPCs)
  if (actorData.type === 'npc') {
    const creatureType = system.details?.type?.value ?? system.details?.type;
    if (creatureType) {
      stats.creatureType = creatureType;
    }

    const size = system.traits?.size?.value ?? system.traits?.size ?? system.size;
    if (size) {
      stats.size = size;
    }

    const alignment = system.details?.alignment?.value ?? system.details?.alignment;
    if (alignment) {
      stats.alignment = alignment;
    }

    const legact = system.resources?.legact;
    if (legact) {
      stats.legendaryActions = {
        available: legact.value ?? 0,
        max: legact.max ?? 0,
      };
    }
  }

  // Spellcasting
  const hasSpells = !!(
    system.spells ||
    system.attributes?.spellcasting ||
    (system.details?.spellLevel && system.details.spellLevel > 0)
  );
  if (hasSpells) {
    stats.spellcasting = {
      hasSpells: true,
      spellLevel: system.details?.spellLevel ?? 0,
    };
  }

  return stats;
}
