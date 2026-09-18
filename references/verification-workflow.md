# Per-Change Verification

For routine draft verification, prefer the aggregate wrapper:

```bash
node scripts/verify-draft.mjs \
  --deck /absolute/path/to/version \
  --write --json
```

It refreshes the slide map, runs static validation, and invokes available
deck-plan or change-plan checks. Use the lower-level command below when
debugging one change-plan failure or when a workflow requires per-change output
directly.

Run verification after command execution, static validation, and version
comparison:

```bash
node scripts/verify-changes.mjs \
  --deck /absolute/path/to/version \
  --plan /absolute/path/to/version/change-plan.json \
  --write --json
```

The verifier evaluates every change independently and writes:

- updated statuses and assertion evidence into `change-plan.json`
- a batch summary into `verification-report.json`

The process exits with status `1` when any change fails.

## Status Rules

- `pending`: planned but not executed
- `applied`: execution completed but one or more assertions are not verified
- `verified`: every objective assertion passed
- `blocked`: execution or verification requires unresolved user input

Never mark a change `verified` from visual inspection alone when an objective
assertion is available. A failed verification keeps the change at `applied`
unless it was already `blocked`.

## Automatic Assertions

Standard commands derive assertions without requiring the AI to repeat them:

- `set-text`: target text equals the requested value
- `add-item`: item exists, title and body match, numbering is sequential
- `remove-item`: item is absent and numbering is sequential
- `replace-image`: semantic image `src`, `alt`, source dimensions, ratio-derived
  layout, fit mode, and slide layout state match the stored plan
- `add-slide`: new stable slide ID exists immediately after the reviewed anchor,
  and its layout plus `data-layout-treatment` match the passed layout decision
- `delete-slide`: deleted stable slide ID is absent
- `move-slide`: moved slide is immediately after the requested anchor
- `split-slide`: both slides exist, the new slide follows the source, every
  declared item moved from source to new slide, and both item sequences are
  numbered correctly

Explicit assertions may be added to any change to strengthen acceptance.

## Explicit Assertion Types

### Text

```json
{
  "type": "text-includes",
  "slide": "workflow",
  "target": "title",
  "expected": "人工审核"
}
```

Supported types:

- `text-equals`
- `text-includes`

### Repeated items

```json
{
  "type": "item-count",
  "slide": "workflow",
  "target": "items",
  "expected": 3
}
```

Supported types:

- `item-count`
- `item-exists`
- `item-absent`
- `item-text-equals`
- `sequential-numbering`

### Images

Supported types:

- `image-src-equals`
- `image-alt-equals`
- `image-layout-equals`
- `image-dimensions-equal`
- `image-fit-equals`

Run `validate-deck.mjs` before verification to confirm that every local image
reference exists and that recorded dimensions/layout match the copied source
pixels. The verifier then confirms that the intended semantic image target and
its containing slide use the requested adaptive state.

### Slides

Supported types:

- `slide-exists`
- `slide-absent`
- `slide-after`
- `slide-layout-equals`
- `slide-attribute-equals`

## Custom Edits

Every `custom-edit` requires at least one explicit assertion. Translate the
objective portion of the request into deterministic assertions. Keep subjective
requirements, such as "more premium" or "more balanced", for the later semantic
and aesthetic review instead of pretending they are machine-verifiable.

Example:

```json
{
  "id": "custom-workflow",
  "command": "custom-edit",
  "targets": ["workflow"],
  "status": "applied",
  "assertions": [
    {
      "type": "text-includes",
      "slide": "workflow",
      "target": "title",
      "expected": "人工审核"
    },
    {
      "type": "item-count",
      "slide": "workflow",
      "target": "items",
      "expected": 3
    }
  ]
}
```

Objective verification does not replace semantic review or visual review. It
proves that requested structural and textual facts are present in the final DOM.
