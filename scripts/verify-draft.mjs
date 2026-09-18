#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteTextFiles } from "../lib/atomic-files.mjs";
import { resolveDeck } from "../lib/deck-model.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function readArgs(argv) {
  const result = {
    deck: "",
    deckPlan: "",
    changePlan: "",
    write: false,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--deck") result.deck = argv[++index] ?? "";
    else if (arg === "--deck-plan") result.deckPlan = argv[++index] ?? "";
    else if (arg === "--change-plan") result.changePlan = argv[++index] ?? "";
    else if (arg === "--write") result.write = true;
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024
  });
  return {
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

function parseJsonStep(step) {
  if (step.status !== "passed") return step;
  try {
    return { ...step, output: JSON.parse(step.stdout) };
  } catch {
    return step;
  }
}

function compactStep(step) {
  const compacted = {
    status: step.status
  };
  if (step.exitCode !== undefined) compacted.exitCode = step.exitCode;
  if (step.stderr) compacted.error = step.stderr;
  return compacted;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.deck) {
    console.error(
      "Usage: node scripts/verify-draft.mjs --deck /path/to/deck [--deck-plan deck-plan.json] [--change-plan change-plan.json] [--write] [--json]"
    );
    process.exitCode = 1;
    return;
  }

  const { deckDir, htmlPath } = await resolveDeck(args.deck);
  const checkedAt = new Date().toISOString();
  const inspect = parseJsonStep(
    runNode(path.join(scriptDir, "inspect-deck.mjs"), [
      deckDir,
      ...(args.write ? ["--write"] : []),
      "--json"
    ])
  );
  const staticValidation = runNode(path.join(scriptDir, "validate-deck.mjs"), [
    htmlPath
  ]);

  const deckPlanPath = args.deckPlan
    ? path.resolve(args.deckPlan)
    : path.join(deckDir, "deck-plan.json");
  const deckPlan = existsSync(deckPlanPath)
    ? parseJsonStep(
        runNode(path.join(scriptDir, "verify-deck-plan.mjs"), [
          "--deck",
          deckDir,
          "--plan",
          deckPlanPath,
          ...(args.write ? ["--write"] : []),
          "--json"
        ])
      )
    : { status: "skipped", reason: "deck-plan.json not found" };

  const changePlanPath = args.changePlan
    ? path.resolve(args.changePlan)
    : path.join(deckDir, "change-plan.json");
  const changeVerification = existsSync(changePlanPath)
    ? parseJsonStep(
        runNode(path.join(scriptDir, "verify-changes.mjs"), [
          "--deck",
          deckDir,
          "--plan",
          changePlanPath,
          ...(args.write ? ["--write"] : []),
          "--json"
        ])
      )
    : { status: "skipped", reason: "change-plan.json not found" };

  const steps = {
    inspect: {
      ...compactStep(inspect),
      slideCount: inspect.output?.slides?.length ?? null
    },
    staticValidation: compactStep(staticValidation),
    deckPlan: deckPlan.status === "skipped" ? deckPlan : compactStep(deckPlan),
    changeVerification:
      changeVerification.status === "skipped"
        ? changeVerification
        : compactStep(changeVerification)
  };
  const failedSteps = Object.entries(steps)
    .filter(([, step]) => step.status === "failed")
    .map(([name]) => name);
  const report = {
    schemaVersion: 1,
    deck: deckDir,
    checkedAt,
    status: failedSteps.length === 0 ? "passed" : "failed",
    failedSteps,
    steps
  };

  if (args.write) {
    await atomicWriteTextFiles([
      {
        path: path.join(deckDir, "draft-verification.json"),
        content: `${JSON.stringify(report, null, 2)}\n`
      }
    ]);
  }

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Draft verification: ${report.status.toUpperCase()}`);
    for (const [name, step] of Object.entries(report.steps)) {
      console.log(`${name}: ${step.status}`);
    }
  }
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
