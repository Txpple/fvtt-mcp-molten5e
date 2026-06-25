import { z } from 'zod';

/**
 * Single source of truth → advertised contract.
 *
 * Every MCP tool's input contract used to be hand-written twice: once as a JSON Schema in the
 * tool's getToolDefinitions() and again as a zod schema inside the handler. The two drifted
 * silently (e.g. search-compendium-creatures advertised default:500 but enforced 100). This
 * collapses the duplication: each tool declares its contract ONCE as a zod schema (used by the
 * handler to parse/validate), and this helper derives the advertised JSON Schema from that same
 * schema — so the advertised and enforced contracts cannot diverge.
 *
 * Options chosen deliberately:
 * - `io: 'input'` — describe what callers may SEND. Fields with `.default()` stay optional
 *   (not forced into `required`), and coercion/transform unions advertise their INPUT side.
 * - `target: 'draft-2020-12'` — the dialect the Anthropic API validates each tool `input_schema`
 *   against. It rejects the ENTIRE request (HTTP 400 `tools.N.custom.input_schema ... must match
 *   JSON Schema draft 2020-12`) if any advertised schema is invalid 2020-12 — which silently
 *   bricks a session the moment the offending tool enters the tool list. The earlier `draft-7`
 *   target looked fine for most tools but emitted the draft-7 tuple shape (`items: [schemaA,
 *   schemaB]` + `additionalItems`) for `z.tuple(...)`, which is invalid under 2020-12 (tuples use
 *   `prefixItems`) — that bricked a live session via create-rolltable's `range` tuple. Generating
 *   2020-12 directly keeps the advertised dialect identical to the one Claude validates.
 *   (schema.test.ts + registry.test.ts guard every tool against a 2020-12-invalid construct.)
 * - `unrepresentable: 'any'` — never throw at module-load time on an exotic `.refine()`/`.transform()`;
 *   emit a permissive node instead.
 *
 * The emitted `$schema` is stripped (MCP carries the dialect out-of-band, and the hand-written
 * definitions never included it), and `required` is normalised to always be an array — matching
 * the previous definitions and the expectations baked into the tool tests.
 */
export function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  delete json.$schema;
  stripIntSentinels(json);
  if (!Array.isArray(json.required)) json.required = [];
  if (typeof json.properties !== 'object' || json.properties === null) json.properties = {};

  return json;
}

// zod's `.int()` emits the JS safe-integer range as explicit min/max bounds. They convey no real
// constraint and just clutter the advertised schema, so drop them wherever they appear.
function stripIntSentinels(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) stripIntSentinels(child);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.maximum === Number.MAX_SAFE_INTEGER) delete obj.maximum;
    if (obj.minimum === -Number.MAX_SAFE_INTEGER) delete obj.minimum;
    for (const key of Object.keys(obj)) stripIntSentinels(obj[key]);
  }
}
