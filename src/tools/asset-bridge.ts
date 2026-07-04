import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * Asset-bridge tools — reference integrity + asset→document composition over the live bridge.
 * Unlike the WebDAV file tools in tools/molten, these manipulate live Foundry documents via
 * foundry.call, so they need the world loaded. Scenes moved to tools/scene.ts and playlists to
 * tools/playlist.ts so the Node-side classes mirror the page-side domain split (page/assets.ts is the
 * art/reference home); what remains here is the cohesive "asset" pair: reference integrity
 * (find/relink) and asset→document art composition (set-actor-art, add-journal-image).
 *
 * Paths are Data-relative (the same vocabulary upload-asset returns) — what Foundry stores in src/img
 * fields — so an uploaded asset path chains straight into set-actor-art with no conversion.
 */

// Single source of truth for each tool's input contract: the handler parses with these
// schemas and getToolDefinitions() advertises toInputSchema(...) of the same schema.
const FindAssetReferencesSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'One or more Data-relative asset paths to look up, e.g. ' +
        '["worlds/your-world/assets/maps/cavern.webp"].'
    ),
});

const RelinkAssetSchema = z.object({
  oldPath: z.string().min(1).describe('Current Data-relative path being referenced.'),
  newPath: z.string().min(1).describe('New Data-relative path to point references at.'),
  dryRun: z.boolean().default(false).describe('Report what would change without writing.'),
});

const SetActorArtSchema = z.object({
  actorIdentifier: z.string().min(1).describe('Actor id or exact name.'),
  imagePath: z
    .string()
    .min(1)
    .describe(
      'Data-relative path to the PORTRAIT image. Must be a STILL image — actor.img rejects video. ' +
        'Also used for the token texture unless tokenImagePath is given.'
    ),
  tokenImagePath: z
    .string()
    .optional()
    .describe(
      'Optional Data-relative path for the prototype TOKEN texture, which (unlike the portrait) ' +
        'accepts an animated VIDEO (.webm/.mp4/.m4v/.ogg) — e.g. a JB2A effect. Defaults to imagePath.'
    ),
  applyToToken: z
    .boolean()
    .default(true)
    .describe('Also set the prototype token texture (default true).'),
});

const AddJournalImageSchema = z.object({
  journalIdentifier: z.string().min(1).describe('Journal id or exact name.'),
  imagePath: z.string().min(1).describe('Data-relative path to the image.'),
  pageName: z.string().optional().describe('Page title (defaults to the file name).'),
  caption: z.string().optional().describe('Optional image caption.'),
  playerVisible: z
    .boolean()
    .optional()
    .describe('If true, players can OBSERVE this image page (a handout). Default: GM-only.'),
});

export interface AssetBridgeToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class AssetBridgeTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: AssetBridgeToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'AssetBridgeTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'find-asset-references',
        description:
          'Reference integrity. Find every world document (scenes, actors, items, journals, ' +
          'playlists, macros, roll tables) that references a given asset path under `Data/`. Use this ' +
          'BEFORE deleting or moving a file to see what would break. Read-only.',
        inputSchema: toInputSchema(FindAssetReferencesSchema),
      },
      {
        name: 'relink-asset',
        description:
          'Reference integrity. Rewrite every reference from one asset path to another (e.g. after ' +
          'moving/renaming a file) so nothing breaks. Pass dryRun:true to preview the documents that ' +
          'would change without writing. GM-only.',
        inputSchema: toInputSchema(RelinkAssetSchema),
      },
      {
        name: 'set-actor-art',
        description:
          "Composition. Set an actor's portrait image, and by default its prototype token art too, " +
          'from a Data-relative path. The portrait (actor.img) must be a STILL image; pass ' +
          'tokenImagePath to give the prototype TOKEN an animated video (.webm/.mp4) while keeping a ' +
          'still portrait (the JB2A-effect pattern). GM-only.',
        inputSchema: toInputSchema(SetActorArtSchema),
      },
      {
        name: 'add-journal-image',
        description:
          'Composition. Append an image page to a journal entry from a Data-relative image path, ' +
          'with an optional caption. GM-only by default; set playerVisible to expose it as a handout.',
        inputSchema: toInputSchema(AddJournalImageSchema),
      },
    ];
  }

  // --- handlers -------------------------------------------------------------

  async handleFindAssetReferences(args: any): Promise<string> {
    const { paths } = FindAssetReferencesSchema.parse(args ?? {});
    const result = await this.foundry.call('findAssetReferences', { paths });
    const refs = result?.references ?? {};
    const lines: string[] = [];
    for (const path of paths) {
      const hits = refs[path] ?? [];
      if (hits.length === 0) {
        lines.push(`• ${path} — no references found (safe to delete/move).`);
      } else {
        lines.push(`• ${path} — ${hits.length} reference(s):`);
        for (const h of hits) {
          lines.push(`    - ${h.documentType} "${h.documentName}" (${h.documentId}) :: ${h.field}`);
        }
      }
    }
    return `Asset references (${result?.totalReferences ?? 0} total):\n${lines.join('\n')}`;
  }

  async handleRelinkAsset(args: any): Promise<string> {
    const { oldPath, newPath, dryRun } = RelinkAssetSchema.parse(args ?? {});
    const result = await this.foundry.call('relinkAsset', {
      oldPath,
      newPath,
      dryRun,
    });
    const changed = result?.changed ?? [];
    const verb = result?.dryRun ? 'Would rewrite' : 'Rewrote';
    const header = `${verb} ${result?.changedCount ?? changed.length} reference(s): ${oldPath} → ${newPath}`;
    if (changed.length === 0) return `${header} (nothing referenced the old path).`;
    const lines = changed.map(
      (c: any) => `  - ${c.documentType} "${c.documentName}" (${c.documentId}) :: ${c.field}`
    );
    return `${header}\n${lines.join('\n')}`;
  }

  async handleSetActorArt(args: any): Promise<string> {
    const parsed = SetActorArtSchema.parse(args ?? {});
    const result = await this.foundry.call('setActorArt', parsed);
    if (result?.updated === false && result?.notFound) {
      return `Actor not found: "${result?.notFound ?? parsed.actorIdentifier}". Nothing changed.`;
    }
    const warns = Array.isArray(result?.warnings) ? result.warnings : [];
    const warnSection = warns.length
      ? `\n\n⚠️ ${warns.length} warning(s):\n${warns.map((w: string) => `- ${w}`).join('\n')}`
      : '';
    // Nothing valid was written (e.g. a video portrait with applyToToken:false) — report + warn.
    if (result?.updated === false) {
      return `No art applied to actor "${result?.actorName ?? parsed.actorIdentifier}".${warnSection}`;
    }
    const img = result?.img;
    const tokenSrc = result?.tokenSrc;
    // Distinct portrait vs token art (a still portrait + an animated token) → show both; otherwise
    // keep the original single-path phrasing.
    const artDesc =
      result?.appliedToToken && tokenSrc && tokenSrc !== img
        ? `portrait ${img ?? '(unchanged)'} · token ${tokenSrc}`
        : `${img ?? tokenSrc}${result?.appliedToToken ? ' (portrait + prototype token)' : ' (portrait only)'}`;
    return `Set art for actor "${result?.actorName}" (${result?.actorId}) → ${artDesc}.${warnSection}`;
  }

  async handleAddJournalImage(args: any): Promise<string> {
    const parsed = AddJournalImageSchema.parse(args ?? {});
    const result = await this.foundry.call('addJournalImage', parsed);
    if (result?.updated === false) {
      return `Journal not found: "${result?.notFound ?? parsed.journalIdentifier}". Nothing changed.`;
    }
    const warns = Array.isArray(result?.warnings) ? result.warnings : [];
    const warnSection = warns.length
      ? `\n\n⚠️ ${warns.length} warning(s):\n${warns.map((w: string) => `- ${w}`).join('\n')}`
      : '';
    return (
      `Added image page "${result?.pageName}" (${result?.pageId}) to journal ` +
      `"${result?.journalName}" (${result?.journalId}) → ${result?.src}.` +
      warnSection
    );
  }
}
