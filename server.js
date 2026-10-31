import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from './lib/graph.js';
import { runAgent, runTool, TOOL_DECLS, PROVIDER, ACTIVE_MODEL } from './lib/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { manifest, graphs } = loadAll(path.join(__dirname, 'data'));
const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const clientCache = new Map();

app.get('/api/health', (req, res) => {
  res.json({ ok: true, repos: manifest.length, provider: PROVIDER, model: ACTIVE_MODEL, key: PROVIDER === 'openai' || !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) });
});

app.get('/api/repos', (req, res) => res.json(manifest));

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
