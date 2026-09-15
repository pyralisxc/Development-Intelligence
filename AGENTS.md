# Development Intelligence agent guide

This repository owns the standalone Development Intelligence technical-intelligence service.

## Product boundary

Development Intelligence owns **one intrinsic evidence graph**. Source inspection, runtime observation, parity analysis, Git history, and future external analyzers are inputs/lenses over that graph; no external tool owns Development Intelligence truth, persistence, or lifecycle.

Development Intelligence provides technical evidence. It does not decide product intent or development workflow and must not depend on custom agent methodologies.

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
12. The human graph viewer and agent tools project the same canonical graph.

## Accepted checkpoint

The portable accepted graph path is:

`/.development-intelligence/graph.ndjson`

The checkpoint is deterministic, text-oriented, excludes its own directory from source fingerprinting, and belongs to the inspected project repository. Git owns accepted history.

## Verification

Run `npm run verify` for every meaningful change.

Permanent evidence should protect durable product/infrastructure contracts rather than historical implementation shape.
