#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteTextFiles } from "../lib/atomic-files.mjs";
import { inspectDeck, readProject } from "../lib/deck-model.mjs";
import {
  applySemanticReview,
  extractSemanticSlides,
  semanticEvidence
} from "../lib/semantic-audit.mjs";

function readArgs(argv) {
  const result = { deck: "", plan: "", report: "", review: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--deck") result.deck = argv[++index] ?? "";
    else if (arg === "--plan") result.plan = argv[++index] ?? "";
    else if (arg === "--report") result.report = argv[++index] ?? "";
    else if (arg === "--review") result.review = argv[++index] ?? "";
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function writeReportAndGate(deckDir, reportPath, report) {
  const project = await readProject(deckDir);
  const entries = [
    {
      path: reportPath,
      content: `${JSON.stringify(report, null, 2)}\n`
    }
  ];
  if (project) {
    entries.push({
      path: path.join(deckDir, "deck-project.json"),
      content: `${JSON.stringify(
        {
          ...project,
          updatedAt: report.updatedAt,
          semanticAudit: {
            status: report.status,
            report: reportPath,
            changes: report.changes.length,
            updatedAt: report.updatedAt
          }
        },
        null,
        2
      )}\n`
    });
  }
  await atomicWriteTextFiles(entries);
}

async function resolveSource(deckDir, revised) {
  const revisionPath = path.join(deckDir, "revision.json");
  if (!existsSync(revisionPath)) return { deckDir, slides: revised };
  const revision = JSON.parse(await readFile(revisionPath, "utf8"));
  if (!revision.source || !existsSync(revision.source)) {
    return { deckDir, slides: revised };
  }
  const source = await inspectDeck(revision.source);
  return { deckDir: source.deckDir, slides: source.slides };
}

async function readSemanticSlides(deck) {
  return extractSemanticSlides(await readFile(deck.htmlPath, "utf8"));
}

async function createReport(args, deck) {
  const planPath = path.resolve(args.plan || path.join(deck.deckDir, "change-plan.json"));
  if (!existsSync(planPath)) {
    throw new Error(`Semantic audit requires a change plan: ${planPath}`);
  }
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (!Array.isArray(plan.changes) || plan.changes.length === 0) {
    throw new Error("Semantic audit requires a non-empty changes array.");
  }

  const sourceDeck = await resolveSource(deck.deckDir, deck.slides);
  const sourceHtmlPath = path.join(sourceDeck.deckDir, "index.html");
  const [sourceSlides, revisedSlides] = await Promise.all([
    extractSemanticSlides(await readFile(sourceHtmlPath, "utf8")),
    readSemanticSlides(deck)
  ]);
  const changes = semanticEvidence({ plan, sourceSlides, revisedSlides });
  const automatedChecks = {
    everyRequestPresent: changes.every((change) => change.request.trim().length > 0),
    allChangesVerified: changes.every(
      (change) => change.verificationStatus === "verified"
    ),
    allTargetsResolved: changes.every(
      (change) =>
        change.targets.length > 0 &&
        change.targets.every(
          (target) =>
            change.before.some((slide) => slide.id === target) ||
            change.after.some((slide) => slide.id === target)
        )
    )
  };
  const automatedPassed = Object.values(automatedChecks).every(Boolean);
  const createdAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    deck: deck.deckDir,
    source: sourceDeck.deckDir,
    plan: planPath,
    createdAt,
    updatedAt: createdAt,
    automatedChecks,
    automatedPassed,
    changes,
    status: automatedPassed ? "review-required" : "failed",
    review: null
  };
  const reportPath = path.join(deck.deckDir, "semantic-audit-report.json");
  await writeReportAndGate(deck.deckDir, reportPath, report);
  return report;
}

async function reviewReport(args, deck) {
  if (!args.report || !args.review) {
    throw new Error("Review mode requires both --report and --review.");
  }
  const reportPath = path.resolve(args.report);
  const [report, review] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile(path.resolve(args.review), "utf8").then(JSON.parse)
  ]);
  if (report.deck !== deck.deckDir) {
    throw new Error(`Semantic report belongs to a different deck: ${report.deck}`);
  }
  if (!report.automatedPassed) {
    throw new Error("Cannot review a semantic audit whose automated checks failed.");
  }
  const reviewed = applySemanticReview(report, review);
  await writeReportAndGate(deck.deckDir, reportPath, reviewed);
  return reviewed;
}

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Semantic audit: ${report.status.toUpperCase()}`);
  console.log(`Changes: ${report.changes.length}`);
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.deck) {
    console.error(
      "Usage: node scripts/semantic-audit.mjs --deck /path/to/deck --plan change-plan.json [--json]\n" +
        "Review: node scripts/semantic-audit.mjs --deck /path/to/deck --report report.json --review review.json [--json]"
    );
    process.exitCode = 1;
    return;
  }
  const deck = await inspectDeck(args.deck);
  const report = args.review
    ? await reviewReport(args, deck)
    : await createReport(args, deck);
  printReport(report, args.json);
  if (report.status === "review-required") process.exitCode = 2;
  else if (report.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
