// Import any public GitHub repo at runtime: shallow clone -> Graphify (AST only, no LLM) -> FirstPR bundle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareBundle, upsertManifest } from './prepare.js';

const run = promisify(execFile);
const GRAPHIFY = process.env.GRAPHIFY_BIN || 'graphify';
const CLONE_TIMEOUT = parseInt(process.env.IMPORT_CLONE_TIMEOUT_MS || '180000');
const GRAPHIFY_TIMEOUT = parseInt(process.env.IMPORT_GRAPHIFY_TIMEOUT_MS || '300000');
const MAX_NODES = parseInt(process.env.IMPORT_MAX_NODES || '25000');

// Only plain https://github.com/<owner>/<repo> URLs (optionally .git / trailing slash / /tree/... suffix).
const GH = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/(?:tree|blob)\/.*)?\/?$/;

export function parseGithubUrl(input) {
  const m = GH.exec(String(input || '').trim());
  if (!m || m[2] === '.' || m[2] === '..') return null;
  const [, owner, repo] = m;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

function friendly(e, step) {
  if (e.killed || e.signal === 'SIGTERM') return `${step} timed out. The repository may be too large.`;
  if (e.code === 'ENOENT') return step === 'Graphify'
    ? 'Graphify is not installed on the server. Run: pip install graphifyy'
    : 'git is not installed on the server.';
  const msg = String(e.stderr || e.message || '').trim();
  if (step === 'Clone' && /not found|could not read|Authentication|terminal prompts disabled/i.test(msg)) return 'Repository not found or not public.';
  return `${step} failed: ${msg.split('\n').slice(-3).join(' ').slice(0, 300)}`;
}

async function fetchDescription(owner, repo) {
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { 'User-Agent': 'FirstPR' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return '';
    return (await r.json()).description || '';
  } catch { return ''; }
}

/**
 * @param input GitHub URL
 * @param importDir directory holding imported bundles + their repos.json
 * @param taken (slug) => existing manifest entry or undefined, to avoid clobbering other repos
 * @returns manifest entry
 */
export async function importRepo(input, importDir, taken) {
  const gh = parseGithubUrl(input);
  if (!gh) { const e = new Error('Please paste a public GitHub repository URL, like https://github.com/owner/repo'); e.status = 400; throw e; }

  // Re-importing the same URL refreshes it; a different repo with the same name gets an owner-prefixed slug.
  let slug = gh.repo;
  const existing = taken(slug);
  if (existing && existing.url.toLowerCase() !== gh.url.toLowerCase()) slug = `${gh.owner}-${gh.repo}`;
  const clash = taken(slug);
  if (clash && !clash.imported) { const e = new Error(`"${slug}" is a built-in repo already.`); e.status = 409; throw e; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firstpr-'));
  const repoDir = path.join(tmp, 'repo');
  try {
    try {
      await run('git', ['clone', '--depth', '1', '--single-branch', '--', gh.url, repoDir], {
        timeout: CLONE_TIMEOUT, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }, windowsHide: true,
      });
    } catch (e) { const err = new Error(friendly(e, 'Clone')); err.status = 422; throw err; }

    try {
      await run(GRAPHIFY, ['update', '.'], { cwd: repoDir, timeout: GRAPHIFY_TIMEOUT, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (e) { const err = new Error(friendly(e, 'Graphify')); err.status = 500; throw err; }

    if (!fs.existsSync(path.join(repoDir, 'graphify-out', 'graph.json'))) {
      const e = new Error('Graphify did not produce a graph. The repository may have no supported source code.'); e.status = 422; throw e;
    }

    const description = await fetchDescription(gh.owner, gh.repo);
    const { entry } = prepareBundle(repoDir, path.join(importDir, slug), { slug, name: gh.repo, url: gh.url, description });
    if (entry.nodes === 0) {
      fs.rmSync(path.join(importDir, slug), { recursive: true, force: true });
      const e = new Error('No classes, functions or files were found in that repository.'); e.status = 422; throw e;
    }
    if (entry.nodes > MAX_NODES) {
      fs.rmSync(path.join(importDir, slug), { recursive: true, force: true });
      const e = new Error(`That repository is too big for the browser graph (${entry.nodes.toLocaleString()} nodes, limit ${MAX_NODES.toLocaleString()}).`); e.status = 422; throw e;
    }
    entry.imported = true;
    upsertManifest(path.join(importDir, 'repos.json'), entry);
    return entry;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
