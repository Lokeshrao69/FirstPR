# FirstPR: submission and pitch kit

## Submission form

**Project name:** FirstPR

**Tagline:** Map an open-source AI repo. Ask it anything. Ship your first PR.

**Description:**
FirstPR helps first-time contributors understand big open-source AI codebases. It uses Graphify to turn a repo into a knowledge graph of its classes, functions, calls, imports and docs. A Gemma 4 agent then explores that graph with 7 function-calling tools: search, explain, shortest path, blast radius, overview, nodes-in-file and read-source. Answers cite real files and line numbers, and the cited nodes light up on an interactive graph.

There are three modes. **Ask the codebase** explains how things work. **Plan an issue** turns a good-first-issue into a PR plan with blast radius and tests to run. **Debug a screenshot** uses Gemma 4's image input to read a traceback and find the code responsible.

It is fully open source (MIT). It runs on Gemma 4 through the Gemini API, or on any self-hosted open-weight model through Ollama or vLLM. It ships an agent skill so coding agents like Codex or Gemini CLI can use the same graph tools, and it is deployed live on Cloudways.

**Tech:** Gemma 4 (Gemini API), Graphify, Node.js, Express, force-graph, Cloudways by DigitalOcean

**Tracks:** Best Open-Source AI Project · Best Use of Gemma 4 · Best Use of Graphify · Best Use of Cloudways

## 3-minute demo script

1. **Hook (20s).** "Hacktoberfest this year is about open-source AI. But opening smolagents for the first time means facing 3,000+ symbols. Where do you even start? FirstPR gives you a map and a guide."
2. **The map (25s).** Switch to **smolagents** and show the full graph: "Graphify built this from the AST. Every dot is a class, function or doc, and every line is a call, import or inheritance." Search `CodeAgent`, click it and show the callers, callees and code.
3. **Ask (40s).** Switch to **nanoGPT** and click "How does a forward pass flow through GPT, Block, attention and MLP?" Open the **trace** and point out that Gemma 4 called `search_graph`, `explain_node` and `find_path`. Then show the cited nodes lighting up in the graph and click one.
4. **Plan an issue (45s).** Open the **Plan an issue** tab and use the `top_p` sampling suggestion. Show the plan: the file and line, the **blast radius** from `impact_of_change`, the steps and a PR title. "That's a newcomer's first PR, scoped."
5. **Screenshot (30s).** Open **Debug a screenshot** and use the sample error image. Gemma 4 reads the traceback, finds `GPT.forward` at `model.py:L173` and explains `block_size`.
6. **Close (20s).** "It's open source and MIT-licensed. It runs on Gemma 4 or any open-weight model on your own machine, has an agent skill so other coding agents can use it, and is live on Cloudways. Add any repo with one Graphify command."

## Likely judge questions

- **Why not just RAG?** Retrieval returns chunks of text. The graph captures structure, such as who calls what and what breaks if something changes. Paths and blast radius can't be computed from chunks.
- **Does it hallucinate?** Every node chip is checked against the graph on the server. The system prompt forbids inventing files, and the trace shows every tool result the agent used.
- **How do I add a repo?** Run `./scripts/add-repo.sh <github-url>`. It runs `graphify update` (AST only, no LLM cost) and builds a bundle.
- **Why Gemma 4?** It's open-weight under Apache-2.0, has native function calling and image input, and comes in sizes small enough to self-host. The same code runs on Ollama.
- **What's next?** Live repo ingestion, GitHub issue import by URL, and automatic "good first issue" ranking by blast radius.
