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
import {
  applySlideLayoutReview,
  recommendSlideLayout
} from "../lib/slide-layout-plan.mjs";
import { validateTemplateContract } from "../lib/template-contract.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(
  skillRoot,
  "assets",
  "templates",
  "yellow-editorial",
  "layout-contracts.json"
);
const planScript = path.join(skillRoot, "scripts", "plan-slide-layout.mjs");

function yellowContract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

function errorPaths(contract) {
  return validateTemplateContract(contract).errors.map((error) => error.path);
}

test("layout selection profiles cover every registered layout", () => {
  const contract = yellowContract();
  const result = validateTemplateContract(contract);

  assert.equal(result.valid, true);
  assert.deepEqual(
    Object.keys(contract.layoutSelection.layouts).sort(),
    Object.keys(contract.layouts).sort()
  );
});

test("layout selection rejects missing and unknown layout profiles", () => {
  const missing = yellowContract();
  delete missing.layoutSelection.layouts.metric;
  assert.ok(
    errorPaths(missing).includes("layoutSelection.layouts.metric")
  );

  const unknown = yellowContract();
  unknown.layoutSelection.layouts.unknown = {
    ...unknown.layoutSelection.layouts.statement
  };
  assert.ok(
    errorPaths(unknown).includes("layoutSelection.layouts.unknown")
  );
});

test("layout selection validates semantic profile fields", () => {
  const contract = yellowContract();
  contract.layoutSelection.layouts.comparison.contentShapes = [];
  contract.layoutSelection.layouts.process.narrativeRoles = [];
  contract.layoutSelection.layouts.metric.density = "packed";
  contract.layoutSelection.layouts.agenda.styleTreatment = "";
  contract.layoutSelection.layouts.closing.prototypeSlide = "";

  const paths = errorPaths(contract);
  assert.ok(
    paths.includes("layoutSelection.layouts.comparison.contentShapes")
  );
  assert.ok(
    paths.includes("layoutSelection.layouts.process.narrativeRoles")
  );
  assert.ok(paths.includes("layoutSelection.layouts.metric.density"));
  assert.ok(
    paths.includes("layoutSelection.layouts.agenda.styleTreatment")
  );
  assert.ok(
    paths.includes("layoutSelection.layouts.closing.prototypeSlide")
  );
});

test("layout selection validates preferred ranges and prototype slide IDs", () => {
  const outsideLayoutCapacity = yellowContract();
  outsideLayoutCapacity.layoutSelection.layouts.comparison.preferredItems = {
    min: 1,
    max: 4
  };
  assert.ok(
    errorPaths(outsideLayoutCapacity).includes(
      "layoutSelection.layouts.comparison.preferredItems"
    )
  );

  const reversed = yellowContract();
  reversed.layoutSelection.layouts.process.preferredItems = {
    min: 4,
    max: 2
  };
  assert.ok(
    errorPaths(reversed).includes(
      "layoutSelection.layouts.process.preferredItems"
    )
  );

  const unknownPrototype = yellowContract();
  unknownPrototype.layoutSelection.layouts.metric.prototypeSlide =
    "missing-slide";
  assert.ok(
    errorPaths(unknownPrototype).includes(
      "layoutSelection.layouts.metric.prototypeSlide"
    )
  );
});

function decision(overrides = {}) {
  return {
    id: "add-results-layout",
    changeId: "add-results",
    slide: "results",
    request: "Add a results slide.",
    after: "workflow",
    narrativeRole: "evidence",
    contentShape: "quantitative-evidence",
    intent: "quantitative-comparison",
    signals: ["text", "number", "chart"],
    itemCount: 2,
    density: "balanced",
    requestedLayout: null,
    source: "inferred",
    ...overrides
  };
}

const slides = [
  { id: "comparison", layout: "comparison" },
  { id: "workflow", layout: "process" },
  { id: "decision-matrix", layout: "decision-matrix" }
];

test("layout recommender selects layouts for common content structures", () => {
  const contract = yellowContract();
  const cases = [
    [decision(), "metric"],
    [
      decision({
        narrativeRole: "execution",
        contentShape: "sequence",
        intent: "process",
        signals: ["text", "items"],
        itemCount: 4
      }),
      "process"
    ],
    [
      decision({
        contentShape: "parallel-comparison",
        intent: "categorical-comparison",
        signals: ["text", "items"],
        itemCount: 2
      }),
      "comparison"
    ],
    [
      decision({
        narrativeRole: "argument",
        contentShape: "single-message",
        intent: "key-message",
        signals: ["text"],
        itemCount: 0,
        density: "speaker-led"
      }),
      "statement"
    ]
  ];

  for (const [input, expected] of cases) {
    const result = recommendSlideLayout({
      decision: input,
      contract,
      slides
    });
    assert.equal(result.selectedLayout, expected);
    assert.equal(
      result.styleTreatment,
      contract.layoutSelection.layouts[expected].styleTreatment
    );
    assert.equal(
      result.prototypeSlide,
      contract.layoutSelection.layouts[expected].prototypeSlide
    );
  }
});

test("compatible explicit user layout takes priority", () => {
  const contract = yellowContract();
  contract.layoutSelection.layouts.metric.contentShapes.push(
    "parallel-comparison"
  );
  contract.semanticVisualQuality.layoutRules.metric.allowedIntents.push(
    "categorical-comparison"
  );
  contract.semanticVisualQuality.layoutRules.metric.requiredSignals = [
    "text",
    "items"
  ];
  const result = recommendSlideLayout({
    decision: decision({
      contentShape: "parallel-comparison",
      intent: "categorical-comparison",
      signals: ["text", "items"],
      requestedLayout: "metric",
      source: "user"
    }),
    contract,
    slides
  });

  assert.equal(result.selectedLayout, "metric");
  assert.ok(result.candidates[0].reasons.includes("user-requested-layout"));
});

test("layout recommender records structural rejection evidence", () => {
  const result = recommendSlideLayout({
    decision: decision({
      requestedLayout: "comparison",
      source: "user"
    }),
    contract: yellowContract(),
    slides
  });
  const rejected = result.rejections.find(
    (item) => item.layout === "comparison"
  );

  assert.equal(result.selectedLayout, "metric");
  assert.ok(rejected.reasons.includes("content-shape-incompatible"));
  assert.ok(rejected.reasons.includes("intent-incompatible"));
  assert.ok(rejected.reasons.includes("required-signals-missing:items"));
});

test("layout recommender rejects decisions with no compatible capacity", () => {
  assert.throws(
    () =>
      recommendSlideLayout({
        decision: decision({ itemCount: 8 }),
        contract: yellowContract(),
        slides
      }),
    /No compatible layout.*item-capacity/
  );
});

test("adjacent repetition penalty resolves an otherwise tied recommendation", () => {
  const contract = yellowContract();
  for (const layout of ["statement", "closing"]) {
    contract.layoutSelection.layouts[layout].narrativeRoles = ["summary"];
    contract.layoutSelection.layouts[layout].contentShapes = ["single-message"];
    contract.layoutSelection.layouts[layout].density = "speaker-led";
    contract.semanticVisualQuality.layoutRules[layout].allowedIntents = [
      "key-message"
    ];
    contract.semanticVisualQuality.layoutRules[layout].requiredSignals = ["text"];
  }
  const result = recommendSlideLayout({
    decision: decision({
      after: "point",
      narrativeRole: "summary",
      contentShape: "single-message",
      intent: "key-message",
      signals: ["text"],
      itemCount: 0,
      density: "speaker-led"
    }),
    contract,
    slides: [
      { id: "point", layout: "statement" },
      { id: "next", layout: "agenda" }
    ]
  });

  assert.equal(result.selectedLayout, "closing");
  assert.ok(
    result.candidates.find((item) => item.layout === "statement").reasons
      .includes("adjacent-layout-repeat:-2")
  );
});

test("layout candidates are stable and expose bounded confidence", () => {
  const contract = yellowContract();
  contract.layoutSelection.layouts.comparison.contentShapes.push(
    "quantitative-evidence"
  );
  contract.semanticVisualQuality.layoutRules.comparison.allowedIntents.push(
    "quantitative-comparison"
  );
  contract.semanticVisualQuality.layoutRules.comparison.requiredSignals = [
    "text",
    "number",
    "chart"
  ];
  const first = recommendSlideLayout({
    decision: decision(),
    contract,
    slides
  });
  const second = recommendSlideLayout({
    decision: decision(),
    contract,
    slides
  });

  assert.deepEqual(first.candidates, second.candidates);
  assert.ok(["high", "medium", "low"].includes(first.confidence));
  assert.equal(first.status, "review-required");
  assert.equal(typeof first.scoreGap, "number");
});

function recommendation() {
  return recommendSlideLayout({
    decision: decision(),
    contract: yellowContract(),
    slides
  });
}

function passingReview(overrides = {}) {
  return {
    reviewer: "layout-reviewer",
    decisions: [
      {
        id: "add-results-layout",
        checks: {
          requestFit: "pass",
          contentFit: "pass",
          narrativeFit: "pass",
          styleContinuity: "pass"
        },
        notes: "",
        ...overrides
      }
    ]
  };
}

test("slide layout review requires all semantic checks", () => {
  const plan = {
    schemaVersion: 1,
    status: "review-required",
    decisions: [recommendation()],
    review: null
  };
  const review = passingReview();
  delete review.decisions[0].checks.narrativeFit;

  assert.throws(
    () => applySlideLayoutReview(plan, review),
    /narrativeFit.*pass or fail/
  );
});

test("slide layout review validates decision coverage and failed notes", () => {
  const plan = {
    schemaVersion: 1,
    status: "review-required",
    decisions: [recommendation()],
    review: null
  };
  assert.throws(
    () =>
      applySlideLayoutReview(plan, {
        reviewer: "layout-reviewer",
        decisions: []
      }),
    /missing decisions/
  );
  assert.throws(
    () =>
      applySlideLayoutReview(
        plan,
        passingReview({
          checks: {
            requestFit: "fail",
            contentFit: "pass",
            narrativeFit: "pass",
            styleContinuity: "pass"
          }
        })
      ),
    /requires notes/
  );
});

test("slide layout review persists passed and failed evidence", () => {
  const plan = {
    schemaVersion: 1,
    status: "review-required",
    decisions: [recommendation()],
    review: null
  };
  const passed = applySlideLayoutReview(
    plan,
    passingReview(),
    "2026-09-17T00:00:00.000Z"
  );
  assert.equal(passed.status, "passed");
  assert.equal(passed.review.decisions.length, 1);

  const failed = applySlideLayoutReview(
    plan,
    passingReview({
      checks: {
        requestFit: "pass",
        contentFit: "pass",
        narrativeFit: "pass",
        styleContinuity: "fail"
      },
      notes: "Treatment does not continue the deck rhythm."
    }),
    "2026-09-17T00:00:00.000Z"
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.review.decisions[0].checks.styleContinuity, "fail");
});

test("plan-slide-layout CLI writes recommendations and project gate", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-layout-plan-"));
  const templateDir = path.dirname(contractPath);
  writeFileSync(
    path.join(root, "index.html"),
    readFileSync(path.join(templateDir, "template.html"))
  );
  writeFileSync(path.join(root, "layout-contracts.json"), readFileSync(contractPath));
  writeFileSync(
    path.join(root, "deck-project.json"),
    JSON.stringify({ schemaVersion: 1, template: "yellow-editorial" })
  );
  const requestPath = path.join(root, "layout-request.json");
  writeFileSync(
    requestPath,
    JSON.stringify({
      decisions: [
        decision({
          contentShape: "parallel-comparison",
          intent: "categorical-comparison",
          signals: ["text", "items"],
          itemCount: 2
        })
      ]
    })
  );

  const planned = spawnSync(
    process.execPath,
    [planScript, "--deck", root, "--plan", requestPath, "--write", "--json"],
    { encoding: "utf8" }
  );
  assert.equal(planned.status, 2, planned.stderr);
  const artifact = JSON.parse(
    readFileSync(path.join(root, "slide-layout-plan.json"), "utf8")
  );
  assert.equal(artifact.status, "review-required");
  assert.equal(artifact.decisions[0].selectedLayout, "comparison");

  const reviewPath = path.join(root, "layout-review.json");
  writeFileSync(reviewPath, JSON.stringify(passingReview()));
  const reviewed = spawnSync(
    process.execPath,
    [
      planScript,
      "--deck",
      root,
      "--plan",
      requestPath,
      "--review",
      reviewPath,
      "--write",
      "--json"
    ],
    { encoding: "utf8" }
  );
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const project = JSON.parse(
    readFileSync(path.join(root, "deck-project.json"), "utf8")
  );
  assert.equal(project.slideLayoutPlan.status, "passed");
  assert.equal(project.slideLayoutPlan.decisions, 1);
});

function createPlannedDeck() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "ppt-layout-gate-"));
  const root = path.join(parent, "deck");
  execFileSync(
    process.execPath,
    [
      path.join(skillRoot, "scripts", "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      root
    ],
    { encoding: "utf8" }
  );
  const requestPath = path.join(root, "layout-request.json");
  writeFileSync(
    requestPath,
    JSON.stringify({
      decisions: [
        decision({
          changeId: "add-results",
          slide: "results",
          after: "metrics",
          contentShape: "parallel-comparison",
          intent: "categorical-comparison",
          signals: ["text", "items"],
          itemCount: 2
        })
      ]
    })
  );
  const reviewPath = path.join(root, "layout-review.json");
  writeFileSync(reviewPath, JSON.stringify(passingReview()));
  execFileSync(
    process.execPath,
    [
      planScript,
      "--deck",
      root,
      "--plan",
      requestPath,
      "--review",
      reviewPath,
      "--write"
    ],
    { encoding: "utf8" }
  );
  return root;
}

function addSlideChange(overrides = {}) {
  return {
    id: "add-results",
    type: "add-slide",
    command: "add-slide",
    targets: ["results"],
    after: "metrics",
    layoutDecision: "add-results-layout",
    layoutTreatment: "asymmetric-contrast",
    html: `<section class="slide" data-slide-id="results" data-layout="comparison" data-layout-treatment="asymmetric-contrast" aria-label="结果对比">
  <h2 data-role="title">结果对比</h2>
  <footer class="footer"><span>结果</span><span data-role="page-number">00 — 00</span></footer>
</section>`,
    request: "Add a results comparison slide.",
    impact: ["slide-count", "navigation"],
    ...overrides
  };
}

function runChangePlanner(deck, change) {
  const planPath = path.join(deck, `change-${Date.now()}.json`);
  writeFileSync(
    planPath,
    JSON.stringify({ summary: "Add results", changes: [change] })
  );
  return spawnSync(
    process.execPath,
    [
      path.join(skillRoot, "scripts", "plan-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );
}

test("add-slide requires a passed matching layout decision", () => {
  const deck = createPlannedDeck();
  const valid = runChangePlanner(deck, addSlideChange());
  assert.equal(valid.status, 0, valid.stderr);

  const missingDecision = runChangePlanner(
    deck,
    addSlideChange({ layoutDecision: "" })
  );
  assert.equal(missingDecision.status, 1);
  assert.match(missingDecision.stderr, /requires layoutDecision/);

  const wrongAnchor = runChangePlanner(
    deck,
    addSlideChange({ after: "workflow" })
  );
  assert.equal(wrongAnchor.status, 1);
  assert.match(wrongAnchor.stderr, /insertion anchor/);

  const wrongLayout = runChangePlanner(
    deck,
    addSlideChange({
      html: addSlideChange().html.replace(
        'data-layout="comparison"',
        'data-layout="statement"'
      )
    })
  );
  assert.equal(wrongLayout.status, 1);
  assert.match(wrongLayout.stderr, /reviewed layout/);

  const wrongTreatment = runChangePlanner(
    deck,
    addSlideChange({
      layoutTreatment: "editorial-manifesto"
    })
  );
  assert.equal(wrongTreatment.status, 1);
  assert.match(wrongTreatment.stderr, /reviewed treatment/);
});

test("add-slide rejects an unreviewed layout plan while split-slide stays exempt", () => {
  const deck = createPlannedDeck();
  const artifactPath = path.join(deck, "slide-layout-plan.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  artifact.status = "review-required";
  writeFileSync(artifactPath, JSON.stringify(artifact));

  const blocked = runChangePlanner(deck, addSlideChange());
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /has not passed review/);

  const split = runChangePlanner(deck, {
    id: "split-workflow",
    type: "split-slide",
    command: "split-slide",
    targets: ["workflow", "workflow-detail"],
    slide: "workflow",
    newSlide: "workflow-detail",
    target: "items",
    moveItemIds: ["review"],
    html: `<section class="slide" data-slide-id="workflow-detail" data-layout="process" aria-label="流程续页">
  <h2 data-role="title">流程续页</h2>
  <div data-role="items"><div class="step" data-item-id="review"></div></div>
  <footer><span data-role="page-number">00 — 00</span></footer>
</section>`,
    request: "Split workflow.",
    impact: ["slide-count"]
  });
  assert.equal(split.status, 0, split.stderr);
});
