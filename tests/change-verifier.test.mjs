import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyChanges } from "../lib/change-verifier.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(skillRoot, "scripts");

const splitWorkflowSlide = `<section class="slide" data-slide-id="workflow-detail" data-layout="process" aria-label="流程设计续页">
  <h2 data-role="title">核验与交付</h2>
  <div class="process-rail" data-role="items" data-item-count="2">
    <div class="step" data-item-id="review"><div class="step-number" data-role="item-number">01</div><h3 data-role="item-title">人工核验</h3><p data-role="item-body">确认关键事实。</p></div>
    <div class="step" data-item-id="deliver"><div class="step-number" data-role="item-number">02</div><h3 data-role="item-title">交付与反馈</h3><p data-role="item-body">记录采纳结果。</p></div>
  </div>
  <footer class="footer"><span>流程续页</span><span data-role="page-number">00 — 00</span></footer>
</section>`;

function createDeck(name = "verification-deck") {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-verifier-test-"));
  const deck = path.join(root, name);
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

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function applyPlan(deck, plan) {
  const planPath = path.join(deck, "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
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
  return path.join(deck, "change-plan.json");
}

test("verifier derives assertions and advances every completed change to verified", () => {
  const { deck } = createDeck();
  const planPath = applyPlan(deck, {
    summary: "Update one title and remove one process step",
    changes: [
      {
        id: "metrics-title",
        type: "content",
        command: "set-text",
        targets: ["metrics"],
        slide: "metrics",
        target: "title",
        value: "增长效果与业务验证",
        request: "Update the metrics title.",
        impact: ["copy"]
      },
      {
        id: "remove-review",
        type: "item-count",
        command: "remove-item",
        targets: ["workflow"],
        slide: "workflow",
        target: "items",
        itemId: "review",
        request: "Remove the review step.",
        impact: ["layout", "numbering"]
      }
    ]
  });

  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(scripts, "verify-changes.mjs"),
        "--deck",
        deck,
        "--plan",
        planPath,
        "--write",
        "--json"
      ],
      { encoding: "utf8" }
    )
  );

  const storedPlan = readJson(planPath);
  const report = readJson(path.join(deck, "verification-report.json"));
  assert.equal(output.passed, true);
  assert.equal(output.verifiedChanges, 2);
  assert.ok(storedPlan.changes.every((change) => change.status === "verified"));
  assert.ok(
    storedPlan.changes.every((change) =>
      change.verification.assertions.every((assertion) => assertion.passed)
    )
  );
  assert.equal(report.passed, true);
});

test("failed verification preserves applied state and writes assertion evidence", () => {
  const { deck } = createDeck();
  const planPath = applyPlan(deck, {
    summary: "Update title",
    changes: [
      {
        id: "metrics-title",
        type: "content",
        command: "set-text",
        targets: ["metrics"],
        slide: "metrics",
        target: "title",
        value: "Expected title",
        request: "Update title.",
        impact: ["copy"]
      }
    ]
  });
  const htmlPath = path.join(deck, "index.html");
  writeFileSync(
    htmlPath,
    readFileSync(htmlPath, "utf8").replace("Expected title", "Wrong title"),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "verify-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--write",
      "--json"
    ],
    { encoding: "utf8" }
  );

  const storedPlan = readJson(planPath);
  const report = readJson(path.join(deck, "verification-report.json"));
  assert.equal(result.status, 1);
  assert.equal(storedPlan.changes[0].status, "applied");
  assert.equal(storedPlan.changes[0].verification.passed, false);
  assert.equal(
    storedPlan.changes[0].verification.assertions[0].actual,
    "Wrong title"
  );
  assert.equal(report.passed, false);
});

test("custom edits can be verified with explicit semantic assertions", () => {
  const { deck } = createDeck();
  const htmlPath = path.join(deck, "index.html");
  writeFileSync(
    htmlPath,
    readFileSync(htmlPath, "utf8").replace(
      "让机器提速，让人把关。",
      "突出人工审核，形成可靠交付。"
    ),
    "utf8"
  );
  const planPath = path.join(deck, "change-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Custom workflow adjustment",
      changes: [
        {
          id: "custom-workflow",
          type: "style",
          command: "custom-edit",
          targets: ["workflow"],
          request: "Emphasize human review.",
          impact: ["copy", "layout"],
          status: "applied",
          assertions: [
            {
              type: "text-includes",
              slide: "workflow",
              target: "title",
              expected: "人工审核"
            },
            {
              type: "item-count",
              slide: "workflow",
              target: "items",
              expected: 4
            }
          ]
        }
      ]
    }),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "verify-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).passed, true);
});

test("add-item verification checks the inserted title and body", () => {
  const { deck } = createDeck();
  const planPath = applyPlan(deck, {
    summary: "Add publishing step",
    changes: [
      {
        id: "add-publish",
        type: "item-count",
        command: "add-item",
        targets: ["workflow"],
        slide: "workflow",
        target: "items",
        after: "review",
        item: {
          id: "publish",
          title: "正式发布",
          body: "进入用户提供的渠道。"
        },
        request: "Add publishing step.",
        impact: ["layout", "numbering"]
      }
    ]
  });

  const first = spawnSync(
    process.execPath,
    [
      path.join(scripts, "verify-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );
  const firstReport = JSON.parse(first.stdout);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    firstReport.changes[0].verification.assertions.filter(
      (assertion) => assertion.type === "item-text-equals"
    ).length,
    2
  );

  const htmlPath = path.join(deck, "index.html");
  writeFileSync(
    htmlPath,
    readFileSync(htmlPath, "utf8").replace(
      "进入用户提供的渠道。",
      "错误的正文。"
    ),
    "utf8"
  );
  const second = spawnSync(
    process.execPath,
    [
      path.join(scripts, "verify-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(second.status, 1);
  assert.match(second.stdout, /错误的正文/);
});

test("split-slide verification checks adjacency, migration, and numbering", () => {
  const { deck } = createDeck();
  const planPath = applyPlan(deck, {
    summary: "Split workflow",
    changes: [
      {
        id: "split-workflow",
        type: "split-slide",
        command: "split-slide",
        targets: ["workflow", "workflow-detail"],
        slide: "workflow",
        newSlide: "workflow-detail",
        target: "items",
        moveItemIds: ["review", "deliver"],
        html: splitWorkflowSlide,
        request: "Split workflow into two slides.",
        impact: ["slide-count", "navigation", "numbering"]
      }
    ]
  });

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "verify-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const change = JSON.parse(result.stdout).changes[0];
  assert.equal(change.status, "verified");
  assert.ok(
    change.verification.assertions.some(
      (assertion) =>
        assertion.type === "slide-after" &&
        assertion.slide === "workflow-detail" &&
        assertion.actual === "workflow"
    )
  );
  assert.equal(
    change.verification.assertions.filter(
      (assertion) => assertion.type === "item-absent"
    ).length,
    2
  );
  assert.equal(
    change.verification.assertions.filter(
      (assertion) => assertion.type === "item-exists"
    ).length,
    2
  );
});

test("custom edits without assertions cannot be marked verified", () => {
  const { deck } = createDeck();
  const planPath = path.join(deck, "change-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Unverifiable custom edit",
      changes: [
        {
          id: "custom",
          command: "custom-edit",
          targets: ["workflow"],
          status: "applied"
        }
      ]
    }),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "verify-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /custom-edit requires explicit assertions/);
});

test("add-slide verification proves reviewed layout treatment and position", () => {
  const templatePath = path.join(
    skillRoot,
    "assets",
    "templates",
    "yellow-editorial",
    "template.html"
  );
  const html = readFileSync(templatePath, "utf8").replace(
    /(<section class="slide" data-slide-id="comparison")/,
    `<section class="slide" data-slide-id="results" data-layout="comparison" data-layout-treatment="asymmetric-contrast" aria-label="结果">
  <h2 data-role="title">结果</h2>
  <footer><span data-role="page-number">05 — 09</span></footer>
</section>
$1`
  );
  const plan = {
    summary: "Add results",
    changes: [
      {
        id: "add-results",
        command: "add-slide",
        targets: ["results"],
        after: "metrics",
        layoutTreatment: "asymmetric-contrast",
        reviewedLayout: "comparison",
        status: "applied"
      }
    ]
  };

  const passed = verifyChanges(html, plan);
  assert.equal(passed.report.passed, true);
  assert.deepEqual(
    passed.report.changes[0].verification.assertions.map(
      (assertion) => assertion.type
    ),
    [
      "slide-exists",
      "slide-after",
      "slide-layout-equals",
      "slide-attribute-equals"
    ]
  );

  const tampered = verifyChanges(
    html.replace(
      'data-layout-treatment="asymmetric-contrast"',
      'data-layout-treatment="editorial-manifesto"'
    ),
    plan
  );
  assert.equal(tampered.report.passed, false);
  assert.equal(
    tampered.report.changes[0].verification.assertions.at(-1).actual,
    "editorial-manifesto"
  );
});
