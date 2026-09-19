#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteTextFiles } from "../lib/atomic-files.mjs";
import { analyzeAccessibilityQuality } from "../lib/accessibility-quality.mjs";
import { resolveBrowserExecutable } from "../lib/browser-runtime.mjs";
import { analyzeChartQuality } from "../lib/chart-quality.mjs";
import { inspectDeck, readProject } from "../lib/deck-model.mjs";
import { analyzeFontContinuity } from "../lib/font-continuity.mjs";
import { analyzeImageQuality } from "../lib/image-quality.mjs";
import { analyzeLayoutQuality } from "../lib/layout-quality.mjs";
import { analyzeSemanticEmphasis } from "../lib/semantic-emphasis.mjs";
import { analyzeSemanticVisualQuality } from "../lib/semantic-visual-quality.mjs";
import { analyzeStyleConsistency } from "../lib/style-consistency.mjs";
import { analyzeTypographyQuality } from "../lib/typography-quality.mjs";
import {
  analyzeVisualDiff,
  analyzeVisualGeometry,
  applyVisualReview,
  buildVisualContactSheetHtml,
  buildVisualReviewScope,
  comparePngPixels,
  inspectScreenshot,
  renderScreenshots,
  selectVisualSlides,
  VISUAL_VIEWPORTS
} from "../lib/visual-audit.mjs";

function inheritedBrowserRuntime() {
  if (!process.env.RAY_PPT_BROWSER_RUNTIME_JSON) return null;
  try {
    return JSON.parse(process.env.RAY_PPT_BROWSER_RUNTIME_JSON);
  } catch {
    return null;
  }
}

function readArgs(argv) {
  const result = {
    deck: "",
    plan: "",
    out: "",
    chrome: "",
    browserCache: "",
    runtimeCache: "",
    allowBrowserDownload: false,
    browserRuntime: inheritedBrowserRuntime(),
    timeout: 10000,
    report: "",
    review: "",
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--deck") result.deck = argv[++index] ?? "";
    else if (arg === "--plan") result.plan = argv[++index] ?? "";
    else if (arg === "--out") result.out = argv[++index] ?? "";
    else if (arg === "--chrome") result.chrome = argv[++index] ?? "";
    else if (arg === "--browser-cache") result.browserCache = argv[++index] ?? "";
    else if (arg === "--runtime-cache") result.runtimeCache = argv[++index] ?? "";
    else if (arg === "--allow-browser-install") result.allowBrowserDownload = true;
    else if (arg === "--no-browser-download") result.allowBrowserDownload = false;
    else if (arg === "--timeout") result.timeout = Number(argv[++index] ?? 10000);
    else if (arg === "--report") result.report = argv[++index] ?? "";
    else if (arg === "--review") result.review = argv[++index] ?? "";
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function safeName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, "-");
}

async function writeReportAndGate(deckDir, reportPath, report) {
  const project = await readProject(deckDir);
  const entries = [
    {
      path: reportPath,
      content: `${JSON.stringify(report, null, 2)}\n`
    }
  ];
  if (project) {
    entries.push({
      path: path.join(deckDir, "deck-project.json"),
      content: `${JSON.stringify(
        {
          ...project,
          updatedAt: report.updatedAt,
          visualAudit: {
            status: report.status,
            report: reportPath,
            captures: report.captures.length,
            contactSheets: report.contactSheets ?? [],
            reviewScope: report.reviewScope
              ? {
                  mode: report.reviewScope.mode,
                  abnormalCaptureCount: report.reviewScope.abnormalCaptureCount,
                  abnormalItemCount: report.reviewScope.abnormalItemCount
                }
              : null,
            updatedAt: report.updatedAt
          }
        },
        null,
        2
      )}\n`
    });
  }
  await atomicWriteTextFiles(entries);
}

async function reviewExisting(args, deck) {
  if (!args.report || !args.review) {
    throw new Error("Review mode requires both --report and --review.");
  }
  const reportPath = path.resolve(args.report);
  const [report, review] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile(path.resolve(args.review), "utf8").then(JSON.parse)
  ]);
  if (report.deck !== deck.deckDir) {
    throw new Error(`Visual report belongs to a different deck: ${report.deck}`);
  }
  if (!report.capturePassed) {
    throw new Error("Cannot approve a visual audit whose automated capture checks failed.");
  }
  const reviewed = applyVisualReview(report, review);
  await writeReportAndGate(deck.deckDir, reportPath, reviewed);
  return reviewed;
}

async function resolveSourceDeck(deckDir) {
  const revisionPath = path.join(deckDir, "revision.json");
  if (!existsSync(revisionPath)) return null;
  const revision = JSON.parse(await readFile(revisionPath, "utf8"));
  if (!revision.source) return null;
  const sourcePath = path.isAbsolute(revision.source)
    ? revision.source
    : path.resolve(deckDir, revision.source);
  if (!existsSync(sourcePath)) return null;
  return inspectDeck(sourcePath);
}

async function readLayoutContract(deckDir) {
  const contractPath = path.join(deckDir, "layout-contracts.json");
  if (!existsSync(contractPath)) return null;
  return JSON.parse(await readFile(contractPath, "utf8"));
}

function pageNumberPixelRects(geometry) {
  if (!geometry?.slide || !geometry?.slideViewport) return [];
  const scaleX = geometry.slideViewport.width / geometry.slide.width;
  const scaleY = geometry.slideViewport.height / geometry.slide.height;
  const slideRects = (geometry.elements ?? [])
    .filter((element) => element.selector === '[data-role="page-number"]')
    .map((element) => ({
      left:
        geometry.slideViewport.left + element.rect.left * scaleX - 3,
      top:
        geometry.slideViewport.top + element.rect.top * scaleY - 3,
      right:
        geometry.slideViewport.left + element.rect.right * scaleX + 3,
      bottom:
        geometry.slideViewport.top + element.rect.bottom * scaleY + 3
    }));
  return [
    ...slideRects,
    ...(geometry.paginationIgnoreRects ?? []).map((rect) => ({
      left: rect.left - 3,
      top: rect.top - 3,
      right: rect.right + 3,
      bottom: rect.bottom + 3
    }))
  ];
}

async function captureAudit(args, deck) {
  const defaultPlan = path.join(deck.deckDir, "change-plan.json");
  const planPath = args.plan
    ? path.resolve(args.plan)
    : existsSync(defaultPlan)
      ? defaultPlan
      : "";
  const plan = planPath ? JSON.parse(await readFile(planPath, "utf8")) : null;
  const emphasisPlanPath = path.join(deck.deckDir, "emphasis-plan.json");
  const emphasisPlan = existsSync(emphasisPlanPath)
    ? JSON.parse(await readFile(emphasisPlanPath, "utf8"))
    : null;
  const sourceDeck = await resolveSourceDeck(deck.deckDir);
  const pageCountChanged =
    sourceDeck !== null && sourceDeck.slides.length !== deck.slides.length;
  const sourceSlides = sourceDeck?.slides ?? deck.slides;
  const selectedSlides = selectVisualSlides({
    sourceSlides,
    revisedSlides: deck.slides,
    plan
  });
  if (selectedSlides.length === 0) {
    throw new Error("Visual audit selected no slides.");
  }

  const outputDir = path.resolve(args.out || path.join(deck.deckDir, "visual-audit"));
  await mkdir(outputDir, { recursive: true });
  const baselineDir = path.join(outputDir, "baseline");
  if (sourceDeck) await mkdir(baselineDir, { recursive: true });
  const tasks = selectedSlides.flatMap((slideId) =>
    VISUAL_VIEWPORTS.map((viewport) => ({ slideId, viewport }))
  );
  const renderTasks = tasks.map(({ slideId, viewport }) => {
    const outputPath = path.join(
      outputDir,
      `${safeName(slideId)}-${viewport.name}.png`
    );
    const url = pathToFileURL(deck.htmlPath);
    url.searchParams.set("__visual_audit", `${safeName(slideId)}-${viewport.name}`);
    const slideIndex = deck.slides.findIndex((slide) => slide.id === slideId);
    url.hash = String(slideIndex + 1);
    return {
      slideId,
      slideIndex,
      viewport,
      url: url.href,
      outputPath,
      width: viewport.width,
      height: viewport.height,
      expectedSlide: slideId,
      timeoutMs: args.timeout
    };
  });
  const baselineTasks = sourceDeck
    ? tasks.flatMap(({ slideId, viewport }) => {
        const slideIndex = sourceDeck.slides.findIndex(
          (slide) => slide.id === slideId
        );
        if (slideIndex < 0) return [];
        const outputPath = path.join(
          baselineDir,
          `${safeName(slideId)}-${viewport.name}.png`
        );
        const url = pathToFileURL(sourceDeck.htmlPath);
        url.searchParams.set(
          "__visual_audit",
          `baseline-${safeName(slideId)}-${viewport.name}`
        );
        url.hash = String(slideIndex + 1);
        return [
          {
            slideId,
            slideIndex,
            viewport,
            url: url.href,
            outputPath,
            width: viewport.width,
            height: viewport.height,
            expectedSlide: slideId,
            timeoutMs: args.timeout
          }
        ];
      })
    : [];
  const allRenderTasks = [...renderTasks, ...baselineTasks];
  const renderedCaptures = await renderScreenshots({
    chromePath: path.resolve(args.chrome),
    tasks: allRenderTasks,
    timeoutMs: args.timeout
  });
  const baselineRenders = new Map(
    baselineTasks.map((task, index) => [
      `${task.slideId}:${task.viewport.name}`,
      {
        task,
        rendered: renderedCaptures[renderTasks.length + index]
      }
    ])
  );
  const plannedSlides = new Set(
    (plan?.changes ?? []).flatMap((change) => change.targets ?? [])
  );
  const captures = await Promise.all(
    renderTasks.map(async ({ slideId, slideIndex, viewport, outputPath }, index) => {
      const id = `${slideId}:${viewport.name}`;
      const rendered = renderedCaptures[index];
      try {
        if (rendered.error) throw new Error(rendered.error);
        if (!rendered.geometry) {
          throw new Error(`Chrome did not return visual geometry for ${slideId}.`);
        }
        const geometryFindings = analyzeVisualGeometry(rendered.geometry);
        const inspected = await inspectScreenshot(outputPath, viewport, {
          region: rendered.geometry.slideViewport,
          allowedEdges: rendered.geometry.stripeAllowances,
          ignoredRects: rendered.geometry.stripeIgnoreRects
        });
        const baseline = baselineRenders.get(id);
        let visualDiff = null;
        let visualDiffFindings = [];
        if (baseline) {
          if (baseline.rendered.error) {
            throw new Error(`Baseline render failed for ${id}: ${baseline.rendered.error}`);
          }
          const [revisedPng, baselinePng] = await Promise.all([
            readFile(outputPath),
            readFile(baseline.task.outputPath)
          ]);
          const analyzed = analyzeVisualDiff({
            metrics: comparePngPixels(baselinePng, revisedPng, {
              ignoredRects: pageCountChanged
                ? [
                    ...pageNumberPixelRects(baseline.rendered.geometry),
                    ...pageNumberPixelRects(rendered.geometry)
                  ]
                : []
            }),
            planned: plannedSlides.has(slideId),
            baselineFile: baseline.task.outputPath
          });
          visualDiff = analyzed.evidence;
          visualDiffFindings = analyzed.findings;
        } else if (sourceDeck) {
          visualDiff = {
            baselineFile: null,
            planned: plannedSlides.has(slideId),
            status: "not-compared",
            reason: "source-slide-missing"
          };
        }
        const findings = [
          ...geometryFindings,
          ...inspected.stripeFindings,
          ...visualDiffFindings
        ];
        const automatedPassed = !findings.some(
          (finding) => finding.severity === "blocker"
        );
        return {
          id,
          slide: slideId,
          slideNumber: slideIndex + 1,
          viewport: viewport.name,
          width: inspected.width,
          height: inspected.height,
          bytes: inspected.bytes,
          dimensionsMatch: inspected.dimensionsMatch,
          nonBlank: inspected.nonBlank,
          visualDiff,
          findings,
          automatedPassed,
          valid: inspected.dimensionsMatch && inspected.nonBlank && automatedPassed,
          durationMs: rendered.durationMs,
          viewportWidth: rendered.viewportWidth,
          viewportHeight: rendered.viewportHeight,
          activeSlide: rendered.activeSlide,
          activeAnimations: rendered.activeAnimations,
          brokenImages: rendered.brokenImages,
          styleProfile: rendered.geometry.styleProfile ?? null,
          qualityProfile: rendered.geometry.qualityProfile ?? null,
          renderSessionId: rendered.renderSessionId,
          file: outputPath
        };
      } catch (error) {
        return {
          id,
          slide: slideId,
          slideNumber: slideIndex + 1,
          viewport: viewport.name,
          width: viewport.width,
          height: viewport.height,
          valid: false,
          error: error.message,
          renderSessionId: rendered.renderSessionId,
          file: outputPath
        };
      }
    })
  );

  const createdAt = new Date().toISOString();
  const layoutContract = await readLayoutContract(deck.deckDir);
  const styleConsistency = analyzeStyleConsistency({
    profiles: captures
      .filter((capture) => capture.viewport === "desktop" && capture.styleProfile)
      .map((capture) => capture.styleProfile),
    contract: layoutContract,
    plan
  });
  const qualityProfiles = captures
    .filter((capture) => capture.viewport === "desktop" && capture.qualityProfile)
    .map((capture) => capture.qualityProfile);
  const baselineQualityProfiles = baselineTasks
    .map((task, index) => ({
      task,
      rendered: renderedCaptures[renderTasks.length + index]
    }))
    .filter(
      ({ task, rendered }) =>
        task.viewport.name === "desktop" && rendered.geometry?.qualityProfile
    )
    .map(({ rendered }) => rendered.geometry.qualityProfile);
  const fontContinuity = analyzeFontContinuity({
    profiles: qualityProfiles,
    baselineProfiles: baselineQualityProfiles,
    contract: layoutContract,
    plan
  });
  const typographyQuality = analyzeTypographyQuality({
    profiles: qualityProfiles.map((profile) => ({
      slide: profile.slide,
      layout: profile.layout,
      elements: profile.typography
    })),
    contract: layoutContract
  });
  const imageQuality = analyzeImageQuality({
    profiles: qualityProfiles.map((profile) => ({
      slide: profile.slide,
      layout: profile.layout,
      images: profile.images
    })),
    contract: layoutContract
  });
  const layoutQuality = analyzeLayoutQuality({
    profiles: qualityProfiles,
    contract: layoutContract
  });
  const chartQuality = analyzeChartQuality({
    profiles: qualityProfiles,
    contract: layoutContract
  });
  const semanticVisualQuality = analyzeSemanticVisualQuality({
    profiles: qualityProfiles.map((profile) => ({
      slide: profile.slide,
      layout: profile.layout,
      ...profile.semantic
    })),
    contract: layoutContract
  });
  const accessibilityQuality = analyzeAccessibilityQuality({
    profiles: qualityProfiles.map((profile) => ({
      slide: profile.slide,
      layout: profile.layout,
      ...profile.accessibility
    })),
    contract: layoutContract
  });
  const semanticEmphasis = analyzeSemanticEmphasis({
    profiles: qualityProfiles.map((profile) => ({
      slide: profile.slide,
      candidates: profile.emphasisCandidates ?? []
    })),
    plan: emphasisPlan
      ? {
          ...emphasisPlan,
          decisions: (emphasisPlan.decisions ?? []).filter((decision) =>
            selectedSlides.includes(decision.slide)
          )
        }
      : null
  });
  const visualQualityFindings = [
    ...typographyQuality.findings,
    ...imageQuality.findings,
    ...layoutQuality.findings,
    ...chartQuality.findings,
    ...semanticVisualQuality.findings,
    ...accessibilityQuality.findings
  ];
  const visualQuality = {
    passed: [
      typographyQuality,
      imageQuality,
      layoutQuality,
      chartQuality,
      semanticVisualQuality,
      accessibilityQuality
    ].every((quality) => quality.passed),
    typography: typographyQuality,
    images: imageQuality,
    layout: layoutQuality,
    charts: chartQuality,
    semanticVisual: semanticVisualQuality,
    accessibility: accessibilityQuality,
    findings: visualQualityFindings
  };
  const capturePassed =
    captures.every((capture) => capture.valid) &&
    styleConsistency.passed &&
    fontContinuity.passed &&
    visualQuality.passed &&
    semanticEmphasis.passed;
  const captureFindingCount = captures.reduce(
    (total, capture) => total + (capture.findings?.length ?? 0),
    0
  );
  const findingCount =
    captureFindingCount +
    styleConsistency.findings.length +
    fontContinuity.findings.length +
    visualQuality.findings.length +
    semanticEmphasis.findings.length;
  const visualDiffFindingCount = captures.reduce(
    (total, capture) =>
      total +
      (capture.findings ?? []).filter(
        (finding) => finding.code === "unexpected-visual-change"
      ).length,
    0
  );
  const renderSessions = new Set(
    captures.map((capture) => capture.renderSessionId).filter(Boolean)
  ).size;
  const report = {
    schemaVersion: 2,
    deck: deck.deckDir,
    plan: planPath || null,
    createdAt,
    updatedAt: createdAt,
    selectedSlides,
    viewports: VISUAL_VIEWPORTS,
    captures,
    renderSessions,
    findingCount,
    styleFindingCount: styleConsistency.findings.length,
    styleConsistency,
    fontContinuityFindingCount: fontContinuity.findings.length,
    fontContinuity,
    qualityFindingCount: visualQuality.findings.length,
    visualQuality,
    semanticEmphasisFindingCount: semanticEmphasis.findings.length,
    semanticEmphasis,
    visualDiffFindingCount,
    browser: args.browserRuntime,
    capturePassed,
    status: capturePassed ? "review-required" : "failed",
    review: null
  };
  const reviewScope = buildVisualReviewScope(report);
  const contactSheets = VISUAL_VIEWPORTS.map((viewport) => {
    const file = path.join(outputDir, `contact-sheet-${viewport.name}.html`);
    return {
      viewport: viewport.name,
      file,
      captureCount: captures.filter(
        (capture) => capture.viewport === viewport.name
      ).length,
      abnormalCaptureCount: reviewScope.captures.filter(
        (capture) =>
          capture.viewport === viewport.name && capture.items.length > 0
      ).length
    };
  });
  const reportPath = path.join(outputDir, "visual-audit-report.json");
  const finalReport = {
    ...report,
    report: reportPath,
    reviewScope,
    contactSheets
  };
  await atomicWriteTextFiles(
    contactSheets.map((sheet) => ({
      path: sheet.file,
      content: buildVisualContactSheetHtml({
        report: finalReport,
        viewport: sheet.viewport
      })
    }))
  );
  await writeReportAndGate(deck.deckDir, reportPath, finalReport);
  return finalReport;
}

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Visual audit: ${report.status.toUpperCase()}`);
  console.log(`Slides: ${report.selectedSlides.join(", ")}`);
  console.log(`Captures: ${report.captures.length}`);
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.deck) {
    console.error(
      "Usage: node scripts/visual-audit.mjs --deck /path/to/deck [--plan plan.json] [--out folder] [--chrome path] [--browser-cache path] [--runtime-cache path] [--allow-browser-install] [--json]\n" +
        "Review: node scripts/visual-audit.mjs --deck /path/to/deck --report report.json --review review.json [--json]"
    );
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(args.timeout) || args.timeout < 1000) {
    throw new Error("--timeout must be at least 1000 milliseconds.");
  }

  const deck = await inspectDeck(args.deck);
  if (!args.review) {
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
    if (
      !args.browserRuntime ||
      path.resolve(args.browserRuntime.executablePath ?? "") !==
        path.resolve(browser.executablePath)
    ) {
      args.browserRuntime = {
        source: browser.source,
        executablePath: browser.executablePath,
        product: browser.product ?? null,
        version: browser.version ?? browser.spec?.version ?? null,
        cdpTransport: browser.cdpTransport ?? null,
        platform: browser.spec?.platform ?? process.platform,
        discovery: browser.discovery ?? null
      };
    }
  }
  const report = args.review
    ? await reviewExisting(args, deck)
    : await captureAudit(args, deck);
  printReport(report, args.json);
  if (report.status === "review-required") process.exitCode = 2;
  else if (report.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
