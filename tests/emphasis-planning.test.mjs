import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyEmphasisReview,
  extractEmphasisTargets,
  normalizeEmphasisPlan
} from "../lib/emphasis-plan.mjs";
import { analyzeSemanticEmphasis } from "../lib/semantic-emphasis.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const planScript = path.join(skillRoot, "scripts", "plan-emphasis.mjs");

const html = `<!doctype html>
<section class="slide active" data-slide-id="thesis" data-layout="statement">
  <div data-role="title" data-edit>增长的关键，不是更多功能，而是更短的验证周期。</div>
  <p data-role="body" data-edit>先验证高风险假设，再扩大投入。</p>
</section>
<section class="slide" data-slide-id="metrics" data-layout="metric">
  <h2 data-role="title" data-edit>验证周期缩短</h2>
  <div data-role="metric" data-edit>从 14 天降至 3 天</div>
</section>`;

function decision(overrides = {}) {
  return {
    id: "thesis-core",
    slide: "thesis",
    role: "title",
    text: "更短的验证周期",
    category: "core-conclusion",
    rationale: "This phrase states the causal conclusion of the slide.",
    source: "inferred",
    priority: "primary",
    treatments: ["bold"],
    ...overrides
  };
}

test("extractEmphasisTargets preserves slide and semantic role text", () => {
  assert.deepEqual(extractEmphasisTargets(html), [
    {
      slide: "thesis",
      role: "title",
      text: "增长的关键，不是更多功能，而是更短的验证周期。"
    },
    {
      slide: "thesis",
      role: "body",
      text: "先验证高风险假设，再扩大投入。"
    },
    {
      slide: "metrics",
      role: "title",
      text: "验证周期缩短"
    },
    {
      slide: "metrics",
      role: "metric",
      text: "从 14 天降至 3 天"
    }
  ]);
});

test("normalization resolves exact text and marks valid plans for review", () => {
  const plan = normalizeEmphasisPlan({
    plan: { decisions: [decision()] },
    html
  });

  assert.equal(plan.status, "review-required");
  assert.equal(plan.decisions.length, 1);
  assert.equal(plan.decisions[0].text, "更短的验证周期");
  assert.deepEqual(plan.decisions[0].treatments, ["bold"]);
  assert.equal(plan.review, null);
});

test("normalization resolves text among repeated elements with the same role", () => {
  const repeatedHtml = `<section class="slide active" data-slide-id="steps">
    <div data-item-id="first"><h3 data-role="item-title" data-edit>发现问题</h3></div>
    <div data-item-id="second"><h3 data-role="item-title" data-edit>验证方案</h3></div>
  </section>`;
  const plan = normalizeEmphasisPlan({
    plan: {
      decisions: [
        decision({
          slide: "steps",
          role: "item-title",
          text: "发现问题",
          category: "user-request",
          source: "user",
          priority: "secondary"
        })
      ]
    },
    html: repeatedHtml
  });
  assert.equal(plan.decisions[0].text, "发现问题");
});

test("user decisions override inferred decisions for the same target", () => {
  const plan = normalizeEmphasisPlan({
    plan: {
      decisions: [
        decision(),
        decision({
          id: "explicit-request",
          source: "user",
          rationale: "The user explicitly requested this emphasis.",
          treatments: ["highlight"]
        })
      ]
    },
    html
  });

  assert.deepEqual(
    plan.decisions.map(({ id, source, treatments }) => ({
      id,
      source,
      treatments
    })),
    [
      {
        id: "explicit-request",
        source: "user",
        treatments: ["highlight"]
      }
    ]
  );
});

test("normalization rejects duplicate ids and unresolved exact text", () => {
  assert.throws(
    () =>
      normalizeEmphasisPlan({
        plan: { decisions: [decision(), decision()] },
        html
      }),
    /Duplicate emphasis decision id: thesis-core/
  );
  assert.throws(
    () =>
      normalizeEmphasisPlan({
        plan: {
          decisions: [decision({ text: "不存在的重点" })]
        },
        html
      }),
    /does not resolve to exact text/
  );
});

test("normalization limits inferred primary decisions and total decisions per slide", () => {
  assert.throws(
    () =>
      normalizeEmphasisPlan({
        plan: {
          decisions: [
            decision(),
            decision({
              id: "second-primary",
              role: "body",
              text: "高风险假设",
              category: "decision-action"
            })
          ]
        },
        html
      }),
    /at most one inferred primary/
  );
  assert.throws(
    () =>
      normalizeEmphasisPlan({
        plan: {
          decisions: [
            decision({ priority: "secondary" }),
            decision({
              id: "second",
              role: "body",
              text: "高风险假设",
              category: "decision-action",
              priority: "secondary"
            }),
            decision({
              id: "third",
              role: "body",
              text: "扩大投入",
              category: "decision-action",
              priority: "secondary"
            })
          ]
        },
        html
      }),
    /at most two inferred decisions/
  );
});

test("normalization limits inferred coverage but not explicit user emphasis", () => {
  const oversized = decision({
    text: "增长的关键，不是更多功能，而是更短的验证周期",
    rationale: "The entire sentence was selected."
  });
  assert.throws(
    () =>
      normalizeEmphasisPlan({
        plan: { decisions: [oversized] },
        html
      }),
    /exceeds the 25% inferred coverage limit/
  );
  assert.doesNotThrow(() =>
    normalizeEmphasisPlan({
      plan: {
        decisions: [
          {
            ...oversized,
            source: "user",
            rationale: "The user explicitly requested the full sentence."
          }
        ]
      },
      html
    })
  );
});

test("normalization rejects unsupported categories and treatments", () => {
  assert.throws(
    () =>
      normalizeEmphasisPlan({
        plan: {
          decisions: [decision({ category: "decorative" })]
        },
        html
      }),
    /Unsupported emphasis category/
  );
  assert.throws(
    () =>
      normalizeEmphasisPlan({
        plan: {
          decisions: [decision({ treatments: ["underline"] })]
        },
        html
      }),
    /Unsupported emphasis treatment/
  );
});

test("semantic review requires relevance, context, and restraint for every decision", () => {
  const report = normalizeEmphasisPlan({
    plan: { decisions: [decision()] },
    html
  });
  assert.throws(
    () =>
      applyEmphasisReview(report, {
        reviewer: "semantic reviewer",
        decisions: [
          {
            id: "thesis-core",
            checks: { relevance: "pass", context: "pass" },
            notes: ""
          }
        ]
      }),
    /check "restraint" must be pass or fail/
  );
});

test("semantic review records failures with notes and passes complete reviews", () => {
  const report = normalizeEmphasisPlan({
    plan: { decisions: [decision()] },
    html
  });
  assert.throws(
    () =>
      applyEmphasisReview(report, {
        reviewer: "semantic reviewer",
        decisions: [
          {
            id: "thesis-core",
            checks: {
              relevance: "fail",
              context: "pass",
              restraint: "pass"
            },
            notes: ""
          }
        ]
      }),
    /requires notes/
  );

  const failed = applyEmphasisReview(report, {
    reviewer: "semantic reviewer",
    decisions: [
      {
        id: "thesis-core",
        checks: {
          relevance: "fail",
          context: "pass",
          restraint: "pass"
        },
        notes: "The phrase is supporting detail, not the conclusion."
      }
    ]
  });
  assert.equal(failed.status, "failed");

  const passed = applyEmphasisReview(report, {
    reviewer: "semantic reviewer",
    decisions: [
      {
        id: "thesis-core",
        checks: {
          relevance: "pass",
          context: "pass",
          restraint: "pass"
        },
        notes: "The phrase is the slide conclusion and is narrowly scoped."
      }
    ]
  });
  assert.equal(passed.status, "passed");
  assert.equal(passed.review.decisions.length, 1);
});

test("plan-emphasis CLI writes normalized and reviewed artifacts transactionally", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-emphasis-plan-test-"));
  const deck = path.join(root, "deck");
  mkdirSync(deck);
  writeFileSync(path.join(deck, "index.html"), html);
  writeFileSync(
    path.join(deck, "deck-project.json"),
    `${JSON.stringify({ schemaVersion: 1, emphasisPlan: { status: "required" } })}\n`
  );
  const input = path.join(root, "input.json");
  writeFileSync(input, `${JSON.stringify({ decisions: [decision()] }, null, 2)}\n`);

  const planned = spawnSync(
    process.execPath,
    [planScript, "--deck", deck, "--plan", input, "--write", "--json"],
    { encoding: "utf8" }
  );
  assert.equal(planned.status, 2, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).status, "review-required");
  const storedPath = path.join(deck, "emphasis-plan.json");
  assert.equal(JSON.parse(readFileSync(storedPath, "utf8")).status, "review-required");

  const reviewPath = path.join(root, "review.json");
  writeFileSync(
    reviewPath,
    `${JSON.stringify(
      {
        reviewer: "semantic reviewer",
        decisions: [
          {
            id: "thesis-core",
            checks: {
              relevance: "pass",
              context: "pass",
              restraint: "pass"
            },
            notes: "The central conclusion is concise and relevant."
          }
        ]
      },
      null,
      2
    )}\n`
  );
  const reviewed = spawnSync(
    process.execPath,
    [
      planScript,
      "--deck",
      deck,
      "--plan",
      storedPath,
      "--review",
      reviewPath,
      "--write",
      "--json"
    ],
    { encoding: "utf8" }
  );
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).status, "passed");
  assert.equal(
    JSON.parse(readFileSync(path.join(deck, "deck-project.json"), "utf8"))
      .emphasisPlan.status,
    "passed"
  );
});

function passedPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "passed",
    decisions: [decision()],
    review: { reviewer: "semantic reviewer", decisions: [] },
    ...overrides
  };
}

function rendered(overrides = {}) {
  return {
    slide: "thesis",
    role: "title",
    id: "thesis-core",
    text: "更短的验证周期",
    treatments: ["bold"],
    selector: '[data-emphasis-id="thesis-core"]',
    ...overrides
  };
}

test("rendered semantic emphasis accepts an exact reviewed plan match", () => {
  const result = analyzeSemanticEmphasis({
    plan: passedPlan(),
    profiles: [{ slide: "thesis", candidates: [rendered()] }]
  });

  assert.equal(result.status, "passed");
  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("rendered semantic emphasis blocks unplanned and stale emphasis", () => {
  const result = analyzeSemanticEmphasis({
    plan: passedPlan(),
    profiles: [
      {
        slide: "thesis",
        candidates: [
          rendered(),
          rendered({
            id: null,
            text: "更多功能",
            selector: "strong:nth-of-type(2)"
          })
        ]
      }
    ]
  });
  assert.equal(result.passed, false);
  assert.ok(
    result.findings.some((finding) => finding.code === "unplanned-emphasis")
  );

  const stale = analyzeSemanticEmphasis({
    plan: passedPlan(),
    profiles: [
      {
        slide: "thesis",
        candidates: [rendered({ text: "更长的验证周期" })]
      }
    ]
  });
  assert.ok(
    stale.findings.some((finding) => finding.code === "stale-emphasis-text")
  );
});

test("rendered semantic emphasis blocks wrong roles and missing treatments", () => {
  const wrongRole = analyzeSemanticEmphasis({
    plan: passedPlan(),
    profiles: [
      {
        slide: "thesis",
        candidates: [rendered({ role: "body" })]
      }
    ]
  });
  assert.ok(
    wrongRole.findings.some((finding) => finding.code === "emphasis-role-mismatch")
  );

  const missingTreatment = analyzeSemanticEmphasis({
    plan: passedPlan({
      decisions: [decision({ treatments: ["bold", "highlight"] })]
    }),
    profiles: [{ slide: "thesis", candidates: [rendered()] }]
  });
  assert.ok(
    missingTreatment.findings.some(
      (finding) => finding.code === "emphasis-treatment-mismatch"
    )
  );
});

test("rendered semantic emphasis blocks plans that have not passed review", () => {
  const result = analyzeSemanticEmphasis({
    plan: passedPlan({ status: "review-required" }),
    profiles: [{ slide: "thesis", candidates: [rendered()] }]
  });
  assert.equal(result.passed, false);
  assert.equal(result.findings[0].code, "emphasis-plan-not-approved");
});

test("legacy decks without an emphasis plan remain compatible", () => {
  const result = analyzeSemanticEmphasis({
    plan: null,
    profiles: [{ slide: "thesis", candidates: [rendered({ id: null })] }]
  });
  assert.equal(result.status, "not-configured");
  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("new decks copy a reviewed emphasis plan with matching stable markers", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-emphasis-template-test-"));
  const deck = path.join(root, "deck");
  const created = spawnSync(
    process.execPath,
    [
      path.join(skillRoot, "scripts", "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      deck
    ],
    { encoding: "utf8" }
  );
  assert.equal(created.status, 0, created.stderr);

  const templateHtml = readFileSync(path.join(deck, "index.html"), "utf8");
  const plan = JSON.parse(
    readFileSync(path.join(deck, "emphasis-plan.json"), "utf8")
  );
  assert.equal(plan.status, "passed");
  assert.ok(plan.review?.reviewer);
  assert.ok(plan.decisions.length > 0);
  for (const item of plan.decisions) {
    assert.match(
      templateHtml,
      new RegExp(`data-emphasis-id=["']${item.id}["']`)
    );
  }
  assert.equal(
    JSON.parse(readFileSync(path.join(deck, "deck-project.json"), "utf8"))
      .emphasisPlan.status,
    "passed"
  );
});

test("deck versioning remaps emphasis plan metadata to the protected copy", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-emphasis-version-test-"));
  const deck = path.join(root, "deck");
  const created = spawnSync(
    process.execPath,
    [
      path.join(skillRoot, "scripts", "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      deck
    ],
    { encoding: "utf8" }
  );
  assert.equal(created.status, 0, created.stderr);
  const versioned = spawnSync(
    process.execPath,
    [
      path.join(skillRoot, "scripts", "version-deck.mjs"),
      deck,
      "--label",
      "emphasis-copy"
    ],
    { encoding: "utf8" }
  );
  assert.equal(versioned.status, 0, versioned.stderr);
  const copy = versioned.stdout.trim().split("\n").at(-1);
  const project = JSON.parse(
    readFileSync(path.join(copy, "deck-project.json"), "utf8")
  );
  assert.equal(project.emphasisPlan.path, path.join(copy, "emphasis-plan.json"));
});
