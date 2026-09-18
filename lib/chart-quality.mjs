function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finding(profile, chart, code, severity, property, expected, actual, message) {
  return {
    code,
    severity,
    slide: profile.slide,
    layout: profile.layout,
    selectors: chart.selector ? [chart.selector] : [],
    property,
    expected,
    actual,
    message
  };
}

export function analyzeChartQuality({ profiles = [], contract = null }) {
  const rules = contract?.chartQuality ?? {};
  const supportedTypes = new Set(rules.supportedTypes ?? []);
  const findings = [];

  for (const profile of profiles) {
    for (const chart of profile.charts ?? []) {
      if (chart.allow) continue;
      if (rules.requiredTitle && !String(chart.title ?? "").trim()) {
        findings.push(
          finding(
            profile,
            chart,
            "chart-missing-title",
            "blocker",
            "title",
            "non-empty",
            chart.title ?? "",
            `${chart.selector} has no declared chart title.`
          )
        );
      }
      if (rules.requiredSource && !String(chart.source ?? "").trim()) {
        findings.push(
          finding(
            profile,
            chart,
            "chart-missing-source",
            "blocker",
            "source",
            "non-empty",
            chart.source ?? "",
            `${chart.selector} has no declared data source or calculation note.`
          )
        );
      }
      if (supportedTypes.size > 0 && !supportedTypes.has(chart.type)) {
        findings.push(
          finding(
            profile,
            chart,
            "chart-unsupported-type",
            "warning",
            "type",
            [...supportedTypes],
            chart.type ?? null,
            `${chart.selector} uses a chart type without a declared quality contract.`
          )
        );
      }

      const pointRules = rules[chart.type] ?? {};
      for (const point of chart.points ?? []) {
        if (
          (rules.requiredPointLabels || pointRules.requireLabels) &&
          !String(point.label ?? "").trim()
        ) {
          findings.push(
            finding(
              profile,
              { ...chart, selector: point.selector ?? chart.selector },
              "chart-missing-label",
              "blocker",
              "point.label",
              "non-empty",
              point.label ?? "",
              `${point.selector ?? chart.selector} has no redundant data label.`
            )
          );
        }
      }
      if (!supportedTypes.has(chart.type)) continue;

      const minimum = finite(chart.scale?.min);
      const maximum = finite(chart.scale?.max);
      if (minimum === null || maximum === null || maximum <= minimum) {
        findings.push(
          finding(
            profile,
            chart,
            "chart-invalid-domain",
            "blocker",
            "scale",
            "finite min < max",
            chart.scale ?? null,
            `${chart.selector} has an invalid numeric domain.`
          )
        );
        continue;
      }
      if (pointRules.requireZeroBaseline && minimum !== 0) {
        findings.push(
          finding(
            profile,
            chart,
            "chart-nonzero-baseline",
            "blocker",
            "scale.min",
            0,
            minimum,
            `${chart.selector} must use a zero baseline for proportional bars.`
          )
        );
      }

      const ticks = (chart.ticks ?? []).map(finite);
      if (
        ticks.some((tick) => tick === null) ||
        ticks.some((tick, index) => index > 0 && tick <= ticks[index - 1])
      ) {
        findings.push(
          finding(
            profile,
            chart,
            "chart-tick-order",
            "blocker",
            "ticks",
            "strictly ascending numeric values",
            chart.ticks ?? [],
            `${chart.selector} has unordered or non-numeric axis ticks.`
          )
        );
      }

      for (const point of chart.points ?? []) {
        const value = finite(point.value);
        if (value === null || value < minimum || value > maximum) {
          findings.push(
            finding(
              profile,
              { ...chart, selector: point.selector ?? chart.selector },
              "chart-value-out-of-domain",
              "blocker",
              "point.value",
              { min: minimum, max: maximum },
              point.value ?? null,
              `${point.selector ?? chart.selector} lies outside the chart domain.`
            )
          );
          continue;
        }
        if (chart.type !== "bar") continue;
        const drawnFraction = finite(point.drawnFraction);
        const expectedFraction = (value - minimum) / (maximum - minimum);
        const tolerance = Number(pointRules.widthTolerance ?? 0);
        if (
          drawnFraction === null ||
          Math.abs(drawnFraction - expectedFraction) > tolerance
        ) {
          findings.push(
            finding(
              profile,
              { ...chart, selector: point.selector ?? chart.selector },
              "chart-bar-scale-mismatch",
              "blocker",
              "point.drawnFraction",
              { value: expectedFraction, tolerance },
              drawnFraction,
              `${point.selector ?? chart.selector} length does not match its value.`
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
