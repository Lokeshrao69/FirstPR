import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll, RepoGraph } from './lib/graph.js';
import { runAgent, runTool, TOOL_DECLS, PROVIDER, ACTIVE_MODEL } from './lib/agent.js';
import { importRepo, parseGithubUrl } from './lib/importer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { manifest, graphs, importDir } = loadAll(path.join(__dirname, 'data'));
const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const clientCache = new Map();

app.get('/api/health', (req, res) => {
  res.json({ ok: true, repos: manifest.length, provider: PROVIDER, model: ACTIVE_MODEL, key: PROVIDER === 'openai' || !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) });
});

app.get('/api/repos', (req, res) => res.json(manifest));

// Import any public GitHub repo: clone -> Graphify -> bundle, then serve it without a restart.
const importing = new Map(); // url -> Promise<entry>, so double-clicks share one job
app.post('/api/repos/import', async (req, res) => {
  const gh = parseGithubUrl(req.body?.url);
  if (!gh) return res.status(400).json({ error: 'Please paste a public GitHub repository URL, like https://github.com/owner/repo' });
  const key = gh.url.toLowerCase();
  const already = manifest.find((m) => m.url.toLowerCase() === key);
  if (already && !req.body?.refresh) return res.json(already);
  if (!importing.has(key)) {
    if (importing.size >= 2) return res.status(429).json({ error: 'Other imports are running. Try again in a minute.' });
    const job = importRepo(gh.url, importDir, (slug) => manifest.find((m) => m.slug === slug))
      .then((entry) => {
        graphs.set(entry.slug, new RepoGraph(path.join(importDir, entry.slug), entry));
        clientCache.delete(entry.slug);
        const i = manifest.findIndex((m) => m.slug === entry.slug);
        if (i >= 0) manifest[i] = entry; else manifest.push(entry);
        console.log(`imported ${entry.url} as ${entry.slug}: ${entry.nodes} nodes, ${entry.links} links`);
        return entry;
      })
      .finally(() => importing.delete(key));
    importing.set(key, job);
  }
  try {
    res.json(await importing.get(key));
  } catch (e) {
    console.error('import error:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/graph/:repo', (req, res) => {
  const g = graphs.get(req.params.repo);
  if (!g) return res.status(404).json({ error: 'Unknown repo' });
  if (!clientCache.has(g.meta.slug)) clientCache.set(g.meta.slug, JSON.stringify(g.forClient()));
  res.type('json').send(clientCache.get(g.meta.slug));
});

// Direct access to the graph tools (also handy for other agents / debugging)
app.get('/api/tools', (req, res) => res.json(TOOL_DECLS));
app.post('/api/tool/:repo/:name', (req, res) => {
  const g = graphs.get(req.params.repo);
  if (!g) return res.status(404).json({ error: 'Unknown repo' });
  res.json(runTool(g, req.params.name, req.body || {}));
});

app.post('/api/chat', async (req, res) => {
  const { repo, message, history, image, mode } = req.body || {};
  const g = graphs.get(repo);
  if (!g) return res.status(404).json({ error: 'Unknown repo' });
  if (!message && !image) return res.status(400).json({ error: 'Empty message' });
  if (image && !/^image\/(png|jpe?g|webp|gif)$/.test(image.mimeType || '')) return res.status(400).json({ error: 'Unsupported image type' });
  try {
    const out = await runAgent({ graph: g, history, message, image, mode });
    res.json(out);
  } catch (e) {
    console.error('agent error:', e.message);
    res.status(e.status === 429 ? 429 : 500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FirstPR running on http://localhost:${PORT} with ${manifest.map((m) => m.slug).join(', ')}`));
