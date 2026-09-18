function finding(profile, code, severity, property, expected, actual, message) {
  return {
    code,
    severity,
    slide: profile.slide,
    layout: profile.layout,
    selectors: (profile.primaryEmphasis ?? []).map((item) => item.selector),
    property,
    expected,
    actual,
    message
  };
}

export function analyzeSemanticVisualQuality({
  profiles = [],
  contract = null
}) {
  const layoutRules =
    contract?.semanticVisualQuality?.layoutRules ?? {};
  const findings = [];

  for (const profile of profiles) {
    if (profile.allow) continue;
    const rules = layoutRules[profile.layout];
    if (!rules) continue;

    const intent = String(profile.intent ?? "").trim();
    if (!intent) {
      findings.push(
        finding(
          profile,
          "semantic-missing-intent",
          "warning",
          "intent",
          rules.allowedIntents ?? [],
          intent,
          `${profile.slide} does not declare its visual communication intent.`
        )
      );
    } else if (
      (rules.allowedIntents ?? []).length > 0 &&
      !rules.allowedIntents.includes(intent)
    ) {
      findings.push(
        finding(
          profile,
          "semantic-intent-mismatch",
          "blocker",
          "intent",
          rules.allowedIntents,
          intent,
          `${profile.slide} uses an intent incompatible with its layout.`
        )
      );
    }

    const signals = new Set(profile.signals ?? []);
    for (const signal of rules.requiredSignals ?? []) {
      if (signals.has(signal)) continue;
      findings.push(
        finding(
          profile,
          "semantic-missing-evidence",
          "blocker",
          "signals",
          signal,
          [...signals],
          `${profile.slide} lacks the required ${signal} evidence for its intent.`
        )
      );
    }

    const emphasis = profile.primaryEmphasis ?? [];
    if (emphasis.length === 0) {
      findings.push(
        finding(
          profile,
          "semantic-missing-emphasis",
          "warning",
          "primaryEmphasis",
          "exactly one",
          0,
          `${profile.slide} has no declared primary emphasis target.`
        )
      );
    } else if (emphasis.length > 1) {
      findings.push(
        finding(
          profile,
          "semantic-ambiguous-emphasis",
          "warning",
          "primaryEmphasis",
          "exactly one",
          emphasis.length,
          `${profile.slide} declares competing primary emphasis targets.`
        )
      );
    } else if (
      (rules.primaryRoles ?? []).length > 0 &&
      !rules.primaryRoles.includes(emphasis[0].role)
    ) {
      findings.push(
        finding(
          profile,
          "semantic-primary-role",
          "blocker",
          "primaryEmphasis.role",
          rules.primaryRoles,
          emphasis[0].role ?? null,
          `${profile.slide} emphasizes a role incompatible with its layout intent.`
        )
      );
    }
  }

  return {
    passed: !findings.some((item) => item.severity === "blocker"),
    checkedSlides: profiles.map((profile) => profile.slide),
    findings
  };
}
