import { recommendSlideLayout } from "./slide-layout-plan.mjs";
import { extractSlideSections } from "./deck-model.mjs";

const DENSITIES = new Set(["speaker-led", "balanced", "dense"]);
const EVIDENCE_MODES = new Set(["none", "sourced", "demonstration"]);
const EMPHASIS_CATEGORIES = new Set([
  "user-request",
  "core-conclusion",
  "key-metric",
  "decision-action",
  "contrast"
]);
const EMPHASIS_PRIORITIES = new Set(["primary", "secondary"]);
const EMPHASIS_SOURCES = new Set(["inferred", "user"]);
const EMPHASIS_TREATMENTS = new Set([
  "bold",
  "enlarge",
  "color",
  "highlight"
]);
const DECK_REVIEW_CHECKS = [
  "briefFit",
  "evidenceIntegrity",
  "narrativeCoherence",
  "layoutRhythm"
];
const SLIDE_REVIEW_CHECKS = [
  "requestFit",
  "contentFit",
  "narrativeFit",
  "styleContinuity"
];

function text(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`Deck plan requires ${field}.`);
  return normalized;
}

function textList(value, field, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => !String(item ?? "").trim())
  ) {
    throw new Error(
      `Deck plan requires ${allowEmpty ? "a valid" : "a non-empty"} ${field} array.`
    );
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

function normalizeBrief(brief) {
  const density = brief?.density ?? "balanced";
  if (!DENSITIES.has(density)) {
    throw new Error(`Unsupported deck density "${density}".`);
  }
  return {
    title: text(brief?.title, "brief.title"),
    topic: text(brief?.topic, "brief.topic"),
    objective: text(brief?.objective, "brief.objective"),
    audience: textList(brief?.audience, "brief.audience"),
    desiredConclusion: text(
      brief?.desiredConclusion,
      "brief.desiredConclusion"
    ),
    density,
    constraints: textList(brief?.constraints ?? [], "brief.constraints", {
      allowEmpty: true
    })
  };
}

function normalizeSources(sources) {
  if (!Array.isArray(sources)) {
    throw new Error("Deck plan requires a sources array.");
  }
  const sourceIds = new Set();
  const claimIds = new Set();
  const claims = new Map();
  const normalized = sources.map((source) => {
    const id = text(source?.id, "source.id");
    if (sourceIds.has(id)) throw new Error(`Duplicate deck source id: ${id}`);
    sourceIds.add(id);
    if (!Array.isArray(source.claims)) {
      throw new Error(`Deck source "${id}" requires a claims array.`);
    }
    return {
      id,
      type: text(source.type, `source "${id}".type`),
      title: text(source.title, `source "${id}".title`),
      location: String(source.location ?? "").trim(),
      claims: source.claims.map((claim) => {
        const claimId = text(claim?.id, `source "${id}" claim.id`);
        if (claimIds.has(claimId)) {
          throw new Error(`Duplicate source claim id: ${claimId}`);
        }
        claimIds.add(claimId);
        const evidenceType = text(
          claim.evidenceType,
          `source claim "${claimId}".evidenceType`
        );
        if (!["source", "user-provided", "demonstration"].includes(evidenceType)) {
          throw new Error(
            `Unsupported evidence type "${evidenceType}" for claim "${claimId}".`
          );
        }
        const normalizedClaim = {
          id: claimId,
          text: text(claim.text, `source claim "${claimId}".text`),
          evidenceType,
          attribution: String(claim.attribution ?? "").trim()
        };
        if (evidenceType === "source" && !normalizedClaim.attribution) {
          throw new Error(`Source claim "${claimId}" requires attribution.`);
        }
        claims.set(claimId, normalizedClaim);
        return normalizedClaim;
      })
    };
  });
  return { sources: normalized, claims };
}

function normalizeNarrative(narrative) {
  if (!Array.isArray(narrative?.sections) || narrative.sections.length === 0) {
    throw new Error("Deck plan requires narrative.sections.");
  }
  const sectionIds = new Set();
  return {
    openingPromise: text(
      narrative.openingPromise,
      "narrative.openingPromise"
    ),
    arc: text(narrative.arc, "narrative.arc"),
    sections: narrative.sections.map((section) => {
      const id = text(section?.id, "narrative section.id");
      if (sectionIds.has(id)) {
        throw new Error(`Duplicate narrative section id: ${id}`);
      }
      sectionIds.add(id);
      return {
        id,
        purpose: text(section.purpose, `narrative section "${id}".purpose`)
      };
    }),
    conclusion: text(narrative.conclusion, "narrative.conclusion"),
    nextAction: text(narrative.nextAction, "narrative.nextAction")
  };
}

function normalizeEmphasis(candidate, slideId) {
  const id = text(candidate?.id, `slide "${slideId}" emphasis.id`);
  const source = candidate.source ?? "inferred";
  const priority = candidate.priority ?? "secondary";
  const category =
    candidate.category ?? (source === "user" ? "user-request" : "");
  if (!EMPHASIS_SOURCES.has(source)) {
    throw new Error(`Unsupported emphasis source "${source}" for "${id}".`);
  }
  if (!EMPHASIS_PRIORITIES.has(priority)) {
    throw new Error(`Unsupported emphasis priority "${priority}" for "${id}".`);
  }
  if (!EMPHASIS_CATEGORIES.has(category)) {
    throw new Error(`Unsupported emphasis category "${category}" for "${id}".`);
  }
  const treatments = textList(
    candidate.treatments,
    `slide "${slideId}" emphasis "${id}".treatments`
  );
  for (const treatment of treatments) {
    if (!EMPHASIS_TREATMENTS.has(treatment)) {
      throw new Error(
        `Unsupported emphasis treatment "${treatment}" for "${id}".`
      );
    }
  }
  return {
    id,
    role: text(candidate.role, `slide "${slideId}" emphasis "${id}".role`),
    text: text(candidate.text, `slide "${slideId}" emphasis "${id}".text`),
    category,
    rationale: text(
      candidate.rationale,
      `slide "${slideId}" emphasis "${id}".rationale`
    ),
    source,
    priority,
    treatments
  };
}

function normalizeSlide(raw, claims, seenEmphasisIds) {
  const id = text(raw?.id, "slide.id");
  const evidenceMode = raw.evidenceMode ?? "none";
  if (!EVIDENCE_MODES.has(evidenceMode)) {
    throw new Error(`Unsupported evidence mode "${evidenceMode}" on "${id}".`);
  }
  const sourceClaimIds = textList(
    raw.sourceClaimIds ?? [],
    `slide "${id}".sourceClaimIds`,
    { allowEmpty: true }
  );
  for (const claimId of sourceClaimIds) {
    if (!claims.has(claimId)) {
      throw new Error(`Slide "${id}" references unknown source claim "${claimId}".`);
    }
  }
  if (evidenceMode === "sourced" && sourceClaimIds.length === 0) {
    throw new Error(`Sourced slide "${id}" requires sourceClaimIds.`);
  }
  if (evidenceMode !== "sourced" && sourceClaimIds.length > 0) {
    throw new Error(
      `Slide "${id}" may reference source claims only with evidenceMode "sourced".`
    );
  }
  const signals = textList(raw.signals, `slide "${id}".signals`);
  if (
    (signals.includes("number") || signals.includes("chart")) &&
    evidenceMode === "none"
  ) {
    throw new Error(
      `A quantitative slide "${id}" requires sourced or demonstration evidence.`
    );
  }
  const emphasisCandidates = (raw.emphasisCandidates ?? []).map((candidate) => {
    const normalized = normalizeEmphasis(candidate, id);
    if (seenEmphasisIds.has(normalized.id)) {
      throw new Error(`Duplicate emphasis candidate id: ${normalized.id}`);
    }
    seenEmphasisIds.add(normalized.id);
    return normalized;
  });
  const inferred = emphasisCandidates.filter((item) => item.source === "inferred");
  if (inferred.length > 2) {
    throw new Error(
      `Slide "${id}" allows at most two inferred emphasis candidates.`
    );
  }
  if (inferred.filter((item) => item.priority === "primary").length > 1) {
    throw new Error(
      `Slide "${id}" allows at most one inferred primary emphasis candidate.`
    );
  }
  return {
    id,
    title: text(raw.title, `slide "${id}".title`),
    purpose: text(raw.purpose, `slide "${id}".purpose`),
    narrativeRole: text(raw.narrativeRole, `slide "${id}".narrativeRole`),
    contentShape: text(raw.contentShape, `slide "${id}".contentShape`),
    intent: text(raw.intent, `slide "${id}".intent`),
    signals,
    itemCount: raw.itemCount,
    density: raw.density ?? "balanced",
    requestedLayout: raw.requestedLayout
      ? String(raw.requestedLayout).trim()
      : null,
    source: raw.source ?? "inferred",
    evidenceMode,
    sourceClaimIds,
    emphasisCandidates
  };
}

function rhythmWarnings(slides) {
  const warnings = [];
  for (let index = 2; index < slides.length; index += 1) {
    const group = slides.slice(index - 2, index + 1);
    if (group.every((slide) => slide.selectedLayout === group[0].selectedLayout)) {
      warnings.push({
        code: "repeated-layout-rhythm",
        slides: group.map((slide) => slide.id),
        message: `Three consecutive slides use layout "${group[0].selectedLayout}".`
      });
    }
    if (group.every((slide) => slide.density === "dense")) {
      warnings.push({
        code: "repeated-dense-rhythm",
        slides: group.map((slide) => slide.id),
        message: "Three consecutive slides use dense content."
      });
    }
  }
  return warnings;
}

export function buildDeckPlan({
  request,
  contract,
  updatedAt = new Date().toISOString()
}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Deck plan request must be an object.");
  }
  const template = text(request.template, "template");
  if (template !== contract?.template) {
    throw new Error(
      `Deck plan template "${template}" does not match contract "${contract?.template ?? ""}".`
    );
  }
  const brief = normalizeBrief(request.brief);
  const { sources, claims } = normalizeSources(request.sources);
  const narrative = normalizeNarrative(request.narrative);
  if (!Array.isArray(request.slides) || request.slides.length < 2) {
    throw new Error("Deck plan requires at least two slides.");
  }
  const seenIds = new Set();
  const seenEmphasisIds = new Set();
  const normalizedSlides = request.slides.map((raw) => {
    const normalized = normalizeSlide(raw, claims, seenEmphasisIds);
    if (seenIds.has(normalized.id)) {
      throw new Error(`Duplicate deck slide id: ${normalized.id}`);
    }
    seenIds.add(normalized.id);
    return normalized;
  });
  if (normalizedSlides[0].narrativeRole !== "opening") {
    throw new Error('The first slide must use narrativeRole "opening".');
  }
  if (normalizedSlides[0].intent !== "opening") {
    throw new Error('The first slide must use intent "opening".');
  }
  const last = normalizedSlides.at(-1);
  if (!["closing", "action"].includes(last.narrativeRole)) {
    throw new Error(
      'The last slide must use narrativeRole "closing" or "action".'
    );
  }
  if (last.intent !== "call-to-action") {
    throw new Error('The last slide must use intent "call-to-action".');
  }

  const priorSlides = [{ id: "__deck_start__", layout: null }];
  const slides = normalizedSlides.map((slide, index) => {
    const after = index === 0 ? "__deck_start__" : normalizedSlides[index - 1].id;
    const recommendation = recommendSlideLayout({
      decision: {
        id: `initial-${slide.id}-layout`,
        changeId: `initial-${slide.id}`,
        slide: slide.id,
        request: slide.purpose,
        after,
        narrativeRole: slide.narrativeRole,
        contentShape: slide.contentShape,
        intent: slide.intent,
        signals: slide.signals,
        itemCount: slide.itemCount,
        density: slide.density,
        requestedLayout: slide.requestedLayout,
        source: slide.source
      },
      contract,
      slides: priorSlides
    });
    const result = {
      ...slide,
      selectedLayout: recommendation.selectedLayout,
      styleTreatment: recommendation.styleTreatment,
      prototypeSlide: recommendation.prototypeSlide,
      candidates: recommendation.candidates,
      rejections: recommendation.rejections,
      scoreGap: recommendation.scoreGap,
      confidence: recommendation.confidence
    };
    priorSlides.push({ id: slide.id, layout: result.selectedLayout });
    return result;
  });

  if (slides[0].selectedLayout !== "cover") {
    throw new Error('The opening slide must resolve to layout "cover".');
  }
  if (slides.at(-1).selectedLayout !== "closing") {
    throw new Error('The closing slide must resolve to layout "closing".');
  }

  const usedClaimIds = [
    ...new Set(slides.flatMap((slide) => slide.sourceClaimIds))
  ].sort();
  const allClaimIds = [...claims.keys()].sort();
  const unusedClaimIds = allClaimIds.filter((id) => !usedClaimIds.includes(id));
  const warnings = [
    ...unusedClaimIds.map((claimId) => ({
      code: "unused-source-claim",
      claimId,
      message: `Source claim "${claimId}" is not used by any planned slide.`
    })),
    ...rhythmWarnings(slides)
  ];

  return {
    schemaVersion: 1,
    template,
    updatedAt,
    status: "review-required",
    brief,
    sources,
    narrative,
    slides,
    coverage: {
      sourceCount: sources.length,
      claimCount: allClaimIds.length,
      usedClaimIds,
      unusedClaimIds
    },
    findings: {
      blockers: [],
      warnings
    },
    review: null
  };
}

function normalizedChecks(checks, names, label) {
  return Object.fromEntries(
    names.map((name) => {
      if (!["pass", "fail"].includes(checks?.[name])) {
        throw new Error(`${label} check "${name}" must be pass or fail.`);
      }
      return [name, checks[name]];
    })
  );
}

export function applyDeckPlanReview(
  plan,
  review,
  reviewedAt = new Date().toISOString()
) {
  if ((plan.findings?.blockers ?? []).length > 0) {
    throw new Error("Deck plan blockers must be resolved before review.");
  }
  const reviewer = text(review?.reviewer, "review.reviewer");
  const checks = normalizedChecks(
    review?.checks,
    DECK_REVIEW_CHECKS,
    "Deck plan review"
  );
  const notes = String(review?.notes ?? "").trim();
  if (Object.values(checks).includes("fail") && !notes) {
    throw new Error("Failed deck plan review requires notes.");
  }

  const expected = new Set((plan.slides ?? []).map((slide) => slide.id));
  const received = new Map();
  for (const item of review?.slides ?? []) {
    if (!expected.has(item.id)) {
      throw new Error(`Unknown deck plan review slide: ${item.id}`);
    }
    if (received.has(item.id)) {
      throw new Error(`Duplicate deck plan review slide: ${item.id}`);
    }
    const slideChecks = normalizedChecks(
      item.checks,
      SLIDE_REVIEW_CHECKS,
      `Deck plan review slide "${item.id}"`
    );
    const slideNotes = String(item.notes ?? "").trim();
    if (Object.values(slideChecks).includes("fail") && !slideNotes) {
      throw new Error(
        `Failed deck plan review slide "${item.id}" requires notes.`
      );
    }
    received.set(item.id, {
      id: item.id,
      checks: slideChecks,
      notes: slideNotes
    });
  }
  const missing = [...expected].filter((id) => !received.has(id));
  if (missing.length > 0) {
    throw new Error(`Deck plan review is missing slides: ${missing.join(", ")}`);
  }
  const slides = [...received.values()];
  const passed =
    !Object.values(checks).includes("fail") &&
    slides.every((item) => !Object.values(item.checks).includes("fail"));
  return {
    ...plan,
    status: passed ? "passed" : "failed",
    updatedAt: reviewedAt,
    review: {
      reviewer,
      reviewedAt,
      checks,
      notes,
      slides
    }
  };
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1] ?? "";
}

function visibleText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractPlannedSlides(html) {
  return extractSlideSections(html).map(({ openingTag, body }) => {
    const id =
      attribute(openingTag, "data-slide-id") ||
      attribute(openingTag, "id") ||
      attribute(openingTag, "data-slide");
    if (!id) throw new Error("Every authored slide must define a stable id.");
    const itemCountValue = attribute(openingTag, "data-plan-item-count");
    return {
      id,
      title:
        visibleText(body.match(/<h[12]\b[^>]*>[\s\S]*?<\/h[12]>/i)?.[0] ?? "") ||
        attribute(openingTag, "aria-label"),
      layout: attribute(openingTag, "data-layout"),
      styleTreatment: attribute(openingTag, "data-layout-treatment"),
      intent: attribute(openingTag, "data-visual-intent"),
      evidenceMode: attribute(openingTag, "data-evidence-mode") || null,
      sourceClaimIds: attribute(openingTag, "data-source-claims")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .sort(),
      itemCount: itemCountValue === "" ? null : Number(itemCountValue)
    };
  });
}

export function verifyDeckPlan({ plan, slides }) {
  if (plan?.status !== "passed") {
    throw new Error('Deck plan must have status "passed" before verification.');
  }
  const expectedSlides = plan.slides ?? [];
  const actualSlides = slides ?? [];
  const mismatches = [];
  if (expectedSlides.length !== actualSlides.length) {
    mismatches.push({
      slide: null,
      field: "slideCount",
      expected: expectedSlides.length,
      actual: actualSlides.length
    });
  }
  const length = Math.max(expectedSlides.length, actualSlides.length);
  for (let index = 0; index < length; index += 1) {
    const expected = expectedSlides[index];
    const actual = actualSlides[index];
    if (!expected || !actual) {
      mismatches.push({
        slide: expected?.id ?? actual?.id ?? null,
        field: "slideOrder",
        expected: expected?.id ?? null,
        actual: actual?.id ?? null
      });
      continue;
    }
    const comparisons = [
      ["id", expected.id, actual.id],
      ["title", expected.title, actual.title],
      ["selectedLayout", expected.selectedLayout, actual.layout],
      ["styleTreatment", expected.styleTreatment, actual.styleTreatment],
      ["intent", expected.intent, actual.intent],
      ["evidenceMode", expected.evidenceMode, actual.evidenceMode],
      [
        "sourceClaimIds",
        [...expected.sourceClaimIds].sort(),
        [...(actual.sourceClaimIds ?? [])].sort()
      ],
      ["itemCount", expected.itemCount, actual.itemCount]
    ];
    for (const [field, expectedValue, actualValue] of comparisons) {
      if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue)) {
        mismatches.push({
          slide: expected.id,
          field,
          expected: expectedValue,
          actual: actualValue
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: mismatches.length === 0,
    mismatches
  };
}
