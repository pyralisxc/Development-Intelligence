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
