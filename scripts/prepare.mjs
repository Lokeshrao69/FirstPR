// Turns a Graphify output (graphify-out/graph.json) into a slim bundle FirstPR can serve.
// Usage: node scripts/prepare.mjs <repoDir> <slug> <githubUrl> "<description>"
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBundle, upsertManifest } from '../lib/prepare.js';

const [repoDir, slug, url = '', description = ''] = process.argv.slice(2);
if (!repoDir || !slug) {
  console.error('Usage: node scripts/prepare.mjs <repoDir> <slug> <githubUrl> "<description>"');
  process.exit(1);
}

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const { entry, copied } = prepareBundle(repoDir, path.join(dataDir, slug), { slug, url, description });
upsertManifest(path.join(dataDir, 'repos.json'), entry);
console.log(`Prepared ${slug}: ${entry.nodes} nodes, ${entry.links} links, ${copied} source files`);
