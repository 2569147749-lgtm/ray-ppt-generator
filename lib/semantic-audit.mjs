function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1] ?? "";
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function visibleText(html) {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSemanticSlides(html) {
  const slides = [];
  const pattern =
    /(<section\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*>)([\s\S]*?)<\/section>/gi;
  for (const match of html.matchAll(pattern)) {
    const openingTag = match[1];
    const content = match[2];
    const id = attribute(openingTag, "data-slide-id") || attribute(openingTag, "id");
    if (!id) throw new Error("Every semantic slide must define a stable id.");
    const heading = content.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i)?.[1];
    slides.push({
      id,
      position: slides.length + 1,
      layout: attribute(openingTag, "data-layout") || "unknown",
      title: heading ? visibleText(heading) : attribute(openingTag, "aria-label"),
      text: visibleText(content)
    });
  }
  return slides;
}

export function applySemanticReview(
  report,
  review,
  reviewedAt = new Date().toISOString()
) {
  if (!review.reviewer?.trim()) {
    throw new Error("Semantic review requires a non-empty reviewer.");
  }
  const expected = new Set(report.changes.map((change) => change.id));
  const received = new Map();
  for (const item of review.changes ?? []) {
    if (!expected.has(item.id)) throw new Error(`Unknown semantic change: ${item.id}`);
    if (received.has(item.id)) throw new Error(`Duplicate semantic review: ${item.id}`);
    const checks = item.checks ?? {};
    for (const name of ["intent", "context"]) {
      if (!["pass", "fail"].includes(checks[name])) {
        throw new Error(`Semantic review "${item.id}" check "${name}" must be pass or fail.`);
      }
    }
    if (!["pass", "fail", "not-applicable"].includes(checks.facts)) {
      throw new Error(
        `Semantic review "${item.id}" check "facts" must be pass, fail, or not-applicable.`
      );
    }
    const failed = Object.values(checks).includes("fail");
    const notes = String(item.notes ?? "").trim();
    if (failed && !notes) {
      throw new Error(`Failed semantic review "${item.id}" requires notes.`);
    }
    received.set(item.id, {
      id: item.id,
      checks: {
        intent: checks.intent,
        context: checks.context,
        facts: checks.facts
      },
      notes
    });
  }

  const missing = [...expected].filter((id) => !received.has(id));
  if (missing.length > 0) {
    throw new Error(`Semantic review is missing changes: ${missing.join(", ")}`);
  }
  const changes = report.changes.map((change) => received.get(change.id));
  const passed = changes.every(
    (change) => !Object.values(change.checks).includes("fail")
  );
  return {
    ...report,
    status: passed ? "passed" : "failed",
    updatedAt: reviewedAt,
    review: {
      reviewer: review.reviewer.trim(),
      reviewedAt,
      changes
    }
  };
}

export function semanticEvidence({ plan, sourceSlides, revisedSlides }) {
  const sourceById = new Map(sourceSlides.map((slide) => [slide.id, slide]));
  const revisedById = new Map(revisedSlides.map((slide) => [slide.id, slide]));
  return (plan.changes ?? []).map((change) => ({
    id: change.id,
    request: String(change.request ?? ""),
    type: change.type ?? null,
    command: change.command ?? null,
    targets: change.targets ?? [],
    verificationStatus: change.status ?? "pending",
    assertions: change.verification?.assertions ?? [],
    before: (change.targets ?? [])
      .map((target) => sourceById.get(target))
      .filter(Boolean),
    after: (change.targets ?? [])
      .map((target) => revisedById.get(target))
      .filter(Boolean)
  }));
}
