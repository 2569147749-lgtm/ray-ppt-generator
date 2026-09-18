import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeAccessibilityQuality } from "../lib/accessibility-quality.mjs";
import { analyzeChartQuality } from "../lib/chart-quality.mjs";
import { analyzeSemanticVisualQuality } from "../lib/semantic-visual-quality.mjs";
import { validateTemplateContract } from "../lib/template-contract.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const chartContract = {
  chartQuality: {
    supportedTypes: ["bar"],
    requiredTitle: true,
    requiredSource: true,
    requiredPointLabels: true,
    bar: {
      requireZeroBaseline: true,
      widthTolerance: 0.03,
      requireLabels: true
    }
  }
};

function chartProfile(overrides = {}) {
  return {
    slide: "metrics",
    layout: "metric",
    charts: [
      {
        selector: '[data-chart="time-comparison"]',
        type: "bar",
        title: "Time per article",
        source: "Calculation: (30 - 12) / 30",
        scale: { min: 0, max: 30 },
        ticks: [0, 15, 30],
        points: [
          {
            selector: '[data-chart-point="before"]',
            label: "Original process",
            value: 30,
            drawnFraction: 1
          },
          {
            selector: '[data-chart-point="after"]',
            label: "Human and AI",
            value: 12,
            drawnFraction: 0.4
          }
        ],
        ...overrides
      }
    ]
  };
}

test("chart quality accepts a labelled zero-based bar chart", () => {
  const result = analyzeChartQuality({
    profiles: [chartProfile()],
    contract: chartContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("chart quality blocks misleading bar scales and geometry", () => {
  const result = analyzeChartQuality({
    profiles: [
      chartProfile({
        scale: { min: 5, max: 30 },
        ticks: [5, 20, 15],
        points: [
          {
            selector: '[data-chart-point="before"]',
            label: "Original process",
            value: 35,
            drawnFraction: 1
          },
          {
            selector: '[data-chart-point="after"]',
            label: "Human and AI",
            value: 12,
            drawnFraction: 0.8
          }
        ]
      })
    ],
    contract: chartContract
  });
  const codes = result.findings.map((finding) => finding.code);

  assert.equal(result.passed, false);
  assert.ok(codes.includes("chart-nonzero-baseline"));
  assert.ok(codes.includes("chart-tick-order"));
  assert.ok(codes.includes("chart-value-out-of-domain"));
  assert.ok(codes.includes("chart-bar-scale-mismatch"));
  assert.ok(result.findings.every((finding) => finding.severity === "blocker"));
});

test("chart quality requires labels title and source while warning on unknown types", () => {
  const result = analyzeChartQuality({
    profiles: [
      chartProfile({
        type: "radar",
        title: "",
        source: "",
        points: [
          {
            selector: '[data-chart-point="before"]',
            label: "",
            value: 30,
            drawnFraction: 1
          }
        ]
      })
    ],
    contract: chartContract
  });

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.findings.map(({ code, severity }) => ({ code, severity })),
    [
      { code: "chart-missing-title", severity: "blocker" },
      { code: "chart-missing-source", severity: "blocker" },
      { code: "chart-unsupported-type", severity: "warning" },
      { code: "chart-missing-label", severity: "blocker" }
    ]
  );
});

const semanticContract = {
  semanticVisualQuality: {
    layoutRules: {
      metric: {
        allowedIntents: ["quantitative-comparison"],
        requiredSignals: ["number", "chart"],
        primaryRoles: ["metric"]
      },
      statement: {
        allowedIntents: ["key-message"],
        requiredSignals: ["text"],
        primaryRoles: ["title"]
      }
    }
  }
};

function semanticProfile(overrides = {}) {
  return {
    slide: "metrics",
    layout: "metric",
    intent: "quantitative-comparison",
    signals: ["text", "number", "chart"],
    primaryEmphasis: [{ selector: ".metric", role: "metric" }],
    ...overrides
  };
}

test("semantic visual quality accepts compatible intent evidence and emphasis", () => {
  const result = analyzeSemanticVisualQuality({
    profiles: [semanticProfile()],
    contract: semanticContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("semantic visual quality blocks declared layout intent and evidence mismatch", () => {
  const result = analyzeSemanticVisualQuality({
    profiles: [
      semanticProfile({
        intent: "decorative-quote",
        signals: ["text"],
        primaryEmphasis: [{ selector: '[data-role="title"]', role: "title" }]
      })
    ],
    contract: semanticContract
  });
  const codes = result.findings.map((finding) => finding.code);

  assert.equal(result.passed, false);
  assert.ok(codes.includes("semantic-intent-mismatch"));
  assert.equal(
    codes.filter((code) => code === "semantic-missing-evidence").length,
    2
  );
  assert.ok(codes.includes("semantic-primary-role"));
});

test("semantic visual quality warns when declarations or emphasis are ambiguous", () => {
  const result = analyzeSemanticVisualQuality({
    profiles: [
      semanticProfile({
        slide: "statement",
        layout: "statement",
        intent: "",
        signals: ["text"],
        primaryEmphasis: []
      }),
      semanticProfile({
        slide: "double-emphasis",
        primaryEmphasis: [
          { selector: ".first", role: "metric" },
          { selector: ".second", role: "metric" }
        ]
      })
    ],
    contract: semanticContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(
    result.findings.map(({ code, severity }) => ({ code, severity })),
    [
      { code: "semantic-missing-intent", severity: "warning" },
      { code: "semantic-missing-emphasis", severity: "warning" },
      { code: "semantic-ambiguous-emphasis", severity: "warning" }
    ]
  );
});

const accessibilityContract = {
  accessibilityQuality: {
    minContrastNormal: 4.5,
    minContrastLarge: 3,
    largeTextMin: 24,
    largeBoldTextMin: 18.66,
    minTextSize: 16,
    requireSlideLabel: true,
    requireImageAlt: true,
    requireRedundantColorLabels: true
  }
};

function accessibilityProfile(overrides = {}) {
  return {
    slide: "metrics",
    layout: "metric",
    slideLabel: "Data and outcomes",
    texts: [
      {
        selector: '[data-role="title"]',
        text: "Measured improvement",
        fontSize: 60,
        fontWeight: 700,
        contrastRatio: 12,
        allow: false
      },
      {
        selector: ".chart-note",
        text: "Calculation notes",
        fontSize: 23,
        fontWeight: 400,
        contrastRatio: 5.2,
        allow: false
      }
    ],
    images: [],
    colorEncodings: [
      {
        selector: '[data-color-encoding="series"]',
        items: [
          { selector: '[data-color-key="before"]', label: "Before" },
          { selector: '[data-color-key="after"]', label: "After" }
        ]
      }
    ],
    ...overrides
  };
}

test("accessibility quality accepts readable labelled content", () => {
  const result = analyzeAccessibilityQuality({
    profiles: [accessibilityProfile()],
    contract: accessibilityContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("accessibility quality blocks low contrast and projected micro text", () => {
  const result = analyzeAccessibilityQuality({
    profiles: [
      accessibilityProfile({
        texts: [
          {
            selector: ".low-contrast",
            text: "Hard to read",
            fontSize: 20,
            fontWeight: 400,
            contrastRatio: 2.4,
            allow: false
          },
          {
            selector: ".micro",
            text: "Too small",
            fontSize: 12,
            fontWeight: 700,
            contrastRatio: 10,
            allow: false
          },
          {
            selector: ".large",
            text: "Large enough",
            fontSize: 28,
            fontWeight: 400,
            contrastRatio: 3.2,
            allow: false
          }
        ]
      })
    ],
    contract: accessibilityContract
  });
  const codes = result.findings.map((finding) => finding.code).sort();

  assert.equal(result.passed, false);
  assert.deepEqual(codes, [
    "accessibility-contrast",
    "accessibility-text-size"
  ]);
});

test("accessibility quality requires slide image and redundant color labels", () => {
  const result = analyzeAccessibilityQuality({
    profiles: [
      accessibilityProfile({
        slideLabel: "",
        images: [
          {
            selector: '[data-role="evidence-image"]',
            alt: "",
            allow: false
          }
        ],
        colorEncodings: [
          {
            selector: '[data-color-encoding="series"]',
            items: [
              { selector: '[data-color-key="before"]', label: "" },
              { selector: '[data-color-key="after"]', label: "After" }
            ]
          }
        ]
      })
    ],
    contract: accessibilityContract
  });

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.findings.map(({ code, severity }) => ({ code, severity })),
    [
      { code: "accessibility-slide-label", severity: "blocker" },
      { code: "accessibility-image-alt", severity: "blocker" },
      { code: "accessibility-color-only", severity: "blocker" }
    ]
  );
});

test("accessibility quality honors the smallest local exception", () => {
  const result = analyzeAccessibilityQuality({
    profiles: [
      accessibilityProfile({
        texts: [
          {
            selector: ".decorative-microcopy",
            text: "Decorative",
            fontSize: 8,
            fontWeight: 400,
            contrastRatio: 1.2,
            allow: true
          }
        ],
        images: [
          {
            selector: ".decorative-image",
            alt: "",
            allow: true
          }
        ]
      })
    ],
    contract: accessibilityContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

function alternateTemplateContract() {
  return {
    schemaVersion: 1,
    template: "dark-technical-test",
    layouts: {
      dashboard: {
        supportedCommands: ["set-text"],
        itemClass: null,
        minItems: 0,
        maxItems: 0,
        coupled: ["title", "chart"],
        adaptation: "Keep the chart readable."
      }
    },
    styleConsistency: {
      allowedFontFamilies: ["Inter"],
      typographyByRole: {
        title: {
          fontFamilies: ["Inter"],
          fontWeights: [700]
        }
      },
      allowedColors: ["#111111", "#ffffff"],
      slideInsets: {
        left: 64,
        right: 64,
        top: 48,
        bottom: 64,
        tolerance: 2
      },
      footer: {
        required: true,
        left: 64,
        right: 64,
        bottom: 40,
        fontSize: 18,
        tolerance: 2
      },
      titleByLayout: {
        dashboard: { min: 44, max: 72 }
      },
      outlierExemptLayouts: []
    },
    typographyQuality: {
      default: {
        minFontSize: 18,
        minLineHeightRatio: 1.15,
        maxLines: 8,
        maxLineCharacters: 42,
        orphanMinCharacters: 2
      },
      roleRules: {}
    },
    imageQuality: {
      maxUpscaleWarning: 1,
      maxUpscaleBlocker: 1.5,
      maxAspectDistortion: 0.03,
      minCoverVisibleFraction: 0.65
    },
    layoutQuality: {
      balance: {
        centerX: [0.1, 0.9],
        centerY: [0.1, 0.9],
        coverage: [0.1, 0.85],
        exemptLayouts: []
      },
      repeatedGroupsByLayout: {}
    },
    chartQuality: chartContract.chartQuality,
    semanticVisualQuality: {
      layoutRules: {
        dashboard: {
          allowedIntents: ["monitoring"],
          requiredSignals: ["chart"],
          primaryRoles: ["chart"]
        }
      }
    },
    layoutSelection: {
      templateSlideIds: ["dashboard"],
      layouts: {
        dashboard: {
          narrativeRoles: ["evidence"],
          contentShapes: ["quantitative-evidence"],
          density: "balanced",
          preferredItems: { min: 0, max: 0 },
          styleTreatment: "technical-dashboard",
          prototypeSlide: "dashboard"
        }
      }
    },
    accessibilityQuality: accessibilityContract.accessibilityQuality
  };
}

test("template contract validator accepts yellow and non-yellow contracts", () => {
  const yellow = JSON.parse(
    readFileSync(
      path.join(
        skillRoot,
        "assets",
        "templates",
        "yellow-editorial",
        "layout-contracts.json"
      ),
      "utf8"
    )
  );

  assert.deepEqual(validateTemplateContract(yellow), {
    valid: true,
    errors: []
  });
  assert.deepEqual(validateTemplateContract(alternateTemplateContract()), {
    valid: true,
    errors: []
  });
});

test("template contract validator reports missing P1 sections and invalid paths", () => {
  const invalid = alternateTemplateContract();
  delete invalid.chartQuality;
  invalid.accessibilityQuality.minContrastNormal = 30;
  invalid.semanticVisualQuality.layoutRules.unknown = {
    allowedIntents: ["unknown"],
    requiredSignals: [],
    primaryRoles: []
  };
  delete invalid.semanticVisualQuality.layoutRules.dashboard;
  invalid.layouts.dashboard.minItems = 4;
  invalid.layouts.dashboard.maxItems = 2;

  const result = validateTemplateContract(invalid);
  const paths = result.errors.map((error) => error.path);

  assert.equal(result.valid, false);
  assert.ok(paths.includes("chartQuality"));
  assert.ok(paths.includes("accessibilityQuality.minContrastNormal"));
  assert.ok(paths.includes("semanticVisualQuality.layoutRules.unknown"));
  assert.ok(paths.includes("semanticVisualQuality.layoutRules.dashboard"));
  assert.ok(paths.includes("layouts.dashboard"));
});

test("template contract validator rejects malformed semantic font role rules", () => {
  const invalid = alternateTemplateContract();
  invalid.styleConsistency.typographyByRole.title = {
    fontFamilies: [],
    fontWeights: [0, 1200]
  };

  const result = validateTemplateContract(invalid);
  const paths = result.errors.map((error) => error.path);

  assert.equal(result.valid, false);
  assert.ok(
    paths.includes(
      "styleConsistency.typographyByRole.title.fontFamilies"
    )
  );
  assert.ok(
    paths.includes(
      "styleConsistency.typographyByRole.title.fontWeights"
    )
  );
});

test("yellow template declares semantic font continuity by role", () => {
  const yellow = JSON.parse(
    readFileSync(
      path.join(
        skillRoot,
        "assets",
        "templates",
        "yellow-editorial",
        "layout-contracts.json"
      ),
      "utf8"
    )
  );

  assert.deepEqual(
    yellow.styleConsistency.typographyByRole["item-title"],
    {
      fontFamilies: ["DM Sans", "Noto Sans SC"],
      fontWeights: [700]
    }
  );
  assert.deepEqual(
    yellow.styleConsistency.typographyByRole["item-body"],
    {
      fontFamilies: ["DM Sans", "Noto Sans SC"],
      fontWeights: [400]
    }
  );
});

test("yellow selected matrix copy keeps accessible ink contrast", () => {
  const html = readFileSync(
    path.join(
      skillRoot,
      "assets",
      "templates",
      "yellow-editorial",
      "template.html"
    ),
    "utf8"
  );

  assert.match(html, /\.quadrant\.selected small\{color:var\(--ink\)\}/);
});
