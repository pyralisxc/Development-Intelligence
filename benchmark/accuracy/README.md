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
