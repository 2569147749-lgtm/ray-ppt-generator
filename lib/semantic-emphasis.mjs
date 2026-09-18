function finding({
  code,
  decision = null,
  candidate = null,
  message,
  expected = null,
  actual = null
}) {
  return {
    code,
    severity: "blocker",
    slide: decision?.slide ?? candidate?.slide ?? null,
    role: decision?.role ?? candidate?.role ?? null,
    decisionId: decision?.id ?? candidate?.id ?? null,
    selector: candidate?.selector ?? null,
    expected,
    actual,
    message
  };
}

export function analyzeSemanticEmphasis({ profiles = [], plan = null }) {
  if (!plan) {
    return {
      status: "not-configured",
      passed: true,
      decisions: 0,
      candidates: profiles.reduce(
        (total, profile) => total + (profile.candidates?.length ?? 0),
        0
      ),
      findings: []
    };
  }

  const decisions = plan.decisions ?? [];
  const candidates = profiles.flatMap((profile) =>
    (profile.candidates ?? []).map((candidate) => ({
      ...candidate,
      slide: candidate.slide ?? profile.slide
    }))
  );
  const findings = [];
  if (plan.status !== "passed") {
    findings.push(
      finding({
        code: "emphasis-plan-not-approved",
        message: `Semantic emphasis plan is "${plan.status ?? "unknown"}"; review must pass before visual audit.`,
        expected: "passed",
        actual: plan.status ?? null
      })
    );
  }

  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
  const renderedIds = new Set();
  for (const candidate of candidates) {
    const decision = candidate.id ? decisionById.get(candidate.id) : null;
    if (!decision) {
      findings.push(
        finding({
          code: "unplanned-emphasis",
          candidate,
          message: `Rendered emphasis "${candidate.text}" is not present in the semantic emphasis plan.`,
          expected: "planned emphasis id",
          actual: candidate.id
        })
      );
      continue;
    }
    renderedIds.add(decision.id);
    if (candidate.slide !== decision.slide || candidate.text !== decision.text) {
      findings.push(
        finding({
          code: "stale-emphasis-text",
          decision,
          candidate,
          message: `Rendered emphasis "${decision.id}" no longer matches its planned slide text.`,
          expected: { slide: decision.slide, text: decision.text },
          actual: { slide: candidate.slide, text: candidate.text }
        })
      );
    }
    if (candidate.role !== decision.role) {
      findings.push(
        finding({
          code: "emphasis-role-mismatch",
          decision,
          candidate,
          message: `Rendered emphasis "${decision.id}" uses role "${candidate.role}" instead of "${decision.role}".`,
          expected: decision.role,
          actual: candidate.role
        })
      );
    }
    const expectedTreatments = [...new Set(decision.treatments ?? [])].sort();
    const actualTreatments = [...new Set(candidate.treatments ?? [])].sort();
    if (
      expectedTreatments.length !== actualTreatments.length ||
      expectedTreatments.some(
        (treatment, index) => treatment !== actualTreatments[index]
      )
    ) {
      findings.push(
        finding({
          code: "emphasis-treatment-mismatch",
          decision,
          candidate,
          message: `Rendered emphasis "${decision.id}" does not use its planned treatments.`,
          expected: expectedTreatments,
          actual: actualTreatments
        })
      );
    }
  }

  for (const decision of decisions) {
    if (renderedIds.has(decision.id)) continue;
    findings.push(
      finding({
        code: "planned-emphasis-missing",
        decision,
        message: `Planned emphasis "${decision.id}" was not rendered.`,
        expected: decision.treatments,
        actual: []
      })
    );
  }

  return {
    status: findings.length === 0 ? "passed" : "failed",
    passed: findings.length === 0,
    decisions: decisions.length,
    candidates: candidates.length,
    findings
  };
}
