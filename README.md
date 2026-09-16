# Development Intelligence

Development Intelligence is a standalone, project-neutral technical-intelligence service for software development.

Its core is **one intrinsic evidence graph**. Git/source structure, semantic declarations, representations, runtime observations, configuration, documentation, tests, and future generic analyzers contribute evidence to the same model. Code, Architecture, Parity, Change, and the human Viewer are lenses over that graph rather than separate intelligence owners.

External tools may improve what Development Intelligence observes. They do not own DI identity, lifecycle, query semantics, persistence, hosting, or product intent.

## Core rules

- Git/source remains authoritative implementation evidence.
- Accepted graph history belongs to the inspected project, not a central DI database.
- No project-specific production extractors or required semantic project configuration.
- Project registry/configuration grants access; it does not teach DI what a project means.
- Semantic, structural, and representation entities have stable identities independent of source line numbers where language semantics permit it.
- Evidence/provenance explains claims; it is not the identity itself.
- Independent observations that disagree remain explicit conflicts rather than silently becoming corroboration.
- Proven relationships are `resolved`; heuristics remain `candidate`; unknowns remain `unresolved`.
- Coverage distinguishes `complete`, `partial`, `unsupported`, `skipped`, and `failed` inspection so absence is never confused with inability to inspect.
- Secret-like structured values are redacted before entering the graph.
- Runtime observation is allowlisted, bounded, GET-only, read-only, and explicitly addressed by snapshot `graphId`.
- Temporary checkouts, graph caches, and runtime snapshots are disposable compute, not durable authority.

See [Architecture](docs/architecture.md), [Operations](docs/operations.md), and [Testing](docs/testing.md).

## A / W / B lifecycle

Development Intelligence uses a Git-native accepted/working/candidate lifecycle:

- **A — accepted:** deterministic semantic topology under `/.development-intelligence/` on the accepted project revision.
- **W — working:** the complete graph regenerated from one exact Git SHA. Canonical W is source-derived and disposable.
- **B — sealed candidate:** deterministic semantic topology generated for a candidate and committed with that project.
- After normal Git merge, B is simply the new A. Previous A remains in Git history.

Expectation/future data is caller reasoning, not accepted current reality inside DI.

The checkpoint source fingerprint excludes `/.development-intelligence/` itself. The manifest records source, topology, evidence, and analyzer fingerprints. Checkpoint validation recomputes semantic topology from persisted shards rather than trusting manifest metadata.

`project_status` reports currentness dimensionally: source/topology acceptance, evidence drift, analyzer drift, supported schema, and checkpoint integrity. Analyzer or evidence changes do not manufacture semantic topology drift.

## Exact revision and snapshot addressing

An allowlisted Git ref is resolved once per operation to an immutable SHA. Checkout, cache identity, graph construction, source search/snippets, and returned metadata use that same revision context.

Canonical source queries use:

- `project` + optional allowlisted `ref`.

A runtime-observation scan returns an ephemeral `graphId`. That ID may be passed to graph/code/viewer tools to inspect the same snapshot. Runtime scans never replace the canonical source W used by later ordinary project/ref queries.

## Public MCP surface

The permanent agent-facing surface is intentionally small:

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

There is no separate Parity scan database, public cache-management API, provider-specific graph query language, or development-methodology API.

`diff_graph` owns change intelligence. Without `baseRef` it compares accepted semantic A with canonical W. With `baseRef` it compares two Git revisions under the same current analyzer. Semantic diffs compare stable semantic topology rather than source locators/evidence references; evidence/analyzer drift is reported separately.

## Coverage and negative answers

`check_graph_coverage` is the authoritative detailed coverage surface. It reports source files as `complete`, `partial`, `unsupported`, `skipped`, or `failed`, with reasons where available.

Search, trace, Architecture, Parity, and evidence responses carry compact coverage context. Agents should not turn an empty result into an exhaustive “does not exist” claim when relevant coverage is incomplete.

## Human graph viewer

Authenticated HTTP deployments expose:

```text
GET /graph?project=<project>[&ref=<allowlisted-ref>]
GET /graph?project=<project>&graphId=<ephemeral-snapshot-id>
```

The Viewer renders the same graph context queried by agents. Architecture, Parity, Code, and Change are presentation lenses only. Candidate/unresolved relationships remain distinguishable, and relationship evidence is inspectable. Change view applies to canonical source/accepted reality rather than runtime snapshots.

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

`seal` writes `/.development-intelligence/manifest.json` plus deterministic semantic NDJSON shards. The inspected project commits that directory according to its own repository workflow. DI does not commit or merge inspected projects merely to maintain graph state.

## Project access configuration

Operational configuration may declare only where DI is allowed to observe:

- repository URL;
- default/allowlisted Git refs;
- process-scoped Git credentials;
- allowlisted runtime origins;
- environment-backed runtime request headers.

It must not define project-specific semantic ontologies, product intent, source-authority maps, or analyzer branches keyed by project identity.
