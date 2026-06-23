/**
 * Registration ↔ dispatch drift guard.
 *
 * index.ts advertises tools via each class's getToolDefinitions() (assembled into `allTools`)
 * and routes them through a hand-maintained `switch (name)`. The two lists are edited
 * separately, so a new/renamed tool can be advertised-but-not-dispatched (or a case can be
 * orphaned) and only surface at runtime via the `default` throw. This test reconstructs the
 * advertised list exactly as index.ts does and asserts every advertised name has a matching
 * `case '<name>':` in the dispatcher source — cheap offline coverage of the glue index.ts
 * itself can't be imported to test (importing it would start the stdio server).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { makeFoundry, makeLogger } from './test-helpers.js';

import { CharacterTools } from './character.js';
import { CompendiumTools } from './compendium.js';
import { SceneTools } from './scene.js';
import { ActorCreationTools } from './actor-creation.js';
import { QuestCreationTools } from './quest-creation.js';
import { OwnershipTools } from './ownership.js';
import { DnD5eAddFeatureTool } from './dnd5e/add-feature.js';
import { DnD5eFeaturesFromCompendiumTools } from './dnd5e/features.js';
import { buildGrantToActorTool } from './dnd5e/grant-to-actor.js';
import { MoltenTools } from './molten/index.js';
import { AssetBridgeTools } from './asset-bridge.js';
import { TableTools } from './tables.js';
import { CardsTools } from './cards.js';
import { OrganizationTools } from './organization.js';

function advertisedNames(): string[] {
  const { foundry } = makeFoundry();
  const logger = makeLogger();
  const deps = { foundry, logger };

  const addFeature = new DnD5eAddFeatureTool(deps);
  const featuresFromCompendium = new DnD5eFeaturesFromCompendiumTools(deps);
  const grantToActorTool = buildGrantToActorTool(
    addFeature.getInputSchema(),
    featuresFromCompendium.getInputSchema()
  );

  const all = [
    ...new CharacterTools(deps).getToolDefinitions(),
    ...new CompendiumTools(deps).getToolDefinitions(),
    ...new SceneTools(deps).getToolDefinitions(),
    ...new ActorCreationTools(deps).getToolDefinitions(),
    grantToActorTool,
    ...new QuestCreationTools(deps).getToolDefinitions(),
    ...new OwnershipTools(deps).getToolDefinitions(),
    ...new MoltenTools({ logger, foundry }).getToolDefinitions(),
    ...new AssetBridgeTools(deps).getToolDefinitions(),
    ...new TableTools(deps).getToolDefinitions(),
    ...new CardsTools(deps).getToolDefinitions(),
    ...new OrganizationTools(deps).getToolDefinitions(),
  ];
  return all.map(t => t.name);
}

function dispatchCases(): string[] {
  const indexPath = resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts');
  const src = readFileSync(indexPath, 'utf8');
  return [...src.matchAll(/case\s+'([^']+)':/g)].map(m => m[1]);
}

describe('tool registration ↔ dispatch', () => {
  it('every advertised tool has a matching dispatch case', () => {
    const cases = new Set(dispatchCases());
    const missing = advertisedNames().filter(name => !cases.has(name));
    expect(missing).toEqual([]);
  });

  it('advertises 62 uniquely-named tools (matches the documented surface)', () => {
    const names = advertisedNames();
    expect(new Set(names).size).toBe(names.length); // no duplicate names
    expect(names.length).toBe(62);
  });
});
