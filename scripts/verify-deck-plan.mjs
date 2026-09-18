#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteTextFiles } from "../lib/atomic-files.mjs";
import {
  extractPlannedSlides,
  verifyDeckPlan
} from "../lib/deck-plan.mjs";
import { readProject, resolveDeck } from "../lib/deck-model.mjs";

function readArgs(argv) {
  const result = { deck: "", plan: "", write: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--deck") result.deck = argv[++index] ?? "";
    else if (arg === "--plan") result.plan = argv[++index] ?? "";
    else if (arg === "--write") result.write = true;
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function persist(deckDir, report) {
  const reportPath = path.join(deckDir, "deck-plan-verification.json");
  const entries = [
    {
      path: reportPath,
      content: `${JSON.stringify(report, null, 2)}\n`
    }
  ];
  const project = await readProject(deckDir);
  if (project) {
    entries.push({
      path: path.join(deckDir, "deck-project.json"),
      content: `${JSON.stringify(
        {
          ...project,
          updatedAt: report.checkedAt,
          deckPlanVerification: {
            status: report.passed ? "passed" : "failed",
            path: reportPath,
            mismatches: report.mismatches.length,
            updatedAt: report.checkedAt
          }
        },
        null,
        2
      )}\n`
    });
  }
  await atomicWriteTextFiles(entries);
}

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Deck plan verification: ${report.passed ? "PASSED" : "FAILED"}`);
  for (const mismatch of report.mismatches) {
    console.log(
      `${mismatch.slide ?? "deck"} ${mismatch.field}: expected ${JSON.stringify(mismatch.expected)}, got ${JSON.stringify(mismatch.actual)}`
    );
  }
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.deck) {
    console.error(
      "Usage: node scripts/verify-deck-plan.mjs --deck /path/to/deck [--plan /path/deck-plan.json] [--write] [--json]"
    );
    process.exitCode = 1;
    return;
  }
  const { deckDir, htmlPath } = await resolveDeck(args.deck);
  const planPath = args.plan
    ? path.resolve(args.plan)
    : path.join(deckDir, "deck-plan.json");
  if (!existsSync(planPath)) {
    throw new Error(`Deck plan not found: ${planPath}`);
  }
  const [plan, html] = await Promise.all([
    readFile(planPath, "utf8").then(JSON.parse),
    readFile(htmlPath, "utf8")
  ]);
  const report = verifyDeckPlan({
    plan,
    slides: extractPlannedSlides(html)
  });
  if (args.write) await persist(deckDir, report);
  printReport(report, args.json);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
