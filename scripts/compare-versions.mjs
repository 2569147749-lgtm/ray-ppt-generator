#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspectDeck, plannedTargets } from "../lib/deck-model.mjs";

function readArgs(argv) {
  const result = { source: "", revised: "", plan: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!result.source && !arg.startsWith("--")) result.source = arg;
    else if (!result.revised && !arg.startsWith("--")) result.revised = arg;
    else if (arg === "--plan") result.plan = argv[++index] ?? "";
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.source || !args.revised || !args.plan) {
    console.error(
      "Usage: node scripts/compare-versions.mjs source revised --plan plan.json [--json]"
    );
    process.exitCode = 1;
    return;
  }

  const [source, revised, plan] = await Promise.all([
    inspectDeck(args.source),
    inspectDeck(args.revised),
    readFile(path.resolve(args.plan), "utf8").then(JSON.parse)
  ]);
  const sourceById = new Map(source.slides.map((slide) => [slide.id, slide]));
  const revisedById = new Map(revised.slides.map((slide) => [slide.id, slide]));
  const allIds = new Set([...sourceById.keys(), ...revisedById.keys()]);
  const contentChanged = [...allIds]
    .filter((id) => sourceById.get(id)?.hash !== revisedById.get(id)?.hash)
    .sort();
  const sourceOrder = source.slides.map((slide) => slide.id);
  const revisedOrder = revised.slides.map((slide) => slide.id);
  const moveChanges = (plan.changes ?? []).filter(
    (change) => change.command === "move-slide"
  );
  const moved = [];
  for (const change of moveChanges) {
    const target = change.slide ?? change.targets?.[0];
    const revisedIndex = revisedOrder.indexOf(target);
    if (revisedIndex < 0 || revisedOrder[revisedIndex - 1] !== change.after) {
      throw new Error(`Planned slide move not applied: ${target}`);
    }
    if (sourceOrder.indexOf(target) !== revisedIndex) moved.push(target);
  }
  const movedSet = new Set(moveChanges.map((change) => change.slide ?? change.targets?.[0]));
  const addedSet = new Set(
    (plan.changes ?? [])
      .filter((change) => ["add-slide", "split-slide"].includes(change.command))
      .flatMap((change) => change.targets ?? [])
      .filter((id) => !sourceById.has(id))
  );
  const sourceStableOrder = sourceOrder.filter(
    (id) => revisedById.has(id) && !movedSet.has(id)
  );
  const revisedStableOrder = revisedOrder.filter(
    (id) => sourceById.has(id) && !movedSet.has(id) && !addedSet.has(id)
  );
  if (JSON.stringify(sourceStableOrder) !== JSON.stringify(revisedStableOrder)) {
    throw new Error("Unexpected slide order change.");
  }
  const changed = [...new Set([...contentChanged, ...moved])].sort();
  const planned = plannedTargets(plan);
  const unexpected = changed.filter((id) => !planned.includes(id));
  const unchangedPlanned = planned.filter((id) => !changed.includes(id));
  const result = { changed, planned, unexpected, unchangedPlanned };

  if (unexpected.length > 0) {
    throw new Error(`Unexpected changed slides: ${unexpected.join(", ")}`);
  }
  if (unchangedPlanned.length > 0) {
    throw new Error(`Planned slides unchanged: ${unchangedPlanned.join(", ")}`);
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Changed slides: ${changed.join(", ") || "none"}`);
    console.log(`Planned but unchanged: ${unchangedPlanned.join(", ") || "none"}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
