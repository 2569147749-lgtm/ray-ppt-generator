#!/usr/bin/env node

import {
  inspectDeck,
  readProject,
  writeProject
} from "../lib/deck-model.mjs";

function readArgs(argv) {
  const result = { input: "", json: false, write: false };
  for (const arg of argv) {
    if (arg === "--json") result.json = true;
    else if (arg === "--write") result.write = true;
    else if (!result.input && !arg.startsWith("--")) result.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.input) {
    console.error("Usage: node scripts/inspect-deck.mjs /path/to/deck [--write] [--json]");
    process.exitCode = 1;
    return;
  }

  const inspected = await inspectDeck(args.input);
  let project = await readProject(inspected.deckDir);
  if (args.write && project) {
    project = {
      ...project,
      updatedAt: new Date().toISOString(),
      slides: inspected.slides
    };
    await writeProject(inspected.deckDir, project);
  }
  const result = {
    deck: inspected.deckDir,
    template: project?.template ?? null,
    currentVersion: project?.currentVersion ?? null,
    slides: inspected.slides
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Deck: ${result.deck}`);
  for (const [index, slide] of result.slides.entries()) {
    console.log(
      `${String(index + 1).padStart(2, "0")}  ${slide.id}  ${slide.layout}  items=${slide.itemCount}  ${slide.title}`
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
