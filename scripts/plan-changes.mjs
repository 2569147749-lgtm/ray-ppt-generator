#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  inspectDeck,
  inspectHtml,
  plannedTargets,
  readProject
} from "../lib/deck-model.mjs";

function readArgs(argv) {
  const result = { deck: "", plan: "", write: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--deck") {
      result.deck = argv[++index] ?? "";
    } else if (arg === "--plan") {
      result.plan = argv[++index] ?? "";
    } else if (arg === "--write") {
      result.write = true;
    } else if (arg === "--json") {
      result.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function normalizeTypographyAuthorization(change) {
  const authorization = change.typographyAuthorization;
  if (authorization === undefined) return undefined;
  if (
    !authorization ||
    typeof authorization !== "object" ||
    Array.isArray(authorization)
  ) {
    throw new Error(
      `Change ${change.id} typographyAuthorization must be an object.`
    );
  }
  const role = String(authorization.role ?? "").trim();
  if (!role) {
    throw new Error(
      `Change ${change.id} typographyAuthorization requires role.`
    );
  }
  const supported = new Set(["fontFamily", "fontWeight"]);
  const properties = [
    ...new Set(
      (authorization.properties ?? []).map((property) =>
        String(property).trim()
      )
    )
  ];
  if (properties.length === 0) {
    throw new Error(
      `Change ${change.id} typographyAuthorization requires properties.`
    );
  }
  const unsupported = properties.find((property) => !supported.has(property));
  if (unsupported) {
    throw new Error(
      `Change ${change.id} typographyAuthorization does not support ${unsupported}.`
    );
  }

  const normalized = { role, properties };
  if (authorization.itemId !== undefined) {
    const itemId = String(authorization.itemId).trim();
    if (!itemId) {
      throw new Error(
        `Change ${change.id} typographyAuthorization itemId must be non-empty.`
      );
    }
    normalized.itemId = itemId;
  }
  if (properties.includes("fontFamily")) {
    const fontFamily = String(authorization.fontFamily ?? "").trim();
    if (!fontFamily) {
      throw new Error(
        `Change ${change.id} typographyAuthorization requires fontFamily.`
      );
    }
    normalized.fontFamily = fontFamily;
  }
  if (properties.includes("fontWeight")) {
    const fontWeight = Number(authorization.fontWeight);
    if (
      !Number.isFinite(fontWeight) ||
      fontWeight < 1 ||
      fontWeight > 1000
    ) {
      throw new Error(
        `Change ${change.id} typographyAuthorization requires fontWeight between 1 and 1000.`
      );
    }
    normalized.fontWeight = fontWeight;
  }
  return normalized;
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1] ?? "";
}

function slideOpeningTag(html, slideId) {
  const pattern = /<section\b[^>]*\bdata-slide-id=(["'])([^"']+)\1[^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    if (match[2] === slideId) return match[0];
  }
  return "";
}

function assertAddSlideLayout(change, addedSlides, layoutPlan, project) {
  const decisionId = String(change.layoutDecision ?? "").trim();
  if (!decisionId) {
    throw new Error(`Change ${change.id} requires layoutDecision.`);
  }
  const treatment = String(change.layoutTreatment ?? "").trim();
  if (!treatment) {
    throw new Error(`Change ${change.id} requires layoutTreatment.`);
  }
  if (
    !layoutPlan ||
    layoutPlan.status !== "passed" ||
    project?.slideLayoutPlan?.status !== "passed"
  ) {
    throw new Error(
      `Change ${change.id} slide layout plan has not passed review.`
    );
  }
  const decision = layoutPlan.decisions?.find(
    (item) => item.id === decisionId
  );
  if (!decision) {
    throw new Error(
      `Change ${change.id} references unknown layout decision "${decisionId}".`
    );
  }
  const reviewed = layoutPlan.review?.decisions?.find(
    (item) => item.id === decisionId
  );
  if (
    !reviewed ||
    Object.values(reviewed.checks ?? {}).some((value) => value !== "pass")
  ) {
    throw new Error(
      `Change ${change.id} layout decision "${decisionId}" has not passed review.`
    );
  }
  const addedSlide = addedSlides[0];
  if (decision.changeId !== change.id) {
    throw new Error(
      `Layout decision "${decisionId}" belongs to change "${decision.changeId}", not "${change.id}".`
    );
  }
  if (decision.slide !== addedSlide.id) {
    throw new Error(
      `Layout decision "${decisionId}" targets slide "${decision.slide}", not "${addedSlide.id}".`
    );
  }
  if (decision.after !== change.after) {
    throw new Error(
      `Change ${change.id} insertion anchor does not match reviewed anchor "${decision.after}".`
    );
  }
  if (addedSlide.layout !== decision.selectedLayout) {
    throw new Error(
      `Change ${change.id} HTML must use reviewed layout "${decision.selectedLayout}".`
    );
  }
  if (treatment !== decision.styleTreatment) {
    throw new Error(
      `Change ${change.id} must use reviewed treatment "${decision.styleTreatment}".`
    );
  }
  const htmlTreatment = attribute(
    slideOpeningTag(change.html, addedSlide.id),
    "data-layout-treatment"
  );
  if (htmlTreatment !== treatment) {
    throw new Error(
      `Change ${change.id} HTML data-layout-treatment must equal "${treatment}".`
    );
  }
  return decision;
}

function normalizePlan(plan, slideIds, layoutPlan, project) {
  if (!Array.isArray(plan.changes) || plan.changes.length === 0) {
    throw new Error("Change plan must contain a non-empty changes array.");
  }

  const seen = new Set();
  const changes = plan.changes.map((change, index) => {
    const id = String(change.id ?? "").trim();
    if (!id) throw new Error(`Change at index ${index} is missing id.`);
    if (seen.has(id)) throw new Error(`Duplicate change id "${id}".`);
    seen.add(id);
    if (!String(change.type ?? "").trim()) {
      throw new Error(`Change ${id} is missing type.`);
    }
    if (!String(change.request ?? "").trim()) {
      throw new Error(`Change ${id} is missing request.`);
    }
    if (!Array.isArray(change.impact)) {
      throw new Error(`Change ${id} is missing impact.`);
    }

    const targets = [...new Set(change.targets ?? [])];
    if (targets.length === 0) throw new Error(`Change ${id} has no targets.`);
    const addedSlides =
      ["add-slide", "split-slide"].includes(change.command) &&
      typeof change.html === "string"
        ? inspectHtml(change.html)
        : [];
    const addedSlideIds = new Set(addedSlides.map((slide) => slide.id));
    for (const target of targets) {
      if (!slideIds.has(target) && !addedSlideIds.has(target)) {
        throw new Error(`Change ${id} targets unknown slide "${target}".`);
      }
    }
    if (
      ["add-slide", "split-slide"].includes(change.command) &&
      addedSlideIds.size !== 1
    ) {
      throw new Error(`Change ${id} must provide exactly one new slide.`);
    }
    if (
      change.command === "split-slide" &&
      !addedSlideIds.has(change.newSlide)
    ) {
      throw new Error(
        `Change ${id} newSlide "${change.newSlide}" does not match its HTML.`
      );
    }
    const layoutDecision =
      change.command === "add-slide"
        ? assertAddSlideLayout(
        { ...change, id },
        addedSlides,
        layoutPlan,
        project
          )
        : null;

    const typographyAuthorization = normalizeTypographyAuthorization({
      ...change,
      id
    });
    return {
      ...change,
      id,
      targets,
      impact: [...new Set(change.impact ?? [])],
      ...(layoutDecision
        ? { reviewedLayout: layoutDecision.selectedLayout }
        : {}),
      ...(typographyAuthorization ? { typographyAuthorization } : {}),
      status: change.status ?? "pending"
    };
  });

  const knownChanges = new Set(changes.map((change) => change.id));
  for (const change of changes) {
    for (const dependency of change.dependsOn ?? []) {
      if (!knownChanges.has(dependency)) {
        throw new Error(`Change ${change.id} depends on unknown change "${dependency}".`);
      }
    }
  }

  return {
    schemaVersion: 1,
    summary: String(plan.summary ?? "").trim(),
    createdAt: plan.createdAt ?? new Date().toISOString(),
    changes,
    affectedSlides: plannedTargets({ changes })
  };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.deck || !args.plan) {
    console.error(
      "Usage: node scripts/plan-changes.mjs --deck /path/to/deck --plan plan.json [--write] [--json]"
    );
    process.exitCode = 1;
    return;
  }

  const inspected = await inspectDeck(args.deck);
  const requested = JSON.parse(await readFile(path.resolve(args.plan), "utf8"));
  const requiresLayoutPlan = requested.changes?.some(
    (change) => change.command === "add-slide"
  );
  const layoutPlanPath = path.join(
    inspected.deckDir,
    "slide-layout-plan.json"
  );
  const [layoutPlan, project] = await Promise.all([
    requiresLayoutPlan && existsSync(layoutPlanPath)
      ? readFile(layoutPlanPath, "utf8").then(JSON.parse)
      : null,
    readProject(inspected.deckDir)
  ]);
  const normalized = normalizePlan(
    requested,
    new Set(inspected.slides.map((slide) => slide.id)),
    layoutPlan,
    project
  );

  if (args.write) {
    await writeFile(
      path.join(inspected.deckDir, "change-plan.json"),
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8"
    );
  }

  if (args.json) console.log(JSON.stringify(normalized, null, 2));
  else {
    console.log(`Changes: ${normalized.changes.length}`);
    console.log(`Affected slides: ${normalized.affectedSlides.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
