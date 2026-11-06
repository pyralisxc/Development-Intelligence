# DI Preview probe: CardForge review findings

**Observed:** 2026-11-06. **Status:** historical observation; retest before treating it as current.

**Context:** CardForge PR #677, base `5ba16ea856eca3f844a08aa4e526b739bc42556a`, earlier reviewed head `e18b20e2dc69b559b4d0f3c304ac5669cda53a18`. DI's exact-head graph was `repo-e18b20e2dc69b559b4d0f3c304ac5669cda53a18-047454564d`; `audit_repository` reported analyzer `2.16.0-fresh-array-callback-provenance`. This identifies the graph producer, not an independently verified deployment source SHA. DI Preview development was concurrent. CardForge's later fix is a different head and must not be confused with the observed candidate.

## Questions against known findings

An independent review of the earlier CardForge head identified (a) a CSS selector tied to a changed accessible region name, risking loss of desktop layout styling, and (b) repeated array-copying during group accumulation, creating quadratic work. These are findings to investigate, not proof that source analysis alone can establish all user-visible effects.

Using authenticated Preview MCP `investigate` against `project: pyralisxc/CardForge` and `ref: commit:e18b20e2dc69b559b4d0f3c304ac5669cda53a18`, an investigation batch asked about an accessible-name/CSS mismatch and redundant quadratic grouping work. The first was routed to `inspect_entity` for an unrelated `accessibility` field in `OwnerLegalPanel.tsx`; the second to `search_graph` with unrelated candidates, interpreting revision as an ambiguous entity. Neither observed response surfaced the corresponding review concern. The call took approximately 29 seconds and returned a large response.

`audit_repository` for the same project/ref, `limit: 5`, returned one finding about incomplete coverage, not either review concern; approximately 19 seconds. The graph reported 1,857 eligible files complete, with 114 tracked files unsupported. Complete eligible-file processing is not complete behavioral or repository-wide coverage.

**Interpretation:** the tested requests failed to surface these findings. This does not establish that the underlying graph lacks relevant facts, that different queries would fail, or that a source-only audit can prove rendered layout or measured runtime complexity. Targeted evidence retrieval and runtime verification were not part of the DI probe. The CardForge reviewer separately examined the source and later verified desktop behavior on a fixed head.

## Impact traversal and response bounds

`analyze_impact` for the above base/head using `commit:<sha>` selectors, `depth: 1`, and `limit: 10` mapped all nine changed paths. Its 650 base and 672 head seeds exceeded the limit, so both traversals were explicitly `not-performed` with reason `seed-limit`. Zero edges in that response means no traversal, not no impact.

A separate parent-session call with the same pair and `depth: 1`, `limit: 1000` reported both traversals `complete` within the requested bounds and returned 715/737 nodes and 997/1,041 edges. The response was approximately 1.9 MB and the tool transport truncated it, so the complete returned contents could not be reviewed. This is an observed client/transport usability limit, not evidence of graph incompleteness or server failure.

Bare SHA selectors were rejected in the probe; `commit:<sha>` was accepted. This is documented behavior of the observed selector contract, not itself a defect. A status query also reported a stale canonical analyzer/schema identity for HEAD, but historical exact-revision graphs were available. These observations do not establish the current deployed health or freshness.

## Follow-up candidates for the DI development thread

These are proposals, not instructions to the concurrent implementation owner:

1. Evaluate defect-oriented question routing against source-grounded cases, not only entity-name lookup; report when a question cannot be assessed rather than returning an unrelated match as if it answered the question.
2. Explore evidence-linked relationships for selector/accessible-name changes and repeated collection operations. State whether a result is a static candidate, a demonstrated source contradiction, or a runtime/performance observation; never imply runtime execution from source facts.
3. Evaluate separate seed and result budgets, compact summaries, and bounded/paged retrieval for large investigations and impact analyses. Retain explicit traversal status and coverage in each mode.
4. Make deployment/producer identity, canonical graph freshness, exact revision, and unsupported populations easy to identify without implying that a historical graph proves the current service is healthy.

**Retest:** coordinate with the active DI development thread; capture deployed producer identity and exact commit selectors, repeat the same questions and bounded impact request, follow any evidence links to source, and compare with the recorded findings. Test an unrelated negative control to measure noise. Validate layout in a browser and performance with execution evidence separately. Record response size and whether all pages and diagnostics are retrievable.
