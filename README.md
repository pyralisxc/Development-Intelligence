# Development Intelligence

Development Intelligence is a standalone, project-neutral technical-intelligence service for software development.

Its core is **one intrinsic evidence graph**. Code structure, runtime/API observations, UI/MCP relationships, configuration, documentation, tests, and future analyzer outputs all contribute evidence to the same graph. Search, tracing, architecture, parity, diffing, and visualization are lenses over that shared reality.

External tools can improve what Development Intelligence observes. They do not own its graph model, lifecycle, query semantics, storage, or hosting.

## Core rules

- Git/source remains authoritative implementation evidence.
- Accepted graph history belongs to the project being inspected, not to a central Development Intelligence database.
- No project-specific extractors or required semantic project configuration.
- Generic analyzers may understand languages, frameworks, protocols, and formats.
- Raw names are preserved; naming differences are evidence rather than normalized away.
- Deterministic relationships may be resolved; heuristics remain candidates with evidence/confidence.
- `unresolved` and unavailable observations are legitimate results.
- Secret-like structured values are redacted before they enter the graph.
- Runtime observation is allowlisted, bounded, GET-only, and read-only.
- Temporary checkouts/caches are disposable compute, not durable state.

See [Architecture](docs/architecture.md), [Operations](docs/operations.md), and [Testing](docs/testing.md).

## A / W / B lifecycle

Development Intelligence uses the Git-native reality lifecycle proven by Product Reality-style workflows:

- **A — accepted:** `/.development-intelligence/manifest.json` plus deterministic text shards under `/.development-intelligence/graph/` committed in the accepted branch.
- **W — working:** a graph generated from the current working/ref state; disposable and not automatically persisted.
- **B — sealed candidate:** a deterministic checkpoint generated for a candidate immediately before commit/promotion.
- After normal Git merge, B is simply the new A. Previous A remains in Git history.

Expectation overlays (sometimes called E by development methodologies) are optional caller evidence, not an intrinsic code-analysis requirement.

The checkpoint source fingerprint excludes `/.development-intelligence/` itself, avoiding a self-referential commit-SHA problem while still detecting source changes. Records are deterministically assigned to hexadecimal NDJSON shards so large accepted graphs do not become one giant binary or text blob in Git.

## Public MCP surface

Shared/status:

- `list_projects`
- `project_status`
- `scan_graph`
- `graph_status`
- `clear_cache` (disposable acceleration only)

Intrinsic graph/code:

- `search_graph`
- `query_graph`
- `trace_path`
- `search_code`
- `get_code_snippet`
- `get_graph_schema`
- `get_architecture`
- `check_graph_coverage`
- `diff_graph`

Parity lens over the same graph:

- `scan_parity`
- `query_parity`
- `diff_parity`

There is no separate Parity database and no external code-graph engine dependency.

## Human graph viewer

Authenticated HTTP deployments expose:

`GET /graph?project=<project>[&ref=<allowlisted-ref>]`

The viewer renders a bounded projection of the same graph queried by agents. It is intentionally a presentation layer, not a second graph model.

## Local development

Requirements:

- Node.js 22+
- Git

```bash
cp config/projects.example.json config/projects.json
cp .env.example .env
npm install
npm run verify
npm start
```

MCP endpoint: `POST /mcp`

Health endpoint: `GET /health`

## Sealing/checking a project graph

When the Development Intelligence package is available in a project checkout:

```bash
npm run build
node dist/src/graphCli.js seal --repo-path /path/to/project --project project-id
node dist/src/graphCli.js check --repo-path /path/to/project --project project-id
```

`seal` writes `/.development-intelligence/manifest.json` and deterministic NDJSON shards under `/.development-intelligence/graph/`. The project then commits that directory with its candidate according to its own repository workflow.

Development Intelligence itself does not commit or merge projects on behalf of callers merely to maintain graph state.

## Project access configuration

Operational configuration may declare only where DI is allowed to observe:

- repository URL;
- default/allowlisted Git refs;
- process-scoped Git credentials;
- allowlisted runtime origins;
- environment-backed runtime request headers.

It must not define project-specific semantic ontologies, product intent, source-authority maps, or analyzer branches keyed by project identity.
