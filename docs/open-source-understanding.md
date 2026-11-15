# Open-source understanding evidence

Development Intelligence keeps one revision-bound canonical graph. Mature open-source
analysis tools provide language and execution observations. DI verifies source
identity, separates source facts from candidate flows and runtime reports,
and routes only admissible evidence into technical conclusions. No second
graph store, proprietary CLI, or production API integration is required.

## Joern: source-dataflow layer

Joern is an Apache-2.0 code-property-graph/dataflow engine. Its documented
joern-slice data-flow command writes JSON DataFlowSlice nodes and edges.

Run on an exact Git checkout with a self-hosted, licensed-and-pinned Joern
installation, never inside the regular DI HTTP request process. The Joern
distribution is large (approximately 1.7 GB compressed at the Nov 2026
release), and its JVM can require significant memory; reserve a disposable
analysis worker for it. No source uploads or service credentials are needed.

After installing/building the repository and pinning the Joern binary/version:

    npm ci --no-audit --no-fund
    npm run build
    node scripts/run-oss-understanding.mjs --repo-path . --project Development-Intelligence --joern-executable /opt/joern/joern-cli/joern-slice --joern-version 4.0.666 --joern-language JAVASCRIPT --joern-file-filter '.*test.*' --joern-sink-filter '.*assert.*' --node-test-file scripts/windows-preflight.test.mjs

The worker first runs the matching Joern *parse* frontend to create a disposable
CPG file, then the Joern data-flow slicer over that CPG. Joern v4.0.666's
slicer cannot consume the source directory directly. Its JSON DataFlowSlice
is independently checked against source and joined with the same native
assertion and execution-report identities. The CPG and slice are disposable
producer intermediates, not a second persisted DI graph authority.

For an already produced JSON slice from a separately attested source run,
read it without invoking Joern again:

    node dist/src/graphCli.js joern-evidence --repo-path . --project Development-Intelligence --joern-slice-json joern-local-evidence/dataflow-slice.json --joern-version 4.0.666

That exact-source operation reconstructs canonical W, generates the existing
native assertion inventory and produces an ephemeral graph overlay. A Joern
node is admitted only when its file is tracked, completely analyzed, a regular
file inside the checkout, byte-identical to HEAD in Git, and its code plus
line/column match source text. Joern DDG/REACHING_DEF edges remain candidate
possible-flow relationships even when both endpoint locations are verified.
Compiler parser AST assertion-span membership is source-proven separately.
No dynamic value, runtime path, assertion outcome or redundant-test
replacement is proven by Joern output alone.

Bounds: <=16 MiB JSON; <=25,000 nodes; <=75,000 edges; <=250
source files; <=1 MiB per source. Unknown positions, source differences,
ambiguous or unrecognized edges are expressly omitted. Missing flow is
never negative coverage. Caller-supplied Joern version/source artifact
is not producer attestation; the exact JSON SHA-256 is reported.

## Node: actual native TestStream events

Use Node's open-source native test runner and its structured test events,
not scraped TAP/spec console output. The repository includes a custom
reporter that writes a compact versioned JSON-lines envelope.

Example after building the source, on a disposable exact-source checkout:

    mkdir -p observations
    node --test --test-reporter=./scripts/node-test-events-reporter.mjs --test-reporter-destination=observations/node.jsonl scripts/*.test.mjs
    node dist/src/graphCli.js node-test-evidence --repo-path . --project Development-Intelligence --node-test-events-jsonl observations/node.jsonl --node-version "$(node --version)"

The Node analyzer binds direct tracked test filenames and literal test
titles back to exactly one source declaration using TypeScript's AST.
Source files must match the selected Git blob. Reporter events retain
pass/fail observations, digest, revision, producer version and known
unmapped/ambiguous population. Compiled test output referenced only by
its filename is not treated as an independently proven source mapping.
User-supplied reporter files are **not** authenticated CI runs; a passing
event is not per-assertion correctness or an independently proved
replacement. Exact CI build/run/artifact provenance and coverage
remain distinct proof gates for subsequent integration.

## Foundation acceptance

The same exact revision and analyzer bind both evidence planes.
Joern projection creates no durable graph authority, and native
runner reports create no accepted semantic meaning. Existing TypeScript
Compiler/SCIP source facts are the baseline; new dataflow paths are
assessed for independently useful evidence instead of double-counting
same callsite references.

Native fixtures verify Joern schema/location/forgery and a *real* Node
test-runner capture. They do not substitute for a genuine Joern JVM
execution. Before hosted Preview acceptance require independently pinned
Joern producer execution, exact source comparison and bounded
precision/false-upgrade/cost review, plus normal Linux, Windows,
SCIP, CardForge and capacity checks. No automatic test removal,
CI weakening, Main promotion or CardForge changes.

Upstream references:
https://docs.joern.io/cpg-slicing/
https://github.com/joernio/joern/blob/master/LICENSE
https://nodejs.org/api/test.html

## One-command local OSS worker

The operator-owned script now runs both mature engines against one canonical DI graph in a single process; it does not contact DI's hosted MCP or create another graph database.
After npm run build on a clean exact-source checkout, run:

    node scripts/run-oss-understanding.mjs --repo-path . --project Development-Intelligence --joern-executable /opt/joern/joern-cli/joern-slice --joern-version 4.0.666 --joern-language JAVASCRIPT --joern-file-filter '.*test.*' --joern-sink-filter '.*assert.*' --node-test-file scripts/windows-preflight.test.mjs

Both engines are optional individually, but an explicit --node-test-file is needed to run a real native test (the worker never guesses which tests to execute). Joern version and expected executable are operator-provided and require independent integrity review; local Joern subprocess success is observed, not proof of a specific binary's provenance. Test subprocess exit and TestStream events are directly observed by the worker, but report bytes remain unauthenticated outside that controlled execution and do not prove assertion-level values. Joern may return source-inaccurate flows; these remain candidate edges even when source spans are exact. All scratch artifacts are removed after the bounded receipt is produced.


## Capacity vs. presentation: complete native events

Node's native TestStream event ledger is now kept **complete within its
explicit bounded input size** before deriving assertion evidence. The prior
100-event display cap no longer removes test results from the evidence
join. The local `node-test-evidence` CLI pages the returned test rows
(default 100, max 1,000), but its full-population counts and assertion
join do not change across pages:

    node dist/src/graphCli.js node-test-evidence --repo-path . --project Development-Intelligence --node-test-events-jsonl observations/node.jsonl --node-version "$(node --version)" --node-events-page-size 100
    node dist/src/graphCli.js node-test-evidence --repo-path . --project Development-Intelligence --node-test-events-jsonl observations/node.jsonl --node-version "$(node --version)" --node-events-offset 100 --node-events-page-size 100 --node-events-expected-sha256 DIGEST_FROM_FIRST_PAGE

A later page refuses a different report SHA-256. The local OSS worker still
returns a compact set of 20 sample test rows but now discloses that this is
only presentation; all uniquely source-bound test events contribute to
assertion-level evidence. Empty/unmatched rows never become negative
coverage, assertion execution, expected-value, or replacement proof.
The input byte/event-size guards remain operational resource protections,
not a restriction of the amount of evidence evaluated inside them.

## Full-source capacity and evidence recovery (analyzer 2.20)

The TypeScript compiler defaults are 4,096 tracked TS/JS roots, 32 MiB of
source and 12,000 resolved bindings instead of 1,600/12 MiB/3,000.
Isolated native analyzers may supply a separately validated budget up to
20,000 roots/256 MiB/200,000 bindings. Saturation keeps independently
resolved positive source facts but does not prove exhaustive negatives.

The native benchmark `scripts/benchmark-oss-compiler-capacity.mjs --fixture`
generates a real 1,655-file exact-Git source oracle with 3,205 independently
specified TypeChecker callsites, plus import-only, shadowed and dynamic
negative examples. The CI workflow `oss-repository-scale-compiler-proof`
also evaluates exact-current DI and pinned read-only CardForge source.
Use `--compare-legacy` to measure old and new positive callsite sets on the
*same* Git SHA. It rejects lost previously resolved source sites and reports
newly supported static compiler identities, not runtime behavior.

### Native Node test evidence across multiple bounded runs

The historical 40-test-file worker cap now governs each subprocess batch,
not the total corpus. Supply repeated `--node-test-file` selectors, optional
`--node-batch-size` (1–40), `--node-max-files` resource budget and a fresh
untracked `--node-evidence-dir observations/native-run` for recoverable
restricted-permission JSONL artifacts. Only explicitly named exact-Git
source files are run; arbitrary repository code is never executed by a
discovery flag alone. The 43-executed/1-unrun fixture verifies serial
20+20+3 batches, unique joined identities and no missing/false results.

The local `node-test-evidence` CLI accepts *repeated*
`--node-test-events-jsonl` paths. A later `--node-events-offset` page needs
the aggregate first-page `--node-events-expected-sha256`. Recovery retains
complete evidence and unknown unrun assertions, rejecting duplicates or
foreign source revisions; compact presentation is not a truth ceiling.

Discovery defaults to `tests/`, `scripts/`, and `packaging/` paths. It
does not imply test absence elsewhere. Use `--native-test-scope
all-supported` or repeated `--native-test-prefix` and
`--native-test-suffix` flags to select tracked supported names.
The report discloses selected and omitted filename candidates.
Python/C#/other runners are not executed by the Node TestStream producer;
their potential obligations remain outside this native coverage.

### Joern source-shard union, full positive flow recovery

An operator can generate several source-filtered `joern-slice` outputs
from a single disposable CPG using repeated `--joern-file-filter` flags,
bounded by a validated per-segment budget and explicit timeout/depth.
Choose `--joern-evidence-dir` to retain bounded slice JSON locally.
The `joern-evidence` CLI accepts repeated `--joern-slice-json` paths.
Recover all candidate edges with `--joern-edge-offset`,
`--joern-edge-page-size` and `--joern-edge-expected-sha256`.
Duplicate, conflicting or unrelated revision/producers fail closed.
A 256-file exact-source fixture verifies two 128-file shards and lossless
100+100+56 candidate edge recovery. This demonstrates source-validating
import and union, not an actual Joern JVM run over that entire fixture.

The pinned Joern 4.0.666 JVM succeeded on a real tiny JS source fixture.
The separate `oss-joern-repository-source-proof` workflow is the
independent DI/CardForge full-source acceptance, not hosted MCP execution.
Any unsupported Joern CPG, memory ceiling, empty source slice or
unmapped assertion remains an explicit unknown, not proven absence.
Source facts, possible-flow candidates, observed test execution and
independently proven replacement remain distinct. No test is auto-deleted.
