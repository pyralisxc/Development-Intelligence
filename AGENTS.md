# Development Intelligence agent guide

This repository owns the standalone Development Intelligence technical-intelligence service.

## Product boundary

Development Intelligence owns **one intrinsic evidence graph**. Source inspection, runtime observation, parity analysis, Git history, and future external analyzers are inputs/lenses over that graph; no external tool owns Development Intelligence truth, persistence, or lifecycle.

Development Intelligence provides technical evidence. It does not decide product intent or development workflow and must not depend on custom agent methodologies.

[Confluence DI Product Vision](https://pyralisholdings.atlassian.net/wiki/spaces/PYPH/pages/4751361/Development+Intelligence+Product+Vision+and+Principles) and [Version Roadmap](https://pyralisholdings.atlassian.net/wiki/spaces/PYPH/pages/4128770/Development+Intelligence+Product+Version+Roadmap) own product identity, intended cross-version direction and milestone outcomes. `docs/product-direction.md` is a revision-local technical capability/boundary profile, **not** the product-intent owner. For material work, read both relevant Confluence intent and exact Git source; CI/provider state remains authoritative for observed implementation and operations.

## Documentation ownership

- `README.md` — concise entry point and usage orientation.
- Confluence DI Product Vision and Version Roadmap — durable product identity, user outcomes, planned milestones, and product decision criteria.
- `docs/product-direction.md` — source-adjacent technical capabilities, design constraints, supported boundaries, and limitations for the inspected Git revision.
- `docs/architecture.md` — system design, graph semantics, lifecycle, and technical boundaries.
- `ORCHESTRATION.md` — project-local branch, seal, preview, provider, evidence, and human-gate execution policy; it points to the operational owners rather than duplicating them.
- `docs/operations.md` — deployment, configuration, authentication, recovery, and production operation.
- `docs/testing.md` — durable proof strategy and acceptance surfaces.
- `docs/chatgpt-publishing.md` and `docs/vercel-hosting.md` — provider-specific publication/deployment mechanics.

Keep each truth in its owner. Update an existing living document when its truth changes; do not create parallel strategy, roadmap, status, or handoff files.

## Non-negotiable invariants

1. One canonical Development Intelligence graph model; do not create separate code/parity/provider graph authorities.
2. Git/source is authoritative implementation evidence. Durable accepted semantic authority lives in DI canonical persistence and remains revision-bound to Git history.
3. A/W/B lifecycle: accepted A is DI-owned semantic authority for an exact accepted source revision, working W is reconstructable evidence for an exact Git revision, and B is the exact candidate revision plus its semantic review delta before promotion.
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

## Accepted semantic authority

Git remains source/history authority. Durable accepted semantic A, semantic-review history, and canonical current W for inspected projects live in Development Intelligence canonical persistence, keyed to exact project revisions. Inspected repositories must not maintain a second machine semantic authority.

The `/.development-intelligence/` checkpoint format remains compatibility/migration machinery generated only in disposable tests or CI artifacts. Development Intelligence and inspected product repositories must not track it as machine semantic authority.

## Verification

Run `npm run verify` for every meaningful change.

Permanent evidence should protect durable product/infrastructure contracts rather than historical implementation shape.
