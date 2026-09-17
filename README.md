# Development Intelligence

Development Intelligence is a standalone, project-neutral technical-intelligence service for software development.

Its core is **one intrinsic evidence graph**. Code structure, runtime/API observations, UI/MCP relationships, configuration, documentation, tests, and generic technical-source observations all contribute evidence to the same technical reality. Search, tracing, architecture, parity, diffing, inspection, synthesis, and visualization are projections over that shared model.

The human product is the **Development Intelligence Workbench**. The graph powers the Workbench, but the graph is only one representation of the intelligence.

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
- Runtime and technical-source access is allowlisted, bounded, and read-only.
- Temporary checkouts/caches are disposable compute, not durable state.

See [Architecture](docs/architecture.md), [Operations](docs/operations.md), [Testing](docs/testing.md), and [ChatGPT publishing](docs/chatgpt-publishing.md).

## A / W / B lifecycle

Development Intelligence uses a Git-native accepted/working/candidate lifecycle:

- **A — accepted:** `/.development-intelligence/manifest.json` plus deterministic semantic shards under `/.development-intelligence/graph/` committed in the accepted branch.
- **W — working:** a graph generated from one exact Git revision; structural, semantic, and representation intelligence is disposable and rebuilt as needed.
- **B — sealed candidate:** a deterministic semantic-topology checkpoint generated from the exact candidate before promotion.
- After normal Git merge, B is simply the new A. Previous A remains in Git history.

Expectation/future overlays are optional caller evidence, not accepted current reality.

The checkpoint source fingerprint excludes `/.development-intelligence/` itself, avoiding a self-referential commit-SHA problem while still detecting source changes. Stable semantic records are deterministically assigned to hexadecimal NDJSON shards.

## Public MCP surface

Workbench/intelligence primitives:

- `list_projects`
- `project_status`
- `project_overview`
- `inspect_entity`
- `list_sources`
- `query_source`

Graph/code primitives:

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

## Human Workbench

Authenticated HTTP deployments expose:

- `GET /` — project chooser
- `GET /workbench?project=<project>[&ref=<allowlisted-ref>]` — project workspace
- `GET /workbench/data?...` — human Workbench projections
- `POST /workbench/query` — deterministic read-only Workbench query surface

Old `GET /graph?project=...` links remain a compatibility entry into Explore/Graph.

The Workbench is a human client of the same Development Intelligence capabilities agents use. Its primary destinations are:

### Overview

Readable current-state synthesis:

- quick project notes;
- semantic/structural/representation counts;
- coverage/currentness;
- meaningful accepted → working change;
- important semantic concepts and repository areas;
- connected technical sources.

### Explore

Search the same intelligence and choose the representation that fits the task:

- Summary
- List
- Table
- Graph
- Raw

Graph mode is for relationship-heavy questions; it is not the mandatory navigation model.

### Inspector

Selecting an entity opens a persistent Inspector with:

- Summary / quick notes
- Connections
- Code
- Evidence
- Changes

The Inspector synthesizes graph/evidence records into a human-readable technical description while keeping raw evidence available.

### Query

The Workbench can route deterministic read-only questions across DI capabilities such as overview, search, code, parity, coverage, tracing, changes, and configured technical sources.

This is not intended to masquerade as an unconstrained language model. Query results remain evidence-backed and inspectable.

### Sources

Sources are first-class operational inputs. Built-in sources include Git and allowlisted runtime observations. Optional configured technical sources may represent read-only databases, logs, metrics, provider APIs, or other technical systems.

Technical-source results are observations/evidence. They are **not automatically promoted into accepted semantic topology**.

### Changes

Readable accepted → working semantic change, with structural/ref-to-ref analysis still available through `diff_graph`.

## Technical-source adapters

Projects may optionally configure generic read-only technical sources. A source declares only operational access:

- stable source ID / display label;
- type such as `database`, `logs`, `metrics`, `provider-api`, or `http-query`;
- HTTPS endpoint;
- supported capabilities (`query`, `logs`, `metrics`, `records`);
- environment-backed request headers;
- optional timeout.

DI sends bounded GET queries with query/capability/limit parameters. Credentials stay server-side and outside Git. Source adapters do not define project meaning or ontology.

## Public source, private runtime

Repository visibility and service visibility are independent. DI can live in a public source repository while the running Workbench/MCP remains private.

For hosted ChatGPT use, `DEVINT_AUTH_MODE=oauth` provides a native small single-owner OAuth boundary over the same service:

- owner browser authentication with `DEVINT_OWNER_PASSWORD` and the signed Workbench session;
- OAuth protected-resource and authorization-server discovery;
- public-client registration restricted to allowlisted redirect origins;
- authorization code + PKCE S256;
- short-lived MCP bearer tokens plus refresh tokens;
- `DEVINT_SESSION_SECRET` as the deployment-only root for purpose-separated session/OAuth signing;
- optional `DEVINT_AGENT_TOKEN` fallback for trusted non-OAuth clients.

For direct/local use, `DEVINT_AUTH_MODE=private` keeps the simpler owner-session + static agent-bearer model. `bearer` and trusted `proxy` modes remain available for other deployment topologies.

These secrets stay out of Git. OAuth is an access boundary only: it does not enter the graph, checkpoints, project semantics, or source-authority model. See [ChatGPT publishing](docs/chatgpt-publishing.md) for the hosted setup and mixed Development Intelligence + GitHub release acceptance.

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

The sample environment defaults to `private` auth so local development does not require a public OAuth origin. Switch a hosted deployment to `oauth` when connecting ChatGPT.

Workbench: `GET /`

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
- environment-backed runtime request headers;
- optional read-only technical sources.

For owner-scoped GitHub use, `DEVINT_GITHUB_ALLOWED_OWNERS` authorizes canonical `owner/repository` project identifiers without creating one registry entry per repository. The shared read-only GitHub credential still determines whether a public or private repository can actually be fetched, and dynamic projects inspect only the repository's default `HEAD`. Fixed registry entries remain available when a repository needs explicit refs, runtime origins, headers, or technical sources.

It must not define project-specific semantic ontologies, product intent, source-authority maps, or analyzer branches keyed by project identity.
