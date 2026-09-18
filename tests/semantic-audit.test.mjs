import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applySemanticReview,
  extractSemanticSlides
} from "../lib/semantic-audit.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(skillRoot, "scripts");

function createRevision() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-semantic-audit-test-"));
  const source = path.join(root, "deck");
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      source
    ],
    { encoding: "utf8" }
  );
  const output = execFileSync(
    process.execPath,
    [path.join(scripts, "version-deck.mjs"), source, "--label", "semantic-copy"],
    { encoding: "utf8" }
  );
  const revised = output.trim().split("\n").at(-1);
  const planPath = path.join(revised, "change-plan.json");
  writeFileSync(
    planPath,
    `${JSON.stringify(
      {
        summary: "Clarify the metric title",
        changes: [
          {
            id: "metrics-title",
            command: "set-text",
            type: "content",
            targets: ["metrics"],
            slide: "metrics",
            target: "title",
            value: "让效率变化，有据可查。",
            request: "把指标页标题改成强调变化可追踪。",
            status: "pending"
          }
        ]
      },
      null,
      2
    )}\n`
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
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "verify-changes.mjs"),
      "--deck",
      revised,
      "--plan",
      planPath,
      "--write"
    ],
    { encoding: "utf8" }
  );
  return { root, source, revised, planPath };
}

test("semantic extraction retains stable ids, titles, and visible slide text", () => {
  const slides = extractSemanticSlides(`
    <section class="slide active" data-slide-id="metrics" data-layout="metric">
      <h2>效率 <span>变化</span></h2><p>可追踪</p>
    </section>
  `);

  assert.deepEqual(slides, [
    {
      id: "metrics",
      position: 1,
      layout: "metric",
      title: "效率 变化",
      text: "效率 变化 可追踪"
    }
  ]);
});

test("semantic review rejects a checklist that omits a planned change", () => {
  assert.throws(
    () =>
      applySemanticReview(
        {
          changes: [{ id: "first" }, { id: "second" }]
        },
        {
          reviewer: "test",
          changes: [
            {
              id: "first",
              checks: { intent: "pass", context: "pass", facts: "not-applicable" },
              notes: ""
            }
          ]
        }
      ),
    /missing changes: second/
  );
});

test("semantic audit records before and after evidence and requires review", () => {
  const { revised, planPath } = createRevision();
  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "semantic-audit.mjs"),
      "--deck",
      revised,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "review-required");
  assert.equal(report.changes.length, 1);
  assert.match(report.changes[0].before[0].text, /让效率提升，有迹可循/);
  assert.match(report.changes[0].after[0].text, /让效率变化，有据可查/);
  assert.equal(report.changes[0].verificationStatus, "verified");
});

test("semantic review passes only after every change receives all required checks", () => {
  const { root, revised, planPath } = createRevision();
  const capture = spawnSync(
    process.execPath,
    [
      path.join(scripts, "semantic-audit.mjs"),
      "--deck",
      revised,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );
  assert.equal(capture.status, 2, capture.stderr);
  const report = JSON.parse(capture.stdout);
  const reviewPath = path.join(root, "semantic-review.json");
  writeFileSync(
    reviewPath,
    `${JSON.stringify(
      {
        reviewer: "AI semantic review",
        changes: report.changes.map(({ id }) => ({
          id,
          checks: {
            intent: "pass",
            context: "pass",
            facts: "not-applicable"
          },
          notes: "The revised title matches the requested emphasis."
        }))
      },
      null,
      2
    )}\n`
  );

  const reviewed = spawnSync(
    process.execPath,
    [
      path.join(scripts, "semantic-audit.mjs"),
      "--deck",
      revised,
      "--report",
      path.join(revised, "semantic-audit-report.json"),
      "--review",
      reviewPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).status, "passed");
  assert.equal(
    JSON.parse(readFileSync(path.join(revised, "deck-project.json"), "utf8"))
      .semanticAudit.status,
    "passed"
  );
});

test("semantic audit blocks review when objective change verification is incomplete", () => {
  const { revised, planPath } = createRevision();
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.changes[0].status = "applied";
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "semantic-audit.mjs"),
      "--deck",
      revised,
      "--plan",
      planPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, "failed");
});

test("writing another modification invalidates a passed semantic gate", () => {
  const { revised, planPath } = createRevision();
  const projectPath = path.join(revised, "deck-project.json");
  const project = JSON.parse(readFileSync(projectPath, "utf8"));
  writeFileSync(
    projectPath,
    `${JSON.stringify({
      ...project,
      semanticAudit: { status: "passed", report: "/old/semantic-report.json" }
    })}\n`
  );
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.changes[0].value = "让效率变化，持续可查。";
  plan.changes[0].status = "pending";
  delete plan.changes[0].verification;
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

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

  const updated = JSON.parse(readFileSync(projectPath, "utf8"));
  assert.equal(updated.semanticAudit.status, "required");
  assert.equal(updated.semanticAudit.report, null);
});
