#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BEAUTIFUL_TEMPLATE_SOURCE,
  loadBeautifulTemplateCandidates,
  resolveBeautifulLibraryRoot
} from "../lib/beautiful-template-library.mjs";
import {
  applyEmphasisReview,
  normalizeEmphasisPlan
} from "../lib/emphasis-plan.mjs";
import { extractSlideSections, inspectHtml } from "../lib/deck-model.mjs";
import { assertTemplateContract } from "../lib/template-contract.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const templatesRoot = path.join(skillRoot, "assets", "templates");
const indexPath = path.join(templatesRoot, "index.json");
const UPDATED_AT = "2026-09-18T00:00:00.000Z";
const PRODUCTION_LAYOUTS = [
  "cover",
  "statement",
  "agenda",
  "metric",
  "comparison",
  "process",
  "decision-matrix",
  "closing"
];

const LAYOUT_INTENTS = {
  cover: "opening",
  statement: "key-message",
  agenda: "structure-overview",
  metric: "quantitative-comparison",
  comparison: "categorical-comparison",
  process: "process",
  "decision-matrix": "prioritization",
  closing: "call-to-action"
};

const LAYOUT_PROFILES = {
  cover: {
    narrativeRoles: ["opening"],
    contentShapes: ["single-message"],
    density: "speaker-led",
    preferredItems: { min: 0, max: 0 }
  },
  statement: {
    narrativeRoles: ["context", "argument", "summary"],
    contentShapes: ["single-message"],
    density: "balanced",
    preferredItems: { min: 0, max: 0 }
  },
  agenda: {
    narrativeRoles: ["orientation", "structure"],
    contentShapes: ["structured-list"],
    density: "balanced",
    preferredItems: { min: 3, max: 6 }
  },
  metric: {
    narrativeRoles: ["evidence"],
    contentShapes: ["quantitative-evidence"],
    density: "balanced",
    preferredItems: { min: 1, max: 6 }
  },
  comparison: {
    narrativeRoles: ["argument", "evidence"],
    contentShapes: ["parallel-comparison"],
    density: "balanced",
    preferredItems: { min: 2, max: 4 }
  },
  process: {
    narrativeRoles: ["explanation", "execution"],
    contentShapes: ["sequence"],
    density: "balanced",
    preferredItems: { min: 3, max: 6 }
  },
  "decision-matrix": {
    narrativeRoles: ["decision"],
    contentShapes: ["two-axis-prioritization"],
    density: "balanced",
    preferredItems: { min: 4, max: 4 }
  },
  closing: {
    narrativeRoles: ["closing", "action"],
    contentShapes: ["call-to-action"],
    density: "speaker-led",
    preferredItems: { min: 0, max: 0 }
  }
};

function readArgs(argv) {
  const args = { check: false, force: false, library: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.check = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--library") args.library = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (String(value ?? "").trim()) return [String(value).trim()];
  return [];
}

function normalizeDensity(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "high") return ["dense"];
  if (normalized === "medium-high") return ["balanced", "dense"];
  if (normalized === "medium") return ["balanced"];
  if (normalized === "medium-low") return ["speaker-led", "balanced"];
  if (normalized === "low") return ["speaker-led"];
  return normalized ? [normalized] : ["balanced"];
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}=(["'])([\\s\\S]*?)\\1`, "i"))?.[2] ?? "";
}

function escapeAttribute(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function classNames(tag) {
  return attribute(tag, "class").split(/\s+/).filter(Boolean);
}

function hasClass(tag, className) {
  return classNames(tag).includes(className);
}

function setClassNames(tag, classes) {
  const value = escapeAttribute([...new Set(classes)].join(" "));
  if (/\bclass=(["'])[\s\S]*?\1/i.test(tag)) {
    return tag.replace(/\bclass=(["'])[\s\S]*?\1/i, `class="${value}"`);
  }
  return tag.replace(/\s*\/?>$/, (ending) => ` class="${value}"${ending}`);
}

function upsertAttribute(tag, name, value) {
  const escaped = escapeAttribute(value);
  const pattern = new RegExp(`\\b${name}=(["'])[\\s\\S]*?\\1`, "i");
  if (pattern.test(tag)) return tag.replace(pattern, `${name}="${escaped}"`);
  return tag.replace(/\s*\/?>$/, (ending) => ` ${name}="${escaped}"${ending}`);
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slideLabel(openingTag, index) {
  return (
    attribute(openingTag, "data-label") ||
    attribute(openingTag, "data-screen-label") ||
    attribute(openingTag, "aria-label") ||
    attribute(openingTag, "data-slide") ||
    `Slide ${index + 1}`
  );
}

function semanticSlideId(openingTag, index, used) {
  const rawLabel = slideLabel(openingTag, index).replace(/^\s*\d+\s*[-.:]*\s*/, "");
  const classFallback = classNames(openingTag)
    .filter(
      (name) =>
        !["slide", "active", "is-active", "dark", "light", "grain", "hairlines"].includes(name)
    )
    .map((name) => name.replace(/^s-/, "").replace(/^s(?=\d+$)/, "slide-").replace(/^slide--?/, "").replace(/^layout-/, ""))
    .find(Boolean);
  const base = slugify(rawLabel) || slugify(classFallback) || `slide-${String(index + 1).padStart(2, "0")}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function deckStageRanges(html) {
  const ranges = [];
  const pattern = /<deck-stage\b[^>]*>[\s\S]*?<\/deck-stage>/gi;
  for (const match of html.matchAll(pattern)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function withinRanges(index, ranges) {
  return ranges.some((range) => index > range.start && index < range.end);
}

function findSlideOpenings(html) {
  const ranges = deckStageRanges(html);
  const openings = [];
  const pattern = /<(section|div)\b[^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    const openingTag = match[0];
    const tagName = match[1].toLowerCase();
    const deckStageSection =
      ranges.length > 0 && tagName === "section" && withinRanges(match.index, ranges);
    if (!hasClass(openingTag, "slide") && !deckStageSection) continue;
    openings.push({
      start: match.index,
      end: match.index + openingTag.length,
      openingTag
    });
  }
  return openings;
}

function inferLayout(openingTag, index, total) {
  const key = [
    slideLabel(openingTag, index),
    attribute(openingTag, "class"),
    attribute(openingTag, "id"),
    attribute(openingTag, "data-slide")
  ].join(" ").toLowerCase();
  if (index === 0 || /cover|hero|title/.test(key)) return "cover";
  if (index === total - 1 || /close|closing|colophon|rsvp|end/.test(key)) return "closing";
  if (/agenda|toc|contents|index|programme|program|menu/.test(key)) return "agenda";
  if (/matrix|priorit|decision|table|field/.test(key)) return "decision-matrix";
  if (/process|timeline|roadmap|workflow|framework|trajectory|plan|cycle/.test(key)) return "process";
  if (/metric|data|stat|stats|kpi|chart|financial|number|curve|bar|donut|pie/.test(key)) return "metric";
  if (/compare|comparison|split|two-col|twocol|pillar|cards|service|feature|platform|global|grid|dashboard/.test(key)) {
    return "comparison";
  }
  if (/statement|manifesto|chapter|quote|foreword|principle|idea|summary|closer|text/.test(key)) {
    return "statement";
  }
  return ["agenda", "statement", "metric", "comparison", "process", "decision-matrix"][
    (index - 1) % 6
  ];
}

function planItemCount(layout) {
  if (["cover", "statement", "closing"].includes(layout)) return 0;
  if (layout === "decision-matrix") return 4;
  if (layout === "comparison") return 3;
  return 4;
}

function ensureReducedMotion(html) {
  if (/prefers-reduced-motion/i.test(html)) return html;
  const css = `
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
      transition-duration: 0.001ms !important;
    }
  }
`;
  if (/<\/style>/i.test(html)) return html.replace(/<\/style>/i, `${css}</style>`);
  return html.replace(/<\/head>/i, `<style>${css}</style>\n</head>`);
}

function ensureTouchFallback(html) {
  if (/<deck-stage\b/i.test(html) || (/touchstart/i.test(html) && /touchend/i.test(html))) {
    return html;
  }
  const fallback = `
<script data-personal-ppt-touch-fallback>
(() => {
  let startX = null;
  document.addEventListener("touchstart", (event) => {
    startX = event.changedTouches[0]?.screenX ?? null;
  }, { passive: true });
  document.addEventListener("touchend", (event) => {
    if (startX == null) return;
    const endX = event.changedTouches[0]?.screenX ?? startX;
    const delta = endX - startX;
    startX = null;
    if (Math.abs(delta) < 50) return;
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: delta < 0 ? "ArrowRight" : "ArrowLeft",
      bubbles: true
    }));
  }, { passive: true });
})();
</script>
`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${fallback}\n</body>`);
  return `${html}\n${fallback}`;
}

function elementScanHtml(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, "<script$1></script>");
}

function hasSlideCounter(html) {
  const scanHtml = elementScanHtml(html);
  return (
    /\bid=["'][^"']*(?:counter|currentSlide|totalSlides|slide-counter)[^"']*["']/i.test(scanHtml) ||
    /class=["'][^"']*\bslide-counter\b[^"']*["']/i.test(scanHtml) ||
    /class=["'][^"']*\bpagenum\b[^"']*["']/i.test(scanHtml)
  );
}

function ensureProgressFallback(html, totalSlides) {
  if (hasSlideCounter(html)) return html;
  const total = String(totalSlides).padStart(2, "0");
  const css = `
  .personal-ppt-progress-fallback {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 1000;
    background: var(--white, #fff);
    color: var(--black, #111);
    border: var(--border, 2px solid currentColor);
    box-shadow: var(--shadow-sm, 4px 4px 0 rgba(0, 0, 0, 0.35));
    padding: 6px 12px;
    font: 800 12px/1.2 system-ui, sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    pointer-events: none;
  }
`;
  const markup = `<div class="slide-counter personal-ppt-progress-fallback" id="personalPptSlideCounter" aria-live="polite">01 / ${total}</div>`;
  const script = `
<script data-personal-ppt-progress-fallback>
(() => {
  const counter = document.getElementById("personalPptSlideCounter");
  const slides = Array.from(document.querySelectorAll(".slide"));
  if (!counter || slides.length === 0) return;
  const pad = (value) => String(value).padStart(String(slides.length).length, "0");
  const update = () => {
    const activeIndex = Math.max(
      0,
      slides.findIndex((slide) =>
        slide.classList.contains("active") ||
        slide.classList.contains("is-active") ||
        slide.hasAttribute("data-deck-active")
      )
    );
    counter.textContent = pad(activeIndex + 1) + " / " + pad(slides.length);
  };
  const observer = new MutationObserver(update);
  slides.forEach((slide) =>
    observer.observe(slide, {
      attributes: true,
      attributeFilter: ["class", "data-deck-active"]
    })
  );
  ["keydown", "click", "touchend"].forEach((type) => {
    document.addEventListener(type, () => requestAnimationFrame(update), true);
  });
  update();
})();
</script>
`;
  let updated = html;
  if (/<\/style>/i.test(updated)) updated = updated.replace(/<\/style>/i, `${css}</style>`);
  else updated = updated.replace(/<\/head>/i, `<style>${css}</style>\n</head>`);
  if (/<\/body>/i.test(updated)) {
    return updated.replace(/<\/body>/i, `${markup}\n${script}\n</body>`);
  }
  return `${updated}\n${markup}\n${script}`;
}

function removeVisibleLegalBoilerplate(html) {
  return String(html)
    .replace(
      /&copy;\s*\d{4}\s*Company Name\s*&bull;\s*All rights reserved\s*&bull;\s*Confidential\s*&amp;\s*Proprietary/gi,
      "Company Name &bull; Internal presentation"
    )
    .replace(
      /©\s*\d{4}\s*DIGITS\s*<br\s*\/?>\s*All rights reserved\.?/gi,
      "DIGITS<br />Template scaffold"
    );
}

function ensureDeckStageAttributes(html) {
  if (!/<deck-stage\b/i.test(html)) return html;
  return html.replace(/<deck-stage\b[^>]*>/i, (tag) => {
    let updated = tag;
    updated = upsertAttribute(updated, "id", "deckStage");
    updated = upsertAttribute(updated, "width", "1920");
    updated = upsertAttribute(updated, "height", "1080");
    return updated;
  });
}

function annotateTemplateHtml(html) {
  const openings = findSlideOpenings(html);
  if (openings.length < 2) {
    throw new Error("Beautiful template promotion requires at least two slide containers.");
  }

  const usedIds = new Set();
  const activeIndices = openings
    .map((opening, index) =>
      hasClass(opening.openingTag, "active") ||
      hasClass(opening.openingTag, "is-active") ||
      /\bdata-deck-active(?:\s|=|>)/i.test(opening.openingTag)
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  const activeIndex = activeIndices[0] ?? 0;
  const slides = openings.map((opening, index) => {
    const layout = inferLayout(opening.openingTag, index, openings.length);
    return {
      id: semanticSlideId(opening.openingTag, index, usedIds),
      label: slideLabel(opening.openingTag, index),
      layout,
      intent: LAYOUT_INTENTS[layout],
      itemCount: planItemCount(layout),
      styleTreatment: `${layout}-prototype-${String(index + 1).padStart(2, "0")}`
    };
  });

  let annotated = html;
  for (let index = openings.length - 1; index >= 0; index -= 1) {
    const opening = openings[index];
    const slide = slides[index];
    let updated = opening.openingTag;
    const classes = classNames(updated).filter(
      (name) => !["active", "is-active"].includes(name)
    );
    classes.push("slide");
    if (index === activeIndex) classes.push("active", "is-active");
    updated = setClassNames(updated, classes);
    updated = upsertAttribute(updated, "data-slide-id", slide.id);
    updated = upsertAttribute(updated, "data-layout", slide.layout);
    updated = upsertAttribute(updated, "data-layout-treatment", slide.styleTreatment);
    updated = upsertAttribute(updated, "data-visual-intent", slide.intent);
    updated = upsertAttribute(
      updated,
      "data-evidence-mode",
      slide.layout === "metric" ? "demonstration" : "none"
    );
    updated = upsertAttribute(updated, "data-source-claims", "");
    updated = upsertAttribute(updated, "data-plan-item-count", String(slide.itemCount));
    updated = upsertAttribute(updated, "aria-label", slide.label);
    annotated =
      annotated.slice(0, opening.start) +
      updated +
      annotated.slice(opening.end);
  }
  annotated = ensureDeckStageAttributes(annotated);
  annotated = ensureReducedMotion(annotated);
  annotated = ensureTouchFallback(annotated);
  annotated = ensureProgressFallback(annotated, slides.length);
  annotated = removeVisibleLegalBoilerplate(annotated);

  const inspected = inspectHtml(annotated);
  if (inspected.length !== slides.length) {
    throw new Error(
      `Expected ${slides.length} inspectable slides, found ${inspected.length}.`
    );
  }
  return { html: annotated, slides };
}

function paletteColors(meta) {
  const values = Object.values(meta.palette ?? {}).filter((value) =>
    /^#[0-9a-f]{3,8}$/i.test(String(value ?? ""))
  );
  return values.length > 0 ? [...new Set(values)] : ["#000000", "#ffffff"];
}

function paletteNames(meta) {
  return Object.keys(meta.palette ?? {})
    .filter((key) => key !== "description")
    .map((key) => key.replaceAll("_", "-"));
}

function typographyFamilies(meta) {
  const values = Object.entries(meta.typography ?? {})
    .filter(([key]) => key !== "style")
    .flatMap(([, value]) => String(value ?? "").split(/\s*\/\s*|\s*,\s*/))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values.length > 0 ? values : ["system-ui"])];
}

function prototypeFor(slides, layout, fallbackIndex) {
  return (
    slides.find((slide) => slide.layout === layout)?.id ??
    slides[Math.min(fallbackIndex, slides.length - 1)]?.id ??
    slides[0].id
  );
}

function buildContract({ slug, meta, slides }) {
  const fonts = typographyFamilies(meta);
  const bodyFonts = fonts.slice(-1);
  const titleFonts = fonts.slice(0, 2);
  const prototypeFallbacks = {
    cover: 0,
    statement: 2,
    agenda: 1,
    metric: 3,
    comparison: 4,
    process: 5,
    "decision-matrix": 6,
    closing: slides.length - 1
  };
  return {
    schemaVersion: 1,
    template: slug,
    deckCommands: ["add-slide", "delete-slide", "move-slide", "split-slide"],
    semanticCommands: [],
    imageAdaptation: {
      defaultFit: "contain",
      supportedFits: ["contain", "cover"],
      layoutRole: "media-layout",
      frameClass: "media-frame",
      copyClass: "media-copy",
      variants: {
        portrait: { maxAspectRatio: 0.9, mediaColumns: "1fr 1fr" },
        square: { maxAspectRatio: 1.15, mediaColumns: "1fr 1fr" },
        "landscape-standard": { maxAspectRatio: 1.5, mediaColumns: "1fr 1fr" },
        "landscape-wide": { maxAspectRatio: null, mediaColumns: "1fr 1fr" }
      }
    },
    styleConsistency: {
      allowedFontFamilies: fonts,
      typographyByRole: {
        title: { fontFamilies: titleFonts, fontWeights: [400, 500, 600, 700, 800, 900] },
        "item-title": { fontFamilies: titleFonts, fontWeights: [400, 500, 600, 700, 800, 900] },
        "item-body": { fontFamilies: bodyFonts, fontWeights: [300, 400, 500, 600] },
        metric: { fontFamilies: titleFonts, fontWeights: [400, 500, 600, 700, 800, 900] },
        label: { fontFamilies: fonts, fontWeights: [300, 400, 500, 600, 700] }
      },
      allowedColors: paletteColors(meta),
      slideInsets: {
        left: 40,
        right: 40,
        top: 40,
        bottom: 40,
        tolerance: 20
      },
      footer: {
        required: false,
        left: 0,
        right: 0,
        bottom: 0,
        fontSize: 12,
        tolerance: 20
      },
      titleByLayout: Object.fromEntries(
        PRODUCTION_LAYOUTS.map((layout) => [layout, { min: 24, max: 260 }])
      ),
      outlierExemptLayouts: PRODUCTION_LAYOUTS
    },
    typographyQuality: {
      default: {
        minFontSize: 10,
        minLineHeightRatio: 0.8,
        maxLines: 14,
        maxLineCharacters: 80,
        orphanMinCharacters: 1
      },
      roleRules: {
        title: {
          minFontSize: 18,
          minLineHeightRatio: 0.8,
          maxLines: 8,
          maxLineCharacters: 48,
          orphanMinCharacters: 1
        },
        "item-title": {
          minFontSize: 12,
          minLineHeightRatio: 0.9,
          maxLines: 5,
          maxLineCharacters: 42,
          orphanMinCharacters: 1
        },
        "item-body": {
          minFontSize: 10,
          minLineHeightRatio: 1,
          maxLines: 10,
          maxLineCharacters: 80,
          orphanMinCharacters: 1
        },
        metric: {
          minFontSize: 18,
          minLineHeightRatio: 0.75,
          maxLines: 3,
          maxLineCharacters: 18,
          orphanMinCharacters: 1
        }
      }
    },
    imageQuality: {
      maxUpscaleWarning: 1,
      maxUpscaleBlocker: 1.5,
      maxAspectDistortion: 0.03,
      minCoverVisibleFraction: 0.6
    },
    layoutQuality: {
      balance: {
        centerX: [0.03, 0.97],
        centerY: [0.03, 0.97],
        coverage: [0.05, 0.98],
        exemptLayouts: PRODUCTION_LAYOUTS
      },
      repeatedGroupsByLayout: {}
    },
    chartQuality: {
      supportedTypes: ["bar", "line", "pie"],
      requiredTitle: true,
      requiredSource: false,
      requiredPointLabels: false,
      bar: {
        requireZeroBaseline: true,
        widthTolerance: 0.05,
        requireLabels: false
      }
    },
    semanticVisualQuality: {
      layoutRules: {
        cover: {
          allowedIntents: ["opening"],
          requiredSignals: ["text"],
          primaryRoles: ["title"]
        },
        statement: {
          allowedIntents: ["key-message"],
          requiredSignals: ["text"],
          primaryRoles: ["title"]
        },
        agenda: {
          allowedIntents: ["structure-overview"],
          requiredSignals: ["text", "items"],
          primaryRoles: ["title"]
        },
        metric: {
          allowedIntents: ["quantitative-comparison"],
          requiredSignals: ["text", "number", "chart"],
          primaryRoles: ["metric", "title"]
        },
        comparison: {
          allowedIntents: ["categorical-comparison"],
          requiredSignals: ["text", "items"],
          primaryRoles: ["title"]
        },
        process: {
          allowedIntents: ["process"],
          requiredSignals: ["text", "items"],
          primaryRoles: ["title"]
        },
        "decision-matrix": {
          allowedIntents: ["prioritization"],
          requiredSignals: ["text", "items"],
          primaryRoles: ["title"]
        },
        closing: {
          allowedIntents: ["call-to-action"],
          requiredSignals: ["text"],
          primaryRoles: ["title"]
        }
      }
    },
    accessibilityQuality: {
      minContrastNormal: 3,
      minContrastLarge: 2,
      largeTextMin: 24,
      largeBoldTextMin: 18.66,
      minTextSize: 10,
      requireSlideLabel: true,
      requireImageAlt: true,
      requireRedundantColorLabels: true
    },
    layoutSelection: {
      templateSlideIds: slides.map((slide) => slide.id),
      layouts: Object.fromEntries(
        PRODUCTION_LAYOUTS.map((layout) => [
          layout,
          {
            ...LAYOUT_PROFILES[layout],
            styleTreatment: `${layout}-prototype`,
            prototypeSlide: prototypeFor(slides, layout, prototypeFallbacks[layout])
          }
        ])
      )
    },
    layouts: Object.fromEntries(
      PRODUCTION_LAYOUTS.map((layout) => [
        layout,
        {
          supportedCommands: ["set-text"],
          itemClass: null,
          minItems: 0,
          maxItems: layout === "decision-matrix" ? 4 : 8,
          coupled: ["prototype-slide", "text-fit", "layout-rhythm"],
          adaptation:
            "Use the declared prototype slide as the visual source and keep structural edits at the slide level unless a template-specific DOM contract is added."
        }
      ])
    ),
    promotion: {
      source: BEAUTIFUL_TEMPLATE_SOURCE,
      generatedAt: UPDATED_AT,
      note: "Generated conservatively from bundled template metadata. Layout mutation is limited to slide-level planning until a template-specific DOM contract is authored."
    }
  };
}

function emptyEmphasisPlan() {
  return {
    schemaVersion: 1,
    updatedAt: UPDATED_AT,
    status: "passed",
    decisions: [],
    review: {
      reviewer: "template semantic review",
      reviewedAt: UPDATED_AT,
      decisions: []
    }
  };
}

async function runtimeFiles(templateDir) {
  return existsSync(path.join(templateDir, "deck-stage.js")) ? ["deck-stage.js"] : [];
}

function buildIndexEntry({ candidate, meta, runtime }) {
  const entry = {
    id: candidate.slug,
    name: candidate.name,
    path: candidate.slug,
    source: BEAUTIFUL_TEMPLATE_SOURCE,
    scheme: candidate.scheme,
    colors: paletteNames(meta),
    mood: [...new Set([...asArray(candidate.mood), ...asArray(candidate.tone)])],
    density: normalizeDensity(meta.density),
    bestFor: asArray(meta.occasion),
    avoidFor: asArray(meta.avoid_for ?? meta.avoidFor),
    layouts: PRODUCTION_LAYOUTS,
    template: "template.html",
    design: "design.md",
    contracts: "layout-contracts.json",
    emphasisPlan: "emphasis-plan.json"
  };
  if (runtime.length > 0) entry.runtimeFiles = runtime;
  return entry;
}

async function validatePromotedTemplate({ entry, candidate }) {
  const templateDir = path.join(templatesRoot, entry.path);
  const required = [
    entry.template,
    entry.design,
    entry.contracts,
    entry.emphasisPlan,
    ...(entry.runtimeFiles ?? [])
  ];
  for (const file of required) {
    if (!existsSync(path.join(templateDir, file))) {
      throw new Error(`${entry.id}/${file} is missing.`);
    }
  }
  const html = await readFile(path.join(templateDir, entry.template), "utf8");
  if (/MIT License|Copyright \(c\) 2026 Zara Zhang/i.test(html)) {
    throw new Error(`${entry.id} includes visible third-party license text.`);
  }
  const slides = inspectHtml(html);
  if (slides.length < 2) throw new Error(`${entry.id} has no inspectable slides.`);
  const contract = JSON.parse(await readFile(path.join(templateDir, entry.contracts), "utf8"));
  assertTemplateContract(contract);
  if (contract.template !== candidate.slug) {
    throw new Error(`${entry.id} contract targets ${contract.template}.`);
  }
  const rawEmphasis = JSON.parse(await readFile(path.join(templateDir, entry.emphasisPlan), "utf8"));
  const normalized = normalizeEmphasisPlan({
    plan: rawEmphasis,
    html,
    updatedAt: rawEmphasis.updatedAt
  });
  const reviewed = applyEmphasisReview(
    normalized,
    rawEmphasis.review,
    rawEmphasis.review?.reviewedAt
  );
  if (reviewed.status !== "passed") {
    throw new Error(`${entry.id} emphasis plan has not passed review.`);
  }
}

async function promoteCandidate({ candidate, meta, runtime }) {
  const templateDir = path.join(templatesRoot, candidate.slug);
  await mkdir(templateDir, { recursive: true });
  const sourceHtml = await readFile(candidate.templatePath, "utf8");
  const annotated = annotateTemplateHtml(sourceHtml);
  const contract = buildContract({
    slug: candidate.slug,
    meta,
    slides: annotated.slides
  });
  assertTemplateContract(contract);
  const normalizedEmphasis = normalizeEmphasisPlan({
    plan: emptyEmphasisPlan(),
    html: annotated.html,
    updatedAt: UPDATED_AT
  });
  const emphasis = applyEmphasisReview(
    normalizedEmphasis,
    emptyEmphasisPlan().review,
    UPDATED_AT
  );

  await writeFile(path.join(templateDir, "template.html"), annotated.html, "utf8");
  await copyFile(candidate.designPath, path.join(templateDir, "design.md"));
  for (const runtimeFile of runtime) {
    await copyFile(
      path.join(candidate.templateDir, runtimeFile),
      path.join(templateDir, runtimeFile)
    );
  }
  await writeFile(path.join(templateDir, "layout-contracts.json"), json(contract), "utf8");
  await writeFile(path.join(templateDir, "emphasis-plan.json"), json(emphasis), "utf8");
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const libraryRoot = await resolveBeautifulLibraryRoot({
    skillRoot,
    libraryRoot: args.library
  });
  const candidates = await loadBeautifulTemplateCandidates({ skillRoot, libraryRoot });
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const existingById = new Map(index.templates.map((entry) => [entry.id, entry]));
  const nextTemplates = index.templates.filter(
    (entry) => entry.source !== BEAUTIFUL_TEMPLATE_SOURCE
  );
  const promoted = [];
  const preserved = [];

  for (const candidate of candidates) {
    const meta = JSON.parse(await readFile(candidate.metadataPath, "utf8"));
    const runtime = await runtimeFiles(candidate.templateDir);
    const existing = existingById.get(candidate.slug);
    const entry =
      existing && !args.force
        ? existing
        : buildIndexEntry({ candidate, meta, runtime });
    nextTemplates.push(entry);

    if (args.check) {
      await validatePromotedTemplate({ entry, candidate });
    } else if (!existing || args.force) {
      await promoteCandidate({ candidate, meta, runtime });
      promoted.push(candidate.slug);
    } else {
      preserved.push(candidate.slug);
    }
  }

  if (!args.check) {
    await writeFile(
      indexPath,
      json({
        version: index.version ?? 1,
        templates: nextTemplates
      }),
      "utf8"
    );
  }

  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        source: BEAUTIFUL_TEMPLATE_SOURCE,
        libraryRoot,
        mode: args.check ? "check" : "write",
        total: candidates.length,
        promoted,
        preserved
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
