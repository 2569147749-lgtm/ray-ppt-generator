#!/usr/bin/env node

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, inspectHtml, writeProject } from "../lib/deck-model.mjs";
import {
  chooseImageLayout,
  inspectImageDimensions
} from "../lib/image-layout.mjs";
import {
  applyEmphasisReview,
  normalizeEmphasisPlan
} from "../lib/emphasis-plan.mjs";
import { assertTemplateContract } from "../lib/template-contract.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const templatesRoot = path.join(skillRoot, "assets", "templates");
const indexPath = path.join(templatesRoot, "index.json");
const DECK_REVIEW_CHECKS = [
  "briefFit",
  "evidenceIntegrity",
  "narrativeCoherence",
  "layoutRhythm"
];
const SLIDE_REVIEW_CHECKS = [
  "requestFit",
  "contentFit",
  "narrativeFit",
  "styleContinuity"
];

function readArgs(argv) {
  const result = {
    list: false,
    template: "",
    out: "",
    images: "",
    plan: "",
    unplannedScaffold: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      result.list = true;
    } else if (arg === "--template") {
      result.template = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--out") {
      result.out = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--images") {
      result.images = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--plan") {
      result.plan = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--unplanned-scaffold") {
      result.unplannedScaffold = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

function printUsage() {
  console.log(`Usage:
  node scripts/new-deck.mjs --list
  node scripts/new-deck.mjs --template yellow-editorial --plan /absolute/deck-plan.json --out /absolute/output/path [--images /absolute/images.json]
  node scripts/new-deck.mjs --template yellow-editorial --unplanned-scaffold --out /absolute/output/path`);
}

async function readPassedDeckPlan(planPath, templateId, outputDir) {
  if (!planPath) {
    throw new Error(
      "Deliverable deck initialization requires --plan. Use --unplanned-scaffold only for template maintenance or internal tests."
    );
  }
  const resolved = path.resolve(planPath);
  const relative = path.relative(outputDir, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Deck plan must exist outside the not-yet-created output path.");
  }
  if (!existsSync(resolved)) throw new Error(`Deck plan not found: ${resolved}`);
  const plan = JSON.parse(await readFile(resolved, "utf8"));
  if (plan.status !== "passed") {
    throw new Error('Deck plan must have status "passed" before initialization.');
  }
  if (plan.template !== templateId) {
    throw new Error(
      `Deck plan targets template "${plan.template ?? ""}", not "${templateId}".`
    );
  }
  if (!Array.isArray(plan.slides) || plan.slides.length < 2) {
    throw new Error("Passed deck plan must contain at least two slides.");
  }
  const ids = plan.slides.map((slide) => String(slide.id ?? "").trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("Passed deck plan must contain unique non-empty slide ids.");
  }
  const reviewedSlides = new Map(
    (plan.review?.slides ?? []).map((slide) => [slide.id, slide])
  );
  const completeDeckReview =
    String(plan.review?.reviewer ?? "").trim() &&
    DECK_REVIEW_CHECKS.every(
      (name) => plan.review?.checks?.[name] === "pass"
    );
  const completeSlideReview = ids.every((id) => {
    const reviewed = reviewedSlides.get(id);
    return SLIDE_REVIEW_CHECKS.every(
      (name) => reviewed?.checks?.[name] === "pass"
    );
  });
  const completeSlideContracts = plan.slides.every(
    (slide) =>
      String(slide.selectedLayout ?? "").trim() &&
      String(slide.styleTreatment ?? "").trim() &&
      String(slide.prototypeSlide ?? "").trim()
  );
  if (
    !completeDeckReview ||
    !completeSlideReview ||
    !completeSlideContracts ||
    (plan.findings?.blockers ?? []).length > 0
  ) {
    throw new Error(
      "Passed deck plan requires complete passing review evidence and resolved blockers."
    );
  }
  return { path: resolved, plan };
}

async function prepareInitialImages(manifestPath) {
  if (!manifestPath) return [];
  const manifest = JSON.parse(await readFile(path.resolve(manifestPath), "utf8"));
  if (!Array.isArray(manifest.images) || manifest.images.length === 0) {
    throw new Error("Initial image manifest must contain a non-empty images array.");
  }
  const allowedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
  const names = new Set();
  const images = [];
  for (const image of manifest.images) {
    if (!path.isAbsolute(image.source ?? "")) {
      throw new Error("Every initial image source must be an absolute local path.");
    }
    const source = path.resolve(image.source);
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) throw new Error(`Initial image does not exist: ${source}`);
    const extension = path.extname(source).toLowerCase();
    if (!allowedExtensions.has(extension)) {
      throw new Error(`Unsupported initial image type "${extension || "none"}".`);
    }
    const assetName = String(image.assetName ?? path.basename(source)).trim();
    if (!assetName || path.basename(assetName) !== assetName) {
      throw new Error(`Invalid initial image assetName "${assetName}".`);
    }
    if (names.has(assetName)) {
      throw new Error(`Duplicate initial image assetName "${assetName}".`);
    }
    names.add(assetName);
    if (path.extname(assetName).toLowerCase() !== extension) {
      throw new Error(`Initial image "${assetName}" must keep its source extension.`);
    }
    if (!String(image.alt ?? "").trim()) {
      throw new Error(`Initial image "${assetName}" requires non-empty alt text.`);
    }
    const fit = image.fit ?? "contain";
    if (!["contain", "cover"].includes(fit)) {
      throw new Error(`Initial image "${assetName}" fit must be "contain" or "cover".`);
    }
    const dimensions = inspectImageDimensions(await readFile(source), extension);
    const layout = chooseImageLayout(dimensions.width, dimensions.height);
    images.push({
      source,
      assetName,
      src: `assets/${assetName}`,
      alt: image.alt.trim(),
      purpose: String(image.purpose ?? "").trim(),
      width: layout.width,
      height: layout.height,
      aspectRatio: layout.aspectRatio,
      layout: layout.layout,
      fit
    });
  }
  return images;
}

function templateRuntimeFiles(template) {
  if (!Array.isArray(template.runtimeFiles)) return [];
  const files = template.runtimeFiles.map((file) => String(file ?? "").trim());
  for (const file of files) {
    if (!file || path.basename(file) !== file) {
      throw new Error(`Invalid template runtime file "${file}".`);
    }
  }
  return [...new Set(files)];
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const index = JSON.parse(await readFile(indexPath, "utf8"));

  if (args.list) {
    for (const template of index.templates) {
      console.log(`${template.id}\t${template.name}\t${template.bestFor.join(", ")}`);
    }
    return;
  }

  if (!args.template || !args.out) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (args.plan && args.unplannedScaffold) {
    throw new Error("--plan and --unplanned-scaffold are mutually exclusive.");
  }

  const template = index.templates.find((entry) => entry.id === args.template);
  if (!template) {
    throw new Error(`Unknown template "${args.template}". Run with --list.`);
  }

  const outputDir = path.resolve(args.out);
  if (existsSync(outputDir)) {
    throw new Error(`Output path already exists: ${outputDir}`);
  }
  const deckPlan = args.unplannedScaffold
    ? null
    : await readPassedDeckPlan(args.plan, template.id, outputDir);
  const initialImages = await prepareInitialImages(args.images);

  const templateDir = path.join(templatesRoot, template.path);
  const templateHtml = await readFile(path.join(templateDir, template.template), "utf8");
  const templateContract = template.contracts
    ? await readFile(path.join(templateDir, template.contracts), "utf8")
    : null;
  if (templateContract) assertTemplateContract(JSON.parse(templateContract));
  const templateEmphasisPlan = template.emphasisPlan
    ? await readFile(path.join(templateDir, template.emphasisPlan), "utf8")
    : null;
  let reviewedEmphasisPlan = null;
  if (templateEmphasisPlan) {
    const rawPlan = JSON.parse(templateEmphasisPlan);
    const normalized = normalizeEmphasisPlan({
      plan: rawPlan,
      html: templateHtml,
      updatedAt: rawPlan.updatedAt
    });
    reviewedEmphasisPlan = applyEmphasisReview(
      normalized,
      rawPlan.review,
      rawPlan.review?.reviewedAt
    );
    if (reviewedEmphasisPlan.status !== "passed") {
      throw new Error(`Template "${template.id}" emphasis plan has not passed review.`);
    }
  }
  await mkdir(path.join(outputDir, "assets"), { recursive: true });
  await writeFile(path.join(outputDir, "index.html"), templateHtml, "utf8");
  await copyFile(path.join(templateDir, template.design), path.join(outputDir, "template-design.md"));
  for (const runtimeFile of templateRuntimeFiles(template)) {
    await copyFile(
      path.join(templateDir, runtimeFile),
      path.join(outputDir, runtimeFile)
    );
  }
  if (template.contracts) {
    await writeFile(
      path.join(outputDir, "layout-contracts.json"),
      templateContract,
      "utf8"
    );
  }
  if (reviewedEmphasisPlan) {
    await writeFile(
      path.join(outputDir, "emphasis-plan.json"),
      `${JSON.stringify(reviewedEmphasisPlan, null, 2)}\n`,
      "utf8"
    );
  }
  if (deckPlan) {
    await copyFile(deckPlan.path, path.join(outputDir, "deck-plan.json"));
  }
  const createdAt = new Date().toISOString();
  for (const image of initialImages) {
    await copyFile(image.source, path.join(outputDir, "assets", image.assetName));
  }
  if (initialImages.length > 0) {
    await writeFile(
      path.join(outputDir, "image-manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          createdAt,
          images: initialImages
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
  await writeFile(
    path.join(outputDir, "deck.json"),
    `${JSON.stringify(
      {
        template: template.id,
        createdAt,
        entry: "index.html",
        assets: "assets",
        deckPlan: deckPlan ? "deck-plan.json" : null,
        mode: deckPlan ? "planned" : "unplanned-scaffold"
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const project = createProject({
      template: template.id,
      slides: inspectHtml(templateHtml),
      createdAt
    });
  if (reviewedEmphasisPlan) {
    project.emphasisPlan = {
      status: "passed",
      path: path.join(outputDir, "emphasis-plan.json"),
      decisions: reviewedEmphasisPlan.decisions.length,
      updatedAt: reviewedEmphasisPlan.updatedAt
    };
  }
  if (deckPlan) {
    project.deckPlan = {
      status: "passed",
      path: path.join(outputDir, "deck-plan.json"),
      slides: deckPlan.plan.slides.length,
      updatedAt: deckPlan.plan.updatedAt
    };
  } else {
    project.deckPlan = {
      status: "not-required",
      reason: "unplanned-scaffold",
      updatedAt: createdAt
    };
  }
  await writeProject(outputDir, project);

  console.log(`Created deck from ${template.id}: ${outputDir}`);
  console.log(`Edit: ${path.join(outputDir, "index.html")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
