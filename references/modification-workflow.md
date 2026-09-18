# Conversational Deck Modification

Use this workflow for every follow-up revision to a generated HTML presentation.

## 1. Resolve and inspect the current deck

Use the most recently generated or revised deck in the conversation. Do not ask for
its path again unless no current deck exists, the user switches presentations, or
multiple candidates cannot be resolved safely.

Run:

```bash
node scripts/inspect-deck.mjs /absolute/path/to/deck --json
```

Read `deck-project.json`, `template-design.md`, `layout-contracts.json`, and only
the assets relevant to affected slides. Stable `data-slide-id` values are the
canonical targets; page numbers and visible titles are aliases that must first be
resolved to those IDs.

## 2. Decompose the entire prompt

A single prompt may contain several independent changes on different slides.
Before editing, split every explicit request into one atomic object in `changes[]`.
Never collapse the prompt into one generic change and never silently drop a clause.

Each change must contain:

- unique `id`
- `type`
- a standard `command`, or `custom-edit` when no standard command fits
- one or more stable slide `targets`
- the original request in `request`
- expected `impact`, including coupled layout effects
- `dependsOn` when order matters
- initial `status: pending`

Do not authorize typography changes unless the user explicitly requests them.
Ordinary content, layout, image, and item-count changes preserve the source
deck's rendered font family and weight by semantic role. For an explicit font
request, add one `typographyAuthorization` to the corresponding atomic change:

```json
{
  "typographyAuthorization": {
    "role": "title",
    "properties": ["fontFamily", "fontWeight"],
    "fontFamily": "Inter",
    "fontWeight": 600
  }
}
```

`targets` supplies the slide scope. Add `itemId` when the request names one
repeated item. List only properties explicitly requested by the user: changing
the family does not permit changing the weight, and changing the weight does
not permit changing the family. Never infer authorization from `type: "style"`,
`command: "custom-edit"`, or a broad request to improve appearance.

Treat phrase-level bold, enlargement, color, and highlighting as semantic
changes, not decoration. Before applying one, update `emphasis-plan.json` with
the exact slide, role, phrase, rationale, source, priority, and treatments.
An explicit user request uses `source: "user"` and overrides an inferred
decision for the same target. Inferred choices rank core conclusions first,
then meaningful key metrics, decisions/actions, and necessary contrasts. Never
infer emphasis for labels, transitions, generic adjectives, isolated function
words, or decorative fragments.

Use `references/change-plan.schema.json` as the shape. Example:

```json
{
  "summary": "Shorten the workflow and revise the metric explanation",
  "changes": [
    {
      "id": "workflow-three-steps",
      "type": "item-count",
      "command": "remove-item",
      "targets": ["workflow"],
      "slide": "workflow",
      "target": "items",
      "itemId": "draft",
      "request": "Change the four-step workflow to three steps.",
      "impact": ["columns", "gap", "connector", "numbering", "text-space"],
      "status": "pending"
    },
    {
      "id": "metrics-copy",
      "type": "content",
      "command": "set-text",
      "targets": ["metrics"],
      "slide": "metrics",
      "target": "title",
      "value": "让效果变化，有迹可循。",
      "request": "Replace the metric explanation.",
      "impact": ["copy", "text-fit"],
      "status": "pending"
    }
  ]
}
```

If one clause is ambiguous, preserve it as `blocked`; continue planning the clear
clauses, but do not execute the batch until the ambiguity could cause conflicting
edits. Ask one concise question that identifies the unresolved clause.

Validate and store the complete plan:

```bash
node scripts/plan-changes.mjs \
  --deck /absolute/path/to/deck \
  --plan /absolute/path/to/requested-changes.json \
  --write --json
```

Unknown targets are errors. Fix the mapping; do not remove the failing change just
to make validation pass.

For every semantic `add-slide`, plan content structure before writing its HTML.
Create a layout request with `changeId`, new stable slide ID, insertion anchor,
narrative role, content shape, semantic intent, evidence signals, item count,
density, and any explicit user-requested layout. Run:

```bash
node scripts/plan-slide-layout.mjs \
  --deck /absolute/path/to/deck \
  --plan /absolute/path/to/layout-request.json \
  --write --json
```

The planner hard-rejects incompatible intent, evidence, content shape, and item
capacity. It ranks eligible layouts by narrative role, density, preferred
capacity, and adjacent-layout variety. Review every decision for `requestFit`,
`contentFit`, `narrativeFit`, and `styleContinuity`, then rerun with `--review`.
Low confidence still requires explicit review; it is not permission to style
arbitrarily. Only after the plan passes may the new section be authored with
the selected registered `data-layout` and template-owned
`data-layout-treatment`.

The current deck keeps its template visual system. The selector does not combine
foreign templates. If no registered layout is compatible, use a planned
`custom-edit` and explicit assertions instead of forcing the nearest layout.
`split-slide` is exempt because it inherits and verifies the source layout.

## 3. Protect the source

Create one working version for the whole prompt, not one version per atomic change:

```bash
node scripts/version-deck.mjs /absolute/path/to/deck --label concise-batch-name
```

Use the printed directory as the working copy and the next current deck. Never
modify the source by default.

## 4. Execute the batch

Apply changes in dependency order. Keep edits scoped to `affectedSlides` unless a
global change is explicitly planned. After each atomic change:

1. set its status to `applied`
2. check its requested content or structure
3. update all coupled properties from the target layout contract
4. leave unrelated slides untouched

Read `references/dom-commands.md`. When every change uses a supported standard
command, dry-run the complete batch:

```bash
node scripts/modify-deck.mjs \
  --deck /absolute/path/to/version \
  --plan /absolute/path/to/version/change-plan.json \
  --json
```

After the dry run succeeds, rerun with `--write`. The command engine applies the
batch in memory and writes HTML, project state, and applied statuses only after
all commands and layout limits pass.

Use direct HTML/CSS editing only for a planned `custom-edit` that cannot be
represented by the supported command vocabulary. Never approximate a custom
visual request with the wrong standard command.

Validate semantic emphasis before styling:

```bash
node scripts/plan-emphasis.mjs \
  --deck /absolute/path/to/version \
  --plan /absolute/path/to/draft-emphasis-plan.json \
  --write --json
```

Review relevance, context, and restraint for every decision, then apply the
review with `--review`. Require `emphasisPlan.status: "passed"` and place each
stable `data-emphasis-id` only on its exact inline phrase. If copy changes make
an existing decision stale, update or remove that decision before visual
audit. Whole semantic items such as `<strong data-edit>` headings are not
phrase-level emphasis candidates.

For item-count changes, recalculate columns or rows, item widths, gaps, connector
geometry, numbering, highlights, and text space together. Do not only add or
delete markup.

For slide additions, deletions, splits, or reordering, assign stable unique IDs and
update DOM order, footer numbering, total count, active state, navigation, and
`deck-project.json`.

After final copy is authored on an added slide, update and review
`emphasis-plan.json` before applying any phrase-level emphasis.

Use `split-slide` only for `agenda` or `process` layouts with stable item IDs.
Choose the semantic split boundary explicitly, provide the complete new slide
section, and list the moved IDs in source order. Keep both resulting item counts
inside their layout contract. Use `custom-edit` for other split structures.

Default to no image changes. Only act when the user explicitly requests an image
change and provides the local source file. For an existing semantic `<img>`
target, use `replace-image`; it copies the asset into the working version, uses
a relative path, preserves meaningful alt text, and rolls back with the rest of
the batch on failure. The command reads the source dimensions and selects a
portrait, square, 4:3-like, or wide composition. Default to `contain`; select
`cover` only when cropping is intentional. Require the target slide to follow
the `media-layout` contract, otherwise use a planned `custom-edit`. Check the
resulting copy/media balance, crop, and readability visually after execution.

## 5. Verify completeness and non-interference

Refresh the project slide map and run static/objective checks through the
combined draft verifier:

```bash
node scripts/verify-draft.mjs \
  --deck /absolute/path/to/version \
  --write --json
```

The combined verifier runs `inspect-deck.mjs`, `validate-deck.mjs`, and
`verify-changes.mjs` when `change-plan.json` exists. Compare the source and
revised versions against the complete plan separately because it needs both
paths:

```bash
node scripts/compare-versions.mjs \
  /absolute/path/to/source \
  /absolute/path/to/version \
  --plan /absolute/path/to/version/change-plan.json \
  --json
```

The comparison must show:

- no `unexpected` changed slides
- every requested change represented in `changes[]`
- any `unchangedPlanned` slide explained and corrected

The visual audit must also show `fontContinuity.passed: true`. It compares each
semantic role's actual rendered font and computed weight with the protected
source, even on planned slides. Exact `typographyAuthorization` entries permit
only their declared slide, role, optional item, property, and value. Added
slides have no source counterpart and instead inherit the template's
`styleConsistency.typographyByRole` contract.

The verifier must show:

- every objective assertion passed
- every completed change advanced from `applied` to `verified`
- failed assertions retain expected and actual values for correction

Do not deliver while any change remains `pending`, `applied`, or `blocked`.

Read `references/semantic-audit-workflow.md`, generate the before/after evidence
report, and review every requested change:

```bash
node scripts/semantic-audit.mjs \
  --deck /absolute/path/to/version \
  --plan /absolute/path/to/version/change-plan.json \
  --json
```

Exit status `2` means objective prerequisites passed and semantic review is still
required. Require a complete review of intent, context, and factual risk, then
confirm `semanticAudit.status: "passed"` in `deck-project.json`.

Read `references/visual-audit-workflow.md` and capture the required visual task
set:

```bash
node scripts/visual-audit.mjs \
  --deck /absolute/path/to/version \
  --plan /absolute/path/to/version/change-plan.json \
  --runtime-cache /absolute/path/to/version/visual-runtime-cache.json \
  --json
```

Exit status `2` means automated capture passed and focused visual review is
required. Open the generated contact sheet and inspect only captures listed in
`reviewScope.requiredCaptureIds`. Exit status `1` means the report contains an
automated Blocker from text clipping, slide overflow, incoherent overlap, a line
crossing text, abnormal edge/internal stripe, style drift, font continuity,
quality contract, semantic emphasis, or an unexpected visual change. Only then
run bounded auto-fix:

```bash
node scripts/auto-fix-visual.mjs \
  --deck /absolute/path/to/version \
  --plan /absolute/path/to/version/change-plan.json \
  --runtime-cache /absolute/path/to/version/visual-runtime-cache.json \
  --max-rounds 3 \
  --json
```

Only explicitly opted-in semantic text overflow can be repaired automatically;
all other findings require a deliberate edit. Explicit font-size, line-height,
line-count, image-upscale, image-distortion, repeated-gap, repeated-alignment,
and style-contract violations are Blockers. Heuristic typography, crop, reuse,
balance, and density findings remain Warnings for manual judgment. The audit
also compares selected slides to source baselines by stable ID: planned target
differences are evidence only, while a material change on an unplanned
neighboring or boundary slide is the Blocker `unexpected-visual-change`. Fix
those findings before review.

When exit status is `1` and the JSON output contains `handoff`, read every issue
from `visual-repair-handoff.json`. Treat the source deck named by `deck` as the
revision source; never promote the retained staging copy. Create a protected
version, represent every handoff issue as an explicit atomic change, and retain
its `visual-finding-absent` condition as visual acceptance evidence. Use the
suggested action only as routing guidance: do not invent replacement copy,
image crops, or layout intent. Apply the complete batch transactionally, rerun
objective and semantic verification when visible content changes, then rerun
the visual gate. Repeat until no Blocker remains; do not send an unresolved
handoff directly to human approval.

For `chart` issues, verify the source values, domain, tick order, labels,
calculation note, and rendered geometry together. For `content-visual` issues,
confirm the intended message before changing the layout or emphasis; the
declared intent is not permission to rewrite business meaning. For
`accessibility` issues, preserve the design hierarchy while correcting contrast,
text size, alternative text, or redundant labels. These categories always
require a deliberate modification-master decision and are never eligible for
automatic fit-text repair.

Exit status `0` from auto-fix means automated capture passed and the JSON
output provides the final report path; it does not mean human approval. Inspect
the contact sheet, then inspect every abnormal capture or item identified by
`reviewScope`. Submit an abnormal-only review JSON through
`visual-audit.mjs --report ... --review ...`, and require
`visualAudit.status: "passed"` in `deck-project.json`. If the user explicitly
declines every rendering route, record `visualAudit.status: "skipped"` and
disclose that the revision is not visually verified. Any later write
invalidates the prior visual gate or skip decision.

## 6. Deliver or restore

Report source path, new version path, all changes grouped by slide, structural
adjustments, validation performed, and remaining factual or visual risks.

To recover an older protected version without overwriting later work:

```bash
node scripts/restore-version.mjs /absolute/path/to/older-version
```

The restored copy becomes a new highest-numbered version and records
`restoredFrom` in project history.
