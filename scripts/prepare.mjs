// Turns a Graphify output (graphify-out/graph.json) into a slim bundle FirstPR can serve.
// Usage: node scripts/prepare.mjs <repoDir> <slug> <githubUrl> "<description>"
import fs from 'node:fs';
import path from 'node:path';

const [repoDir, slug, url = '', description = ''] = process.argv.slice(2);
if (!repoDir || !slug) {
  console.error('Usage: node scripts/prepare.mjs <repoDir> <slug> <githubUrl> "<description>"');
  process.exit(1);
}

const graphPath = path.join(repoDir, 'graphify-out', 'graph.json');
const raw = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', slug);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'src'), { recursive: true });

const nodes = raw.nodes.map((n) => ({
  id: n.id,
  label: n.label,
  file: n.source_file || '',
  loc: n.source_location || '',
  community: n.community ?? -1,
  cname: n.community_name || '',
  type: n.file_type || '',
  callable: !!n._callable,
  cls: !!n._callable_class,
}));
const ids = new Set(nodes.map((n) => n.id));
const links = (raw.links || raw.edges || [])
  .filter((l) => ids.has(l.source) && ids.has(l.target))
  .map((l) => ({
    s: l.source,
    t: l.target,
    r: l.relation || 'related',
    c: l.confidence || 'EXTRACTED',
    file: l.source_file || '',
    loc: l.source_location || '',
  }));

fs.writeFileSync(
  path.join(outDir, 'graph.json'),
  JSON.stringify({ commit: raw.built_at_commit || '', graphify: raw.graph?.graphify_version || '', nodes, links })
);

// Copy referenced source files so the agent can read real code.
const files = new Set(nodes.map((n) => n.file).filter(Boolean));
let copied = 0;
for (const f of files) {
  const src = path.join(repoDir, f);
  const resolved = path.resolve(src);
  if (!resolved.startsWith(path.resolve(repoDir))) continue;
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile() || st.size > 400_000) continue;
    const dest = path.join(outDir, 'src', f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(resolved, dest);
    copied++;
  } catch {}
}

// Update manifest
const manifestPath = path.join(outDir, '..', 'repos.json');
let manifest = [];
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
manifest = manifest.filter((r) => r.slug !== slug);
manifest.push({ slug, name: slug, url, description, nodes: nodes.length, links: links.length, commit: raw.built_at_commit || '' });
manifest.sort((a, b) => a.nodes - b.nodes);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`Prepared ${slug}: ${nodes.length} nodes, ${links.length} links, ${copied} source files`);
