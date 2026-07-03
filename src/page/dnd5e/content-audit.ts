// Page-side: the content-audit finishing check — the safety net behind authoring rules 7/8/9.
//
// Rules ① (icons) and ② (loot twins) PREVENT the three failures at the authoring boundary; this is the
// DETECTION half — a read-only scan the skill runs before declaring "done" that flags any violation no
// matter which handler (or hand edit) produced it:
//   rule 8 — a placeholder icon (icons/svg/...) on an actor, item, or authored feature.
//   rule 7 — GM-fudge / pretend-reskin language in a description or biography ("treat its X as Y",
//            "reflavor", "deals necrotic in place of bludgeoning", "pretend", "is really <type>").
//   rule 9 — a magic item on an NPC with no matching world-Item loot twin.
//   rule 12 — GM-only content leaked into a PLAYER-VISIBLE item description ("GM:" asides, "the DM",
//            "fill in the …", "ready-made hook", "to suit your table") — players can read an item's
//            description on sight, so a secret/meta-note there is a silent spoiler. ITEM descriptions
//            only (an NPC biography is GM-facing, so its GM notes are fine — not scanned for rule 12).
// The scanners (findFudgeLanguage / findGmLeakLanguage + the imported isPlaceholderIcon / isMagicItemDoc)
// are PURE and unit-tested in content-audit.test.ts; auditContent gathers the live docs and applies them.

import { resolveActorFuzzy, toSource } from '../_shared.js';
import { isPlaceholderIcon } from './icons.js';
import { isMagicItemDoc } from './items.js';

/**
 * GM-fudge / pretend-reskin phrasings (rule 7). Anchored to avoid false positives on legitimate rules
 * text: the "treat … as" arm requires a possessive (its/their/his/her — i.e. the creature's OWN
 * ability being reflavored, not "treat the target as prone"); "in place of" and "is really" require a
 * damage-type/theme word; the bounded [^.<>] runs keep a match inside one clause and out of HTML tags.
 */
export const FUDGE_PATTERN =
  /\btreat(?:s|ed|ing)?\s+(?:its|their|his|her)\b[^.<>]{0,60}\bas\b|\breflavou?r\w*|\bin\s+place\s+of\b[^.<>]{0,40}\b(?:damage|bludgeoning|slashing|piercing|necrotic|radiant|fire|cold|acid|poison|psychic|force|thunder|lightning)\b|\bpretend\w*|\bis\s+really\s+(?:necrotic|radiant|fire|cold|acid|poison|psychic|force|thunder|lightning|bludgeoning|slashing|piercing|gloom|holy|unholy|shadow)\b/gi;

/** Return up to 5 fudge-language snippets found in a (possibly HTML) string. PURE — unit-tested. */
export function findFudgeLanguage(text: string | null | undefined): string[] {
  if (!text || typeof text !== 'string') return [];
  const plain = text.replace(/<[^>]*>/g, ' ');
  const re = new RegExp(FUDGE_PATTERN.source, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(plain)) !== null && out.length < 5) {
    out.push(m[0].trim().replace(/\s+/g, ' '));
  }
  return out;
}

/**
 * GM-note / spoiler leak in a player-visible description (rule 12). An item's description is read by a
 * player the moment they see the item, so GM-only asides and DM-directed meta belong in a GM journal,
 * never here. High-precision arms — each is language that essentially never appears in in-world item
 * flavor: a "GM:" / "DM:" / "GM —" / "GM," label, "GM note", a direct address to the GM/DM/Dungeon
 * Master/Game Master, "your table/campaign/players/group", or the ready-made-hook meta ("fill in the",
 * "ready-made", "to suit your", "as you see fit"). Bounded so a match stays inside one clause.
 */
export const GM_LEAK_PATTERN =
  /\b(?:GM|DM)\s*[:—,]|\b(?:GM|DM)\s+note\b|\bthe\s+(?:GM|DM|dungeon\s+master|game\s+master)\b|\byour\s+(?:table|campaign|players|group)\b|\bready-?made\b|\bfill\s+in\s+the\b|\bto\s+suit\s+your\b|\bas\s+you\s+see\s+fit\b/gi;

/** Return up to 5 GM-leak snippets found in a (possibly HTML) string. PURE — unit-tested. */
export function findGmLeakLanguage(text: string | null | undefined): string[] {
  if (!text || typeof text !== 'string') return [];
  const plain = text.replace(/<[^>]*>/g, ' ');
  const re = new RegExp(GM_LEAK_PATTERN.source, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(plain)) !== null && out.length < 5) {
    out.push(m[0].trim().replace(/\s+/g, ' '));
  }
  return out;
}

// dnd5e physical-item types that can be loot (so rule 9 applies). Feats/spells are not gear.
const LOOTABLE_TYPES = new Set(['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container']);

export interface AuditFinding {
  rule: 7 | 8 | 9 | 12;
  issue: 'placeholder-icon' | 'fudge-language' | 'unlootable-magic' | 'gm-note-leak';
  docType: 'actor' | 'item';
  id: string;
  name: string;
  owner?: string; // owning actor name, for an embedded item
  detail: string;
}

interface AuditArgs {
  actorIdentifiers?: string[];
  itemFolders?: string[];
  worldItemIds?: string[];
}

/**
 * Scan authored content for rule 7/8/9 violations. Targets: the named actors (+ their embedded items),
 * the named world-item folders, and/or specific world items. With NO target it runs a FULL SWEEP of
 * every NPC actor and every world Item. Read-only — it never mutates a document; it returns findings
 * for the skill to fix.
 */
export async function auditContent(args?: AuditArgs): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error(`auditContent requires D&D 5e. Current system: "${game.system.id}".`);
  }
  const { actorIdentifiers, itemFolders, worldItemIds } = args ?? {};
  const noTarget = !actorIdentifiers?.length && !itemFolders?.length && !worldItemIds?.length;

  const findings: AuditFinding[] = [];
  const notFound: string[] = [];

  // --- Resolve target actors (explicit list, or all NPCs on a full sweep) ---
  const actors: any[] = [];
  if (actorIdentifiers?.length) {
    for (const id of actorIdentifiers) {
      const a = resolveActorFuzzy(id);
      if (a) actors.push(a);
      else notFound.push(`actor "${id}"`);
    }
  } else if (noTarget) {
    for (const a of game.actors ?? []) if (a.type === 'npc') actors.push(a);
  }

  // --- Resolve target world items (ids, folders, or all on a full sweep) ---
  const worldItems = new Map<string, any>();
  if (worldItemIds?.length) {
    for (const id of worldItemIds) {
      const it = game.items?.get(id);
      if (it) worldItems.set(it.id, it);
      else notFound.push(`world item "${id}"`);
    }
  }
  if (itemFolders?.length) {
    const folderIds = new Set<string>();
    for (const f of itemFolders) {
      const fd = game.folders?.find((x: any) => x.type === 'Item' && (x.name === f || x.id === f));
      if (fd) folderIds.add(fd.id);
      else notFound.push(`item folder "${f}"`);
    }
    for (const it of game.items ?? []) {
      if (it.folder && folderIds.has(it.folder.id)) worldItems.set(it.id, it);
    }
  }
  if (noTarget) {
    for (const it of game.items ?? []) worldItems.set(it.id, it);
  }

  // A world Item with this name exists (the loot twin a magic NPC item should have). Name-based,
  // matching how the loot-copy is minted (same name as the on-actor item).
  const worldItemNames = new Set<string>();
  for (const it of game.items ?? []) worldItemNames.add((it.name ?? '').toLowerCase());

  const flagDoc = (
    doc: any,
    docType: 'actor' | 'item',
    descText: string | undefined,
    itemType?: string,
    owner?: string
  ) => {
    if (isPlaceholderIcon(doc.img)) {
      findings.push({
        rule: 8,
        issue: 'placeholder-icon',
        docType,
        id: doc.id ?? '',
        name: doc.name ?? '',
        ...(owner ? { owner } : {}),
        detail: `placeholder icon (${doc.img ?? 'none'})`,
      });
    }
    for (const snip of findFudgeLanguage(descText)) {
      findings.push({
        rule: 7,
        issue: 'fudge-language',
        docType,
        id: doc.id ?? '',
        name: doc.name ?? '',
        ...(owner ? { owner } : {}),
        detail: `fudge language: "${snip}"`,
      });
    }
    // rule 12 — GM-note / spoiler in a PLAYER-VISIBLE description. Lootable GEAR only: a player can read
    // a piece of loot's description on sight. An NPC biography, and an NPC's feats/traits/spells, are
    // GM-facing (not player-loot), so their GM notes are legitimate and are NOT scanned for rule 12.
    if (docType === 'item' && typeof itemType === 'string' && LOOTABLE_TYPES.has(itemType)) {
      for (const snip of findGmLeakLanguage(descText)) {
        findings.push({
          rule: 12,
          issue: 'gm-note-leak',
          docType,
          id: doc.id ?? '',
          name: doc.name ?? '',
          ...(owner ? { owner } : {}),
          detail: `GM-note / spoiler in a player-visible description: "${snip}"`,
        });
      }
    }
  };

  // --- Scan actors + their embedded items ---
  for (const actor of actors) {
    flagDoc(actor, 'actor', actor.system?.details?.biography?.value);
    for (const item of actor.items ?? []) {
      const src = toSource(item);
      flagDoc(item, 'item', src.system?.description?.value, item.type, actor.name);
      // rule 9 — a magic item on an NPC needs a world-Item loot twin.
      if (
        actor.type === 'npc' &&
        LOOTABLE_TYPES.has(item.type) &&
        isMagicItemDoc(src.system) &&
        !worldItemNames.has((item.name ?? '').toLowerCase())
      ) {
        findings.push({
          rule: 9,
          issue: 'unlootable-magic',
          docType: 'item',
          id: item.id ?? '',
          name: item.name ?? '',
          owner: actor.name,
          detail: 'magic item on an NPC has no matching world-Item loot twin',
        });
      }
    }
  }

  // --- Scan world items ---
  for (const item of worldItems.values()) {
    flagDoc(item, 'item', toSource(item).system?.description?.value, item.type);
  }

  const byRule = { 7: 0, 8: 0, 9: 0, 12: 0 } as Record<number, number>;
  for (const fnd of findings) byRule[fnd.rule]++;

  return {
    ok: findings.length === 0,
    scope: noTarget ? 'full-sweep (all NPCs + all world items)' : 'targeted',
    scanned: { actors: actors.length, worldItems: worldItems.size },
    counts: {
      rule7_fudge: byRule[7],
      rule8_icon: byRule[8],
      rule9_loot: byRule[9],
      rule12_leak: byRule[12],
    },
    findings,
    ...(notFound.length > 0 ? { notFound } : {}),
  };
}
