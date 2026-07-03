// Scene PLACEABLE editing tools — the per-type CRUD library over the shared page-side kernel
// (src/page/_placeables.ts) and per-type descriptors (src/page/placeables/**).
//
// Separate from src/tools/scene.ts (scene-DOCUMENT tools: background, grid, mood, fog — never
// placeables) — the two axes stay hard-split. Each placeable type is one module file here (schemas,
// defs, handlers keyed by tool name); this facade composes them and asserts defs↔handlers can't
// drift. Full library: Tile, AmbientLight, AmbientSound, Drawing, Wall, Token (place/update/delete),
// Note (pins), Region (+ teleporter special ops). MeasuredTemplate is deferred to the DM-session
// phase (combat ephemera, not world-building) — the descriptor recipe in
// docs/scene-placeables-architecture.md §3.6 makes it a cheap add when needed.

import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import type { PlaceableToolModule } from './_module.js';
import { tileToolModule } from './tile.js';
import { lightToolModule } from './light.js';
import { soundToolModule } from './sound.js';
import { drawingToolModule } from './drawing.js';
import { wallToolModule } from './wall.js';
import { tokenToolModule } from './token.js';
import { noteToolModule } from './note.js';
import { regionToolModule } from './region.js';

export interface PlaceableToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class PlaceableTools {
  private logger: Logger;
  private modules: PlaceableToolModule[];
  private handlers: Record<string, (args: any) => Promise<any>>;

  constructor({ foundry, logger }: PlaceableToolsOptions) {
    this.logger = logger.child({ component: 'PlaceableTools' });
    this.modules = [
      tileToolModule(foundry),
      lightToolModule(foundry),
      soundToolModule(foundry),
      drawingToolModule(foundry),
      wallToolModule(foundry),
      tokenToolModule(foundry),
      noteToolModule(foundry),
      regionToolModule(foundry),
    ];
    // Compose the name->handler map and fail LOUDLY on any def↔handler drift or name collision.
    this.handlers = {};
    for (const m of this.modules) {
      const defNames = new Set(m.defs.map(d => d.name));
      for (const name of Object.keys(m.handlers)) {
        if (!defNames.has(name)) {
          throw new Error(`Placeable tool "${name}" has a handler but no advertised definition`);
        }
        if (this.handlers[name]) {
          throw new Error(`Placeable tool "${name}" is defined by two modules`);
        }
        this.handlers[name] = m.handlers[name];
      }
      for (const name of defNames) {
        if (!m.handlers[name]) {
          throw new Error(`Placeable tool "${name}" is advertised but has no handler`);
        }
      }
    }
  }

  getToolDefinitions() {
    return this.modules.flatMap(m => m.defs);
  }

  /** Route one placeable tool call to its module handler (registry-facing). */
  async handle(name: string, args: any): Promise<any> {
    const handler = this.handlers[name];
    if (!handler) throw new Error(`Unknown placeable tool: ${name}`);
    return handler(args);
  }
}
