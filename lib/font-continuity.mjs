function primaryFontFamily(value) {
  return String(value ?? "")
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
}

function normalizedRuns(element) {
  return (element.fontRuns ?? [])
    .map((run) => ({
      fontFamily: primaryFontFamily(run.fontFamily),
      fontWeight: Number(run.fontWeight),
      fontAvailable: run.fontAvailable !== false
    }))
    .filter(
      (run) =>
        run.fontFamily &&
        Number.isFinite(run.fontWeight) &&
        run.fontWeight >= 1 &&
        run.fontWeight <= 1000
    );
}

function values(runs, property) {
  return [...new Set(runs.map((run) => run[property]))].sort((first, second) =>
    typeof first === "number" ? first - second : first.localeCompare(second)
  );
}

function elementValues(element, property) {
  if (property === "fontFamily" && (element.platformFonts ?? []).length > 0) {
    return [
      ...new Set(
        element.platformFonts
          .filter((font) => Number(font.glyphCount ?? 0) > 0)
          .map((font) => primaryFontFamily(font.fontFamily))
          .filter(Boolean)
      )
    ].sort((first, second) => first.localeCompare(second));
  }
  return values(element.runs, property);
}

function declaredValues(element, property) {
  return values(element.runs, property);
}

function profileElements(profiles) {
  return (profiles ?? []).flatMap((profile) =>
    (profile.typography ?? []).map((element) => ({
      ...element,
      slide: profile.slide,
      layout: profile.layout,
      runs: normalizedRuns(element)
    }))
  );
}

function elementKey(element) {
  return `${element.slide}\u0000${element.selector}`;
}

function authorizations(plan) {
  return (plan?.changes ?? []).flatMap((change) => {
    const authorization = change.typographyAuthorization;
    if (!authorization) return [];
    return (change.targets ?? []).map((slide) => ({
      slide,
      role: authorization.role,
      itemId: authorization.itemId ?? null,
      properties: new Set(authorization.properties ?? []),
      fontFamily: primaryFontFamily(authorization.fontFamily),
      fontWeight: Number(authorization.fontWeight)
    }));
  });
}

function matchingAuthorization(authorizations, element, property, actual) {
  return authorizations.some((authorization) => {
    if (
      authorization.slide !== element.slide ||
      authorization.role !== element.role ||
      authorization.itemId !== (element.itemId ?? null) ||
      !authorization.properties.has(property)
    ) {
      return false;
    }
    return property === "fontFamily"
      ? authorization.fontFamily === actual
      : authorization.fontWeight === actual;
  });
}

function finding(element, code, property, expected, actual, message) {
  return {
    code,
    severity: "blocker",
    slide: element.slide,
    layout: element.layout,
    selectors: [element.selector],
    role: element.role ?? null,
    itemId: element.itemId ?? null,
    property,
    expected,
    actual,
    message
  };
}

function contractFindings(elements, contract, authorizations) {
  const findings = [];
  const rules = contract?.styleConsistency?.typographyByRole ?? {};
  for (const element of elements) {
    const roleRules = rules[element.role];
    if (!roleRules) continue;
    const allowedFamilies = new Set(
      (roleRules.fontFamilies ?? []).map(primaryFontFamily)
    );
    const allowedWeights = new Set(
      (roleRules.fontWeights ?? []).map(Number)
    );
    for (const family of declaredValues(element, "fontFamily")) {
      if (
        allowedFamilies.size === 0 ||
        allowedFamilies.has(family) ||
        matchingAuthorization(authorizations, element, "fontFamily", family)
      ) {
        continue;
      }
      findings.push(
        finding(
          element,
          "font-role-family",
          "fontFamily",
          [...allowedFamilies],
          family,
          `${element.slide} ${element.role} uses a font family outside its template role contract.`
        )
      );
    }
    for (const weight of declaredValues(element, "fontWeight")) {
      if (
        allowedWeights.size === 0 ||
        allowedWeights.has(weight) ||
        matchingAuthorization(authorizations, element, "fontWeight", weight)
      ) {
        continue;
      }
      findings.push(
        finding(
          element,
          "font-role-weight",
          "fontWeight",
          [...allowedWeights].sort((first, second) => first - second),
          weight,
          `${element.slide} ${element.role} uses a font weight outside its template role contract.`
        )
      );
    }
  }
  return findings;
}

function driftFindings(elements, baselineElements, authorizations) {
  const findings = [];
  const baselineByKey = new Map(
    baselineElements.map((element) => [elementKey(element), element])
  );
  for (const element of elements) {
    const baseline = baselineByKey.get(elementKey(element));
    if (!baseline) continue;
    for (const [property, code] of [
      ["fontFamily", "font-family-drift"],
      ["fontWeight", "font-weight-drift"]
    ]) {
      const before = elementValues(baseline, property);
      const after = elementValues(element, property);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const added = after.filter((value) => !before.includes(value));
      const declaredAfter = declaredValues(element, property);
      const declaredBefore = declaredValues(baseline, property);
      const declaredAdded = declaredAfter.filter(
        (value) => !declaredBefore.includes(value)
      );
      if (
        added.length > 0 &&
        declaredAdded.length > 0 &&
        declaredAdded.every((value) =>
          matchingAuthorization(authorizations, element, property, value)
        )
      ) {
        continue;
      }
      findings.push(
        finding(
          element,
          code,
          property,
          before,
          after,
          `${element.slide} ${element.role} changed ${property} without an exact user authorization.`
        )
      );
    }
  }
  return findings;
}

export function analyzeFontContinuity({
  profiles = [],
  baselineProfiles = [],
  contract = null,
  plan = null
}) {
  const elements = profileElements(profiles);
  const baselineElements = profileElements(baselineProfiles);
  const scopedAuthorizations = authorizations(plan);
  const findings = [
    ...contractFindings(elements, contract, scopedAuthorizations),
    ...driftFindings(elements, baselineElements, scopedAuthorizations)
  ];
  return {
    passed: findings.length === 0,
    checkedSlides: [...new Set(elements.map((element) => element.slide))],
    findings
  };
}
