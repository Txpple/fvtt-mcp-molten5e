import { describe, it, expect } from 'vitest';
import {
  resolveStyleName,
  buildMessageVisibility,
  toMessageRecord,
  buildMarkdownTranscript,
  buildHtmlTranscript,
  buildPlaintextTranscript,
  buildRollRequestExpression,
  type RawMessageFields,
} from './chat-helpers.js';

// A representative CONST.CHAT_MESSAGE_STYLES mapping. Values are looked up by NAME, so the test
// asserts name-based resolution, never a hardcoded integer ordering.
const STYLES = { OTHER: 0, IC: 1, EMOTE: 2, OOC: 3 };

describe('resolveStyleName', () => {
  it('defaults to ic with a speaker, ooc without', () => {
    expect(resolveStyleName(undefined, true)).toBe('ic');
    expect(resolveStyleName(undefined, false)).toBe('ooc');
  });
  it('honors an explicit style', () => {
    expect(resolveStyleName('emote', false)).toBe('emote');
    expect(resolveStyleName('other', true)).toBe('other');
  });
});

describe('buildMessageVisibility', () => {
  const base = { styleConst: STYLES, gmIds: ['gm1', 'gm2'], selfUserId: 'me' };

  it('public: no whisper, not blind, ooc style', () => {
    const r = buildMessageVisibility({ ...base, visibility: 'public', hasSpeaker: false });
    expect(r).toEqual({ whisper: [], blind: false, style: STYLES.OOC });
  });

  it('public-as-character: no whisper, ic style (speaker present)', () => {
    const r = buildMessageVisibility({ ...base, visibility: 'public', hasSpeaker: true });
    expect(r.whisper).toEqual([]);
    expect(r.blind).toBe(false);
    expect(r.style).toBe(STYLES.IC);
  });

  it('gm: whispers all GMs, not blind', () => {
    const r = buildMessageVisibility({ ...base, visibility: 'gm', hasSpeaker: false });
    expect(r.whisper).toEqual(['gm1', 'gm2']);
    expect(r.blind).toBe(false);
  });

  it('blind: whispers GMs AND sets blind', () => {
    const r = buildMessageVisibility({ ...base, visibility: 'blind', hasSpeaker: false });
    expect(r.whisper).toEqual(['gm1', 'gm2']);
    expect(r.blind).toBe(true);
  });

  it('self: whispers only the bridge user', () => {
    const r = buildMessageVisibility({ ...base, visibility: 'self', hasSpeaker: false });
    expect(r.whisper).toEqual(['me']);
    expect(r.blind).toBe(false);
  });

  it('explicit style overrides the speaker default', () => {
    const r = buildMessageVisibility({
      ...base,
      visibility: 'public',
      hasSpeaker: true,
      styleName: 'emote',
    });
    expect(r.style).toBe(STYLES.EMOTE);
  });

  it('falls back to OTHER for an unknown style name', () => {
    const r = buildMessageVisibility({
      ...base,
      visibility: 'public',
      hasSpeaker: false,
      styleName: 'bogus' as any, // deliberately invalid to exercise the OTHER fallback
    });
    expect(r.style).toBe(STYLES.OTHER);
  });
});

function raw(overrides: Partial<RawMessageFields> = {}): RawMessageFields {
  return {
    id: 'm1',
    author: 'u1',
    authorName: 'Gamemaster',
    alias: 'The Innkeeper',
    timestamp: 0,
    style: 1,
    content: '<p>Hello <b>there</b></p>',
    flavor: 'Greeting',
    whisper: [],
    blind: false,
    isRoll: false,
    ...overrides,
  };
}

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('toMessageRecord', () => {
  it('html mode keeps raw content', () => {
    const r = toMessageRecord(raw(), { contentMode: 'html' });
    expect(r.content).toBe('<p>Hello <b>there</b></p>');
  });
  it('text mode strips via the injected fn', () => {
    const r = toMessageRecord(raw(), { contentMode: 'text', stripFn: strip });
    expect(r.content).toBe('Hello there');
  });
  it('none mode omits content', () => {
    const r = toMessageRecord(raw(), { contentMode: 'none' });
    expect(r.content).toBeUndefined();
  });
  it('computes ISO time, whisperCount, and carries roll totals', () => {
    const r = toMessageRecord(
      raw({
        timestamp: 0,
        whisper: ['gm1', 'gm2'],
        isRoll: true,
        rolls: [{ total: 17, formula: '1d20+5' }],
      }),
      { contentMode: 'none' }
    );
    expect(r.time).toBe('1970-01-01T00:00:00.000Z');
    expect(r.whisperCount).toBe(2);
    expect(r.rolls).toEqual([{ total: 17, formula: '1d20+5' }]);
  });
  it('omits rolls for a non-roll message', () => {
    const r = toMessageRecord(raw({ isRoll: false, rolls: [{ total: 1 }] }), {
      contentMode: 'none',
    });
    expect(r.rolls).toBeUndefined();
  });
});

describe('transcript builders', () => {
  const records = [
    toMessageRecord(raw({ id: 'a', alias: 'GM', content: '<p>Doors open.</p>' }), {
      contentMode: 'text',
      stripFn: strip,
    }),
    toMessageRecord(
      raw({
        id: 'b',
        alias: 'Goblin',
        content: '<p>Attack!</p>',
        whisper: ['gm1'],
        isRoll: true,
        rolls: [{ total: 14, formula: '1d20+4' }],
      }),
      { contentMode: 'text', stripFn: strip }
    ),
  ];

  it('markdown includes headers, content, whisper marker, and roll totals', () => {
    const md = buildMarkdownTranscript(records);
    expect(md).toContain('# Chat Log');
    expect(md).toContain('### GM');
    expect(md).toContain('Doors open.');
    expect(md).toContain('whisper to 1');
    expect(md).toContain('**Roll:** 1d20+4 = 14');
  });

  it('plaintext includes bracketed time + roll line', () => {
    const txt = buildPlaintextTranscript(records);
    expect(txt).toContain('] GM');
    expect(txt).toContain('Attack!');
    expect(txt).toContain('Roll: 1d20+4 = 14');
  });

  it('html keeps content markup and escapes the header', () => {
    const recs = [
      toMessageRecord(raw({ alias: 'A & B', content: '<p>kept <b>markup</b></p>' }), {
        contentMode: 'html',
      }),
    ];
    const html = buildHtmlTranscript(recs);
    expect(html).toContain('<p>kept <b>markup</b></p>'); // content kept raw
    expect(html).toContain('A &amp; B'); // header escaped
  });
});

describe('buildRollRequestExpression', () => {
  it('save with DC (keyword form)', () => {
    expect(buildRollRequestExpression('save', 'dex', undefined, 15)).toBe('[[/save dex dc=15]]');
  });
  it('check without DC', () => {
    expect(buildRollRequestExpression('check', 'wis')).toBe('[[/check wis]]');
  });
  it('skill uses the skill key', () => {
    expect(buildRollRequestExpression('skill', undefined, 'ste', 12)).toBe('[[/skill ste dc=12]]');
  });
});
