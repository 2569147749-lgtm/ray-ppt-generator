function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finding(profile, selector, code, property, expected, actual, message) {
  return {
    code,
    severity: "blocker",
    slide: profile.slide,
    layout: profile.layout,
    selectors: selector ? [selector] : [],
    property,
    expected,
    actual,
    message
  };
}

export function analyzeAccessibilityQuality({
  profiles = [],
  contract = null
}) {
  const rules = contract?.accessibilityQuality ?? {};
  const findings = [];

  for (const profile of profiles) {
    if (profile.allow) continue;
    if (rules.requireSlideLabel && !String(profile.slideLabel ?? "").trim()) {
      findings.push(
        finding(
          profile,
          null,
          "accessibility-slide-label",
          "slideLabel",
          "non-empty",
          profile.slideLabel ?? "",
          `${profile.slide} has no accessible slide label.`
        )
      );
    }

    for (const text of profile.texts ?? []) {
      if (text.allow || !String(text.text ?? "").trim()) continue;
      const fontSize = finite(text.fontSize);
      if (
        rules.minTextSize !== undefined &&
        (fontSize === null || fontSize < Number(rules.minTextSize))
      ) {
        findings.push(
          finding(
            profile,
            text.selector,
            "accessibility-text-size",
            "fontSize",
            { min: Number(rules.minTextSize) },
            fontSize,
            `${text.selector} is too small for reliable projected reading.`
          )
        );
      }

      const fontWeight = finite(text.fontWeight) ?? 400;
      const large =
        fontSize !== null &&
        (fontSize >= Number(rules.largeTextMin ?? Infinity) ||
          (fontWeight >= 700 &&
            fontSize >= Number(rules.largeBoldTextMin ?? Infinity)));
      const minimumContrast = Number(
        large ? rules.minContrastLarge : rules.minContrastNormal
      );
      const contrastRatio = finite(text.contrastRatio);
      if (
        Number.isFinite(minimumContrast) &&
        (contrastRatio === null || contrastRatio < minimumContrast)
      ) {
        findings.push(
          finding(
            profile,
            text.selector,
            "accessibility-contrast",
            "contrastRatio",
            { min: minimumContrast },
            contrastRatio,
            `${text.selector} does not meet the declared text contrast threshold.`
          )
        );
      }
    }

    if (rules.requireImageAlt) {
      for (const image of profile.images ?? []) {
        if (image.allow || String(image.alt ?? "").trim()) continue;
        findings.push(
          finding(
            profile,
            image.selector,
            "accessibility-image-alt",
            "alt",
            "non-empty",
            image.alt ?? "",
            `${image.selector} has no meaningful alternative text.`
          )
        );
      }
    }

    if (rules.requireRedundantColorLabels) {
      for (const encoding of profile.colorEncodings ?? []) {
        if (encoding.allow) continue;
        const unlabeled = (encoding.items ?? []).filter(
          (item) => !item.allow && !String(item.label ?? "").trim()
        );
        for (const item of unlabeled) {
          findings.push(
            finding(
              profile,
              item.selector ?? encoding.selector,
              "accessibility-color-only",
              "colorEncoding.label",
              "non-empty redundant label",
              item.label ?? "",
              `${item.selector ?? encoding.selector} relies on color without a redundant label.`
            )
          );
        }
      }
    }
  }

  return {
    passed: !findings.some((item) => item.severity === "blocker"),
    checkedSlides: profiles.map((profile) => profile.slide),
    findings
  };
}
