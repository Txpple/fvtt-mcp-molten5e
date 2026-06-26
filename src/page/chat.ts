// Page-side: chat-log reads + writes. Runs INSIDE the headless Foundry page.
//
// Posts/lists/deletes ChatMessage documents and builds export transcripts. Reaches ChatMessage /
// CONST / foundry.applications.ux.TextEditor off the page globals (collections.ts pattern; they are
// not declared in foundry-globals.d.ts). Pure logic (visibility mapping, record/transcript building,
// roll-request tokens) lives in chat-helpers.ts and is unit-tested offline. The bridge is always a
// ready GM, so all five visibility modes are reachable. No rollback; best-effort writes.
//
// Version-grounded for Foundry 14.364 / dnd5e 5.3.3:
//  - presentation = `style` (CONST.CHAT_MESSAGE_STYLES, by NAME), NOT the doc-subtype `type`;
//  - whisper-ness derives from the `whisper` id array (no WHISPER style); set whisper+blind
//    explicitly and pass NO rollMode so explicit recipients are respected;
//  - enrichHTML is async + namespaced (foundry.applications.ux.TextEditor.implementation);
//  - clear-all = deleteDocuments([], {deleteAll:true}); NEVER game.messages.flush() (blocking dialog);
//  - export builds the string in-page (never game.messages.export() — uncapturable browser download);
//  - rich dnd5e cards come from the Activity system (use/rollAttack/rollDamage), the only path whose
//    buttons rebind through the system's own listeners.

import { resolveActorFuzzy, MCP_FLAG_SCOPE } from './_shared.js';
import {
  buildMessageVisibility,
  toMessageRecord,
  buildMarkdownTranscript,
  buildHtmlTranscript,
  buildPlaintextTranscript,
  buildRollRequestExpression,
  type RawMessageFields,
  type Visibility,
  type StyleName,
} from './chat-helpers.js';

const CONST_: any = (globalThis as any).CONST;

// File extension per transcript format. Inlined (not imported from utils/transcript.ts) so the
// page bundle stays browser-only — transcript.ts pulls in node:path for the Node-side validator.
const FORMAT_EXT: Record<'markdown' | 'html' | 'json' | 'plaintext', string> = {
  markdown: 'md',
  html: 'html',
  json: 'json',
  plaintext: 'txt',
};

/** The configured ChatMessage document class (falls back to the global). */
function chatMessageClass(): any {
  return game.messages?.documentClass ?? (globalThis as any).ChatMessage;
}

/** Strip HTML to plain text using a detached element (browser-only). */
function stripHtml(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = html ?? '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Enrich content HTML (resolve @UUID links + inline rolls). Async + namespaced on v13/v14. */
async function enrich(content: string, relativeTo?: any): Promise<string> {
  const TE = (globalThis as any).foundry?.applications?.ux?.TextEditor;
  const impl = TE?.implementation ?? TE;
  if (!impl?.enrichHTML) return content;
  const opts: any = { rolls: true, documents: true, secrets: !!game.user?.isGM };
  if (relativeTo) opts.relativeTo = relativeTo;
  return await impl.enrichHTML(content, opts);
}

/** Extract the canonical per-message fields for listing/export. */
function rawFields(m: any): RawMessageFields {
  const authorId = typeof m.author === 'string' ? m.author : (m.author?.id ?? '');
  const authorName =
    (typeof m.author === 'object' ? m.author?.name : undefined) ??
    game.users?.get(authorId)?.name ??
    '';
  const whisper = Array.isArray(m.whisper)
    ? m.whisper.map((w: any) => (typeof w === 'string' ? w : (w?.id ?? '')))
    : [];
  // Build roll records without explicit-undefined keys (exactOptionalPropertyTypes).
  const rolls = Array.isArray(m.rolls)
    ? m.rolls.map((r: any) => {
        const o: { total?: number; formula?: string } = {};
        if (typeof r?.total === 'number') o.total = r.total;
        const f = r?.formula ?? r?._formula;
        if (typeof f === 'string') o.formula = f;
        return o;
      })
    : [];
  return {
    id: m.id ?? '',
    author: authorId,
    authorName,
    alias: m.speaker?.alias ?? m.alias ?? '',
    timestamp: m.timestamp ?? 0,
    style: m.style ?? 0,
    content: m.content ?? '',
    flavor: m.flavor ?? '',
    whisper,
    blind: !!m.blind,
    isRoll: !!m.isRoll,
    rolls,
  };
}

// --- send -------------------------------------------------------------------

export async function postChatMessage(args: {
  content: string;
  visibility?: Visibility;
  speakerActor?: string;
  flavor?: string;
  style?: StyleName;
  enrich?: boolean;
}): Promise<unknown> {
  if (!args?.content || typeof args.content !== 'string') {
    throw new Error('content is required and must be a non-empty string');
  }
  const Cls = chatMessageClass();
  const visibility: Visibility = args.visibility ?? 'public';

  let actorDoc: any;
  let speaker: any;
  if (args.speakerActor) {
    actorDoc = resolveActorFuzzy(args.speakerActor);
    if (!actorDoc) throw new Error(`speakerActor "${args.speakerActor}" not found`);
    speaker = Cls.getSpeaker({ actor: actorDoc });
  } else {
    speaker = Cls.getSpeaker();
  }
  const alias = speaker?.alias ?? actorDoc?.name ?? game.user?.name ?? '';

  const gmIds = Cls.getWhisperRecipients('GM').map((u: any) => u.id);
  const { whisper, blind, style } = buildMessageVisibility({
    visibility,
    styleName: args.style,
    hasSpeaker: !!actorDoc,
    styleConst: CONST_?.CHAT_MESSAGE_STYLES ?? {},
    gmIds,
    selfUserId: game.user?.id ?? '',
  });

  let content = args.content;
  if (args.enrich !== false) content = await enrich(content, actorDoc);

  const data: any = {
    content,
    speaker,
    whisper,
    blind,
    style,
    flags: { [MCP_FLAG_SCOPE]: { mcp: { tool: 'send-chat-message' } } },
  };
  if (args.flavor) data.flavor = args.flavor;

  const msg = await Cls.create(data);
  return { success: true, id: msg?.id, alias, visibility, whisperCount: whisper.length };
}

// --- list -------------------------------------------------------------------

export function listChatMessages(args: {
  limit?: number;
  sinceTimestamp?: number;
  contentMode?: 'html' | 'text' | 'none';
}): unknown {
  const limit = args?.limit ?? 50;
  const contentMode = args?.contentMode ?? 'text';
  let msgs = (game.messages?.contents ?? [])
    .slice()
    .sort((a: any, b: any) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  if (args?.sinceTimestamp !== undefined) {
    msgs = msgs.filter((m: any) => (m.timestamp ?? 0) >= args.sinceTimestamp!);
  }
  msgs = msgs.slice(-limit);
  const messages = msgs.map((m: any) =>
    toMessageRecord(rawFields(m), { contentMode, stripFn: stripHtml })
  );
  return { count: messages.length, messages };
}

// --- delete -----------------------------------------------------------------

export async function deleteChatMessages(args: {
  ids?: string[];
  beforeTimestamp?: number;
  clearAll?: boolean;
  confirm?: boolean;
}): Promise<unknown> {
  const Cls = chatMessageClass();

  // Precedence: clearAll > beforeTimestamp > ids.
  if (args?.clearAll) {
    if (!args.confirm) {
      return { success: false, refused: true, reason: 'clearAll requires confirm:true' };
    }
    const count = game.messages?.contents?.length ?? 0;
    await Cls.deleteDocuments([], { deleteAll: true });
    return { success: true, deletedCount: count, deleted: [], clearedAll: true };
  }

  let targets: any[];
  let notFound: string[] | undefined;
  if (args?.beforeTimestamp !== undefined) {
    // beforeTimestamp is destructive at scale (it deletes EVERY message older than the cutoff —
    // beforeTimestamp:Date.now() wipes the whole log), so gate it like clearAll, not like a targeted
    // id delete.
    if (!args.confirm) {
      return {
        success: false,
        refused: true,
        reason:
          'beforeTimestamp requires confirm:true (it deletes every message older than the cutoff)',
      };
    }
    const cutoff = args.beforeTimestamp;
    targets = (game.messages?.contents ?? []).filter((m: any) => (m.timestamp ?? 0) < cutoff);
  } else if (Array.isArray(args?.ids) && args.ids.length > 0) {
    targets = [];
    const missing: string[] = [];
    for (const id of args.ids) {
      const m = game.messages?.get(id);
      if (m) targets.push(m);
      else missing.push(id);
    }
    if (missing.length > 0) notFound = missing;
  } else {
    throw new Error('Provide ids, beforeTimestamp, or clearAll.');
  }

  const deleted = targets.map((m: any) => ({ id: m.id, name: m.speaker?.alias ?? m.alias ?? '' }));
  const ids = targets.map((m: any) => m.id);
  // One bulk DB op, chunked for very large logs.
  for (let i = 0; i < ids.length; i += 500) {
    await Cls.deleteDocuments(ids.slice(i, i + 500));
  }
  return {
    success: true,
    deletedCount: ids.length,
    deleted,
    ...(notFound ? { notFound } : {}),
  };
}

// --- export -----------------------------------------------------------------

export function exportChatLog(args: {
  format?: 'markdown' | 'html' | 'json' | 'plaintext';
  limit?: number;
  sinceTimestamp?: number;
}): unknown {
  const format = args?.format ?? 'markdown';
  let msgs = (game.messages?.contents ?? [])
    .slice()
    .sort((a: any, b: any) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  if (args?.sinceTimestamp !== undefined) {
    msgs = msgs.filter((m: any) => (m.timestamp ?? 0) >= args.sinceTimestamp!);
  }
  if (args?.limit) msgs = msgs.slice(-args.limit);

  const contentMode = format === 'html' ? 'html' : 'text';
  const records = msgs.map((m: any) =>
    toMessageRecord(rawFields(m), { contentMode, stripFn: stripHtml })
  );

  let content: string;
  if (format === 'json') content = JSON.stringify(records, null, 2);
  else if (format === 'html') content = buildHtmlTranscript(records);
  else if (format === 'plaintext') content = buildPlaintextTranscript(records);
  else content = buildMarkdownTranscript(records);

  return {
    format,
    messageCount: records.length,
    content,
    suggestedFilename: `chat-log.${FORMAT_EXT[format]}`,
  };
}

// --- dnd5e rich cards -------------------------------------------------------

export async function postItemCard(args: {
  actor: string;
  item: string;
  activity?: string;
  action?: 'use' | 'attack' | 'damage';
  consume?: boolean;
  critical?: boolean;
}): Promise<unknown> {
  const actor = resolveActorFuzzy(args.actor);
  if (!actor) throw new Error(`actor "${args.actor}" not found`);
  const item =
    actor.items?.get(args.item) ||
    actor.items?.getName?.(args.item) ||
    actor.items?.find?.((i: any) => i.name === args.item);
  if (!item) throw new Error(`item "${args.item}" not found on actor "${actor.name}"`);

  const activities = item.system?.activities;
  const list: any[] = activities ? (activities.contents ?? Array.from(activities ?? [])) : [];
  let activity: any;
  if (args.activity) {
    activity =
      activities?.get?.(args.activity) ??
      activities?.getName?.(args.activity) ??
      list.find((a: any) => a?.id === args.activity || a?.name === args.activity);
  } else {
    activity = list[0];
  }

  if (!activity) {
    return {
      success: true,
      posted: false,
      actorName: actor.name,
      itemName: item.name,
      reason:
        'item has no activities; rich buttons require an Activity (dnd5e 5.x). ' +
        'Use send-chat-message for a plain description card.',
    };
  }

  const action = args.action ?? 'use';
  if (action === 'attack') {
    const atk = activities?.getByType?.('attack')?.[0] ?? activity;
    await atk.rollAttack?.({}, { configure: false }, { create: true });
    return {
      success: true,
      posted: true,
      actorName: actor.name,
      itemName: item.name,
      activityType: atk.type,
      action,
    };
  }
  if (action === 'damage') {
    await activity.rollDamage?.(
      { critical: { allow: !!args.critical } },
      { configure: false },
      {
        create: true,
      }
    );
    return {
      success: true,
      posted: true,
      actorName: actor.name,
      itemName: item.name,
      activityType: activity.type,
      action,
    };
  }
  // action === 'use' — the supported primary path; buttons rebind via the dnd5e listeners.
  await activity.use?.({ consume: !!args.consume }, { configure: false }, { create: true });
  return {
    success: true,
    posted: true,
    actorName: actor.name,
    itemName: item.name,
    activityType: activity.type,
    action,
  };
}

export async function requestRoll(args: {
  kind: 'save' | 'check' | 'skill';
  ability?: string;
  skill?: string;
  dc?: number;
  flavor?: string;
  visibility?: 'public' | 'gm';
}): Promise<unknown> {
  const Cls = chatMessageClass();
  const expr = buildRollRequestExpression(args.kind, args.ability, args.skill, args.dc);
  const inner = `${args.flavor ? `<strong>${args.flavor}:</strong> ` : ''}${expr}`;
  const content = await enrich(`<p>${inner}</p>`);
  const whisper =
    args.visibility === 'gm' ? Cls.getWhisperRecipients('GM').map((u: any) => u.id) : [];
  const msg = await Cls.create({
    content,
    whisper,
    flags: { [MCP_FLAG_SCOPE]: { mcp: { tool: 'request-roll' } } },
  });
  return { success: true, id: msg?.id, kind: args.kind, expression: expr };
}
