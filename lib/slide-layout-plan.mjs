const DENSITIES = new Set(["speaker-led", "balanced", "dense"]);
const SOURCES = new Set(["inferred", "user"]);

function text(value, field, decisionId = "") {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(
      `Slide layout decision${decisionId ? ` "${decisionId}"` : ""} requires ${field}.`
    );
  }
  return normalized;
}

function stringList(value, field, decisionId) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => !String(item ?? "").trim())
  ) {
    throw new Error(
      `Slide layout decision "${decisionId}" requires a non-empty ${field} array.`
    );
  }
  return [...new Set(value.map((item) => String(item).trim()))].sort();
}

export function normalizeSlideLayoutDecision(decision) {
  const id = text(decision?.id, "id");
  const source = decision.source ?? "inferred";
  if (!SOURCES.has(source)) {
    throw new Error(`Unsupported slide layout source "${source}" for "${id}".`);
  }
  const density = decision.density ?? "balanced";
  if (!DENSITIES.has(density)) {
    throw new Error(`Unsupported slide layout density "${density}" for "${id}".`);
  }
  if (!Number.isInteger(decision.itemCount) || decision.itemCount < 0) {
    throw new Error(
      `Slide layout decision "${id}" requires a non-negative integer itemCount.`
    );
  }
  return {
    id,
    changeId: text(decision.changeId, "changeId", id),
    slide: text(decision.slide, "slide", id),
    request: text(decision.request, "request", id),
    after: text(decision.after, "after", id),
    narrativeRole: text(decision.narrativeRole, "narrativeRole", id),
    contentShape: text(decision.contentShape, "contentShape", id),
    intent: text(decision.intent, "intent", id),
    signals: stringList(decision.signals, "signals", id),
    itemCount: decision.itemCount,
    density,
    requestedLayout: decision.requestedLayout
      ? String(decision.requestedLayout).trim()
      : null,
    source
  };
}

function adjacentLayouts(slides, after) {
  const index = slides.findIndex((slide) => slide.id === after);
  if (index < 0) {
    throw new Error(`Insertion anchor slide not found: ${after}`);
  }
  return [
    slides[index]?.layout,
    slides[index + 1]?.layout
  ].filter(Boolean);
}

function rejectReasons(decision, layout, profile, semanticRules) {
  const reasons = [];
  if (!profile.contentShapes.includes(decision.contentShape)) {
    reasons.push("content-shape-incompatible");
  }
  if (!semanticRules.allowedIntents.includes(decision.intent)) {
    reasons.push("intent-incompatible");
  }
  const signals = new Set(decision.signals);
  for (const signal of semanticRules.requiredSignals) {
    if (!signals.has(signal)) reasons.push(`required-signals-missing:${signal}`);
  }
  if (
    decision.itemCount < layout.minItems ||
    decision.itemCount > layout.maxItems
  ) {
    reasons.push(
      `item-capacity:${decision.itemCount}-outside-${layout.minItems}-${layout.maxItems}`
    );
  }
  return reasons;
}

function candidateScore(decision, layoutName, profile, neighbors) {
  let score = 0;
  const reasons = [];
  if (profile.narrativeRoles.includes(decision.narrativeRole)) {
    score += 4;
    reasons.push("narrative-role-fit:+4");
  }
  if (profile.density === decision.density) {
    score += 2;
    reasons.push("density-fit:+2");
  }
  if (
    decision.itemCount >= profile.preferredItems.min &&
    decision.itemCount <= profile.preferredItems.max
  ) {
    score += 2;
    reasons.push("preferred-capacity:+2");
  }
  const repeats = neighbors.filter((layout) => layout === layoutName).length;
  if (repeats > 0) {
    const penalty = repeats * 2;
    score -= penalty;
    reasons.push(`adjacent-layout-repeat:-${penalty}`);
  }
  if (
    decision.source === "user" &&
    decision.requestedLayout === layoutName
  ) {
    score += 100;
    reasons.push("user-requested-layout");
  }
  return { score, reasons };
}

function confidence(scoreGap, candidateCount) {
  if (candidateCount === 1 || scoreGap >= 4) return "high";
  if (scoreGap >= 2) return "medium";
  return "low";
}

export function recommendSlideLayout({ decision: rawDecision, contract, slides }) {
  const decision = normalizeSlideLayoutDecision(rawDecision);
  const layouts = contract?.layouts ?? {};
  const profiles = contract?.layoutSelection?.layouts ?? {};
  const semanticRules = contract?.semanticVisualQuality?.layoutRules ?? {};
  const neighbors = adjacentLayouts(slides ?? [], decision.after);
  const candidates = [];
  const rejections = [];

  for (const layoutName of Object.keys(layouts).sort()) {
    const profile = profiles[layoutName];
    const semantic = semanticRules[layoutName];
    if (!profile || !semantic) {
      rejections.push({
        layout: layoutName,
        reasons: ["selection-contract-incomplete"]
      });
      continue;
    }
    const reasons = rejectReasons(
      decision,
      layouts[layoutName],
      profile,
      semantic
    );
    if (reasons.length > 0) {
      rejections.push({ layout: layoutName, reasons });
      continue;
    }
    candidates.push({
      layout: layoutName,
      ...candidateScore(decision, layoutName, profile, neighbors),
      styleTreatment: profile.styleTreatment,
      prototypeSlide: profile.prototypeSlide
    });
  }

  candidates.sort(
    (left, right) =>
      right.score - left.score || left.layout.localeCompare(right.layout)
  );
  if (candidates.length === 0) {
    const evidence = rejections
      .flatMap((item) => item.reasons)
      .filter((reason, index, all) => all.indexOf(reason) === index)
      .join(", ");
    throw new Error(
      `No compatible layout for decision "${decision.id}": ${evidence}`
    );
  }

  const selected = candidates[0];
  const scoreGap =
    candidates.length === 1
      ? selected.score
      : selected.score - candidates[1].score;
  return {
    ...decision,
    selectedLayout: selected.layout,
    styleTreatment: selected.styleTreatment,
    prototypeSlide: selected.prototypeSlide,
    candidates,
    rejections,
    scoreGap,
    confidence: confidence(scoreGap, candidates.length),
    status: "review-required",
    review: null
  };
}

const REVIEW_CHECKS = [
  "requestFit",
  "contentFit",
  "narrativeFit",
  "styleContinuity"
];

export function applySlideLayoutReview(
  plan,
  review,
  reviewedAt = new Date().toISOString()
) {
  const reviewer = String(review?.reviewer ?? "").trim();
  if (!reviewer) {
    throw new Error("Slide layout review requires a non-empty reviewer.");
  }
  const expected = new Set((plan.decisions ?? []).map((item) => item.id));
  const received = new Map();
  for (const item of review.decisions ?? []) {
    if (!expected.has(item.id)) {
      throw new Error(`Unknown slide layout decision: ${item.id}`);
    }
    if (received.has(item.id)) {
      throw new Error(`Duplicate slide layout review: ${item.id}`);
    }
    const checks = item.checks ?? {};
    for (const name of REVIEW_CHECKS) {
      if (!["pass", "fail"].includes(checks[name])) {
        throw new Error(
          `Slide layout review "${item.id}" check "${name}" must be pass or fail.`
        );
      }
    }
    const notes = String(item.notes ?? "").trim();
    if (REVIEW_CHECKS.some((name) => checks[name] === "fail") && !notes) {
      throw new Error(`Failed slide layout review "${item.id}" requires notes.`);
    }
    received.set(item.id, {
      id: item.id,
      checks: Object.fromEntries(
        REVIEW_CHECKS.map((name) => [name, checks[name]])
      ),
      notes
    });
  }
  const missing = [...expected].filter((id) => !received.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Slide layout review is missing decisions: ${missing.join(", ")}`
    );
  }
  const decisions = [...received.values()];
  const passed = decisions.every((item) =>
    REVIEW_CHECKS.every((name) => item.checks[name] === "pass")
  );
  return {
    ...plan,
    status: passed ? "passed" : "failed",
    updatedAt: reviewedAt,
    review: {
      reviewer,
      reviewedAt,
      decisions
    }
  };
}
