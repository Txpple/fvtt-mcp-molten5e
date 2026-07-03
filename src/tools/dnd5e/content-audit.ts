import { z } from 'zod';
import type { FoundryBridge } from '../../foundry.js';
import { Logger } from '../../logger.js';
import { ErrorHandler } from '../../utils/error-handler.js';
import { assertDnd5e } from '../../utils/system-detection.js';
import { toInputSchema } from '../../utils/schema.js';

/**
 * content-audit — the finishing-check safety net for authoring rules 7/8/9/12. A read-only scan the
 * skill runs BEFORE declaring a build "done": it flags placeholder icons (rule 8), GM-fudge /
 * pretend-reskin language in descriptions/biographies (rule 7), magic items on an NPC with no world-Item
 * loot twin (rule 9), and GM-note / spoiler leaks in a player-visible item description (rule 12) —
 * catching violations no matter which handler or hand edit produced them. The page layer (auditContent)
 * owns the gathering + the pure scanners.
 */
const ContentAuditSchema = z.object({
  actorIdentifiers: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Actors to audit (name or id) — each is scanned along with its embedded items/features. ' +
        'Pass the NPCs you just built.'
    ),
  itemFolders: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'World-Item folders to audit (name or id) — e.g. the loot/treasure folder you created.'
    ),
  worldItemIds: z
    .array(z.string().min(1))
    .optional()
    .describe('Specific world Items to audit, by id.'),
});

export interface DnD5eContentAuditToolOptions {
  foundry: FoundryBridge;
  logger: Logger;
}

export class DnD5eContentAuditTool {
  private foundry: FoundryBridge;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundry, logger }: DnD5eContentAuditToolOptions) {
    this.foundry = foundry;
    this.logger = logger.child({ component: 'DnD5eContentAuditTool' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'content-audit',
        description:
          '[D&D 5e only] Finishing check for authored content — scan documents for the four strict ' +
          'authoring-quality rules and report violations to fix (read-only; never mutates):\n' +
          '• rule 8 — placeholder icons (icons/svg/...) on an actor, item, or authored feature.\n' +
          '• rule 7 — GM-fudge / pretend-reskin language in a description or biography ("treat its X ' +
          'as Y", "reflavor", "deals necrotic in place of bludgeoning", "pretend", "is really <type>").\n' +
          '• rule 9 — a magic item on an NPC with no matching world-Item loot twin.\n' +
          '• rule 12 — a GM-note / spoiler leaked into a PLAYER-VISIBLE item description ("GM:" asides, ' +
          '"the DM", "fill in the …", "ready-made hook", "to suit your table"). Item descriptions only — ' +
          'an NPC biography is GM-facing, so it is not scanned for this.\n\n' +
          'RUN THIS before declaring a build done. Target what you built: actorIdentifiers (NPCs, with ' +
          'their gear/features), itemFolders (your loot folder), and/or worldItemIds. With NO target it ' +
          'runs a full sweep of every NPC + every world Item. Fix each finding (set a real icon via ' +
          'update-actor-item/update-item/set-actor-art; replace fudge with real mechanics; mint the ' +
          'missing loot copy; rewrite the item description to innocuous in-world flavor and move the GM ' +
          'note to a GM-only journal) then re-run until clean.',
        inputSchema: toInputSchema(ContentAuditSchema),
      },
    ];
  }

  async handleContentAudit(args: any): Promise<any> {
    const parsed = ContentAuditSchema.parse(args ?? {});
    this.logger.info('Auditing authored content', {
      actors: parsed.actorIdentifiers?.length ?? 0,
      folders: parsed.itemFolders?.length ?? 0,
      worldItems: parsed.worldItemIds?.length ?? 0,
    });

    try {
      await assertDnd5e(this.foundry, this.logger, 'content-audit');
      const result = await this.foundry.call('auditContent', parsed);
      return this.formatResponse(result);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'content-audit', 'content audit');
    }
  }

  private formatResponse(result: any): any {
    const findings: any[] = result?.findings ?? [];
    const c = result?.counts ?? {};
    const where = (f: any) => (f.owner ? `${f.owner} → ${f.name}` : f.name);

    let body: string;
    if (findings.length === 0) {
      body = `✅ No rule 7/8/9/12 violations found (${result?.scope}). Scanned ${result?.scanned?.actors ?? 0} actor(s) + ${result?.scanned?.worldItems ?? 0} world item(s).`;
    } else {
      const groups: Array<[number, string, string]> = [
        [8, 'icons/svg', '🖼️ Rule 8 — placeholder icons (set a real compendium icon)'],
        [7, 'fudge', '🎭 Rule 7 — GM-fudge / pretend-reskin (use real mechanics instead)'],
        [9, 'loot', '💰 Rule 9 — NPC magic with no loot twin (mint a world Item)'],
        [
          12,
          'gm-leak',
          '🤫 Rule 12 — GM note / spoiler in a player-visible description (rewrite innocuous; move the note to a GM-only journal)',
        ],
      ];
      const sections = groups
        .map(([rule, , heading]) => {
          const rows = findings.filter(f => f.rule === rule);
          if (rows.length === 0) return null;
          return `**${heading}** (${rows.length})\n${rows
            .map(f => `- ${where(f)} (${f.docType} \`${f.id}\`) — ${f.detail}`)
            .join('\n')}`;
        })
        .filter(Boolean);
      body =
        `⚠️ Found ${findings.length} issue(s) — fix and re-run content-audit.\n\n` +
        sections.join('\n\n');
    }

    return {
      success: true,
      ok: result?.ok ?? findings.length === 0,
      counts: c,
      findings,
      scanned: result?.scanned,
      ...(result?.notFound ? { notFound: result.notFound } : {}),
      message: body,
    };
  }
}
