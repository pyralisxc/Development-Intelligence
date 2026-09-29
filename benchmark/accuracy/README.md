# Accuracy challenge benchmark

Development Intelligence accuracy benchmarks are exact-revision technical questions with independently established ground truth.

The benchmark is deliberately separate from capacity and hosted-latency evidence:

- capacity answers how much graph DI can construct;
- hosted performance answers how quickly a deployment responds;
- accuracy answers whether DI observed the right entities and relationships without inventing resolved facts.

## Case format

A case is machine-readable and revision-bound:

```json
{
  "version": 1,
  "id": "typescript-route-realization",
  "capability": "api-route-realization",
  "language": "typescript",
  "project": "pyralisxc/Example",
  "ref": "commit:<full-sha>",
  "question": "Which implementation realizes /api/health?",
  "groundTruth": {
    "entities": {
      "required": ["api:/api/health"],
      "forbidden": [],
      "complete": false
    },
    "relationships": {
      "required": [
        { "from": "api:/api/health", "kind": "implemented-by", "to": "symbol:handler" }
      ],
      "forbidden": [],
      "complete": true
    },
    "answerStatuses": ["supported"]
  },
  "provenance": [
    { "kind": "source", "locator": "src/app/api/health/route.ts" }
  ]
}
```

`complete` is important. A benchmark must not count every unlisted observation as a false positive unless the ground-truth set is known to be exhaustive.

Relationships are scored as exact `from | kind | to` triples. Candidate and unresolved behavior should be represented by dedicated cases instead of silently accepting a resolved edge.

## Ground truth

Use the narrowest authoritative source available:

1. compiler or language-service result;
2. exact source inspection and repository-native tests;
3. verified external-tool answer;
4. runtime/provider evidence for live-behavior questions.

A competitor output is not automatically ground truth.

## Scoring

The deterministic scorer reports:

- required observations found;
- missing required observations;
- forbidden observations present;
- recall;
- precision only when the case declares complete ground truth;
- answer-status calibration;
- per-case pass/fail and suite totals.

The first tranche keeps observation collection separate from scoring. That makes the scoring contract hermetic and lets later benchmark runners feed results from DI tools, compiler frontends, or pinned portfolio replays without changing correctness semantics.

Run the scorer with:

```bash
npm run benchmark:accuracy -- benchmark/accuracy/cases.json benchmark/accuracy/observations.json
```

The checked-in portfolio cases and automatic DI observation collector are added incrementally as their independent ground truth is established.

## Semantic-candidate accuracy

Semantic bootstrap uses the same case/scoring contract rather than a separate benchmark authority. Cases may add an optional `groundTruth.semanticCandidates` block:

```json
{
  "semanticCandidates": {
    "universeScopes": ["src/features/authentication", "src/features/editor", "src/shared"],
    "required": [
      {
        "scope": "src/features/authentication",
        "name": "Authentication",
        "origin": "intrinsic-derivation",
        "accepted": false,
        "persisted": false,
        "proofEligible": false,
        "requiresExplicitReview": true,
        "minEvidenceFamilies": 2
      }
    ],
    "forbidden": [
      { "scope": "src/shared" }
    ],
    "complete": true
  }
}
```

Semantic precision is reported only for complete ground truth. `universeScopes` can define a bounded, independently reviewed evaluation universe inside a much larger repository: observations outside that universe remain unjudged rather than being mislabeled false positives. Within a complete universe, extra observed candidates count as false positives.

A required semantic candidate is matched by exact scope plus any optional constraints supplied by the case: name, kind, evidence families, minimum evidence-family count, provenance origin, and authority fields. This lets the benchmark detect both concept errors and authority drift (for example a derived proposal becoming `accepted:true` without review).

The CardForge benchmark uses a pinned seven-scope reviewed universe to produce real-repository semantic-candidate precision, recall, and false-positive rate while preserving the broader repository as unjudged evidence. This is deliberately narrower than claiming repository-wide semantic precision before exhaustive independent ground truth exists.


## Human correction burden and general-question quality

Semantic accuracy is not complete if a candidate set scores well but still forces a reviewer to repair obvious concepts, or if ordinary questions fall back to graph-count prose.

The CardForge real-repository benchmark therefore also reports:

- **correction burden** — the number of reviewed semantic scopes implicated by missing required concepts, forbidden concepts, or false observed concepts inside the complete reviewed universe;
- **T3 general-question grounding** — natural repository questions such as “What does this project do?” must route through repository orientation, use semantic understanding rather than structural-only fallback, avoid topology-count prose, and surface multiple independently reviewed concepts;
- **external tool-call count and latency** for each general question.

A correction burden of zero is meaningful only for the declared reviewed universe. It must not be generalized to the entire repository without exhaustive ground truth.

## Competitor reference snapshots

`benchmark/competitor-reference.json` records dated claims from official competitor sources. The snapshot exists to make market claims visible next to DI's own reproducible measurements, not to create an apples-to-oranges ranking.

Every external numeric claim is marked non-comparable until DI can replay the same dataset, grader, configuration, and metric definition. Competitor output is never benchmark ground truth merely because the vendor published it.


## Conversational semantic depth

Broad semantic questions are not scored as fixed keyword lists. The same repository question may request three different evidence projections:

- `nucleus`: concise, strongest-supported semantic orientation;
- `expanded`: supporting semantic layers and substrates in the same request;
- `exhaustive`: an explicit evidence-qualified candidate census with completeness/truncation disclosed.

The CardForge T3 benchmark therefore does **not** require its five-item T1 semantic-candidate universe to appear in the nucleus prose. Instead, it requires the expanded and exhaustive projections to expose all five reviewed candidate scopes, and requires the exhaustive projection to report an exhausted candidate census. This preserves 100% recall where ground truth is actually complete without teaching DI a preferred summary.

Batched investigation may mix query depths through natural-language intent while retaining one immutable graph context. Explicit `semanticDepth` is available when an agent wants to force one depth for the request.
