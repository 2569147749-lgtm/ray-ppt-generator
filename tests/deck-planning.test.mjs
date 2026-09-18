import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyDeckPlanReview,
  buildDeckPlan,
  extractPlannedSlides,
  verifyDeckPlan
} from "../lib/deck-plan.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(
  skillRoot,
  "assets",
  "templates",
  "yellow-editorial"
);
const contract = JSON.parse(
  readFileSync(path.join(templateRoot, "layout-contracts.json"), "utf8")
);
const planScript = path.join(skillRoot, "scripts", "plan-deck.mjs");
const verifyScript = path.join(skillRoot, "scripts", "verify-deck-plan.mjs");
const newDeckScript = path.join(skillRoot, "scripts", "new-deck.mjs");

function slide(overrides = {}) {
  return {
    id: "thesis",
    title: "验证速度决定增长速度",
    purpose: "Establish the core argument.",
    narrativeRole: "argument",
    contentShape: "single-message",
    intent: "key-message",
    signals: ["text"],
    itemCount: 0,
    density: "speaker-led",
    requestedLayout: null,
    source: "inferred",
    evidenceMode: "none",
    sourceClaimIds: [],
    emphasisCandidates: [
      {
        id: "thesis-speed",
        role: "title",
        text: "验证速度",
        category: "core-conclusion",
        rationale: "It is the causal point of the slide.",
        source: "inferred",
        priority: "primary",
        treatments: ["bold"]
      }
    ],
    ...overrides
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    template: "yellow-editorial",
    brief: {
      title: "更快验证，更稳增长",
      topic: "产品验证体系",
      objective: "Explain why validation speed improves investment quality.",
      audience: ["product leaders", "engineering leaders"],
      desiredConclusion: "Adopt a staged validation workflow.",
      density: "balanced",
      constraints: ["Do not invent business outcomes."]
    },
    sources: [
      {
        id: "research-note",
        type: "document",
        title: "Validation cycle study",
        location: "/tmp/validation-study.md",
        claims: [
          {
            id: "cycle-time",
            text: "The pilot reduced validation time from 14 days to 3 days.",
            evidenceType: "source",
            attribution: "Internal pilot report"
          }
        ]
      }
    ],
    narrative: {
      openingPromise: "Turn product uncertainty into a measurable workflow.",
      arc: "Promise, argument, proof, execution, action.",
      sections: [
        { id: "case", purpose: "Frame the argument and proof." },
        { id: "execution", purpose: "Explain the operating workflow." }
      ],
      conclusion: "Validation speed improves investment quality.",
      nextAction: "Run one staged validation pilot."
    },
    slides: [
      slide({
        id: "cover",
        title: "更快验证，更稳增长",
        purpose: "State the opening promise.",
        narrativeRole: "opening",
        contentShape: "single-message",
        intent: "opening",
        evidenceMode: "none",
        emphasisCandidates: []
      }),
      slide(),
      slide({
        id: "evidence",
        title: "周期从 14 天缩短到 3 天",
        purpose: "Support the argument with measured evidence.",
        narrativeRole: "evidence",
        contentShape: "quantitative-evidence",
        intent: "quantitative-comparison",
        signals: ["text", "number", "chart"],
        itemCount: 2,
        density: "balanced",
        evidenceMode: "sourced",
        sourceClaimIds: ["cycle-time"],
        emphasisCandidates: [
          {
            id: "evidence-cycle",
            role: "metric",
            text: "14 天缩短到 3 天",
            category: "key-metric",
            rationale: "It is the measured proof point.",
            source: "inferred",
            priority: "primary",
            treatments: ["enlarge"]
          }
        ]
      }),
      slide({
        id: "workflow",
        title: "四步验证流程",
        purpose: "Show how to execute the recommendation.",
        narrativeRole: "execution",
        contentShape: "sequence",
        intent: "process",
        signals: ["text", "items"],
        itemCount: 4,
        density: "balanced",
        evidenceMode: "none",
        emphasisCandidates: []
      }),
      slide({
        id: "closing",
        title: "从一次试点开始",
        purpose: "Convert the conclusion into one next action.",
        narrativeRole: "closing",
        contentShape: "call-to-action",
        intent: "call-to-action",
        evidenceMode: "none",
        emphasisCandidates: []
      })
    ],
    ...overrides
  };
}

function build(input = request()) {
  return buildDeckPlan({
    request: input,
    contract,
    updatedAt: "2026-09-17T00:00:00.000Z"
  });
}

function passingReview(plan) {
  return {
    reviewer: "deck-planner-reviewer",
    checks: {
      briefFit: "pass",
      evidenceIntegrity: "pass",
      narrativeCoherence: "pass",
      layoutRhythm: "pass"
    },
    notes: "",
    slides: plan.slides.map((item) => ({
      id: item.id,
      checks: {
        requestFit: "pass",
        contentFit: "pass",
        narrativeFit: "pass",
        styleContinuity: "pass"
      },
      notes: ""
    }))
  };
}

test("builds a deterministic reviewed-ready plan and reuses layout selection", () => {
  const plan = build();

  assert.equal(plan.status, "review-required");
  assert.equal(plan.template, "yellow-editorial");
  assert.deepEqual(
    plan.slides.map(({ id, selectedLayout, prototypeSlide }) => ({
      id,
      selectedLayout,
      prototypeSlide
    })),
    [
      { id: "cover", selectedLayout: "cover", prototypeSlide: "cover" },
      {
        id: "thesis",
        selectedLayout: "statement",
        prototypeSlide: "point-of-view"
      },
      { id: "evidence", selectedLayout: "metric", prototypeSlide: "metrics" },
      { id: "workflow", selectedLayout: "process", prototypeSlide: "workflow" },
      { id: "closing", selectedLayout: "closing", prototypeSlide: "closing" }
    ]
  );
  assert.deepEqual(plan.coverage.usedClaimIds, ["cycle-time"]);
  assert.deepEqual(plan.coverage.unusedClaimIds, []);
  assert.deepEqual(plan.findings.blockers, []);
  assert.equal(plan.review, null);
});

test("rejects unresolved claims and quantitative slides without evidence", () => {
  const unknownClaim = request();
  unknownClaim.slides[2].sourceClaimIds = ["missing-claim"];
  assert.throws(() => build(unknownClaim), /unknown source claim "missing-claim"/);

  const unsupportedMetric = request();
  unsupportedMetric.slides[2].evidenceMode = "none";
  unsupportedMetric.slides[2].sourceClaimIds = [];
  assert.throws(
    () => build(unsupportedMetric),
    /quantitative slide "evidence" requires sourced or demonstration evidence/
  );
});

test("requires opening and closing boundaries with unique stable ids", () => {
  const badOpening = request();
  badOpening.slides[0].narrativeRole = "context";
  assert.throws(() => build(badOpening), /first slide must use narrativeRole "opening"/);

  const badClosing = request();
  badClosing.slides.at(-1).intent = "key-message";
  assert.throws(() => build(badClosing), /last slide must use intent "call-to-action"/);

  const duplicate = request();
  duplicate.slides[1].id = "cover";
  assert.throws(() => build(duplicate), /Duplicate deck slide id: cover/);
});

test("bounds inferred emphasis candidates before copy is authored", () => {
  const tooMany = request();
  tooMany.slides[1].emphasisCandidates.push(
    {
      ...tooMany.slides[1].emphasisCandidates[0],
      id: "thesis-second",
      text: "增长速度",
      priority: "secondary"
    },
    {
      ...tooMany.slides[1].emphasisCandidates[0],
      id: "thesis-third",
      text: "决定",
      priority: "secondary"
    }
  );
  assert.throws(() => build(tooMany), /at most two inferred emphasis candidates/);

  const twoPrimary = request();
  twoPrimary.slides[1].emphasisCandidates.push({
    ...twoPrimary.slides[1].emphasisCandidates[0],
    id: "thesis-second-primary",
    text: "增长速度"
  });
  assert.throws(() => build(twoPrimary), /at most one inferred primary emphasis/);
});

test("records unused evidence and rhythm concerns without inventing fixes", () => {
  const input = request();
  input.sources[0].claims.push({
    id: "unused",
    text: "A claim not selected for this narrative.",
    evidenceType: "source",
    attribution: "Appendix"
  });
  input.slides.splice(
    2,
    0,
    slide({
      id: "thesis-two",
      title: "投入质量来自更早决策",
      emphasisCandidates: []
    }),
    slide({
      id: "thesis-three",
      title: "更早决策依赖可验证证据",
      emphasisCandidates: []
    })
  );

  const plan = build(input);
  assert.deepEqual(plan.coverage.unusedClaimIds, ["unused"]);
  assert.ok(
    plan.findings.warnings.some(
      (finding) => finding.code === "unused-source-claim"
    )
  );
  assert.ok(
    plan.findings.warnings.some(
      (finding) => finding.code === "repeated-layout-rhythm"
    )
  );
});

test("deck review requires every global and slide-level check", () => {
  const plan = build();
  const review = passingReview(plan);
  delete review.checks.evidenceIntegrity;
  assert.throws(
    () => applyDeckPlanReview(plan, review),
    /evidenceIntegrity.*pass or fail/
  );

  const missingSlide = passingReview(plan);
  missingSlide.slides.pop();
  assert.throws(
    () => applyDeckPlanReview(plan, missingSlide),
    /missing slides: closing/
  );

  const failed = passingReview(plan);
  failed.checks.layoutRhythm = "fail";
  assert.throws(
    () => applyDeckPlanReview(plan, failed),
    /Failed deck plan review requires notes/
  );
});

test("deck review passes only complete positive evidence", () => {
  const plan = build();
  const reviewed = applyDeckPlanReview(
    plan,
    passingReview(plan),
    "2026-09-17T01:00:00.000Z"
  );

  assert.equal(reviewed.status, "passed");
  assert.equal(reviewed.review.slides.length, reviewed.slides.length);
  assert.equal(reviewed.review.reviewedAt, "2026-09-17T01:00:00.000Z");
});

test("extracts plan evidence from authored HTML and reports objective drift", () => {
  const reviewed = applyDeckPlanReview(build(), passingReview(build()));
  const html = reviewed.slides
    .map(
      (item, index) => `<section class="slide${index === 0 ? " active" : ""}"
  data-slide-id="${item.id}"
  data-layout="${item.selectedLayout}"
  data-layout-treatment="${item.styleTreatment}"
  data-visual-intent="${item.intent}"
  data-evidence-mode="${item.evidenceMode}"
  data-source-claims="${item.sourceClaimIds.join(",")}"
  data-plan-item-count="${item.itemCount}"
  aria-label="${item.title}">
  <h2>${item.title}</h2>
</section>`
    )
    .join("\n");
  const actual = extractPlannedSlides(html);
  const passed = verifyDeckPlan({ plan: reviewed, slides: actual });
  assert.equal(passed.passed, true);
  assert.deepEqual(passed.mismatches, []);

  actual[2].layout = "comparison";
  const failed = verifyDeckPlan({ plan: reviewed, slides: actual });
  assert.equal(failed.passed, false);
  assert.ok(
    failed.mismatches.some(
      (mismatch) =>
        mismatch.slide === "evidence" && mismatch.field === "selectedLayout"
    )
  );

  const missingEvidence = extractPlannedSlides(
    html
      .replace(' data-evidence-mode="sourced"', "")
      .replace(' data-plan-item-count="2"', "")
  );
  const incomplete = verifyDeckPlan({ plan: reviewed, slides: missingEvidence });
  assert.equal(incomplete.passed, false);
  assert.ok(
    incomplete.mismatches.some(
      (mismatch) =>
        mismatch.slide === "evidence" && mismatch.field === "evidenceMode"
    )
  );
  assert.ok(
    incomplete.mismatches.some(
      (mismatch) =>
        mismatch.slide === "evidence" && mismatch.field === "itemCount"
    )
  );
});

test("plan-deck CLI persists review states and verifier checks authored HTML", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-deck-plan-"));
  const requestPath = path.join(root, "request.json");
  const reviewPath = path.join(root, "review.json");
  const planPath = path.join(root, "deck-plan.json");
  writeFileSync(requestPath, JSON.stringify(request()));

  const planned = spawnSync(
    process.execPath,
    [
      planScript,
      "--template",
      "yellow-editorial",
      "--request",
      requestPath,
      "--out",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );
  assert.equal(planned.status, 2, planned.stderr);
  const draft = JSON.parse(readFileSync(planPath, "utf8"));
  writeFileSync(reviewPath, JSON.stringify(passingReview(draft)));

  const reviewed = spawnSync(
    process.execPath,
    [
      planScript,
      "--template",
      "yellow-editorial",
      "--request",
      requestPath,
      "--review",
      reviewPath,
      "--out",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(readFileSync(planPath, "utf8")).status, "passed");

  const output = path.join(root, "deck");
  const created = spawnSync(
    process.execPath,
    [
      newDeckScript,
      "--template",
      "yellow-editorial",
      "--plan",
      planPath,
      "--out",
      output
    ],
    { encoding: "utf8" }
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(existsSync(path.join(output, "deck-plan.json")), true);
  const project = JSON.parse(
    readFileSync(path.join(output, "deck-project.json"), "utf8")
  );
  assert.equal(project.deckPlan.status, "passed");

  const matchingHtml = JSON.parse(readFileSync(planPath, "utf8")).slides
    .map(
      (item, index) => `<section class="slide${index === 0 ? " active" : ""}"
data-slide-id="${item.id}" data-layout="${item.selectedLayout}"
data-layout-treatment="${item.styleTreatment}"
data-visual-intent="${item.intent}"
data-evidence-mode="${item.evidenceMode}"
data-source-claims="${item.sourceClaimIds.join(",")}"
data-plan-item-count="${item.itemCount}"
aria-label="${item.title}"><h2>${item.title}</h2></section>`
    )
    .join("\n");
  writeFileSync(path.join(output, "index.html"), matchingHtml);
  const verified = spawnSync(
    process.execPath,
    [verifyScript, "--deck", output, "--write", "--json"],
    { encoding: "utf8" }
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).passed, true);
});

test("new-deck rejects missing, unreviewed, and mismatched plans", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-deck-plan-gate-"));
  const noPlan = spawnSync(
    process.execPath,
    [
      newDeckScript,
      "--template",
      "yellow-editorial",
      "--out",
      path.join(root, "no-plan")
    ],
    { encoding: "utf8" }
  );
  assert.equal(noPlan.status, 1);
  assert.match(noPlan.stderr, /requires --plan/);

  const draft = build();
  const draftPath = path.join(root, "draft.json");
  writeFileSync(draftPath, JSON.stringify(draft));
  const unreviewed = spawnSync(
    process.execPath,
    [
      newDeckScript,
      "--template",
      "yellow-editorial",
      "--plan",
      draftPath,
      "--out",
      path.join(root, "unreviewed")
    ],
    { encoding: "utf8" }
  );
  assert.equal(unreviewed.status, 1);
  assert.match(unreviewed.stderr, /must have status "passed"/);

  const forged = { ...draft, status: "passed", review: null };
  const forgedPath = path.join(root, "forged.json");
  writeFileSync(forgedPath, JSON.stringify(forged));
  const forgedResult = spawnSync(
    process.execPath,
    [
      newDeckScript,
      "--template",
      "yellow-editorial",
      "--plan",
      forgedPath,
      "--out",
      path.join(root, "forged")
    ],
    { encoding: "utf8" }
  );
  assert.equal(forgedResult.status, 1);
  assert.match(forgedResult.stderr, /complete passing review evidence/);

  const mismatched = applyDeckPlanReview(draft, passingReview(draft));
  mismatched.template = "other-template";
  const mismatchedPath = path.join(root, "mismatched.json");
  writeFileSync(mismatchedPath, JSON.stringify(mismatched));
  const result = spawnSync(
    process.execPath,
    [
      newDeckScript,
      "--template",
      "yellow-editorial",
      "--plan",
      mismatchedPath,
      "--out",
      path.join(root, "mismatched")
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /targets template "other-template"/);
});

test("unplanned scaffold mode remains explicit and mutually exclusive", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-deck-scaffold-"));
  const scaffold = spawnSync(
    process.execPath,
    [
      newDeckScript,
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      path.join(root, "scaffold")
    ],
    { encoding: "utf8" }
  );
  assert.equal(scaffold.status, 0, scaffold.stderr);

  const both = spawnSync(
    process.execPath,
    [
      newDeckScript,
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--plan",
      path.join(root, "missing.json"),
      "--out",
      path.join(root, "both")
    ],
    { encoding: "utf8" }
  );
  assert.equal(both.status, 1);
  assert.match(both.stderr, /mutually exclusive/);
});
