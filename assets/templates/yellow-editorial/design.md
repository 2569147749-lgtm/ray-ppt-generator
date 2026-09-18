# Yellow Editorial

## Intent

Use this design for confident product stories, project showcases, strategy presentations, interview portfolios, and business proposals. It should feel editorial and decisive rather than corporate or decorative.

Do not use it for dense financial statements, legal evidence packs, or image-led luxury portfolios.

## Visual system

- Yellow `#ffda24`
- Warm white `#fffef8`
- Ink `#20211d`
- Secondary text `#696a62`
- Rules `#d8d8ce`
- Display pairing — DM Sans and Noto Sans SC
- Editorial emphasis — Noto Serif SC

Use yellow for the opening, closing, selected states, highlights, and data emphasis. Keep most explanatory slides warm white.

Phrase-level emphasis follows `emphasis-plan.json`. Plan and review exact text
before adding bold, enlargement, color, or highlight styling, then attach the
decision's stable `data-emphasis-id` to that inline phrase. User-requested
emphasis has priority. Otherwise rank core conclusions, meaningful key metrics,
decisions/actions, and necessary contrasts in that order. Do not emphasize
labels, transitions, generic adjectives, isolated function words, or decorative
fragments. Inferred emphasis is limited to one primary and two total decisions
per slide and at most 25% of visible slide text.

The recurring visual vocabulary is:

- large white circles on yellow fields
- thin black orbital lines
- black dots
- upward arrows
- strong editorial rules
- restrained yellow underlines or blocks

Do not add gradients, blobs, glass cards, excessive shadows, or unrelated decorative shapes.

## Stage and spacing

- Fixed 1920×1080 canvas
- Outer horizontal padding 88px
- Top padding 64px
- Footer baseline 44px from the bottom
- Slide titles generally 76–92px
- Body text generally 23–30px
- Never shrink body text below 21px to force content onto one slide

## Automated visual contracts

The visual audit blocks text clipping, authored-stage overflow, incoherent
element overlap, lines crossing text, and unexplained edge or internal strips.
It also enforces the cross-slide style contract in `layout-contracts.json`:
declared font families, semantic colors, 88px horizontal and 64px top insets,
the shared footer baseline, and layout-specific title-size ranges. Cover and
closing title scales are intentional layout-family exceptions, not body-slide
precedents.

Semantic typography roles are also declared in `styleConsistency.typographyByRole`.
Titles may use the display sans or editorial serif treatment; repeated item
titles and bodies use the display sans stack at their declared weights. New
slides inherit these role rules. Revisions preserve the source deck's actual
rendered fonts and computed weights unless the user explicitly authorizes an
exact role-level change in the change plan.

The same contract defines P0 content-quality limits. Semantic text below its
role minimum, below its minimum line-height ratio, or above its maximum line
count is a Blocker. Excessive image upscaling, aspect-ratio distortion, and
contracted repeated-group gap or alignment drift are also Blockers. Orphan
lines, long lines, moderate image upscaling, severe intentional crop, image
reuse, and extreme balance or density are review Warnings. Cover and closing
slides are exempt only from the broad balance heuristic.

P1 contracts extend this gate:

- Charts declare their type, title, source, numeric domain, ticks, point values,
  and rendered marks. Bar charts use a zero baseline and their mark lengths must
  match the declared values.
- Every layout declares a communication intent, required evidence signals, and
  one compatible primary emphasis role. Missing declarations are review
  Warnings; explicit intent, evidence, or emphasis mismatches are Blockers.
- Visible text meets the declared contrast and projected-size thresholds. Slides
  and images require accessible labels, and color encodings require redundant
  text labels.

Use a `data-visual-*="allow"` exception only on the smallest element that owns
an intentional effect. The built-in ghost number permits overlap with foreground
content, and the process rail permits its connector to cross the numbered nodes.
Mark an intentional long internal band with `data-visual-stripe="allow"` on the
band itself. Do not copy those exceptions to unrelated content or to the whole
slide. Typography, crop, image-repeat, and repeated-group exceptions follow the
same element-local rule.

## Layout family

The template includes:

1. cover with circle and orbital line
2. large statement with highlighted phrase
3. numbered agenda
4. oversized metric and zero-based horizontal bars
5. asymmetric yellow-white comparison
6. four-step process and feedback loop
7. qualitative decision matrix
8. closing with one next action

For an added slide, use `layoutSelection` in `layout-contracts.json` to choose
among these registered layouts. Match content shape, semantic intent, required
evidence, and item capacity before considering narrative role, density,
preferred capacity, or adjacent-layout variety. The selected
`styleTreatment` and `prototypeSlide` preserve this template's visual grammar;
they are not invitations to combine another template system.

Every inferred choice requires review for request fit, content fit, narrative
fit, and style continuity. A low-confidence ranking remains review-required.
If none of the registered layouts is structurally compatible, plan a
`custom-edit` from this grid and vocabulary rather than forcing the nearest
layout. Do not repeat one layout for every slide.

## Content rules

- Replace every demonstration title, paragraph, metric, label, brand, and footer.
- Use a maximum of one core message per speaker-led slide.
- Label invented demonstration values as sample data.
- Put calculation logic and source notes near charts.
- For screenshots, use one large, inspectable image rather than several thumbnails.
- Use relative local image paths.
- Build image-led pages with `media-layout`, `media-copy`, and `media-frame`.
- Let source ratio choose the composition: portrait images receive a narrow
  vertical media column, 4:3 images receive a balanced media column, and 16:9
  images receive a wider horizontal media column.
- Default to `object-fit: contain`; crop with `cover` only when composition and
  subject placement have been visually reviewed.

## Interaction

Keep the fixed-stage controller, keyboard navigation, swipe navigation, full screen, page count, progress, print styles, reduced-motion support, and inline editing.

The template content is a layout demonstration, not reusable user content.
