# Product direction

## Identity

Development Intelligence is the **evidence layer for software development**.

It turns exact Git revisions and bounded technical observations into one inspectable model of what a software project contains, how its parts connect, what changed, what remains uncertain, and whether important representations agree. People use that intelligence through the Workbench. Agents use the same intelligence through MCP.

The graph is the internal model, not the product identity. The product outcome is faster, more trustworthy understanding before a person or agent decides or changes anything.

## Who it is for

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

Development Intelligence has two equal product surfaces over the same capabilities:

- **Workbench** — the human surface for overview, exploration, inspection, source/evidence review, change analysis, parity contracts, and connected technical sources.
- **MCP** — the agent surface for the same project, revision, graph, code, architecture, coverage, evidence, change, and parity intelligence.

Neither surface owns separate truth. A capability that matters to one surface should normally be available to the other unless the difference is inherently presentational.

Each inspected project remains autonomous:

- Git/source owns implementation truth.
- The project owns product intent and project-specific architecture rules.
- Accepted semantic graph history is committed with that project when the project chooses to adopt it.
- Development Intelligence owns its generic graph model, analyzers, evidence discipline, and query contracts.
- Runtime observations, external analyzers, and technical sources may contribute evidence but never become hidden authorities.

## Product principles

1. **Truth before advice.** Establish exact, inspectable technical reality before asking an agent to interpret or change it.
2. **One model, many lenses.** Code, architecture, parity, change, evidence, and visualization remain projections of one intrinsic graph.
3. **Exact history matters.** Current HEAD, a PR proposal, its base, its accepted result, and any historical commit are distinct identities.
4. **Absence requires coverage.** “Not found” is not “does not exist” when inspection was incomplete.
5. **Uncertainty stays visible.** Candidate, unresolved, unavailable, partial, and conflicting evidence are valid outcomes.
6. **Humans and agents share capability.** The Workbench and MCP must not drift into separate products or intelligence backends.
7. **Projects keep their meaning.** Generic analysis may understand technologies and explicit source-adjacent declarations; it may not invent product intent or branch on project identity.
8. **Accepted truth travels with source.** Git owns durable accepted graph history; service caches and checkouts are disposable.
9. **Observation is bounded.** Repository, runtime, and technical-source access is allowlisted, read-only, credential-safe, and explicit.
10. **Complexity must earn permanence.** New persistence, providers, abstractions, team concepts, or workflow controls must improve trustworthy understanding enough to justify their carrying cost.

## What Development Intelligence is not

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

## Current truth

As of release **v2.9.0**, the production service at `https://devint.cardforges.com` provides:

- one schema-v2 intrinsic graph with semantic, structural, and representation layers;
- exact Git revision resolution for commits, branches, tags, and explicit pull-request head/base/result identities;
- accepted/working/candidate graph lifecycle with deterministic Git-owned semantic checkpoints;
- graph search, grouped multi-query search, relationship tracing, exact-revision source search/snippets, architecture, coverage, evidence, change, parity, and caller-owned Parity Contract evaluation;
- a human Workbench and modern MCP `2026-07-28` surface over the same intelligence;
- TypeScript/JavaScript, C#, Java, Python, CSS, structured-text, and Unity serialized/configuration analysis at the precision disclosed by `get_graph_schema`;
- optional source-adjacent generic semantic declarations;
- allowlisted runtime observations and generic bounded read-only HTTP technical sources;
- dynamic inspection of authorized GitHub-owner repositories plus explicitly configured projects;
- private owner access, machine bearer access, and hosted OAuth with shared one-time authorization-code state where horizontal scaling requires it;
- stateless reconstruction of canonical source graphs from full immutable Git SHAs, while runtime-overlay snapshots remain ephemeral;
- permanent verification through hermetic cross-language contracts, the packaged-action smoke test, and a pinned CardForge-scale benchmark; additional portfolio replays become release evidence when they are run.

Current boundaries are equally important:

- TypeScript/JavaScript has the deepest cross-file call intelligence; other language analyzers expose narrower, disclosed precision.
- CSS structure is searchable, but component-to-selector usage is not inferred.
- Runtime and configured technical-source observations do not automatically become accepted semantic topology.
- Source-adjacent declarations can state generic current semantics; Development Intelligence does not determine whether those semantics are desirable product intent.
- Arbitrary external analyzers may contribute evidence only after a generic adapter contract exists; no plugin may dictate graph identity or lifecycle.
- The service inspects and explains. It does not write inspected repositories or operate their providers.

For mechanically current details, prefer the deployed `GET /health`, MCP tool schemas, `get_graph_schema`, `package.json`, source, CI, and the accepted `/.development-intelligence/` checkpoint over prose.

## Direction

Development Intelligence should become more useful by increasing the **fidelity, reach, and efficiency of trustworthy project understanding**, not by accumulating unrelated agent powers.

The next durable improvements should come from five directions:

1. **Deeper technical fidelity.** Improve cross-file and cross-language relationships, framework/protocol understanding, evidence quality, ranking, and honest coverage where real repository questions expose gaps.
2. **Stronger temporal intelligence.** Make distant commits, PR proposals, accepted results, regressions, and architectural evolution easier to compare without turning history into a second storage authority.
3. **Better question-to-evidence flow.** Reduce repetitive calls, expose useful neighborhoods and explanations, and help people and agents move from a question to exact evidence without navigating raw graph mechanics.
4. **Broader generic evidence inputs.** Let mature external analyzers, logs, metrics, databases, and provider APIs contribute bounded evidence through stable generic contracts while preserving one graph owner.
5. **Portfolio-grade proof.** Continuously test the product against materially different real repositories, languages, scales, and workflows so generic claims are earned rather than inferred from one flagship project.

The Workbench should increasingly feel like an intelligence workspace, not a graph administration console. MCP should increasingly let agents ask fewer, better-scoped questions. Both should remain explainable projections over the same evidence.

## Decision filter

A proposed capability belongs in Development Intelligence when it materially improves at least one of:

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

This file owns Development Intelligence's product identity, direction, current product position, and enduring non-goals.

- `README.md` is the concise entry point and usage orientation.
- `docs/architecture.md` owns system design, graph semantics, lifecycle, and technical boundaries.
- `docs/operations.md` owns deployment, configuration, authentication, recovery, and production operation.
- `docs/testing.md` owns durable proof strategy and acceptance surfaces.
- `docs/chatgpt-publishing.md` owns ChatGPT publication and OAuth acceptance.
- `docs/vercel-hosting.md` owns Vercel-specific deployment mechanics.
- `AGENTS.md` owns contributor/agent invariants.
- Source, provider state, generated MCP schemas, deployed health, and Git history establish current implementation and operational fact when prose drifts.

Update this document when product identity, intended direction, current capability boundaries, or enduring non-goals materially change. Do not use it as a changelog, task tracker, or speculative roadmap.
