#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteTextFiles } from "../lib/atomic-files.mjs";
import { inspectDeck, readProject } from "../lib/deck-model.mjs";
import {
  applySlideLayoutReview,
  recommendSlideLayout
} from "../lib/slide-layout-plan.mjs";
import { assertTemplateContract } from "../lib/template-contract.mjs";

function readArgs(argv) {
  const result = {
    deck: "",
    plan: "",
    review: "",
    write: false,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--deck") result.deck = argv[++index] ?? "";
    else if (arg === "--plan") result.plan = argv[++index] ?? "";
    else if (arg === "--review") result.review = argv[++index] ?? "";
    else if (arg === "--write") result.write = true;
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function persist(deckDir, plan) {
  const planPath = path.join(deckDir, "slide-layout-plan.json");
  const project = await readProject(deckDir);
  const entries = [
    {
      path: planPath,
      content: `${JSON.stringify(plan, null, 2)}\n`
    }
  ];
  if (project) {
    entries.push({
      path: path.join(deckDir, "deck-project.json"),
      content: `${JSON.stringify(
        {
          ...project,
          updatedAt: plan.updatedAt,
          slideLayoutPlan: {
            status: plan.status,
            path: planPath,
            decisions: plan.decisions.length,
            updatedAt: plan.updatedAt
          }
        },
        null,
        2
      )}\n`
    });
  }
  await atomicWriteTextFiles(entries);
}

function printPlan(plan, json) {
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`Slide layout plan: ${plan.status.toUpperCase()}`);
  for (const decision of plan.decisions) {
    console.log(
      `${decision.id}: ${decision.selectedLayout} / ${decision.styleTreatment} (${decision.confidence})`
    );
  }
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.deck || !args.plan) {
    console.error(
      "Usage: node scripts/plan-slide-layout.mjs --deck /path/to/deck --plan layout-request.json [--review review.json] [--write] [--json]"
    );
    process.exitCode = 1;
    return;
  }
  const deck = await inspectDeck(args.deck);
  const requestPath = path.resolve(args.plan);
  if (!existsSync(requestPath)) {
    throw new Error(`Slide layout request not found: ${requestPath}`);
  }
  const contractPath = path.join(deck.deckDir, "layout-contracts.json");
  if (!existsSync(contractPath)) {
    throw new Error(`Layout contract not found: ${contractPath}`);
  }
  const [request, contract] = await Promise.all([
    readFile(requestPath, "utf8").then(JSON.parse),
    readFile(contractPath, "utf8").then(JSON.parse)
  ]);
  assertTemplateContract(contract);
  if (!Array.isArray(request.decisions)) {
    throw new Error("Slide layout request requires a decisions array.");
  }
  const seen = new Set();
  const decisions = request.decisions.map((decision) => {
    const recommendation = recommendSlideLayout({
      decision,
      contract,
      slides: deck.slides
    });
    if (seen.has(recommendation.id)) {
      throw new Error(`Duplicate slide layout decision id: ${recommendation.id}`);
    }
    seen.add(recommendation.id);
    return recommendation;
  });
  let plan = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    status: "review-required",
    decisions,
    review: null
  };
  if (args.review) {
    const review = JSON.parse(
      await readFile(path.resolve(args.review), "utf8")
    );
    plan = applySlideLayoutReview(plan, review);
  }
  if (args.write) await persist(deck.deckDir, plan);
  printPlan(plan, args.json);
  if (plan.status === "review-required") process.exitCode = 2;
  else if (plan.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
