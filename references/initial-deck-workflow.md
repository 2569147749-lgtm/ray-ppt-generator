# Initial Deck Planning

Use this workflow before creating any new deliverable deck.

## 1. Inventory the brief and evidence

Create one request JSON matching `deck-plan.schema.json` input fields:

- `brief`: title, topic, objective, audience, desired conclusion, density, and
  explicit constraints
- `sources`: every user input, document, URL, or declared demonstration source,
  with stable claim IDs
- `narrative`: opening promise, arc, sections, conclusion, and next action
- `slides`: stable ID, working title, purpose, narrative role, content shape,
  intent, signals, item count, density, evidence mode, source claim IDs, and
  planned emphasis candidates

Do not turn an unsupported statement into a sourced claim. A slide with numeric
or chart signals must declare `evidenceMode: "sourced"` with valid claim IDs or
`evidenceMode: "demonstration"`. Demonstration values must be labeled as such in
the authored slide.

Inferred emphasis candidates are hypotheses, not mandatory styling. Allow at
most one primary and two total inferred candidates per slide. Run
`plan-emphasis.mjs` after the visible copy exists only for phrases that will
actually receive local bold, enlargement, color, or highlight treatment.

## 2. Select the visual direction

Before choosing a template, capture the deck occasion and desired mood. Ask for
them when they are not already explicit in the user's brief.

Use registered templates from `assets/templates/index.json` when one clearly
matches the brief or when the user names one. Registered templates include
personal layout contracts and can continue directly into deck planning.
`neo-grid-bold` is the promoted production ID for the corresponding
`beautiful:neo-grid-bold` preview candidate.

When the visual direction is uncertain, or when the user wants options, create
three real cover previews from the bundled production templates. An explicitly
configured `beautiful-html-templates` library may override the bundled source:

```bash
node scripts/preview-template-candidates.mjs \
  --request /absolute/path/to/template-preview-request.json \
  --out /absolute/path/to/template-previews \
  --json
```

The preview request JSON must include:

```json
{
  "title": "Deck title shown on the preview cover",
  "subtitle": "Optional subtitle or promise",
  "author": "Optional author or team",
  "date": "Optional date",
  "occasion": "business review, founder pitch, training, research synthesis...",
  "mood": "confident editorial, quiet literary, warm playful...",
  "density": "speaker-led | balanced | dense",
  "scheme": "light | dark | mixed"
}
```

Open or serve the three returned `previewPath` files and wait for the user to
choose one. Do not show the license notice in the previews. The command writes
`THIRD_PARTY_NOTICES.md` beside the preview manifest; keep that file as a
non-rendered compliance artifact.

Candidates whose IDs start with `beautiful:` are external visual systems, not
registered personal template IDs. Use them to choose or promote a visual
system, but do not pass a `beautiful:<slug>` ID to `plan-deck.mjs` or
`new-deck.mjs`. Use a matching unprefixed template ID only after it appears in
`assets/templates/index.json` with a local `layout-contracts.json` and reviewed
`emphasis-plan.json`.

## 3. Build the plan

Run:

```bash
node scripts/plan-deck.mjs \
  --template yellow-editorial \
  --request /absolute/path/to/deck-request.json \
  --out /absolute/path/to/deck-plan.json \
  --json
```

The planner verifies opening and closing boundaries, source references,
quantitative evidence mode, stable IDs, emphasis limits, and template
compatibility. It calls the registered layout selector for every slide in
sequence and records candidates, rejections, score gaps, confidence, treatment,
and prototype.

Exit `2` means the structure is valid and human review is required. Review the
whole deck for:

- `briefFit`
- `evidenceIntegrity`
- `narrativeCoherence`
- `layoutRhythm`

Review every slide for:

- `requestFit`
- `contentFit`
- `narrativeFit`
- `styleContinuity`

Warnings such as unused source claims or three repeated layouts require an
explicit judgment; they are not automatic permission to alter facts or force a
different layout. Submit the complete review with `--review` and require
`status: "passed"`.

## 4. Initialize from the passed plan

The plan must live outside the output directory because that directory does not
exist yet:

```bash
node scripts/new-deck.mjs \
  --template yellow-editorial \
  --plan /absolute/path/to/deck-plan.json \
  --out /absolute/path/to/deck
```

`--unplanned-scaffold` is reserved for template maintenance and internal tests.
Never use it for a user deliverable.

## 5. Author against the plan

Replace the template demonstration slides. For each authored `<section>`, keep:

```html
<section
  class="slide"
  data-slide-id="stable-id"
  data-layout="registered-layout"
  data-layout-treatment="template-treatment"
  data-visual-intent="declared-intent"
  data-evidence-mode="none"
  data-source-claims="claim-one,claim-two"
  data-plan-item-count="3">
```

Use an empty `data-source-claims=""` for slides without sourced claims. Keep
slide order, title, layout, intent, evidence mode, item count, and evidence
references aligned with `deck-plan.json`. A layout that no longer fits the
authored content means the plan must be revised and reviewed, not silently
bypassed.

If the chosen direction uses third-party template material, write the required
license text only to non-rendered files such as `THIRD_PARTY_NOTICES.md` in the
working or output directory. Do not place MIT, copyright, license, or attribution
boilerplate in slide content, cover copy, footers, speaker notes, or other
user-visible presentation surfaces unless the user explicitly asks for visible
attribution.

## 6. Verify the authored deck

Refresh `deck-project.json` and run the combined draft verifier:

```bash
node scripts/verify-draft.mjs \
  --deck /absolute/path/to/deck \
  --write --json
```

The combined verifier runs `inspect-deck.mjs`, `validate-deck.mjs`, and
`verify-deck-plan.mjs` when `deck-plan.json` exists. The plan verifier compares
slide count, stable ID order, titles, selected layouts, layout treatments,
semantic intents, source claim IDs, and declared item counts. Require
`deckPlanVerification.status: "passed"` before semantic, emphasis, or visual
validation.

The initial plan is a first-draft contract. Later user-requested revisions use
the protected modification workflow and their own atomic change plans.
