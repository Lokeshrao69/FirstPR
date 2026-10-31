/* FirstPR frontend */
const $ = (s) => document.querySelector(s);
const state = {
  repo: null, repos: [], data: null, byId: new Map(), adj: new Map(),
  mode: 'ask', history: [], image: null, busy: false,
  cited: new Set(), explored: new Set(), selected: null, hover: null,
};

const SUGGESTIONS = {
  nanoGPT: {
    ask: ['How does a forward pass flow through GPT, Block, attention and MLP?', 'How does train.py use the model and get batches?', 'Where are weights loaded from pretrained GPT-2?'],
    issue: ['Issue: Add a `top_p` (nucleus sampling) option to `GPT.generate` alongside the existing `top_k`.', 'Issue: `estimate_loss()` should also report perplexity in the training logs.'],
  },
  minbpe: {
    ask: ['How does RegexTokenizer differ from BasicTokenizer?', 'How does GPT4Tokenizer recover the merges from tiktoken?', 'How are save() and load() implemented?'],
    issue: ['Issue: Add a `vocab_size` property to the base Tokenizer class and use it in train().', 'Issue: `decode()` should support `errors="strict"` as an option instead of always using "replace".'],
  },
  smolagents: {
    ask: ['How does CodeAgent run the Python code the model writes?', 'How are tools defined and passed to an agent?', 'What is the path from MultiStepAgent.run to a model call?'],
    issue: ['Issue: `InterpreterError` messages from the local Python executor should include a hint listing the authorized imports/tools.', 'Issue: Make `ToolCallingAgent` log the total number of tool calls at the end of a run.'],
  },
};
const SCREENSHOT_SUGGESTIONS = {
  nanoGPT: { label: 'Try the sample error screenshot', src: 'samples/nanogpt-error.png', prompt: 'I got this error running my long-context eval script. What went wrong and what are my options to fix it?' },
  minbpe: { label: 'Try the sample error screenshot', src: 'samples/minbpe-error.png', prompt: 'I got this error when loading my tokenizer. What does it mean and where is the code?' },
  smolagents: { label: 'Try the sample error screenshot', src: 'samples/smolagents-error.png', prompt: 'My agent crashed with this. Where in smolagents does this come from?' },
};
const PLACEHOLDERS = {
  ask: 'Ask how something works… e.g. "How does attention work here?"',
  issue: 'Paste a GitHub issue (title + body) you want to solve…',
  screenshot: 'Attach or paste (Ctrl+V) a screenshot of an error, then describe what you were doing…',
};

// ---------- Graph ----------
const PALETTE = ['#ff8a3d', '#7cc4ff', '#b7f171', '#c79bff', '#ff6b8b', '#5ce1c6', '#ffd166', '#9aa7ff', '#f78fb3', '#7bdff2', '#e9c46a', '#a0e7a0'];
const colorFor = (c) => PALETTE[Math.abs(c) % PALETTE.length];
const Graph = ForceGraph()($('#graph'))
  .backgroundColor('#0d0f14')
  .nodeId('id')
  .nodeRelSize(3)
  .nodeVal((n) => 1 + Math.sqrt(n.d))
  .linkColor((l) => linkActive(l) ? '#ffd166cc' : (anyHighlight() ? '#ffffff0a' : '#ffffff1f'))
  .linkWidth((l) => (linkActive(l) ? 2 : 0.6))
  .linkDirectionalParticles((l) => (linkActive(l) ? 2 : 0))
  .linkDirectionalParticleWidth(2.5)
  .linkDirectionalParticleColor(() => '#ffd166')
  .nodeLabel((n) => `<b>${esc(n.l)}</b><br/><span style="font-family:monospace;font-size:11px">${esc(n.f)}${n.loc ? ':' + esc(n.loc) : ''}</span><br/><span style="color:#8b93a7">${esc(n.cn)} · ${n.d} links</span>`)
  .nodeCanvasObject(drawNode)
  .nodePointerAreaPaint((n, color, ctx) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x, n.y, radius(n) + 2, 0, 2 * Math.PI); ctx.fill(); })
  .onNodeClick((n) => selectNode(n.id, true))
  .onNodeHover((n) => { state.hover = n ? n.id : null; $('#graph').style.cursor = n ? 'pointer' : ''; })
  .onBackgroundClick(() => { closeDetails(); })
  .cooldownTicks(250);

function radius(n) { return 2.2 + Math.sqrt(n.d) * 1.1; }
function anyHighlight() { return state.cited.size || state.explored.size || state.selected; }
function linkActive(l) {
  const s = l.source.id ?? l.source, t = l.target.id ?? l.target;
  if (state.selected && (s === state.selected || t === state.selected)) return true;
  return state.cited.has(s) && state.cited.has(t);
}
function drawNode(n, ctx, scale) {
  const r = radius(n);
  const cited = state.cited.has(n.id), explored = state.explored.has(n.id), sel = state.selected === n.id;
  const dim = anyHighlight() && !cited && !explored && !sel && !(state.selected && state.adj.get(state.selected)?.has(n.id));
  ctx.globalAlpha = dim ? 0.18 : 1;
  if (cited || sel) {
    ctx.beginPath(); ctx.arc(n.x, n.y, r + 4, 0, 2 * Math.PI);
    ctx.fillStyle = sel ? '#ffffff33' : '#ffd16640'; ctx.fill();
  }
  ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
  ctx.fillStyle = sel ? '#ffffff' : cited ? '#ffd166' : explored ? '#4f8cff' : colorFor(n.c);
  ctx.fill();
  const showLabel = sel || cited || state.hover === n.id || (scale > 2.2 && n.d > 2) || (scale > 1 && n.d > 25) || n.d > 60;
  if (showLabel && !dim) {
    const fs = Math.max(10 / scale, 1.5);
    ctx.font = `${cited || sel ? 'bold ' : ''}${fs}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = cited ? '#ffd166' : '#e7eaf0';
    ctx.fillText(n.l.length > 34 ? n.l.slice(0, 32) + '…' : n.l, n.x, n.y + r + 1.5);
  }
  ctx.globalAlpha = 1;
}

async function loadRepo(slug) {
  state.repo = slug; state.history = []; state.cited.clear(); state.explored.clear(); state.selected = null;
  $('#loading').textContent = 'Loading knowledge graph…';
  $('#loading').classList.remove('hidden'); closeDetails();
  const meta = state.repos.find((r) => r.slug === slug);
  $('#repoLink').href = meta.url;
  const data = await fetch(`api/graph/${encodeURIComponent(slug)}`).then((r) => r.json());
  state.data = data; state.byId = new Map(data.nodes.map((n) => [n.id, n]));
  state.adj = new Map(data.nodes.map((n) => [n.id, new Set()]));
  for (const l of data.links) { state.adj.get(l.source)?.add(l.target); state.adj.get(l.target)?.add(l.source); }
  const big = data.nodes.length > 1500;
  Graph.d3Force('charge').strength(big ? -18 : -60);
  Graph.d3Force('link').distance(big ? 18 : 34);
  Graph.warmupTicks(big ? 60 : 0).graphData({ nodes: data.nodes.map((n) => ({ ...n })), links: data.links.map((l) => ({ ...l })) });
  setTimeout(() => Graph.zoomToFit(600, 40), big ? 1800 : 900);
  const communities = new Set(data.nodes.map((n) => n.c)).size;
  $('#stats').innerHTML = `<b>${data.nodes.length.toLocaleString()}</b> nodes · <b>${data.links.length.toLocaleString()}</b> edges · <b>${communities}</b> communities · built by Graphify @ <code>${(meta.commit || '').slice(0, 7)}</code>`;
  $('#loading').classList.add('hidden');
  $('#messages').innerHTML = '';
  welcome(meta);
  renderSuggestions();
  history.replaceState(null, '', `?repo=${encodeURIComponent(slug)}`);
}

function focusNodes(ids) {
  const nodes = Graph.graphData().nodes.filter((n) => ids.includes(n.id));
  if (!nodes.length) return;
  if (nodes.length === 1) { Graph.centerAt(nodes[0].x, nodes[0].y, 700); Graph.zoom(3, 700); return; }
  const set = new Set(ids);
  Graph.zoomToFit(800, 120, (n) => set.has(n.id));
  setTimeout(() => { if (Graph.zoom() > 3) Graph.zoom(3, 400); }, 850);
}

async function selectNode(id, fromGraph = false) {
  const n = state.byId.get(id); if (!n) return;
  state.selected = id;
  if (!fromGraph) focusNodes([id]);
  const d = $('#details');
  d.classList.remove('hidden');
  d.innerHTML = `<button class="close" aria-label="close">×</button><h3>${esc(n.l)}</h3><div class="meta">${esc(n.f)}${n.loc ? ':' + esc(n.loc) : ''}<br/>community: ${esc(n.cn)} · ${n.d} links</div><div class="thinking">Loading relationships…</div>`;
  d.querySelector('.close').onclick = closeDetails;
  const info = await tool('explain_node', { node: id });
  if (state.selected !== id) return;
  const li = (rel, b) => `<li data-id="${esc(b.id)}"><span class="rel">${esc(rel)}</span><span class="lbl">${esc(b.label)}</span></li>`;
  d.innerHTML = `<button class="close" aria-label="close">×</button>
    <h3>${esc(n.l)}</h3>
    <div class="meta">${esc(n.f)}${n.loc ? ':' + esc(n.loc) : ''}<br/>community: ${esc(n.cn)} · ${n.d} links</div>
    <div class="actions">
      <button data-act="explain">💬 Explain this</button>
      <button data-act="impact">💥 What breaks if I change it?</button>
      <button data-act="code">📄 Show code</button>
    </div>
    <h4>Uses / contains (${info.outgoing.length})</h4><ul>${info.outgoing.map((o) => li(o.relation + ' →', o.to)).join('') || '<li>—</li>'}</ul>
    <h4>Used by (${info.incoming.length})</h4><ul>${info.incoming.map((o) => li('← ' + o.relation, o.from)).join('') || '<li>—</li>'}</ul>
    <div id="codeBox"></div>`;
  d.querySelector('.close').onclick = closeDetails;
  d.querySelectorAll('li[data-id]').forEach((el) => (el.onclick = () => selectNode(el.dataset.id)));
  d.querySelector('[data-act=explain]').onclick = () => { setMode('ask'); send(`Explain [[${id}]] (${n.l}): what is it responsible for, how is it used, and how does it fit into the rest of the repo?`); };
  d.querySelector('[data-act=impact]').onclick = () => { setMode('issue'); send(`If I modify [[${id}]] (${n.l}), what else could break? Which files and tests should I check before opening a PR?`); };
  d.querySelector('[data-act=code]').onclick = async () => {
    const start = parseInt(String(n.loc).replace(/\D/g, '')) || 1;
    const src = await tool('read_source', { file: n.f, start_line: start, end_line: start + 40 });
    d.querySelector('#codeBox').innerHTML = src.error ? `<p class="meta">${esc(src.error)}</p>` : `<h4>${esc(src.file)} L${src.start}-${src.end}</h4><pre style="font-size:11px;overflow:auto;background:#0d0f14;padding:8px;border-radius:8px">${esc(src.code)}</pre>`;
  };
}
function closeDetails() { state.selected = null; $('#details').classList.add('hidden'); }

async function tool(name, args) {
  return fetch(`api/tool/${encodeURIComponent(state.repo)}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) }).then((r) => r.json());
}

// ---------- Search box ----------
let searchTimer;
$('#nodeSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $('#searchResults').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    const { results } = await tool('search_graph', { query: q });
    $('#searchResults').innerHTML = results.map((r) => `<li data-id="${esc(r.id)}">${esc(r.label)}<small>${esc(r.file)}${r.line ? ':' + esc(r.line) : ''}</small></li>`).join('');
    $('#searchResults').querySelectorAll('li').forEach((li) => (li.onclick = () => { $('#searchResults').innerHTML = ''; selectNode(li.dataset.id); }));
  }, 180);
});
$('#resetView').onclick = () => { state.cited.clear(); state.explored.clear(); closeDetails(); Graph.zoomToFit(600, 40); };

// ---------- Chat ----------
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#input').placeholder = PLACEHOLDERS[mode];
  renderSuggestions();
}
document.querySelectorAll('.modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

function renderSuggestions() {
  const box = $('#suggestions'); box.innerHTML = '';
  if (state.mode === 'screenshot') {
    const s = SCREENSHOT_SUGGESTIONS[state.repo];
    if (s) {
      const b = document.createElement('button'); b.textContent = '🖼️ ' + s.label;
      b.onclick = async () => { const blob = await fetch(s.src).then((r) => r.blob()); await setImage(blob); $('#input').value = s.prompt; };
      box.appendChild(b);
    }
    return;
  }
  for (const text of SUGGESTIONS[state.repo]?.[state.mode] || []) {
    const b = document.createElement('button'); b.textContent = text;
    b.onclick = () => (state.mode === 'issue' ? (($('#input').value = text), $('#input').focus()) : send(text));
    box.appendChild(b);
  }
}

function welcome(meta) {
  addMsg('model', `<div class="welcome">👋 You're exploring <b>${esc(meta.slug)}</b>: ${esc(meta.description)}.<br/><br/>
  The graph on the left was built by <b>Graphify</b>: every dot is a class, function, file or doc, and every line is a call, import or inheritance link. I'm a <b>Gemma 4</b> agent that walks this graph to answer you, so my answers point to real files and lines.<br/><br/>
  Try a suggestion below, click a node, or switch to <b>Plan an issue</b> to turn a good-first-issue into a PR plan.</div>`, true);
}

function addMsg(role, html, raw = false) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (raw) el.innerHTML = html; else el.textContent = html;
  $('#messages').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return el;
}

function renderAnswer(out) {
  const labels = out.labels || {};
  let md = out.answer.replace(/\[\[([^\]]+)\]\]/g, (_, id) => {
    const real = state.byId.has(id) ? id : (out.cited || []).find((c) => c === id) || id;
    const label = labels[real] || state.byId.get(real)?.l || id;
    return `<span class="node-ref" data-id="${esc(real)}">${esc(label)}</span>`;
  });
  const html = DOMPurify.sanitize(marked.parse(md), { ADD_ATTR: ['data-id'] });
  const trace = out.trace?.length
    ? `<details class="trace"><summary>🔎 Walked the Graphify graph with ${out.trace.length} tool call${out.trace.length > 1 ? 's' : ''} · ${esc(out.model)}</summary><ol>${out.trace.map((t) => `<li><code>${esc(t.tool)}(${esc(fmtArgs(t.args))})</code><br/>${esc(t.summary)}</li>`).join('')}</ol></details>`
    : '';
  const el = addMsg('model', trace + html, true);
  el.querySelectorAll('.node-ref').forEach((r) => (r.onclick = () => selectNode(r.dataset.id)));
}
function fmtArgs(a) { return Object.entries(a || {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', '); }

async function send(text) {
  if (state.busy) return;
  const message = (text ?? $('#input').value).trim();
  const image = state.image;
  if (!message && !image) return;
  state.busy = true; $('#send').disabled = true; closeDetails();
  const userEl = addMsg('user', '', true);
  if (image) { const img = document.createElement('img'); img.src = image.url; userEl.appendChild(img); }
  userEl.appendChild(document.createTextNode(message));
  $('#input').value = ''; clearImage();
  const thinking = addMsg('model', `<div class="thinking">Gemma 4 is walking the knowledge graph…</div>`, true);
  try {
    const res = await fetch('api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: state.repo, message, history: state.history, mode: image ? 'screenshot' : state.mode, image: image ? { mimeType: image.mimeType, data: image.data } : null }),
    });
    const out = await res.json();
    thinking.remove();
    if (!res.ok) throw new Error(out.error || res.statusText);
    renderAnswer(out);
    state.history.push({ role: 'user', text: message }, { role: 'model', text: out.answer });
    state.cited = new Set(out.cited); state.explored = new Set(out.explored);
    const focus = [...new Set([...out.cited, ...out.explored.slice(0, 30)])];
    if (focus.length) focusNodes(focus);
  } catch (e) {
    thinking.remove();
    addMsg('error', `⚠️ ${e.message}`);
  } finally {
    state.busy = false; $('#send').disabled = false;
  }
}
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

// ---------- Images ----------
async function setImage(blob) {
  if (!/^image\/(png|jpe?g|webp)$/.test(blob.type)) return alert('Please use a PNG, JPG or WebP image.');
  if (blob.size > 8 * 1024 * 1024) return alert('Image too large (max 8 MB).');
  const url = URL.createObjectURL(blob);
  const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
  state.image = { url, data, mimeType: blob.type };
  const p = $('#imagePreview'); p.classList.remove('hidden');
  p.innerHTML = `<img src="${url}" alt="attachment"/><span>Screenshot attached. Gemma 4 will read it.</span><button type="button" title="remove">✕</button>`;
  p.querySelector('button').onclick = clearImage;
  if (state.mode !== 'screenshot') setMode('screenshot');
}
function clearImage() { state.image = null; $('#imagePreview').classList.add('hidden'); $('#file').value = ''; }
$('#file').addEventListener('change', (e) => e.target.files[0] && setImage(e.target.files[0]));
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); setImage(item.getAsFile()); }
});
['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'drop' && e.dataTransfer.files[0]) setImage(e.dataTransfer.files[0]);
}));

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- Boot ----------
(async () => {
  const [repos, health] = await Promise.all([fetch('api/repos').then((r) => r.json()), fetch('api/health').then((r) => r.json())]);
  state.repos = repos;
  $('#repo').innerHTML = repos.map((r) => `<option value="${esc(r.slug)}">${esc(r.slug)} (${r.nodes.toLocaleString()} nodes)</option>`).join('');
  $('#modelTag').textContent = `${health.model}${health.key ? '' : ' · ⚠ no API key'}`;
  $('#repo').onchange = (e) => loadRepo(e.target.value);
  $('.brand').style.cursor = 'pointer';
  $('.brand').title = 'Choose a different repository';
  $('.brand').onclick = showPicker;
  setMode('ask');
  window.addEventListener('resize', () => Graph.width($('.graph-pane').clientWidth).height($('.graph-pane').clientHeight));
  Graph.width($('.graph-pane').clientWidth).height($('.graph-pane').clientHeight);
  // Deep links (?repo=x) open directly; otherwise ask the user which repo to analyse first.
  const want = repos.find((r) => r.slug === new URLSearchParams(location.search).get('repo'))?.slug;
  if (want) { $('#repo').value = want; await loadRepo(want); }
  else showPicker();
})();

function showPicker() {
  $('#pickerList').innerHTML = state.repos.map((r) => `
    <button class="picker-item${r.slug === state.repo ? ' current' : ''}" data-slug="${esc(r.slug)}">
      <span class="picker-name">${esc(r.name || r.slug)}</span>
      <span class="picker-desc">${esc(r.description || '')}</span>
      <span class="picker-meta">${r.nodes.toLocaleString()} nodes · ${r.links.toLocaleString()} edges · ${esc(r.url.replace('https://github.com/', ''))}</span>
    </button>`).join('');
  $('#pickerList').querySelectorAll('.picker-item').forEach((b) => (b.onclick = () => {
    $('#picker').classList.add('hidden');
    $('#repo').value = b.dataset.slug;
    if (b.dataset.slug !== state.repo) loadRepo(b.dataset.slug);
  }));
  if (!state.repo) $('#loading').textContent = 'Choose a repository to begin…';
  $('#picker').classList.remove('hidden');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.repo) $('#picker').classList.add('hidden'); });
