#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteTextFiles } from "../lib/atomic-files.mjs";
import { verifyChanges } from "../lib/change-verifier.mjs";
import { resolveDeck } from "../lib/deck-model.mjs";

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

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.deck || !args.plan) {
    console.error(
      "Usage: node scripts/verify-changes.mjs --deck /path/to/deck --plan change-plan.json [--write] [--json]"
    );
    process.exitCode = 1;
    return;
  }

  const { deckDir, htmlPath } = await resolveDeck(args.deck);
  const planPath = path.resolve(args.plan);
  const [html, plan] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(planPath, "utf8").then(JSON.parse)
  ]);
  const verification = verifyChanges(html, plan);

  if (args.write) {
    await atomicWriteTextFiles([
      {
        path: planPath,
        content: `${JSON.stringify(verification.plan, null, 2)}\n`
      },
      {
        path: path.join(deckDir, "verification-report.json"),
        content: `${JSON.stringify(verification.report, null, 2)}\n`
      }
    ]);
  }

  if (args.json) console.log(JSON.stringify(verification.report, null, 2));
  else {
    console.log(`Verification: ${verification.report.passed ? "PASS" : "FAIL"}`);
    console.log(`Verified changes: ${verification.report.verifiedChanges}`);
    if (verification.report.failedChanges.length > 0) {
      console.log(`Failed changes: ${verification.report.failedChanges.join(", ")}`);
    }
  }

  if (!verification.report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
