# Development Intelligence: independent audit notes

This branch is a shared, evidence-oriented notebook for independent observations of Development Intelligence (DI). It is not an implementation branch, a product roadmap, a substitute for GitHub issues, or a second authority for DI's semantic graph. Findings are point-in-time observations, not assertions about the current deployment.

The active DI development thread owns implementation decisions. Before acting on a note, refresh the deployed producer, relevant branch and open work, reproduce against an exact revision, and coordinate with that thread. Promote enduring product, architecture, operations, or testing facts to their existing owners by normal review; do not merge this notebook into Preview as a parallel living status document without an explicit decision.

## Working convention

Keep a short index here and date-stamped records beside it. Record the producer/analyzer identity if known; repository and exact revision; tool and arguments; observed output; expected evidence; coverage and limitations; and what would count as a meaningful retest. Distinguish a tool call that did not surface a finding from proof that DI cannot represent or find it. Never commit credentials, tokens, private customer data, or full raw response dumps. Update or supersede observations when retested; do not silently rewrite their history.

## Records

- [2026-11-06: CardForge review findings and DI Preview](2026-11-06-cardforge-review-probe.md) — two real review findings used to probe exact-revision investigation and repository audit, plus bounded impact and response-size observations.
