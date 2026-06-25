/**
 * Shared formatting helpers for tool responses — keeps the per-tool handlers thin
 * and their human-readable output consistent.
 */

/**
 * Render a bulk-deletion result (`{ deleted: [{name,id}], deletedCount?, notFound? }`)
 * into the standard `Deleted N <noun>:` summary with bullet lines and an optional
 * `not found:` tail. `noun` is the already-pluralised label, e.g. `'scene(s)'` or
 * `` `${documentType} document(s)` ``.
 */
export function formatDeletionResult(result: any, noun: string): string {
  const deleted = result?.deleted ?? [];
  const lines = deleted.map((d: any) => `  - "${d.name}" (${d.id})`);
  const notFound =
    result?.notFound && result.notFound.length > 0
      ? `\n  not found: ${result.notFound.join(', ')}`
      : '';
  // Surface partial-progress failures (bulk-delete records, rather than aborting on, a failed
  // delete) so the user sees exactly what was removed and what couldn't be.
  const failed =
    result?.failed && result.failed.length > 0
      ? `\n  failed: ${result.failed.map((f: any) => `"${f.name}" (${f.error})`).join(', ')}`
      : '';
  return `Deleted ${result?.deletedCount ?? deleted.length} ${noun}:\n${lines.join('\n')}${notFound}${failed}`;
}

/**
 * Render the shared "unresolved @scale" advisory from a flat list of occurrences the copy tools
 * REPORT as a fact (design.md §2.1). Each occurrence is `{ label, path, formula }` — what carried
 * the token, where it lives, and the dangling formula. This advises the reader to set an explicit
 * die; it deliberately proposes NO value (the die is the skill's/DM's judgment, never the tool's).
 * Returns '' when there are none. `label` already names the feature/item (and actor, where copying
 * many) so the same renderer serves features, items, and actor copies.
 */
export function formatUnresolvedScale(
  occurrences: Array<{ label: string; path: string; formula: string }>
): string {
  if (!occurrences || occurrences.length === 0) return '';
  const lines = occurrences.map(o => `  - ${o.label} — \`${o.path}\` = \`${o.formula}\``);
  return (
    `\n\n⚠️ **${occurrences.length} unresolved \`@scale\` token(s)** — these are fed by PC class/` +
    `species advancement and dangle to 0 on an NPC. Set an explicit die for this creature (the tool ` +
    `reports the token as a fact; it does not choose the value):\n${lines.join('\n')}`
  );
}

/**
 * Render the result of a compendium import (spells or features) into the standard
 * actor-import report: an icon + summary line, a Requested/Added/Skipped/Not-found
 * tally, and per-bucket sections. `noun` is the capitalised content word in the
 * summary, e.g. `'Spells'` or `'Features'`. Returns the full structured response
 * (summary, success flag, buckets, and a rendered `message`).
 */
export function formatImportReport(result: any, totalRequested: number, noun: string): any {
  const added = result.added as Array<{
    name: string;
    packId: string;
    packLabel: string;
    itemId: string;
    unresolvedScale?: Array<{ path: string; formula: string }>;
  }>;
  const skipped = result.skipped as Array<{ name: string; reason: string }>;
  const notFound = result.notFound as string[];
  const failed = result.failed as Array<{ name: string; error: string }>;
  const warnings = result.warnings as string[];

  const parts: string[] = [];
  if (added.length > 0) parts.push(`${added.length} added`);
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
  if (notFound.length > 0) parts.push(`${notFound.length} not found`);
  if (failed.length > 0) parts.push(`${failed.length} failed`);

  const icon = failed.length > 0 ? '⚠️' : notFound.length > 0 ? '🔍' : '✅';
  const summary = `${icon} ${noun} imported to "${result.actor.name}" — ${parts.length > 0 ? parts.join(', ') : 'nothing changed'}`;

  const lines: string[] = [
    `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
    `**Requested:** ${totalRequested} — Added: ${added.length}, Skipped: ${skipped.length}, Not found: ${notFound.length}${failed.length > 0 ? `, Failed: ${failed.length}` : ''}`,
  ];
  if (added.length > 0) {
    lines.push('\n✅ **Added:**');
    for (const s of added) lines.push(`  - ${s.name} *(${s.packLabel}, item \`${s.itemId}\`)*`);
  }
  if (skipped.length > 0) {
    lines.push('\n⏭️ **Skipped:**');
    for (const s of skipped) lines.push(`  - ${s.name} — *${s.reason}*`);
  }
  if (notFound.length > 0) {
    lines.push('\n❌ **Not found in compendium:**');
    for (const name of notFound) lines.push(`  - ${name}`);
  }
  if (failed.length > 0) {
    lines.push('\n⚠️ **Failed during import:**');
    for (const f of failed) lines.push(`  - ${f.name} — *${f.error}*`);
  }
  if (warnings.length > 0) {
    lines.push('\n⚠️ **Warnings:**');
    for (const w of warnings) lines.push(`  - ${w}`);
  }

  // Surface any unresolved @scale tokens the page reported on the copied features (advancement-fed;
  // dangle on an NPC). The tool reports them; the skill sets the die.
  const unresolvedScale = added.flatMap(a =>
    (a.unresolvedScale ?? []).map(t => ({ label: a.name, path: t.path, formula: t.formula }))
  );
  const message = `${summary}\n\n${lines.join('\n')}${formatUnresolvedScale(unresolvedScale)}`;

  return {
    summary,
    success: added.length > 0 || (notFound.length === 0 && failed.length === 0),
    actor: result.actor,
    added,
    skipped,
    notFound,
    failed,
    warnings,
    ...(unresolvedScale.length > 0 ? { unresolvedScale } : {}),
    message,
  };
}
