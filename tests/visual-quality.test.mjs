import assert from "node:assert/strict";
import test from "node:test";
import { analyzeImageQuality } from "../lib/image-quality.mjs";
import { analyzeLayoutQuality } from "../lib/layout-quality.mjs";
import { analyzeTypographyQuality } from "../lib/typography-quality.mjs";

const typographyContract = {
  typographyQuality: {
    default: {
      minFontSize: 18,
      minLineHeightRatio: 1.15,
      maxLines: 8,
      maxLineCharacters: 42,
      orphanMinCharacters: 2
    },
    roleRules: {
      title: {
        minFontSize: 52,
        minLineHeightRatio: 1.1,
        maxLines: 3,
        maxLineCharacters: 24,
        orphanMinCharacters: 2
      },
      "item-body": {
        minFontSize: 20,
        minLineHeightRatio: 1.35,
        maxLines: 4,
        maxLineCharacters: 28,
        orphanMinCharacters: 2
      }
    }
  }
};

function typographyProfile(overrides = {}) {
  return {
    slide: "workflow",
    layout: "process",
    elements: [
      {
        selector: '[data-role="item-body"]',
        role: "item-body",
        text: "从可靠来源获取信息，保留链接与发布时间。",
        fontSize: 25,
        lineHeight: 40,
        lineCount: 2,
        lineCharacterCounts: [10, 10],
        allow: false,
        ...overrides
      }
    ]
  };
}

test("typography quality accepts readable contracted text", () => {
  const result = analyzeTypographyQuality({
    profiles: [typographyProfile()],
    contract: typographyContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("typography quality blocks explicit size leading and line-count violations", () => {
  const result = analyzeTypographyQuality({
    profiles: [
      typographyProfile({
        fontSize: 16,
        lineHeight: 17,
        lineCount: 5,
        lineCharacterCounts: [8, 8, 8, 8, 8]
      })
    ],
    contract: typographyContract
  });
  const codes = result.findings.map((finding) => finding.code).sort();

  assert.equal(result.passed, false);
  assert.deepEqual(codes, [
    "typography-font-size",
    "typography-line-count",
    "typography-line-height"
  ]);
  assert.ok(result.findings.every((finding) => finding.severity === "blocker"));
});

test("typography quality warns for long lines and an orphan final line", () => {
  const result = analyzeTypographyQuality({
    profiles: [
      typographyProfile({
        lineCount: 3,
        lineCharacterCounts: [34, 20, 1]
      })
    ],
    contract: typographyContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(
    result.findings.map(({ code, severity }) => ({ code, severity })),
    [
      { code: "typography-long-line", severity: "warning" },
      { code: "typography-orphan-line", severity: "warning" }
    ]
  );
});

test("typography quality honors an element-local allowance", () => {
  const result = analyzeTypographyQuality({
    profiles: [
      typographyProfile({
        fontSize: 12,
        lineHeight: 12,
        lineCount: 12,
        lineCharacterCounts: Array(12).fill(1),
        allow: true
      })
    ],
    contract: typographyContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

const imageContract = {
  imageQuality: {
    maxUpscaleWarning: 1,
    maxUpscaleBlocker: 1.5,
    maxAspectDistortion: 0.03,
    minCoverVisibleFraction: 0.65
  }
};

function imageProfile(slide, images) {
  return { slide, layout: "media", images };
}

function image(overrides = {}) {
  return {
    selector: '[data-role="evidence-image"]',
    role: "evidence-image",
    src: "assets/product.png",
    alt: "Product interface",
    naturalWidth: 1600,
    naturalHeight: 900,
    drawnWidth: 800,
    drawnHeight: 450,
    renderedAspect: 16 / 9,
    sourceAspect: 16 / 9,
    objectFit: "contain",
    visibleFraction: 1,
    allowCrop: false,
    allowRepeat: false,
    ...overrides
  };
}

test("image quality accepts sufficient resolution without distortion", () => {
  const result = analyzeImageQuality({
    profiles: [imageProfile("evidence", [image()])],
    contract: imageContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("image quality blocks excessive upscale and stretched aspect ratios", () => {
  const result = analyzeImageQuality({
    profiles: [
      imageProfile("low-resolution", [
        image({
          src: "assets/small.png",
          naturalWidth: 400,
          naturalHeight: 225,
          drawnWidth: 1000,
          drawnHeight: 562.5
        })
      ]),
      imageProfile("stretched", [
        image({
          src: "assets/stretched.png",
          naturalWidth: 1200,
          naturalHeight: 800,
          drawnWidth: 600,
          drawnHeight: 600,
          sourceAspect: 1.5,
          renderedAspect: 1,
          objectFit: "fill"
        })
      ])
    ],
    contract: imageContract
  });
  const codes = result.findings.map((finding) => finding.code).sort();

  assert.equal(result.passed, false);
  assert.deepEqual(codes, ["image-aspect-distortion", "image-upscale"]);
  assert.ok(result.findings.every((finding) => finding.severity === "blocker"));
});

test("image quality warns for moderate upscale severe cover crop and reuse", () => {
  const reused = image({
    src: "assets/reused.png",
    naturalWidth: 800,
    naturalHeight: 600,
    drawnWidth: 960,
    drawnHeight: 720
  });
  const result = analyzeImageQuality({
    profiles: [
      imageProfile("one", [reused]),
      imageProfile("two", [
        image({
          ...reused,
          objectFit: "cover",
          visibleFraction: 0.55
        })
      ])
    ],
    contract: imageContract
  });
  const codes = result.findings.map((finding) => finding.code);

  assert.equal(result.passed, true);
  assert.equal(codes.filter((code) => code === "image-upscale").length, 2);
  assert.equal(codes.filter((code) => code === "image-reused").length, 2);
  assert.ok(codes.includes("image-severe-crop"));
  assert.ok(result.findings.every((finding) => finding.severity === "warning"));
});

test("image quality honors local crop and repeat allowances", () => {
  const allowed = image({
    src: "assets/logo.png",
    objectFit: "cover",
    visibleFraction: 0.4,
    allowCrop: true,
    allowRepeat: true
  });
  const result = analyzeImageQuality({
    profiles: [
      imageProfile("one", [allowed]),
      imageProfile("two", [allowed])
    ],
    contract: imageContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

const layoutContract = {
  layoutQuality: {
    balance: {
      centerX: [0.15, 0.85],
      centerY: [0.15, 0.85],
      coverage: [0.06, 0.8],
      exemptLayouts: ["cover", "closing"]
    },
    repeatedGroupsByLayout: {
      agenda: {
        orientation: "vertical",
        gapTolerance: 8,
        crossAxisTolerance: 8
      },
      process: {
        orientation: "horizontal",
        gapTolerance: 8,
        crossAxisTolerance: 8
      }
    }
  }
};

function layoutProfile(overrides = {}) {
  return {
    slide: "workflow",
    layout: "process",
    metrics: {
      centerX: 0.5,
      centerY: 0.5,
      coverage: 0.32
    },
    repeatedGroups: [
      {
        selector: '[data-role="items"]',
        orientation: "horizontal",
        gaps: [50, 50, 50],
        crossAxisPositions: [300, 302, 299, 301],
        allow: false
      }
    ],
    ...overrides
  };
}

test("layout quality accepts balanced and regularly aligned content", () => {
  const result = analyzeLayoutQuality({
    profiles: [layoutProfile()],
    contract: layoutContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("layout quality warns for gross imbalance and extreme density", () => {
  const result = analyzeLayoutQuality({
    profiles: [
      layoutProfile({
        metrics: {
          centerX: 0.94,
          centerY: 0.5,
          coverage: 0.03
        },
        repeatedGroups: []
      })
    ],
    contract: layoutContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(
    result.findings.map(({ code, severity }) => ({ code, severity })),
    [
      { code: "layout-visual-balance", severity: "warning" },
      { code: "layout-content-density", severity: "warning" }
    ]
  );
});

test("layout quality blocks contracted repeated-group spacing and alignment drift", () => {
  const result = analyzeLayoutQuality({
    profiles: [
      layoutProfile({
        repeatedGroups: [
          {
            selector: '[data-role="items"]',
            orientation: "horizontal",
            gaps: [50, 82, 48],
            crossAxisPositions: [300, 302, 328, 301],
            allow: false
          }
        ]
      })
    ],
    contract: layoutContract
  });
  const codes = result.findings.map((finding) => finding.code).sort();

  assert.equal(result.passed, false);
  assert.deepEqual(codes, ["layout-misalignment", "layout-uneven-spacing"]);
  assert.ok(result.findings.every((finding) => finding.severity === "blocker"));
});

test("layout quality honors balance-family and local repeated-group exemptions", () => {
  const result = analyzeLayoutQuality({
    profiles: [
      layoutProfile({
        slide: "cover",
        layout: "cover",
        metrics: { centerX: 0.95, centerY: 0.1, coverage: 0.95 },
        repeatedGroups: []
      }),
      layoutProfile({
        repeatedGroups: [
          {
            selector: '[data-role="items"]',
            orientation: "horizontal",
            gaps: [20, 100],
            crossAxisPositions: [100, 150, 80],
            allow: true
          }
        ]
      })
    ],
    contract: layoutContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});
