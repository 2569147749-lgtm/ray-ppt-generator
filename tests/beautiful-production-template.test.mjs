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
  applyEmphasisReview,
  normalizeEmphasisPlan
} from "../lib/emphasis-plan.mjs";
import { assertTemplateContract } from "../lib/template-contract.mjs";
import { inspectHtml } from "../lib/deck-model.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatesRoot = path.join(skillRoot, "assets", "templates");
const beautifulLibraryRoot = path.resolve(
  skillRoot,
  "..",
  "beautiful-html-templates",
  "library"
);
const planScript = path.join(skillRoot, "scripts", "plan-deck.mjs");
const newDeckScript = path.join(skillRoot, "scripts", "new-deck.mjs");
const validateScript = path.join(skillRoot, "scripts", "validate-deck.mjs");
const beautifulIndexPath = path.join(beautifulLibraryRoot, "index.json");
const productionLayouts = [
  "cover",
  "statement",
  "agenda",
  "metric",
  "comparison",
  "process",
  "decision-matrix",
  "closing"
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function visibleMarkup(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ");
}

function productionTemplate(id) {
  const index = readJson(path.join(templatesRoot, "index.json"));
  return index.templates.find((entry) => entry.id === id);
}

function productionTemplates() {
  return readJson(path.join(templatesRoot, "index.json")).templates;
}

function beautifulTemplates() {
  return readJson(beautifulIndexPath).templates;
}

function sourceTemplateDir(slug) {
  return path.join(beautifulLibraryRoot, "templates", slug);
}

function sourceRuntimeFiles(slug) {
  const templateDir = sourceTemplateDir(slug);
  return existsSync(path.join(templateDir, "deck-stage.js")) ? ["deck-stage.js"] : [];
}

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
    density: "dense",
    requestedLayout: null,
    source: "inferred",
    evidenceMode: "none",
    sourceClaimIds: [],
    emphasisCandidates: [],
    ...overrides
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    template: "neo-grid-bold",
    brief: {
      title: "更快验证，更稳增长",
      topic: "产品验证体系",
      objective: "Explain why validation speed improves investment quality.",
      audience: ["product leaders", "engineering leaders"],
      desiredConclusion: "Adopt a staged validation workflow.",
      density: "dense",
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
        density: "speaker-led"
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
        density: "dense",
        evidenceMode: "sourced",
        sourceClaimIds: ["cycle-time"]
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
        density: "dense"
      }),
      slide({
        id: "closing",
        title: "从一次试点开始",
        purpose: "Convert the conclusion into one next action.",
        narrativeRole: "closing",
        contentShape: "call-to-action",
        intent: "call-to-action",
        density: "speaker-led"
      })
    ],
    ...overrides
  };
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

test("registers every beautiful template as a contract-ready production template", () => {
  const expectedSlugs = beautifulTemplates().map((template) => template.slug).sort();
  const registeredSlugs = productionTemplates()
    .filter((template) => template.source === "beautiful-html-templates")
    .map((template) => template.id)
    .sort();
  assert.deepEqual(registeredSlugs, expectedSlugs);

  for (const sourceTemplate of beautifulTemplates()) {
    const template = productionTemplate(sourceTemplate.slug);
    assert.ok(template, `${sourceTemplate.slug} must be registered`);
    assert.equal(template.source, "beautiful-html-templates");
    assert.equal(template.template, "template.html");
    assert.equal(template.design, "design.md");
    assert.equal(template.contracts, "layout-contracts.json");
    assert.equal(template.emphasisPlan, "emphasis-plan.json");
    assert.deepEqual(template.runtimeFiles ?? [], sourceRuntimeFiles(sourceTemplate.slug));
    assert.deepEqual(template.layouts, productionLayouts);

    const templateDir = path.join(templatesRoot, template.path);
    for (const file of [
      template.template,
      template.design,
      template.contracts,
      template.emphasisPlan,
      ...(template.runtimeFiles ?? [])
    ]) {
      assert.equal(
        existsSync(path.join(templateDir, file)),
        true,
        `${template.id}/${file} must exist`
      );
    }

    const html = readFileSync(path.join(templateDir, template.template), "utf8");
    assert.doesNotMatch(html, /MIT License/);
    assert.doesNotMatch(html, /Copyright \(c\) 2026 Zara Zhang/);
    assert.doesNotMatch(
      visibleMarkup(html),
      /MIT License|Copyright \(c\)|&copy;|©|All rights reserved/i,
      `${template.id} must not render third-party legal boilerplate`
    );

    const contract = readJson(path.join(templateDir, template.contracts));
    assert.doesNotThrow(() => assertTemplateContract(contract));
    assert.equal(contract.template, sourceTemplate.slug);
    assert.deepEqual(Object.keys(contract.layouts), productionLayouts);
    assert.ok(contract.layoutSelection.templateSlideIds.length > 0);
    assert.equal(
      inspectHtml(html).length,
      contract.layoutSelection.templateSlideIds.length,
      `${template.id} must expose all prototype slides to deck inspection`
    );

    const rawEmphasisPlan = readJson(path.join(templateDir, template.emphasisPlan));
    const normalized = normalizeEmphasisPlan({
      plan: rawEmphasisPlan,
      html,
      updatedAt: rawEmphasisPlan.updatedAt
    });
    const reviewed = applyEmphasisReview(
      normalized,
      rawEmphasisPlan.review,
      rawEmphasisPlan.review?.reviewedAt
    );
    assert.equal(reviewed.status, "passed");
  }
});

test("plans and initializes every beautiful template through the production CLIs", () => {
  for (const sourceTemplate of beautifulTemplates()) {
    const root = mkdtempSync(path.join(os.tmpdir(), `ppt-${sourceTemplate.slug}-production-`));
    const requestPath = path.join(root, "request.json");
    const reviewPath = path.join(root, "review.json");
    const planPath = path.join(root, "deck-plan.json");
    const outputDir = path.join(root, "deck");
    writeFileSync(
      requestPath,
      `${JSON.stringify(request({ template: sourceTemplate.slug }), null, 2)}\n`
    );

    const planned = spawnSync(
      process.execPath,
      [
        planScript,
        "--template",
        sourceTemplate.slug,
        "--request",
        requestPath,
        "--out",
        planPath,
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(planned.status, 2, `${sourceTemplate.slug}: ${planned.stderr}`);
    const draft = readJson(planPath);
    assert.equal(draft.template, sourceTemplate.slug);
    assert.deepEqual(
      draft.slides.map(({ id, selectedLayout }) => ({ id, selectedLayout })),
      [
        { id: "cover", selectedLayout: "cover" },
        { id: "thesis", selectedLayout: "statement" },
        { id: "evidence", selectedLayout: "metric" },
        { id: "workflow", selectedLayout: "process" },
        { id: "closing", selectedLayout: "closing" }
      ],
      `${sourceTemplate.slug}: expected standard production layout mapping`
    );

    writeFileSync(reviewPath, `${JSON.stringify(passingReview(draft), null, 2)}\n`);
    const reviewed = spawnSync(
      process.execPath,
      [
        planScript,
        "--template",
        sourceTemplate.slug,
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
    assert.equal(reviewed.status, 0, `${sourceTemplate.slug}: ${reviewed.stderr}`);

    const created = spawnSync(
      process.execPath,
      [
        newDeckScript,
        "--template",
        sourceTemplate.slug,
        "--plan",
        planPath,
        "--out",
        outputDir
      ],
      { encoding: "utf8" }
    );
    assert.equal(created.status, 0, `${sourceTemplate.slug}: ${created.stderr}`);
    for (const file of [
      "index.html",
      "template-design.md",
      "layout-contracts.json",
      "emphasis-plan.json",
      "deck-plan.json",
      "deck-project.json",
      ...sourceRuntimeFiles(sourceTemplate.slug)
    ]) {
      assert.equal(
        existsSync(path.join(outputDir, file)),
        true,
        `${sourceTemplate.slug}/${file} must be created`
      );
    }

    const html = readFileSync(path.join(outputDir, "index.html"), "utf8");
    assert.doesNotMatch(html, /MIT License/);
    assert.doesNotMatch(html, /Copyright \(c\) 2026 Zara Zhang/);

    const project = readJson(path.join(outputDir, "deck-project.json"));
    assert.equal(project.template, sourceTemplate.slug);
    assert.ok(project.slides.length > 0, `${sourceTemplate.slug} must inspect slides`);
    assert.equal(project.emphasisPlan.status, "passed");
    assert.equal(project.deckPlan.status, "passed");

    const validated = spawnSync(
      process.execPath,
      [validateScript, path.join(outputDir, "index.html")],
      { encoding: "utf8" }
    );
    assert.equal(validated.status, 0, `${sourceTemplate.slug}: ${validated.stderr}`);
  }
});
