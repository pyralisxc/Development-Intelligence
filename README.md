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

Development Intelligence uses a Git-native accepted/working/candidate lifecycle:

- **A — accepted:** `/.development-intelligence/manifest.json` plus deterministic semantic shards under `/.development-intelligence/graph/` committed in the accepted branch.
- **W — working:** a graph generated from one exact Git revision; structural, semantic, and representation intelligence is disposable and rebuilt as needed.
- **B — sealed candidate:** a deterministic semantic-topology checkpoint generated from the exact candidate before promotion.
- After normal Git merge, B is simply the new A. Previous A remains in Git history.

Expectation/future overlays are optional caller evidence, not accepted current reality.

The checkpoint source fingerprint excludes `/.development-intelligence/` itself, avoiding a self-referential commit-SHA problem while still detecting source changes. Stable semantic records are deterministically assigned to hexadecimal NDJSON shards.

## Public MCP surface

- `list_projects`
- `project_status`
- `scan_graph`
- `search_graph`
- `trace_path`
- `search_code`
- `get_code_snippet`
- `get_graph_schema`
- `get_architecture`
- `check_graph_coverage`
- `get_evidence`
- `diff_graph`
- `query_parity`

There is no separate Parity database, public cache-management API, provider-specific graph query language, or development-methodology API.

`diff_graph` owns change intelligence. Without `baseRef` it compares accepted semantic A with canonical W. With `baseRef` it compares two Git revisions under the same current analyzer. Semantic diffs compare stable semantic topology rather than source locators/evidence references; evidence/analyzer drift is reported separately.

## Coverage and negative answers

Coverage is part of the answer, not an internal counter. Eligible source files are classified as `complete`, `partial`, `unsupported`, `skipped`, or `failed` with a reason where appropriate. Search/architecture/parity output carries a coverage summary, and `check_graph_coverage` provides the detailed file-level view.

DI must not turn “analysis failed or was skipped” into “nothing exists.”

## Human Viewer

Authenticated HTTP deployments expose:

`GET /graph?project=<project>[&ref=<allowlisted-ref>]`

The Viewer is a human navigation shell over the same graph agents query. It provides:

- Architecture, Parity, Code, and Change destinations with human-readable descriptions;
- global search plus common “find a…” shortcuts;
- focused bounded neighborhoods instead of requiring a person to interpret an entire graph at once;
- an Inspector that acts as the primary navigator through readable connections, relationship certainty, and evidence;
- back navigation and fit/zoom controls;
- raw graph records as optional technical detail rather than the main interface.

The graph remains spatial context; it is not intended to force human navigation through dots and lines alone.

## Public source, private runtime

Repository visibility and service visibility are independent. DI can live in a public source repository while the running Viewer/MCP remains private.

For a small single-owner deployment, `DEVINT_AUTH_MODE=private` provides:

- a native browser sign-in using `DEVINT_OWNER_PASSWORD` and a signed session cookie;
- a separate `DEVINT_AGENT_TOKEN` bearer credential for agents/MCP;
- a deployment-only `DEVINT_SESSION_SECRET` for session signing.

These secrets stay out of Git. DI does not require a user-account database merely to support one owner plus explicitly credentialed agents. OAuth-capable clients can still use a thin authenticated gateway in front of DI when their protocol requires OAuth.

## Runtime observation snapshots

Ordinary project/ref queries always address deterministic source-derived W. A runtime scan returns an explicit ephemeral `graphId`; callers must pass that identifier when they want the runtime-overlay snapshot. A previous runtime scan never silently changes subsequent canonical project/ref queries.

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

`seal` writes `/.development-intelligence/manifest.json` and deterministic semantic NDJSON shards under `/.development-intelligence/graph/`. The project commits that directory with its candidate according to its own repository workflow.

Development Intelligence itself does not commit or merge inspected projects on behalf of callers merely to maintain graph state.

## Project access configuration

Operational configuration may declare only where DI is allowed to observe:

- repository URL;
- default/allowlisted Git refs;
- process-scoped Git credentials;
- allowlisted runtime origins;
- environment-backed runtime request headers.

It must not define project-specific semantic ontologies, product intent, source-authority maps, or analyzer branches keyed by project identity.
