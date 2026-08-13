// clone-sim-pcs.mjs — one-off: clone the four PCs as "(Sim)" copies for Tom's battle replay.
// Full toObject() copies (sheets stay rollable), filed in a folder, owned by Tom only.
//
// Usage: node scripts/clone-sim-pcs.mjs --folder <folderId> --owner <userId> --actors id1,id2,...
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const { Foundry } = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'foundry.js')).href);

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--folder') opts.folderId = argv[++i];
  else if (a === '--owner') opts.ownerId = argv[++i];
  else if (a === '--actors') opts.actorIds = argv[++i].split(',');
  else {
    console.error(`unknown argument: ${a}`);
    process.exit(64);
  }
}
if (!opts.ownerId || !opts.actorIds?.length) {
  console.error('--owner <userId> and --actors <id,id,...> are required');
  process.exit(64);
}

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

const work = async o => {
  const out = [];
  for (const id of o.actorIds) {
    const src = game.actors.get(id);
    if (!src) {
      out.push({ srcId: id, error: 'actor not found' });
      continue;
    }
    const data = src.toObject();
    delete data._id;
    data.name = `${src.name} (Sim)`;
    data.folder = o.folderId ?? null;
    data.ownership = { default: 0, [o.ownerId]: 3 };
    const created = await Actor.create(data, { keepId: false });
    out.push({ srcId: id, id: created.id, name: created.name });
  }
  return out;
};

try {
  await f.connect();
  const result = await f.evaluate(work, opts);
  for (const r of result) {
    if (r.error) console.error(`✗ ${r.srcId}: ${r.error}`);
    else console.log(`✓ ${r.name} (${r.id}) cloned from ${r.srcId}`);
  }
  process.exitCode = result.some(r => r.error) ? 1 : 0;
} finally {
  await f.dispose().catch(() => {});
}
