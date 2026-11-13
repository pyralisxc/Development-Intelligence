# Revision-bound technical product profile

> **Documentation authority (2026-11-13):** [DI Product Vision and Principles](https://pyralisholdings.atlassian.net/wiki/spaces/PYPH/pages/4751361/Development+Intelligence+Product+Vision+and+Principles) and [Product Version Roadmap](https://pyralisholdings.atlassian.net/wiki/spaces/PYPH/pages/4128770/Development+Intelligence+Product+Version+Roadmap) in Confluence own durable product purpose, cross-version decisions and milestone meaning. This Git document retains a source-adjacent technical profile and implementation boundaries for the revision containing it; it does **not** own the product roadmap or certify deployed behavior. Read the [Documentation and Evidence Guide](https://pyralisholdings.atlassian.net/wiki/spaces/PYPH/pages/4030466/Development+Intelligence+Documentation+and+Evidence+Guide) before comparing source truth, accepted Main, Preview, releases and provider observations.

The filename is retained for existing source links and contributor compatibility. Its old product-vision owner declaration has been superseded by the published Confluence blueprint.

## Source-adjacent identity

Development Intelligence is the **evidence layer for software development**.

It turns exact Git revisions and bounded technical observations into one inspectable model of what a software project contains, how its parts connect, what changed, what remains uncertain, and whether important representations agree. Integrated owner products consume that intelligence through stable service contracts; agents use MCP directly; the Workbench remains a direct specialist surface for inspection, diagnostics, and independent verification.

The graph is the internal model, not the product identity. The product outcome is faster, more trustworthy understanding before a person or agent decides or changes anything.

## Product context (summary; Confluence owns intent)

Development Intelligence is built first for a solo software owner working with coding agents across many repositories, languages, revisions, providers, and long-running product histories.

Its quality bar is enterprise-grade evidence discipline—exact revision identity, explicit coverage, bounded credentials, deterministic accepted history, inspectable uncertainty, and reproducible release proof—without making teams, organizational administration, or process governance a prerequisite. Team capability may be added later when it directly improves the solo-owner repository experience; it is not a current product promise.

## The job it owns

Development Intelligence helps answer:

- What exists in this exact revision?
- How are code, product concepts, routes, APIs, tools, providers, UI representations, and technical evidence connected?
- What changed between accepted, proposed, historical, and working states?
- Where is the evidence complete, partial, unsupported, skipped, failed, candidate, or unresolved?
- Does an explicit caller-owned expectation match observed project reality?
- What source or evidence supports an answer?

It is most valuable when an agent or owner must reason across a repository without silently relying on stale indexes, disconnected search results, undocumented assumptions, or a single visual graph.

## Product shape

Development Intelligence is a standalone evidence service with one canonical intelligence model and multiple clients:

- **MCP / service contracts** — the canonical programmatic integration surface for project, revision, graph, code, architecture, coverage, evidence, change, parity, and assessment intelligence.
- **Workbench** — the direct specialist human surface for engine development, diagnostics, deep inspection, debugging, and independent verification.
- **AI Systems Control** — the canonical integrated owner-facing product for routine use of Development Intelligence alongside other specialist development systems. ASC is a separate product and deployment; it consumes DI capabilities without owning DI graph/evidence semantics.

These surfaces must not create separate truth. Capabilities that ASC or another client presents should come from Development Intelligence contracts rather than reimplementing intelligence logic outside DI. The Workbench remains supported until integrated clients demonstrate equivalent or intentionally improved access to the relevant capability.

Each inspected project remains autonomous:

- Git/source owns implementation truth.
- The project owns product intent and project-specific architecture rules.
- Development Intelligence rebuilds semantic understanding from the exact selected source graph. Historical interpretation is reconstructed by inspecting that historical Git revision, never replayed as authority over today's code.
- Development Intelligence owns its generic graph model, analyzers, evidence discipline, and query contracts.
- Runtime observations, external analyzers, and technical sources may contribute evidence but never become hidden authorities.

## Engine-level design invariants in this source

1. **Truth before advice.** Establish exact, inspectable technical reality before asking an agent to interpret or change it.
2. **One model, many lenses.** Code, architecture, parity, change, evidence, and visualization remain projections of one intrinsic graph.
3. **Exact history matters.** Current HEAD, a PR proposal, its base, its accepted result, and any historical commit are distinct identities.
4. **Absence requires coverage.** “Not found” is not “does not exist” when inspection was incomplete.
5. **Uncertainty stays visible.** Candidate, unresolved, unavailable, partial, and conflicting evidence are valid outcomes.
6. **Clients share capability contracts.** MCP, the Workbench, AI Systems Control, and future clients must not drift into separate intelligence backends or duplicate DI semantics.
7. **Projects keep their meaning.** Generic analysis may understand technologies and explicit source-adjacent declarations; it may not invent product intent or branch on project identity.
8. **Current truth is reconstructed; history is selected.** DI's present code and semantic understanding comes from the exact inspected graph; Git owns immutable history. Optional review/release records remain separate decisions, not an input to current technical truth. Caches, indexes and checkouts are disposable.
9. **Observation is bounded.** Repository, runtime, and technical-source access is allowlisted, read-only, credential-safe, and explicit.
10. **Complexity must earn permanence.** New persistence, providers, abstractions, team concepts, or workflow controls must improve trustworthy understanding enough to justify their carrying cost.
11. **Exact questions have reproducible answers.** The same normalized query, scope, source revision, analyzer version, and relevant configuration must produce the same conclusion and evidence regardless of agent or date. A changed answer must be attributable to changed source/input or a versioned analyzer improvement. Determinism does not turn heuristics into facts: supported, inferred, candidate, and unknown conclusions remain explicitly distinct.

## Supported technical boundaries and non-goals

Development Intelligence is not:

- a code-writing or repository-mutation agent;
- a development methodology, approval system, or autonomous project manager;
- the source of a project's product intent;
- a generic chat interface pretending that unconstrained language-model output is evidence;
- a central graph database that must remain online for accepted intelligence to exist;
- a project-specific ontology service or collection of repository-specific extractors;
- a replacement for GitHub, CI, code review, runtime observability, physical UI testing, or provider acceptance;
- a claim that every meaningful behavior can be inferred from static source.

These are product boundaries, not temporary omissions. Integrations may connect these systems, but Development Intelligence should not absorb their authority.

## Source-level capability inventory (not a deployment assertion)

At the source revision containing this document, the following code paths and contracts are present. They are **not** a claim that the running Production service, accepted Main, every client, or a public 0.1.0 release has this exact implementation. Use immutable Git SHA, the current MCP schema/graph, authenticated CI, deployment revision and provider observations to establish each actual boundary.

The historical package and GitHub v2.x numbering are separate from Confluence's planned public 0.1.0–1.0.0 product milestones.

Source-level capabilities include:

- one schema-v2 intrinsic graph with semantic, structural, and representation layers;
- exact Git revision resolution for commits, branches, tags, and explicit pull-request head/base/result identities;
- accepted/working/candidate graph lifecycle with deterministic Git-owned semantic checkpoints;
- graph search, grouped multi-query search, relationship tracing, exact-revision source search/snippets, architecture, coverage, evidence, change, parity, caller-owned Parity Contract evaluation, and deterministic evidence-backed assessment;
- a human Workbench and modern MCP `2026-07-28` surface over the same intelligence;
- shared Claim/Proof, Capability Realization, and audit-finding projections through `query_intelligence` and the Workbench, without creating a second graph authority;
- TypeScript/JavaScript, C#, Java, Go, Rust, Python, SQL, CSS, structured-text, and Unity serialized/configuration analysis at the **different precision** disclosed by `get_graph_schema`; full eligible-file coverage is not proof that every callable relationship has been emitted;
- optional source-adjacent generic semantic declarations;
- allowlisted runtime observations and generic bounded read-only HTTP technical sources, with provider-neutral normalized external evidence for generic JSON, deployment state, and database schema responses;
- dynamic inspection of authorized GitHub-owner repositories plus explicitly configured projects;
- private owner access, machine bearer access, and hosted OAuth with shared one-time authorization-code state where horizontal scaling requires it;
- stateless reconstruction of canonical source graphs from full immutable Git SHAs, while runtime-overlay snapshots remain ephemeral;
- revision-bound **source-derived test execution facts**: supported TypeScript/JavaScript test callbacks can establish whether a written assertion must, may or cannot execute on successful completion, or remains unknown. The ordinary investigation route and `get_test_claim_report` share the same source-fact projection and exact source proof fingerprint; this is conditional source truth, not an observed test run;
- local direct Node TestStream observation/correlation for explicitly executed tests; caller-supplied reports are not authenticated CI attestation. Passing test jobs are genuine bounded execution evidence when provider and source identities are established, but aggregate PASS cannot prove which individual assertion executed, nor a real provider write behind a mock;
- permanent verification through hermetic cross-language contracts, the packaged-action smoke test, and a pinned CardForge-scale benchmark; additional portfolio replays become release evidence when they are actually run.

Current boundaries are equally important:

- TypeScript/JavaScript has the deepest compiler-backed cross-file call intelligence; other language analyzers expose narrower, disclosed precision. Some language frontends omit calls entirely without creating unresolved edges, so zero unresolved relationships cannot prove call-graph completeness.
- CSS structure is searchable, but component-to-selector usage is not inferred.
- Runtime and configured technical-source observations do not automatically become accepted semantic topology. Source-derived must-on-success execution constraints can be established independently; attaching a passing run creates a separate source-plus-run assessment without modifying the original source proof.
- Assessment results and caller-required realization facets are ephemeral projections; they are not accepted semantic topology or inferred product intent.
- Source-adjacent declarations can state generic current semantics; Development Intelligence does not determine whether those semantics are desirable product intent.
- Arbitrary external analyzers may contribute evidence only after a generic adapter contract exists; no plugin may dictate graph identity or lifecycle.
- The service inspects and explains. It does not write inspected repositories or operate their providers.

For mechanically current details, prefer the deployed `GET /health`, MCP tool schemas, `project_status`, `get_graph_schema`, DI canonical persistence/currentness, `package.json`, source, and CI over prose. Repository-local `.development-intelligence` files are legacy/self-test compatibility artifacts, not the semantic authority for inspected projects.

## Evidence-led technical improvement surfaces

**The Confluence Product Vision and Version Roadmap own prioritization and future product milestones.** The following are technical analysis and implementation-quality dimensions useful when diagnosing this specific codebase—not a second roadmap.

Development Intelligence's engineering improvements are assessed by the **fidelity, reach, and efficiency of trustworthy project understanding**, not by accumulating unrelated agent powers.

The next durable improvements should come from five directions:

1. **Deeper technical fidelity.** Improve cross-file and cross-language relationships, framework/protocol understanding, evidence quality, ranking, and honest coverage where real repository questions expose gaps.
2. **Stronger temporal intelligence.** Reconstruct and compare distant commits, PR proposals, accepted results, regressions, and architectural evolution on demand without turning those comparisons into a second storage authority.
3. **Better question-to-evidence flow.** Reduce repetitive calls, expose useful neighborhoods and explanations, and help people and agents move from a question to exact evidence without navigating raw graph mechanics.
4. **Broader generic evidence inputs.** Let mature external analyzers, logs, metrics, databases, and provider APIs contribute bounded evidence through stable generic contracts while preserving one graph owner.
5. **Portfolio-grade proof.** Continuously test the product against materially different real repositories, languages, scales, and workflows so generic claims are earned rather than inferred from one flagship project.

The Workbench should remain an excellent specialist intelligence workspace and diagnostic reference, not a second competing control-plane product. MCP/service contracts should increasingly let integrated clients such as AI Systems Control ask fewer, better-scoped questions while preserving explainable evidence.

## Revision-local engineering decision filter

The product-level decision and milestone meaning belong to [Confluence's DI vision](https://pyralisholdings.atlassian.net/wiki/spaces/PYPH/pages/4751361/Development+Intelligence+Product+Vision+and+Principles). For changes to this technical implementation, evaluate whether they materially improve one of:

- fidelity of observed technical reality;
- ability to connect or compare evidence;
- clarity about uncertainty, coverage, provenance, or conflict;
- efficiency with which a person or agent can reach trustworthy understanding;
- portability, reproducibility, or safe operation of that intelligence.

It should be rejected, integrated externally, or kept project-owned when its primary purpose is to:

- decide what a product should mean;
- execute development work rather than inform it;
- impose one methodology or organizational process;
- centralize durable project truth outside Git without a demonstrated necessity;
- add project-specific semantics to the generic service;
- create team/administrative surface that does not improve the solo-owner repository experience;
- hide uncertainty behind a simpler-looking answer.

## Documentation authority

**Confluence owns DI product identity, cross-version vision, intended direction, milestone scope and future non-goals.** See [Product Vision](https://pyralisholdings.atlassian.net/wiki/spaces/PYPH/pages/4751361/Development+Intelligence+Product+Vision+and+Principles) and [Version Roadmap](https://pyralisholdings.atlassian.net/wiki/spaces/PYPH/pages/4128770/Development+Intelligence+Product+Version+Roadmap). Git at an immutable SHA owns implementation and revision-local technical contracts; CI and providers own identified observed execution, deployment and distribution facts. This file is an indexed source-adjacent technical profile, not a competing product blueprint.

- `README.md` is the concise entry point and usage orientation.
- `docs/architecture.md` owns system design, graph semantics, lifecycle, and technical boundaries.
- `docs/operations.md` owns deployment, configuration, authentication, recovery, and production operation.
- `docs/testing.md` owns durable proof strategy and acceptance surfaces.
- `docs/chatgpt-publishing.md` owns ChatGPT publication and OAuth acceptance.
- `docs/vercel-hosting.md` owns Vercel-specific deployment mechanics.
- `AGENTS.md` owns contributor/agent invariants.
- Source, provider state, generated MCP schemas, deployed health, and Git history establish current implementation and operational fact when prose drifts.

Update this document when source-level capability inventory, technical limitations or engine-level contracts materially change at an exact revision. Update the Confluence vision/roadmap for product intent. Do not make this an unversioned changelog, provider-status mirror, issue tracker or independent release claim.
