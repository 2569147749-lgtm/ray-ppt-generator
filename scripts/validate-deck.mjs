#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  extractSlideSections,
  inspectHtml,
  tagHasClass
} from "../lib/deck-model.mjs";
import {
  chooseImageLayout,
  inspectImageDimensions
} from "../lib/image-layout.mjs";
import { validateTemplateContract } from "../lib/template-contract.mjs";

function fail(message, failures) {
  failures.push(message);
}

function elementScanHtml(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, "<script$1></script>");
}

function firstCssRuleBody(html, selector) {
  const pattern = new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\}`, "i");
  return String(html).match(pattern)?.[1] ?? "";
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node scripts/validate-deck.mjs /absolute/path/to/index.html");
    process.exitCode = 1;
    return;
  }

  const htmlPath = path.resolve(input);
  if (!existsSync(htmlPath)) {
    throw new Error(`Deck does not exist: ${htmlPath}`);
  }

  const html = await readFile(htmlPath, "utf8");
  const scanHtml = elementScanHtml(html);
  const failures = [];
  const warnings = [];
  const usesDeckStage = /<deck-stage\b/i.test(html);
  const slideSections = extractSlideSections(html);
  let inspectedSlides = [];
  try {
    inspectedSlides = inspectHtml(html);
  } catch (error) {
    fail(error.message, failures);
  }

  const slideCount = slideSections.length;
  if (slideCount < 2) fail("Expected at least two .slide elements.", failures);

  const activeSlideCount = slideSections.filter(
    (slide) =>
      tagHasClass(slide.openingTag, "active") ||
      tagHasClass(slide.openingTag, "is-active") ||
      /\bdata-deck-active(?:\s|=|>)/i.test(slide.openingTag)
  ).length;
  if (activeSlideCount !== 1) {
    fail(
      `Expected exactly one initially active slide, found ${activeSlideCount}.`,
      failures
    );
  }

  const hasCssStageDimensions =
    /width:\s*1920px/.test(html) && /height:\s*1080px/.test(html);
  const hasDeckStageDimensions =
    /<deck-stage\b[^>]*\bwidth=["']1920["'][^>]*\bheight=["']1080["']/i.test(html);
  const hasViewportStageDimensions =
    /width:\s*(?:100vw|100%)/.test(html) &&
    /(height|min-height):\s*100vh/.test(html);
  const hasInsetStageDimensions =
    /html,\s*body[\s\S]*?height:\s*100%/i.test(html) &&
    /\.slide\s*\{[\s\S]*?inset:\s*0/i.test(html);
  const slideRule = firstCssRuleBody(html, "\\.slide");
  const hasPercentStageDimensions =
    /html,\s*body[\s\S]*?height:\s*100%/i.test(html) &&
    /width:\s*100%/i.test(slideRule) &&
    /height:\s*100%/i.test(slideRule) &&
    /position:\s*absolute/i.test(slideRule) &&
    (/inset:\s*0/i.test(slideRule) ||
      (/top:\s*0/i.test(slideRule) && /left:\s*0/i.test(slideRule)));
  if (
    !hasCssStageDimensions &&
    !hasDeckStageDimensions &&
    !hasViewportStageDimensions &&
    !hasInsetStageDimensions &&
    !hasPercentStageDimensions
  ) {
    fail("Missing fixed 1920x1080 or full-viewport stage dimensions.", failures);
  }

  if (!usesDeckStage && !/prefers-reduced-motion/.test(html)) {
    fail("Missing prefers-reduced-motion support.", failures);
  }

  if (usesDeckStage) {
    if (!/<deck-stage\b[^>]*\bid=["']deckStage["']/i.test(html)) {
      fail("Missing required deck-stage element #deckStage.", failures);
    }
    if (!/<script\b[^>]*\bsrc=["']deck-stage\.js["'][^>]*>/i.test(html)) {
      fail("Missing deck-stage.js runtime script.", failures);
    }
  } else {
    const hasStageContainer =
      hasViewportStageDimensions ||
      hasInsetStageDimensions ||
      hasPercentStageDimensions ||
      /<(?:div|main|section)\b[^>]*\bid=["'](?:deckStage|deck)["'][^>]*>/i.test(html) ||
      /class=["'][^"']*\b(?:deck|stage|slides|slides-container|slide-deck|presentation)\b[^"']*["']/i.test(html);
    const hasPreviousControl =
      /\bid=["'][^"']*(?:prev|previous)[^"']*["']/i.test(html) ||
      /function\s+(?:prev|prevSlide)\b/i.test(html) ||
      /changeSlide\(\s*-1\s*\)/i.test(html) ||
      /ArrowLeft/.test(html);
    const hasNextControl =
      /\bid=["'][^"']*next[^"']*["']/i.test(html) ||
      /function\s+(?:next|nextSlide)\b/i.test(html) ||
      /changeSlide\(\s*1\s*\)/i.test(html) ||
      /ArrowRight/.test(html);
    const hasCounter =
      /\bid=["'][^"']*(?:counter|currentSlide|totalSlides|slide-counter)[^"']*["']/i.test(html) ||
      /class=["'][^"']*\bslide-counter\b[^"']*["']/i.test(html) ||
      /class=["'][^"']*\bpagenum\b[^"']*["']/i.test(html);
    const hasProgress =
      /\bid=["'][^"']*progress[^"']*["']/i.test(html) ||
      /class=["'][^"']*\b(?:progress|progress-bar|nav-dots|pagenum)\b[^"']*["']/i.test(html) ||
      hasCounter;
    for (const [name, present] of [
      ["slide stage container", hasStageContainer],
      ["previous navigation control", hasPreviousControl],
      ["next navigation control", hasNextControl],
      ["slide counter", hasCounter],
      ["progress indicator", hasProgress]
    ]) {
      if (!present) fail(`Missing required ${name}.`, failures);
    }
  }

  if (!usesDeckStage && (!/ArrowRight/.test(html) || !/ArrowLeft/.test(html))) {
    fail("Missing keyboard arrow navigation.", failures);
  }

  if (!usesDeckStage && (!/touchstart/.test(html) || !/touchend/.test(html))) {
    fail("Missing touch swipe navigation.", failures);
  }

  const ids = [...scanHtml.matchAll(/(?<![\w:-])id=["']([^"']+)["']/g)].map(
    (match) => match[1]
  );
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  for (const id of duplicateIds) {
    fail(`Duplicate id: ${id}`, failures);
  }

  const imageTags = [...scanHtml.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  for (const imageTag of imageTags) {
    if (!/\balt=["'][^"']+["']/i.test(imageTag)) {
      fail(`Image is missing alt text: ${imageTag.slice(0, 120)}`, failures);
    }
    const role = imageTag.match(/\bdata-role=["']([^"']+)["']/i)?.[1];
    const source = imageTag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (
      role &&
      source &&
      !/^(?:https?:|data:|blob:|#|javascript:)/i.test(source)
    ) {
      const width = Number(
        imageTag.match(/\bdata-image-width=["']([^"']+)["']/i)?.[1] ?? 0
      );
      const height = Number(
        imageTag.match(/\bdata-image-height=["']([^"']+)["']/i)?.[1] ?? 0
      );
      const aspectRatio = Number(
        imageTag.match(/\bdata-image-aspect=["']([^"']+)["']/i)?.[1] ?? 0
      );
      const layout =
        imageTag.match(/\bdata-image-layout=["']([^"']+)["']/i)?.[1] ?? "";
      const fit = imageTag.match(/\bdata-image-fit=["']([^"']+)["']/i)?.[1] ?? "";
      if (
        !width ||
        !height ||
        !aspectRatio ||
        !layout ||
        !["contain", "cover"].includes(fit)
      ) {
        fail(`Semantic image "${role}" is missing adaptive image metadata.`, failures);
        continue;
      }
      const cleanSource = decodeURIComponent(source.split(/[?#]/)[0]);
      const assetPath = path.resolve(path.dirname(htmlPath), cleanSource);
      if (existsSync(assetPath)) {
        try {
          const actual = inspectImageDimensions(
            await readFile(assetPath),
            path.extname(assetPath)
          );
          const expected = chooseImageLayout(actual.width, actual.height);
          if (width !== actual.width || height !== actual.height) {
            fail(
              `Image "${role}" metadata ${width}x${height} does not match source ${actual.width}x${actual.height}.`,
              failures
            );
          }
          if (layout !== expected.layout) {
            fail(
              `Image "${role}" layout "${layout}" does not match source ratio (${expected.layout}).`,
              failures
            );
          }
          const section = [...html.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/gi)]
            .find((match) => match[0].includes(imageTag));
          const slideLayout = section?.[0].match(
            /<section\b[^>]*\bdata-image-layout=["']([^"']+)["']/i
          )?.[1];
          const slideStyle =
            section?.[0].match(/<section\b[^>]*\bstyle=["']([^"']*)["']/i)?.[1] ??
            "";
          const slideAspect = Number(
            slideStyle.match(/--image-aspect\s*:\s*([^;]+)/i)?.[1] ?? 0
          );
          const slideFit =
            slideStyle.match(/--image-fit\s*:\s*([^;]+)/i)?.[1]?.trim() ?? "";
          if (slideLayout !== layout) {
            fail(
              `Image "${role}" layout "${layout}" is not synchronized with its slide.`,
              failures
            );
          }
          if (
            aspectRatio !== expected.aspectRatio ||
            slideAspect !== expected.aspectRatio ||
            slideFit !== fit
          ) {
            fail(
              `Image "${role}" ratio or fit metadata is not synchronized with its slide.`,
              failures
            );
          }
        } catch (error) {
          fail(`Cannot inspect image "${role}": ${error.message}`, failures);
        }
      }
    }
  }

  const localSources = [...scanHtml.matchAll(/\bsrc=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter(
      (source) =>
        !/^(?:https?:|data:|blob:|#|javascript:)/i.test(source) &&
        !source.includes("${")
    );

  for (const source of localSources) {
    const cleanSource = decodeURIComponent(source.split(/[?#]/)[0]);
    const assetPath = path.resolve(path.dirname(htmlPath), cleanSource);
    if (!existsSync(assetPath)) {
      fail(`Missing local asset: ${source}`, failures);
    }
  }

  const contractsPath = path.join(path.dirname(htmlPath), "layout-contracts.json");
  if (existsSync(contractsPath) && inspectedSlides.length > 0) {
    const contracts = JSON.parse(await readFile(contractsPath, "utf8"));
    const contractValidation = validateTemplateContract(contracts);
    for (const error of contractValidation.errors) {
      fail(
        `Invalid template contract at ${error.path}: ${error.message}.`,
        failures
      );
    }
    for (const slide of inspectedSlides) {
      const contract = contracts.layouts?.[slide.layout];
      if (!contract) {
        fail(`Missing layout contract for ${slide.id} (${slide.layout}).`, failures);
        continue;
      }
      if (slide.itemCount < contract.minItems) {
        fail(
          `${slide.layout} item count ${slide.itemCount} is below minimum ${contract.minItems} on ${slide.id}.`,
          failures
        );
      }
      if (slide.itemCount > contract.maxItems) {
        fail(
          `${slide.layout} item count ${slide.itemCount} exceeds maximum ${contract.maxItems} on ${slide.id}.`,
          failures
        );
      }
    }
  }

  const projectPath = path.join(path.dirname(htmlPath), "deck-project.json");
  if (existsSync(projectPath) && inspectedSlides.length > 0) {
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    const actualIds = inspectedSlides.map((slide) => slide.id);
    const recordedIds = (project.slides ?? []).map((slide) => slide.id);
    if (JSON.stringify(actualIds) !== JSON.stringify(recordedIds)) {
      fail("Slide order or stable ids do not match deck-project.json.", failures);
    }
  }

  if (!/<title>[^<]+<\/title>/.test(html)) {
    warnings.push("Document title is empty or missing.");
  }

  if (!/aria-label/.test(html)) {
    warnings.push("No aria-label found. Review accessibility labels.");
  }

  console.log(`Deck: ${htmlPath}`);
  console.log(`Slides: ${slideCount}`);
  console.log(`Initial active slides: ${activeSlideCount}`);
  console.log(`Local assets: ${localSources.length}`);

  for (const warning of warnings) {
    console.warn(`WARN: ${warning}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL: ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("PASS: static deck checks completed.");
  console.log("NEXT: run scripts/visual-audit.mjs and complete its review gate.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
