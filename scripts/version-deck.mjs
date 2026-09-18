#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { cp, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectDeck, readProject, writeProject } from "../lib/deck-model.mjs";

function readArgs(argv) {
  const result = { input: "", label: "revision", restoredFrom: "" };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!result.input && !arg.startsWith("--")) {
      result.input = arg;
    } else if (arg === "--label") {
      result.label = argv[index + 1] ?? "revision";
      index += 1;
    } else if (arg === "--restored-from") {
      result.restoredFrom = argv[index + 1] ?? "";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

function sanitizeLabel(label) {
  const cleaned = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned || "revision";
}

async function resolveDeckDir(input) {
  const resolved = path.resolve(input);
  if (!existsSync(resolved)) {
    throw new Error(`Deck does not exist: ${resolved}`);
  }

  const info = await stat(resolved);
  const deckDir = info.isDirectory() ? resolved : path.dirname(resolved);
  if (!existsSync(path.join(deckDir, "index.html"))) {
    throw new Error(`Deck folder must contain index.html: ${deckDir}`);
  }

  return deckDir;
}

function nextVersion(parentDir, baseName) {
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versionPattern = new RegExp(`^${escaped}-v(\\d{3})(?:-|$)`);
  let highest = 0;

  for (const entry of readdirSync(parentDir)) {
    const match = entry.match(versionPattern);
    if (match) highest = Math.max(highest, Number(match[1]));
  }

  return highest + 1;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      "Usage: node scripts/version-deck.mjs /absolute/path/to/deck --label change-name"
    );
    process.exitCode = 1;
    return;
  }

  const sourceDir = await resolveDeckDir(args.input);
  const parentDir = path.dirname(sourceDir);
  const sourceName = path.basename(sourceDir);
  const baseName = sourceName.replace(/-v\d{3}(?:-.*)?$/, "");
  const version = nextVersion(parentDir, baseName);
  const label = sanitizeLabel(args.label);
  const destination = path.join(
    parentDir,
    `${baseName}-v${String(version).padStart(3, "0")}-${label}`
  );

  if (existsSync(destination)) {
    throw new Error(`Version destination already exists: ${destination}`);
  }

  await cp(sourceDir, destination, { recursive: true, errorOnExist: true });
  const createdAt = new Date().toISOString();
  const revision = {
    version,
    label,
    source: sourceDir,
    createdAt,
    ...(args.restoredFrom ? { restoredFrom: path.resolve(args.restoredFrom) } : {})
  };
  await writeFile(
    path.join(destination, "revision.json"),
    `${JSON.stringify(revision, null, 2)}\n`,
    "utf8"
  );

  const sourceProject = await readProject(sourceDir);
  if (sourceProject) {
    const inspected = await inspectDeck(destination);
    await writeProject(destination, {
      ...sourceProject,
      currentVersion: version,
      updatedAt: createdAt,
      slides: inspected.slides,
      history: [...(sourceProject.history ?? []), revision],
      ...(sourceProject.emphasisPlan
        ? {
            emphasisPlan: {
              ...sourceProject.emphasisPlan,
              path: path.join(destination, "emphasis-plan.json")
            }
          }
        : {}),
      ...(sourceProject.slideLayoutPlan
        ? {
            slideLayoutPlan: {
              ...sourceProject.slideLayoutPlan,
              path: path.join(destination, "slide-layout-plan.json")
            }
          }
        : {})
    });
  }

  console.log(`Created protected working copy:`);
  console.log(destination);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
