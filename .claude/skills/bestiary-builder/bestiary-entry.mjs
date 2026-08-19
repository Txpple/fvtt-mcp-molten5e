// bestiary-entry.mjs — add/refresh ONE monster page in the world's single "Bestiary" journal.
//
// Deterministic half of the bestiary-builder skill. Given a Monster Manual creature name it:
//   1. resolves the creature in dnd-monster-manual.actors (premium book — never the SRD);
//   2. follows its biography @Embed to the MM lore page ("Appendix: Monster Details");
//   3. harvests the MM journal ART embedded in that lore page (modules/… path, no upload needed);
//   4. strips the non-narrative bits — habitat/treasure line, nested art embeds, rollable-table
//      embeds and their lead-in/footnote — leaving the narrative the players can read;
//   5. upserts it as a page of the Bestiary journal, house-styled, and re-sorts every page
//      ALPHABETICALLY;
//   6. keeps the ownership contract: journal entry = players OBSERVE, page = player-visible unless
//      --gm-only (an unrevealed monster stays GM-only even though the entry is open).
//
// All DOM work happens in the live page (real DOMParser), so this is parsing, not regex guesswork.
//
// Usage (from the repo root):
//   node .claude/skills/bestiary-builder/bestiary-entry.mjs --monster "Ettercap"
//   node .claude/skills/bestiary-builder/bestiary-entry.mjs --monster "Twig Blight" \
//        --art "worlds/<world>/assets/journal/twig-blights.png::Twig blights" --dry-run
//
// Options:
//   --monster <name>   MM creature name (required). Shared-lore variants are fine:
//                      "Hobgoblin Captain" -> the "Hobgoblins" page, "Vine Blight" -> "Blights".
//   --page <name>      Override the page title (default: the MM lore page name).
//   --art <src[::cap]> Use this Data-relative image instead of the MM art. Repeatable (order kept).
//   --no-art           Text only.
//   --gm-only          Page stays GM-only (monster not yet revealed to the players).
//   --journal <name>   Bestiary journal name (default "Bestiary").
//   --folder <name>    Folder the journal is filed in when created (default "Adventure Log").
//   --dry-run          Print the resolved page HTML; write nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const { Foundry } = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'foundry.js')).href);

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { arts: [], journalName: 'Bestiary', folderName: 'Adventure Log' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--monster') opts.monsterName = argv[++i];
  else if (a === '--page') opts.pageName = argv[++i];
  else if (a === '--art') opts.arts.push(argv[++i]);
  else if (a === '--no-art') opts.noArt = true;
  else if (a === '--gm-only') opts.gmOnly = true;
  else if (a === '--journal') opts.journalName = argv[++i];
  else if (a === '--folder') opts.folderName = argv[++i];
  else if (a === '--dry-run') opts.dryRun = true;
  else {
    console.error(`unknown argument: ${a}`);
    process.exit(64);
  }
}
if (!opts.monsterName) {
  console.error('--monster <name> is required (e.g. --monster "Ettercap")');
  process.exit(64);
}
opts.arts = opts.arts.map(s => {
  const [src, caption = ''] = s.split('::');
  return { src: src.trim(), caption: caption.trim() };
});

// ---- env --------------------------------------------------------------------------------------
const env = {};
for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  if (line.trimStart().startsWith('#')) continue;
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const f = new Foundry({
  serverUrl: env.MOLTEN_SERVER_URL,
  magicUrl: env.MOLTEN_MAGIC_URL,
  user: env.FOUNDRY_USER || 'DM Assistant',
  password: env.FOUNDRY_PASSWORD,
  adminKey: env.MOLTEN_ADMIN_KEY,
  worldId: env.MOLTEN_WORLD_ID,
});

// ---- the live-page half -----------------------------------------------------------------------
const work = async o => {
  const IMG_STYLE = 'max-width:100%;border-radius:4px';
  const CAP_STYLE = 'text-align:center;font-size:0.9em;opacity:0.75';

  const figure = (src, caption) =>
    caption
      ? `<figure style="margin:0 0 0.75em"><img src="${src}" alt="${caption.replace(/"/g, '&quot;')}" style="${IMG_STYLE}"><figcaption style="${CAP_STYLE}">${caption}</figcaption></figure>`
      : `<img src="${src}" alt="" style="${IMG_STYLE};margin-bottom:0.75em">`;

  // 1. resolve the creature in the premium Monster Manual pack
  const pack = game.packs.get('dnd-monster-manual.actors');
  if (!pack) return { error: 'dnd-monster-manual.actors pack not present in this world' };
  const index = await pack.getIndex();
  const want = o.monsterName.toLowerCase();
  const exact = index.find(e => e.name.toLowerCase() === want);
  const loose = index.filter(e => e.name.toLowerCase().includes(want));
  const hit = exact ?? (loose.length === 1 ? loose[0] : null);
  if (!hit) {
    return {
      error: loose.length
        ? `"${o.monsterName}" is ambiguous in the Monster Manual`
        : `"${o.monsterName}" is not in the Monster Manual`,
      candidates: loose.slice(0, 12).map(e => e.name),
    };
  }
  const actor = await pack.getDocument(hit._id);

  // 2. biography -> the shared lore page
  const bio = actor.system?.details?.biography?.value ?? '';
  const embed = /@Embed\[([^\s\]]+)/.exec(bio);
  if (!embed) return { error: `${actor.name} has no lore embed in its biography (homebrew?)` };
  const lore = await fromUuid(embed[1]);
  if (!lore?.text?.content) return { error: `lore page ${embed[1]} has no text content` };

  // 3. parse the lore page in the DOM; harvest art, drop the non-narrative furniture
  const doc = new DOMParser().parseFromString(
    `<div id="r">${lore.text.content}</div>`,
    'text/html'
  );
  let root = doc.getElementById('r');
  while (root.children.length === 1 && root.firstElementChild.tagName === 'DIV')
    root = root.firstElementChild; // some entries wrap everything in a bare <div>

  const mmArt = [];
  for (const el of [...root.children]) {
    const text = (el.textContent ?? '').trim();

    // an @Embed-only paragraph: art page -> harvest, anything else (rollable tables) -> drop
    const emb = /^@Embed\[([^\s\]]+)/.exec(text);
    if (emb && /^@Embed\[/.test(text)) {
      const target = await fromUuid(emb[1]).catch(() => null);
      if (target?.type === 'image' && target.src)
        mmArt.push({ src: target.src, caption: target.image?.caption ?? '' });
      el.remove();
      continue;
    }
    // encounter-building metadata, not narrative
    if (el.classList.contains('habitat-treasure')) {
      el.remove();
      continue;
    }
    // DM tooling that hangs off an embedded table. The pointer is sometimes its own
    // paragraph and sometimes the closing sentence of a narrative one (Wight, Skeleton),
    // so strip the sentence and drop the paragraph only if nothing else was in it.
    if (/^\*\s*See the /i.test(text)) {
      el.remove();
      continue;
    }
    if (/Roll on or choose a result/i.test(text)) {
      el.innerHTML = el.innerHTML.replace(
        /\s*Roll on or choose a result from the [^.<]*?table[^.<]*\.\s*/gi,
        ' '
      );
      if (!(el.textContent ?? '').trim()) {
        el.remove();
        continue;
      }
    }
    // the italic epithet under the art -> the house lead line
    if (el.classList.contains('creature-flavor') && el.querySelector('em')) {
      el.className = 'lead';
      continue;
    }
    // pull-quotes -> a plain blockquote (the MM's own classes have no styling in-world)
    if (el.tagName === 'ASIDE' && el.classList.contains('quote')) {
      const bq = doc.createElement('blockquote');
      for (const p of [...el.children]) {
        if (p.classList.contains('quote-author')) {
          p.removeAttribute('class');
          p.setAttribute('style', 'text-align:right');
          p.innerHTML = `<em>${p.innerHTML}</em>`;
        }
        bq.appendChild(p);
      }
      el.replaceWith(bq);
      continue;
    }
    el.removeAttribute('class'); // MM book classes don't exist in the world stylesheet
  }

  const arts = o.noArt ? [] : o.arts.length ? o.arts : mmArt;
  const body = root.innerHTML.trim();
  const html =
    `<section class="mcp-journal"><div class="wrap">` +
    arts.map(a => figure(a.src, a.caption)).join('') +
    body +
    `</div></section>`;

  const pageName = o.pageName || lore.name;
  if (o.dryRun)
    return { dryRun: true, monster: actor.name, pageName, arts, mmArt, html, loreUuid: embed[1] };

  // 4. upsert the journal (entry = players OBSERVE; a GM-only page must say so EXPLICITLY, since
  //    an inherited default would inherit the open entry)
  const folder = game.folders.find(x => x.name === o.folderName && x.type === 'JournalEntry');
  let journal = game.journal.getName(o.journalName);
  if (!journal) {
    journal = await JournalEntry.create({
      name: o.journalName,
      folder: folder?.id ?? null,
      ownership: { default: 2 },
    });
  } else if ((journal.ownership?.default ?? 0) < 2) {
    await journal.update({ 'ownership.default': 2 });
  }

  const ownership = { default: o.gmOnly ? 0 : 2 };
  const existing = journal.pages.find(p => p.name === pageName);
  if (existing) await existing.update({ 'text.content': html, ownership });
  else
    await journal.createEmbeddedDocuments('JournalEntryPage', [
      { name: pageName, type: 'text', text: { content: html, format: 1 }, ownership },
    ]);

  // 5. alphabetical page order
  const ordered = [...journal.pages].sort((a, b) => a.name.localeCompare(b.name));
  await journal.updateEmbeddedDocuments(
    'JournalEntryPage',
    ordered.map((p, i) => ({ _id: p.id, sort: (i + 1) * 100 }))
  );

  return {
    monster: actor.name,
    journal: journal.name,
    journalId: journal.id,
    pageName,
    created: !existing,
    gmOnly: Boolean(o.gmOnly),
    arts,
    pages: ordered.map(p => ({
      name: p.name,
      playerVisible: (p.ownership?.default ?? 0) >= 2,
    })),
  };
};

// ---- drive ------------------------------------------------------------------------------------
try {
  console.log(`[bestiary] connecting…`);
  await f.connect();
  const result = await f.evaluate(work, opts);
  if (result?.error) {
    console.error(`[bestiary] ${result.error}`);
    if (result.candidates?.length) console.error(`  candidates: ${result.candidates.join(', ')}`);
    process.exitCode = 1;
  } else if (result?.dryRun) {
    console.log(`[bestiary] DRY RUN — ${result.monster} -> page "${result.pageName}"`);
    console.log(`  art: ${result.arts.map(a => a.src).join(', ') || '(none)'}`);
    console.log(`\n${result.html}\n`);
  } else {
    console.log(
      `[bestiary] ${result.created ? 'created' : 'updated'} "${result.pageName}" in ${result.journal}` +
        `${result.gmOnly ? ' (GM-only)' : ''}`
    );
    console.log(
      `  pages now: ${result.pages.map(p => `${p.name}${p.playerVisible ? '' : ' [GM]'}`).join(' · ')}`
    );
  }
} finally {
  await f.dispose().catch(() => {});
}
