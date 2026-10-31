---
name: firstpr
description: Plan a first open-source contribution using a FirstPR server's Graphify knowledge-graph tools. Use when the user wants to understand an unfamiliar repo, find where a "good first issue" should be fixed, or check the blast radius of a change before opening a PR.
---

# FirstPR skill

FirstPR exposes the same graph tools its Gemma 4 agent uses over plain HTTP, so any coding agent
(Codex, Gemini CLI, Cursor and others) can reason over a Graphify knowledge graph without
reading the whole repo.

Set `FIRSTPR_URL` to the deployed app (e.g. `https://<your-app>.cloudwaysapps.com`) or `http://localhost:3000`.

## Tools

All calls are `POST $FIRSTPR_URL/api/tool/<repo>/<tool>` with a JSON body. List repos with `GET $FIRSTPR_URL/api/repos`.

| tool | body | use it to |
|---|---|---|
| `repo_overview` | `{}` | get core abstractions and communities first |
| `search_graph` | `{"query": "tokenizer encode"}` | find node ids |
| `explain_node` | `{"node": "<id or name>"}` | see callers, callees, imports, inheritance with file:line |
| `find_path` | `{"from": "A", "to": "B"}` | explain how two parts connect |
| `impact_of_change` | `{"node": "<id>"}` | blast radius, affected files, likely tests |
| `nodes_in_file` | `{"file": "model.py"}` | list symbols in a file |
| `read_source` | `{"file": "model.py", "start_line": 90, "end_line": 140}` | read real code |

Example:

```bash
curl -s -X POST "$FIRSTPR_URL/api/tool/nanoGPT/impact_of_change" \
  -H 'Content-Type: application/json' -d '{"node":"CausalSelfAttention"}'
```

## Workflow for a good-first-issue

1. `repo_overview`, then `search_graph` with the issue's key nouns.
2. `explain_node` on the 1-3 best hits; `read_source` around their line numbers.
3. `impact_of_change` on the node you plan to edit; note dependents and `likely_tests`.
4. Write the plan: where the change goes, what could break, numbered steps, tests to run, a PR title.
5. Only cite files and functions that the tools returned.
