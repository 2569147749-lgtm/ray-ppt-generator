# Semantic Audit Gate

Run this gate for every deck revision after objective verification. It answers a
different question from `verify-changes.mjs`:

- objective verification: did the requested DOM fact change?
- semantic audit: does the resulting meaning match the user's intent in context?

A revised deck is not deliverable until `deck-project.json` contains
`semanticAudit.status: "passed"` for the current HTML.

## 1. Build the evidence report

```bash
node scripts/semantic-audit.mjs \
  --deck /absolute/path/to/revised-deck \
  --plan /absolute/path/to/revised-deck/change-plan.json \
  --json
```

The script requires every planned change to be `verified`. It creates
`semantic-audit-report.json` with one entry per change containing:

- original user request
- command, type, and stable targets
- objective verification status and assertions
- complete visible slide text before the revision
- complete visible slide text after the revision

It exits with:

- `0`: reviewed and passed
- `1`: automated prerequisite failure or reviewed failure
- `2`: evidence is complete and semantic review is required

## 2. Review every change

For each change, compare the original request with both the before and after
evidence. Review:

- `intent`: the result expresses what the user actually requested
- `context`: surrounding copy, labels, sequence, and slide logic remain coherent
- `facts`: claims, numbers, dates, attribution, and certainty remain supported;
  use `not-applicable` only when the change carries no factual claim

Do not infer that a change is semantically correct merely because its objective
assertions passed.

## 3. Record the review

Create one entry for every change ID:

```json
{
  "reviewer": "AI semantic review",
  "changes": [
    {
      "id": "metrics-title",
      "checks": {
        "intent": "pass",
        "context": "pass",
        "facts": "not-applicable"
      },
      "notes": "The new title emphasizes traceable change without adding a claim."
    }
  ]
}
```

Apply it:

```bash
node scripts/semantic-audit.mjs \
  --deck /absolute/path/to/revised-deck \
  --report /absolute/path/to/revised-deck/semantic-audit-report.json \
  --review /absolute/path/to/semantic-review.json \
  --json
```

The checklist must cover every change exactly once. `intent` and `context` must
be `pass` or `fail`; `facts` may also be `not-applicable`. A failed check requires
notes and sets the gate to `failed`. Fix the revision, rerun objective
verification, regenerate evidence, and review again.

Writing another deck modification automatically invalidates a previously passed
semantic gate.
