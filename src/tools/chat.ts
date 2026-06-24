import { z } from 'zod';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, isAbsolute, basename } from 'node:path';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { config } from '../config.js';
import type { MoltenConfig } from '../config.js';
import { toInputSchema } from '../utils/schema.js';
import { formatDeletionResult } from '../utils/format.js';
import { ErrorHandler, FormattedToolError } from '../utils/error-handler.js';
import { validateExportDestinations } from '../utils/transcript.js';
import { WebDavClient, toDataRelative, guessContentType } from './molten/webdav.js';
import {
  makeDavClient,
  buildPublicUrl,
  notConfiguredMessage,
  worldDbRefusal,
  looksLikeWorldDbPath,
  davErrorMessage,
  humanSize,
} from './molten/dav-access.js';

/**
 * Chat-log tools — post / list / delete / export chat messages, plus rich dnd5e cards.
 *
 * send-chat-message covers all five visibility modes (public / public-as-character / gm / blind /
 * self) and embeds images as a first-class param (local files are uploaded over WebDAV, then linked).
 * post-item-card drives the dnd5e Activity system so its Attack/Damage/Apply-Effects buttons actually
 * work (the only way without an installed module). export-chat-log writes to a local file AND/OR a
 * WebDAV Data/ path. GM-only writes; the bridge user is a GM.
 */

const ImageSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'An absolute LOCAL file path (uploaded over WebDAV), a Data-relative asset path already in ' +
        'Foundry, or an https:// URL.'
    ),
  caption: z.string().optional().describe('Optional caption shown under the image.'),
  alt: z.string().optional().describe('Optional alt text (defaults to the caption).'),
  embed: z
    .enum(['webdav', 'dataUri'])
    .default('webdav')
    .describe(
      'webdav (default) = upload a local file to the world over WebDAV and link its public URL ' +
        '(http/Data-relative paths are linked as-is). dataUri = inline the LOCAL file directly into ' +
        'the message HTML as a base64 data: URI — self-contained, no upload, but it bloats the ' +
        'message in the world DB, so keep it for small images.'
    ),
});

const SendChatMessageSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'Message body as HTML (all formatting is just HTML). Inline rolls like [[/r 1d20+5]] and ' +
        '@UUID[Type.id]{label} links are enriched on render. Use the images param to attach images ' +
        'rather than hand-writing <img>.'
    ),
  visibility: z
    .enum(['public', 'gm', 'blind', 'self'])
    .default('public')
    .describe(
      'public = everyone; gm = whisper to all GMs; blind = whisper to GMs (mainly meaningful for ' +
        'rolls — for plain text it behaves like gm but also sets blind); self = only the bridge ' +
        'user. For "public as a character", use public + speakerActor.'
    ),
  speakerActor: z
    .string()
    .optional()
    .describe(
      'Actor id / exact name / name-substring (or scene token id) to speak AS — the message renders ' +
        'with that character as speaker (the "public as character" mode).'
    ),
  flavor: z
    .string()
    .optional()
    .describe('Optional secondary header line, e.g. "Perception Check".'),
  style: z
    .enum(['ooc', 'ic', 'emote', 'other'])
    .optional()
    .describe('Presentation style (defaults to ic when speakerActor is set, else ooc).'),
  enrich: z
    .boolean()
    .default(true)
    .describe('Pre-enrich content (resolve @UUID links and inline rolls) before posting.'),
  images: z
    .array(ImageSchema)
    .optional()
    .describe(
      'Images to embed. Local files are uploaded to the world over WebDAV and linked; Data-relative ' +
        'paths and https URLs are linked directly. PRIVACY: uploaded files are served publicly with ' +
        'no auth.'
    ),
  imageFolder: z
    .string()
    .optional()
    .describe(
      'Data-relative folder for uploaded local images (default "worlds/<world>/assets/chat").'
    ),
  overwriteImages: z
    .boolean()
    .default(false)
    .describe('Overwrite an existing uploaded image of the same name instead of refusing.'),
});

const ListChatMessagesSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .default(50)
    .describe('Return the most recent N messages (chronological, newest last).'),
  sinceTimestamp: z
    .number()
    .int()
    .optional()
    .describe('Only messages with timestamp (ms epoch) at/after this value.'),
  contentMode: z
    .enum(['html', 'text', 'none'])
    .default('text')
    .describe(
      'Return raw content HTML, HTML stripped to text, or omit content (cheap on big logs).'
    ),
});

const DeleteChatMessagesSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .optional()
      .describe('Exact message ids to delete (a single id is just an array of one).'),
    beforeTimestamp: z
      .number()
      .int()
      .optional()
      .describe(
        'Delete all messages with timestamp (ms epoch) older than this — purge an old log.'
      ),
    clearAll: z
      .boolean()
      .default(false)
      .describe('Delete EVERY chat message. Requires confirm:true.'),
    confirm: z
      .boolean()
      .default(false)
      .describe('Must be true to run clearAll (an explicit guard — clear-all is irreversible).'),
  })
  .refine(a => (a.ids && a.ids.length > 0) || a.beforeTimestamp !== undefined || a.clearAll, {
    message: 'Provide ids, beforeTimestamp, or clearAll.',
  });

const ExportChatLogSchema = z
  .object({
    format: z
      .enum(['markdown', 'html', 'json', 'plaintext'])
      .default('markdown')
      .describe(
        'Transcript format. markdown/plaintext strip HTML (roll totals kept); html keeps raw ' +
          'message markup (unstyled, not the rendered card); json is the structured records.'
      ),
    localPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Absolute local destination path (parent dirs created). At least one destination required.'
      ),
    remotePath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Destination relative to the Foundry Data/ root for the WebDAV copy, e.g. ' +
          '"worlds/your-world/exports/session-3.md". Returns a public HTTPS URL. Requires MOLTEN_WEBDAV_PASSWORD.'
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Export only the most recent N messages (omit for the whole log).'),
    sinceTimestamp: z
      .number()
      .int()
      .optional()
      .describe('Only messages at/after this ms-epoch timestamp.'),
    overwrite: z
      .boolean()
      .default(false)
      .describe('Allow overwriting an existing file at either destination.'),
  })
  .refine(a => a.localPath || a.remotePath, {
    message: 'Provide localPath, remotePath, or both.',
  });

const PostItemCardSchema = z.object({
  actor: z
    .string()
    .min(1)
    .describe('Actor id / exact name / name-substring (or scene token id) that owns the item.'),
  item: z.string().min(1).describe('Item / feature / spell id or exact name on that actor.'),
  activity: z
    .string()
    .optional()
    .describe('Optional activity id/name when the item has several (default: the first activity).'),
  action: z
    .enum(['use', 'attack', 'damage'])
    .default('use')
    .describe(
      'use = post the usage card with its buttons (primary path); attack = roll the attack to chat; ' +
        'damage = roll damage to chat. attack/damage auto-targeting is degraded headless (no targets).'
    ),
  consume: z
    .boolean()
    .default(false)
    .describe('Spend the item/spell resources (uses/slots). Default false = just post the card.'),
  critical: z
    .boolean()
    .default(false)
    .describe('For action=damage: roll a critical (best-effort).'),
});

const RequestRollSchema = z
  .object({
    kind: z
      .enum(['save', 'check', 'skill'])
      .describe('save = ability saving throw; check = ability check; skill = skill check.'),
    ability: z
      .string()
      .optional()
      .describe('Ability key for save/check, e.g. "dex", "wis", "con".'),
    skill: z.string().optional().describe('Skill key for kind=skill, e.g. "ste", "prc", "ath".'),
    dc: z.number().int().positive().optional().describe('Target DC shown on the card.'),
    flavor: z.string().optional().describe('Optional label, e.g. "Trap! Reflexes".'),
    visibility: z
      .enum(['public', 'gm'])
      .default('public')
      .describe('public = the whole table; gm = GMs only.'),
  })
  .refine(a => (a.kind === 'skill' ? !!a.skill : !!a.ability), {
    message: 'save/check require an ability; skill requires a skill.',
  });

export interface ChatToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class ChatTools {
  private foundry: FoundryBridge;
  private logger: Logger;
  private molten: MoltenConfig;
  private errorHandler: ErrorHandler;
  private davClient: WebDavClient | null = null;

  constructor({ foundry, logger }: ChatToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'ChatTools' });
    this.molten = config.molten;
    this.errorHandler = new ErrorHandler(this.logger);
  }

  private dav(): WebDavClient | null {
    if (!this.davClient) this.davClient = makeDavClient(this.molten, this.logger);
    return this.davClient;
  }

  getToolDefinitions() {
    return [
      {
        name: 'send-chat-message',
        description:
          'Post a message to the Foundry chat log as the GM bridge user. Content is HTML. Choose a ' +
          'visibility mode (public / gm whisper / blind / self) and optionally speak AS a character ' +
          '(speakerActor). Embed images via the images param (local files upload over WebDAV; ' +
          'Data-relative paths and https URLs link directly — uploaded files are PUBLIC). GM-only.',
        inputSchema: toInputSchema(SendChatMessageSchema),
      },
      {
        name: 'list-chat-messages',
        description:
          'List recent chat messages (id, author, time, whisper/blind, content preview). Use to ' +
          'find ids for delete, verify a post, or preview before export. contentMode:"none" keeps ' +
          'it cheap on a huge log.',
        inputSchema: toInputSchema(ListChatMessagesSchema),
      },
      {
        name: 'delete-chat-messages',
        description:
          'Delete chat messages: by exact id(s) (a single id is an array of one), or all messages ' +
          'older than a timestamp (beforeTimestamp — handy for the known Molten big-log perf drag), ' +
          'or the entire log (clearAll + confirm:true). IRREVERSIBLE. GM-only.',
        inputSchema: toInputSchema(DeleteChatMessagesSchema),
      },
      {
        name: 'export-chat-log',
        description:
          'Export the chat transcript to a LOCAL absolute file AND/OR a WebDAV Data/ path (returns ' +
          'its public URL). Formats: markdown | html | json | plaintext. Refuses to overwrite an ' +
          'existing file at either destination unless overwrite:true. WebDAV needs MOLTEN_WEBDAV_PASSWORD.',
        inputSchema: toInputSchema(ExportChatLogSchema),
      },
      {
        name: 'post-item-card',
        description:
          "Post a rich dnd5e card for an actor's item/feature/spell with WORKING buttons " +
          '(Attack/Damage/Apply-Effects), or roll an attack/damage to chat. Drives the dnd5e Activity ' +
          'system — the only way to get interactive buttons without a module. Items with no activity ' +
          'return a clear reason (use send-chat-message for a plain card). GM-only.',
        inputSchema: toInputSchema(PostItemCardSchema),
      },
      {
        name: 'request-roll',
        description:
          'Post a click-to-roll request card (saving throw / ability check / skill) that players ' +
          'click to roll their OWN check — the table-facing "everyone make a DEX save (DC 15)" ' +
          'prompt. Uses the dnd5e inline roll enricher. GM-only.',
        inputSchema: toInputSchema(RequestRollSchema),
      },
    ];
  }

  // --- send -----------------------------------------------------------------

  async handleSendChatMessage(args: any): Promise<string> {
    try {
      const parsed = SendChatMessageSchema.parse(args ?? {});

      let content = parsed.content;
      if (parsed.images && parsed.images.length > 0) {
        const assembled = await this.assembleImages(
          parsed.images,
          parsed.imageFolder ?? `worlds/${this.molten.worldId ?? 'world'}/assets/chat`,
          parsed.overwriteImages
        );
        if ('refusal' in assembled) return assembled.refusal;
        content = `${content}\n${assembled.figures.join('\n')}`;
      }

      const result = await this.foundry.call('postChatMessage', {
        content,
        visibility: parsed.visibility,
        speakerActor: parsed.speakerActor,
        flavor: parsed.flavor,
        style: parsed.style,
        enrich: parsed.enrich,
      });
      return (
        `Posted chat message ${result?.id} as "${result?.alias}" ` +
        `(${result?.visibility}, whisper: ${result?.whisperCount}).`
      );
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'send-chat-message', 'posting message');
    }
  }

  /**
   * Resolve each image to a public URL (uploading absolute local files over WebDAV) and build the
   * <figure> HTML. Returns a plain refusal string on a WebDAV/world-DB guard rather than throwing.
   */
  private async assembleImages(
    images: Array<{
      path: string;
      caption?: string | undefined;
      alt?: string | undefined;
      embed?: 'webdav' | 'dataUri' | undefined;
    }>,
    folder: string,
    overwrite: boolean
  ): Promise<{ figures: string[] } | { refusal: string }> {
    const figures: string[] = [];
    for (const img of images) {
      const p = img.path;
      let url: string;

      // dataUri: inline a LOCAL file as base64 directly in the HTML (no upload).
      if (img.embed === 'dataUri') {
        if (/^https?:\/\//i.test(p) || p.startsWith('data:')) {
          return {
            refusal: `Image "${p}": embed:"dataUri" needs a LOCAL file path, not a URL. Use embed:"webdav" or pass a local file.`,
          };
        }
        let bytes: Buffer;
        try {
          bytes = await readFile(p);
        } catch (err) {
          return {
            refusal: `Cannot read local image "${p}" for dataUri embed: ${(err as Error).message}`,
          };
        }
        const mime = guessContentType(p) || 'application/octet-stream';
        url = `data:${mime};base64,${bytes.toString('base64')}`;
        figures.push(figureHtml(url, img.caption, img.alt));
        continue;
      }

      if (/^https?:\/\//i.test(p)) {
        url = p;
      } else if (isAbsolute(p)) {
        // Local file → upload over WebDAV, then link the public URL.
        const dav = this.dav();
        if (!dav)
          return {
            refusal: notConfiguredMessage(
              'send-chat-message (image upload)',
              this.molten.webdavUser
            ),
          };
        const remote = toDataRelative(`${folder}/${basename(p)}`);
        if (looksLikeWorldDbPath(remote)) return { refusal: worldDbRefusal(remote) };
        let bytes: Uint8Array;
        try {
          bytes = await readFile(p);
        } catch (err) {
          return { refusal: `Cannot read local image "${p}": ${(err as Error).message}` };
        }
        try {
          if (overwrite || !(await dav.exists(remote))) {
            await dav.ensureParents(remote);
            await dav.putFile(remote, bytes, guessContentType(p));
          }
          url = buildPublicUrl(this.molten.serverUrl, remote);
        } catch (err) {
          return { refusal: davErrorMessage('send-chat-message (image upload)', err, this.logger) };
        }
      } else {
        // Treat as an existing Data-relative asset path.
        url = buildPublicUrl(this.molten.serverUrl, toDataRelative(p));
      }

      figures.push(figureHtml(url, img.caption, img.alt));
    }
    return { figures };
  }

  // --- list -----------------------------------------------------------------

  async handleListChatMessages(args: any): Promise<string> {
    const parsed = ListChatMessagesSchema.parse(args ?? {});
    const res = await this.foundry.call('listChatMessages', parsed);
    const messages: any[] = res?.messages ?? [];
    if (messages.length === 0) return 'No chat messages.';
    const lines = messages.map(m => {
      const preview = (m.content ?? '').replace(/\s+/g, ' ').slice(0, 80);
      const w = m.whisperCount ? ` [whisper:${m.whisperCount}${m.blind ? ',blind' : ''}]` : '';
      const who = m.alias || m.authorName || '?';
      return `  - ${m.id} [${m.time}] ${who}${w}: ${preview}`;
    });
    return `${messages.length} message(s):\n${lines.join('\n')}`;
  }

  // --- delete ---------------------------------------------------------------

  async handleDeleteChatMessages(args: any): Promise<string> {
    const parsed = DeleteChatMessagesSchema.parse(args ?? {});
    // Guard the irreversible clear-all BEFORE touching the bridge.
    if (parsed.clearAll && !parsed.confirm) {
      return (
        'Refused: clearAll deletes EVERY chat message and is irreversible. ' +
        'Pass confirm:true to proceed.'
      );
    }
    const result = await this.foundry.call('deleteChatMessages', parsed);
    if (result?.clearedAll) {
      return `Cleared the chat log — deleted ${result.deletedCount} message(s).`;
    }
    return formatDeletionResult(result, 'chat message(s)');
  }

  // --- export ---------------------------------------------------------------

  async handleExportChatLog(args: any): Promise<string> {
    const parsed = ExportChatLogSchema.parse(args ?? {});
    // Build conditionally to avoid explicit-undefined props (exactOptionalPropertyTypes).
    const dest: { localPath?: string; remotePath?: string } = {};
    if (parsed.localPath) dest.localPath = parsed.localPath;
    if (parsed.remotePath) dest.remotePath = parsed.remotePath;
    const check = validateExportDestinations(dest);
    if (!check.ok) return `Refused: ${check.error}`;

    const res = await this.foundry.call('exportChatLog', {
      format: parsed.format,
      limit: parsed.limit,
      sinceTimestamp: parsed.sinceTimestamp,
    });
    const content: string = res?.content ?? '';
    const bytes = Buffer.from(content, 'utf8');
    const outLines: string[] = [];

    // Local destination.
    if (parsed.localPath) {
      if (!parsed.overwrite && (await fileExists(parsed.localPath))) {
        return `Refused: local file "${parsed.localPath}" already exists. Pass overwrite:true to replace it.`;
      }
      try {
        await mkdir(dirname(parsed.localPath), { recursive: true });
        await writeFile(parsed.localPath, bytes);
        outLines.push(`  local: ${parsed.localPath} (${humanSize(bytes.length)})`);
      } catch (err) {
        return `export-chat-log failed writing "${parsed.localPath}": ${(err as Error).message}`;
      }
    }

    // WebDAV destination.
    if (parsed.remotePath) {
      const clean = toDataRelative(parsed.remotePath);
      if (looksLikeWorldDbPath(clean)) return worldDbRefusal(parsed.remotePath);
      const dav = this.dav();
      if (!dav) {
        if (!parsed.localPath)
          return notConfiguredMessage('export-chat-log', this.molten.webdavUser);
        outLines.push('  (WebDAV not configured — remote copy skipped)');
      } else {
        try {
          if (!parsed.overwrite && (await dav.exists(clean))) {
            return `Refused: "Data/${clean}" already exists. Pass overwrite:true to replace it.`;
          }
          await dav.ensureParents(clean);
          await dav.putFile(clean, bytes, guessContentType(parsed.remotePath));
          outLines.push(
            `  Data/${clean}\n  public URL: ${buildPublicUrl(this.molten.serverUrl, clean)}`
          );
        } catch (err) {
          return davErrorMessage('export-chat-log', err, this.logger);
        }
      }
    }

    return `Exported ${res?.messageCount ?? 0} message(s) as ${parsed.format} →\n${outLines.join('\n')}`;
  }

  // --- dnd5e rich cards -----------------------------------------------------

  async handlePostItemCard(args: any): Promise<string> {
    try {
      const parsed = PostItemCardSchema.parse(args ?? {});
      const r = await this.foundry.call('postItemCard', parsed);
      if (r?.posted === false) return `Could not post a rich card: ${r.reason}`;
      return `Posted ${r?.action} card for "${r?.itemName}" (${r?.activityType}) as ${r?.actorName}.`;
    } catch (error) {
      if (error instanceof FormattedToolError) throw error;
      this.errorHandler.handleToolError(error, 'post-item-card', 'posting item card');
    }
  }

  async handleRequestRoll(args: any): Promise<string> {
    const parsed = RequestRollSchema.parse(args ?? {});
    const r = await this.foundry.call('requestRoll', parsed);
    return `Posted ${r?.kind} request (${r?.expression}) — players can click to roll.`;
  }
}

/** Escape a string for use in an HTML attribute. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape text content for HTML. */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build a <figure> with an embedded image (+ optional caption). */
function figureHtml(url: string, caption?: string, alt?: string): string {
  const altText = alt ?? caption ?? '';
  const cap = caption ? `<figcaption>${escapeText(caption)}</figcaption>` : '';
  return `<figure><img src="${escapeAttr(url)}" alt="${escapeAttr(altText)}">${cap}</figure>`;
}

/** True if a local path exists (used for the overwrite guard). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
