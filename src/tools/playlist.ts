import { z } from 'zod';
import type { FoundryBridge } from '../foundry.js';
import { Logger } from '../logger.js';
import { formatDeletionResult } from '../utils/format.js';
import { toInputSchema } from '../utils/schema.js';

/**
 * Playlist tools — create/list/update/delete Foundry Playlist documents over the bridge. Split out of
 * the old AssetBridgeTools so the Node-side tool classes mirror the clean page-side domain split
 * (page/collections.ts owns playlists). Paths are Data-relative (what upload-asset returns), so an
 * uploaded track chains straight into create-playlist with no conversion — the playlist-builder skill's
 * "upload these tracks and make a tavern ambience" becomes upload-asset×N → create-playlist.
 */

// Single source of truth for each tool's input contract: the handler parses with these
// schemas and getToolDefinitions() advertises toInputSchema(...) of the same schema.
const CreatePlaylistSchema = z.object({
  name: z.string().min(1).describe('Playlist name.'),
  soundPaths: z
    .array(z.string().min(1))
    .min(1)
    .describe('Data-relative paths to the sound files, in order.'),
  mode: z
    .enum(['sequential', 'shuffle', 'simultaneous', 'soundboard', 'disabled'])
    .default('sequential')
    .describe('Playback mode (default sequential).'),
  defaultVolume: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Volume 0–1 applied to each track (default 0.5).'),
  repeat: z.boolean().default(false).describe('Whether each track loops (default false).'),
  fade: z.number().min(0).optional().describe('Crossfade duration in milliseconds (optional).'),
});

const ListPlaylistsSchema = z.object({});

const UpdatePlaylistSchema = z.object({
  identifier: z.string().min(1).describe('Playlist id or exact name.'),
  name: z.string().min(1).optional().describe('New playlist name.'),
  mode: z
    .enum(['sequential', 'shuffle', 'simultaneous', 'soundboard', 'disabled'])
    .optional()
    .describe('New playback mode.'),
  fade: z.number().min(0).optional().describe('Crossfade duration in milliseconds.'),
});

const DeletePlaylistSchema = z.object({
  identifiers: z
    .array(z.string().min(1))
    .min(1)
    .describe('Exact ids (preferred) or exact names of playlists to delete.'),
});

export interface PlaylistToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class PlaylistTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: PlaylistToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'PlaylistTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-playlist',
        description:
          'Create a Foundry Playlist from a list of Data-relative sound paths (e.g. ones just ' +
          'returned by upload-asset). Modes: sequential, shuffle, simultaneous, soundboard. GM-only.',
        inputSchema: toInputSchema(CreatePlaylistSchema),
      },
      {
        name: 'list-playlists',
        description:
          'List Playlist documents with id, name, mode, track count, and whether each is currently ' +
          'playing.',
        inputSchema: toInputSchema(ListPlaylistsSchema),
      },
      {
        name: 'update-playlist',
        description:
          "Update a Playlist's document fields: rename, change playback mode, or set the crossfade " +
          'duration. Does not add/remove tracks. GM-only.',
        inputSchema: toInputSchema(UpdatePlaylistSchema),
      },
      {
        name: 'delete-playlist',
        description:
          'Permanently delete one or more Playlist documents by exact id or exact name. STRICT ' +
          'resolution — no fuzzy/substring matching. GM-only.',
        inputSchema: toInputSchema(DeletePlaylistSchema),
      },
    ];
  }

  async handleCreatePlaylist(args: any): Promise<string> {
    const parsed = CreatePlaylistSchema.parse(args ?? {});
    const result = await this.foundry.call('createPlaylist', parsed);
    const sounds = result?.sounds ?? [];
    const lines = sounds.map((s: any) => `    - ${s.name}  (${s.path})`);
    let out =
      `Created playlist "${result?.playlistName}" (${result?.playlistId}) — mode ${result?.mode}, ` +
      `${result?.soundCount} track(s):\n${lines.join('\n')}`;
    const warns = Array.isArray(result?.warnings) ? result.warnings : [];
    if (warns.length) {
      out += `\n\n⚠️ ${warns.length} warning(s):\n${warns.map((w: string) => `- ${w}`).join('\n')}`;
    }
    return out;
  }

  async handleListPlaylists(_args: any): Promise<string> {
    const playlists = (await this.foundry.call('listPlaylists', {})) ?? [];
    if (!Array.isArray(playlists) || playlists.length === 0) return 'No playlists found.';
    const lines = playlists.map(
      (p: any) =>
        `  - "${p.name}" (${p.id}) — mode ${p.mode}, ${p.soundCount} track(s)${p.playing ? ' [playing]' : ''}`
    );
    return `Playlists (${playlists.length}):\n${lines.join('\n')}`;
  }

  async handleUpdatePlaylist(args: any): Promise<string> {
    const parsed = UpdatePlaylistSchema.parse(args ?? {});
    const result = await this.foundry.call('updatePlaylist', parsed);
    if (result?.updated === false) {
      return `Playlist not found: "${result?.notFound ?? parsed.identifier}". Nothing changed.`;
    }
    return `Updated playlist "${result?.playlistName}" (${result?.playlistId}).`;
  }

  async handleDeletePlaylist(args: any): Promise<string> {
    const { identifiers } = DeletePlaylistSchema.parse(args ?? {});
    const result = await this.foundry.call('deletePlaylists', { identifiers });
    return formatDeletionResult(result, 'playlist(s)');
  }
}
