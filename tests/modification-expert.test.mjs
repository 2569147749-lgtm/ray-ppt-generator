import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(skillRoot, "scripts");
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

function createDeck(name = "product-deck") {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-modifier-test-"));
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

test("template exposes stable slide ids and layout types", () => {
  const html = readFileSync(templatePath, "utf8");
  const ids = [...html.matchAll(/\bdata-slide-id=["']([^"']+)["']/g)].map(
    (match) => match[1]
  );
  const layouts = [...html.matchAll(/\bdata-layout=["']([^"']+)["']/g)].map(
    (match) => match[1]
  );

  assert.equal(ids.length, 8);
  assert.equal(new Set(ids).size, 8);
  assert.deepEqual(layouts, [
    "cover",
    "statement",
    "agenda",
    "metric",
    "comparison",
    "process",
    "decision-matrix",
    "closing"
  ]);
});

test("layout contracts declare structural limits and coupled adjustments", () => {
  const contracts = readJson(contractsPath);
  assert.equal(contracts.schemaVersion, 1);
  assert.equal(contracts.layouts.process.itemClass, "step");
  assert.ok(contracts.layouts.process.minItems <= 3);
  assert.ok(contracts.layouts.process.maxItems >= 4);
  assert.ok(contracts.layouts.process.coupled.includes("connector"));
  assert.ok(contracts.layouts.agenda.coupled.includes("numbering"));
});

test("new deck creates a project state with an inspectable slide map", () => {
  const { deck } = createDeck();
  const state = readJson(path.join(deck, "deck-project.json"));

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.template, "yellow-editorial");
  assert.equal(state.currentVersion, 0);
  assert.equal(state.slides.length, 8);
  assert.deepEqual(
    state.slides.map((slide) => slide.id),
    [
      "cover",
      "point-of-view",
      "framework",
      "metrics",
      "comparison",
      "workflow",
      "decision-matrix",
      "closing"
    ]
  );

  const inspected = JSON.parse(
    execFileSync(process.execPath, [path.join(scripts, "inspect-deck.mjs"), deck, "--json"], {
      encoding: "utf8"
    })
  );
  assert.equal(inspected.slides[5].layout, "process");
  assert.equal(inspected.slides[5].itemCount, 4);
  assert.equal(readJson(path.join(deck, "layout-contracts.json")).schemaVersion, 1);
});

test("a single change plan can validate and store changes for different slides", () => {
  const { deck } = createDeck();
  const planPath = path.join(deck, "requested-changes.json");
  writeFileSync(
    planPath,
    `${JSON.stringify(
      {
        summary: "Shorten the process and update the metric explanation",
        changes: [
          {
            id: "change-workflow",
            type: "item-count",
            targets: ["workflow"],
            request: "Change four workflow nodes to three.",
            impact: ["layout", "connector", "numbering"]
          },
          {
            id: "change-metric-copy",
            type: "content",
            targets: ["metrics"],
            request: "Replace the metric explanation.",
            impact: ["copy", "text-fit"]
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const output = execFileSync(
    process.execPath,
    [
      path.join(scripts, "plan-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--write",
      "--json"
    ],
    { encoding: "utf8" }
  );
  const normalized = JSON.parse(output);

  assert.equal(normalized.changes.length, 2);
  assert.deepEqual(normalized.affectedSlides, ["metrics", "workflow"]);
  assert.equal(readJson(path.join(deck, "change-plan.json")).changes.length, 2);
});

test("change plan normalizes a scoped typography authorization", () => {
  const { deck } = createDeck();
  const planPath = path.join(deck, "font-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Change the metrics title font",
      changes: [
        {
          id: "metrics-title-font",
          type: "style",
          command: "custom-edit",
          targets: ["metrics"],
          request: "Change the title font to Inter.",
          impact: ["typography"],
          typographyAuthorization: {
            role: "title",
            properties: ["fontFamily", "fontFamily"],
            fontFamily: "Inter"
          }
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
  assert.deepEqual(
    JSON.parse(result.stdout).changes[0].typographyAuthorization,
    {
      role: "title",
      properties: ["fontFamily"],
      fontFamily: "Inter"
    }
  );
});

test("change plan rejects incomplete typography authorization", () => {
  const { deck } = createDeck();
  const planPath = path.join(deck, "invalid-font-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Invalid font edit",
      changes: [
        {
          id: "invalid-font",
          type: "style",
          command: "custom-edit",
          targets: ["metrics"],
          request: "Change the title typography.",
          impact: ["typography"],
          typographyAuthorization: {
            role: "title",
            properties: ["fontWeight"]
          }
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

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Change invalid-font typographyAuthorization requires fontWeight/
  );
});

test("change plan rejects an unknown target without dropping the other changes", () => {
  const { deck } = createDeck();
  const planPath = path.join(deck, "invalid-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Two edits",
      changes: [
        {
          id: "known",
          type: "content",
          targets: ["metrics"],
          request: "Update copy.",
          impact: ["copy"]
        },
        {
          id: "unknown",
          type: "content",
          targets: ["missing-slide"],
          request: "Update another page.",
          impact: ["copy"]
        }
      ]
    }),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [path.join(scripts, "plan-changes.mjs"), "--deck", deck, "--plan", planPath],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Change unknown targets unknown slide "missing-slide"/);
});

test("validator enforces layout contract item limits", () => {
  const { deck } = createDeck();
  const htmlPath = path.join(deck, "index.html");
  const html = readFileSync(htmlPath, "utf8").replace(
    '<div class="step" data-item-id="collect">',
    '<div class="step"><div class="step"><div class="step"><div class="step" data-item-id="collect">'
  );
  writeFileSync(htmlPath, html, "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(scripts, "validate-deck.mjs"), htmlPath],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /process item count 7 exceeds maximum 6/);
});

test("versioning updates project state and records its source", () => {
  const { deck } = createDeck();
  const output = execFileSync(
    process.execPath,
    [path.join(scripts, "version-deck.mjs"), deck, "--label", "batch-update"],
    { encoding: "utf8" }
  );
  const versionPath = output.trim().split("\n").at(-1);
  const state = readJson(path.join(versionPath, "deck-project.json"));

  assert.equal(state.currentVersion, 1);
  assert.equal(state.history.at(-1).label, "batch-update");
  assert.equal(state.history.at(-1).source, deck);
});

test("comparison allows all planned slide changes and rejects unrelated changes", () => {
  const { deck } = createDeck();
  const versionOutput = execFileSync(
    process.execPath,
    [path.join(scripts, "version-deck.mjs"), deck, "--label", "two-page-change"],
    { encoding: "utf8" }
  );
  const revised = versionOutput.trim().split("\n").at(-1);
  const plan = {
    summary: "Edit workflow and metrics",
    changes: [
      {
        id: "workflow-copy",
        type: "content",
        targets: ["workflow"],
        request: "Update workflow copy.",
        impact: ["copy"]
      },
      {
        id: "metric-copy",
        type: "content",
        targets: ["metrics"],
        request: "Update metric copy.",
        impact: ["copy"]
      }
    ]
  };
  const planPath = path.join(revised, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan), "utf8");

  let html = readFileSync(path.join(revised, "index.html"), "utf8");
  html = html
    .replace("让机器提速，让人把关。", "三步形成可靠交付。")
    .replace("让效率提升，有迹可循。", "让效果变化，有迹可循。");
  writeFileSync(path.join(revised, "index.html"), html, "utf8");

  const valid = spawnSync(
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
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout).changed.sort(), ["metrics", "workflow"]);

  html = html.replace("把好想法，推进三步。", "这是一处计划外修改。");
  writeFileSync(path.join(revised, "index.html"), html, "utf8");

  const invalid = spawnSync(
    process.execPath,
    [
      path.join(scripts, "compare-versions.mjs"),
      deck,
      revised,
      "--plan",
      planPath
    ],
    { encoding: "utf8" }
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unexpected changed slides: framework/);
});

test("restore creates a new version from an older protected version", () => {
  const { deck } = createDeck();
  const firstOutput = execFileSync(
    process.execPath,
    [path.join(scripts, "version-deck.mjs"), deck, "--label", "first-change"],
    { encoding: "utf8" }
  );
  const firstVersion = firstOutput.trim().split("\n").at(-1);

  const restoreOutput = execFileSync(
    process.execPath,
    [path.join(scripts, "restore-version.mjs"), firstVersion],
    { encoding: "utf8" }
  );
  const restored = restoreOutput.trim().split("\n").at(-1);

  assert.match(restored, /product-deck-v002-restored$/);
  const state = readJson(path.join(restored, "deck-project.json"));
  assert.equal(state.currentVersion, 2);
  assert.equal(state.history.at(-1).restoredFrom, firstVersion);
});
