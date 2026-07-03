// The per-type module contract for the placeable tools package.
//
// Each placeable type is ONE file exporting `<type>ToolModule(foundry)`: its hand-tuned zod schemas
// (the LLM-facing contract), the advertised tool definitions, and the thin handlers over
// `foundry.call` + the shared formatters — defs and handlers side by side, KEYED BY TOOL NAME, so
// they cannot drift (the facade asserts the keys match at construction). Correctness lives in the
// page-side descriptor (src/page/placeables/<type>.ts); judgment lives in the skills.

import type { FoundryBridge } from '../../foundry.js';
import { z } from 'zod';

export interface PlaceableToolModule {
  /** Advertised tool definitions ({name, description, inputSchema}). */
  defs: Array<{ name: string; description: string; inputSchema: unknown }>;
  /** Tool name -> handler. Keys must exactly match the def names. */
  handlers: Record<string, (args: any) => Promise<any>>;
}

export type PlaceableModuleFactory = (foundry: FoundryBridge) => PlaceableToolModule;

/** The one scene-target base every placeable schema composes. */
export const sceneTarget = z
  .string()
  .min(1)
  .describe('Scene id or exact name holding the placeables.');
