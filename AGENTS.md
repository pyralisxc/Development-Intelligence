# Development Intelligence agent guide

This repository owns the standalone Development Intelligence technical-intelligence service.

## Product boundary

Development Intelligence provides technical evidence. It does not decide product intent or development workflow and must not depend on custom agent methodologies.

Two sibling capabilities exist:

- `codebase/` — immutable revision-bundle lifecycle plus an adapter around upstream Codebase Memory.
- `parity/` — cross-representation technical observation and evidence-backed resolution.

The service may be useful to other tools or agents, but usefulness does not imply ownership or dependency.

## Non-negotiable invariants

1. No project-specific analyzer/extractor in production source.
2. No required semantic project configuration.
3. No inferred product intent or hidden source-authority hierarchy.
4. Preserve raw names; do not normalize away naming divergence.
5. Candidate/heuristic relationships retain evidence and confidence.
6. Unresolved/unavailable is preferable to invented certainty.
7. Runtime scanning is read-only, bounded, and origin-allowlisted.
8. Git/runtime credentials remain process-scoped and never appear in artifacts/output.
9. A failed index never replaces the selected last-known-good Revision Bundle.
10. A bundle is promotable only after portable artifact presence and integrity are verified.
11. Public output uses public project/revision identities and does not leak internal CBM names or ephemeral paths.
12. Durable state is artifact/control data; clones, source extraction, CBM caches, and hydration directories are ephemeral.
13. Do not add workflow/PR/deployment orchestration to the technical-intelligence API surface.
14. Do not fork Codebase Memory merely to solve hosting/lifecycle concerns.
15. Do not mutate a canonical revision graph with post-index runtime trace ingestion; any future runtime-derived graph enrichment must be an explicit evidence/overlay revision.

## Hosting boundary

Production is expected to run on managed infrastructure that can scale to zero. The current production adapters are Cloud Storage for immutable artifacts, Firestore for control pointers, a Cloud Run service for MCP/API queries, and a Cloud Run Job for indexing. Local filesystem adapters exist only for development/tests.

Do not reintroduce persistent mirrors, retained worktrees, a durable `CBM_CACHE_DIR`, or an always-running indexing process as product requirements.

## Naming

Use the public names:

- Development Intelligence
- Codebase Memory
- Parity Engine
- Revision Bundle

Avoid aliases that imply another product owns this service.

## Verification

Run `npm run verify` for every meaningful change.

Permanent tests should protect public protocol, provenance, artifact integrity, privacy, safety, and universality contracts—not incidental implementation shape or temporary cloud-provider mechanics.
