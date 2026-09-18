#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteTextFiles } from "../lib/atomic-files.mjs";
import { resolveBrowserExecutable } from "../lib/browser-runtime.mjs";
import { resolveDeck } from "../lib/deck-model.mjs";
import {
  nextVisualRuntimeAction,
  recordVisualAuditSkip,
  validateVisualRuntimeDecision
} from "../lib/visual-runtime-decision.mjs";

function readArgs(argv) {
  const result = {
    chrome: "",
    browserCache: "",
    runtimeCache: "",
    decision: "",
    deck: "",
    out: "",
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--chrome") result.chrome = argv[++index] ?? "";
    else if (arg === "--browser-cache") result.browserCache = argv[++index] ?? "";
    else if (arg === "--runtime-cache") result.runtimeCache = argv[++index] ?? "";
    else if (arg === "--decision") result.decision = argv[++index] ?? "";
    else if (arg === "--deck") result.deck = argv[++index] ?? "";
    else if (arg === "--out") result.out = argv[++index] ?? "";
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function publicBrowser(browser) {
  return {
    source: browser.source,
    executablePath: browser.executablePath,
    argsPrefix: browser.argsPrefix ?? [],
    product: browser.product ?? null,
    version: browser.version ?? browser.spec?.version ?? null,
    platform: browser.spec?.platform ?? process.platform,
    discovery: browser.discovery ?? null
  };
}

async function writeOutput(output, outputPath) {
  if (!outputPath) return;
  await atomicWriteTextFiles([
    {
      path: path.resolve(outputPath),
      content: `${JSON.stringify(output, null, 2)}\n`
    }
  ]);
}

async function resolveLocal(args, allowManagedInstall = false) {
  try {
    const browser = await resolveBrowserExecutable({
      explicitPath: args.chrome,
      cacheDir: args.browserCache || undefined,
      runtimeCachePath: args.runtimeCache || undefined,
      allowManagedInstall,
      onStatus: ({ phase, spec }) => {
        if (phase === "download-start") {
          console.error(
            `Preparing Chrome for Testing ${spec.version} (${spec.platform}); this is a consented one-time download.`
          );
        }
      }
    });
    return {
      status: "available",
      browser: publicBrowser(browser),
      coverage: browser.discovery?.coverage ?? "explicit",
      candidates: browser.discovery?.candidates ?? [],
      attempts: browser.discovery?.attempts ?? []
    };
  } catch (error) {
    if (
      ![
        "VISUAL_RUNTIME_UNAVAILABLE",
        "VISUAL_RUNTIME_DISCOVERY_INCOMPLETE"
      ].includes(error.code)
    ) {
      throw error;
    }
    return {
      ...(error.discovery ?? {
        status: "unknown",
        coverage: "unknown",
        candidates: [],
        attempts: []
      }),
      resolutionError: {
        code: error.code,
        message: error.message
      }
    };
  }
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  let suppliedDecision = null;
  let decisionPath = null;
  if (args.decision) {
    decisionPath = path.resolve(args.decision);
    if (!existsSync(decisionPath)) {
      throw new Error(`Runtime decision does not exist: ${decisionPath}`);
    }
    suppliedDecision = JSON.parse(await readFile(decisionPath, "utf8"));
  }

  const local = await resolveLocal(args, false);
  if (local.status === "available") {
    const output = {
      schemaVersion: 1,
      status: "ready",
      action: "use-local-browser",
      browser: local.browser,
      local
    };
    await writeOutput(output, args.out);
    console.log(args.json ? JSON.stringify(output, null, 2) : output.browser.executablePath);
    return;
  }

  const mergedDecision = { ...(suppliedDecision ?? {}), local };
  const next = suppliedDecision
    ? validateVisualRuntimeDecision(mergedDecision).next
    : nextVisualRuntimeAction(mergedDecision);

  if (next.action === "install-managed-browser") {
    const installed = await resolveLocal(args, true);
    if (installed.status !== "available") {
      throw new Error("Consented managed browser installation did not produce a runtime.");
    }
    const output = {
      schemaVersion: 1,
      status: "ready",
      action: "use-local-browser",
      browser: installed.browser,
      local,
      decision: decisionPath
    };
    await writeOutput(output, args.out);
    console.log(args.json ? JSON.stringify(output, null, 2) : output.browser.executablePath);
    return;
  }

  if (next.action === "skip-visual-audit") {
    if (!args.deck) throw new Error("Skipping visual audit requires --deck.");
    const { deckDir } = await resolveDeck(args.deck);
    const visualAudit = await recordVisualAuditSkip(deckDir, {
      reason: next.reason,
      decisionPath
    });
    const output = {
      schemaVersion: 1,
      status: "skipped",
      action: next.action,
      deck: deckDir,
      visualAudit
    };
    await writeOutput(output, args.out);
    console.log(args.json ? JSON.stringify(output, null, 2) : next.reason);
    return;
  }

  const output = {
    schemaVersion: 1,
    status: "action-required",
    ...next,
    local,
    decision: decisionPath
  };
  await writeOutput(output, args.out);
  console.log(args.json ? JSON.stringify(output, null, 2) : next.action);
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
