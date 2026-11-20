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
    node scripts/run-oss-understanding.mjs --repo-path . --project Development-Intelligence --joern-executable /opt/joern/joern-cli/joern-slice --joern-version 4.0.666 --joern-language JAVASCRIPT --joern-file-filter '.*src.*' --joern-sink-filter '.*'

The worker first runs the matching Joern *parse* frontend to create a disposable
CPG file, then the Joern data-flow slicer over that CPG. Joern v4.0.666's
slicer cannot consume the source directory directly. Its JSON DataFlowSlice
is independently checked against source and joined with the same native
assertion and execution-report identities. The CPG and slice are disposable
producer intermediates, not a second persisted DI graph authority.

For an already produced JSON slice from a separately attested source run,
read it without invoking Joern again:

    node dist/src/graphCli.js joern-evidence --repo-path . --project Development-Intelligence --joern-slice-json joern-local-evidence/dataflow-slice.json --joern-version 4.0.666

To include an existing bounded slice in the graph before ordinary local
questions, pass it at build time instead:

    node dist/src/graphCli.js working-build --repo-path . --project Development-Intelligence --data-dir /path/to/di-data --joern-slice-json /path/to/dataflow-slice.json --joern-version 4.0.666

`revision-build` accepts the same two flags. A working build checks the
working-tree fingerprint before and after reconciliation; a revision build
checks the selected Git revision. Matching source locations do not attest
that the caller-supplied slice was produced from the whole source state.
Joern coverage is partial because a slice is bounded and missing flows do not
prove absence. The build fails before activation if the supplied slice is
invalid or the source changes. This option consumes an existing slice; it
does not automatically install or run Joern during ordinary builds.

That exact-source operation reconstructs canonical W, generates the existing
native assertion inventory and produces an ephemeral graph overlay. A Joern
node is admitted when its tracked, analyzed file is a regular file inside the
checkout, byte-identical to HEAD in Git, and its code and position match the
source directly or by uniquely matching syntax tokens and literal values.
The node records which matching method was used. Joern DDG/REACHING_DEF edges remain candidate
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

Example after building the source, using an actual tracked Node test in an inspected project (replace the example path):

    mkdir -p observations
    node --test --test-reporter=./scripts/node-test-events-reporter.mjs --test-reporter-destination=observations/node.jsonl path/to/inspected-project.test.mjs
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

Use the actual selected source and producer output when evaluating a Joern integration. Historical acceptance fixtures and CI workflows are not part of the current development line.

Upstream references:
https://docs.joern.io/cpg-slicing/
https://github.com/joernio/joern/blob/master/LICENSE
https://nodejs.org/api/test.html

## One-command local OSS worker

The operator-owned script now runs both mature engines against one canonical DI graph in a single process; it does not contact DI's hosted MCP or create another graph database.
After npm run build on a clean exact-source checkout, run:

    node scripts/run-oss-understanding.mjs --repo-path . --project Development-Intelligence --joern-executable /opt/joern/joern-cli/joern-slice --joern-version 4.0.666 --joern-language JAVASCRIPT --joern-file-filter '.*src.*' --joern-sink-filter '.*'

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

The historical capacity benchmark and CI replay remain available through Git history. Current investigation can measure compiler capacity against an actual inspected repository.

### Native Node test evidence across bounded batches

The worker executes only explicitly selected tracked, exact-source test files,
using repeated `--node-test-file` arguments. `--node-test-batch-size` sets the
number per subprocess (default 40, maximum 200). It combines the emitted
native events before correlating them with source assertions; it does not
silently discover or execute other tests. The `node-test-evidence` command
accepts one JSONL report per invocation and supports paging that report.
Python, C#, and other test runners remain outside this Node-specific evidence.

### Joern slice scope

The worker accepts one `--joern-file-filter` and one optional sink filter per
run, and removes its scratch CPG and slice after producing its receipt. To
reuse a validated slice in a graph build, explicitly supply an unused output
path outside the inspected checkout with `--joern-slice-output PATH`, then
pass that file as `--joern-slice-json PATH` to `working-build` or
`revision-build`. The output is created without overwriting an existing file
and can contain source code, so its destination and deletion are the
operator's responsibility. Each build currently consumes one bounded slice;
shard union, automatic Joern execution during normal builds, and exhaustive
negative-flow conclusions are not supported.

The installed local launcher exposes this worker as `di-local oss-evidence`;
it uses the configured checkout and project unless those options are supplied
explicitly. Joern must be separately installed and its executable and version
specified. A later `di-local build --joern-slice-json PATH --joern-version VERSION`
incorporates the retained slice into the working graph.

`di-local joern-build` instead runs the worker and, after successful source
reconciliation, builds and activates the working graph with that slice in one
operation. It retains the old graph if the producer fails or the source changes.
Working builds include current non-ignored files and use a source fingerprint;
the separate exact-revision evidence and native-test worker requires a clean
tracked checkout. `--joern-source` can limit parsing to one source file;
`--joern-java-home` selects a Java installation.
`--joern-memory-mb` (default 1024) and `--joern-timeout-seconds` (default 300
per producer process) bound resources. Windows `.bat` launchers are supported
through a fixed interpreter; arguments containing shell metacharacters are
rejected. A file-scoped slice is partial coverage, not an exhaustive analysis.
Joern can report file-scoped output using a basename; the worker derives the
selected file's repository directory as the source prefix. For a separately
retained slice, use `--joern-project-prefix` on the graph build when needed.

For example, with Joern and Java already installed on Windows:

    di-local.cmd joern-build --joern-executable "P:\tools\joern\joern-cli\joern-slice.bat" --joern-java-home "P:\tools\java\jdk" --joern-version 4.0.681 --joern-language JAVASCRIPT --joern-source src/intelligence/localOperations.ts --joern-depth 3 --joern-sink-filter ".*settings.*"

The source path, language, and optional sink filter are selected by the operator;
they describe the scope of that analysis and are not defaults for other projects.
