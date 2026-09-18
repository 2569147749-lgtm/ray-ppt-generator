function primaryFontFamily(value) {
  return String(value ?? "")
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
}

function normalizeColor(value) {
  const color = String(value ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  const rgb = color.match(/^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/);
  if (!rgb) return color;
  return `#${rgb
    .slice(1, 4)
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function outsideTolerance(actual, expected, tolerance) {
  return !Number.isFinite(actual) || Math.abs(actual - expected) > tolerance;
}

function blocker({ code, slide, property, expected, actual, message }) {
  return {
    code,
    severity: "blocker",
    slide,
    property,
    expected,
    actual,
    message
  };
}

function checkMetricGroup(findings, profile, code, property, actual, expected) {
  if (!expected) return;
  const tolerance = Number(expected.tolerance ?? 1);
  for (const [name, value] of Object.entries(expected)) {
    if (name === "tolerance" || name === "required") continue;
    if (!outsideTolerance(Number(actual?.[name]), Number(value), tolerance)) continue;
    findings.push(
      blocker({
        code,
        slide: profile.slide,
        property: `${property}.${name}`,
        expected: { value, tolerance },
        actual: actual?.[name] ?? null,
        message: `${profile.slide} ${property}.${name} is outside the declared style contract.`
      })
    );
  }
}

function authorizedFontFamilies(plan) {
  const bySlide = new Map();
  for (const change of plan?.changes ?? []) {
    const authorization = change.typographyAuthorization;
    if (
      !authorization?.properties?.includes("fontFamily") ||
      !String(authorization.fontFamily ?? "").trim()
    ) {
      continue;
    }
    for (const slide of change.targets ?? []) {
      const families = bySlide.get(slide) ?? new Set();
      families.add(primaryFontFamily(authorization.fontFamily));
      bySlide.set(slide, families);
    }
  }
  return bySlide;
}

function explicitContractFindings(profiles, rules, plan) {
  const findings = [];
  const allowedFonts = new Set(rules.allowedFontFamilies ?? []);
  const allowedColors = new Set((rules.allowedColors ?? []).map(normalizeColor));
  const authorizedFonts = authorizedFontFamilies(plan);

  for (const profile of profiles) {
    if (allowedFonts.size > 0) {
      for (const item of profile.fontFamilies ?? []) {
        const family = primaryFontFamily(item.value);
        if (
          !family ||
          allowedFonts.has(family) ||
          authorizedFonts.get(profile.slide)?.has(family)
        ) {
          continue;
        }
        findings.push(
          blocker({
            code: "style-font-family",
            slide: profile.slide,
            property: "fontFamily",
            expected: [...allowedFonts],
            actual: family,
            message: `${profile.slide} uses undeclared font family ${family}.`
          })
        );
      }
    }

    if (allowedColors.size > 0) {
      for (const [name, value] of Object.entries(profile.semanticColors ?? {})) {
        const color = normalizeColor(value);
        if (!color || allowedColors.has(color)) continue;
        findings.push(
          blocker({
            code: "style-color",
            slide: profile.slide,
            property: `semanticColors.${name}`,
            expected: [...allowedColors],
            actual: color,
            message: `${profile.slide} uses undeclared semantic color ${color}.`
          })
        );
      }
    }

    checkMetricGroup(
      findings,
      profile,
      "style-slide-inset",
      "insets",
      profile.insets,
      rules.slideInsets
    );

    if (rules.footer?.required && !profile.footer) {
      findings.push(
        blocker({
          code: "style-footer",
          slide: profile.slide,
          property: "footer",
          expected: "present",
          actual: null,
          message: `${profile.slide} is missing the required footer.`
        })
      );
    } else {
      checkMetricGroup(
        findings,
        profile,
        "style-footer",
        "footer",
        profile.footer,
        rules.footer
      );
    }

    const titleRange = rules.titleByLayout?.[profile.layout];
    if (titleRange && !profile.title) {
      findings.push(
        blocker({
          code: "style-title-hierarchy",
          slide: profile.slide,
          property: "title",
          expected: "present",
          actual: null,
          message: `${profile.slide} is missing the required layout title.`
        })
      );
    } else if (titleRange) {
      const fontSize = Number(profile.title.fontSize);
      if (
        !Number.isFinite(fontSize) ||
        fontSize < Number(titleRange.min) ||
        fontSize > Number(titleRange.max)
      ) {
        findings.push(
          blocker({
            code: "style-title-hierarchy",
            slide: profile.slide,
            property: "title.fontSize",
            expected: titleRange,
            actual: profile.title.fontSize,
            message: `${profile.slide} title size is outside its layout range.`
          })
        );
      }
    }
  }
  return findings;
}

function inferredOutlierFindings(profiles, rules) {
  if ((rules.allowedFontFamilies ?? []).length > 0) return [];
  const exempt = new Set(rules.outlierExemptLayouts ?? []);
  const candidates = profiles
    .filter((profile) => !exempt.has(profile.layout) && profile.title?.fontFamily)
    .map((profile) => ({
      profile,
      family: primaryFontFamily(profile.title.fontFamily)
    }))
    .filter((item) => item.family);
  const counts = new Map();
  for (const { family } of candidates) {
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const [dominantFamily, dominantCount = 0] = [...counts.entries()].sort(
    (first, second) => second[1] - first[1] || first[0].localeCompare(second[0])
  )[0] ?? [];
  if (!dominantFamily || dominantCount < 2) return [];

  return candidates
    .filter(({ family }) => family !== dominantFamily && counts.get(family) === 1)
    .map(({ profile, family }) => ({
      code: "style-title-font-outlier",
      severity: "warning",
      slide: profile.slide,
      property: "title.fontFamily",
      expected: dominantFamily,
      actual: family,
      message: `${profile.slide} title font differs from the deck majority.`
    }));
}

export function analyzeStyleConsistency({
  profiles = [],
  contract = null,
  plan = null
}) {
  const rules = contract?.styleConsistency ?? {};
  const findings = [
    ...explicitContractFindings(profiles, rules, plan),
    ...inferredOutlierFindings(profiles, rules)
  ];
  return {
    passed: !findings.some((finding) => finding.severity === "blocker"),
    checkedSlides: profiles.map((profile) => profile.slide),
    findings
  };
}
