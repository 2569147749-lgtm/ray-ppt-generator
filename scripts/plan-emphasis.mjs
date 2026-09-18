#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteTextFiles } from "../lib/atomic-files.mjs";
import { inspectDeck, readProject } from "../lib/deck-model.mjs";
import {
  applyEmphasisReview,
  normalizeEmphasisPlan
} from "../lib/emphasis-plan.mjs";

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
  const planPath = path.join(deckDir, "emphasis-plan.json");
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
          emphasisPlan: {
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
  console.log(`Emphasis plan: ${plan.status.toUpperCase()}`);
  console.log(`Decisions: ${plan.decisions.length}`);
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.deck || !args.plan) {
    console.error(
      "Usage: node scripts/plan-emphasis.mjs --deck /path/to/deck --plan plan.json [--review review.json] [--write] [--json]"
    );
    process.exitCode = 1;
    return;
  }
  const deck = await inspectDeck(args.deck);
  const planPath = path.resolve(args.plan);
  if (!existsSync(planPath)) throw new Error(`Emphasis plan not found: ${planPath}`);
  const [rawPlan, html] = await Promise.all([
    readFile(planPath, "utf8").then(JSON.parse),
    readFile(deck.htmlPath, "utf8")
  ]);
  let plan = normalizeEmphasisPlan({ plan: rawPlan, html });
  if (args.review) {
    const review = JSON.parse(await readFile(path.resolve(args.review), "utf8"));
    plan = applyEmphasisReview(plan, review);
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
