// Pure typed-block journal renderer — string/data in, HTML out, no Foundry / logger / IO.
//
// This is the STRUCTURING half of the journal building block (design.md §2.1 / §5): the skill supplies
// the WORDS as typed blocks, this renderer arranges + styles them into the `.mcp-journal` house look
// ("Lost Mine of Phandelver"). It NEVER invents prose — every `text`/`html`/`items` value is the
// caller's. It replaces the deleted quest prose generators (quest/quest-content.ts), which fabricated
// read-aloud text / NPC dialogue / hooks inside the tool layer (Invariant 1 violation).
//
// `blockSchema` (zod) is the single source of truth for the block contract; the journal tools import it
// for their `pages[].blocks` input, and `Block` is its inferred type.

import { z } from 'zod';

/** The `.mcp-journal` house stylesheet (moved verbatim from the former createStyledJournal). */
export const MCP_JOURNAL_CSS = [
  '.mcp-journal { --ink:#222; --muted:#666; --paper:#f8f5f2; --gm:#f2f2f2; --accent:#b33; --rule:#ddd; font-size:14px; line-height:1.6; color:var(--ink); }',
  '.mcp-journal .wrap { max-width: 980px; margin: 0 auto; padding: 8px 12px 24px; }',
  '.mcp-journal h1 { font-size: 28px; letter-spacing: .5px; text-align: center; margin: 8px 0 6px; }',
  '.mcp-journal .orn { height: 10px; border: 0; border-top: 2px solid var(--rule); margin: 8px auto 16px; width: 60%; }',
  '.mcp-journal h2 { font-size: 20px; margin: 18px 0 6px; }',
  '.mcp-journal h3 { font-size: 16px; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .04em; }',
  '.mcp-journal p.lead { font-size: 15px; color: var(--muted); margin: 0 0 10px; }',
  '.mcp-journal .readaloud { background: var(--paper); border-left: 4px solid var(--accent); padding: 10px 12px; margin: 12px 0; }',
  '.mcp-journal .gmnote { background: var(--gm); border-left: 4px solid #444; padding: 10px 12px; margin: 12px 0; }',
  '.mcp-journal ul { margin: 6px 0 10px 18px; }',
  '.mcp-journal .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px 24px; }',
  '.mcp-journal img { max-width: 100%; height: auto; border-radius: 2px; }',
  '.mcp-journal .meta { font-size: 12px; color: var(--muted); margin: 4px 0 12px; }',
  '.mcp-journal table { border-collapse: collapse; width: 100%; }',
  '.mcp-journal table th, .mcp-journal table td { border-bottom: 1px solid var(--rule); padding: 6px 4px; text-align: left; }',
  '.mcp-journal .spaced { margin-top: 14px; }',
].join(' ');

/**
 * The journal block contract. A discriminated union — each variant is a deterministic styling of
 * CALLER-SUPPLIED content (the skill's words). `grid` is intentionally NON-recursive (columns of headed
 * lists — the "Quest Details | Rewards & Status" layout) to keep the generated MCP input schema flat
 * and 2020-12-valid; `html` is the escape hatch for anything the typed blocks don't cover.
 */
export const blockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    text: z.string().min(1).describe('Heading text (plain).'),
    level: z
      .union([z.literal(2), z.literal(3)])
      .optional()
      .describe('Heading level: 2 (default, section) or 3 (subsection).'),
  }),
  z.object({
    type: z.literal('lead'),
    html: z.string().min(1).describe('Summary/intro line (muted lead paragraph).'),
  }),
  z.object({
    type: z.literal('paragraph'),
    html: z.string().min(1).describe('A body paragraph (inline HTML allowed).'),
  }),
  z.object({
    type: z.literal('readaloud'),
    html: z
      .string()
      .min(1)
      .describe('Boxed read-aloud / player-facing text. Pass <p>…</p> for multi-paragraph.'),
  }),
  z.object({
    type: z.literal('gmnote'),
    html: z.string().min(1).describe('GM-only callout box. Pass <p>…</p> for multi-paragraph.'),
  }),
  z.object({
    type: z.literal('list'),
    items: z.array(z.string().min(1)).min(1).describe('Bulleted list items (inline HTML allowed).'),
  }),
  z.object({
    type: z.literal('grid'),
    columns: z
      .array(
        z.object({
          heading: z.string().optional().describe('Optional column heading.'),
          items: z.array(z.string().min(1)).min(1).describe('Column list items.'),
        })
      )
      .min(1)
      .describe('Columns of headed lists, laid out in a 2-column grid.'),
  }),
  z.object({
    type: z.literal('html'),
    html: z.string().min(1).describe('Raw HTML escape hatch (rendered verbatim).'),
  }),
]);

export type Block = z.infer<typeof blockSchema>;

/** Defensively strip <script> from caller HTML (trusted GM tooling, but never inject script). */
function clean(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

/** Render one block to its `.mcp-journal` HTML fragment. */
export function renderBlock(block: Block): string {
  switch (block.type) {
    case 'heading':
      return block.level === 3 ? `<h3>${block.text}</h3>` : `<h2 class="spaced">${block.text}</h2>`;
    case 'lead':
      return `<p class="lead">${clean(block.html)}</p>`;
    case 'paragraph':
      return `<p>${clean(block.html)}</p>`;
    case 'readaloud':
      return `<div class="readaloud">${clean(block.html)}</div>`;
    case 'gmnote':
      return `<div class="gmnote">${clean(block.html)}</div>`;
    case 'list':
      return `<ul>${block.items.map(i => `<li>${clean(i)}</li>`).join('')}</ul>`;
    case 'grid':
      return `<div class="grid-2">${block.columns
        .map(
          col =>
            `<div>${col.heading ? `<h3>${col.heading}</h3>` : ''}<ul>${col.items
              .map(i => `<li>${clean(i)}</li>`)
              .join('')}</ul></div>`
        )
        .join('')}</div>`;
    case 'html':
      return clean(block.html);
  }
}

/** Render a list of blocks to a concatenated HTML body. */
export function renderBlocks(blocks: Block[]): string {
  return blocks.map(renderBlock).join('');
}

/**
 * Render blocks to a complete, self-contained `.mcp-journal` styled page (the `<style>` is inlined so
 * each page renders correctly on its own). This is what a journal page's `text.content` is set to.
 */
export function renderStyledHtml(blocks: Block[]): string {
  return `<section class="mcp-journal"><style>${MCP_JOURNAL_CSS}</style><div class="wrap">${renderBlocks(
    blocks
  )}</div></section>`;
}
