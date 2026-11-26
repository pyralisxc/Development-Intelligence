# Local Development Intelligence

The local runtime builds from the current files in a Git checkout, including non-ignored new files. The resulting graph identifies a working tree and records its HEAD separately. Rebuild after changing source files. Builds report producer coverage; a graph is not a backup of the source files.

For Windows, download and extract the `Development-Intelligence-Local-win-x64.zip` artifact built by the Windows package workflow, then run `Install-Local.cmd`. Setup prompts for the checkout and optional install, graph-data and scratch locations, creates a Start Menu entry and builds the current files. Git for Windows must be installed. The ZIP includes its own Node runtime and platform-specific dependencies.

For installation from source on Linux or Windows, use Git, Node.js 22.23.4 or later (23.4 or later on Node 23) and the project's platform-specific dependencies. The minimum includes the requirement of the SCIP TypeScript producer. From the source checkout run `npm ci` and `npm run build`, then:

```text
node scripts/install-local.mjs --repo-path /path/to/your/checkout --project my-project
```

Use `--install-dir`, `--data-dir`, `--scratch-dir`, `--desktop-dir`, `--retain`, `--cache-size`, `--graph-worker-heap-mb`, `--scip-heap-mb` and `--port` to select locations and settings. The two optional heap settings apply separately to the graph worker and SCIP producer; `default` removes an explicit installer setting. They do not cap total process or system memory. The local Workbench can update them later. The installer reports the launcher and desktop or Start Menu entry it created. Defaults keep three graph generations; named targets are retained even when their number exceeds the chosen count. Three graphs per project may also be cached in memory for comparison; set the cache size to zero to disable it. The launcher is named `di-local` on Linux and `di-local.cmd` on Windows. The examples below use that name; invoke the reported full path or add its directory to your PATH.

```text
di-local build
di-local build --target "My graph"
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

Terminal questions use the same question route as the Workbench and MCP. The default output summarizes the answer, graph identity, coverage and pagination. Add `--scope PATH_OR_SUBJECT` to focus the investigation, or `--details` for the complete evidence and graph-filter response; `--offset` and `--limit` select its page.

Committed references resolve using the local Git repository. `main` or `preview` selects the local branch when it exists; after fetching, use `--ref origin/preview --target preview` or `--ref origin/main --target main` to select the updated remote-tracking branch explicitly. Revision builds use a disposable checkout and do not change your files. `compare` without `--base` compares main, preview and working pairwise. Use `--offset` and `--limit` to page each category. The shared comparison reports source changes, moved occurrences, unmatched producer output, analysis differences for unchanged source, and provenance separately. An ambiguous occurrence retains its source identity; graph changes do not by themselves imply a runtime behavioral change. Parity contracts also support evaluating one selected graph against supplied expectations.

Graph names are labels for retained targets and can include spaces. `working` remains the default name for a current-file build for compatibility, but no name requires a particular source: the same name can be used for a committed revision or current files. `working-tree` as a revision selector identifies the most recently retained current-file graph rather than requiring a graph named `working`. A named build publishes its replacement only after graph and index construction succeed.

The `open` command starts the local Workbench and opens the browser. `serve` runs the loopback service in the foreground. `mcp` serves the same local graph through standard input/output to a compatible local agent. Connecting ChatGPT to a local process requires a supported connection or tunnel configured separately.

To link this installation, choose **Link a computer** in the account Workbench on the computer to link, then choose **Open DI on this computer**. Updated Linux and Windows installations register a local link handler. Confirm the Workbench address in the terminal and complete Clerk's device approval; DI starts the linked process and arranges for it to start when the user signs in to the computer. The link is valid for ten minutes and is single use. Direct linking does not replace an existing linked account while its worker may be running; an already-linked installation retains its existing connection. If the browser cannot open the app, install or update DI, or select the computer's operating system and run the displayed fallback command. Add `--no-autostart` to the fallback command to skip startup registration; use `di-local account-autostart on` or `di-local account-autostart off` to change it later. `di-local account-status` checks the connection; `di-local account-run` runs the process in the foreground. An unlinked or offline computer remains visible in the account but cannot execute graph operations.

The Workbench Semantics view derives its understanding from the selected graph. It does not provide separate editing, approval or verification of semantic meanings. Legacy review, promotion-gate and portfolio-bootstrap interfaces are retired; existing stored review data is not deleted. Source-graph backup does not include that old data.

Explore opens the graph first. Search for a subject, choose among matching identities, and select a node to inspect its source and evidence. Pan, zoom and reset the view; the status reports when the displayed neighborhood is bounded. List, table, summary and raw records remain available for the same investigation. `query --text` offers a readable terminal answer; the default JSON remains suitable for scripts and `--details` returns the full evidence response.

Select a relationship line for its source and evidence, or use the inspector's Connections tab to inspect it from the keyboard. Node summaries show related subjects, connected context and source-analysis contributions derived from the selected graph; Graph source and coverage shows the selected source state and analysis coverage. A family can include a shared helper without merging that helper's other workflows into it.

Source search against a selected working graph uses that graph’s local working files, including untracked files. It verifies the working source fingerprint before and after searching; if the files no longer match, rebuild the working graph before searching that graph. A selected committed graph continues to search its Git revision.

The graph's Filters menu includes subject kind, relationship status and direction from a selected subject for the currently loaded projection, plus maximum nodes and traversal depth for requesting a neighborhood. These controls affect the view, not graph construction, and the displayed counts describe the bounded projection rather than the entire repository. Fit graph and zoom controls operate within the graph panel; selected subjects can be passed to the existing question surface. Question filters include a results-per-page setting, and the terminal accepts `query --limit N` with `--offset` for the same graph filter. TypeScript compiler analysis has no fixed default file, byte or binding cutoff. An explicitly supplied graph file limit remains an operator choice and is reported in coverage.

Relationship-kind filtering also applies to the loaded projection; active filters are listed above the graph. Selecting a node highlights its visible connections, with relationship status still distinguished by color. **Explore neighborhood** requests the selected subject's bounded neighborhood, and **Back** returns to the previous graph context. These controls do not assert that unseen relationships are absent. Source opens beside the graph when the workspace has enough room; otherwise it opens as a tab in the Graph group, leaving Questions and Inspector available. Panels can still be moved and resized with Dockview.

`di-local backup --backup-dir PATH` copies retained source graphs into a new backup directory. `di-local restore --backup-dir PATH --data-dir NEW_PATH` restores them into an empty graph location. These commands do not back up repository files or accepted semantic records. Use `history` to find retained graph IDs, `activate --graph-id ID` to select a retained generation, and `unpin --target NAME` to release a comparison target for cleanup on the next build.

The Workbench's Local setup section can change the checkout, data, scratch, backup, retention, memory cache and port settings and start builds, backups and restores. Changing the port takes effect on the next launch. Registering another project currently uses the terminal. The local MCP `compare_graphs` operation exposes the same pairwise comparison to agents.

Questions, node and relationship inspection, audits, parity expectations, and revision comparisons expose a revision-bound investigation selection over the graph they used. It includes selected records, relationship endpoints, attached evidence, source and relationship coverage, and page context. Selection is a view of existing records; missing expectations and audit observations do not become graph facts.

In Explore, a question follows its current result page on the graph. Use **Show graph context** to return to the surrounding graph and **Show investigation** to return to the result. Select a node or line to inspect its records; shift-click selects multiple visible nodes. **Investigate repository audit** selects the audit's sampled graph records. Parity evaluations and comparison pages offer buttons to show observed records on the graph; comparison base and head remain separate source states. Change rows inspect their own side of the comparison, and changed records offer before and after inspection. Questions and inspection in a followed result use that result's graph identity. Source coverage, unresolved relationships, and additional result pages remain visible in their respective operation results.

The `di-local storage` command reports each retained generation, its graph and index bytes, names, and whether it is active or has an index. Active and named generations are protected even when they exceed the selected retention count. Names can share a stored generation when its graph records and substantive metadata match; build time and the matching repository observation time are retained separately as the latest build time. A graph ID alone does not establish that match. Unpinning a name removes the name; eligible historical generations are pruned after a later successful publication. Graph backup copies catalog-referenced generations and their indexes, not source files or disposable analysis caches. To restore a missing or incompatible local index without rebuilding source, use `di-local reindex --target <name>`; omit `--target` for the active graph.
