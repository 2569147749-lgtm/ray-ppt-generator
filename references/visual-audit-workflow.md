# Visual Audit Gate

Run this gate after static validation, version comparison, and objective
verification. A deck is visually verified only when `deck-project.json`
contains `visualAudit.status: "passed"` for the current HTML. An explicitly
authorized `skipped` state may be delivered only with a prominent statement
that visual rendering and inspection were not performed.

## 1. Capture

For a new deck, omit `--plan`; every slide is rendered. For a revision, pass the
complete change plan. Start with the diagnostic audit entry point:

```bash
node scripts/visual-audit.mjs \
  --deck /absolute/path/to/deck \
  --plan /absolute/path/to/deck/change-plan.json \
  --runtime-cache /absolute/path/to/deck/visual-runtime-cache.json \
  --json
```

Exit `2` means all automated capture checks passed and focused visual review is
required. The report includes `contactSheets[]` and `reviewScope`; use the
desktop contact sheet as the normal-page overview and inspect only captures
listed in `reviewScope.requiredCaptureIds` individually. Exit `1` means at
least one automated Blocker exists. Only then run the bounded auto-fix entry
point:

```bash
node scripts/auto-fix-visual.mjs \
  --deck /absolute/path/to/deck \
  --plan /absolute/path/to/deck/change-plan.json \
  --runtime-cache /absolute/path/to/deck/visual-runtime-cache.json \
  --max-rounds 3 \
  --json
```

Exit `0` from auto-fix means the automated gate passed, either without changes
or after a bounded repair. The JSON output contains the final `report` path.
Exit `1` means the loop stopped with unresolved findings or an execution
failure; inspect the reported `stagingDir`. When at least one audit report
exists, the output also contains `handoff`, the absolute path to
`visual-repair-handoff.json`. The original deck is unchanged, and every
attempted report, screenshot, action plan, fingerprint, error, and repair
handoff remains in that directory.

### Visual runtime resolution

Run the side-effect-free preflight before capture:

```bash
node scripts/resolve-visual-runtime.mjs --json
```

When a local runtime is available, cache the verified result and reuse it for
subsequent capture commands in the same deck:

```bash
node scripts/resolve-visual-runtime.mjs \
  --out /absolute/path/to/deck/runtime-resolution.json \
  --runtime-cache /absolute/path/to/deck/visual-runtime-cache.json \
  --json
```

The local stage searches system and user application directories, executable
search paths, macOS Spotlight bundle metadata, Windows App Paths registry
entries, and Linux package locations. Every candidate must report a supported
Chromium version and complete a real isolated headless CDP command. Prefer CDP
Pipe because it does not require a localhost listener. If Pipe is unavailable,
restart the browser with CDP WebSocket and verify that route with
`Browser.getVersion`; observing a DevTools endpoint alone is not success. The
result records the selected `cdpTransport`, each candidate, source, probe, and
failed discovery source. `partial` coverage means the search was incomplete; it
does not mean Chromium is absent. Even complete supported-source coverage does
not prove that no portable browser exists in an arbitrary directory. Preserve
the `not-found-in-supported-sources` wording and accept an explicit path before
moving to later fallbacks.

If local resolution is unavailable, follow this order without skipping a step:

1. Inspect the active Agent's tool, plugin, Skill, and MCP inventory. Record
   `inventorySource`, `inspectedAt`, and every inspected tool. A compatible
   adapter must support local content or complete upload, JavaScript evaluation,
   viewport control, screenshots, and DOM geometry. Missing inventory evidence
   means `unknown`, not `unavailable`.
2. Inspect remote-renderer configuration. A remote route requires a real HTTPS
   service or adapter and explicit user permission before uploading the deck,
   images, fonts, or other assets. Configuration alone is not consent.
3. If Agent and remote routes are unavailable or declined, disclose an
   estimated 120 MiB download, 200 MiB installed footprint, and 350 MiB
   temporary peak, then ask permission. Only after consent may the command use
   `--allow-browser-install`.
4. If the user declines every rendering route, ask for final confirmation and
   record `visualAudit.status: "skipped"` with the reason. Skipped is never
   equivalent to passed.

Write the evidence and decisions to a JSON file, then validate it:

```bash
node scripts/resolve-visual-runtime.mjs \
  --deck /absolute/path/to/deck \
  --decision /absolute/path/to/visual-runtime-decision.json \
  --out /absolute/path/to/runtime-resolution.json \
  --json
```

The decision uses the fixed sequence `local -> agent -> remote -> download ->
skip`. The resolver rejects a selected action that jumps over an uninspected
stage. Agent and remote adapters execute through the capabilities exposed by
the active host; this Skill does not claim either route exists merely because a
similarly named config file or plugin directory is present.

An Agent or remote adapter is equivalent only when it returns every desktop PNG
plus the same geometry, style, quality, browser provenance, and v2
report fields produced by `visual-audit.mjs`. Screenshot-only tools are useful
for manual inspection but are not a complete replacement; record them as
inspected and incompatible, then continue the fallback sequence.

Example evidence after Agent inspection and before download consent:

```json
{
  "agent": {
    "status": "inspected",
    "inventorySource": "active-agent-tool-registry",
    "inspectedAt": "2026-09-17T12:00:00.000Z",
    "tools": [
      {
        "name": "browser-tool",
        "adapter": "agent://browser-tool",
        "capabilities": {
          "localContent": true,
          "javascript": true,
          "viewport": true,
          "screenshot": true,
          "domGeometry": true
        }
      }
    ]
  },
  "remote": {
    "status": "unavailable",
    "evidence": "No remote renderer is configured."
  },
  "download": { "consent": "unknown" },
  "skip": { "consent": "unknown" },
  "selectedAction": "request-download-consent"
}
```

### Managed browser cache

After explicit download consent, the command downloads the pinned Chrome for
Testing headless shell from Google's official storage and publishes it
transactionally into a versioned user cache. A failed or interrupted download
never becomes a cache hit.

The cache defaults to:

- macOS: `~/Library/Caches/ray-ppt-generator/browser`
- Windows: `%LOCALAPPDATA%\ray-ppt-generator\browser`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/ray-ppt-generator/browser`

Set `RAY_PPT_BROWSER_CACHE` or pass `--browser-cache /path` to relocate it.
`--chrome /path` and `CHROME_PATH` remain advanced overrides, but they must pass
the same version and CDP launch probe as discovered browsers.

The downloader and ZIP extractor use only Node.js standard-library APIs; npm,
Playwright, Puppeteer, and a system `unzip` executable are not required. The
host still needs Node.js 22 or newer, HTTPS access for the first download, and a
writable cache. Chrome for Testing is a browser binary, not a complete Linux
userspace, so Linux shared-library packages may still require administrator or
image-level provisioning. Fully removing those host requirements requires a
per-platform packaged runtime or a remote rendering service. Decks that link
remote fonts or media still need those resources to be reachable; bundle such
assets locally when offline rendering must be reproducible.

The loop can repair only `text-overflow` on the exact semantic text element
marked with both:

```html
data-visual-autofix="fit-text"
data-visual-min-font-size="40"
```

It calculates a smaller font size from the measured desktop client/scroll ratio
and reruns the full audit. Revision repairs are restricted to planned target slides. The default
limit is three applied repair rounds. A repeated action fingerprint stops the
loop to prevent oscillation. A required size below the declared minimum is not
applied.

No repair is generated for overlap, slide overflow, line-through-text, image
stripes, unexpected cross-version changes, ambiguous semantic locators, or
unmarked text. Typography, image, layout, and style quality Blockers also never
receive a guessed repair. Those findings require an explicit layout, content,
image, or style correction by the modification master. The loop never adds
visual exception attributes.

All audits and candidate writes run in an isolated sibling copy. After a passing
audit, the repaired HTML, unchanged semantic-audit state, final project gate,
every round report, and every referenced screenshot are published in one atomic
file batch under `visual-audit/auto-fix-<timestamp>/`. A failed loop never
publishes candidate deck changes.

The revision task set contains every affected slide and its immediate neighbors
in the revised deck. When the slide count changes, it also contains the first and
last slide. Every selected slide is rendered at:

- desktop: 1440 x 900

When `revision.json.source` resolves to a source deck, the audit also renders a
baseline for each selected stable slide ID that exists in both versions.
Baselines are stored under `visual-audit/baseline/`. Planned target-slide
differences are recorded as evidence and do not fail the gate. A material
difference on a selected non-target slide produces the Blocker
`unexpected-visual-change`. Added or deleted slides without a matching stable ID
are not pixel-compared, so structural edits do not create false regressions.

The command verifies PNG dimensions, rejects blank captures, and runs automated
visual defect checks against each active slide:

- clipped text from `scrollWidth` / `scrollHeight`
- visible text or media outside the 1920 x 1080 authored slide
- incoherent intersections between text and media geometry
- DOM, border, SVG, or pseudo-element lines crossing text glyphs
- narrow, contrasting, near-uniform strips attached to a slide edge
- unexplained long, narrow color regions inside the slide
- material cross-version changes on protected neighboring or boundary slides
- explicit cross-slide style-contract drift in fonts, semantic colors, title
  hierarchy, slide insets, or footer geometry
- semantic-role font-family or font-weight drift from the protected source
  unless the exact property and requested value are authorized in the change
  plan
- explicit typography-contract drift in role font size, line height, or line
  count
- excessive image upscale or aspect-ratio distortion
- explicit repeated-group gap or cross-axis alignment drift
- chart domains, tick order, point values, labels, sources, or rendered mark
  lengths that violate the template chart contract
- declared slide intent, required evidence, or primary emphasis that conflicts
  with the selected layout
- inline bold, enlargement, color, or highlight that lacks a reviewed semantic
  emphasis decision, has stale text or the wrong role, or differs from its
  planned treatment
- insufficient text contrast, projected micro text, missing accessible labels,
  or color-only encoding

DOM rectangles are converted from the scaled browser viewport back to authored
slide coordinates. Pixel strip detection is restricted to the rendered slide
rectangle, so browser chrome outside the slide is not analyzed as slide content.

Every capture-level finding is written to the corresponding
`captures[].findings` entry. Capture-level Blockers set that capture's
`automatedPassed` and `valid` fields to `false`. A matched revision capture also
contains `visualDiff`, including the
baseline path, whether the slide was planned, pixel metrics, and one of
`identical`, `noise`, `planned-change`, or `unexpected-change`. The report
includes aggregate `findingCount` and `visualDiffFindingCount`. The command writes
one report per round, then publishes the final successful report path returned
by `auto-fix-visual.mjs`.

Each capture also records a `styleProfile` from the same browser evaluation.
Desktop profiles are analyzed once at deck level and written to
`styleConsistency`; this does not add screenshots or browser sessions. A
violation of an explicit template rule is a Blocker and makes `capturePassed`
false. A statistical title-font outlier without an explicit rule is a Warning
for manual review and does not fail the automated gate. Intentional layout
differences, such as cover and closing display scales, belong in
`layout-contracts.json` under `styleConsistency`; do not suppress them with broad
DOM exceptions.

The same CDP session records computed family/weight runs and actual platform
fonts for each semantic typography target. For revisions, desktop profiles are
matched to source profiles by stable slide ID and semantic selector. Unrequested
family or weight drift is a Blocker even when the slide is otherwise planned.
An exact `typographyAuthorization` permits only its target slide, role, optional
item, property, and requested value. New slides are checked against
`styleConsistency.typographyByRole` in the template contract.

The auto-fix loop records font-continuity Blockers as
`unsupported-font-continuity-finding`, style Blockers as
`unsupported-style-finding`, and quality Blockers as
`unsupported-quality-finding`. Semantic-emphasis Blockers are recorded as
`unsupported-semantic-emphasis-finding`; the loop stops without modifying the
deck. Font,
palette, spacing, footer, hierarchy, image framing, and layout choices require
an explicit authoring decision rather than an inferred repair.

The failure handoff deduplicates capture, font-continuity, style, and quality
Blockers across viewports. Each issue identifies its slide, category, original
finding, suggested action, and a `visual-finding-absent` acceptance condition.
Give this file to the modification master as evidence; do not edit the retained
staging copy as the deliverable. The modification master creates a protected
revision of the source deck, converts every issue into an explicit change plan,
applies deliberate edits, and reruns semantic and visual gates until no Blocker
remains.

Each capture also records a `qualityProfile` in the existing browser evaluation.
Desktop profiles are analyzed once at deck level and written to `visualQuality`;
this adds no screenshots or Chrome sessions. Explicit typography, image, and
repeated-layout contract violations are Blockers. The same profile records
charts, semantic intent/evidence, and accessibility data. Explicit chart
misrepresentation, declared semantic mismatch, and accessibility contract
violations are Blockers. Missing semantic intent or ambiguous emphasis remains
a Warning because the audit cannot safely infer business meaning. Orphan or
long lines, moderate upscale, severe crop, unexplained image reuse, and extreme
balance or density are also Warnings for manual review and do not fail
`capturePassed`.

Every registered template must provide a valid `layout-contracts.json` with
style, typography, image, layout, chart, semantic-visual, and accessibility
sections. `new-deck.mjs` validates the source contract before creating output,
and `validate-deck.mjs` validates the copied contract. Quality analyzers consume
only these generic sections; they must not branch on a template name.

New templates also provide a reviewed `emphasis-plan.json`. The browser records
only inline descendants of `[data-edit]`, so a whole semantic item such as
`<strong data-edit>` is not mistaken for local emphasis. A candidate is detected
from `data-emphasis-id`, `strong`, `b`, `mark`, increased weight or size, changed
color, or a visible background treatment relative to its owning editable text.
The deck-level `semanticEmphasis` report compares desktop candidates with the
approved plan without adding screenshots or Chrome sessions. Legacy decks with
no plan report `not-configured` for compatibility; once a plan exists, any
unapproved, missing, stale, mismatched, or unplanned emphasis is a Blocker.

The underlying `visual-audit.mjs` command remains the review and diagnostic
entry point. It records the gate in `deck-project.json` and exits with:

- `0`: reviewed and passed
- `1`: automated capture failure or reviewed failure
- `2`: captures passed and human visual review is required

One audit batch reuses a single isolated Chrome process and CDP session for both
revised captures and source baselines. Every capture still resets the viewport,
navigates the deck from a unique clean document URL, verifies the requested
active slide, waits for fonts and images, and forces CSS motion to its final
state before geometry collection and screenshot capture. Baseline comparison
increases revision rendering work, but does not launch another Chrome process or
relax any quality check. The report records one `renderSessionId` per revised
capture and the aggregate `renderSessions` count. Each capture has a hard
timeout. After the batch, Chrome is fully terminated before its temporary
profile is removed.

## 2. Inspect the contact sheet and abnormal captures

Open the generated `contact-sheet-desktop.html` listed in `contactSheets[]` as
the all-slide visual overview. Then inspect only the capture files listed in
`reviewScope.requiredCaptureIds` one by one. A capture is abnormal only when
the report contains structured evidence such as:

- failed capture, blank image, dimension mismatch, or automated geometry failure
- capture-level `findings[]` with `severity: "blocker"` or `"warning"`
- `visualDiff.status: "unexpected-change"` on an unplanned protected slide
- style, font-continuity, typography, image, layout, chart, semantic-visual,
  accessibility, or semantic-emphasis findings mapped to that slide
- explicit low-confidence evidence recorded by a planning or quality analyzer

For abnormal captures, check:

- text overflow, clipping, and accidental wrapping
- incoherent overlap or elements outside the visible stage
- alignment, spacing, hierarchy, and density
- image loading, crop, readability, and relevance
- controls, page count, connector geometry, and first/last boundaries
- desktop framing and projected readability

Do not approve from filenames or automated `valid` values alone. The contact
sheet is the fast normal-page scan; it is not a substitute for resolving every
reported abnormal item. A successful auto-fix still has
`status: "review-required"` and cannot approve itself. Automated checks catch
measurable geometry and pixel defects; they do not judge hierarchy, balance,
narrative clarity, crop quality, or whether an intentional composition still
looks good.

## Intentional overlap and line contracts

Use a local exception only when the overlap is a deliberate part of the design:

- `data-visual-overlap="allow"` permits that element to overlap another checked
  element.
- `data-visual-overflow="allow"` permits deliberate clipping or scrolling.
- `data-visual-bounds="allow"` permits a checked element to extend beyond the
  authored slide.
- `data-visual-line="allow"` permits a line owned by that element to cross text,
  or permits lines to cross that text element.
- On the active slide, `data-visual-stripe="allow-left"`,
  `allow-right`, `allow-top`, or `allow-bottom` permits an intentional edge
  stripe. Multiple values may be space-separated; `allow` permits all edges.
- On a descendant element, `data-visual-stripe="allow"` excludes that element's
  rendered rectangle from internal image-partition findings. Use this for a
  deliberate long band that the pixel analyzer cannot otherwise distinguish
  from a rendering defect.

Apply the attribute to the smallest owning element. Never add a slide-wide
exception merely to clear a report. Record the visual reason in the template
markup or design documentation, and inspect the result manually after any
exception.

## 3. Record the review

Create an abnormal-only review JSON. It must pass or fail the contact sheet and
cover every capture listed in `reviewScope.requiredCaptureIds`. Normal captures
without abnormal evidence are auto-passed by the reviewer:

```json
{
  "reviewer": "AI visual review",
  "mode": "abnormal-only",
  "contactSheet": {
    "status": "pass",
    "file": "/absolute/path/to/contact-sheet-desktop.html",
    "notes": ""
  },
  "captures": [
    {
      "id": "metrics:desktop",
      "status": "pass",
      "notes": ""
    }
  ]
}
```

Apply it:

```bash
node scripts/visual-audit.mjs \
  --deck /absolute/path/to/deck \
  --report /absolute/path/from/auto-fix-output/visual-audit-report.json \
  --review /absolute/path/to/review.json \
  --json
```

An incomplete checklist is rejected. Any failed capture sets the gate to
`failed`; fix the deck and recapture. Writing another modification automatically
invalidates a previously passed gate and sets it back to `required`.
