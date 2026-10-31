// Gemma 4 agent (via the Gemini API) that reasons over a Graphify knowledge graph with function calling.

const BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
const MODEL = process.env.GEMMA_MODEL || 'gemma-4-31b-it';
const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || '8');
let systemInstructionSupported = true;

export const TOOL_DECLS = [
  {
    name: 'repo_overview',
    description: 'Get the big picture of the repository from its Graphify knowledge graph: core abstractions (most connected nodes) and communities (clusters of related code). Call this first for broad questions.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'search_graph',
    description: 'Search the codebase knowledge graph for classes, functions, files, or concepts by keyword. Returns node ids you can pass to other tools.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Keywords, e.g. "tokenizer encode" or "attention"' } }, required: ['query'] },
  },
  {
    name: 'explain_node',
    description: 'Show a node and all its relationships in the graph: what it calls/imports/inherits (outgoing) and what calls/uses it (incoming), with file:line evidence.',
    parameters: { type: 'object', properties: { node: { type: 'string', description: 'Node id or name' } }, required: ['node'] },
  },
  {
    name: 'find_path',
    description: 'Find the shortest chain of relationships connecting two nodes. Use to answer "how does A reach/relate to B".',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
  },
  {
    name: 'impact_of_change',
    description: 'Blast radius: everything that depends on a node (callers, importers, subclasses) up to 2 hops, the files affected and likely tests to run. Use before recommending a change.',
    parameters: { type: 'object', properties: { node: { type: 'string' } }, required: ['node'] },
  },
  {
    name: 'nodes_in_file',
    description: 'List the classes/functions defined in a given file path.',
    parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
  },
  {
    name: 'read_source',
    description: 'Read actual source code lines from a file (max 120 lines). Use the line numbers from graph nodes (e.g. L94).',
    parameters: { type: 'object', properties: { file: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['file'] },
  },
];

export function runTool(graph, name, args = {}) {
  switch (name) {
    case 'repo_overview': return graph.overview();
    case 'search_graph': return { results: graph.search(args.query || '', 10) };
    case 'explain_node': return graph.explain(args.node);
    case 'find_path': return graph.path(args.from, args.to);
    case 'impact_of_change': return graph.impact(args.node);
    case 'nodes_in_file': return graph.nodesInFile(args.file);
    case 'read_source': return graph.readSource(args.file, args.start_line, args.end_line);
    default: return { error: `Unknown tool ${name}` };
  }
}

const MODES = {
  ask: `The user is asking a question about the codebase. Answer clearly for a newcomer, explaining how the pieces fit together.`,
  issue: `The user pasted a GitHub issue (often a "good first issue") they want to solve. Produce a contribution plan with these sections:
## What the issue is asking (1-2 sentences)
## Where the change goes (files + nodes, with line refs)
## What could break (use impact_of_change; list dependents and tests)
## Step-by-step plan (numbered, concrete)
## Suggested PR title
Always call impact_of_change on the main node you plan to modify.`,
  screenshot: `The user shared a screenshot (an error, stack trace, terminal output, UI, or diagram). First read it carefully and state what it shows (error type, message, file names, line numbers, function names). Then map those to nodes in the graph and explain the likely cause and where to look/fix.`,
};

function systemPrompt(graph, mode) {
  return `You are FirstPR, a friendly senior maintainer who helps first-time contributors understand and contribute to the open-source repository "${graph.meta.slug}" (${graph.meta.url}).
You have tools backed by a Graphify knowledge graph of the repo (AST-extracted nodes = classes/functions/files/docs, edges = calls/imports/inherits/contains/uses).
Rules:
- Ground EVERY claim in tool results. Never invent files, functions or line numbers. If the graph does not contain something, say so.
- Prefer few, targeted tool calls: search_graph -> explain_node / find_path / impact_of_change -> read_source when code details matter.
- When you mention a graph node, cite it with its exact node id in double brackets, e.g. [[model_gpt]]. Cite 3-10 of the most relevant nodes. Only cite ids returned by tools.
- Include file:line references like \`model.py:L94\`.
- Use concise Markdown. Be encouraging but precise.
Task mode: ${MODES[mode] || MODES.ask}`;
}

async function callGemma(body) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server.');
  // The hosted Gemma endpoints intermittently return 500 "Internal error encountered." (and 429/503 under load);
  // these are transient, so retry with exponential backoff before surfacing the error.
  const retries = parseInt(process.env.GEMINI_RETRIES || '5');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < retries) {
      const delay = Math.min(1000 * 2 ** attempt, 16000) + Math.random() * 500;
      console.warn(`Gemini API ${res.status} (${json?.error?.message || 'no message'}), retry ${attempt + 1}/${retries} in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    const msg = json?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; throw err;
  }
}

/**
 * @param graph RepoGraph
 * @param history [{role:'user'|'model', text}]
 * @param message string
 * @param image {mimeType, data(base64)} | null
 * @param mode 'ask'|'issue'|'screenshot'
 */
export async function runAgent(opts) {
  return PROVIDER === 'openai' ? runAgentOpenAI(opts) : runAgentGemini(opts);
}

export const PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
export const ACTIVE_MODEL = PROVIDER === 'openai' ? (process.env.OPENAI_MODEL || 'gemma4') : MODEL;

// ---- Self-hosted open-weight models via any OpenAI-compatible server (Ollama, vLLM, llama.cpp, DigitalOcean inference) ----
async function runAgentOpenAI({ graph, history = [], message, image, mode = 'ask' }) {
  const base = (process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, '');
  const key = process.env.OPENAI_API_KEY || 'ollama';
  const messages = [{ role: 'system', content: systemPrompt(graph, mode) }];
  for (const h of history.slice(-8)) if (h?.text) messages.push({ role: h.role === 'model' ? 'assistant' : 'user', content: String(h.text).slice(0, 6000) });
  const content = [{ type: 'text', text: message || 'What does this screenshot show and where in the codebase should I look?' }];
  if (image?.data) content.push({ type: 'image_url', image_url: { url: `data:${image.mimeType || 'image/png'};base64,${image.data}` } });
  messages.push({ role: 'user', content });
  const tools = TOOL_DECLS.map((t) => ({ type: 'function', function: t }));
  const trace = [];
  const touched = new Set();
  const call = async (withTools) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: ACTIVE_MODEL, messages, temperature: 0.3, ...(withTools ? { tools } : {}) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(json?.error?.message || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return json.choices?.[0]?.message || {};
  };
  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await call(true);
    if (!msg.tool_calls?.length) return finish(graph, (msg.content || '(No answer)').trim(), trace, touched);
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.function.arguments || {}; } catch {}
      let result;
      try { result = runTool(graph, tc.function.name, args); } catch (e) { result = { error: e.message }; }
      collectIds(result, touched);
      trace.push({ tool: tc.function.name, args, summary: summarize(tc.function.name, result) });
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(clip(result)) });
    }
  }
  messages.push({ role: 'user', content: 'Stop calling tools now and give your best final answer using what you found.' });
  const msg = await call(false);
  return finish(graph, (msg.content || '(No answer)').trim(), trace, touched);
}

// ---- Gemma 4 via the Gemini API ----
async function runAgentGemini({ graph, history = [], message, image, mode = 'ask' }) {
  const sys = systemPrompt(graph, mode);
  const contents = [];
  for (const h of history.slice(-8)) {
    if (h?.text) contents.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text).slice(0, 6000) }] });
  }
  const userParts = [];
  if (image?.data) userParts.push({ inlineData: { mimeType: image.mimeType || 'image/png', data: image.data } });
  userParts.push({ text: message || (image ? 'What does this screenshot show and where in the codebase should I look?' : '') });
  contents.push({ role: 'user', parts: userParts });

  const trace = [];
  const touched = new Set();

  for (let step = 0; step < MAX_STEPS; step++) {
    const body = {
      contents,
      tools: [{ functionDeclarations: TOOL_DECLS }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    };
    if (systemInstructionSupported) body.systemInstruction = { parts: [{ text: sys }] };
    else body.contents = [{ role: 'user', parts: [{ text: `[Instructions]\n${sys}` }] }, { role: 'model', parts: [{ text: 'Understood.' }] }, ...contents];

    let resp;
    try {
      resp = await callGemma(body);
    } catch (e) {
      if (systemInstructionSupported && e.status === 400 && /instruction/i.test(e.message)) {
        systemInstructionSupported = false; step--; continue;
      }
      throw e;
    }

    const cand = resp.candidates?.[0];
    const parts = cand?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const answer = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim()
        || (cand?.finishReason ? `(No answer, finish reason: ${cand.finishReason})` : '(No answer)');
      return finish(graph, answer, trace, touched);
    }

    contents.push({ role: 'model', parts });
    const responses = [];
    for (const p of calls) {
      const { name, args } = p.functionCall;
      let result;
      try { result = runTool(graph, name, args || {}); } catch (e) { result = { error: e.message }; }
      collectIds(result, touched);
      trace.push({ tool: name, args: args || {}, summary: summarize(name, result) });
      responses.push({ functionResponse: { name, response: { result: clip(result) } } });
    }
    contents.push({ role: 'user', parts: responses });
  }

  // Ran out of steps: ask for a final answer without tools.
  contents.push({ role: 'user', parts: [{ text: 'Stop calling tools now and give your best final answer using what you found.' }] });
  const body = { contents, generationConfig: { temperature: 0.3, maxOutputTokens: 4096 } };
  if (systemInstructionSupported) body.systemInstruction = { parts: [{ text: sys }] };
  const resp = await callGemma(body);
  const answer = (resp.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  return finish(graph, answer || '(No answer)', trace, touched);
}

function finish(graph, answer, trace, touched) {
  const cited = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(answer))) {
    const id = graph.resolve(m[1]);
    if (id && !cited.includes(id)) cited.push(id);
  }
  const labels = Object.fromEntries(cited.map((id) => [id, graph.nodes.get(id).label]));
  return { answer, cited, labels, explored: [...touched].filter((id) => graph.nodes.has(id)).slice(0, 150), trace, model: ACTIVE_MODEL };
}

function collectIds(obj, set, depth = 0) {
  if (!obj || depth > 5) return;
  if (Array.isArray(obj)) return obj.forEach((x) => collectIds(x, set, depth + 1));
  if (typeof obj === 'object') {
    if (typeof obj.id === 'string') set.add(obj.id);
    if (Array.isArray(obj.node_ids)) obj.node_ids.forEach((i) => set.add(i));
    for (const v of Object.values(obj)) if (typeof v === 'object') collectIds(v, set, depth + 1);
  }
}

function clip(result) {
  const s = JSON.stringify(result);
  return s.length > 14000 ? JSON.parse(JSON.stringify({ truncated: true, preview: s.slice(0, 14000) })) : result;
}

function summarize(name, r) {
  if (r?.error) return `error: ${r.error}`;
  switch (name) {
    case 'repo_overview': return `${r.nodes} nodes, ${r.edges} edges, ${r.communities.length} top communities`;
    case 'search_graph': return `${r.results.length} hits: ${r.results.slice(0, 4).map((x) => x.label).join(', ')}`;
    case 'explain_node': return `${r.node.label}: ${r.outgoing.length} out, ${r.incoming.length} in`;
    case 'find_path': return r.found ? `${r.hops} hops: ${[r.from.label, ...r.steps.map((s) => s.to)].join(' → ')}` : 'no path found';
    case 'impact_of_change': return `${r.dependents_count} dependents across ${r.files_affected.length} files`;
    case 'nodes_in_file': return `${r.nodes.length} nodes in ${r.file}`;
    case 'read_source': return `${r.file} L${r.start}-${r.end}`;
    default: return '';
  }
}
