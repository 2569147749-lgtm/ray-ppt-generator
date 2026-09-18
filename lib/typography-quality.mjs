function finding(element, profile, code, severity, property, expected, actual, message) {
  return {
    code,
    severity,
    slide: profile.slide,
    layout: profile.layout,
    selectors: [element.selector],
    role: element.role ?? null,
    property,
    expected,
    actual,
    message
  };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rulesFor(element, rules) {
  return {
    ...(rules.default ?? {}),
    ...(rules.roleRules?.[element.role] ?? {})
  };
}

export function analyzeTypographyQuality({ profiles = [], contract = null }) {
  const rules = contract?.typographyQuality ?? {};
  const findings = [];

  for (const profile of profiles) {
    for (const element of profile.elements ?? []) {
      if (element.allow) continue;
      const elementRules = rulesFor(element, rules);
      const fontSize = finite(element.fontSize);
      const lineHeight = finite(element.lineHeight);
      const lineCount = finite(element.lineCount);
      const lineCharacterCounts = (element.lineCharacterCounts ?? [])
        .map(finite)
        .filter((value) => value !== null);

      if (
        elementRules.minFontSize !== undefined &&
        (fontSize === null || fontSize < Number(elementRules.minFontSize))
      ) {
        findings.push(
          finding(
            element,
            profile,
            "typography-font-size",
            "blocker",
            "fontSize",
            { min: Number(elementRules.minFontSize) },
            fontSize,
            `${element.selector} is smaller than the declared readable size.`
          )
        );
      }

      const lineHeightRatio =
        fontSize && lineHeight !== null ? lineHeight / fontSize : null;
      if (
        elementRules.minLineHeightRatio !== undefined &&
        (lineHeightRatio === null ||
          lineHeightRatio < Number(elementRules.minLineHeightRatio))
      ) {
        findings.push(
          finding(
            element,
            profile,
            "typography-line-height",
            "blocker",
            "lineHeightRatio",
            { min: Number(elementRules.minLineHeightRatio) },
            lineHeightRatio,
            `${element.selector} line height is too tight for its font size.`
          )
        );
      }

      if (
        elementRules.maxLines !== undefined &&
        (lineCount === null || lineCount > Number(elementRules.maxLines))
      ) {
        findings.push(
          finding(
            element,
            profile,
            "typography-line-count",
            "blocker",
            "lineCount",
            { max: Number(elementRules.maxLines) },
            lineCount,
            `${element.selector} exceeds the declared line-count limit.`
          )
        );
      }

      const maxLineCharacters =
        lineCharacterCounts.length > 0 ? Math.max(...lineCharacterCounts) : 0;
      if (
        elementRules.maxLineCharacters !== undefined &&
        maxLineCharacters > Number(elementRules.maxLineCharacters)
      ) {
        findings.push(
          finding(
            element,
            profile,
            "typography-long-line",
            "warning",
            "maxLineCharacters",
            { max: Number(elementRules.maxLineCharacters) },
            maxLineCharacters,
            `${element.selector} contains a line that may be difficult to scan.`
          )
        );
      }

      const finalLineCharacters = lineCharacterCounts.at(-1) ?? 0;
      if (
        lineCount > 1 &&
        elementRules.orphanMinCharacters !== undefined &&
        finalLineCharacters > 0 &&
        finalLineCharacters < Number(elementRules.orphanMinCharacters)
      ) {
        findings.push(
          finding(
            element,
            profile,
            "typography-orphan-line",
            "warning",
            "finalLineCharacters",
            { min: Number(elementRules.orphanMinCharacters) },
            finalLineCharacters,
            `${element.selector} ends with an isolated final-line glyph.`
          )
        );
      }
    }
  }

  return {
    passed: !findings.some((item) => item.severity === "blocker"),
    checkedSlides: profiles.map((profile) => profile.slide),
    findings
  };
}
