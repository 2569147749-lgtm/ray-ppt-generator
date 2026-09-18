function categoryFor(code) {
  if (code.startsWith("chart-")) return "chart";
  if (code.startsWith("semantic-") || code.includes("emphasis")) {
    return "content-visual";
  }
  if (code.startsWith("accessibility-")) return "accessibility";
  if (
    code.startsWith("typography-") ||
    code.startsWith("font-") ||
    code === "text-overflow"
  ) {
    return "typography";
  }
  if (code.startsWith("image-") || code.includes("stripe")) return "image";
  if (code.startsWith("style-")) return "style";
  if (code === "unexpected-visual-change") return "regression";
  return "layout";
}

function suggestedActionFor(category, code) {
  if (code === "text-overflow") return "shorten-copy-or-reflow";
  if (category === "chart") return "review-chart-data-scale-and-encoding";
  if (category === "content-visual") return "align-content-intent-and-layout";
  if (category === "accessibility") return "repair-accessible-visual-treatment";
  if (category === "typography") return "adjust-copy-or-typography";
  if (category === "image") return "replace-or-reframe-image";
  if (category === "style") return "restore-template-style-contract";
  if (category === "regression") return "inspect-unplanned-change";
  return "custom-layout-edit";
}

function issueKey(finding) {
  return JSON.stringify([
    finding.slide,
    finding.code,
    finding.property ?? "",
    [...(finding.selectors ?? [])].sort()
  ]);
}

function collectBlockers(report) {
  const collected = [];
  for (const capture of report.captures ?? []) {
    for (const finding of capture.findings ?? []) {
      if (finding.severity !== "blocker") continue;
      collected.push({
        ...finding,
        slide: finding.slide ?? capture.slide,
        capture: capture.id
      });
    }
  }
  for (const finding of report.styleConsistency?.findings ?? []) {
    if (finding.severity === "blocker") collected.push(finding);
  }
  for (const finding of report.fontContinuity?.findings ?? []) {
    if (finding.severity === "blocker") collected.push(finding);
  }
  for (const finding of report.visualQuality?.findings ?? []) {
    if (finding.severity === "blocker") collected.push(finding);
  }
  for (const finding of report.semanticEmphasis?.findings ?? []) {
    if (finding.severity === "blocker") collected.push(finding);
  }
  return collected;
}

function safeId(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, "-");
}

export function buildVisualRepairHandoff(
  report,
  createdAt = new Date().toISOString()
) {
  const grouped = new Map();
  for (const finding of collectBlockers(report)) {
    const key = issueKey(finding);
    const current = grouped.get(key);
    if (current) {
      if (finding.capture && !current.captures.includes(finding.capture)) {
        current.captures.push(finding.capture);
      }
      continue;
    }
    grouped.set(key, {
      finding,
      captures: finding.capture ? [finding.capture] : []
    });
  }

  const issues = [...grouped.values()]
    .map(({ finding, captures }) => {
      const category = categoryFor(finding.code);
      const normalizedFinding = { ...finding };
      delete normalizedFinding.capture;
      return {
        id: `visual-${safeId(finding.slide)}-${safeId(finding.code)}`,
        owner: "modification-master",
        slide: finding.slide,
        priority: "blocker",
        category,
        finding: normalizedFinding,
        captures,
        suggestedAction: suggestedActionFor(category, finding.code),
        acceptance: [
          {
            type: "visual-finding-absent",
            code: finding.code,
            slide: finding.slide
          }
        ]
      };
    })
    .sort(
      (first, second) =>
        first.slide.localeCompare(second.slide) ||
        first.finding.code.localeCompare(second.finding.code)
    );

  return {
    schemaVersion: 1,
    deck: report.deck ?? null,
    sourceReport: report.report ?? null,
    createdAt,
    status: issues.length > 0 ? "requires-modification" : "clear",
    owner: "modification-master",
    issues
  };
}
