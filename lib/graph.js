// Graph engine over a Graphify knowledge graph. These are the "tools" the Gemma 4 agent calls.
import fs from 'node:fs';
import path from 'node:path';

const STRUCTURAL = new Set(['contains', 'method']);

export class RepoGraph {
  constructor(dir, meta) {
    this.dir = dir;
    this.meta = meta;
    const g = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
    this.raw = g;
    this.nodes = new Map(g.nodes.map((n) => [n.id, n]));
    this.out = new Map();
    this.in = new Map();
    for (const n of g.nodes) { this.out.set(n.id, []); this.in.set(n.id, []); }
    for (const l of g.links) {
      this.out.get(l.s).push(l);
      this.in.get(l.t).push(l);
    }
    this.degree = new Map(g.nodes.map((n) => [n.id, this.out.get(n.id).length + this.in.get(n.id).length]));
    this.byLabel = new Map();
    for (const n of g.nodes) {
      const k = norm(n.label);
      if (!this.byLabel.has(k)) this.byLabel.set(k, []);
      this.byLabel.get(k).push(n.id);
    }
  }

  brief(id) {
    const n = this.nodes.get(id);
    if (!n) return null;
    return { id: n.id, label: n.label, file: n.file, line: n.loc, community: n.cname, degree: this.degree.get(id) };
  }

  /** Resolve an id, label, or fuzzy name to a node id. */
  resolve(ref) {
    if (!ref) return null;
    const r = String(ref).trim().replace(/^\[\[|\]\]$/g, '');
    if (this.nodes.has(r)) return r;
    const k = norm(r);
    const hits = this.byLabel.get(k) || this.byLabel.get(norm(r.replace(/\(\)$/, ''))) || this.byLabel.get(norm(r + '()'));
    if (hits?.length) return [...hits].sort((a, b) => this.degree.get(b) - this.degree.get(a))[0];
    const s = this.search(r, 1);
    return s[0]?.id || null;
  }

  search(query, limit = 8) {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const scored = [];
    for (const n of this.nodes.values()) {
      const label = norm(n.label);
      const id = n.id.toLowerCase();
      const file = n.file.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (label === t) score += 10;
        else if (label.includes(t)) score += 5;
        if (id.includes(t)) score += 2;
        if (file.includes(t)) score += 1.5;
        if (n.cname.toLowerCase().includes(t)) score += 1;
      }
      if (score > 0) {
        score += Math.log2(1 + this.degree.get(n.id)) * 0.6;
        scored.push([score, n.id]);
      }
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map(([score, id]) => ({ ...this.brief(id), score: +score.toFixed(2) }));
  }

  explain(ref, limit = 30) {
    const id = this.resolve(ref);
    if (!id) return { error: `No node matches "${ref}". Try search_graph first.` };
    const outgoing = this.out.get(id).slice(0, limit).map((l) => ({ relation: l.r, to: this.brief(l.t), confidence: l.c, at: `${l.file}:${l.loc}` }));
    const incoming = this.in.get(id).slice(0, limit).map((l) => ({ relation: l.r, from: this.brief(l.s), confidence: l.c, at: `${l.file}:${l.loc}` }));
    return { node: this.brief(id), outgoing, incoming, truncated: this.degree.get(id) > limit * 2 };
  }

  /** Shortest path ignoring direction (how are A and B connected?). */
  path(fromRef, toRef, maxDepth = 8) {
    const a = this.resolve(fromRef);
    const b = this.resolve(toRef);
    if (!a || !b) return { error: `Could not resolve ${!a ? fromRef : toRef}` };
    const prev = new Map([[a, null]]);
    let frontier = [a];
    for (let d = 0; d < maxDepth && frontier.length && !prev.has(b); d++) {
      const next = [];
      for (const u of frontier) {
        for (const l of [...this.out.get(u), ...this.in.get(u)]) {
          const v = l.s === u ? l.t : l.s;
          if (!prev.has(v)) { prev.set(v, { from: u, link: l }); next.push(v); }
        }
      }
      frontier = next;
    }
    if (!prev.has(b)) return { from: this.brief(a), to: this.brief(b), found: false };
    const steps = [];
    for (let cur = b; prev.get(cur); cur = prev.get(cur).from) {
      const { from, link } = prev.get(cur);
      steps.unshift({ from: this.brief(from).label, relation: link.r, direction: link.s === from ? '->' : '<-', to: this.brief(cur).label, to_id: cur, at: `${link.file}:${link.loc}` });
    }
    return { from: this.brief(a), to: this.brief(b), found: true, hops: steps.length, steps, node_ids: [a, ...steps.map((s) => s.to_id)] };
  }

  /** Blast radius: what depends on this node (reverse, non-structural edges), up to depth. */
  impact(ref, depth = 2) {
    const id = this.resolve(ref);
    if (!id) return { error: `No node matches "${ref}"` };
    const seen = new Map([[id, 0]]);
    let frontier = [id];
    for (let d = 1; d <= depth; d++) {
      const next = [];
      for (const u of frontier) {
        for (const l of this.in.get(u)) {
          if (STRUCTURAL.has(l.r) || l.r === 'rationale_for') continue;
          if (!seen.has(l.s)) { seen.set(l.s, d); next.push(l.s); }
        }
      }
      frontier = next;
    }
    seen.delete(id);
    const dependents = [...seen.entries()]
      .sort((x, y) => x[1] - y[1] || this.degree.get(y[0]) - this.degree.get(x[0]))
      .slice(0, 40)
      .map(([nid, d]) => ({ ...this.brief(nid), distance: d }));
    const files = [...new Set(dependents.map((d) => d.file))];
    const tests = files.filter((f) => /(^|\/)tests?(\/|_)|_test\.|test_/.test(f));
    return { node: this.brief(id), dependents_count: seen.size, dependents, files_affected: files, likely_tests: tests };
  }

  overview() {
    const god = [...this.degree.entries()]
      .filter(([id]) => this.nodes.get(id).type === 'code')
      .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => this.brief(id));
    const comm = new Map();
    for (const n of this.nodes.values()) {
      if (!comm.has(n.community)) comm.set(n.community, { name: n.cname, size: 0, files: new Set() });
      const c = comm.get(n.community); c.size++; if (n.file) c.files.add(n.file);
    }
    const communities = [...comm.values()].sort((a, b) => b.size - a.size).slice(0, 12)
      .map((c) => ({ name: c.name, size: c.size, files: [...c.files].slice(0, 5) }));
    const files = [...new Set([...this.nodes.values()].map((n) => n.file).filter(Boolean))];
    return { repo: this.meta.slug, url: this.meta.url, nodes: this.nodes.size, edges: this.raw.links.length, file_count: files.length, core_abstractions: god, communities };
  }

  nodesInFile(file) {
    const f = String(file).replace(/^\.?\//, '');
    const list = [...this.nodes.values()].filter((n) => n.file === f || n.file.endsWith('/' + f));
    if (!list.length) {
      const files = [...new Set([...this.nodes.values()].map((n) => n.file))].filter((x) => x.includes(f)).slice(0, 10);
      return { error: `No exact file "${file}"`, did_you_mean: files };
    }
    return { file: list[0].file, nodes: list.slice(0, 60).map((n) => this.brief(n.id)) };
  }

  readSource(file, start, end) {
    const rel = String(file || '').replace(/^\.?\//, '');
    const base = path.resolve(this.dir, 'src');
    const p = path.resolve(base, rel);
    if (!p.startsWith(base + path.sep)) return { error: 'Invalid path' };
    if (!fs.existsSync(p)) return { error: `File not bundled: ${rel}` };
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    let s = Math.max(1, parseInt(start) || 1);
    let e = parseInt(end) || s + 59;
    e = Math.min(lines.length, Math.max(s, e), s + 119);
    const text = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(4)}| ${l}`).join('\n');
    return { file: rel, start: s, end: e, total_lines: lines.length, code: text };
  }

  /** Compact payload for the browser visualisation. */
  forClient() {
    return {
      meta: this.meta,
      nodes: [...this.nodes.values()].map((n) => ({ id: n.id, l: n.label, f: n.file, loc: n.loc, c: n.community, cn: n.cname, d: this.degree.get(n.id) })),
      links: this.raw.links.map((l) => ({ source: l.s, target: l.t, r: l.r })),
    };
  }
}

function norm(s) { return String(s).toLowerCase().replace(/[`'"]/g, '').trim(); }
const STOP = new Set(['the', 'a', 'an', 'how', 'does', 'do', 'is', 'what', 'where', 'which', 'of', 'in', 'to', 'and', 'for', 'work', 'works', 'this', 'that', 'it', 'with']);
function tokenize(q) {
  return String(q).toLowerCase().split(/[^a-z0-9_.]+/).filter((t) => t.length > 1 && !STOP.has(t));
}

export function loadAll(dataDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'repos.json'), 'utf8'));
  const graphs = new Map();
  for (const m of manifest) graphs.set(m.slug, new RepoGraph(path.join(dataDir, m.slug), m));
  return { manifest, graphs };
}
