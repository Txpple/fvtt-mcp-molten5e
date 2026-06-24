// Pure, Foundry-free helpers for the chat tools. Browser-safe (no Node) AND testable offline
// (no game/CONST/document) — the DOM-dependent work (HTML→text strip) is injected as a callback.
// Unit-tested in chat-helpers.test.ts; the in-browser glue lives in src/page/chat.ts.

export type Visibility = 'public' | 'gm' | 'blind' | 'self';
export type StyleName = 'ooc' | 'ic' | 'emote' | 'other';

/** Resolve the presentation style name: explicit wins, else IC when there's a speaker, else OOC. */
export function resolveStyleName(styleName: StyleName | undefined, hasSpeaker: boolean): StyleName {
  if (styleName) return styleName;
  return hasSpeaker ? 'ic' : 'ooc';
}

export interface VisibilityInput {
  visibility: Visibility;
  // `| undefined` is explicit so callers may pass an unset style under exactOptionalPropertyTypes.
  styleName?: StyleName | undefined;
  hasSpeaker: boolean;
  /** Injected CONST.CHAT_MESSAGE_STYLES (name → integer). Looked up by NAME, never hardcoded. */
  styleConst: Record<string, number>;
  gmIds: string[];
  selfUserId: string;
}

export interface VisibilityParts {
  whisper: string[];
  blind: boolean;
  style: number;
}

/**
 * Map the five visibility modes (+ style) to the ChatMessage data fields that control who sees a
 * message. Speaker is built separately page-side (needs Foundry). Mode map:
 *   public → no whisper; gm → whisper GMs; blind → whisper GMs + blind; self → whisper self.
 * ("public-as-character" = public + a resolved speaker, handled by the caller.)
 */
export function buildMessageVisibility(input: VisibilityInput): VisibilityParts {
  const styleName = resolveStyleName(input.styleName, input.hasSpeaker);
  const style = input.styleConst[styleName.toUpperCase()] ?? input.styleConst.OTHER ?? 0;

  let whisper: string[] = [];
  let blind = false;
  switch (input.visibility) {
    case 'public':
      whisper = [];
      break;
    case 'gm':
      whisper = input.gmIds;
      break;
    case 'blind':
      whisper = input.gmIds;
      blind = true;
      break;
    case 'self':
      whisper = input.selfUserId ? [input.selfUserId] : [];
      break;
  }
  return { whisper, blind, style };
}

export interface RawMessageFields {
  id: string;
  author: string;
  authorName?: string;
  alias?: string;
  timestamp: number;
  style: number;
  content: string;
  flavor?: string;
  whisper: string[];
  blind: boolean;
  isRoll: boolean;
  rolls?: Array<{ total?: number; formula?: string }>;
}

export interface MessageRecord {
  id: string;
  author: string;
  authorName?: string;
  alias?: string;
  timestamp: number;
  time: string;
  style: number;
  isRoll: boolean;
  whisperCount: number;
  blind: boolean;
  content?: string;
  flavor?: string;
  rolls?: Array<{ total?: number; formula?: string }>;
}

export interface RecordOptions {
  contentMode: 'html' | 'text' | 'none';
  /** HTML→plain-text stripper (DOM-based in the browser); required for contentMode 'text'. */
  stripFn?: (html: string) => string;
}

/** Convert raw per-message fields into a flat, serializable record (canonical author/style). */
export function toMessageRecord(raw: RawMessageFields, opts: RecordOptions): MessageRecord {
  const rec: MessageRecord = {
    id: raw.id,
    author: raw.author,
    timestamp: raw.timestamp,
    time: new Date(raw.timestamp).toISOString(),
    style: raw.style,
    isRoll: raw.isRoll,
    whisperCount: raw.whisper.length,
    blind: raw.blind,
  };
  if (raw.authorName) rec.authorName = raw.authorName;
  if (raw.alias) rec.alias = raw.alias;
  if (opts.contentMode === 'html') {
    rec.content = raw.content;
  } else if (opts.contentMode === 'text') {
    rec.content = opts.stripFn ? opts.stripFn(raw.content) : raw.content;
  } // 'none' → omit content
  if (raw.flavor) rec.flavor = raw.flavor;
  if (raw.isRoll && raw.rolls && raw.rolls.length > 0) {
    rec.rolls = raw.rolls;
  }
  return rec;
}

function rollSummary(rec: MessageRecord): string {
  if (!rec.rolls || rec.rolls.length === 0) return '';
  return rec.rolls
    .map(r => [r.formula, r.total !== undefined ? `= ${r.total}` : ''].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ');
}

function speakerLabel(rec: MessageRecord): string {
  return rec.alias || rec.authorName || rec.author || 'Unknown';
}

/** Markdown transcript: a heading per message (speaker + time), flavor, content, roll totals. */
export function buildMarkdownTranscript(records: MessageRecord[]): string {
  const blocks = records.map(rec => {
    const lines = [`### ${speakerLabel(rec)} — ${rec.time}`];
    if (rec.whisperCount > 0)
      lines.push(`*(whisper to ${rec.whisperCount}${rec.blind ? ', blind' : ''})*`);
    if (rec.flavor) lines.push(`_${rec.flavor}_`);
    if (rec.content) lines.push(rec.content);
    const roll = rollSummary(rec);
    if (roll) lines.push(`**Roll:** ${roll}`);
    return lines.join('\n');
  });
  return `# Chat Log\n\n${blocks.join('\n\n---\n\n')}\n`;
}

/** Plaintext transcript: simple bracketed lines, no markup. */
export function buildPlaintextTranscript(records: MessageRecord[]): string {
  const blocks = records.map(rec => {
    const head = `[${rec.time}] ${speakerLabel(rec)}${
      rec.whisperCount > 0 ? ` (whisper${rec.blind ? ', blind' : ''})` : ''
    }`;
    const lines = [head];
    if (rec.flavor) lines.push(rec.flavor);
    if (rec.content) lines.push(rec.content);
    const roll = rollSummary(rec);
    if (roll) lines.push(`Roll: ${roll}`);
    return lines.join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * HTML transcript. Keeps each message's RAW content HTML (already Foundry-sanitized) — note this is
 * unstyled markup, NOT the rendered system card. Headers/labels are escaped.
 */
export function buildHtmlTranscript(records: MessageRecord[]): string {
  const blocks = records.map(rec => {
    const parts = [
      `<header><strong>${escapeHtml(speakerLabel(rec))}</strong> <time>${escapeHtml(rec.time)}</time>${
        rec.whisperCount > 0 ? ` <em>(whisper${rec.blind ? ', blind' : ''})</em>` : ''
      }</header>`,
    ];
    if (rec.flavor) parts.push(`<div class="flavor"><em>${escapeHtml(rec.flavor)}</em></div>`);
    if (rec.content) parts.push(`<div class="content">${rec.content}</div>`);
    const roll = rollSummary(rec);
    if (roll) parts.push(`<div class="roll"><strong>Roll:</strong> ${escapeHtml(roll)}</div>`);
    return `<article>${parts.join('')}</article>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Chat Log</title></head><body><h1>Chat Log</h1>${blocks.join(
    ''
  )}</body></html>`;
}

/**
 * Build a dnd5e inline roll-request enricher token (keyword DC form). Examples:
 *   save  → [[/save dex dc=15]]    check → [[/check wis]]    skill → [[/skill ste dc=12]]
 * The exact token spelling is byte-verified against the live world in the gated integration test;
 * if dnd5e differs, only this function changes.
 */
export function buildRollRequestExpression(
  kind: 'save' | 'check' | 'skill',
  ability?: string,
  skill?: string,
  dc?: number
): string {
  const target = (kind === 'skill' ? skill : ability) ?? '';
  const dcPart = typeof dc === 'number' ? ` dc=${dc}` : '';
  return `[[/${kind} ${target}${dcPart}]]`;
}
