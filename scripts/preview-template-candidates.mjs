#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTitlePreviewHtml,
  copyPreviewSupportFiles,
  loadBeautifulTemplateCandidates,
  resolveBeautifulLibraryRoot,
  selectBeautifulTemplateCandidates,
  writeThirdPartyNotice
} from "../lib/beautiful-template-library.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");

function readArgs(argv) {
  const result = {
    request: "",
    out: "",
    library: "",
    count: 3,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--request") result.request = argv[++index] ?? "";
    else if (arg === "--out") result.out = argv[++index] ?? "";
    else if (arg === "--library") result.library = argv[++index] ?? "";
    else if (arg === "--count") result.count = Number(argv[++index] ?? 3);
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function printUsage() {
  console.log(`Usage:
  node scripts/preview-template-candidates.mjs --request /absolute/preview-request.json --out /absolute/previews [--library /absolute/beautiful/library] [--json]`);
}

function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`Preview request requires ${field}.`);
  return normalized;
}

function normalizeRequest(request) {
  return {
    title: requiredText(request.title, "title"),
    subtitle: String(request.subtitle ?? "").trim(),
    author: String(request.author ?? "").trim(),
    date: String(request.date ?? "").trim(),
    occasion: requiredText(request.occasion, "occasion"),
    mood: requiredText(request.mood, "mood"),
    density: String(request.density ?? "").trim(),
    scheme: String(request.scheme ?? "").trim()
  };
}

async function writeCandidatePreview({ candidate, index, outDir, request, libraryRoot }) {
  const previewDir = path.join(
    outDir,
    `${String(index + 1).padStart(2, "0")}-${candidate.slug}`
  );
  await mkdir(previewDir, { recursive: true });
  await copyPreviewSupportFiles({
    templateDir: candidate.templateDir,
    libraryRoot,
    outDir: previewDir
  });
  const templateHtml = await readFile(candidate.templatePath, "utf8");
  const previewHtml = buildTitlePreviewHtml({
    templateHtml,
    title: request.title,
    subtitle: request.subtitle,
    author: request.author,
    date: request.date
  });
  const previewPath = path.join(previewDir, "index.html");
  await writeFile(previewPath, previewHtml, "utf8");
  return {
    id: candidate.id,
    slug: candidate.slug,
    name: candidate.name,
    tagline: candidate.tagline,
    mood: candidate.mood,
    tone: candidate.tone,
    formality: candidate.formality,
    density: candidate.density,
    scheme: candidate.scheme,
    score: candidate.score,
    previewPath,
    templatePath: candidate.templatePath
  };
}

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Template previews: ${report.outputDir}`);
  for (const [index, candidate] of report.candidates.entries()) {
    console.log(
      `${index + 1}. ${candidate.name} (${candidate.slug}) — ${candidate.previewPath}`
    );
  }
  console.log(`Third-party notices: ${report.noticePath}`);
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.request || !args.out) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(args.count) || args.count < 1 || args.count > 6) {
    throw new Error("--count must be an integer from 1 to 6.");
  }
  const requestPath = path.resolve(args.request);
  if (!existsSync(requestPath)) throw new Error(`Preview request not found: ${requestPath}`);
  const outputDir = path.resolve(args.out);
  await mkdir(outputDir, { recursive: true });

  const request = normalizeRequest(JSON.parse(await readFile(requestPath, "utf8")));
  const libraryRoot = await resolveBeautifulLibraryRoot({
    skillRoot,
    libraryRoot: args.library
  });
  const templates = await loadBeautifulTemplateCandidates({ skillRoot, libraryRoot });
  const selected = selectBeautifulTemplateCandidates({
    templates,
    occasion: request.occasion,
    mood: request.mood,
    density: request.density,
    scheme: request.scheme,
    count: args.count
  });
  const candidates = [];
  for (const [index, candidate] of selected.entries()) {
    candidates.push(
      await writeCandidatePreview({
        candidate,
        index,
        outDir: outputDir,
        request,
        libraryRoot
      })
    );
  }
  const noticePath = await writeThirdPartyNotice({ libraryRoot, outDir: outputDir });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: "beautiful-html-templates",
    request,
    libraryRoot,
    outputDir,
    noticePath,
    licenseVisibleInRenderedDeck: false,
    candidates
  };
  await writeFile(
    path.join(outputDir, "preview-manifest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  printReport(report, args.json);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
