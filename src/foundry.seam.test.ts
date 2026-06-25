/**
 * Coverage for the tool<->page seam (alignment-plan 0.4). The TYPE side —
 * `FoundryBridge.call(name: keyof PageApi)` in src/foundry.ts — already makes a wrong
 * method name a `tsc` error (caught by the gate). This test is the runtime backstop and
 * living documentation: it parses the page registration (`const api = {…}` in
 * src/page/index.ts) and asserts every `foundry.call('X')` in the source tree names a
 * registered page method, so the seam cannot silently drift (e.g. via a renamed handler
 * or a call site a future `any` cast would hide from the type checker).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url)); // .../src

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Method names registered on window.__fvtt — the `const api = { … } satisfies` block. */
function registeredMethods(): string[] {
  const src = readFileSync(join(SRC, 'page', 'index.ts'), 'utf8');
  const start = src.indexOf('const api = {');
  const end = src.indexOf('} satisfies', start);
  if (start < 0 || end < 0) throw new Error('could not locate the page `api` registration block');
  const names: string[] = [];
  for (const line of src.slice(start, end).split('\n')) {
    const m = /^\s*([a-zA-Z][\w]*)\s*,\s*$/.exec(line); // a shorthand property line
    if (m) names.push(m[1]);
  }
  return names;
}

/** Every foundry.call('name') in the source tree, excluding tests and the page side itself. */
function calledMethods(): Array<{ name: string; file: string }> {
  const re = /foundry\.call\s*(?:<[^>]*>)?\s*\(\s*['"]([a-zA-Z][\w]*)['"]/g;
  const calls: Array<{ name: string; file: string }> = [];
  for (const file of tsFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel.includes('.test.')) continue;
    if (rel.split(sep)[0] === 'page') continue; // the page side is the seam TARGET, not a caller
    for (const m of readFileSync(file, 'utf8').matchAll(re)) {
      calls.push({ name: m[1], file: rel });
    }
  }
  return calls;
}

describe('tool<->page seam', () => {
  it('registers a non-empty, duplicate-free set of page methods', () => {
    const names = registeredMethods();
    expect(names.length).toBeGreaterThan(50);
    expect(new Set(names).size).toBe(names.length); // no duplicate registrations
  });

  it("every foundry.call('name') targets a registered page method", () => {
    const registered = new Set(registeredMethods());
    const calls = calledMethods();
    expect(calls.length).toBeGreaterThan(20); // sanity: we actually scanned real call sites
    const orphans = calls.filter(c => !registered.has(c.name)).map(c => `${c.name} @ ${c.file}`);
    expect(orphans).toEqual([]);
  });
});
