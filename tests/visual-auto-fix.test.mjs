import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyCommands } from "../lib/deck-dom.mjs";
import { buildVisualRepairHandoff } from "../lib/visual-repair-handoff.mjs";
import {
  fingerprintVisualFixCommands,
  planVisualAutoFix,
  runVisualAutoFixLoop
} from "../lib/visual-auto-fix.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(skillRoot, "scripts");
const templatePath = path.join(
  skillRoot,
  "assets",
  "templates",
  "yellow-editorial",
  "template.html"
);
const chromePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function overflowFinding(overrides = {}) {
  return {
    code: "text-overflow",
    severity: "blocker",
    selectors: ['[data-role="title"]'],
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
      scrollHeight: 100,
      ...overrides
    }
  };
}

function reportWith(captures) {
  return {
    capturePassed: false,
    captures
  };
}

function createOverflowDeck({ autoFix }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-visual-auto-fix-test-"));
  const deck = path.join(root, "deck");
  mkdirSync(deck);
  const optIn = autoFix
    ? ' data-visual-autofix="fit-text" data-visual-min-font-size="24"'
    : "";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#222}
.deck-viewport{position:fixed;inset:0;overflow:hidden}
.deck-stage{position:absolute;width:1920px;height:1080px;transform-origin:0 0}
.slide{display:none;position:absolute;inset:0;width:1920px;height:1080px;overflow:hidden;background:#fff}
.slide.active{display:block}
.title{position:absolute;left:100px;top:120px;width:420px;height:110px;margin:0;overflow:hidden;white-space:nowrap;font:700 80px Arial,sans-serif}
.page{position:absolute;right:80px;bottom:60px;font:20px Arial,sans-serif}
</style></head><body>
<div class="deck-viewport"><main class="deck-stage" id="deckStage">
  <section class="slide active" data-slide-id="metrics" data-layout="custom">
    <h1 class="title" data-role="title"${optIn}>Long metrics headline</h1>
    <span class="page" data-role="page-number">01 - 02</span>
  </section>
  <section class="slide" data-slide-id="closing" data-layout="custom">
    <h1 class="title" data-role="title" style="width:900px">Closing</h1>
    <span class="page" data-role="page-number">02 - 02</span>
  </section>
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
</script></body></html>`;
  const project = `${JSON.stringify(
    {
      schemaVersion: 1,
      deckDir: deck,
      visualAudit: {
        status: "required",
        report: null,
        captures: 0
      },
      semanticAudit: {
        status: "passed",
        report: "semantic-audit.json",
        changes: 1
      }
    },
    null,
    2
  )}\n`;
  const plan = `${JSON.stringify(
    {
      summary: "Update metrics title",
      changes: [
        {
          id: "metrics-title",
          targets: ["metrics"],
          status: "verified"
        }
      ]
    },
    null,
    2
  )}\n`;
  writeFileSync(path.join(deck, "index.html"), html);
  writeFileSync(path.join(deck, "deck-project.json"), project);
  writeFileSync(path.join(deck, "change-plan.json"), plan);
  return { root, deck, html, project, plan };
}

test("template opts controlled semantic text into bounded auto-fit", () => {
  const html = readFileSync(templatePath, "utf8");
  const controlled = [
    ...html.matchAll(
      /<[^>]+\bdata-role=["'](?:title|item-title|item-body)["'][^>]*>/g
    )
  ].map((match) => match[0]);

  assert.ok(controlled.length > 0);
  assert.ok(
    controlled.every(
      (tag) =>
        tag.includes('data-visual-autofix="fit-text"') &&
        /\bdata-visual-min-font-size=["']\d+(?:\.\d+)?["']/.test(tag)
    )
  );
});

test("visual auto-fix planner creates a deterministic fit-text command", () => {
  const plan = planVisualAutoFix(
    reportWith([
      {
        id: "metrics:desktop",
        slide: "metrics",
        visualDiff: { planned: true },
        findings: [overflowFinding()]
      }
    ])
  );

  assert.deepEqual(plan.unresolved, []);
  assert.equal(plan.commands.length, 1);
  assert.deepEqual(plan.commands[0], {
    id: "visual-fit-metrics-title",
    command: "fit-text",
    slide: "metrics",
    target: "title",
    itemId: null,
    fontSize: 37.63,
    minFontSize: 32
  });
});

test("visual auto-fix planner merges viewport findings to the smallest safe size", () => {
  const plan = planVisualAutoFix(
    reportWith([
      {
        id: "metrics:desktop",
        slide: "metrics",
        findings: [overflowFinding()]
      },
      {
        id: "metrics:phone",
        slide: "metrics",
        findings: [
          overflowFinding({
            clientWidth: 360,
            scrollWidth: 480
          })
        ]
      }
    ])
  );

  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0].fontSize, 35.28);
});

test("visual auto-fix planner leaves unsafe and unsupported blockers unresolved", () => {
  const plan = planVisualAutoFix(
    reportWith([
      {
        id: "framework:desktop",
        slide: "framework",
        visualDiff: { planned: false },
        findings: [overflowFinding({ slide: "framework" })]
      },
      {
        id: "metrics:desktop",
        slide: "metrics",
        visualDiff: { planned: true },
        findings: [
          overflowFinding({
            minFontSize: 40
          }),
          {
            code: "element-overlap",
            severity: "blocker",
            selectors: [".first", ".second"]
          }
        ]
      }
    ])
  );

  assert.deepEqual(plan.commands, []);
  assert.deepEqual(
    plan.unresolved.map((finding) => finding.reason).sort(),
    [
      "below-minimum-font-size",
      "unplanned-revision-slide",
      "unsupported-finding"
    ]
  );
});

test("visual auto-fix planner preserves deck-level style blockers as unresolved", () => {
  const plan = planVisualAutoFix({
    capturePassed: false,
    captures: [],
    styleConsistency: {
      passed: false,
      findings: [
        {
          code: "style-title-hierarchy",
          severity: "blocker",
          slide: "metrics",
          property: "title.fontSize"
        }
      ]
    }
  });

  assert.deepEqual(plan.commands, []);
  assert.deepEqual(plan.unresolved, [
    {
      capture: null,
      slide: "metrics",
      code: "style-title-hierarchy",
      reason: "unsupported-style-finding",
      selectors: []
    }
  ]);
});

test("visual auto-fix planner preserves font continuity blockers as unresolved", () => {
  const plan = planVisualAutoFix({
    capturePassed: false,
    captures: [],
    fontContinuity: {
      passed: false,
      findings: [
        {
          code: "font-weight-drift",
          severity: "blocker",
          slide: "metrics",
          selectors: ['[data-role="title"]']
        }
      ]
    }
  });

  assert.deepEqual(plan.commands, []);
  assert.deepEqual(plan.unresolved, [
    {
      capture: null,
      slide: "metrics",
      code: "font-weight-drift",
      reason: "unsupported-font-continuity-finding",
      selectors: ['[data-role="title"]']
    }
  ]);
});

test("visual auto-fix planner preserves visual quality blockers as unresolved", () => {
  const plan = planVisualAutoFix({
    capturePassed: false,
    captures: [],
    visualQuality: {
      passed: false,
      findings: [
        {
          code: "typography-line-count",
          severity: "blocker",
          slide: "workflow",
          selectors: ['[data-role="item-body"]']
        },
        {
          code: "layout-content-density",
          severity: "warning",
          slide: "closing"
        }
      ]
    }
  });

  assert.deepEqual(plan.commands, []);
  assert.deepEqual(plan.unresolved, [
    {
      capture: null,
      slide: "workflow",
      code: "typography-line-count",
      reason: "unsupported-quality-finding",
      selectors: ['[data-role="item-body"]']
    }
  ]);
});

test("visual repair handoff deduplicates blockers and routes them by category", () => {
  const overflow = {
    code: "text-overflow",
    severity: "blocker",
    selectors: ['[data-role="title"]'],
    property: "scrollWidth"
  };
  const handoff = buildVisualRepairHandoff(
    {
      deck: "/tmp/deck",
      captures: [
        {
          id: "metrics:desktop",
          slide: "metrics",
          findings: [overflow]
        },
        {
          id: "metrics:phone",
          slide: "metrics",
          findings: [overflow]
        }
      ],
      styleConsistency: {
        findings: [
          {
            code: "style-color",
            severity: "blocker",
            slide: "comparison",
            property: "semanticColors.title"
          }
        ]
      },
      visualQuality: {
        findings: [
          {
            code: "typography-line-count",
            severity: "blocker",
            slide: "workflow",
            property: "lineCount",
            selectors: ['[data-role="item-body"]']
          },
          {
            code: "image-upscale",
            severity: "blocker",
            slide: "evidence",
            property: "upscale",
            selectors: ['[data-role="evidence-image"]']
          },
          {
            code: "chart-bar-scale-mismatch",
            severity: "blocker",
            slide: "metrics",
            property: "point.drawnFraction",
            selectors: ['[data-chart-point="after"]']
          },
          {
            code: "semantic-intent-mismatch",
            severity: "blocker",
            slide: "comparison",
            property: "intent",
            selectors: []
          },
          {
            code: "accessibility-contrast",
            severity: "blocker",
            slide: "closing",
            property: "contrastRatio",
            selectors: [".next-action"]
          },
          {
            code: "layout-content-density",
            severity: "warning",
            slide: "closing",
            property: "metrics.coverage"
          }
        ]
      },
      semanticEmphasis: {
        findings: [
          {
            code: "unplanned-emphasis",
            severity: "blocker",
            slide: "point-of-view",
            role: "title",
            selector: ".highlight"
          }
        ]
      }
    },
    "2026-09-17T10:00:00.000Z"
  );

  assert.equal(handoff.status, "requires-modification");
  assert.equal(handoff.owner, "modification-master");
  assert.equal(handoff.issues.length, 8);
  assert.deepEqual(
    handoff.issues.map((issue) => issue.category).sort(),
    [
      "accessibility",
      "chart",
      "content-visual",
      "content-visual",
      "image",
      "style",
      "typography",
      "typography"
    ]
  );
  assert.ok(
    handoff.issues.every(
      (issue) =>
        issue.priority === "blocker" &&
        issue.acceptance[0].type === "visual-finding-absent"
    )
  );
  assert.equal(
    handoff.issues.filter((issue) => issue.finding.code === "text-overflow").length,
    1
  );
});

test("visual repair fingerprints ignore input command order", () => {
  const commands = [
    {
      id: "visual-fit-a-title",
      command: "fit-text",
      slide: "a",
      target: "title",
      itemId: null,
      fontSize: 42,
      minFontSize: 30
    },
    {
      id: "visual-fit-b-copy",
      command: "fit-text",
      slide: "b",
      target: "copy",
      itemId: null,
      fontSize: 24,
      minFontSize: 18
    }
  ];

  assert.equal(
    fingerprintVisualFixCommands(commands),
    fingerprintVisualFixCommands([...commands].reverse())
  );
});

test("fit-text updates one unique slide-level semantic target", () => {
  const html = `<main>
    <section class="slide active" data-slide-id="metrics">
      <h2 data-role="title" style="color:red">Metrics</h2>
      <span data-role="page-number">01 - 02</span>
    </section>
    <section class="slide" data-slide-id="closing">
      <h2 data-role="title">Closing</h2>
      <span data-role="page-number">02 - 02</span>
    </section>
  </main>`;

  const result = applyCommands(html, [
    {
      id: "visual-fit-metrics-title",
      command: "fit-text",
      slide: "metrics",
      target: "title",
      fontSize: 37.63,
      minFontSize: 32
    }
  ]);

  assert.match(
    result.html,
    /data-role="title" style="color:red;font-size:37\.63px">Metrics/
  );
  assert.doesNotMatch(result.html, /font-size:37\.63px">Closing/);
});

test("fit-text scopes repeated item roles through a stable item id", () => {
  const html = `<main>
    <section class="slide active" data-slide-id="workflow">
      <h2 data-role="title">Workflow</h2>
      <div data-role="items">
        <div data-item-id="first"><p data-role="item-body">First body</p></div>
        <div data-item-id="second"><p data-role="item-body">Second body</p></div>
      </div>
      <span data-role="page-number">01 - 02</span>
    </section>
    <section class="slide" data-slide-id="closing">
      <h2 data-role="title">Closing</h2>
      <span data-role="page-number">02 - 02</span>
    </section>
  </main>`;

  const result = applyCommands(html, [
    {
      id: "visual-fit-workflow-second-item-body",
      command: "fit-text",
      slide: "workflow",
      target: "item-body",
      itemId: "second",
      fontSize: 18,
      minFontSize: 16
    }
  ]);

  assert.doesNotMatch(result.html, /font-size:18px">First body/);
  assert.match(result.html, /font-size:18px">Second body/);
});

test("fit-text rejects ambiguous locators and unsafe font sizes", () => {
  const html = `<main>
    <section class="slide active" data-slide-id="metrics">
      <h2 data-role="title">First</h2>
      <h2 data-role="title">Second</h2>
      <span data-role="page-number">01 - 02</span>
    </section>
    <section class="slide" data-slide-id="closing">
      <h2 data-role="title">Closing</h2>
      <span data-role="page-number">02 - 02</span>
    </section>
  </main>`;

  assert.throws(
    () =>
      applyCommands(html, [
        {
          id: "ambiguous",
          command: "fit-text",
          slide: "metrics",
          target: "title",
          fontSize: 32,
          minFontSize: 24
        }
      ]),
    /must resolve to exactly one element/
  );
  assert.throws(
    () =>
      applyCommands(html.replace("<h2 data-role=\"title\">Second</h2>", ""), [
        {
          id: "too-small",
          command: "fit-text",
          slide: "metrics",
          target: "title",
          fontSize: 7,
          minFontSize: 6
        }
      ]),
    /at least 8px/
  );
});

test("bounded visual repair loop audits again after applying a repair", async () => {
  const reports = [
    reportWith([
      {
        id: "metrics:desktop",
        slide: "metrics",
        findings: [overflowFinding()]
      }
    ]),
    {
      capturePassed: true,
      captures: []
    }
  ];
  const applied = [];

  const result = await runVisualAutoFixLoop({
    maxRounds: 3,
    audit: async () => reports.shift(),
    apply: async (commands) => applied.push(commands)
  });

  assert.equal(result.status, "repaired");
  assert.equal(result.rounds.length, 2);
  assert.equal(result.repairsApplied, 1);
  assert.equal(applied.length, 1);
});

test("bounded visual repair loop stops when no eligible action exists", async () => {
  const result = await runVisualAutoFixLoop({
    maxRounds: 3,
    audit: async () =>
      reportWith([
        {
          id: "metrics:desktop",
          slide: "metrics",
          findings: [
            {
              code: "element-overlap",
              severity: "blocker",
              selectors: [".a", ".b"]
            }
          ]
        }
      ]),
    apply: async () => assert.fail("must not apply")
  });

  assert.equal(result.status, "unresolved");
  assert.equal(result.stopReason, "no-eligible-repair");
  assert.equal(result.rounds.length, 1);
});

test("bounded visual repair loop stops at the configured action limit", async () => {
  let audits = 0;
  let applies = 0;
  const result = await runVisualAutoFixLoop({
    maxRounds: 1,
    audit: async () => {
      audits += 1;
      return reportWith([
        {
          id: "metrics:desktop",
          slide: "metrics",
          findings: [
            overflowFinding({
              fontSize: audits === 1 ? 48 : 37.63,
              scrollWidth: audits === 1 ? 500 : 430
            })
          ]
        }
      ]);
    },
    apply: async () => {
      applies += 1;
    }
  });

  assert.equal(result.status, "unresolved");
  assert.equal(result.stopReason, "max-rounds");
  assert.equal(applies, 1);
  assert.equal(audits, 2);
});

test("bounded visual repair loop rejects a repeated action fingerprint", async () => {
  let applies = 0;
  const result = await runVisualAutoFixLoop({
    maxRounds: 3,
    audit: async () =>
      reportWith([
        {
          id: "metrics:desktop",
          slide: "metrics",
          findings: [overflowFinding()]
        }
      ]),
    apply: async () => {
      applies += 1;
    }
  });

  assert.equal(result.status, "unresolved");
  assert.equal(result.stopReason, "repeated-repair");
  assert.equal(applies, 1);
  assert.equal(result.rounds.length, 2);
});

test("bounded visual repair loop records an apply failure", async () => {
  const result = await runVisualAutoFixLoop({
    maxRounds: 3,
    audit: async () =>
      reportWith([
        {
          id: "metrics:desktop",
          slide: "metrics",
          findings: [overflowFinding()]
        }
      ]),
    apply: async () => {
      throw new Error("write rejected");
    }
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "apply-failed");
  assert.equal(result.rounds[0].error, "write rejected");
});

test(
  "visual auto-fix CLI repairs an opted-in overflow and publishes review evidence",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const { deck, plan } = createOverflowDeck({ autoFix: true });
    const result = spawnSync(
      process.execPath,
      [
        path.join(scripts, "auto-fix-visual.mjs"),
        "--deck",
        deck,
        "--plan",
        path.join(deck, "change-plan.json"),
        "--chrome",
        chromePath,
        "--max-rounds",
        "3",
        "--json"
      ],
      { encoding: "utf8", timeout: 60000 }
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "repaired");
    assert.equal(output.repairsApplied, 1);
    assert.equal(existsSync(output.stagingDir), false);
    const updatedHtml = readFileSync(path.join(deck, "index.html"), "utf8");
    assert.match(updatedHtml, /font-size:[0-9.]+px/);
    const finalReport = JSON.parse(readFileSync(output.report, "utf8"));
    assert.equal(finalReport.deck, deck);
    assert.equal(finalReport.capturePassed, true);
    assert.equal(finalReport.status, "review-required");
    assert.ok(finalReport.captures.every((capture) => existsSync(capture.file)));
    const project = JSON.parse(
      readFileSync(path.join(deck, "deck-project.json"), "utf8")
    );
    assert.equal(project.visualAudit.status, "review-required");
    assert.equal(project.semanticAudit.status, "passed");
    assert.equal(readFileSync(path.join(deck, "change-plan.json"), "utf8"), plan);
  }
);

test(
  "visual auto-fix CLI retains failure evidence without changing the original deck",
  { skip: spawnSync(chromePath, ["--version"], { encoding: "utf8" }).status !== 0 },
  () => {
    const { deck, html, project, plan } = createOverflowDeck({ autoFix: false });
    const result = spawnSync(
      process.execPath,
      [
        path.join(scripts, "auto-fix-visual.mjs"),
        "--deck",
        deck,
        "--chrome",
        chromePath,
        "--max-rounds",
        "3",
        "--json"
      ],
      { encoding: "utf8", timeout: 60000 }
    );

    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "unresolved");
    assert.equal(output.stopReason, "no-eligible-repair");
    assert.equal(readFileSync(path.join(deck, "index.html"), "utf8"), html);
    assert.equal(
      readFileSync(path.join(deck, "deck-project.json"), "utf8"),
      project
    );
    assert.equal(readFileSync(path.join(deck, "change-plan.json"), "utf8"), plan);
    assert.equal(existsSync(output.stagingDir), true);
    assert.equal(
      output.handoff,
      path.join(output.stagingDir, "visual-repair-handoff.json")
    );
    assert.equal(existsSync(output.handoff), true);
    const handoff = JSON.parse(readFileSync(output.handoff, "utf8"));
    assert.equal(handoff.deck, deck);
    assert.equal(handoff.status, "requires-modification");
    assert.equal(handoff.owner, "modification-master");
    assert.ok(handoff.issues.length > 0);
    assert.ok(
      handoff.issues.some(
        (issue) =>
          issue.slide === "metrics" &&
          issue.finding.code === "text-overflow" &&
          issue.acceptance[0].code === "text-overflow"
      )
    );
    assert.equal(
      existsSync(
        path.join(
          output.stagingDir,
          "deck",
          ".visual-auto-fix",
          "round-1",
          "visual-audit-report.json"
        )
      ),
      true
    );
  }
);
