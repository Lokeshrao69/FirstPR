// Turns a Graphify output (<repoDir>/graphify-out/graph.json) into the slim bundle FirstPR serves:
// <outDir>/graph.json plus a copy of every referenced source file under <outDir>/src.
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 400_000;

export function prepareBundle(repoDir, outDir, { slug, name, url = '', description = '' }) {
  const raw = JSON.parse(fs.readFileSync(path.join(repoDir, 'graphify-out', 'graph.json'), 'utf8'));
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

  // Copy referenced source files so the agent can read real code (never anything outside the repo).
  const root = path.resolve(repoDir);
  let copied = 0;
  for (const f of new Set(nodes.map((n) => n.file).filter(Boolean))) {
    const resolved = path.resolve(root, f);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
    try {
      const st = fs.lstatSync(resolved);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const dest = path.join(outDir, 'src', f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(resolved, dest);
      copied++;
    } catch {}
  }

  const entry = { slug, name: name || slug, url, description, nodes: nodes.length, links: links.length, commit: raw.built_at_commit || '' };
  return { entry, copied };
}

/** Insert or replace an entry in a repos.json manifest file. */
export function upsertManifest(manifestPath, entry) {
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  manifest = manifest.filter((r) => r.slug !== entry.slug);
  manifest.push(entry);
  manifest.sort((a, b) => a.nodes - b.nodes);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}
