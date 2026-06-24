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
  // AC.value is DERIVED (absent from the toObject() source), so prefer the derived block.
  const acValue = actorData.derived?.ac?.value ?? system.attributes?.ac?.value;
  if (acValue !== undefined) {
    basicInfo.armorClass = acValue;
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

  // Armor Class — value is DERIVED (absent from the toObject() source); prefer the derived block.
  const ac = actorData.derived?.ac?.value ?? system.attributes?.ac?.value;
  if (ac !== undefined) {
    stats.armorClass = ac;
  }

  // Initiative — derived total (only present on the live actor).
  if (typeof actorData.derived?.init?.total === 'number') {
    stats.initiative = actorData.derived.init.total;
  }

  // Abilities (STR, DEX, CON, INT, WIS, CHA). The modifier is DERIVED (`abilities.<ab>.mod`),
  // missing from the source blob — prefer the derived block, falling back to any inline mod.
  if (system.abilities) {
    stats.abilities = {};
    for (const [key, ability] of Object.entries(system.abilities)) {
      const abilityData = ability as any;
      stats.abilities[key] = {
        value: abilityData.value ?? 10,
        modifier: actorData.derived?.abilities?.[key]?.mod ?? abilityData.mod ?? 0,
      };
    }
  }

  // Skills. `total` (the rolled modifier) and `passive` are DERIVED; prefer the derived block.
  if (system.skills) {
    stats.skills = {};
    for (const [key, skill] of Object.entries(system.skills)) {
      const skillData = skill as any;
      const d = actorData.derived?.skills?.[key];
      const entry: any = {
        value: skillData.value ?? 0,
        modifier: d?.total ?? skillData.total ?? skillData.mod ?? 0,
        proficient: skillData.proficient ?? 0,
      };
      const passive = d?.passive ?? skillData.passive;
      if (passive !== undefined) entry.passive = passive;
      stats.skills[key] = entry;
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
      // `available` (= max − spent) is DERIVED — prefer the derived block over the (absent) source value.
      stats.legendaryActions = {
        available: actorData.derived?.legact?.value ?? legact.value ?? 0,
        max: legact.max ?? 0,
      };
    }

    // XP is derived from CR (absent from the source) — surface it for stat-block display.
    if (typeof actorData.derived?.xp?.value === 'number') {
      stats.xp = actorData.derived.xp.value;
    }
  }

  // Spellcasting. The NPC spell level moved from details.spellLevel to attributes.spell.level in
  // dnd5e 5.x (details.spellLevel kept only as a legacy fallback for old data).
  const spellLevel = system.attributes?.spell?.level ?? system.details?.spellLevel ?? 0;
  const hasSpells = !!(system.spells || system.attributes?.spellcasting || spellLevel > 0);
  if (hasSpells) {
    stats.spellcasting = {
      hasSpells: true,
      spellLevel,
    };
  }

  return stats;
}
