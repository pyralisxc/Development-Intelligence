# Development Intelligence agent guide

This repository owns the Development Intelligence MCP service.

## Product boundary

Development Intelligence provides technical evidence. It does not decide product intent or development workflow.

Two sibling capabilities exist:

- `codebase/` — hosted lifecycle and proxying around upstream Codebase Memory.
- `parity/` — cross-representation technical observation and evidence-backed resolution.

Do not couple either capability to custom agent skills or project-specific vocabulary.

## Non-negotiable invariants

1. No project-specific analyzer/extractor in production source.
2. No required semantic project configuration.
3. No inferred intent or source-authority hierarchy.
4. Preserve raw names; do not normalize away naming divergence.
5. Candidate/heuristic relationships retain evidence and confidence.
6. Unresolved is preferable to invented certainty.
7. Runtime scanning is read-only and origin-allowlisted.
8. Git credentials remain process-scoped and never appear in output/state.
9. A failed refresh never replaces the last-known-good source/index generation.
10. Public tool output uses public project identities and does not leak internal generation names or managed filesystem paths.
11. Do not add workflow/PR/deployment orchestration to this service.
12. Do not fork Codebase Memory to solve wrapper/hosting concerns.

## Naming

Use the names exposed to users and agents:

- Development Intelligence
- Codebase Memory
- Parity Engine

Avoid alternate product aliases.

## Verification

Run `npm run verify` for every meaningful change.

Permanent tests should protect public protocol, provenance, safety, and universality contracts—not incidental implementation shape.
