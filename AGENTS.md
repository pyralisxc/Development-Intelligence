# Development Intelligence agent guide

This repository owns the standalone Development Intelligence technical-intelligence service.

## Product boundary

Development Intelligence owns **one intrinsic evidence graph**. Source inspection, runtime observation, parity analysis, Git history, and future external analyzers are inputs/lenses over that graph; no external tool owns Development Intelligence truth, persistence, or lifecycle.

Development Intelligence provides technical evidence. It does not decide product intent or development workflow and must not depend on custom agent methodologies.

`docs/product-direction.md` is the living authority for product identity, intended direction, current product position, and enduring non-goals. Read it before material product or architecture work. Source/provider state remains authoritative for implementation and operational fact.

## Documentation ownership

- `README.md` — concise entry point and usage orientation.
- `docs/product-direction.md` — identity, direction, current product position, decision filter, and non-goals.
- `docs/architecture.md` — system design, graph semantics, lifecycle, and technical boundaries.
- `ORCHESTRATION.md` — project-local branch, seal, preview, provider, evidence, and human-gate execution policy; it points to the operational owners rather than duplicating them.
- `docs/operations.md` — deployment, configuration, authentication, recovery, and production operation.
- `docs/testing.md` — durable proof strategy and acceptance surfaces.
- `docs/chatgpt-publishing.md` and `docs/vercel-hosting.md` — provider-specific publication/deployment mechanics.

Keep each truth in its owner. Update an existing living document when its truth changes; do not create parallel strategy, roadmap, status, or handoff files.

## Non-negotiable invariants

1. One canonical Development Intelligence graph model; do not create separate code/parity/provider graph authorities.
2. Git/source is authoritative implementation evidence. The accepted graph is a rebuildable projection committed with the project that it describes.
3. A/W/B lifecycle: accepted A lives in Git, working W is disposable, sealed B is committed with a candidate and becomes A through normal Git merge/history.
4. Optional expectation evidence may be overlaid by a caller, but Development Intelligence never requires a particular product/development methodology.
5. No project-specific analyzer/extractor in generic production source.
6. No required semantic project configuration or hidden source-authority hierarchy.
7. Preserve observed naming differences. Candidate/heuristic relationships retain evidence and confidence; unresolved/unavailable is preferable to invented certainty.
8. Runtime observation is read-only, bounded, and allowlisted. Credentials remain process-scoped and never enter graph checkpoints.
9. Local checkouts, parser caches, indexes, and Vercel/Sandbox files are disposable computation space, never durable graph authority.
10. External tools may contribute evidence but may not dictate DI graph schema, lifecycle, query semantics, hosting, or storage.
11. Do not add development workflow, PR orchestration, or Build-authorization policy to the public intelligence API.
12. MCP, the Workbench, AI Systems Control, and future clients must project the same canonical DI intelligence rather than create client-specific intelligence backends.
13. The Workbench is a specialist diagnostic/reference surface. Do not add control-plane ownership or duplicate ASC product responsibilities merely to preserve it as a competing primary website.

## Accepted checkpoint

The portable accepted graph lives under:

`/.development-intelligence/`

with a deterministic `manifest.json` and hexadecimal NDJSON shards under `graph/`. The checkpoint belongs to the inspected project repository; Git owns accepted history. The source fingerprint excludes the generated directory itself.

## Verification

Run `npm run verify` for every meaningful change.

Permanent evidence should protect durable product/infrastructure contracts rather than historical implementation shape.
