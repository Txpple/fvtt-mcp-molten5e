// Spike: v14 embedded PLACEABLE document schema ground truth (READ-ONLY).
//
// For the scene-placeables architecture review. Dumps, against the live world (Foundry 14.364,
// dnd5e 5.3.3), the schema field tree for EVERY embedded PlaceableDocument on a Scene —
// Token · Tile · Drawing · Wall · AmbientLight · AmbientSound · Note · MeasuredTemplate · Region
// (+ Region's embedded RegionBehavior) — plus the relevant CONST enums and a real sample
// toObject() of each placeable type actually present in the most-populated live scene. This is the
// ground truth the CRUD roadmap is built on (per the scene-schema memory: trust the live dump over
// the stale foundry-vtt-types repo).
//
// Reuses the project's robust Foundry bridge (wake → admin-launch → join → ready) from dist/.
// Build first: npm run build.  Run: node scripts/spike-placeables-schema.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry } from '../dist/foundry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'Claude',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

const OUT = join(__dirname, '..', 'scratch-placeables-schema.json');

try {
  console.log('[spike-placeables] connecting…');
  await f.connect();
  console.log('[spike-placeables] connected — probing\n');

  const probe = await f.evaluate(() => {
    // Recursively describe a DataField tree, capped in depth so the dump stays readable.
    const describeField = (field, depth = 0) => {
      if (!field || depth > 4) return { type: field?.constructor?.name ?? '?' };
      const info = { type: field.constructor?.name };
      if (field.required) info.required = true;
      if (field.nullable) info.nullable = true;
      // initial can be a fn; just record whether a default exists + a scalar default if cheap.
      if (field.initial !== undefined && typeof field.initial !== 'function') {
        try {
          info.default = JSON.parse(JSON.stringify(field.initial));
        } catch {
          /* skip unserializable defaults */
        }
      } else if (typeof field.initial === 'function') {
        info.default = '<fn>';
      }
      const choices = field.choices ?? field.options?.choices;
      if (choices && typeof choices !== 'function') {
        try {
          info.choices = Array.isArray(choices) ? choices : Object.keys(choices);
        } catch {
          /* skip */
        }
      }
      // Nested structure:
      if (field.fields) {
        // SchemaField / embedded data model with a fields map
        info.fields = Object.fromEntries(
          Object.entries(field.fields).map(([k, v]) => [k, describeField(v, depth + 1)])
        );
      }
      if (field.element) {
        // ArrayField / SetField / EmbeddedCollectionField — describe the element
        info.of = describeField(field.element, depth + 1);
      }
      if (field.model?.schema?.fields) {
        // EmbeddedDataField / EmbeddedDocumentField — describe the model schema
        info.model = Object.fromEntries(
          Object.entries(field.model.schema.fields).map(([k, v]) => [
            k,
            describeField(v, depth + 1),
          ])
        );
      }
      return info;
    };

    const schemaOf = configKey => {
      const cls = CONFIG?.[configKey]?.documentClass;
      const fields = cls?.schema?.fields;
      if (!fields) return { error: `no documentClass/schema for CONFIG.${configKey}` };
      return {
        documentName: cls.documentName,
        topLevelKeys: Object.keys(fields),
        fields: Object.fromEntries(
          Object.entries(fields).map(([k, v]) => [k, describeField(v, 0)])
        ),
      };
    };

    const out = {
      world: {
        system: game.system?.id,
        systemVersion: game.system?.version,
        foundry: game.version,
      },
    };

    // 1) SCHEMAS for every embedded placeable document type ---------------------
    const PLACEABLES = [
      'Token',
      'Tile',
      'Drawing',
      'Wall',
      'AmbientLight',
      'AmbientSound',
      'Note',
      'MeasuredTemplate',
      'Region',
    ];
    out.schemas = Object.fromEntries(PLACEABLES.map(k => [k, schemaOf(k)]));
    // Region's embedded RegionBehavior is its own document type.
    out.schemas.RegionBehavior = schemaOf('RegionBehavior');

    // 2) Relevant CONST enums --------------------------------------------------
    out.CONST = {
      WALL_SENSE_TYPES: CONST?.WALL_SENSE_TYPES,
      WALL_MOVEMENT_TYPES: CONST?.WALL_MOVEMENT_TYPES,
      WALL_DOOR_TYPES: CONST?.WALL_DOOR_TYPES,
      WALL_DOOR_STATES: CONST?.WALL_DOOR_STATES,
      WALL_DIRECTIONS: CONST?.WALL_DIRECTIONS,
      WALL_RESTRICTION_TYPES: CONST?.WALL_RESTRICTION_TYPES,
      TOKEN_DISPOSITIONS: CONST?.TOKEN_DISPOSITIONS,
      DRAWING_FILL_TYPES: CONST?.DRAWING_FILL_TYPES,
      MEASURED_TEMPLATE_TYPES: CONST?.MEASURED_TEMPLATE_TYPES,
      TILE_OCCLUSION_MODES: CONST?.TILE_OCCLUSION_MODES,
      REGION_VISIBILITY: CONST?.REGION_VISIBILITY,
      REGION_MOVEMENT_SEGMENTS: CONST?.REGION_MOVEMENT_SEGMENTS,
      NOTE_ANCHORS: CONST?.NOTE_ANCHORS ?? CONST?.TEXT_ANCHOR_POINTS,
    };

    // 3) Available RegionBehavior sub-types (the teleportToken family etc.) ------
    out.regionBehaviorTypes = Object.keys(CONFIG?.RegionBehavior?.dataModels ?? {});

    // 4) Live samples from the most-populated scene(s) --------------------------
    // Trim big/derived fields so the sample stays legible.
    const trim = obj => {
      const clone = JSON.parse(JSON.stringify(obj ?? {}));
      return clone;
    };
    const sceneStats = [];
    for (const scene of game.scenes?.contents ?? []) {
      const counts = {
        tokens: scene.tokens?.size ?? 0,
        tiles: scene.tiles?.size ?? 0,
        drawings: scene.drawings?.size ?? 0,
        walls: scene.walls?.size ?? 0,
        lights: scene.lights?.size ?? 0,
        sounds: scene.sounds?.size ?? 0,
        notes: scene.notes?.size ?? 0,
        templates: scene.templates?.size ?? 0,
        regions: scene.regions?.size ?? 0,
      };
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      sceneStats.push({ id: scene.id, name: scene.name, total, counts });
    }
    sceneStats.sort((a, b) => b.total - a.total);
    out.sceneStats = sceneStats;

    // Grab one real sample per placeable kind from wherever it first appears.
    const collForKind = {
      Token: s => s.tokens,
      Tile: s => s.tiles,
      Drawing: s => s.drawings,
      Wall: s => s.walls,
      AmbientLight: s => s.lights,
      AmbientSound: s => s.sounds,
      Note: s => s.notes,
      MeasuredTemplate: s => s.templates,
      Region: s => s.regions,
    };
    const samples = {};
    for (const [kind, get] of Object.entries(collForKind)) {
      for (const scene of game.scenes?.contents ?? []) {
        const coll = get(scene);
        const first = coll?.contents?.[0];
        if (first) {
          samples[kind] = { fromScene: scene.name, source: trim(first.toObject()) };
          // For a Region, also expose its behaviors' toObject (teleporters etc.)
          if (kind === 'Region') {
            samples[kind].behaviors = (first.behaviors?.contents ?? []).map(b =>
              trim(b.toObject())
            );
          }
          break;
        }
      }
      if (!samples[kind]) samples[kind] = null; // none present in the world
    }
    out.samples = samples;

    return out;
  }, undefined);

  writeFileSync(OUT, JSON.stringify(probe, null, 2), 'utf8');
  console.log(`[spike-placeables] wrote ${OUT}`);
  // Console summary so the run is legible without opening the file.
  console.log('\nWorld:', JSON.stringify(probe.world));
  console.log('\nScene population (top 5):');
  for (const s of probe.sceneStats.slice(0, 5)) {
    console.log(`  ${s.name} — total ${s.total}: ${JSON.stringify(s.counts)}`);
  }
  console.log('\nTop-level schema keys per placeable:');
  for (const [k, v] of Object.entries(probe.schemas)) {
    console.log(`  ${k}: ${v.topLevelKeys ? v.topLevelKeys.join(', ') : JSON.stringify(v)}`);
  }
  console.log('\nRegionBehavior sub-types:', JSON.stringify(probe.regionBehaviorTypes));
  console.log(
    '\nSamples present:',
    Object.entries(probe.samples)
      .map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`)
      .join(' ')
  );
} catch (e) {
  console.log(`\n[spike-placeables] FATAL: ${e?.stack || e?.message || String(e)}`);
  process.exitCode = 1;
} finally {
  await f.dispose?.();
}
