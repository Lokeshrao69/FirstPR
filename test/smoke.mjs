// Offline smoke test: starts a mock Gemini API + the FirstPR server and exercises every endpoint.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const mock = spawn('node', ['test/mock-gemini.mjs'], { env: { ...process.env, MOCK_PORT: '4010' }, stdio: 'inherit' });
const app = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', GEMINI_API_KEY: 'test', GEMINI_BASE_URL: 'http://localhost:4010' }, stdio: 'inherit' });
const B = 'http://localhost:3999';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (p, body) => fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then(async (r) => ({ status: r.status, body: await r.json() }));

try {
  await sleep(1200);
  const h = await j('/api/health'); assert.equal(h.body.ok, true);
  const repos = await j('/api/repos'); assert.ok(repos.body.length >= 1);
  const g = await j('/api/graph/nanoGPT'); assert.ok(g.body.nodes.length > 10 && g.body.links.length > 10);
  const s = await j('/api/tool/nanoGPT/search_graph', { query: 'attention' }); assert.equal(s.body.results[0].label, 'CausalSelfAttention');
  const p = await j('/api/tool/nanoGPT/find_path', { from: 'train.py', to: 'CausalSelfAttention' }); assert.equal(p.body.found, true);
  const bad = await j('/api/tool/nanoGPT/read_source', { file: '../../server.js' }); assert.ok(bad.body.error);

  const chat = await j('/api/chat', { repo: 'nanoGPT', message: 'How does attention work?', mode: 'ask' });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  assert.deepEqual(chat.body.cited, ['model_causalselfattention', 'model_block']);
  assert.equal(chat.body.trace.length, 3);
  assert.match(chat.body.answer, /image=false sys=true/);

  const img = fs.readFileSync('public/samples/nanogpt-error.png').toString('base64');
  const chat2 = await j('/api/chat', { repo: 'nanoGPT', message: 'what broke?', image: { mimeType: 'image/png', data: img }, mode: 'screenshot' });
  assert.match(chat2.body.answer, /image=true/);

  const badImg = await j('/api/chat', { repo: 'nanoGPT', message: 'x', image: { mimeType: 'text/html', data: 'eA==' } });
  assert.equal(badImg.status, 400);
  console.log('\n✅ all smoke tests passed');
} catch (e) {
  console.error('\n❌', e);
  process.exitCode = 1;
} finally {
  mock.kill(); app.kill();
}

// Second run: OpenAI-compatible provider (self-hosted open-weight model)
{
  const mock2 = spawn('node', ['test/mock-gemini.mjs'], { env: { ...process.env, MOCK_PORT: '4020' }, stdio: 'ignore' });
  const app2 = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3998', LLM_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:4021/v1', OPENAI_MODEL: 'gemma4:e4b' }, stdio: 'ignore' });
  try {
    await sleep(1200);
    const r = await fetch('http://localhost:3998/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: 'nanoGPT', message: 'path?' }) }).then((r) => r.json());
    assert.deepEqual(r.cited, ['model', 'model_causalselfattention'], JSON.stringify(r));
    assert.equal(r.trace[0].tool, 'find_path');
    assert.match(r.answer, /model=gemma4:e4b/);
    console.log('✅ openai-compatible provider passed');
  } catch (e) { console.error('❌ openai provider', e); process.exitCode = 1; }
  finally { mock2.kill(); app2.kill(); }
}
