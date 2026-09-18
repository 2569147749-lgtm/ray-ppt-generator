#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFiles } from "../lib/atomic-files.mjs";
import { applyCommands } from "../lib/deck-dom.mjs";
import {
  inspectHtml,
  readProject,
  resolveDeck
} from "../lib/deck-model.mjs";
import {
  chooseImageLayout,
  inspectImageDimensions
} from "../lib/image-layout.mjs";

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

function validateContracts(slides, contracts) {
  if (!contracts) return;
  for (const slide of slides) {
    const contract = contracts.layouts?.[slide.layout];
    if (!contract) {
      throw new Error(`Missing layout contract for ${slide.id} (${slide.layout}).`);
    }
    if (slide.itemCount < contract.minItems) {
      throw new Error(
        `${slide.layout} item count ${slide.itemCount} is below minimum ${contract.minItems} on ${slide.id}.`
      );
    }
    if (slide.itemCount > contract.maxItems) {
      throw new Error(
        `${slide.layout} item count ${slide.itemCount} exceeds maximum ${contract.maxItems} on ${slide.id}.`
      );
    }
  }
}

async function prepareCommands(changes, deckDir) {
  const allowedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
  const destinations = new Set();
  const assets = [];
  const commands = [];

  for (const change of changes) {
    if (change.command !== "replace-image") {
      commands.push(change);
      continue;
    }
    if (!path.isAbsolute(change.source ?? "")) {
      throw new Error(`Change "${change.id}" requires an absolute local image source.`);
    }
    const source = path.resolve(change.source);
    const sourceInfo = await stat(source).catch(() => null);
    if (!sourceInfo?.isFile()) {
      throw new Error(`Image source does not exist: ${source}`);
    }
    const sourceExtension = path.extname(source).toLowerCase();
    if (!allowedExtensions.has(sourceExtension)) {
      throw new Error(`Unsupported image type "${sourceExtension || "none"}".`);
    }
    const assetName = String(change.assetName ?? path.basename(source)).trim();
    if (!assetName || path.basename(assetName) !== assetName) {
      throw new Error(`Change "${change.id}" has an invalid assetName.`);
    }
    const assetExtension = path.extname(assetName).toLowerCase();
    if (assetExtension !== sourceExtension) {
      throw new Error(`Change "${change.id}" assetName must keep the source extension.`);
    }
    if (!String(change.alt ?? "").trim()) {
      throw new Error(`Change "${change.id}" requires non-empty alt text.`);
    }
    const fit = change.fit ?? "contain";
    if (!["contain", "cover"].includes(fit)) {
      throw new Error(`Change "${change.id}" fit must be "contain" or "cover".`);
    }
    const imageBuffer = await readFile(source);
    const dimensions = inspectImageDimensions(imageBuffer, sourceExtension);
    const imageLayout = chooseImageLayout(dimensions.width, dimensions.height);
    const destination = path.join(deckDir, "assets", assetName);
    if (destinations.has(destination)) {
      throw new Error(`Multiple image changes target "${assetName}".`);
    }
    destinations.add(destination);
    if (source !== destination) assets.push({ path: destination, source });
    commands.push({
      ...change,
      source,
      assetName,
      src: `assets/${assetName}`,
      imageWidth: imageLayout.width,
      imageHeight: imageLayout.height,
      aspectRatio: imageLayout.aspectRatio,
      imageLayout: imageLayout.layout,
      fit
    });
  }
  return { commands, assets };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.deck || !args.plan) {
    console.error(
      "Usage: node scripts/modify-deck.mjs --deck /path/to/deck --plan plan.json [--write] [--json]"
    );
    process.exitCode = 1;
    return;
  }

  const { deckDir, htmlPath } = await resolveDeck(args.deck);
  const planPath = path.resolve(args.plan);
  const [sourceHtml, plan, project] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(planPath, "utf8").then(JSON.parse),
    readProject(deckDir)
  ]);
  if (!Array.isArray(plan.changes) || plan.changes.length === 0) {
    throw new Error("Change plan must contain a non-empty changes array.");
  }

  const prepared = await prepareCommands(plan.changes, deckDir);
  const result = applyCommands(sourceHtml, prepared.commands);
  const slides = inspectHtml(result.html);
  const contractsPath = path.join(deckDir, "layout-contracts.json");
  const contracts = existsSync(contractsPath)
    ? JSON.parse(await readFile(contractsPath, "utf8"))
    : null;
  validateContracts(slides, contracts);

  const appliedAt = new Date().toISOString();
  const appliedIds = new Set(result.results.map((entry) => entry.id));
  const storedPlan = {
    ...plan,
    schemaVersion: plan.schemaVersion ?? 1,
    appliedAt,
    changes: prepared.commands.map((change) => ({
      ...change,
      status: appliedIds.has(change.id) ? "applied" : change.status
    })),
    affectedSlides: result.affectedSlides
  };
  const nextProject = project
    ? {
        ...project,
        updatedAt: appliedAt,
        slides,
        visualAudit: {
          status: "required",
          report: null,
          captures: 0,
          updatedAt: appliedAt
        },
        semanticAudit: {
          status: "required",
          report: null,
          changes: storedPlan.changes.length,
          updatedAt: appliedAt
        }
      }
    : null;

  if (args.write) {
    const entries = [
      { path: htmlPath, content: result.html },
      {
        path: path.join(deckDir, "change-plan.json"),
        content: `${JSON.stringify(storedPlan, null, 2)}\n`
      }
    ];
    if (nextProject) {
      entries.push({
        path: path.join(deckDir, "deck-project.json"),
        content: `${JSON.stringify(nextProject, null, 2)}\n`
      });
    }
    entries.push(...prepared.assets);
    await atomicWriteFiles(entries);
  }

  const output = {
    deck: deckDir,
    wrote: args.write,
    appliedChanges: result.results.map((entry) => entry.id),
    affectedSlides: result.affectedSlides,
    slideIds: result.slideIds
  };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`Applied changes: ${output.appliedChanges.join(", ")}`);
    console.log(`Affected slides: ${output.affectedSlides.join(", ")}`);
    console.log(args.write ? `Updated: ${htmlPath}` : "Dry run only; no files written.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
