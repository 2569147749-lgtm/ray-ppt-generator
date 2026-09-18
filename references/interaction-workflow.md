# Dynamic User Interaction

Use this workflow before asking the user any question. The goal is to obtain
only decisions that materially affect correctness, privacy, cost, or the
deliverable, while avoiding repeated or premature questions.

## 1. Classify every input

For each potentially relevant field, assign exactly one state:

- `explicit`: the user directly supplied the value
- `inferred-high-confidence`: the value follows clearly from the request,
  supplied files, current deck, or durable preferences
- `missing-material`: proceeding would create a meaningful risk or materially
  different deliverable
- `missing-nonmaterial`: a reasonable default is safe
- `ambiguous`: two or more materially different interpretations remain
- `requires-consent`: the action uploads content, downloads a managed browser,
  intentionally crops media, skips required verification, or changes a
  protected scope

Do not ask about `explicit`, `inferred-high-confidence`, or
`missing-nonmaterial` fields. State material assumptions in the final delivery
when useful.

## 2. Apply precedence

Resolve interaction decisions in this order:

1. current user request
2. files, URLs, and the current deck named or implied by the request
3. prior statements in the same conversation
4. durable preferences
5. safe defaults

Never ask the user to repeat a value available from a higher-priority source.
Do not let a durable preference override the current request.

## 3. Decide whether to ask

Ask only when at least one of these triggers is present:

- one or more `missing-material` brief fields
- an `ambiguous` target or instruction that could cause conflicting output
- a factual claim or precise metric lacks an acceptable source
- the user requests an image action but no usable local source is available
- intentional image cropping requires acceptance
- the user explicitly wants visual options, or no production template clearly
  matches the brief
- a rendering fallback requires upload, download, or skip consent

Do not ask merely because an optional field is absent.

### Quick-draft override

When the user asks for a quick draft, capability sample, or exploratory result:

- infer non-safety brief fields and proceed
- choose a clearly matching production template directly
- use explicitly labelled demonstration data instead of invented claims
- do not bypass privacy, download, crop, destructive-scope, or verification-skip
  consent
- do not ask the user to approve internal planning or quality checks

## 4. Merge questions

### Merge into one brief batch

Combine all currently known `missing-material` brief fields into one concise
message. Use only the applicable questions, in this order:

1. What is the presentation occasion or use case?
2. Who is the audience?
3. What conclusion or action should the audience take away?
4. What approximate length and density are needed?
5. What visual mood is desired?
6. Which supplied documents, data, images, screenshots, or URLs are mandatory?
7. Where should the output be written, if the default workspace is unsuitable?

Do not send separate turns for occasion and mood when both are missing.
Do not include more than seven questions in one batch. Prefer four or fewer by
inferring safe defaults.

### Do not merge dependent questions

Keep a question in a later turn when it depends on work that has not happened:

- template choice follows generation of three real previews
- crop consent follows inspection of the actual image and target layout
- remote-upload consent follows failure of local and Agent rendering routes
- browser-download consent follows failure or rejection of earlier routes
- skip confirmation follows rejection or unavailability of every rendering
  route

Never ask the user to choose a template before previews exist.
Never ask for browser download permission while a verified local browser is
available.

### Do not merge unrelated permissions

Ask each privacy, cost, or verification consent at the point where it becomes
necessary. Do not bundle remote upload, browser download, and audit skip into a
single all-purpose approval.

## 5. New-deck triggers

| Field or decision | Ask when | Do not ask when | Standard wording |
| --- | --- | --- | --- |
| purpose / occasion | It cannot be inferred and affects narrative or template selection | The request names a pitch, report, training, review, proposal, or equivalent | "What occasion or use case is this presentation for?" |
| audience | Different plausible audiences require materially different language or evidence | The audience is explicit or obvious from the supplied source | "Who is the primary audience?" |
| desired conclusion | The topic is known but the intended takeaway or action is not | A clear thesis or requested outcome is explicit | "What should the audience believe or do after the presentation?" |
| length / density | The source volume supports materially different deliverables | A requested page count, speaker-led format, reading deck, or quick draft resolves it | "Roughly how many slides should it be, and is it speaker-led or reading-first?" |
| visual mood | It cannot be inferred from the occasion, brand, or explicit template | A template is named or the brief clearly implies a direction | "What visual mood should it have?" |
| source evidence | A requested factual claim or precise metric lacks support | The user supplied evidence or accepts clearly labelled demonstration data | "Please provide the source for this claim, or confirm that labelled demonstration data is acceptable." |
| local images | The user requires imagery but supplied no usable file | Images are not requested, or valid local files are available | "Please provide the local image files and describe what each should communicate." |
| output location | The default workspace is unsuitable or multiple destinations are plausible | A path is supplied or the standard deck output directory is safe | "Where should the generated deck be written?" |

Occasion and mood are required for visual selection, but may be inferred.
If both are `missing-material`, ask for both in the same brief batch.

## 6. Template-choice trigger

Generate three real title-slide previews and wait for a user decision only when:

- the user explicitly asks to compare designs or choose a style, or
- no registered production template clearly matches the brief.

After serving the previews, ask:

> Choose preview 1, 2, or 3, or describe the adjustment you want.

Do not generate previews when the user names a registered template or one
production template clearly matches and the user did not request options.

## 7. Revision triggers

Use the current deck without asking for its path. Ask for a path only when no
current deck exists, the user starts a separate presentation task, or multiple
candidate decks remain.

For an ambiguous revision:

1. decompose every clear clause into the change plan
2. preserve the unresolved clause as `blocked`
3. ask one question naming the exact unresolved clause and alternatives
4. do not execute a batch when the ambiguity could cause conflicting edits

Examples:

- "Which presentation should I modify?"
- "Does 'the second module' mean the second card on slide 4 or the second
  section of the deck?"
- "Should the font change apply only to the slide 5 title or to every title?"
- "Should only the phrase '36% growth' be emphasized, or the entire sentence?"

Do not ask for confirmation when stable slide IDs, page aliases, and semantic
roles resolve the target uniquely.

## 8. Image and crop triggers

Use only user-provided local image files. If a requested image source is absent,
ask for the file and intended purpose in one question.

Default to `contain`. Ask for crop consent only after inspection shows that
`cover` would materially improve the requested composition:

> This layout requires intentional cropping to fill the frame. Should I crop
> the image, or keep the complete image with contain?

The user's explicit request for `cover`, full bleed, or intentional crop counts
as consent for that target only.

## 9. Rendering consent sequence

When no verified local browser exists, preserve this sequence:

1. inspect Agent rendering capabilities without asking the user
2. inspect configured remote rendering without uploading
3. if a compatible remote route exists, ask:
   "May I upload the deck HTML and local assets to the configured remote
   renderer for visual verification?"
4. if remote rendering is unavailable or declined, disclose the estimated
   120 MiB download, 200 MiB installed footprint, and 350 MiB temporary peak,
   then ask:
   "May I download the managed Chrome renderer?"
5. only after every rendering route is unavailable or declined, ask:
   "Do you confirm delivery without visual verification?"

Consent is action-specific and cannot be inferred from configuration,
silence, or approval of another route.

## 10. Internal gates are not user questions

The Agent performs these reviews without asking the user to approve them:

- deck-plan brief and evidence review
- per-slide layout review
- emphasis relevance and restraint review
- objective change verification
- semantic intent and factual-risk review
- contact-sheet and abnormal-capture visual review
- automated repair within the declared fit-text boundary

Ask the user only when an internal gate exposes a real business ambiguity,
missing evidence, missing asset, or required consent. Do not translate every
warning or exit status `2` into a user approval request.

## 11. Interaction budget and state

- Prefer zero clarification turns when the brief is sufficient.
- Use at most one brief-clarification batch before planning.
- Template selection is a separate turn because it depends on generated
  previews.
- Ask at most one revision-ambiguity question per unresolved batch; include all
  conflicting clauses that are already known.
- Permission questions remain sequential because later options depend on
  earlier availability or refusal.
- After an answer, update the conversation state and never ask the same question
  again unless the user changes the requirement.
- Keep the delivered or revised output directory as the current deck.

## 12. Final pre-question check

Before sending any question, verify:

- the answer is not already present
- the decision materially affects the result, safety, privacy, cost, or
  verification status
- safe inference or a documented default cannot resolve it
- all independent brief questions are merged
- dependent and permission questions are deferred to the correct stage
- the wording identifies the exact decision and its consequence
