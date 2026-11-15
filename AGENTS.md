# Development Intelligence agent guide

This repository owns the standalone Development Intelligence technical-intelligence service.

## Product boundary

Development Intelligence owns **one intrinsic evidence graph**. Source inspection, runtime observation, parity analysis, Git history, and future external analyzers are inputs/lenses over that graph; no external tool owns Development Intelligence truth, persistence, or lifecycle.

Development Intelligence provides technical evidence. It does not decide product intent or development workflow and must not depend on custom agent methodologies.

The [DI Confluence blueprint](https://pyralisholdings.atlassian.net/wiki/spaces/PYPH/pages/720897) and [Product Version Roadmap](https://pyralisholdings.atlassian.net/wiki/spaces/PYPH/pages/4128770) own durable DI product identity, intended direction, public milestones and enduring product boundaries. Read them before material product or architecture decisions. `docs/product-direction.md` is the revision-bound technical/product-interface context at this source commit, not a second vision owner. Immutable Git, CI and actual provider/runtime evidence establish what is implemented and observed.

## Development expectations

Build the complete, well-developed outcome the owner requests. Read the Confluence product blueprint and roadmap and the relevant source before making material product or architecture decisions. Change all connected source, interfaces, and integrations needed for a coherent usable result; do not optimize for the smallest patch or preserve an obsolete implementation merely to reduce the diff. Make routine engineering decisions and continue authorized work without unnecessary permission requests.

Use mature tools for their intended capabilities and integrate their useful outputs directly when they fit. Do not recreate their internals or add redundant wrappers and proof machinery by default. DI should establish source-derived conditions, effects, and execution facts as facts when the code and supported analysis establish them; a separate runtime witness is not a prerequisite for source-derived facts.

Do not add tests by default. The owner prefers real use and examination of real outputs as primary acceptance. Existing tests, fixtures, and workflows are implementation artifacts, not product authority; evaluate them for retirement or revision when they preserve obsolete behavior or obstruct the intended outcome. Preserve exact current CI requirements as operational facts until the relevant workflows are deliberately changed.

## Documentation ownership

- `README.md` — concise entry point and usage orientation.
- **Confluence DI blueprint and roadmap** — cross-version product intent and milestone acceptance; `docs/product-direction.md` — revision-bound product-interface description, current implementation constraints and technical decision context.
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

For source changes, the current repository verification and CI still run `npm run verify`; report their actual results. Do not add tests merely because source changed, and do not treat a passing suite as product acceptance. For documentation-only changes, review the affected text and links; report CI results when available. See `docs/testing.md` for real-use acceptance and current CI details.
