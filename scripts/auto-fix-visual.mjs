#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFiles } from "../lib/atomic-files.mjs";
import { resolveBrowserExecutable } from "../lib/browser-runtime.mjs";
import { applyCommands } from "../lib/deck-dom.mjs";
import { resolveDeck } from "../lib/deck-model.mjs";
import { runVisualAutoFixLoop } from "../lib/visual-auto-fix.mjs";
import { buildVisualRepairHandoff } from "../lib/visual-repair-handoff.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const visualAuditScript = path.join(scriptDir, "visual-audit.mjs");

function readArgs(argv) {
  const result = {
    deck: "",
    plan: "",
    chrome: "",
    browserCache: "",
    runtimeCache: "",
    allowBrowserDownload: false,
    timeout: 10000,
    maxRounds: 3,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--deck") result.deck = argv[++index] ?? "";
    else if (arg === "--plan") result.plan = argv[++index] ?? "";
    else if (arg === "--chrome") result.chrome = argv[++index] ?? "";
    else if (arg === "--browser-cache") result.browserCache = argv[++index] ?? "";
    else if (arg === "--runtime-cache") result.runtimeCache = argv[++index] ?? "";
    else if (arg === "--allow-browser-install") result.allowBrowserDownload = true;
    else if (arg === "--no-browser-download") result.allowBrowserDownload = false;
    else if (arg === "--timeout") result.timeout = Number(argv[++index] ?? 10000);
    else if (arg === "--max-rounds") {
      result.maxRounds = Number(argv[++index] ?? 3);
    } else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mapPath(value, fromRoot, toRoot) {
  if (!value || !path.isAbsolute(value) || !isInside(fromRoot, value)) return value;
  return path.join(toRoot, path.relative(fromRoot, value));
}

function mapReport(report, stageDeck, finalDeck, stageOutput, finalOutput, autoFix) {
  return {
    ...report,
    deck: finalDeck,
    plan: mapPath(report.plan, stageDeck, finalDeck),
    captures: (report.captures ?? []).map((capture) => ({
      ...capture,
      file: mapPath(capture.file, stageOutput, finalOutput),
      visualDiff: capture.visualDiff
        ? {
            ...capture.visualDiff,
            baselineFile: mapPath(
              capture.visualDiff.baselineFile,
              stageOutput,
              finalOutput
            )
          }
        : capture.visualDiff
    })),
    autoFix
  };
}

async function prepareStage(sourceDeck) {
  const parent = path.dirname(sourceDeck);
  const stageRoot = await mkdtemp(
    path.join(parent, `.${path.basename(sourceDeck)}-visual-fix-`)
  );
  const stageDeck = path.join(stageRoot, path.basename(sourceDeck));
  await cp(sourceDeck, stageDeck, { recursive: true });

  const revisionPath = path.join(stageDeck, "revision.json");
  if (existsSync(revisionPath)) {
    const revision = JSON.parse(await readFile(revisionPath, "utf8"));
    if (revision.source && !path.isAbsolute(revision.source)) {
      revision.source = path.resolve(sourceDeck, revision.source);
      await writeFile(revisionPath, `${JSON.stringify(revision, null, 2)}\n`);
    }
  }
  return { stageRoot, stageDeck };
}

function stagedPlanPath(planPath, sourceDeck, stageDeck) {
  if (!planPath) return "";
  const resolved = path.resolve(planPath);
  return isInside(sourceDeck, resolved)
    ? path.join(stageDeck, path.relative(sourceDeck, resolved))
    : resolved;
}

function runAudit({
  stageDeck,
  outputDir,
  planPath,
  chrome,
  browserRuntime,
  timeout
}) {
  const command = [
    visualAuditScript,
    "--deck",
    stageDeck,
    "--out",
    outputDir,
    "--chrome",
    chrome,
    "--timeout",
    String(timeout),
    "--json"
  ];
  if (planPath) command.push("--plan", planPath);
  const result = spawnSync(process.execPath, command, {
    encoding: "utf8",
    env: {
      ...process.env,
      RAY_PPT_BROWSER_RUNTIME_JSON: JSON.stringify(browserRuntime)
    },
    timeout: Math.max(60000, timeout * 20),
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Visual audit did not return JSON: ${result.stderr.trim() || "unknown error"}`
    );
  }
  if (![0, 1, 2].includes(result.status)) {
    throw new Error(result.stderr.trim() || `Visual audit exited ${result.status}.`);
  }
  return report;
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  await visit(root);
  return files;
}

async function publishSuccess({
  sourceDeck,
  stageDeck,
  stageRoot,
  loopResult,
  roundOutputs
}) {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const finalRoot = path.join(sourceDeck, "visual-audit", `auto-fix-${runId}`);
  const entries = [];
  const publishedRounds = [];

  for (const round of loopResult.rounds) {
    const stageOutput = roundOutputs.get(round.index);
    const finalOutput = path.join(finalRoot, `round-${round.index}`);
    const reportPath = path.join(finalOutput, "visual-audit-report.json");
    const mappedReport = mapReport(
      round.report,
      stageDeck,
      sourceDeck,
      stageOutput,
      finalOutput,
      {
        status: loopResult.status,
        round: round.index,
        repairsApplied: loopResult.repairsApplied
      }
    );
    entries.push({
      path: reportPath,
      content: `${JSON.stringify(mappedReport, null, 2)}\n`
    });
    for (const source of await listFiles(stageOutput)) {
      if (path.basename(source) === "visual-audit-report.json") continue;
      entries.push({
        path: path.join(finalOutput, path.relative(stageOutput, source)),
        source
      });
    }
    publishedRounds.push({
      index: round.index,
      report: reportPath,
      status: mappedReport.status,
      capturePassed: mappedReport.capturePassed,
      plan: round.plan,
      fingerprint: round.fingerprint,
      applied: round.applied,
      ...(round.error ? { error: round.error } : {})
    });
  }

  const finalRound = publishedRounds.at(-1);
  const finalReport = JSON.parse(
    entries.find((entry) => entry.path === finalRound.report).content
  );
  const stageProjectPath = path.join(stageDeck, "deck-project.json");
  if (existsSync(stageProjectPath)) {
    const project = JSON.parse(await readFile(stageProjectPath, "utf8"));
    entries.push({
      path: path.join(sourceDeck, "deck-project.json"),
      content: `${JSON.stringify(
        {
          ...project,
          updatedAt: finalReport.updatedAt,
          visualAudit: {
            status: finalReport.status,
            report: finalRound.report,
            captures: finalReport.captures.length,
            updatedAt: finalReport.updatedAt
          }
        },
        null,
        2
      )}\n`
    });
  }
  entries.push({
    path: path.join(sourceDeck, "index.html"),
    content: await readFile(path.join(stageDeck, "index.html"), "utf8")
  });
  const historyPath = path.join(finalRoot, "visual-auto-fix.json");
  entries.push({
    path: historyPath,
    content: `${JSON.stringify(
      {
        schemaVersion: 1,
        deck: sourceDeck,
        status: loopResult.status,
        stopReason: loopResult.stopReason,
        repairsApplied: loopResult.repairsApplied,
        rounds: publishedRounds
      },
      null,
      2
    )}\n`
  });

  try {
    await Promise.all(
      [...new Set(entries.map((entry) => path.dirname(entry.path)))].map(
        (directory) => mkdir(directory, { recursive: true })
      )
    );
    await atomicWriteFiles(entries);
  } catch (error) {
    await rm(finalRoot, { recursive: true, force: true });
    throw error;
  }
  await rm(stageRoot, { recursive: true, force: true });
  return {
    report: finalRound.report,
    history: historyPath,
    evidenceDir: finalRoot
  };
}

async function publishFailureHandoff({ sourceDeck, stageRoot, loopResult }) {
  const finalReport = [...loopResult.rounds]
    .reverse()
    .find((round) => round.report)?.report;
  if (!finalReport) return null;

  const handoffPath = path.join(stageRoot, "visual-repair-handoff.json");
  const handoff = buildVisualRepairHandoff({
    ...finalReport,
    deck: sourceDeck
  });
  await atomicWriteFiles([
    {
      path: handoffPath,
      content: `${JSON.stringify(handoff, null, 2)}\n`
    }
  ]);
  return handoffPath;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.deck) {
    throw new Error(
      "Usage: node scripts/auto-fix-visual.mjs --deck /path/to/deck [--plan plan.json] [--max-rounds 3] [--chrome path] [--browser-cache path] [--runtime-cache path] [--allow-browser-install] [--json]"
    );
  }
  if (!Number.isInteger(args.maxRounds) || args.maxRounds < 1) {
    throw new Error("--max-rounds must be a positive integer.");
  }
  if (!Number.isFinite(args.timeout) || args.timeout < 1000) {
    throw new Error("--timeout must be at least 1000 milliseconds.");
  }

  const { deckDir } = await resolveDeck(args.deck);
  const browser = await resolveBrowserExecutable({
    explicitPath: args.chrome,
    cacheDir: args.browserCache || undefined,
    runtimeCachePath: args.runtimeCache || undefined,
    allowManagedInstall: args.allowBrowserDownload,
    onStatus: ({ phase, spec }) => {
      if (phase === "download-start") {
        console.error(
          `Preparing Chrome for Testing ${spec.version} (${spec.platform}); this is a one-time download.`
        );
      }
    }
  });
  args.chrome = browser.executablePath;
  const browserRuntime = {
    source: browser.source,
    executablePath: browser.executablePath,
    product: browser.product ?? null,
    version: browser.version ?? browser.spec?.version ?? null,
    cdpTransport: browser.cdpTransport ?? null,
    platform: browser.spec?.platform ?? process.platform,
    discovery: browser.discovery ?? null
  };
  const { stageRoot, stageDeck } = await prepareStage(deckDir);
  const planPath = stagedPlanPath(args.plan, deckDir, stageDeck);
  const roundOutputs = new Map();
  const result = await runVisualAutoFixLoop({
    maxRounds: args.maxRounds,
    audit: async ({ round }) => {
      const outputDir = path.join(
        stageDeck,
        ".visual-auto-fix",
        `round-${round}`
      );
      roundOutputs.set(round, outputDir);
      return runAudit({
        stageDeck,
        outputDir,
        planPath,
        chrome: args.chrome,
        browserRuntime,
        timeout: args.timeout
      });
    },
    apply: async (commands) => {
      const htmlPath = path.join(stageDeck, "index.html");
      const sourceHtml = await readFile(htmlPath, "utf8");
      const changed = applyCommands(sourceHtml, commands);
      await atomicWriteFiles([{ path: htmlPath, content: changed.html }]);
    }
  });

  let publication = null;
  if (["clean", "repaired"].includes(result.status)) {
    publication = await publishSuccess({
      sourceDeck: deckDir,
      stageDeck,
      stageRoot,
      loopResult: result,
      roundOutputs
    });
  }
  const handoff = publication
    ? null
    : await publishFailureHandoff({
        sourceDeck: deckDir,
        stageRoot,
        loopResult: result
      });
  const output = {
    deck: deckDir,
    status: result.status,
    stopReason: result.stopReason,
    repairsApplied: result.repairsApplied,
    rounds: result.rounds.length,
    stagingDir: stageRoot,
    handoff,
    ...publication
  };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`Visual auto-fix: ${output.status.toUpperCase()}`);
    console.log(`Repairs applied: ${output.repairsApplied}`);
    console.log(
      publication
        ? `Review report: ${publication.report}`
        : `Failure evidence retained at: ${stageRoot}`
    );
  }
  if (!publication) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
