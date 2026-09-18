import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  analyzeVisualGeometry,
  analyzeVisualDiff,
  applyVisualReview,
  buildVisualReviewScope,
  comparePngPixels,
  detectEdgeStripes,
  detectInternalStripes,
  inspectPng,
  selectVisualSlides,
  VISUAL_VIEWPORTS
} from "../lib/visual-audit.mjs";
import { analyzeFontContinuity } from "../lib/font-continuity.mjs";
import { analyzeStyleConsistency } from "../lib/style-consistency.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(skillRoot, "scripts");
const chromePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("visual audit defaults to the desktop presentation viewport only", () => {
  assert.deepEqual(VISUAL_VIEWPORTS, [
    { name: "desktop", width: 1440, height: 900 }
  ]);
});

const styleContract = {
  styleConsistency: {
    allowedFontFamilies: ["DM Sans", "Noto Sans SC", "Noto Serif SC"],
    allowedColors: ["#20211d", "#fffef8", "#ffda24"],
    slideInsets: {
      left: 88,
      right: 88,
      top: 64,
      bottom: 70,
      tolerance: 2
    },
    footer: {
      required: true,
      left: 88,
      right: 88,
      bottom: 44,
      fontSize: 18,
      tolerance: 2
    },
    titleByLayout: {
      cover: { min: 100, max: 160 },
      statement: { min: 60, max: 96 },
      closing: { min: 88, max: 136 }
    },
    outlierExemptLayouts: ["cover", "closing"]
  }
};

function styleProfile({
  slide,
  layout,
  titleSize,
  titleFamily = '"DM Sans", "Noto Sans SC", sans-serif',
  background = "#fffef8"
}) {
  return {
    slide,
    layout,
    insets: { left: 88, right: 88, top: 64, bottom: 70 },
    title: {
      fontFamily: titleFamily,
      fontSize: titleSize,
      color: "#20211d"
    },
    footer: {
      left: 88,
      right: 88,
      bottom: 44,
      fontSize: 18,
      color: "#20211d",
      borderColor: "#20211d"
    },
    semanticColors: {
      slideBackground: background,
      title: "#20211d",
      footerText: "#20211d",
      footerBorder: "#20211d"
    },
    fontFamilies: [
      { value: titleFamily, count: 4 },
      { value: '"Noto Serif SC", serif', count: 1 }
    ]
  };
}

function fontProfile({
  slide = "metrics",
  selector = '[data-role="title"]',
  role = "title",
  itemId = null,
  fontFamily = "DM Sans",
  fontWeight = 700,
  fontAvailable = true
} = {}) {
  return {
    slide,
    layout: "metric",
    typography: [
      {
        selector,
        role,
        itemId,
        fontRuns: [{ fontFamily, fontWeight, fontAvailable }]
      }
    ]
  };
}

test("font continuity blocks unrequested family and weight drift", () => {
  const source = fontProfile();
  const familyDrift = analyzeFontContinuity({
    profiles: [fontProfile({ fontFamily: "Noto Serif SC" })],
    baselineProfiles: [source],
    plan: { changes: [{ id: "copy", targets: ["metrics"] }] }
  });
  const weightDrift = analyzeFontContinuity({
    profiles: [fontProfile({ fontWeight: 500 })],
    baselineProfiles: [source],
    plan: { changes: [{ id: "copy", targets: ["metrics"] }] }
  });

  assert.equal(familyDrift.passed, false);
  assert.equal(familyDrift.findings[0].code, "font-family-drift");
  assert.equal(weightDrift.passed, false);
  assert.equal(weightDrift.findings[0].code, "font-weight-drift");
});

test("font continuity applies authorization only to its property and semantic scope", () => {
  const sourceProfiles = [
    fontProfile(),
    fontProfile({
      selector: '[data-item-id="one"] [data-role="item-title"]',
      role: "item-title",
      itemId: "one"
    })
  ];
  const result = analyzeFontContinuity({
    profiles: [
      fontProfile({ fontFamily: "Inter" }),
      fontProfile({
        selector: '[data-item-id="one"] [data-role="item-title"]',
        role: "item-title",
        itemId: "one",
        fontFamily: "Inter",
        fontWeight: 600
      })
    ],
    baselineProfiles: sourceProfiles,
    plan: {
      changes: [
        {
          id: "title-font",
          targets: ["metrics"],
          typographyAuthorization: {
            role: "title",
            properties: ["fontFamily"],
            fontFamily: "Inter"
          }
        }
      ]
    }
  });

  assert.equal(result.passed, false);
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code === "font-family-drift" &&
        finding.role === "item-title"
    )
  );
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code === "font-weight-drift" &&
        finding.role === "item-title"
    )
  );
  assert.ok(
    !result.findings.some(
      (finding) =>
        finding.code === "font-family-drift" && finding.role === "title"
    )
  );
});

test("font continuity enforces template-owned role rules on new slides", () => {
  const result = analyzeFontContinuity({
    profiles: [fontProfile({ slide: "new-slide", fontWeight: 400 })],
    contract: {
      styleConsistency: {
        typographyByRole: {
          title: {
            fontFamilies: ["DM Sans", "Noto Serif SC"],
            fontWeights: [700]
          }
        }
      }
    },
    plan: {
      changes: [
        {
          id: "add",
          targets: ["new-slide"],
          command: "add-slide"
        }
      ]
    }
  });

  assert.equal(result.passed, false);
  assert.equal(result.findings[0].code, "font-role-weight");
});

test("font continuity prefers actual platform font evidence over CSS declarations", () => {
  const source = fontProfile();
  source.typography[0].platformFonts = [
    { fontFamily: "Noto Sans SC", glyphCount: 8 }
  ];
  const revised = fontProfile();
  revised.typography[0].platformFonts = [
    { fontFamily: "Arial Unicode MS", glyphCount: 8 }
  ];

  const result = analyzeFontContinuity({
    profiles: [revised],
    baselineProfiles: [source],
    plan: { changes: [{ id: "copy", targets: ["metrics"] }] }
  });

  assert.equal(result.passed, false);
  assert.equal(result.findings[0].code, "font-family-drift");
  assert.deepEqual(result.findings[0].expected, ["Noto Sans SC"]);
  assert.deepEqual(result.findings[0].actual, ["Arial Unicode MS"]);
});

test("style consistency accepts declared layout-family differences", () => {
  const result = analyzeStyleConsistency({
    profiles: [
      styleProfile({
        slide: "cover",
        layout: "cover",
        titleSize: 154,
        background: "#ffda24"
      }),
      styleProfile({
        slide: "point-of-view",
        layout: "statement",
        titleSize: 91
      }),
      styleProfile({
        slide: "closing",
        layout: "closing",
        titleSize: 131,
        background: "#ffda24"
      })
    ],
    contract: styleContract
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("style consistency blocks explicit typography palette and geometry drift", () => {
  const profile = styleProfile({
    slide: "point-of-view",
    layout: "statement",
    titleSize: 44,
    titleFamily: '"Comic Sans MS", cursive'
  });
  profile.insets.left = 64;
  profile.footer.bottom = 24;
  profile.semanticColors.title = "#ff0000";

  const result = analyzeStyleConsistency({
    profiles: [profile],
    contract: styleContract
  });
  const codes = new Set(result.findings.map((finding) => finding.code));

  assert.equal(result.passed, false);
  assert.ok(codes.has("style-font-family"));
  assert.ok(codes.has("style-title-hierarchy"));
  assert.ok(codes.has("style-slide-inset"));
  assert.ok(codes.has("style-footer"));
  assert.ok(codes.has("style-color"));
  assert.ok(result.findings.every((finding) => finding.severity === "blocker"));
});

test("style consistency permits an explicitly authorized new family only on its target slide", () => {
  const authorized = styleProfile({
    slide: "metrics",
    layout: "metric",
    titleSize: 76,
    titleFamily: "Inter, sans-serif"
  });
  authorized.fontFamilies = [{ value: "Inter, sans-serif", count: 4 }];
  const unrelated = styleProfile({
    slide: "workflow",
    layout: "process",
    titleSize: 76,
    titleFamily: "Inter, sans-serif"
  });
  unrelated.fontFamilies = [{ value: "Inter, sans-serif", count: 4 }];

  const result = analyzeStyleConsistency({
    profiles: [authorized, unrelated],
    contract: styleContract,
    plan: {
      changes: [
        {
          targets: ["metrics"],
          typographyAuthorization: {
            role: "title",
            properties: ["fontFamily"],
            fontFamily: "Inter"
          }
        }
      ]
    }
  });

  assert.equal(
    result.findings.some(
      (finding) =>
        finding.code === "style-font-family" &&
        finding.slide === "metrics"
    ),
    false
  );
  assert.equal(
    result.findings.some(
      (finding) =>
        finding.code === "style-font-family" &&
        finding.slide === "workflow"
    ),
    true
  );
});

test("style consistency blocks a missing title required by the layout contract", () => {
  const profile = styleProfile({
    slide: "point-of-view",
    layout: "statement",
    titleSize: 91
  });
  profile.title = null;

  const result = analyzeStyleConsistency({
    profiles: [profile],
    contract: styleContract
  });

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.findings.filter((finding) => finding.code === "style-title-hierarchy"),
    [
      {
        code: "style-title-hierarchy",
        severity: "blocker",
        slide: "point-of-view",
        property: "title",
        expected: "present",
        actual: null,
        message: "point-of-view is missing the required layout title."
      }
    ]
  );
});

test("style consistency reports inferred title-family outliers as warnings", () => {
  const profiles = [
    styleProfile({ slide: "one", layout: "statement", titleSize: 80 }),
    styleProfile({ slide: "two", layout: "agenda", titleSize: 76 }),
    styleProfile({ slide: "three", layout: "metric", titleSize: 76 }),
    styleProfile({
      slide: "custom",
      layout: "custom",
      titleSize: 76,
      titleFamily: "Arial, sans-serif"
    })
  ];
  const result = analyzeStyleConsistency({
    profiles,
    contract: { styleConsistency: { outlierExemptLayouts: ["cover", "closing"] } }
  });

  assert.equal(result.passed, true);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, "style-title-font-outlier");
  assert.equal(result.findings[0].severity, "warning");
  assert.equal(result.findings[0].slide, "custom");
});

test("yellow editorial declares a complete cross-slide style contract", () => {
  const contract = JSON.parse(
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
  ).styleConsistency;

  assert.deepEqual(contract.allowedFontFamilies, [
    "DM Sans",
    "Noto Sans SC",
    "Noto Serif SC"
  ]);
  assert.ok(contract.allowedColors.includes("#ffda24"));
  assert.deepEqual(contract.slideInsets, {
    left: 88,
    right: 88,
    top: 64,
    bottom: 70,
    tolerance: 2
  });
  assert.equal(contract.footer.required, true);
  assert.deepEqual(Object.keys(contract.titleByLayout).sort(), [
    "agenda",
    "closing",
    "comparison",
    "cover",
    "decision-matrix",
    "metric",
    "process",
    "statement"
  ]);
  assert.deepEqual(contract.outlierExemptLayouts, ["cover", "closing"]);
});

test("yellow editorial declares P0 typography image and layout quality contracts", () => {
  const contract = JSON.parse(
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

  assert.equal(contract.typographyQuality.roleRules.title.minFontSize, 52);
  assert.equal(contract.typographyQuality.roleRules["item-body"].minFontSize, 20);
  assert.equal(contract.imageQuality.maxUpscaleBlocker, 1.5);
  assert.equal(contract.imageQuality.minCoverVisibleFraction, 0.65);
  assert.deepEqual(contract.layoutQuality.balance.exemptLayouts, [
    "cover",
    "closing"
  ]);
  assert.equal(
    contract.layoutQuality.repeatedGroupsByLayout.agenda.orientation,
    "vertical"
  );
  assert.equal(
    contract.layoutQuality.repeatedGroupsByLayout.process.orientation,
    "horizontal"
  );
});

function createDeck() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-visual-audit-test-"));
  const deck = path.join(root, "deck");
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      deck
    ],
    { encoding: "utf8" }
  );
  return { root, deck };
}

function writeVisualDiffDeck(deckDir, labels, frameworkColor = "#f4f1ea") {
  mkdirSync(deckDir, { recursive: true });
  writeFileSync(
    path.join(deckDir, "index.html"),
    `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#222}
.deck-viewport{position:fixed;inset:0;overflow:hidden}
.deck-stage{position:absolute;width:1920px;height:1080px;transform-origin:0 0}
.slide{display:none;position:absolute;inset:0;width:1920px;height:1080px;overflow:hidden;background:#f4f1ea}
.slide.active{display:block}.framework{background:${frameworkColor}}
h1{position:absolute;left:180px;top:180px;margin:0;font:700 88px Arial,sans-serif;color:#181818}
</style></head><body>
<div class="deck-viewport"><main class="deck-stage" id="deckStage">
  <section class="slide" data-slide-id="cover"><h1 data-edit>${labels.cover}</h1></section>
  <section class="slide framework" data-slide-id="framework"><h1 data-edit>${labels.framework}</h1></section>
  <section class="slide" data-slide-id="metrics"><h1 data-edit>${labels.metrics}</h1></section>
  <section class="slide" data-slide-id="closing"><h1 data-edit>${labels.closing}</h1></section>
</main></div>
<script>
const slides=[...document.querySelectorAll('.slide')];
function render(){
  const index=Math.max(0,Math.min(slides.length-1,(Number(location.hash.slice(1))||1)-1));
  slides.forEach((slide,i)=>slide.classList.toggle('active',i===index));
  const stage=document.getElementById('deckStage');
  const scale=Math.min(innerWidth/1920,innerHeight/1080);
  stage.style.transform='translate('+((innerWidth-1920*scale)/2)+'px,'+((innerHeight-1080*scale)/2)+'px) scale('+scale+')';
}
addEventListener('hashchange',render);addEventListener('resize',render);render();
</script></body></html>`,
    "utf8"
  );
}

function slide(id) {
  return { id };
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

function blankPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function rgbaPng(width, height, colorAt) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha = 255] = colorAt(x, y);
      const offset = 1 + x * 4;
      row[offset] = red;
      row[offset + 1] = green;
      row[offset + 2] = blue;
      row[offset + 3] = alpha;
    }
    scanlines.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(scanlines))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function rect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

test("geometry analysis blocks text overflow and visible content outside the slide", () => {
  const findings = analyzeVisualGeometry({
    slide: rect(0, 0, 1920, 1080),
    elements: [
      {
        selector: "[data-role=title]",
        kind: "text",
        rect: rect(100, 100, 500, 120),
        textRects: [rect(100, 100, 500, 120)],
        overflowX: 42,
        overflowY: 0
      },
      {
        selector: ".footer-note",
        kind: "text",
        rect: rect(1800, 1000, 180, 40),
        textRects: [rect(1800, 1000, 180, 40)]
      }
    ],
    lines: []
  });

  assert.deepEqual(
    findings.map((finding) => finding.code).sort(),
    ["slide-overflow", "text-overflow"]
  );
  assert.ok(findings.every((finding) => finding.severity === "blocker"));
});

test("geometry analysis preserves an opted-in semantic text-fit candidate", () => {
  const findings = analyzeVisualGeometry({
    slide: rect(0, 0, 1920, 1080),
    elements: [
      {
        selector: '[data-role="title"]',
        kind: "text",
        rect: rect(100, 100, 400, 100),
        textRects: [rect(100, 100, 400, 100)],
        overflowX: 100,
        overflowY: 0,
        clipsOverflow: true,
        autoFix: {
          command: "fit-text",
          slide: "metrics",
          target: "title",
          itemId: null,
          fontSize: 48,
          minFontSize: 32,
          clientWidth: 400,
          clientHeight: 100,
          scrollWidth: 500,
          scrollHeight: 100
        }
      }
    ],
    lines: []
  });

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].autoFix, {
    command: "fit-text",
    slide: "metrics",
    target: "title",
    itemId: null,
    fontSize: 48,
    minFontSize: 32,
    clientWidth: 400,
    clientHeight: 100,
    scrollWidth: 500,
    scrollHeight: 100
  });
});

test("geometry analysis blocks incoherent overlap but honors an explicit overlap allowance", () => {
  const base = {
    slide: rect(0, 0, 1920, 1080),
    lines: []
  };
  const colliding = [
    {
      selector: ".title",
      kind: "text",
      rect: rect(100, 100, 500, 100),
      textRects: [rect(100, 100, 500, 100)]
    },
    {
      selector: ".caption",
      kind: "text",
      rect: rect(450, 150, 400, 80),
      textRects: [rect(450, 150, 400, 80)]
    }
  ];

  assert.equal(
    analyzeVisualGeometry({ ...base, elements: colliding }).filter(
      (finding) => finding.code === "element-overlap"
    ).length,
    1
  );
  assert.equal(
    analyzeVisualGeometry({
      ...base,
      elements: [{ ...colliding[0], allowOverlap: true }, colliding[1]]
    }).length,
    0
  );
});

test("geometry analysis blocks a line crossing text and accepts an allowed connector", () => {
  const snapshot = {
    slide: rect(0, 0, 1920, 1080),
    elements: [
      {
        selector: ".label",
        kind: "text",
        rect: rect(300, 300, 300, 80),
        textRects: [rect(300, 320, 300, 35)]
      }
    ],
    lines: [
      {
        selector: ".connector::before",
        rect: rect(100, 334, 800, 1),
        orientation: "horizontal"
      }
    ]
  };

  const findings = analyzeVisualGeometry(snapshot);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "line-through-text");
  assert.equal(
    analyzeVisualGeometry({
      ...snapshot,
      lines: [{ ...snapshot.lines[0], allowed: true }]
    }).length,
    0
  );
});

test("geometry analysis uses SVG line endpoints instead of its broad bounding box", () => {
  const base = {
    slide: rect(0, 0, 1920, 1080),
    elements: [
      {
        selector: ".label",
        kind: "text",
        rect: rect(280, 130, 80, 50),
        textRects: [rect(280, 130, 80, 50)]
      }
    ]
  };

  assert.equal(
    analyzeVisualGeometry({
      ...base,
      lines: [
        {
          selector: "line",
          rect: rect(100, 100, 400, 400),
          start: { x: 100, y: 100 },
          end: { x: 500, y: 500 },
          thickness: 2
        }
      ]
    }).length,
    0
  );
  assert.equal(
    analyzeVisualGeometry({
      ...base,
      lines: [
        {
          selector: "line",
          rect: rect(100, 100, 400, 100),
          start: { x: 100, y: 100 },
          end: { x: 500, y: 200 },
          thickness: 2
        }
      ]
    })[0].code,
    "line-through-text"
  );
});

test("geometry analysis does not flag separated content", () => {
  const findings = analyzeVisualGeometry({
    slide: rect(0, 0, 1920, 1080),
    elements: [
      {
        selector: ".title",
        kind: "text",
        rect: rect(100, 100, 500, 80),
        textRects: [rect(100, 110, 500, 45)]
      },
      {
        selector: ".body",
        kind: "text",
        rect: rect(100, 240, 700, 180),
        textRects: [rect(100, 250, 700, 100)]
      }
    ],
    lines: []
  });

  assert.deepEqual(findings, []);
});

test("pixel analysis detects a narrow contrasting edge stripe and honors its allowance", () => {
  const png = rgbaPng(100, 60, (x) =>
    x < 6 ? [220, 20, 30, 255] : [250, 250, 245, 255]
  );

  const findings = detectEdgeStripes(png, {
    region: rect(0, 0, 100, 60)
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "abnormal-edge-stripe");
  assert.equal(findings[0].edge, "left");
  assert.ok(findings[0].thickness >= 5);
  assert.deepEqual(
    detectEdgeStripes(png, {
      region: rect(0, 0, 100, 60),
      allowedEdges: ["left"]
    }),
    []
  );
});

test("pixel analysis does not report a uniform slide background as a stripe", () => {
  const png = rgbaPng(100, 60, () => [250, 250, 245, 255]);

  assert.deepEqual(
    detectEdgeStripes(png, {
      region: rect(0, 0, 100, 60)
    }),
    []
  );
});

test("image partition analysis detects horizontal and vertical internal stripes", () => {
  const horizontal = rgbaPng(120, 80, (x, y) =>
    y >= 31 && y < 37 && x >= 12 && x < 108
      ? [220, 20, 30, 255]
      : [250, 250, 245, 255]
  );
  const vertical = rgbaPng(120, 80, (x, y) =>
    x >= 54 && x < 60 && y >= 8 && y < 72
      ? [20, 80, 220, 255]
      : [250, 250, 245, 255]
  );

  assert.equal(
    detectInternalStripes(horizontal, {
      region: rect(0, 0, 120, 80)
    })[0].orientation,
    "horizontal"
  );
  assert.equal(
    detectInternalStripes(vertical, {
      region: rect(0, 0, 120, 80)
    })[0].orientation,
    "vertical"
  );
});

test("image partition analysis ignores short blocks and attributed DOM regions", () => {
  const shortBlock = rgbaPng(120, 80, (x, y) =>
    y >= 31 && y < 37 && x >= 40 && x < 80
      ? [220, 20, 30, 255]
      : [250, 250, 245, 255]
  );
  const longStripe = rgbaPng(120, 80, (x, y) =>
    y >= 31 && y < 37 && x >= 12 && x < 108
      ? [220, 20, 30, 255]
      : [250, 250, 245, 255]
  );

  assert.deepEqual(
    detectInternalStripes(shortBlock, {
      region: rect(0, 0, 120, 80)
    }),
    []
  );
  assert.deepEqual(
    detectInternalStripes(longStripe, {
      region: rect(0, 0, 120, 80),
      ignoredRects: [rect(10, 29, 100, 10)]
    }),
    []
  );
});

test("visual task selection includes affected slides and immediate revised neighbors", () => {
  const revised = ["cover", "point", "framework", "metrics", "comparison", "closing"].map(
    slide
  );
  const plan = { changes: [{ targets: ["metrics"] }] };

  assert.deepEqual(
    selectVisualSlides({ sourceSlides: revised, revisedSlides: revised, plan }),
    ["framework", "metrics", "comparison"]
  );
});

test("visual task selection includes first and last slides when slide count changes", () => {
  const source = ["cover", "framework", "metrics", "closing"].map(slide);
  const revised = ["cover", "framework", "details", "metrics", "closing"].map(slide);
  const plan = { changes: [{ targets: ["framework", "details"] }] };

  assert.deepEqual(
    selectVisualSlides({ sourceSlides: source, revisedSlides: revised, plan }),
    ["cover", "framework", "details", "metrics", "closing"]
  );
});

test("PNG inspection rejects a dimensionally valid but blank image", () => {
  const result = inspectPng(blankPng(), { width: 1, height: 1 });

  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.nonBlank, false);
});

test("PNG pixel comparison reports exact channel differences", () => {
  const first = rgbaPng(2, 1, (x) => (x === 0 ? [10, 20, 30, 255] : [40, 50, 60, 255]));
  const second = rgbaPng(2, 1, (x) => (x === 0 ? [10, 20, 30, 255] : [45, 50, 55, 255]));

  assert.deepEqual(comparePngPixels(first, first), {
    dimensionsMatch: true,
    differingPixels: 0,
    differingPixelRatio: 0,
    maxChannelDelta: 0,
    meanChannelDelta: 0
  });
  assert.deepEqual(comparePngPixels(first, second), {
    dimensionsMatch: true,
    differingPixels: 1,
    differingPixelRatio: 0.5,
    maxChannelDelta: 5,
    meanChannelDelta: 1.25
  });
});

test("PNG pixel comparison can ignore an explicitly measured semantic region", () => {
  const first = rgbaPng(3, 1, (x) =>
    x === 1 ? [10, 20, 30, 255] : [40, 50, 60, 255]
  );
  const second = rgbaPng(3, 1, (x) =>
    x === 1 ? [200, 210, 220, 255] : [40, 50, 60, 255]
  );

  assert.deepEqual(
    comparePngPixels(first, second, {
      ignoredRects: [{ left: 1, top: 0, right: 2, bottom: 1 }]
    }),
    {
      dimensionsMatch: true,
      differingPixels: 0,
      differingPixelRatio: 0,
      maxChannelDelta: 0,
      meanChannelDelta: 0
    }
  );
});

test("visual diff records planned changes without blocking them", () => {
  const result = analyzeVisualDiff({
    planned: true,
    baselineFile: "/tmp/baseline/metrics-desktop.png",
    metrics: {
      dimensionsMatch: true,
      differingPixels: 25000,
      differingPixelRatio: 0.019,
      maxChannelDelta: 255,
      meanChannelDelta: 2.4
    }
  });

  assert.equal(result.evidence.status, "planned-change");
  assert.equal(result.evidence.planned, true);
  assert.deepEqual(result.findings, []);
});

test("visual diff blocks a meaningful change on a protected slide", () => {
  const result = analyzeVisualDiff({
    planned: false,
    baselineFile: "/tmp/baseline/framework-desktop.png",
    metrics: {
      dimensionsMatch: true,
      differingPixels: 3200,
      differingPixelRatio: 0.0097,
      maxChannelDelta: 180,
      meanChannelDelta: 0.84
    }
  });

  assert.equal(result.evidence.status, "unexpected-change");
  assert.deepEqual(result.findings, [
    {
      code: "unexpected-visual-change",
      severity: "blocker",
      message: "Protected slide differs materially from its source version.",
      differingPixelRatio: 0.0097,
      maxChannelDelta: 180,
      meanChannelDelta: 0.84
    }
  ]);
});

test("visual diff tolerates negligible anti-aliasing noise on a protected slide", () => {
  const result = analyzeVisualDiff({
    planned: false,
    baselineFile: "/tmp/baseline/framework-desktop.png",
    metrics: {
      dimensionsMatch: true,
      differingPixels: 480,
      differingPixelRatio: 0.00037,
      maxChannelDelta: 7,
      meanChannelDelta: 0.001
    }
  });

  assert.equal(result.evidence.status, "noise");
  assert.deepEqual(result.findings, []);
});

test("visual review rejects an incomplete capture checklist", () => {
  assert.throws(
    () =>
      applyVisualReview(
        {
          captures: [{ id: "metrics:desktop" }, { id: "framework:desktop" }]
        },
        {
          reviewer: "test",
          captures: [{ id: "metrics:desktop", status: "pass" }]
        }
      ),
    /missing captures: framework:desktop/
  );
});

test("visual review scope identifies abnormal captures from structured evidence", () => {
  const scope = buildVisualReviewScope({
    captures: [
      {
        id: "cover:desktop",
        slide: "cover",
        viewport: "desktop",
        valid: true,
        automatedPassed: true,
        findings: [],
        visualDiff: { status: "identical", planned: false }
      },
      {
        id: "metrics:desktop",
        slide: "metrics",
        viewport: "desktop",
        valid: true,
        automatedPassed: true,
        findings: [
          {
            code: "typography-orphan-line",
            severity: "warning",
            message: "Potential orphan line."
          }
        ],
        visualDiff: { status: "planned-change", planned: true }
      },
      {
        id: "framework:desktop",
        slide: "framework",
        viewport: "desktop",
        valid: true,
        automatedPassed: true,
        findings: [],
        visualDiff: { status: "unexpected-change", planned: false }
      },
      {
        id: "closing:desktop",
        slide: "closing",
        viewport: "desktop",
        valid: true,
        automatedPassed: true,
        findings: []
      }
    ],
    styleConsistency: {
      findings: [
        {
          slide: "closing",
          code: "style-title-family-outlier",
          severity: "warning",
          message: "Title family differs from neighboring slides."
        }
      ]
    },
    fontContinuity: { findings: [] },
    visualQuality: { findings: [] },
    semanticEmphasis: { findings: [] }
  });

  assert.deepEqual(scope.requiredCaptureIds, [
    "metrics:desktop",
    "framework:desktop",
    "closing:desktop"
  ]);
  assert.equal(scope.abnormalItemCount, 3);
  assert.deepEqual(
    scope.captures.find((capture) => capture.id === "metrics:desktop").reasons,
    ["warning"]
  );
  assert.deepEqual(
    scope.captures.find((capture) => capture.id === "framework:desktop").reasons,
    ["unexpected-visual-change"]
  );
  assert.deepEqual(
    scope.captures.find((capture) => capture.id === "cover:desktop").reasons,
    []
  );
});

test("abnormal-only visual review auto-passes normal captures after contact sheet review", () => {
  const reviewed = applyVisualReview(
    {
      capturePassed: true,
      contactSheets: [
        {
          viewport: "desktop",
          file: "/tmp/contact-sheet-desktop.html"
        }
      ],
      captures: [
        {
          id: "cover:desktop",
          slide: "cover",
          viewport: "desktop",
          valid: true,
          automatedPassed: true,
          findings: []
        },
        {
          id: "metrics:desktop",
          slide: "metrics",
          viewport: "desktop",
          valid: true,
          automatedPassed: true,
          findings: [
            {
              code: "typography-orphan-line",
              severity: "warning",
              message: "Potential orphan line."
            }
          ]
        }
      ],
      styleConsistency: { findings: [] },
      fontContinuity: { findings: [] },
      visualQuality: { findings: [] },
      semanticEmphasis: { findings: [] }
    },
    {
      reviewer: "test",
      mode: "abnormal-only",
      contactSheet: {
        status: "pass",
        file: "/tmp/contact-sheet-desktop.html",
        notes: ""
      },
      captures: [{ id: "metrics:desktop", status: "pass", notes: "" }]
    },
    "2026-09-17T00:00:00.000Z"
  );

  assert.equal(reviewed.status, "passed");
  assert.deepEqual(
    reviewed.review.captures.map(({ id, status, autoPassed }) => ({
      id,
      status,
      autoPassed
    })),
    [
      { id: "cover:desktop", status: "pass", autoPassed: true },
      { id: "metrics:desktop", status: "pass", autoPassed: false }
    ]
  );
  assert.deepEqual(reviewed.review.scope.requiredCaptureIds, ["metrics:desktop"]);
});

test("writing a deck modification invalidates a previously passed visual gate", () => {
  const { deck } = createDeck();
  const projectPath = path.join(deck, "deck-project.json");
  const project = JSON.parse(readFileSync(projectPath, "utf8"));
  writeFileSync(
    projectPath,
    `${JSON.stringify({
      ...project,
      visualAudit: { status: "passed", report: "/old/report.json" }
    })}\n`
  );
  const planPath = path.join(deck, "change-plan.json");
  writeFileSync(
    planPath,
    `${JSON.stringify({
      changes: [
        {
          id: "metrics-title",
          command: "set-text",
          targets: ["metrics"],
          slide: "metrics",
          target: "title",
          value: "新的指标标题",
          status: "pending"
        }
      ]
    })}\n`
  );

  execFileSync(
    process.execPath,
    [
      path.join(scripts, "modify-deck.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--write"
    ],
    { encoding: "utf8" }
  );

  const updated = JSON.parse(readFileSync(projectPath, "utf8"));
  assert.equal(updated.visualAudit.status, "required");
  assert.equal(updated.visualAudit.report, null);
});

test(
  "visual audit blocks DOM geometry, crossing lines, and abnormal image stripes",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ppt-visual-defects-test-"));
    const deck = path.join(root, "deck");
    const outputDir = path.join(root, "visual-audit");
    mkdirSync(deck);
    writeFileSync(
      path.join(deck, "index.html"),
      `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#222}
.deck-stage{position:absolute;width:1920px;height:1080px;transform-origin:0 0}
.slide{position:absolute;inset:0;width:1920px;height:1080px;overflow:hidden;background:#fff}
.stripe{position:absolute;inset:0 auto 0 0;width:12px;background:#e02030}
.internal-stripe{position:absolute;left:160px;top:760px;width:1600px;height:16px;background:#16a060}
.overflow{position:absolute;left:100px;top:100px;width:180px;height:40px;overflow:hidden;white-space:nowrap;font:32px sans-serif}
.outside{position:absolute;left:1880px;top:220px;width:120px;font:30px sans-serif}
.first,.second{position:absolute;top:400px;font:40px sans-serif}
.first{left:200px}.second{left:280px}
.crossing{position:absolute;left:650px;top:520px;font:42px sans-serif}
.bad-line{position:absolute;left:600px;top:520px;width:500px;height:50px;overflow:visible}
</style></head><body>
<main class="deck-stage" id="deckStage">
  <section class="slide active" data-slide-id="defects" data-layout="custom">
    <div class="stripe" aria-hidden="true"></div>
    <div class="internal-stripe" aria-hidden="true"></div>
    <div class="overflow" data-edit>This title is much too long for its fixed box</div>
    <div class="outside" data-edit>Outside</div>
    <div class="first" data-edit>Overlapping</div><div class="second" data-edit>labels</div>
    <div class="crossing" data-edit>Crossed label</div>
    <svg class="bad-line" viewBox="0 0 500 50" aria-hidden="true">
      <line x1="0" y1="25" x2="500" y2="25" stroke="#111" stroke-width="3"></line>
    </svg>
  </section>
</main>
<script>
const stage=document.getElementById('deckStage');
const scale=Math.min(innerWidth/1920,innerHeight/1080);
stage.style.transform='translate('+((innerWidth-1920*scale)/2)+'px,'+((innerHeight-1080*scale)/2)+'px) scale('+scale+')';
</script></body></html>`,
      "utf8"
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--out",
        outputDir,
        "--chrome",
        chromePath,
        "--json"
      ],
      { encoding: "utf8", timeout: 30000 }
    );

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "failed");
    assert.equal(report.capturePassed, false);
    const codes = new Set(
      report.captures.flatMap((capture) =>
        (capture.findings ?? []).map((finding) => finding.code)
      )
    );
    assert.deepEqual(
      [...codes].sort(),
      [
        "abnormal-edge-stripe",
        "abnormal-internal-stripe",
        "element-overlap",
        "line-through-text",
        "slide-overflow",
        "text-overflow"
      ]
    );
  }
);

test(
  "visual audit blocks an unplanned visual change on a protected slide",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ppt-visual-diff-test-"));
    const source = path.join(root, "source");
    const deck = path.join(root, "revision");
    const outputDir = path.join(root, "visual-audit");
    const labels = {
      cover: "Cover",
      framework: "Framework",
      metrics: "Metrics",
      closing: "Closing"
    };
    writeVisualDiffDeck(source, labels);
    writeVisualDiffDeck(
      deck,
      { ...labels, metrics: "Updated metrics" },
      "#72c6a3"
    );
    writeFileSync(
      path.join(deck, "revision.json"),
      `${JSON.stringify({ source })}\n`
    );
    writeFileSync(
      path.join(deck, "change-plan.json"),
      `${JSON.stringify({
        changes: [{ id: "metrics-copy", targets: ["metrics"], status: "verified" }]
      })}\n`
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--out",
        outputDir,
        "--chrome",
        chromePath,
        "--json"
      ],
      { encoding: "utf8", timeout: 30000 }
    );

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "failed");
    assert.equal(report.renderSessions, 1);
    assert.equal(report.visualDiffFindingCount, 1);
    const frameworkCaptures = report.captures.filter(
      (capture) => capture.slide === "framework"
    );
    assert.ok(
      frameworkCaptures.every(
        (capture) =>
          capture.visualDiff.status === "unexpected-change" &&
          capture.findings.some(
            (finding) => finding.code === "unexpected-visual-change"
          )
      )
    );
    assert.ok(
      report.captures
        .filter((capture) => capture.slide === "metrics")
        .every(
          (capture) =>
            capture.visualDiff.planned &&
            capture.visualDiff.status === "planned-change"
        )
    );
    assert.equal(readdirSync(path.join(outputDir, "baseline")).length, 3);
  }
);

test(
  "visual audit allows planned changes when protected slides remain identical",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ppt-visual-diff-clean-test-"));
    const source = path.join(root, "source");
    const deck = path.join(root, "revision");
    const outputDir = path.join(root, "visual-audit");
    const labels = {
      cover: "Cover",
      framework: "Framework",
      metrics: "Metrics",
      closing: "Closing"
    };
    writeVisualDiffDeck(source, labels);
    writeVisualDiffDeck(deck, { ...labels, metrics: "Updated metrics" });
    writeFileSync(
      path.join(deck, "revision.json"),
      `${JSON.stringify({ source })}\n`
    );
    writeFileSync(
      path.join(deck, "change-plan.json"),
      `${JSON.stringify({
        changes: [{ id: "metrics-copy", targets: ["metrics"], status: "verified" }]
      })}\n`
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--out",
        outputDir,
        "--chrome",
        chromePath,
        "--json"
      ],
      { encoding: "utf8", timeout: 30000 }
    );

    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "review-required");
    assert.equal(report.visualDiffFindingCount, 0);
    assert.ok(
      report.captures
        .filter((capture) => capture.slide !== "metrics")
        .every((capture) => capture.visualDiff.status === "identical")
    );
    assert.ok(
      report.captures
        .filter((capture) => capture.slide === "metrics")
        .every((capture) => capture.visualDiff.status === "planned-change")
    );
  }
);

test(
  "visual audit blocks unrequested font drift on a planned slide",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const { root, deck: source } = createDeck();
    const versionOutput = execFileSync(
      process.execPath,
      [path.join(scripts, "version-deck.mjs"), source, "--label", "copy-change"],
      { encoding: "utf8" }
    );
    const deck = versionOutput.trim().split("\n").at(-1);
    const planPath = path.join(deck, "change-plan.json");
    const outputDir = path.join(root, "font-continuity-audit");
    writeFileSync(
      planPath,
      `${JSON.stringify({
        changes: [
          {
            id: "metrics-copy",
            targets: ["metrics"],
            status: "verified"
          }
        ]
      })}\n`
    );
    const htmlPath = path.join(deck, "index.html");
    writeFileSync(
      htmlPath,
      readFileSync(htmlPath, "utf8").replace(
        '<h2 class="reveal" data-role="title" data-visual-autofix="fit-text" data-visual-min-font-size="52" data-edit>让效率提升，有迹可循。</h2>',
        '<h2 class="reveal" style="font-weight:500" data-role="title" data-visual-autofix="fit-text" data-visual-min-font-size="52" data-edit>让效率变化，有迹可循。</h2>'
      )
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--plan",
        planPath,
        "--out",
        outputDir,
        "--chrome",
        chromePath,
        "--json"
      ],
      { encoding: "utf8", timeout: 30000 }
    );

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.fontContinuity.passed, false);
    assert.ok(
      report.fontContinuity.findings.some(
        (finding) =>
          finding.slide === "metrics" &&
          finding.code === "font-weight-drift"
      )
    );
    assert.equal(report.renderSessions, 1);

    writeFileSync(
      planPath,
      `${JSON.stringify({
        changes: [
          {
            id: "metrics-copy",
            targets: ["metrics"],
            status: "verified",
            typographyAuthorization: {
              role: "title",
              properties: ["fontWeight"],
              fontWeight: 500
            }
          }
        ]
      })}\n`
    );
    const authorized = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--plan",
        planPath,
        "--out",
        path.join(root, "authorized-font-audit"),
        "--chrome",
        chromePath,
        "--json"
      ],
      { encoding: "utf8", timeout: 30000 }
    );

    assert.equal(authorized.status, 2, authorized.stderr);
    const authorizedReport = JSON.parse(authorized.stdout);
    assert.equal(authorizedReport.fontContinuity.passed, true);
    assert.deepEqual(authorizedReport.fontContinuity.findings, []);
  }
);

test(
  "visual audit blocks a contracted runtime typography defect",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const { root, deck } = createDeck();
    const outputDir = path.join(root, "visual-audit");
    const planPath = path.join(deck, "change-plan.json");
    const htmlPath = path.join(deck, "index.html");
    const contractPath = path.join(deck, "layout-contracts.json");
    writeFileSync(
      planPath,
      `${JSON.stringify({
        changes: [
          { id: "workflow-type", targets: ["workflow"], status: "verified" }
        ]
      })}\n`
    );
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    contract.typographyQuality = {
      default: {
        minFontSize: 18,
        minLineHeightRatio: 1.15,
        maxLines: 8,
        maxLineCharacters: 42,
        orphanMinCharacters: 2
      },
      roleRules: {
        "item-body": {
          minFontSize: 20,
          minLineHeightRatio: 1.3,
          maxLines: 4,
          maxLineCharacters: 28,
          orphanMinCharacters: 2
        }
      }
    };
    writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    writeFileSync(
      htmlPath,
      readFileSync(htmlPath, "utf8").replace(
        "data-edit>从可靠来源获取信息，<br>保留链接与发布时间。",
        'style="font-size:12px;line-height:12px" data-edit>从可靠来源获取信息，<br>保留链接与发布时间。'
      )
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--plan",
        planPath,
        "--out",
        outputDir,
        "--chrome",
        chromePath,
        "--json"
      ],
      { encoding: "utf8", timeout: 30000 }
    );

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.capturePassed, false);
    assert.equal(report.visualQuality.passed, false);
    assert.ok(
      report.visualQuality.typography.findings.some(
        (finding) =>
          finding.code === "typography-font-size" &&
          finding.slide === "workflow" &&
          finding.severity === "blocker"
      )
    );
  }
);

test(
  "visual audit blocks misleading chart geometry and inaccessible contrast",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const { root, deck } = createDeck();
    const outputDir = path.join(root, "visual-audit");
    const planPath = path.join(deck, "change-plan.json");
    const htmlPath = path.join(deck, "index.html");
    writeFileSync(
      planPath,
      `${JSON.stringify({
        changes: [
          { id: "metrics-p1-defects", targets: ["metrics"], status: "verified" }
        ]
      })}\n`
    );
    writeFileSync(
      htmlPath,
      readFileSync(htmlPath, "utf8")
        .replace(
          'data-chart-mark style="width:40%"',
          'data-chart-mark style="width:80%"'
        )
        .replace(
          '<div class="chart-note" data-edit>',
          '<div class="chart-note" style="color:#fff" data-edit>'
        )
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--plan",
        planPath,
        "--out",
        outputDir,
        "--chrome",
        chromePath,
        "--json"
      ],
      { encoding: "utf8", timeout: 30000 }
    );

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.capturePassed, false);
    assert.ok(
      report.visualQuality.charts.findings.some(
        (finding) => finding.code === "chart-bar-scale-mismatch"
      )
    );
    assert.ok(
      report.visualQuality.accessibility.findings.some(
        (finding) => finding.code === "accessibility-contrast"
      )
    );
  }
);

test(
  "visual audit blocks an explicit cross-slide style contract violation",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const { root, deck } = createDeck();
    const outputDir = path.join(root, "visual-audit");
    const planPath = path.join(deck, "change-plan.json");
    const htmlPath = path.join(deck, "index.html");
    writeFileSync(
      planPath,
      `${JSON.stringify({
        changes: [
          { id: "statement-style", targets: ["point-of-view"], status: "verified" }
        ]
      })}\n`
    );
    writeFileSync(
      path.join(deck, "layout-contracts.json"),
      `${JSON.stringify(styleContract, null, 2)}\n`
    );
    writeFileSync(
      htmlPath,
      readFileSync(htmlPath, "utf8").replace(
        '<div class="statement reveal"',
        '<div class="statement reveal" style="font-family: Comic Sans MS, cursive"'
      )
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--plan",
        planPath,
        "--out",
        outputDir,
        "--chrome",
        chromePath,
        "--json"
      ],
      { encoding: "utf8", timeout: 30000 }
    );

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.capturePassed, false);
    assert.equal(report.styleConsistency.passed, false);
    assert.ok(
      report.styleConsistency.findings.some(
        (finding) =>
          finding.code === "style-font-family" &&
          finding.slide === "point-of-view" &&
          finding.severity === "blocker"
      )
    );
  }
);

test(
  "visual audit renders selected desktop screenshots and requires review",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const { root, deck } = createDeck();
    const planPath = path.join(deck, "change-plan.json");
    const outputDir = path.join(root, "visual-audit");
    writeFileSync(
      planPath,
      `${JSON.stringify(
        {
          summary: "Review metrics",
          changes: [
            {
              id: "metrics-copy",
              targets: ["metrics"],
              status: "verified"
            }
          ]
        },
        null,
        2
      )}\n`
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--plan",
        planPath,
        "--out",
        outputDir,
        "--chrome",
        chromePath,
        "--json"
      ],
      { encoding: "utf8", timeout: 30000 }
    );

    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "review-required");
    assert.equal(report.browser.source, "explicit");
    assert.match(report.browser.version, /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(report.browser.executablePath, chromePath);
    assert.deepEqual(report.selectedSlides, ["framework", "metrics", "comparison"]);
    assert.equal(report.contactSheets.length, 1);
    assert.equal(report.contactSheets[0].viewport, "desktop");
    assert.equal(report.contactSheets[0].captureCount, 3);
    assert.equal(report.contactSheets[0].abnormalCaptureCount, 0);
    const contactSheet = readFileSync(report.contactSheets[0].file, "utf8");
    assert.match(contactSheet, /Visual Audit Contact Sheet/);
    assert.match(contactSheet, /framework/);
    assert.match(contactSheet, /metrics/);
    assert.match(contactSheet, /comparison/);
    assert.equal(report.reviewScope.abnormalCaptureCount, 0);
    assert.equal(report.reviewScope.abnormalItemCount, 0);
    assert.equal(report.captures.length, 3);
    assert.equal(report.renderSessions, 1);
    assert.equal(report.styleConsistency.passed, true);
    assert.deepEqual(report.styleConsistency.findings, []);
    assert.equal(report.visualQuality.passed, true);
    assert.deepEqual(report.visualQuality.findings, []);
    assert.equal(report.visualQuality.charts.passed, true);
    assert.equal(report.visualQuality.semanticVisual.passed, true);
    assert.equal(report.visualQuality.accessibility.passed, true);
    assert.ok(report.captures.every((capture) => capture.styleProfile));
    assert.ok(report.captures.every((capture) => capture.qualityProfile));
    assert.ok(
      report.captures
        .filter((capture) => capture.viewport === "desktop")
        .flatMap((capture) => capture.qualityProfile.typography)
        .every(
          (element) =>
            Array.isArray(element.platformFonts) &&
            element.platformFonts.length > 0
        )
    );
    assert.ok(
      report.captures.every(
        (capture) =>
          Array.isArray(capture.qualityProfile.charts) &&
          capture.qualityProfile.semantic &&
          capture.qualityProfile.accessibility
      )
    );
    assert.ok(
      Math.abs(
        report.captures.find(
          (capture) =>
            capture.slide === "metrics" && capture.viewport === "desktop"
        ).qualityProfile.charts[0].points[1].drawnFraction - 0.4
      ) < 0.001
    );
    assert.deepEqual(
      report.captures.find(
        (capture) =>
          capture.slide === "metrics" && capture.viewport === "desktop"
      ).qualityProfile.charts[0].points.map((point) => point.selector),
      ['[data-chart-point="before"]', '[data-chart-point="after"]']
    );
    assert.equal(
      report.captures.find(
        (capture) =>
          capture.slide === "framework" && capture.viewport === "desktop"
      ).qualityProfile.repeatedGroups[0].orientation,
      "vertical"
    );
    assert.equal(
      new Set(report.captures.map((capture) => capture.renderSessionId)).size,
      1
    );
    assert.ok(report.captures.every((capture) => capture.valid));
    assert.ok(
      report.captures.every(
        (capture) =>
          capture.viewportWidth === capture.width &&
          capture.viewportHeight === capture.height &&
          capture.activeSlide === capture.slide &&
          capture.activeAnimations === 0
      )
    );
    assert.deepEqual(
      [...new Set(report.captures.map((capture) => capture.viewport))].sort(),
      ["desktop"]
    );
    const desktopImages = report.captures
      .filter((capture) => capture.viewport === "desktop")
      .map((capture) => readFileSync(capture.file).toString("base64"));
    assert.equal(new Set(desktopImages).size, 3);
    assert.deepEqual(
      readdirSync(outputDir).filter((name) => name.startsWith(".chrome-profile-")),
      []
    );
  }
);

test(
  "visual review must cover every capture before the project gate passes",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const { root, deck } = createDeck();
    const outputDir = path.join(root, "visual-audit");
    const planPath = path.join(deck, "change-plan.json");
    writeFileSync(
      planPath,
      `${JSON.stringify({
        changes: [{ id: "metrics-copy", targets: ["metrics"], status: "verified" }]
      })}\n`
    );
    const capture = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--plan",
        planPath,
        "--out",
        outputDir,
        "--chrome",
        chromePath,
        "--json"
      ],
      { encoding: "utf8", timeout: 30000 }
    );
    assert.equal(capture.status, 2, capture.stderr);
    const report = JSON.parse(capture.stdout);
    const reviewPath = path.join(root, "review.json");
    writeFileSync(
      reviewPath,
      `${JSON.stringify(
        {
          reviewer: "automated test",
          captures: report.captures.map(({ id }) => ({
            id,
            status: "pass",
            notes: ""
          }))
        },
        null,
        2
      )}\n`
    );

    const reviewed = spawnSync(
      process.execPath,
      [
        path.join(scripts, "visual-audit.mjs"),
        "--deck",
        deck,
        "--report",
        path.join(outputDir, "visual-audit-report.json"),
        "--review",
        reviewPath,
        "--json"
      ],
      { encoding: "utf8" }
    );

    assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.equal(JSON.parse(reviewed.stdout).status, "passed");
    assert.equal(
      JSON.parse(readFileSync(path.join(deck, "deck-project.json"), "utf8")).visualAudit
        .status,
      "passed"
    );
  }
);
