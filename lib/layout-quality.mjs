function finiteValues(values) {
  return (values ?? [])
    .map(Number)
    .filter((value) => Number.isFinite(value));
}

function spread(values) {
  const finite = finiteValues(values);
  return finite.length > 1 ? Math.max(...finite) - Math.min(...finite) : 0;
}

function outsideRange(value, range) {
  const number = Number(value);
  return (
    !Number.isFinite(number) ||
    !Array.isArray(range) ||
    range.length !== 2 ||
    number < Number(range[0]) ||
    number > Number(range[1])
  );
}

function finding(profile, group, code, severity, property, expected, actual, message) {
  return {
    code,
    severity,
    slide: profile.slide,
    layout: profile.layout,
    selectors: group?.selector ? [group.selector] : [],
    property,
    expected,
    actual,
    message
  };
}

export function analyzeLayoutQuality({ profiles = [], contract = null }) {
  const rules = contract?.layoutQuality ?? {};
  const balanceRules = rules.balance ?? {};
  const exemptLayouts = new Set(balanceRules.exemptLayouts ?? []);
  const findings = [];

  for (const profile of profiles) {
    if (!exemptLayouts.has(profile.layout) && profile.metrics) {
      const outsideCenter =
        (balanceRules.centerX &&
          outsideRange(profile.metrics.centerX, balanceRules.centerX)) ||
        (balanceRules.centerY &&
          outsideRange(profile.metrics.centerY, balanceRules.centerY));
      if (outsideCenter) {
        findings.push(
          finding(
            profile,
            null,
            "layout-visual-balance",
            "warning",
            "metrics.center",
            {
              x: balanceRules.centerX,
              y: balanceRules.centerY
            },
            {
              x: profile.metrics.centerX,
              y: profile.metrics.centerY
            },
            `${profile.slide} has a strongly displaced visual center.`
          )
        );
      }

      if (
        balanceRules.coverage &&
        outsideRange(profile.metrics.coverage, balanceRules.coverage)
      ) {
        findings.push(
          finding(
            profile,
            null,
            "layout-content-density",
            "warning",
            "metrics.coverage",
            { range: balanceRules.coverage },
            profile.metrics.coverage,
            `${profile.slide} has unusually sparse or dense visible content.`
          )
        );
      }
    }

    const groupRules = rules.repeatedGroupsByLayout?.[profile.layout];
    if (!groupRules) continue;
    for (const group of profile.repeatedGroups ?? []) {
      if (group.allow || group.orientation !== groupRules.orientation) continue;
      const gapSpread = spread(group.gaps);
      if (
        groupRules.gapTolerance !== undefined &&
        gapSpread > Number(groupRules.gapTolerance)
      ) {
        findings.push(
          finding(
            profile,
            group,
            "layout-uneven-spacing",
            "blocker",
            "gaps",
            { maxSpread: Number(groupRules.gapTolerance) },
            { values: group.gaps, spread: gapSpread },
            `${group.selector} has inconsistent spacing between repeated items.`
          )
        );
      }

      const crossAxisSpread = spread(group.crossAxisPositions);
      if (
        groupRules.crossAxisTolerance !== undefined &&
        crossAxisSpread > Number(groupRules.crossAxisTolerance)
      ) {
        findings.push(
          finding(
            profile,
            group,
            "layout-misalignment",
            "blocker",
            "crossAxisPositions",
            { maxSpread: Number(groupRules.crossAxisTolerance) },
            {
              values: group.crossAxisPositions,
              spread: crossAxisSpread
            },
            `${group.selector} has misaligned repeated items.`
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
