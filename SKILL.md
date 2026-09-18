---
name: ray-ppt-generator
description: Generate or revise personalized HTML presentations from topics, files, images, websites, or existing decks. Use when the user asks for a PPT, slide deck, pitch deck, 演示文稿, or follow-up slide changes.
---

# Ray PPT Generator

Create a complete, presentation-ready HTML deck. Do not stop at an outline unless the user explicitly asks for one.

## 1. Choose the mode

- **New deck** — read `references/initial-deck-workflow.md`, then continue
  with the workflow below.
- **Existing deck revision** — read `references/modification-workflow.md` and follow it before editing any file.

Before asking the user any question, read
`references/interaction-workflow.md`. Follow its field states, trigger rules,
question-merging rules, dependency order, consent sequence, and interaction
budget. Internal plan, semantic, emphasis, and visual reviews are Agent gates,
not user approval steps.

Treat requests such as changing wording, changing item counts, replacing images, reordering slides, adding slides, deleting slides, or splitting dense slides as existing-deck revisions.

After generating or revising a deck, keep its output directory as the current deck for the conversation. Interpret follow-up requests such as "change page 5", "remove one node", or "replace that screenshot" as revisions to the current deck without asking the user for its path again.

Ask for a path only when there is no current deck in the conversation, the user starts a separate task, or multiple candidate decks make the target genuinely ambiguous.

For revisions, create a protected working copy with `scripts/version-deck.mjs`. Make that new version the current deck. Never overwrite the previous version by default. Reuse the existing template and deployed capabilities instead of rebuilding the presentation from scratch.

A revision prompt may contain multiple independent requests across different
slides. Decompose every request into an atomic `changes[]` entry, resolve each
entry to stable slide IDs, and validate the complete batch with
`scripts/plan-changes.mjs` before editing. Never execute only the first request,
merge distinct requests into a vague summary, or silently discard an unresolved
target. After editing, use `scripts/compare-versions.mjs` to reject changes on
slides outside the plan.

Before authoring HTML for any semantic `add-slide`, describe its narrative
role, content shape, intent, evidence signals, item count, and density in a
layout request. Run `scripts/plan-slide-layout.mjs`, review request fit, content
fit, narrative fit, and style continuity, and require
`slideLayoutPlan.status: "passed"`. The selector keeps the current template's
visual system and chooses only a registered layout, treatment, and prototype.
If no registered layout is structurally compatible, stop and plan a
`custom-edit`; do not force the content into the nearest layout or import a
foreign template. `split-slide` inherits its source layout and does not require
a new layout decision.

Preserve the source deck's rendered font family and weight for every semantic
role by default. When the user explicitly requests a font-family or font-weight
change, record a `typographyAuthorization` on that atomic change with the exact
role, optional item ID, authorized properties, and requested values. Apply only
that scope. A family request does not authorize a weight change, a weight
request does not authorize a family change, and a target-slide request does not
authorize unrelated roles on the same slide.

For supported revisions, read `references/dom-commands.md` and execute the
complete plan through `scripts/modify-deck.mjs`. Use semantic roles instead of
text search or arbitrary CSS selectors. The supported command batch is
transactional: if any command fails, do not leave a partially modified deck.
Use `custom-edit` only when the requested visual structure is outside the
declared layout capabilities, then apply the same validation and comparison
checks.

After execution, read `references/verification-workflow.md` and run
`scripts/verify-changes.mjs`. Standard commands derive objective assertions
automatically. Every `custom-edit` must provide explicit assertions. Do not
deliver while any requested change remains `pending`, `applied`, or `blocked`;
only changes whose assertions pass may advance to `verified`.

Read `references/semantic-audit-workflow.md` and run
`scripts/semantic-audit.mjs`. Compare the original request with the before/after
visible text for every change, review intent, context, and factual risk, and
require `semanticAudit.status: "passed"` for the current revision.

Run phrase-level emphasis planning on demand: only when the user explicitly asks
for emphasis or when you are about to add/change local bold, enlargement, color,
or highlight styling. Then write the intended phrases to `emphasis-plan.json`
and validate them with `scripts/plan-emphasis.mjs`. User-requested emphasis
overrides inference. Otherwise rank candidates as core conclusion, meaningful
key metric, decision/action, then necessary contrast. Do not infer emphasis for
labels, transitions, generic adjectives, isolated function words, or decorative
fragments. Review every decision for relevance, context, and restraint, and
require `emphasisPlan.status: "passed"` before styling the matching
`data-emphasis-id` span.

Then read `references/visual-audit-workflow.md` and run
`scripts/visual-audit.mjs` first, reusing a cached visual runtime when one has
already been resolved. Enter `scripts/auto-fix-visual.mjs` only when the audit
returns an automated Blocker that is eligible for bounded repair. Auto-fix may
repair only explicitly opted-in semantic text overflow, in an isolated copy,
with a declared minimum font size, at most three applied rounds, and a
repeated-action stop. It must not guess repairs for overlap, bounds, lines,
stripes, or cross-version changes. Automated DOM
geometry, text overflow, line crossing, image-stripe, and protected-slide
cross-version checks must pass before manual review. The deck-level style
consistency check must also pass explicit template contracts for fonts,
semantic colors, title hierarchy, slide insets, and footer geometry; inferred
outliers remain review warnings. Semantic-role font continuity compares actual
rendered fonts and computed weights against the source revision and blocks
unrequested drift, including on planned slides. New slides must satisfy the
template's role typography contract. Typography, image integrity, and
repeated-layout contracts also block approval, while heuristic orphan, crop,
reuse, balance, and density concerns remain warnings. Chart scales, values,
labels, and rendered marks must satisfy the template chart contract. Declared content intent and
primary emphasis must match the layout, and visible content must satisfy the
template accessibility contract for contrast, projected size, labels, and
redundant color encoding. The semantic-emphasis gate also requires every
rendered inline emphasis to match an approved exact phrase, role, stable ID,
and treatment. Planned target-slide differences are evidence, not
failures. If the command returns a `handoff`, route every issue through the
modification workflow in a protected revision and rerun semantic and visual
gates; never guess a non-fit-text repair. Inspect every generated desktop
contact sheet from the returned report, inspect only captures or items listed
in `reviewScope.requiredCaptureIds`, and submit an abnormal-only review through
`scripts/visual-audit.mjs`. Abnormal evidence comes only from structured
findings, warnings, Blockers, low-confidence signals, plan mismatches, or
unplanned visual differences recorded in the report. Do not deliver unless
`deck-project.json` records `visualAudit.status: "passed"` for the current
revision, or the user explicitly declined every rendering route and the project records
`visualAudit.status: "skipped"` with that decision. A skipped deck may be
delivered only with a prominent unverified-visuals disclosure.

## 2. Understand the brief

Read `references/preferences.md` first. Treat it as a default, never as a stronger signal than the current request.

Infer all fields already supplied by the user:

- purpose and audience
- topic and desired conclusion
- approximate length
- speaker-led or reading-first density
- visual preference
- available documents, images, screenshots, or URLs
- output location

Apply `references/interaction-workflow.md` to missing decisions. Ask at most one
brief-clarification batch, never repeat supplied information, and use the
quick-draft override when the user asks to judge capability or see an
exploratory result.

## 3. Prepare content

Build a slide narrative before editing HTML:

1. opening promise
2. problem or context
3. core argument or product
4. supporting evidence, process, comparison, or demonstration
5. conclusion and next action

Choose the number of slides from the information volume. Split dense material instead of reducing text until it becomes hard to read.

Never invent business results, research findings, customer quotes, or precise metrics. Mark sample values as demonstration data. Preserve source links for claims that require attribution.

Before initializing a deck, inventory the brief, sources, stable claim IDs,
narrative arc, and every proposed slide in a deck-plan request. Quantitative
slides must reference sourced claims or declare demonstration evidence. Include
at most one primary and two total inferred emphasis candidates per slide; these
are planning hypotheses and do not replace exact-copy emphasis review.

After the visible copy is stable, plan phrase-level emphasis only for phrases
that will actually receive bold, enlargement, color, or highlight treatment.
Start from the template `emphasis-plan.json` when such treatment is needed,
replace demonstration decisions with exact deck text, and run:

```bash
node scripts/plan-emphasis.mjs \
  --deck /absolute/path/to/deck \
  --plan /absolute/path/to/draft-emphasis-plan.json \
  --write --json
```

Exit `2` means structural checks passed and semantic review is required. Review
every decision for relevance, context, and restraint, then rerun with
`--review /absolute/path/to/emphasis-review.json`. Only a `passed` plan may be
implemented. Add its stable `data-emphasis-id` to the exact inline phrase and
use only the listed treatments. User-directed decisions take precedence over
inferred decisions. Inference permits at most one primary and two total
decisions per slide, covering no more than 25% of visible slide text.

## 4. Select a design direction

New decks require an explicit or inferred occasion and mood before visual
selection. If either is materially missing, ask for both in one concise batch
before selecting a template.

Read `assets/templates/index.json`.

- When a listed template clearly matches the brief, plan against its registered
  contracts before initializing it.
- When the user explicitly requests a listed template, use it.
- `neo-grid-bold` is a promoted `beautiful-html-templates` visual system with a
  local layout contract, reviewed emphasis plan, and `deck-stage.js` runtime
  file. If a preview result is `beautiful:neo-grid-bold` and the user chooses
  it, use the registered production template ID `neo-grid-bold` for
  `plan-deck.mjs` and `new-deck.mjs`.
- When no registered template clearly matches, or when the user wants to choose
  the aesthetic direction, generate three real title-slide previews from the
  bundled production templates and let the user choose before building the full
  deck. An external `beautiful-html-templates` library may override the bundled
  source when explicitly configured:

```bash
node scripts/preview-template-candidates.mjs \
  --request /absolute/path/to/template-preview-request.json \
  --out /absolute/path/to/previews \
  --json
```

The preview request must include `title`, `occasion`, and `mood`; include
`subtitle`, `author`, `date`, `scheme`, and `density` when known. Open or serve
the three returned `previewPath` files and wait for the user's choice. Treat
`beautiful:<slug>` candidates as external visual systems; do not pass the
prefixed preview ID to production planning. Use a promoted unprefixed template
ID from `assets/templates/index.json` only when that template has a local
`layout-contracts.json` and reviewed `emphasis-plan.json`.
- Do not combine unrelated template systems without a concrete reason.

Third-party license notices for external template material must remain in
non-rendered files such as `THIRD_PARTY_NOTICES.md`. Never add MIT, copyright,
license, or attribution boilerplate to slide HTML, cover text, footers, speaker
notes, or any other user-visible presentation surface unless the user explicitly
asks for visible attribution.

When the initial request includes images, read
`references/initial-image-workflow.md` and pass an image request JSON through
`new-deck.mjs --images`. Use the resulting `image-manifest.json` while designing
the first draft. Do not postpone image inspection or ratio-aware composition
until a later revision.

After selecting a template, read only its `design.md`. Use `template.html` as the implementation base, not as content to preserve.

Also read its `layout-contracts.json` when present. Item-count changes must update
every coupled property listed for that layout. Every registered template
contract must declare style, typography, image, layout, chart,
semantic-visual, accessibility, and layout-selection sections; template
creation fails before writing output when any required contract is missing or
invalid.

Replace every demonstration title, label, paragraph, number, brand, and footer. Keep the template's visual grammar, typography, spacing, and interaction model.

Build and review the complete first-draft contract before creating the output
directory:

```bash
node scripts/plan-deck.mjs \
  --template TEMPLATE_ID \
  --request /absolute/path/to/deck-request.json \
  --out /absolute/path/to/deck-plan.json \
  --json
```

Exit `2` means structural planning passed but human review is still required.
Review brief fit, evidence integrity, narrative coherence, layout rhythm, and
all four per-slide layout checks. Rerun with `--review` and require
`status: "passed"`. Then initialize with
`scripts/new-deck.mjs --plan /absolute/path/to/deck-plan.json`.
`--unplanned-scaffold` is only for template maintenance and internal tests,
never a deliverable.

## 5. Use images deliberately

Default to no images. Add or replace an image only when the user explicitly
requests it and provides the local source file. Do not search for, generate, or
silently substitute imagery.

Inspect every provided image before placing it. Exclude unusable, duplicated, irrelevant, or broken images.

For first-draft images, initialize the deck with `--images`, then build semantic
`media-layout` placeholders and execute `replace-image` during initial assembly.
This uses the same dimension detection, adaptive layout, asset safety, and
verification behavior as later revisions.

For website or product presentations:

- prefer real homepage, workflow, detail, and mobile screenshots
- capture screenshots only after the page reaches a stable state
- never include loading, error, authentication, or empty states unless the slide discusses that state
- use screenshots as primary evidence, not tiny decoration
- keep local assets beside the generated HTML and use relative paths

For supported revisions, use `replace-image` from
`references/dom-commands.md`. It copies the provided local raster file into the
deck's `assets/` directory, reads its real pixel dimensions, selects a portrait,
square, 4:3-like, or wide layout, and updates both the image and the containing
slide. It participates in transactional rollback and per-change verification.
Default to `contain` so the full image remains visible. Use `cover` only when the
user accepts intentional cropping, and verify the crop visually.

Image-led slides must use the template's `media-layout`, `media-copy`, and
`media-frame` contract. Do not force images with different aspect ratios into one
fixed box. Use `custom-edit` for a page whose composition does not expose this
adaptive structure.

Do not reuse the same screenshot on multiple slides unless it is a logo or the repetition communicates a comparison.

## 6. Build the deck

Generate a fixed 1920×1080 stage that scales uniformly to the viewport. Keep the output as an HTML file with inline CSS and JavaScript; local images may remain in an adjacent `assets/` folder.

Author slides in the exact stable-ID order recorded by the passed
`deck-plan.json`. Every section must preserve its planned `data-layout`,
`data-layout-treatment`, `data-visual-intent`, comma-separated
`data-source-claims`, `data-evidence-mode`, and `data-plan-item-count`. Revise
and re-review the plan when authored content no longer fits; do not silently
switch layouts or claims.

Every deck must support:

- left/right arrow and Space navigation
- touch swipe navigation
- full-screen mode
- visible page count and progress
- reduced-motion preference
- one active slide at a time
- print styles

Retain inline text editing when the selected template supports it.

Avoid generic card grids, purple gradients, decorative blobs, tiny body text, and repeated layouts. Match slide composition to its message.

## 7. Verify before delivery

Refresh the machine-readable slide map and run static contract checks with the
combined draft verifier:

```bash
node scripts/verify-draft.mjs \
  --deck /absolute/path/to/deck \
  --write --json
```

The combined verifier runs `inspect-deck.mjs`, `validate-deck.mjs`, and any
available `verify-deck-plan.mjs` / `verify-changes.mjs` checks. When debugging a
specific failure, rerun the underlying command directly.

Verify the authored deck against its approved first-draft contract when a
separate check is needed:

```bash
node scripts/verify-deck-plan.mjs \
  --deck /absolute/path/to/deck \
  --write --json
```

Require `deckPlanVerification.status: "passed"` before continuing. This checks
slide count and order, stable IDs, titles, layouts, treatments, semantic
intents, evidence modes, source claim references, and declared item counts.

Run:

```bash
node scripts/validate-deck.mjs /absolute/path/to/deck/index.html
```

Resolve the visual runtime before capture:

```bash
node scripts/resolve-visual-runtime.mjs --json
```

This command checks explicit overrides, standard and user application
locations, executable search paths, macOS application metadata, Windows App
Paths registry entries, Linux package locations, and every discovered
candidate's actual headless CDP launch. It does not download anything by
default. Do not treat a partial discovery result as proof that Chromium is
absent.

If no verified local browser exists, inspect the current Agent's real tool,
plugin, Skill, and MCP inventory. Record every inspected tool and its support
for local content, JavaScript evaluation, viewport control, screenshots, and
DOM geometry. Use the host's tool-discovery mechanism when one exists; inspect
known browser Skills and configured plugins rather than relying on remembered
tool names. An uninspected inventory is `unknown`, never `unavailable`.
Then check for a configured remote renderer and request permission before
uploading deck content or assets. Only when both routes are unavailable or
declined may you disclose the managed browser download size and ask permission
to install it. Pass `--allow-browser-install` only after that permission.

If the user declines every rendering option, record an explicit
`visualAudit.status: "skipped"` decision with a reason. Never call it passed or
fully verified. The Skill host must provide Node.js 22 or newer. A consented
managed install requires HTTPS access, a writable cache, and on Linux the
shared libraries required by Chrome for Testing.

Then read `references/visual-audit-workflow.md` and run the visual audit gate.
New decks render every slide; revisions render affected slides, their immediate
neighbors, and the first/last slide when page count changes.
Every selected slide must have a 1440 x 900 desktop capture. Revisions also
compare matched stable slide IDs against source baselines and block material
changes on selected unplanned slides. Treat automated geometry, unresolved
overflow, line, image-stripe, unexpected visual-difference, and explicit
style, typography, image-integrity, and repeated-layout contract findings as
blockers. Inspect the returned contact sheet, then inspect only abnormal
captures or abnormal items identified by `reviewScope`; submit an
abnormal-only review through `scripts/visual-audit.mjs` before delivery. If
automated capture returns a repair handoff, create a protected revision from
its source deck, plan and apply every issue through the modification master,
and rerun all affected semantic and visual checks until no Blocker remains.

Static validation and nonblank screenshot checks do not replace visual
inspection.

Delete temporary preview files after verification. Keep only the deliverable and its required assets.

## 8. Deliver

Open the generated HTML and report:

- absolute file path
- local preview URL when a server is needed
- template or design direction
- slide count
- included images and any excluded assets
- verification performed
- remaining factual or visual risks

When visual audit was explicitly skipped, state that prominently in delivery
and do not describe the deck as visually verified.

Treat the delivered output directory as the current deck for subsequent conversational changes.

Offer PDF export or deployment only after the HTML draft is complete.

## Preference updates

Update `references/preferences.md` only when the user explicitly asks to remember a durable presentation preference. Record preferences, not task-specific content or private data.
