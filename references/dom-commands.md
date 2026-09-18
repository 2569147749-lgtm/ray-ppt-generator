# Controlled Deck DOM Commands

Use these commands only on generated decks whose slides expose stable
`data-slide-id`, `data-layout`, and semantic `data-role` attributes.

Run a complete batch as a dry run first:

```bash
node scripts/modify-deck.mjs \
  --deck /absolute/path/to/version \
  --plan /absolute/path/to/plan.json \
  --json
```

Add `--write` only after the dry run succeeds. The write is transactional: an
invalid command prevents HTML, project state, and change-plan files from being
partially updated.

## Commands

### `set-text`

Replace one semantic text target. User text is HTML-escaped; newlines become
`<br>`.

```json
{
  "id": "metrics-title",
  "command": "set-text",
  "targets": ["metrics"],
  "slide": "metrics",
  "target": "title",
  "value": "增长效果与业务验证"
}
```

Current cross-layout text target:

- `title`

Add more `data-role` targets to a template only when their meaning is stable
across generated decks.

### `add-item`

Add one structured item to an `agenda` or `process` layout. The engine escapes
content, assigns the supplied stable item ID, renumbers all items, and reapplies
the layout adaptation.

```json
{
  "id": "workflow-publish",
  "command": "add-item",
  "targets": ["workflow"],
  "slide": "workflow",
  "target": "items",
  "after": "review",
  "item": {
    "id": "publish",
    "title": "正式发布",
    "body": "进入用户提供的渠道。"
  }
}
```

`after` is optional. Without it, the item is appended.

### `remove-item`

Remove one item by stable item ID, renumber the remaining items, and reapply the
layout adaptation.

```json
{
  "id": "remove-review",
  "command": "remove-item",
  "targets": ["workflow"],
  "slide": "workflow",
  "target": "items",
  "itemId": "review"
}
```

Layout contracts still enforce minimum and maximum item counts.

### `replace-image`

Copy one user-provided local raster image into the deck and replace one existing
semantic `<img>` target.

```json
{
  "id": "replace-product-screen",
  "command": "replace-image",
  "targets": ["comparison"],
  "slide": "comparison",
  "target": "evidence-image",
  "source": "/absolute/path/to/provided-screen.png",
  "assetName": "product-screen.png",
  "alt": "产品流程新版截图",
  "fit": "contain"
}
```

Requirements:

- `source` is an existing absolute local path supplied by the user
- supported types are PNG, JPEG, WebP, GIF, and AVIF
- `assetName` is a filename only and keeps the source extension
- `alt` is non-empty
- the target is an existing `<img data-role="...">`
- `fit` is optional: `contain` preserves the complete image and is the default;
  use `cover` only when intentional cropping is acceptable

The CLI reads the source pixel dimensions and classifies it as `portrait`,
`square`, `landscape-standard` (including 4:3), or `landscape-wide` (including
16:9). It stores the width, height, aspect ratio, fit, and selected layout on the
image and synchronizes `data-image-layout` plus CSS variables on the slide.

Adaptive image slides should use this semantic structure:

```html
<div class="media-layout" data-role="media-layout">
  <div class="media-copy">...</div>
  <figure class="media-frame">
    <img data-role="evidence-image" src="assets/example.png" alt="...">
  </figure>
</div>
```

The template changes the copy/media column ratio and frame height according to
the detected source ratio. Do not hard-code one 16:9 box for every image. Use
`custom-edit` when the target page does not follow the adaptive media contract.

The CLI copies the file to `assets/`, writes the relative `src`, and commits the
asset, HTML, project state, and change plan together. A failure rolls back the
whole batch. It does not delete the old asset because another slide may still
reference it.

### `add-slide`

Insert exactly one complete slide section. The new section must have a unique
`data-slide-id`, a known `data-layout`, one `data-role="title"`, and one
`data-role="page-number"`.

```json
{
  "id": "add-summary",
  "command": "add-slide",
  "targets": ["summary"],
  "after": "metrics",
  "layoutDecision": "add-summary-layout",
  "layoutTreatment": "editorial-manifesto",
  "html": "<section class=\"slide\" data-slide-id=\"summary\" data-layout=\"statement\" data-layout-treatment=\"editorial-manifesto\" aria-label=\"总结\">...</section>"
}
```

Before writing the section, run `plan-slide-layout.mjs` and complete its four
semantic review checks. `plan-changes.mjs` requires a passed
`slide-layout-plan.json` and verifies that the decision belongs to this change,
new slide, and insertion anchor. The HTML layout and treatment must exactly
match the reviewed choice.

Build the section from the reviewed registered prototype while preserving the
current template's visual system. Do not invent an unregistered layout, import
a foreign template, or force incompatible content into the nearest layout.
When no registered layout fits, use a planned `custom-edit`.

### `delete-slide`

Delete one slide while keeping at least two slides in the deck.

```json
{
  "id": "delete-comparison",
  "command": "delete-slide",
  "targets": ["comparison"],
  "slide": "comparison"
}
```

### `move-slide`

Move one slide immediately after another stable slide ID.

```json
{
  "id": "move-workflow",
  "command": "move-slide",
  "targets": ["workflow"],
  "slide": "workflow",
  "after": "metrics"
}
```

### `split-slide`

Split an `agenda` or `process` slide by moving existing semantic items into one
new slide immediately after the source. The AI supplies the complete new slide
HTML and chooses the item boundary; the engine does not infer semantic grouping.

```json
{
  "id": "split-workflow",
  "command": "split-slide",
  "targets": ["workflow", "workflow-detail"],
  "slide": "workflow",
  "newSlide": "workflow-detail",
  "target": "items",
  "moveItemIds": ["review", "deliver"],
  "html": "<section class=\"slide\" data-slide-id=\"workflow-detail\" data-layout=\"process\" aria-label=\"流程设计续页\">...</section>"
}
```

The new section must:

- use the same registered layout as the source
- define the `newSlide` ID, title role, page-number role, and item container
- contain exactly the moved item IDs in their source order
- keep at least the layout-contract minimum number of items on both slides

The engine removes the selected items from the source, adapts and renumbers both
slides, inserts the new slide after the source, and synchronizes deck numbering.

All page-level commands synchronize footer numbering, initial active state, the
visible counter, and `deck-project.json`.

### Internal `fit-text` repair

`fit-text` is reserved for `scripts/auto-fix-visual.mjs`; do not add it to a
user-authored `change-plan.json`. It writes only an inline `font-size` on one
unique semantic text target:

```json
{
  "id": "visual-fit-metrics-title",
  "command": "fit-text",
  "slide": "metrics",
  "target": "title",
  "itemId": null,
  "fontSize": 52.4,
  "minFontSize": 40
}
```

The target must opt in on the exact text element:

```html
<h2
  data-role="title"
  data-visual-autofix="fit-text"
  data-visual-min-font-size="40"
>...</h2>
```

Repeated roles such as `item-title` and `item-body` also require the containing
stable `data-item-id`. The command rejects ambiguous locators, values below the
declared minimum, and any font size below 8px. The visual audit derives the
requested size from measured client and scroll dimensions; callers must not
guess a value or use this command to bypass a layout change.

## Capability Boundary

`layout-contracts.json` is the source of truth for supported commands. The
current standard coverage is:

- every layout: `set-text`
- `agenda` and `process`: `add-item`, `remove-item`
- any existing semantic `<img>` target: `replace-image`
- deck level: `add-slide`, `delete-slide`, `move-slide`, `split-slide`
- automated visual repair only: `fit-text`

Do not force unsupported requests into a similar-looking command. Mark a
non-standard visual request as `custom-edit`, edit HTML/CSS directly in the
protected version, then run the same static, comparison, visual, and semantic
verification workflow.
