const CATEGORIES = new Set([
  "user-request",
  "core-conclusion",
  "key-metric",
  "decision-action",
  "contrast"
]);
const TREATMENTS = new Set(["bold", "enlarge", "color", "highlight"]);
const PRIORITIES = new Set(["primary", "secondary"]);
const SOURCES = new Set(["inferred", "user"]);

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

function normalizedLength(text) {
  return String(text ?? "").replace(/\s+/g, "").length;
}

function slideSections(html) {
  const sections = [];
  const pattern =
    /(<section\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*>)([\s\S]*?)<\/section>/gi;
  for (const match of html.matchAll(pattern)) {
    const slide = attribute(match[1], "data-slide-id") || attribute(match[1], "id");
    if (!slide) throw new Error("Every slide must define a stable id.");
    sections.push({ slide, content: match[2], text: visibleText(match[2]) });
  }
  return sections;
}

export function extractEmphasisTargets(html) {
  const targets = [];
  for (const section of slideSections(html)) {
    const editable =
      /(<([a-z][\w:-]*)\b[^>]*\bdata-edit(?:=["'][^"']*["'])?[^>]*>)([\s\S]*?)<\/\2>/gi;
    for (const match of section.content.matchAll(editable)) {
      const role = attribute(match[1], "data-role");
      if (!role) continue;
      targets.push({
        slide: section.slide,
        role,
        text: visibleText(match[3])
      });
    }
  }
  return targets;
}

function validateDecision(decision) {
  const id = String(decision.id ?? "").trim();
  if (!id) throw new Error("Every emphasis decision requires a non-empty id.");
  const slide = String(decision.slide ?? "").trim();
  const role = String(decision.role ?? "").trim();
  const text = String(decision.text ?? "").replace(/\s+/g, " ").trim();
  const rationale = String(decision.rationale ?? "").trim();
  if (!slide || !role || !text || !rationale) {
    throw new Error(
      `Emphasis decision "${id}" requires slide, role, text, and rationale.`
    );
  }
  const source = decision.source ?? "inferred";
  if (!SOURCES.has(source)) {
    throw new Error(`Unsupported emphasis source "${source}" for "${id}".`);
  }
  const category = decision.category ?? (source === "user" ? "user-request" : "");
  if (!CATEGORIES.has(category)) {
    throw new Error(`Unsupported emphasis category "${category}" for "${id}".`);
  }
  const priority = decision.priority ?? "secondary";
  if (!PRIORITIES.has(priority)) {
    throw new Error(`Unsupported emphasis priority "${priority}" for "${id}".`);
  }
  if (!Array.isArray(decision.treatments) || decision.treatments.length === 0) {
    throw new Error(`Emphasis decision "${id}" requires at least one treatment.`);
  }
  const treatments = [...new Set(decision.treatments)];
  for (const treatment of treatments) {
    if (!TREATMENTS.has(treatment)) {
      throw new Error(`Unsupported emphasis treatment "${treatment}" for "${id}".`);
    }
  }
  return {
    id,
    slide,
    role,
    text,
    category,
    rationale,
    source,
    priority,
    treatments
  };
}

export function normalizeEmphasisPlan({
  plan,
  html,
  updatedAt = new Date().toISOString()
}) {
  if (!Array.isArray(plan?.decisions)) {
    throw new Error("Emphasis plan requires a decisions array.");
  }
  const seenIds = new Set();
  const validated = plan.decisions.map((raw) => {
    const item = validateDecision(raw);
    if (seenIds.has(item.id)) {
      throw new Error(`Duplicate emphasis decision id: ${item.id}`);
    }
    seenIds.add(item.id);
    return item;
  });

  const slides = slideSections(html);
  const targets = extractEmphasisTargets(html);
  for (const item of validated) {
    const resolved = targets.some(
      (target) =>
        target.slide === item.slide &&
        target.role === item.role &&
        target.text.includes(item.text)
    );
    if (!resolved) {
      throw new Error(
        `Emphasis decision "${item.id}" does not resolve to exact text in ${item.slide}/${item.role}.`
      );
    }
  }

  const userTargets = new Set(
    validated
      .filter((item) => item.source === "user")
      .map((item) => `${item.slide}\u0000${item.role}\u0000${item.text}`)
  );
  const decisions = validated.filter(
    (item) =>
      item.source === "user" ||
      !userTargets.has(`${item.slide}\u0000${item.role}\u0000${item.text}`)
  );

  for (const slide of slides) {
    const inferred = decisions.filter(
      (item) => item.slide === slide.slide && item.source === "inferred"
    );
    if (inferred.filter((item) => item.priority === "primary").length > 1) {
      throw new Error(
        `Slide "${slide.slide}" allows at most one inferred primary emphasis decision.`
      );
    }
    if (inferred.length > 2) {
      throw new Error(
        `Slide "${slide.slide}" allows at most two inferred decisions.`
      );
    }
    const covered = inferred.reduce(
      (total, item) => total + normalizedLength(item.text),
      0
    );
    const available = normalizedLength(slide.text);
    if (available > 0 && covered / available > 0.25) {
      throw new Error(
        `Slide "${slide.slide}" exceeds the 25% inferred coverage limit.`
      );
    }
  }

  return {
    schemaVersion: 1,
    updatedAt,
    status: "review-required",
    decisions,
    review: null
  };
}

export function applyEmphasisReview(
  plan,
  review,
  reviewedAt = new Date().toISOString()
) {
  const reviewer = String(review?.reviewer ?? "").trim();
  if (!reviewer) throw new Error("Emphasis review requires a non-empty reviewer.");
  const expected = new Set((plan.decisions ?? []).map((item) => item.id));
  const received = new Map();
  for (const item of review.decisions ?? []) {
    if (!expected.has(item.id)) {
      throw new Error(`Unknown emphasis decision: ${item.id}`);
    }
    if (received.has(item.id)) {
      throw new Error(`Duplicate emphasis review: ${item.id}`);
    }
    const checks = item.checks ?? {};
    for (const name of ["relevance", "context", "restraint"]) {
      if (!["pass", "fail"].includes(checks[name])) {
        throw new Error(
          `Emphasis review "${item.id}" check "${name}" must be pass or fail.`
        );
      }
    }
    const notes = String(item.notes ?? "").trim();
    if (Object.values(checks).includes("fail") && !notes) {
      throw new Error(`Failed emphasis review "${item.id}" requires notes.`);
    }
    received.set(item.id, {
      id: item.id,
      checks: {
        relevance: checks.relevance,
        context: checks.context,
        restraint: checks.restraint
      },
      notes
    });
  }
  const missing = [...expected].filter((id) => !received.has(id));
  if (missing.length > 0) {
    throw new Error(`Emphasis review is missing decisions: ${missing.join(", ")}`);
  }
  const decisions = [...received.values()];
  const passed = decisions.every(
    (item) => !Object.values(item.checks).includes("fail")
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
