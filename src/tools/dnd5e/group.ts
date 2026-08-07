import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { assertDnd5e } from '../../utils/system-detection.js';
import { toInputSchema } from '../../utils/schema.js';

/**
 * dnd5e GROUP actors (type:"group") — the shared party stash / travel group.
 * - create-group: create the group, enroll members (system.addMember), default ownership,
 *   optionally crown it the world's primary party — one call builds the whole stash.
 * - manage-group-members: add/remove members later, per-actor outcomes.
 * - get-group: the group-shaped read (members, shared currency, shared inventory, ownership,
 *   primary-party flag) — get-actor's character-shaped read returns an empty husk for groups.
 * - set-primary-party: read/set/clear the dnd5e primaryParty world setting.
 *
 * The page layer (src/page/dnd5e/group.ts) owns correctness: fuzzy resolution, the system
 * addMember/removeMember API with pre-classified outcomes, fail-closed create validation, and
 * the {actor: id} setting shape. Note dnd5e 5.3.3 has NO party/encounter subtype field on
 * GroupData, so none is advertised.
 *
 * Shared inventory/currency WRITES ride the existing paths (add-item / import-item items,
 * update-actor currency) — these tools own the group's shape, not a parallel item pipeline.
 */

const CoinSchema = z.number().int().min(0);

const CreateGroupSchema = z.object({
  name: z.string().min(1).describe('Name of the group actor, e.g. "The Party".'),
  members: z
    .array(z.string().min(1))
    .default([])
    .describe(
      'World actors to enroll (name or id; partial name match supported). FAIL-CLOSED: a member ' +
        'that does not resolve, or is itself a group, rejects the whole create — nothing is made.'
    ),
  description: z
    .string()
    .optional()
    .describe('Full description (HTML allowed) shown on the group sheet.'),
  summary: z.string().optional().describe('One-line summary shown in group embeds.'),
  img: z
    .string()
    .optional()
    .describe(
      'Portrait image path under Data/ or URL. A path that does not resolve on the server is ' +
        'dropped (dnd5e stamps its default group art) with a warning.'
    ),
  folderName: z
    .string()
    .optional()
    .describe('Actor-sidebar folder to file the group under (created if missing).'),
  defaultOwnership: z
    .enum(['none', 'limited', 'observer', 'owner'])
    .optional()
    .describe(
      "The document's DEFAULT ownership — what every player gets. 'owner' is the shared party " +
        'stash: all players can open it and move items. Per-user grants: set-actor-ownership.'
    ),
  currency: z
    .object({
      pp: CoinSchema.optional(),
      gp: CoinSchema.optional(),
      ep: CoinSchema.optional(),
      sp: CoinSchema.optional(),
      cp: CoinSchema.optional(),
    })
    .optional()
    .describe('Starting shared coin (whole non-negative amounts per denomination).'),
  makePrimaryParty: z
    .boolean()
    .default(false)
    .describe(
      "Also point the world's dnd5e primaryParty setting at this new group (the party shown " +
        'in the players sidebar; XP awards and party overviews target it).'
    ),
});

const ManageGroupMembersSchema = z
  .object({
    groupIdentifier: z
      .string()
      .min(1)
      .describe('The group actor to edit (name or id; partial name match supported).'),
    add: z
      .array(z.string().min(1))
      .default([])
      .describe('World actors to enroll (name or id). Already-members are skipped and reported.'),
    remove: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'Members to remove (name or id — a raw member id also works when the underlying actor ' +
          'was deleted). Non-members are skipped and reported.'
      ),
  })
  .refine(a => a.add.length > 0 || a.remove.length > 0, {
    message: 'pass at least one actor in add or remove',
  });

const GetGroupSchema = z.object({
  groupIdentifier: z
    .string()
    .min(1)
    .describe('The group actor to read (name or id; partial name match supported).'),
});

const SetPrimaryPartySchema = z
  .object({
    groupIdentifier: z
      .string()
      .min(1)
      .optional()
      .describe('Group actor to crown as the primary party (name or id).'),
    clear: z.boolean().default(false).describe('Unset the primary party instead.'),
  })
  .refine(a => !(a.groupIdentifier && a.clear), {
    message: 'pass groupIdentifier OR clear, not both',
  });

export interface DnD5eGroupToolsOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class DnD5eGroupTools {
  private foundry: FoundryBridge;
  private logger: Logger;

  constructor({ foundry, logger }: DnD5eGroupToolsOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eGroupTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-group',
        description:
          'Create a dnd5e GROUP actor (type:group) — the shared party stash / travel group. ' +
          'Enrolls world actors as members, can grant every player default ownership ' +
          "(defaultOwnership:'owner' = the classic shared stash), seed shared coin, and " +
          "optionally crown it the world's PRIMARY PARTY. Member resolution is fail-closed: " +
          'one bad name and nothing is created. Stock the inventory afterwards with ' +
          'add-item / import-item against the group.',
        inputSchema: toInputSchema(CreateGroupSchema),
      },
      {
        name: 'manage-group-members',
        description:
          'Add and/or remove members on an existing dnd5e group actor. Uses the system ' +
          'addMember/removeMember API; every requested actor gets a reported outcome ' +
          '(added / removed / skipped with reason) and the final roster is echoed back.',
        inputSchema: toInputSchema(ManageGroupMembersSchema),
      },
      {
        name: 'get-group',
        description:
          'Read a dnd5e group actor the group-shaped way: member roster (with dangling ids ' +
          'flagged), shared currency, shared inventory, ownership (default + per-user), and ' +
          'whether it is the primary party. Use this instead of get-actor for type:group.',
        inputSchema: toInputSchema(GetGroupSchema),
      },
      {
        name: 'set-primary-party',
        description:
          "Read or change the world's dnd5e PRIMARY PARTY (the group shown in the players " +
          'sidebar; XP awards and party overviews target it). No arguments → report the ' +
          'current primary party. groupIdentifier → point it at that group. clear:true → unset.',
        inputSchema: toInputSchema(SetPrimaryPartySchema),
      },
    ];
  }

  async handleCreateGroup(args: any): Promise<string> {
    const parsed = CreateGroupSchema.parse(args ?? {});
    await assertDnd5e(this.foundry, this.logger, 'create-group');
    const r = await this.foundry.call('createGroupActor', parsed);

    const lines = [
      `✅ Created group **${r.group.name}** (\`${r.group.id}\`)`,
      `- **Members:** ${formatRoster(r.members)}`,
      `- **Default ownership:** ${r.group.defaultOwnership}`,
    ];
    if (r.group.folderId) lines.push(`- **Folder:** \`${r.group.folderId}\``);
    if (r.primaryParty) {
      lines.push(
        `- **Primary party:** now this group${
          r.primaryParty.previous ? ` (was ${r.primaryParty.previous.name})` : ''
        }`
      );
    }
    for (const w of r.warnings ?? []) lines.push(`⚠️ ${w}`);
    return lines.join('\n');
  }

  async handleManageGroupMembers(args: any): Promise<string> {
    const parsed = ManageGroupMembersSchema.parse(args ?? {});
    await assertDnd5e(this.foundry, this.logger, 'manage-group-members');
    const r = await this.foundry.call('manageGroupMembers', parsed);

    const lines = [`✅ **${r.group.name}** membership updated`];
    if (r.added.length) {
      lines.push(`- **Added:** ${r.added.map((a: any) => a.name).join(', ')}`);
    }
    if (r.removed.length) {
      lines.push(`- **Removed:** ${r.removed.map((a: any) => a.name ?? `\`${a.id}\``).join(', ')}`);
    }
    for (const s of r.skipped ?? []) {
      lines.push(`- ⚠️ Skipped "${s.identifier}" — ${s.reason}`);
    }
    lines.push(`- **Roster now:** ${formatRoster(r.members)}`);
    return lines.join('\n');
  }

  async handleGetGroup(args: any): Promise<unknown> {
    const parsed = GetGroupSchema.parse(args ?? {});
    await assertDnd5e(this.foundry, this.logger, 'get-group');
    return this.foundry.call('getGroupInfo', parsed);
  }

  async handleSetPrimaryParty(args: any): Promise<string> {
    const parsed = SetPrimaryPartySchema.parse(args ?? {});
    await assertDnd5e(this.foundry, this.logger, 'set-primary-party');
    const r = await this.foundry.call('configurePrimaryParty', parsed);

    const show = (p: { id: string; name: string } | null) =>
      p ? `**${p.name}** (\`${p.id}\`)` : '(none)';
    if (!r.changed) {
      const requested = parsed.groupIdentifier !== undefined || parsed.clear;
      return requested
        ? `✅ Already set — primary party is ${show(r.current)}.`
        : `**Primary party:** ${show(r.current)}`;
    }
    return `✅ Primary party: ${show(r.previous)} → ${show(r.current)}`;
  }
}

function formatRoster(members: Array<{ id: string; name: string | null }>): string {
  if (!members.length) return '(none)';
  return members.map(m => m.name ?? `\`${m.id}\` (dangling)`).join(', ');
}
