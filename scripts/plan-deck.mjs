#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteTextFiles } from "../lib/atomic-files.mjs";
import {
  applyDeckPlanReview,
  buildDeckPlan
} from "../lib/deck-plan.mjs";
import { assertTemplateContract } from "../lib/template-contract.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const templatesRoot = path.join(skillRoot, "assets", "templates");

function readArgs(argv) {
  const result = {
    template: "",
    request: "",
    review: "",
    out: "",
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--template") result.template = argv[++index] ?? "";
    else if (arg === "--request") result.request = argv[++index] ?? "";
    else if (arg === "--review") result.review = argv[++index] ?? "";
    else if (arg === "--out") result.out = argv[++index] ?? "";
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function resolveTemplate(templateId) {
  const index = JSON.parse(
    await readFile(path.join(templatesRoot, "index.json"), "utf8")
  );
  const template = index.templates.find((item) => item.id === templateId);
  if (!template) {
    throw new Error(`Unknown template "${templateId}".`);
  }
  if (!template.contracts) {
    throw new Error(`Template "${templateId}" has no layout contract.`);
  }
  const contract = JSON.parse(
    await readFile(
      path.join(templatesRoot, template.path, template.contracts),
      "utf8"
    )
  );
  assertTemplateContract(contract);
  return contract;
}

function printPlan(plan, json) {
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`Deck plan: ${plan.status.toUpperCase()}`);
  for (const slide of plan.slides) {
    console.log(
      `${slide.id}: ${slide.selectedLayout} / ${slide.styleTreatment} (${slide.confidence})`
    );
  }
  for (const finding of plan.findings.warnings) {
    console.log(`WARN ${finding.code}: ${finding.message}`);
  }
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.template || !args.request || !args.out) {
    console.error(
      "Usage: node scripts/plan-deck.mjs --template TEMPLATE --request /path/request.json --out /path/deck-plan.json [--review /path/review.json] [--json]"
    );
    process.exitCode = 1;
    return;
  }
  const requestPath = path.resolve(args.request);
  if (!existsSync(requestPath)) {
    throw new Error(`Deck plan request not found: ${requestPath}`);
  }
  const [request, contract] = await Promise.all([
    readFile(requestPath, "utf8").then(JSON.parse),
    resolveTemplate(args.template)
  ]);
  if (request.template !== args.template) {
    throw new Error(
      `Deck request targets template "${request.template ?? ""}", not "${args.template}".`
    );
  }
  let plan = buildDeckPlan({ request, contract });
  if (args.review) {
    const reviewPath = path.resolve(args.review);
    if (!existsSync(reviewPath)) {
      throw new Error(`Deck plan review not found: ${reviewPath}`);
    }
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    plan = applyDeckPlanReview(plan, review);
  }
  await atomicWriteTextFiles([
    {
      path: path.resolve(args.out),
      content: `${JSON.stringify(plan, null, 2)}\n`
    }
  ]);
  printPlan(plan, args.json);
  if (plan.status === "review-required") process.exitCode = 2;
  else if (plan.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
