import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ITEM_CLASSES = {
  agenda: "agenda-row",
  metric: "bar-row",
  comparison: "comparison-col",
  process: "step",
  "decision-matrix": "quadrant"
};
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1] ?? "";
}

function classNames(tag) {
  return attribute(tag, "class").split(/\s+/).filter(Boolean);
}

export function tagHasClass(tag, className) {
  return classNames(tag).includes(className);
}

export function extractSlideSections(html) {
  const source = String(html);
  const slides = [];
  const openingPattern = /<([a-z][\w:-]*)\b[^>]*>/gi;
  for (const match of source.matchAll(openingPattern)) {
    const openingTag = match[0];
    if (!tagHasClass(openingTag, "slide")) continue;
    slides.push({
      openingTag,
      tagName: match[1].toLowerCase(),
      start: match.index,
      bodyStart: match.index + openingTag.length
    });
  }
  return slides.map((slide, index) => {
    const range = findElementRangeFromOpening(source, slide);
    return {
      ...slide,
      closeStart: range.closeStart,
      end: range.end,
      html: source.slice(slide.start, range.end),
      body: source.slice(slide.bodyStart, range.closeStart)
    };
  });
}

function findElementRangeFromOpening(html, opening) {
  if (/\/>$/.test(opening.openingTag) || VOID_ELEMENTS.has(opening.tagName)) {
    return { closeStart: opening.bodyStart, end: opening.bodyStart };
  }

  const pattern = new RegExp(`</?${escapeRegExp(opening.tagName)}\\b[^>]*>`, "gi");
  pattern.lastIndex = opening.bodyStart;
  let depth = 1;
  let match;
  while ((match = pattern.exec(html))) {
    if (match[0].startsWith("</")) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) {
      return {
        closeStart: match.index,
        end: match.index + match[0].length
      };
    }
  }
  throw new Error(`Unclosed <${opening.tagName}> slide element.`);
}

function countClass(html, className) {
  return [...html.matchAll(/\bclass=["']([^"']+)["']/g)].filter((match) =>
    match[1].split(/\s+/).includes(className)
  ).length;
}

function plainText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function slideTitle(section, openingTag) {
  const heading = section.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i)?.[1];
  if (heading) return plainText(heading);
  return attribute(openingTag, "aria-label");
}

function slideAssets(section) {
  return [
    ...new Set(
      [...section.matchAll(/\b(?:src|poster)=["']([^"']+)["']/gi)].map(
        (match) => match[1]
      )
    )
  ];
}

function contentFingerprint(section) {
  return section
    .replace(
      /(<([a-z][\w:-]*)\b[^>]*\bdata-role=["']page-number["'][^>]*>)[\s\S]*?(<\/\2>)/gi,
      "$1__PAGE_NUMBER__$3"
    )
    .replace(
      /(<[a-z][\w:-]*\b[^>]*\bclass=["'])([^"']*)(["'][^>]*>)/i,
      (_, before, classes, after) =>
        `${before}${classes
          .split(/\s+/)
          .filter((name) => name && name !== "active")
          .join(" ")}${after}`
    );
}

export async function resolveDeck(input) {
  const resolved = path.resolve(input);
  if (!existsSync(resolved)) throw new Error(`Deck does not exist: ${resolved}`);
  const info = await stat(resolved);
  const deckDir = info.isDirectory() ? resolved : path.dirname(resolved);
  const htmlPath = info.isDirectory() ? path.join(resolved, "index.html") : resolved;
  if (!existsSync(htmlPath)) {
    throw new Error(`Deck folder must contain index.html: ${deckDir}`);
  }
  return { deckDir, htmlPath };
}

export function inspectHtml(html) {
  const slides = extractSlideSections(html).map((slide, index) => {
    const openingTag = slide.openingTag;
    const section = slide.html;
    const id =
      attribute(openingTag, "data-slide-id") ||
      attribute(openingTag, "id") ||
      attribute(openingTag, "data-slide");
    const layout = attribute(openingTag, "data-layout") || "unknown";
    if (!id) {
      throw new Error(
        `Slide ${index + 1} must define data-slide-id, id, or data-slide.`
      );
    }

    const itemClass = ITEM_CLASSES[layout];
    return {
      id,
      layout,
      title: slideTitle(section, openingTag),
      itemCount: itemClass ? countClass(section, itemClass) : 0,
      assets: slideAssets(section),
      hash: createHash("sha256").update(contentFingerprint(section)).digest("hex")
    };
  });

  const duplicateIds = slides
    .map((slide) => slide.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length) {
    throw new Error(`Duplicate slide id: ${[...new Set(duplicateIds)].join(", ")}`);
  }
  return slides;
}

export async function inspectDeck(input) {
  const { deckDir, htmlPath } = await resolveDeck(input);
  const html = await readFile(htmlPath, "utf8");
  return { deckDir, htmlPath, slides: inspectHtml(html) };
}

export async function readProject(deckDir) {
  const projectPath = path.join(deckDir, "deck-project.json");
  if (!existsSync(projectPath)) return null;
  return JSON.parse(await readFile(projectPath, "utf8"));
}

export async function writeProject(deckDir, project) {
  const projectPath = path.join(deckDir, "deck-project.json");
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  return projectPath;
}

export function createProject({ template, slides, createdAt = new Date().toISOString() }) {
  return {
    schemaVersion: 1,
    template,
    entry: "index.html",
    currentVersion: 0,
    createdAt,
    updatedAt: createdAt,
    slides,
    history: []
  };
}

export function plannedTargets(plan) {
  return [
    ...new Set((plan.changes ?? []).flatMap((change) => change.targets ?? []))
  ].sort();
}
