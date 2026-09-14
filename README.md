# Development Intelligence

Development Intelligence is a project-neutral MCP tool service for technical software truth.

It exposes two independent capabilities:

- **Codebase Memory** — structural code intelligence (search, architecture, call/data-flow tracing, blast radius, coverage).
- **Parity Engine** — evidence-backed comparison across observable technical representations such as source, UI/runtime, HTTP/API, MCP, structured configuration, tests, and documentation.

Development Intelligence is tooling, not a development methodology. It contains no product intent, workflow stages, build authorization, PR orchestration, or agent-routing policy.

## Core rules

- Codebase Memory and Parity Engine are independent siblings.
- Parity Engine has **no project-specific extractors** and requires **no semantic project configuration**.
- Generic analyzers may understand languages, frameworks, protocols, and formats; analyzer behavior may never branch on project identity.
- Project-declared semantics are observations, not universal schema.
- Naming differences are preserved rather than normalized away.
- Heuristic relationships retain strategy/evidence/confidence and never silently become facts.
- `unresolved` and `unavailable` are valid results.
- Runtime observation is read-only.
- Development Intelligence may mutate only its own derived source mirrors, Codebase Memory indexes, and parity scan state.

See [Architecture](docs/architecture.md) and [Operations](docs/operations.md).

## Public MCP surface

Shared:

- `list_projects`
- `project_status`
- `refresh_codebase`
- `delete_project` (derived state only)

Codebase Memory:

- `index_status`
- `search_graph`
- `search_code`
- `get_code_snippet`
- `trace_path`
- `query_graph`
- `get_graph_schema`
- `get_architecture`
- `check_index_coverage`
- `detect_changes`
- `ingest_traces`

Parity Engine:

- `scan_parity`
- `query_parity`
- `diff_parity`
- `parity_status`

`index_repository(repo_path=...)` is intentionally an internal hosting primitive rather than the normal public interface. `manage_adr` is intentionally absent because decisions/intent are not neutral technical observations.

## Requirements

- Node.js 22+
- Git
- `codebase-memory-mcp` 0.10.8 (or a separately verified compatible release) available as `codebase-memory-mcp`
- persistent storage for `DEVINT_DATA_DIR` and, in production, Codebase Memory cache state

The Parity Engine uses TypeScript 5.8.3 as a runtime parser for JS/TS/JSX/TSX.

## Quick start

```bash
cp config/projects.example.json config/projects.json
cp .env.example .env
npm install
npm run verify
npm run build
npm start
```

Configure at least one project in `config/projects.json` and set any referenced credential environment variables.

Health:

```bash
curl http://127.0.0.1:8787/health
```

MCP endpoint:

```text
POST /mcp
```

The modern MCP protocol revision `2026-07-28` is served statelessly. A limited initialize-era compatibility path is retained for older clients.

## Project configuration

Project configuration tells Development Intelligence **where it may observe**, never what a project means.

Allowed operational configuration includes:

- repository URL;
- default/allowlisted Git refs;
- server-side Git credential environment variable;
- allowlisted runtime origins;
- runtime request header values loaded from environment variables.

Not allowed as architecture:

- surface/capability ontologies;
- project-specific action maps;
- human↔MCP parity maps;
- per-project semantic extractors;
- project-specific analyzer code.

## Refresh model

`refresh_codebase`:

1. verifies the requested ref is allowlisted;
2. fetches the managed bare mirror with server-side credentials;
3. resolves the exact commit SHA;
4. materializes an immutable detached worktree;
5. indexes that worktree into a **new internal Codebase Memory generation**;
6. verifies the new index is healthy;
7. atomically selects the new source/index pair;
8. prunes old derived generations according to `DEVINT_KEEP_GENERATIONS` (default `2`).

A failed index never replaces the selected last-known-good generation.

## Verification

```bash
npm run verify
```

The durable suite currently protects:

- atomic last-known-good Codebase Memory promotion;
- bounded generation retention;
- clean public project identity;
- universal Parity discovery without project rules;
- secret-like structured-value redaction;
- tool-only public MCP surface;
- MCP `2026-07-28` discovery/header/result/cache contract;
- generic-boundary source guardrail.

See [Testing](docs/testing.md).
