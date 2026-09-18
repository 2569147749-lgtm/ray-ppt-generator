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
import { applyCommands } from "../lib/deck-dom.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(
  skillRoot,
  "assets",
  "templates",
  "yellow-editorial",
  "template.html"
);
const contractsPath = path.join(
  skillRoot,
  "assets",
  "templates",
  "yellow-editorial",
  "layout-contracts.json"
);
const scripts = path.join(skillRoot, "scripts");

const splitWorkflowSlide = `<section class="slide" data-slide-id="workflow-detail" data-layout="process" aria-label="流程设计续页">
  <h2 data-role="title">核验与交付</h2>
  <div class="process-rail" data-role="items" data-item-count="2">
    <div class="step" data-item-id="review"><div class="step-number" data-role="item-number">03</div><h3 data-role="item-title">人工核验</h3><p data-role="item-body">确认关键事实。</p></div>
    <div class="step" data-item-id="deliver"><div class="step-number" data-role="item-number">04</div><h3 data-role="item-title">交付与反馈</h3><p data-role="item-body">记录采纳结果。</p></div>
  </div>
  <footer class="footer"><span>流程续页</span><span data-role="page-number">00 — 00</span></footer>
</section>`;

function createDeck(name = "dom-deck") {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-dom-test-"));
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

function writePassedLayoutDecision(deck, decision) {
  const reviewedAt = "2026-09-17T00:00:00.000Z";
  writeFileSync(
    path.join(deck, "slide-layout-plan.json"),
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: reviewedAt,
      status: "passed",
      decisions: [decision],
      review: {
        reviewer: "test",
        reviewedAt,
        decisions: [
          {
            id: decision.id,
            checks: {
              requestFit: "pass",
              contentFit: "pass",
              narrativeFit: "pass",
              styleContinuity: "pass"
            },
            notes: ""
          }
        ]
      }
    })
  );
  const projectPath = path.join(deck, "deck-project.json");
  const project = readJson(projectPath);
  project.slideLayoutPlan = {
    status: "passed",
    path: path.join(deck, "slide-layout-plan.json"),
    decisions: 1,
    updatedAt: reviewedAt
  };
  writeFileSync(projectPath, JSON.stringify(project));
}

test("template exposes semantic roles for controlled deck editing", () => {
  const html = readFileSync(templatePath, "utf8");

  assert.equal((html.match(/\bdata-role=["']title["']/g) ?? []).length, 8);
  assert.equal((html.match(/\bdata-role=["']items["']/g) ?? []).length, 2);
  assert.equal((html.match(/\bdata-item-id=["'][^"']+["']/g) ?? []).length, 7);
  assert.equal((html.match(/\bdata-role=["']item-number["']/g) ?? []).length, 7);
  assert.equal((html.match(/\bdata-role=["']item-count["']/g) ?? []).length, 1);
  assert.equal((html.match(/\bdata-role=["']page-number["']/g) ?? []).length, 8);
});

test("layout contracts declare the standard commands each layout supports", () => {
  const contracts = readJson(contractsPath);

  assert.deepEqual(contracts.deckCommands, [
    "add-slide",
    "delete-slide",
    "move-slide",
    "split-slide"
  ]);
  assert.deepEqual(contracts.layouts.process.supportedCommands, [
    "set-text",
    "add-item",
    "remove-item"
  ]);
  assert.deepEqual(contracts.layouts.agenda.supportedCommands, [
    "set-text",
    "add-item",
    "remove-item"
  ]);
  assert.deepEqual(contracts.layouts.cover.supportedCommands, ["set-text"]);
});

test("set-text replaces one semantic target and escapes user text", () => {
  const html = readFileSync(templatePath, "utf8");
  const result = applyCommands(html, [
    {
      id: "metrics-title",
      command: "set-text",
      slide: "metrics",
      target: "title",
      value: "增长 <验证>\n第二行"
    }
  ]);

  assert.match(result.html, /增长 &lt;验证&gt;<br>第二行/);
  assert.doesNotMatch(result.html, /让效率提升，有迹可循。/);
  assert.deepEqual(result.affectedSlides, ["metrics"]);
});

test("remove-item renumbers process items and recalculates its layout", () => {
  const html = readFileSync(templatePath, "utf8");
  const result = applyCommands(html, [
    {
      id: "remove-review",
      command: "remove-item",
      slide: "workflow",
      target: "items",
      itemId: "review"
    }
  ]);

  assert.doesNotMatch(result.html, /data-item-id="review"/);
  assert.match(result.html, /data-item-count="3"/);
  assert.match(result.html, /--item-count:3/);
  assert.match(result.html, /--connector-right:264\.75px/);
  assert.equal(
    (result.html.match(/\bdata-role="item-number"/g) ?? []).length,
    6
  );
});

test("add-item renders a process item at the requested position", () => {
  const html = readFileSync(templatePath, "utf8");
  const result = applyCommands(html, [
    {
      id: "add-publish",
      command: "add-item",
      slide: "workflow",
      target: "items",
      after: "review",
      item: {
        id: "publish",
        title: "正式发布",
        body: "进入用户提供的渠道。"
      }
    }
  ]);

  assert.match(result.html, /data-item-id="publish"/);
  assert.match(
    result.html,
    /<h3 data-role="item-title" data-visual-autofix="fit-text" data-visual-min-font-size="28" data-edit>正式发布<\/h3>/
  );
  assert.match(result.html, /data-item-count="5"/);
  assert.ok(
    result.html.indexOf('data-item-id="review"') <
      result.html.indexOf('data-item-id="publish"')
  );
});

test("add-item supports agenda rows and updates the visible item count", () => {
  const html = readFileSync(templatePath, "utf8");
  const result = applyCommands(html, [
    {
      id: "add-scale",
      command: "add-item",
      slide: "framework",
      target: "items",
      after: "design",
      item: {
        id: "scale",
        title: "形成规模化机制",
        body: "沉淀规则、指标与复盘节奏。"
      }
    }
  ]);

  assert.match(result.html, /data-item-id="scale"/);
  assert.match(result.html, /data-role="item-count">04</);
  assert.match(result.html, /data-item-id="scale"[\s\S]*?data-role="item-number">03</);
  assert.match(result.html, /data-item-id="validate"[\s\S]*?data-role="item-number">04</);
});

test("delete-slide and move-slide update order and every page number", () => {
  const html = readFileSync(templatePath, "utf8");
  const result = applyCommands(html, [
    {
      id: "delete-comparison",
      command: "delete-slide",
      slide: "comparison"
    },
    {
      id: "move-closing",
      command: "move-slide",
      slide: "closing",
      after: "cover"
    }
  ]);

  assert.deepEqual(result.slideIds, [
    "cover",
    "closing",
    "point-of-view",
    "framework",
    "metrics",
    "workflow",
    "decision-matrix"
  ]);
  assert.doesNotMatch(result.html, /data-slide-id="comparison"/);
  assert.match(
    result.html,
    /data-slide-id="closing"[\s\S]*?data-role="page-number">02 — 07/
  );
  assert.equal(
    (result.html.match(/data-role="page-number">[^<]+ — 07/g) ?? []).length,
    7
  );
});

test("add-slide inserts one validated slide and synchronizes numbering", () => {
  const html = readFileSync(templatePath, "utf8");
  const result = applyCommands(html, [
    {
      id: "add-summary",
      command: "add-slide",
      after: "metrics",
      html: `<section class="slide" data-slide-id="summary" data-layout="statement" aria-label="总结">
  <h2 data-role="title">阶段总结</h2>
  <footer class="footer"><span>总结</span><span data-role="page-number">00 — 00</span></footer>
</section>`
    }
  ]);

  assert.equal(result.slideIds[4], "summary");
  assert.equal(result.slideIds.length, 9);
  assert.match(
    result.html,
    /data-slide-id="summary"[\s\S]*?data-role="page-number">05 — 09/
  );
});

test("split-slide moves declared items into a validated slide after the source", () => {
  const html = readFileSync(templatePath, "utf8");
  const result = applyCommands(html, [
    {
      id: "split-workflow",
      command: "split-slide",
      targets: ["workflow", "workflow-detail"],
      slide: "workflow",
      newSlide: "workflow-detail",
      target: "items",
      moveItemIds: ["review", "deliver"],
      html: splitWorkflowSlide
    }
  ]);

  assert.deepEqual(result.slideIds.slice(5, 7), ["workflow", "workflow-detail"]);
  assert.deepEqual(result.affectedSlides, ["workflow", "workflow-detail"]);
  assert.doesNotMatch(
    result.html.match(/data-slide-id="workflow"[\s\S]*?<\/section>/)[0],
    /data-item-id="(?:review|deliver)"/
  );
  assert.match(
    result.html,
    /data-slide-id="workflow-detail"[\s\S]*?data-item-id="review"[\s\S]*?data-role="item-number">01</
  );
  assert.match(
    result.html,
    /data-slide-id="workflow-detail"[\s\S]*?data-item-id="deliver"[\s\S]*?data-role="item-number">02</
  );
  assert.match(
    result.html,
    /data-slide-id="workflow-detail"[\s\S]*?data-role="page-number">07 — 09</
  );
});

test("split-slide rejects a partial item mapping without changing the source", () => {
  const html = readFileSync(templatePath, "utf8");
  const incompleteSlide = splitWorkflowSlide.replace(
    /<div class="step" data-item-id="deliver"[\s\S]*?<\/div>\s*<\/div>/,
    "</div>"
  );

  assert.throws(
    () =>
      applyCommands(html, [
        {
          id: "split-workflow",
          command: "split-slide",
          slide: "workflow",
          newSlide: "workflow-detail",
          target: "items",
          moveItemIds: ["review", "deliver"],
          html: incompleteSlide
        }
      ]),
    /must contain exactly the moved items/
  );
  assert.match(html, /data-slide-id="workflow"/);
  assert.match(html, /data-item-id="deliver"/);
  assert.doesNotMatch(html, /data-slide-id="workflow-detail"/);
});

test("a failed command leaves the source value untouched", () => {
  const html = readFileSync(templatePath, "utf8");

  assert.throws(
    () =>
      applyCommands(html, [
        {
          id: "valid-first",
          command: "set-text",
          slide: "metrics",
          target: "title",
          value: "Should not be returned"
        },
        {
          id: "invalid-second",
          command: "set-text",
          slide: "workflow",
          target: "missing-role",
          value: "Invalid"
        }
      ]),
    /missing-role/
  );
  assert.match(html, /让效率提升，有迹可循。/);
});

test("modify-deck applies a multi-slide batch and updates project state", () => {
  const { deck } = createDeck();
  const planPath = path.join(deck, "requested-changes.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Update metrics and workflow",
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
          id: "workflow-remove-review",
          type: "item-count",
          command: "remove-item",
          targets: ["workflow"],
          slide: "workflow",
          target: "items",
          itemId: "review",
          request: "Remove the review step.",
          impact: ["layout", "connector", "numbering"]
        }
      ]
    }),
    "utf8"
  );

  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(scripts, "modify-deck.mjs"),
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

  const html = readFileSync(path.join(deck, "index.html"), "utf8");
  const project = readJson(path.join(deck, "deck-project.json"));
  const storedPlan = readJson(path.join(deck, "change-plan.json"));
  assert.deepEqual(output.affectedSlides, ["metrics", "workflow"]);
  assert.match(html, /增长效果与业务验证/);
  assert.doesNotMatch(html, /data-item-id="review"/);
  assert.equal(project.slides.find((slide) => slide.id === "workflow").itemCount, 3);
  assert.ok(storedPlan.changes.every((change) => change.status === "applied"));
});

test("modify-deck does not write any file when a later command fails", () => {
  const { deck } = createDeck();
  const htmlPath = path.join(deck, "index.html");
  const projectPath = path.join(deck, "deck-project.json");
  const originalHtml = readFileSync(htmlPath, "utf8");
  const originalProject = readFileSync(projectPath, "utf8");
  const planPath = path.join(deck, "invalid-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "One valid and one invalid command",
      changes: [
        {
          id: "valid",
          command: "set-text",
          slide: "metrics",
          target: "title",
          value: "Must roll back"
        },
        {
          id: "invalid",
          command: "set-text",
          slide: "workflow",
          target: "missing-role",
          value: "Invalid"
        }
      ]
    }),
    "utf8"
  );

  const result = spawnSync(
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

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-role/);
  assert.equal(readFileSync(htmlPath, "utf8"), originalHtml);
  assert.equal(readFileSync(projectPath, "utf8"), originalProject);
});

test("modify-deck rolls back a valid split when a later command fails", () => {
  const { deck } = createDeck();
  const htmlPath = path.join(deck, "index.html");
  const projectPath = path.join(deck, "deck-project.json");
  const originalHtml = readFileSync(htmlPath, "utf8");
  const originalProject = readFileSync(projectPath, "utf8");
  const planPath = path.join(deck, "split-rollback-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Split then fail",
      changes: [
        {
          id: "split-workflow",
          command: "split-slide",
          slide: "workflow",
          newSlide: "workflow-detail",
          target: "items",
          moveItemIds: ["review", "deliver"],
          html: splitWorkflowSlide
        },
        {
          id: "invalid-after-split",
          command: "set-text",
          slide: "metrics",
          target: "missing-role",
          value: "Invalid"
        }
      ]
    }),
    "utf8"
  );

  const result = spawnSync(
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

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-role/);
  assert.equal(readFileSync(htmlPath, "utf8"), originalHtml);
  assert.equal(readFileSync(projectPath, "utf8"), originalProject);
});

test("change planner accepts an add-slide command targeting its new stable id", () => {
  const { deck } = createDeck();
  writePassedLayoutDecision(deck, {
    id: "add-summary-layout",
    changeId: "add-summary",
    slide: "summary",
    after: "metrics",
    selectedLayout: "statement",
    styleTreatment: "editorial-manifesto"
  });
  const planPath = path.join(deck, "add-slide-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Add a summary slide",
      changes: [
        {
          id: "add-summary",
          type: "add-slide",
          command: "add-slide",
          targets: ["summary"],
          after: "metrics",
          layoutDecision: "add-summary-layout",
          layoutTreatment: "editorial-manifesto",
          html: `<section class="slide" data-slide-id="summary" data-layout="statement" data-layout-treatment="editorial-manifesto" aria-label="总结">
  <h2 data-role="title">阶段总结</h2>
  <footer class="footer"><span>总结</span><span data-role="page-number">00 — 00</span></footer>
</section>`,
          request: "Add a summary slide.",
          impact: ["slide-count", "navigation"]
        }
      ]
    }),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "plan-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changes[0].command, "add-slide");
});

test("change planner accepts a split-slide targeting source and new stable ids", () => {
  const { deck } = createDeck();
  const planPath = path.join(deck, "split-slide-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Split the workflow slide",
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
    }),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "plan-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).affectedSlides, [
    "workflow",
    "workflow-detail"
  ]);
});

test("version comparison ignores synchronized page numbers after slide deletion", () => {
  const { deck } = createDeck();
  const revised = path.join(path.dirname(deck), "revised");
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      revised
    ],
    { encoding: "utf8" }
  );
  const planPath = path.join(revised, "delete-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Delete comparison",
      changes: [
        {
          id: "delete-comparison",
          type: "delete-slide",
          command: "delete-slide",
          targets: ["comparison"],
          slide: "comparison",
          request: "Delete comparison.",
          impact: ["slide-count", "navigation"]
        }
      ]
    }),
    "utf8"
  );
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "modify-deck.mjs"),
      "--deck",
      revised,
      "--plan",
      planPath,
      "--write"
    ],
    { encoding: "utf8" }
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "compare-versions.mjs"),
      deck,
      revised,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).changed, ["comparison"]);
});

test("version comparison recognizes a planned slide move without flagging shifted neighbors", () => {
  const { deck } = createDeck();
  const revised = path.join(path.dirname(deck), "moved");
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      revised
    ],
    { encoding: "utf8" }
  );
  const planPath = path.join(revised, "move-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Move closing after cover",
      changes: [
        {
          id: "move-closing",
          type: "reorder-slide",
          command: "move-slide",
          targets: ["closing"],
          slide: "closing",
          after: "cover",
          request: "Move closing after cover.",
          impact: ["slide-order", "navigation"]
        }
      ]
    }),
    "utf8"
  );
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "modify-deck.mjs"),
      "--deck",
      revised,
      "--plan",
      planPath,
      "--write"
    ],
    { encoding: "utf8" }
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "compare-versions.mjs"),
      deck,
      revised,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).changed, ["closing"]);
});

test("version comparison recognizes both sides of a planned slide split", () => {
  const { deck } = createDeck();
  const revised = path.join(path.dirname(deck), "split");
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      revised
    ],
    { encoding: "utf8" }
  );
  const planPath = path.join(revised, "split-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
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
          request: "Split workflow.",
          impact: ["slide-count", "navigation"]
        }
      ]
    }),
    "utf8"
  );
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "modify-deck.mjs"),
      "--deck",
      revised,
      "--plan",
      planPath,
      "--write"
    ],
    { encoding: "utf8" }
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "compare-versions.mjs"),
      deck,
      revised,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).changed, [
    "workflow",
    "workflow-detail"
  ]);
});
