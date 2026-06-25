/**
 * Offline unit tests for the pure journal block renderer (src/tools/journal/blocks.ts).
 *
 * Pins the EXACT HTML each block type produces, and proves the renderer only ever emits the CALLER's
 * words (no invented prose) — the structural counterpart to evicting quest-content.ts's prose generators.
 */

import { describe, it, expect } from 'vitest';
import { renderBlock, renderBlocks, renderStyledHtml, blockSchema, type Block } from './blocks.js';

describe('renderBlock — exact per-type HTML', () => {
  it('heading defaults to h2.spaced, level 3 -> h3', () => {
    expect(renderBlock({ type: 'heading', text: 'Objectives' })).toBe(
      '<h2 class="spaced">Objectives</h2>'
    );
    expect(renderBlock({ type: 'heading', text: 'Details', level: 3 })).toBe('<h3>Details</h3>');
  });

  it('lead / paragraph', () => {
    expect(renderBlock({ type: 'lead', html: 'A grim hook.' })).toBe(
      '<p class="lead">A grim hook.</p>'
    );
    expect(renderBlock({ type: 'paragraph', html: 'Plain body.' })).toBe('<p>Plain body.</p>');
  });

  it('readaloud / gmnote wrap in the styled boxes', () => {
    expect(renderBlock({ type: 'readaloud', html: '<p>Cold air bites.</p>' })).toBe(
      '<div class="readaloud"><p>Cold air bites.</p></div>'
    );
    expect(renderBlock({ type: 'gmnote', html: '<p>The druid is charmed.</p>' })).toBe(
      '<div class="gmnote"><p>The druid is charmed.</p></div>'
    );
  });

  it('list', () => {
    expect(renderBlock({ type: 'list', items: ['Find the druid', 'Cleanse the spring'] })).toBe(
      '<ul><li>Find the druid</li><li>Cleanse the spring</li></ul>'
    );
  });

  it('grid renders columns of headed lists', () => {
    expect(
      renderBlock({
        type: 'grid',
        columns: [
          { heading: 'Quest Details', items: ['Type: Side', 'Difficulty: Hard'] },
          { heading: 'Rewards', items: ['200 gp'] },
        ],
      })
    ).toBe(
      '<div class="grid-2">' +
        '<div><h3>Quest Details</h3><ul><li>Type: Side</li><li>Difficulty: Hard</li></ul></div>' +
        '<div><h3>Rewards</h3><ul><li>200 gp</li></ul></div>' +
        '</div>'
    );
  });

  it('html escape hatch is verbatim', () => {
    expect(renderBlock({ type: 'html', html: '<table><tr><td>x</td></tr></table>' })).toBe(
      '<table><tr><td>x</td></tr></table>'
    );
  });

  it('strips <script> from caller HTML defensively', () => {
    expect(renderBlock({ type: 'paragraph', html: 'safe<script>alert(1)</script> text' })).toBe(
      '<p>safe text</p>'
    );
  });
});

describe('renderBlocks / renderStyledHtml', () => {
  it('concatenates blocks in order', () => {
    const blocks: Block[] = [
      { type: 'heading', text: 'Hook' },
      { type: 'paragraph', html: 'Body.' },
    ];
    expect(renderBlocks(blocks)).toBe('<h2 class="spaced">Hook</h2><p>Body.</p>');
  });

  it('wraps in the self-contained .mcp-journal section with inlined CSS', () => {
    const html = renderStyledHtml([{ type: 'readaloud', html: '<p>Boxed.</p>' }]);
    expect(html.startsWith('<section class="mcp-journal"><style>')).toBe(true);
    expect(html).toContain('.mcp-journal .readaloud {'); // CSS present
    expect(html).toContain('<div class="wrap"><div class="readaloud"><p>Boxed.</p></div></div>');
    expect(html.endsWith('</section>')).toBe(true);
  });

  it('emits ONLY caller words — never invents prose', () => {
    // Sentinel words that the deleted quest generators used to fabricate.
    const html = renderStyledHtml([
      { type: 'readaloud', html: '<p>OnlyMyWords</p>' },
      { type: 'list', items: ['DoThisThing'] },
    ]);
    expect(html).toContain('OnlyMyWords');
    expect(html).toContain('DoThisThing');
    for (const fabricated of [
      'approaches the party',
      'urgent news',
      'blight is spreading',
      'Report back',
      'innocent people are at risk',
    ]) {
      expect(html).not.toContain(fabricated);
    }
  });
});

describe('blockSchema', () => {
  it('accepts a valid discriminated block and rejects an unknown type / empty content', () => {
    expect(blockSchema.safeParse({ type: 'list', items: ['a'] }).success).toBe(true);
    expect(blockSchema.safeParse({ type: 'bogus', html: 'x' }).success).toBe(false);
    expect(blockSchema.safeParse({ type: 'paragraph', html: '' }).success).toBe(false);
  });
});
