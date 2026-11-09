# Test-independent source obligations

This is the first constrained step in answering: what can Development Intelligence
establish independently of a written test, and what still requires the test or
runtime observation?

## Existing engine, no duplicate semantic store

The caller supplies an independently specified ParityContract version 1.
The source evaluator rebuilds DI's current exact-Git canonical graph and
creates a temporary, test-excluded proof *view*; it neither alters the graph
nor persists a history of source interpretations. It deliberately removes
written-test sources, their nodes and edges, and source evidence tied to them.

Existing parity evaluation then determines three kinds of evidence:

- established-static-source: a required relationship is actually resolved
  in non-test source. A direct source call or import is structural fact, not
  confirmation that the behavior executes or returns the expected value.
- source-counterexample: a forbidden source relationship is actually present,
  with resolved evidence IDs. This can disprove a particular static contract.
- unproven: a missing, candidate, or otherwise unsupported relationship.
  The test-excluded view never claims closed-world absence or negative proof.

A required source relationship can be independently demonstrated without
consulting a written test's assertion/expected value. This does not establish
the broader behavioral claim protected by the test. No independent test
replacement, behavioral equivalence, authorization effectiveness, dynamic
dispatch, concurrency invariant, or assertion value is claimed.

## Operator-owned, local, exact-revision use

Build the current DI code and supply a caller-authored source contract file
inside the exact source checkout:

    npm ci --no-audit --no-fund
    npm run build
    node scripts/verify-source-obligations.mjs \
      --repo-path . \
      --project Development-Intelligence \
      --expected-sha "$(git rev-parse HEAD)" \
      --contract-file .di-independent-contract.json

Use --require-established only when every requested obligation must have
positive source proof. A forbidden-but-observed source relationship is a
counterexample, not an acceptable pass. The script verifies the source HEAD
before and after its graph build, rejects dirty tracked checkouts, applies
the existing confined contract-file loader, and writes only stdout. Source
proof has no separate historical retention; Git retains code revisions.

## Independent tests and real-source acceptance

The native regression fixture includes a deliberately incorrect written test.
Changing just the test cannot change the supported production call. Removing
the production call removes DI's proof even if the written test remains.
Candidate-only evidence and direct selection of a test-source link cannot be
used as proof.

The Preview-only CI validates separate TypeScript AST call and declaration
facts on actual source, then tests DI's own source relationship proof without
using written-test results. The repositories are:

- DI, exact PR head, no runtime tests consulted as proof.
- CardForge, read-only pin bd2ed93f7746df6fcc1fc7b88f63f5ee798a4084.
  Its source code is never modified.

At the first passing exact-head real-source gate the measurements were:
DI: 248 tracked source files, 24,552 graph edges, 8,040 ms wall time,
576,708,608 bytes RSS. CardForge: 1,444 tracked source files,
83,073 graph edges, 9,981 ms wall time, 884,678,656 bytes RSS.
Each checked one required static link, one resolved forbidden-link
counterexample, and one unproven missing-target obligation. This is a
narrow truth-boundary acceptance over real repositories, NOT a claim to
have independently proved every test or its behavioral obligation.

## What must happen before reducing written tests

The next step is to establish actual behavioral obligations independently:
preconditions, result values, rejection paths, mutation points, dynamic
dispatch, runtime environment, and coverage over applicable executions.
Compare those independent proofs with the written tests only *after* the
independent analysis. Both semantic-similarity and test pass/fail are
insufficient to prove redundancy. Every unknown remains explicit. Test
retirement is a separate owner decision, never an automatic consequence.

Git retains source history; irreproducible runtime receipts still require
their own minimal provenance. The source evaluator does not preserve
semantic history or create a second graph authority.
