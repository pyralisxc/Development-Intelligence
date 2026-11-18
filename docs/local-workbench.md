# Local Development Intelligence

The local runtime builds from the current files in a Git checkout, including non-ignored new files. The resulting graph identifies a working tree and records its HEAD separately. Rebuild after changing source files. Builds report producer coverage; a graph is not a backup of the source files.

For Windows, download and extract the `Development-Intelligence-Local-win-x64.zip` artifact built by the Windows package workflow, then run `Install-Local.cmd`. Setup prompts for the checkout and optional install, graph-data and scratch locations, creates a Start Menu entry and builds the current files. Git for Windows must be installed. The ZIP includes its own Node runtime and platform-specific dependencies.

For installation from source on Linux or Windows, use Git, Node.js 22 or later and the project's platform-specific dependencies. From the source checkout run `npm ci` and `npm run build`, then:

```text
node scripts/install-local.mjs --repo-path /path/to/your/checkout --project my-project
```

Use `--install-dir`, `--data-dir`, `--scratch-dir`, `--desktop-dir`, `--retain`, `--cache-size` and `--port` to select locations and settings. The installer reports the launcher and desktop or Start Menu entry it created. Defaults keep three graph generations; named targets are retained even when their number exceeds the chosen count. Three graphs per project may also be cached in memory for comparison; set the cache size to zero to disable it. The launcher is named `di-local` on Linux and `di-local.cmd` on Windows. The examples below use that name; invoke the reported full path or add its directory to your PATH.

```text
di-local build
di-local build-revision --ref main --target main
di-local build-revision --ref preview --target preview
di-local history
di-local query --question "What calls the graph builder?"
di-local query --question "What calls the graph builder?" --text
di-local query --target preview --question "What calls the graph builder?"
di-local query --question "What calls the graph builder?" --details
di-local compare --base preview --target working
di-local compare
di-local open
di-local mcp
```

Terminal questions use the same question route as the Workbench and MCP. The default output summarizes the answer, graph identity, coverage and pagination. Add `--details` for the complete evidence and graph-filter response; `--offset` and `--limit` select its page.

Committed references resolve using the local Git repository. `main` or `preview` selects the local branch when it exists; after fetching, use `--ref origin/preview --target preview` or `--ref origin/main --target main` to select the updated remote-tracking branch explicitly. Revision builds use a disposable checkout and do not change your files. `compare` without `--base` compares main, preview and working pairwise. Use `--offset` and `--limit` to page each category. The shared comparison reports source changes, moved occurrences, unmatched producer output, analysis differences for unchanged source, and provenance separately. An ambiguous occurrence retains its source identity; graph changes do not by themselves imply a runtime behavioral change. Parity contracts also support evaluating one selected graph against supplied expectations.

The `open` command starts the local Workbench and opens the browser. `serve` runs the loopback service in the foreground. `mcp` serves the same local graph through standard input/output to a compatible local agent. Connecting ChatGPT to a local process requires a supported connection or tunnel configured separately.

The Workbench Semantics view derives its understanding from the selected graph. It does not provide separate editing, approval or verification of semantic meanings. Legacy review, promotion-gate and portfolio-bootstrap interfaces are retired; existing stored review data is not deleted. Source-graph backup does not include that old data.

Explore opens the graph first. Search for a subject, choose among matching identities, and select a node to inspect its source and evidence. Pan, zoom and reset the view; the status reports when the displayed neighborhood is bounded. List, table, summary and raw records remain available for the same investigation. `query --text` offers a readable terminal answer; the default JSON remains suitable for scripts and `--details` returns the full evidence response.

Select a relationship line for its source and evidence, or use the inspector's Connections tab to inspect it from the keyboard. Node summaries show their graph-built families, family members and producer contributions; Graph source and coverage shows the selected source state and analysis coverage. A family can include a shared helper without merging that helper's other workflows into it.

The graph's Nodes and Depth controls set the displayed neighborhood per project on this device; they do not limit graph construction. Question filters include a results-per-page setting, and the terminal accepts `query --limit N` with `--offset` for the same graph filter. TypeScript compiler analysis has no fixed default file, byte or binding cutoff. An explicitly supplied graph file limit remains an operator choice and is reported in coverage.

`di-local backup --backup-dir PATH` copies retained source graphs into a new backup directory. `di-local restore --backup-dir PATH --data-dir NEW_PATH` restores them into an empty graph location. These commands do not back up repository files or accepted semantic records. Use `history` to find retained graph IDs, `activate --graph-id ID` to select a retained generation, and `unpin --target NAME` to release a comparison target for cleanup on the next build.

The Workbench's Local setup section can change the checkout, data, scratch, backup, retention, memory cache and port settings and start builds, backups and restores. Changing the port takes effect on the next launch. Registering another project currently uses the terminal. The local MCP `compare_graphs` operation exposes the same pairwise comparison to agents.
