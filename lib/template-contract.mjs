const REQUIRED_SECTIONS = [
  "layouts",
  "styleConsistency",
  "typographyQuality",
  "imageQuality",
  "layoutQuality",
  "chartQuality",
  "semanticVisualQuality",
  "accessibilityQuality",
  "layoutSelection"
];

const LAYOUT_DENSITIES = new Set(["speaker-led", "balanced", "dense"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function add(errors, path, message) {
  errors.push({ path, message });
}

function numericRange(errors, value, path, minimum, maximum) {
  if (!finite(value) || Number(value) < minimum || Number(value) > maximum) {
    add(errors, path, `must be between ${minimum} and ${maximum}`);
  }
}

export function validateTemplateContract(contract) {
  const errors = [];
  if (!object(contract)) {
    return {
      valid: false,
      errors: [{ path: "$", message: "must be an object" }]
    };
  }
  if (!Number.isInteger(contract.schemaVersion) || contract.schemaVersion < 1) {
    add(errors, "schemaVersion", "must be a positive integer");
  }
  if (!String(contract.template ?? "").trim()) {
    add(errors, "template", "must be a non-empty string");
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!object(contract[section])) {
      add(errors, section, "must be an object");
    }
  }

  const layouts = object(contract.layouts) ? contract.layouts : {};
  if (Object.keys(layouts).length === 0) {
    add(errors, "layouts", "must declare at least one layout");
  }
  for (const [name, layout] of Object.entries(layouts)) {
    if (!object(layout)) {
      add(errors, `layouts.${name}`, "must be an object");
      continue;
    }
    if (
      !Number.isInteger(layout.minItems) ||
      !Number.isInteger(layout.maxItems) ||
      layout.minItems < 0 ||
      layout.maxItems < layout.minItems
    ) {
      add(
        errors,
        `layouts.${name}`,
        "must declare integer item limits with 0 <= minItems <= maxItems"
      );
    }
  }

  const typographyByRole =
    contract.styleConsistency?.typographyByRole;
  if (
    !object(typographyByRole) ||
    Object.keys(typographyByRole).length === 0
  ) {
    add(
      errors,
      "styleConsistency.typographyByRole",
      "must declare at least one semantic typography role"
    );
  } else {
    for (const [role, rules] of Object.entries(typographyByRole)) {
      const rolePath = `styleConsistency.typographyByRole.${role}`;
      if (!role.trim() || !object(rules)) {
        add(errors, rolePath, "must be a named role rule object");
        continue;
      }
      if (
        !Array.isArray(rules.fontFamilies) ||
        rules.fontFamilies.length === 0 ||
        rules.fontFamilies.some(
          (family) => !String(family ?? "").trim()
        )
      ) {
        add(
          errors,
          `${rolePath}.fontFamilies`,
          "must be a non-empty array of font family names"
        );
      }
      if (
        !Array.isArray(rules.fontWeights) ||
        rules.fontWeights.length === 0 ||
        rules.fontWeights.some(
          (weight) =>
            !finite(weight) || Number(weight) < 1 || Number(weight) > 1000
        )
      ) {
        add(
          errors,
          `${rolePath}.fontWeights`,
          "must contain weights between 1 and 1000"
        );
      }
    }
  }

  const image = contract.imageQuality ?? {};
  if (
    finite(image.maxUpscaleWarning) &&
    finite(image.maxUpscaleBlocker) &&
    Number(image.maxUpscaleWarning) > Number(image.maxUpscaleBlocker)
  ) {
    add(
      errors,
      "imageQuality.maxUpscaleWarning",
      "must not exceed maxUpscaleBlocker"
    );
  }

  const chart = contract.chartQuality ?? {};
  if (!Array.isArray(chart.supportedTypes) || chart.supportedTypes.length === 0) {
    add(errors, "chartQuality.supportedTypes", "must be a non-empty array");
  }
  if (object(chart.bar)) {
    numericRange(
      errors,
      chart.bar.widthTolerance,
      "chartQuality.bar.widthTolerance",
      0,
      1
    );
  }

  const semanticRules =
    contract.semanticVisualQuality?.layoutRules ?? {};
  if (!object(semanticRules)) {
    add(
      errors,
      "semanticVisualQuality.layoutRules",
      "must be an object"
    );
  } else {
    for (const [layout, rules] of Object.entries(semanticRules)) {
      if (!layouts[layout]) {
        add(
          errors,
          `semanticVisualQuality.layoutRules.${layout}`,
          "references an unknown layout"
        );
      } else if (
        !object(rules) ||
        !Array.isArray(rules.allowedIntents) ||
        rules.allowedIntents.length === 0
      ) {
        add(
          errors,
          `semanticVisualQuality.layoutRules.${layout}`,
          "must declare at least one allowed intent"
        );
      }
    }
    for (const layout of Object.keys(layouts)) {
      if (!semanticRules[layout]) {
        add(
          errors,
          `semanticVisualQuality.layoutRules.${layout}`,
          "must declare semantic rules for every layout"
        );
      }
    }
  }

  const selection = contract.layoutSelection ?? {};
  const templateSlideIds = selection.templateSlideIds;
  if (
    !Array.isArray(templateSlideIds) ||
    templateSlideIds.length === 0 ||
    templateSlideIds.some((slideId) => !String(slideId ?? "").trim())
  ) {
    add(
      errors,
      "layoutSelection.templateSlideIds",
      "must be a non-empty array of template slide IDs"
    );
  }
  const prototypeIds = new Set(
    Array.isArray(templateSlideIds) ? templateSlideIds : []
  );
  const selectionLayouts = object(selection.layouts)
    ? selection.layouts
    : {};
  for (const [layoutName, profile] of Object.entries(selectionLayouts)) {
    const profilePath = `layoutSelection.layouts.${layoutName}`;
    if (!layouts[layoutName]) {
      add(errors, profilePath, "references an unknown layout");
      continue;
    }
    if (!object(profile)) {
      add(errors, profilePath, "must be an object");
      continue;
    }
    for (const field of ["narrativeRoles", "contentShapes"]) {
      if (
        !Array.isArray(profile[field]) ||
        profile[field].length === 0 ||
        profile[field].some((value) => !String(value ?? "").trim())
      ) {
        add(
          errors,
          `${profilePath}.${field}`,
          "must be a non-empty array of names"
        );
      }
    }
    if (!LAYOUT_DENSITIES.has(profile.density)) {
      add(
        errors,
        `${profilePath}.density`,
        `must be one of ${[...LAYOUT_DENSITIES].join(", ")}`
      );
    }
    const preferred = profile.preferredItems;
    const layout = layouts[layoutName];
    if (
      !object(preferred) ||
      !Number.isInteger(preferred.min) ||
      !Number.isInteger(preferred.max) ||
      preferred.min < layout.minItems ||
      preferred.max > layout.maxItems ||
      preferred.max < preferred.min
    ) {
      add(
        errors,
        `${profilePath}.preferredItems`,
        "must be an integer range within the layout item limits"
      );
    }
    if (!String(profile.styleTreatment ?? "").trim()) {
      add(
        errors,
        `${profilePath}.styleTreatment`,
        "must be a non-empty string"
      );
    }
    if (
      !String(profile.prototypeSlide ?? "").trim() ||
      !prototypeIds.has(profile.prototypeSlide)
    ) {
      add(
        errors,
        `${profilePath}.prototypeSlide`,
        "must reference a declared template slide ID"
      );
    }
  }
  for (const layoutName of Object.keys(layouts)) {
    if (!selectionLayouts[layoutName]) {
      add(
        errors,
        `layoutSelection.layouts.${layoutName}`,
        "must declare a selection profile for every layout"
      );
    }
  }

  const accessibility = contract.accessibilityQuality ?? {};
  numericRange(
    errors,
    accessibility.minContrastNormal,
    "accessibilityQuality.minContrastNormal",
    1,
    21
  );
  numericRange(
    errors,
    accessibility.minContrastLarge,
    "accessibilityQuality.minContrastLarge",
    1,
    21
  );
  numericRange(
    errors,
    accessibility.minTextSize,
    "accessibilityQuality.minTextSize",
    1,
    200
  );

  return {
    valid: errors.length === 0,
    errors
  };
}

export function assertTemplateContract(contract) {
  const result = validateTemplateContract(contract);
  if (!result.valid) {
    throw new Error(
      `Invalid template contract:\n${result.errors
        .map((error) => `- ${error.path}: ${error.message}`)
        .join("\n")}`
    );
  }
  return contract;
}
