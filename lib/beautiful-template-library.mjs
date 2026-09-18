import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

export const BEAUTIFUL_TEMPLATE_SOURCE = "beautiful-html-templates";
export const THIRD_PARTY_NOTICE_FILE = "THIRD_PARTY_NOTICES.md";

function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (String(value ?? "").trim()) return [String(value).trim()];
  return [];
}

function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`Beautiful template requires ${field}.`);
  return normalized;
}

function normalizeDensity(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "high") return "dense";
  if (normalized === "medium") return "balanced";
  if (normalized === "low") return "speaker-led";
  return normalized || "balanced";
}

function tokenize(value) {
  return [
    ...new Set(
      String(value ?? "")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
    )
  ];
}

function tokenScore(tokens, fields, weight) {
  const haystack = fields.join(" ").toLowerCase();
  return tokens.reduce((score, token) => {
    if (!token) return score;
    return haystack.includes(token) ? score + weight : score;
  }, 0);
}

function overlapScore(left, right) {
  const a = new Set(asArray(left).map((item) => item.toLowerCase()));
  return asArray(right).filter((item) => a.has(item.toLowerCase())).length;
}

function candidateFromMeta(meta, libraryRoot, { bundled = false } = {}) {
  const slug = requiredText(meta.slug ?? meta.id, "slug");
  const templateDir = bundled
    ? path.join(libraryRoot, requiredText(meta.path ?? meta.id, `template "${slug}".path`))
    : path.join(libraryRoot, "templates", slug);
  const density = asArray(meta.density)[0] ?? "";
  return {
    id: `beautiful:${slug}`,
    source: BEAUTIFUL_TEMPLATE_SOURCE,
    slug,
    name: requiredText(meta.name, `template "${slug}".name`),
    tagline: String(meta.tagline ?? "").trim(),
    mood: asArray(meta.mood),
    occasion: asArray(meta.occasion ?? meta.bestFor),
    tone: asArray(meta.tone ?? meta.mood),
    formality: String(meta.formality ?? "").trim(),
    density: normalizeDensity(density),
    scheme: String(meta.scheme ?? "").trim(),
    bestFor: asArray(meta.best_for ?? meta.bestFor).join(" "),
    avoidFor: asArray(meta.avoid_for ?? meta.avoidFor).join(" "),
    slideCount: Number(meta.slide_count ?? meta.slideCount ?? 0),
    templateDir,
    templatePath: path.join(templateDir, meta.template ?? "template.html"),
    designPath: path.join(templateDir, meta.design ?? "design.md"),
    metadataPath: bundled ? path.join(libraryRoot, "index.json") : path.join(templateDir, "template.json"),
    contracts: null,
    license: {
      source: bundled
        ? path.resolve(libraryRoot, "..", "..", THIRD_PARTY_NOTICE_FILE)
        : path.join(libraryRoot, "LICENSE"),
      noticeFile: THIRD_PARTY_NOTICE_FILE,
      visibleInRenderedDeck: false
    }
  };
}

export async function resolveBeautifulLibraryRoot({
  skillRoot,
  libraryRoot = "",
  env = process.env
} = {}) {
  const candidates = [
    libraryRoot,
    env.RAY_PPT_BEAUTIFUL_LIBRARY,
    skillRoot
      ? path.join(
          skillRoot,
          "assets",
          "external",
          "beautiful-html-templates",
          "library"
        )
      : "",
    skillRoot ? path.join(skillRoot, "..", "beautiful-html-templates", "library") : ""
  ]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));

  for (const candidate of [...new Set(candidates)]) {
    if (
      existsSync(path.join(candidate, "index.json")) &&
      existsSync(path.join(candidate, "templates"))
    ) {
      return candidate;
    }
  }
  const bundledRoot = skillRoot
    ? path.join(skillRoot, "assets", "templates")
    : "";
  if (bundledRoot && existsSync(path.join(bundledRoot, "index.json"))) {
    return bundledRoot;
  }
  throw new Error(
    "Cannot find beautiful-html-templates library. Set RAY_PPT_BEAUTIFUL_LIBRARY or pass --library."
  );
}

export async function loadBeautifulTemplateCandidates({
  skillRoot,
  libraryRoot = ""
} = {}) {
  const resolvedRoot = await resolveBeautifulLibraryRoot({ skillRoot, libraryRoot });
  const index = JSON.parse(await readFile(path.join(resolvedRoot, "index.json"), "utf8"));
  if (!Array.isArray(index.templates) || index.templates.length === 0) {
    throw new Error("Beautiful template index must contain templates.");
  }
  const bundled = !existsSync(path.join(resolvedRoot, "templates"));
  const templates = bundled
    ? index.templates.filter((meta) => meta.source === BEAUTIFUL_TEMPLATE_SOURCE)
    : index.templates;
  const candidates = templates.map((meta) =>
    candidateFromMeta(meta, resolvedRoot, { bundled })
  );
  if (candidates.length === 0) {
    throw new Error("Beautiful template index must contain templates.");
  }
  const missing = candidates.filter((candidate) => !existsSync(candidate.templatePath));
  if (missing.length > 0) {
    throw new Error(
      `Beautiful template files are missing: ${missing
        .map((candidate) => candidate.slug)
        .join(", ")}`
    );
  }
  return candidates;
}

export function scoreBeautifulTemplate(
  template,
  { occasion = "", mood = "", density = "", scheme = "" } = {}
) {
  const occasionTokens = tokenize(occasion);
  const moodTokens = tokenize(mood);
  const densityValue = normalizeDensity(density);
  const schemeValue = String(scheme ?? "").trim().toLowerCase();
  let score = 0;
  score += tokenScore(occasionTokens, [template.occasion.join(" "), template.bestFor], 5);
  score += tokenScore(moodTokens, [template.mood.join(" "), template.tone.join(" "), template.tagline], 6);
  score += tokenScore(occasionTokens, [template.tagline, template.tone.join(" ")], 2);
  score += tokenScore(moodTokens, [template.bestFor, template.occasion.join(" ")], 2);
  if (densityValue && template.density === densityValue) score += 3;
  if (schemeValue && String(template.scheme).toLowerCase() === schemeValue) score += 3;
  return score;
}

export function selectBeautifulTemplateCandidates({
  templates,
  occasion = "",
  mood = "",
  density = "",
  scheme = "",
  count = 3
}) {
  if (!Array.isArray(templates) || templates.length === 0) {
    throw new Error("Template selection requires a non-empty templates array.");
  }
  const scored = templates
    .map((template) => ({
      ...template,
      score: scoreBeautifulTemplate(template, { occasion, mood, density, scheme })
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const selected = [];
  while (selected.length < Math.min(count, scored.length)) {
    let best = null;
    for (const candidate of scored) {
      if (selected.some((item) => item.slug === candidate.slug)) continue;
      const diversityPenalty = selected.reduce((penalty, chosen) => {
        const sharedMood = overlapScore(candidate.mood, chosen.mood);
        const sharedTone = overlapScore(candidate.tone, chosen.tone);
        const sameScheme = candidate.scheme && candidate.scheme === chosen.scheme ? 1 : 0;
        return penalty + sharedMood * 2 + sharedTone * 2 + sameScheme;
      }, 0);
      const adjustedScore = candidate.score - diversityPenalty;
      if (
        !best ||
        adjustedScore > best.adjustedScore ||
        (adjustedScore === best.adjustedScore &&
          candidate.score > best.candidate.score) ||
        (adjustedScore === best.adjustedScore &&
          candidate.score === best.candidate.score &&
          candidate.name.localeCompare(best.candidate.name) < 0)
      ) {
        best = { candidate, adjustedScore };
      }
    }
    selected.push(best.candidate);
  }
  return selected;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function replaceDocumentTitle(html, title) {
  const escaped = escapeHtml(title);
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escaped}</title>`);
  }
  return html.replace(/<head([^>]*)>/i, `<head$1>\n<title>${escaped}</title>`);
}

function replaceFirstTagContent(html, tagName, value) {
  if (!String(value ?? "").trim()) return { html, replaced: false };
  const pattern = new RegExp(`(<${tagName}\\b[^>]*>)[\\s\\S]*?(<\\/${tagName}>)`, "i");
  if (!pattern.test(html)) return { html, replaced: false };
  return {
    html: html.replace(pattern, `$1${escapeHtml(value)}$2`),
    replaced: true
  };
}

function ensurePreviewText(section, title, subtitle) {
  let updated = section;
  let titleResult = replaceFirstTagContent(updated, "h1", title);
  if (!titleResult.replaced) titleResult = replaceFirstTagContent(updated, "h2", title);
  updated = titleResult.html;
  if (!titleResult.replaced) {
    updated = updated.replace(/(<section\b[^>]*>)/i, `$1\n<h1>${escapeHtml(title)}</h1>`);
  }
  const subtitleResult = replaceFirstTagContent(updated, "p", subtitle);
  updated = subtitleResult.html;
  if (String(subtitle ?? "").trim() && !subtitleResult.replaced) {
    updated = updated.replace(/<\/section>\s*$/i, `<p>${escapeHtml(subtitle)}</p>\n</section>`);
  }
  return updated;
}

function removeVisibleNoticeBlocks(html) {
  return html.replace(
    /<([a-z][\w:-]*)\b[^>]*class=["'][^"']*\bcopyright\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    ""
  );
}

function keepOnlyFirstSlide(html, firstSlide) {
  const slidePattern =
    /<section\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*>[\s\S]*?<\/section>/gi;
  let replaced = false;
  return html.replace(slidePattern, () => {
    if (replaced) return "";
    replaced = true;
    return firstSlide;
  });
}

function activateSlide(section) {
  return section
    .replace(
      /(<section\b[^>]*\bclass=["'])([^"']*)(["'][^>]*>)/i,
      (_, before, classes, after) => {
        const classNames = new Set(classes.split(/\s+/).filter(Boolean));
        classNames.add("active");
        classNames.add("is-active");
        return `${before}${[...classNames].join(" ")}${after}`;
      }
    )
    .replace(/<section\b(?![^>]*\bdata-deck-active\b)/i, "<section data-deck-active");
}

export function buildTitlePreviewHtml({
  templateHtml,
  title,
  subtitle = "",
  author = "",
  date = ""
}) {
  const deckTitle = requiredText(title, "preview title");
  let html = replaceDocumentTitle(String(templateHtml ?? ""), deckTitle);
  html = removeVisibleNoticeBlocks(html);
  const slidePattern =
    /<section\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*>[\s\S]*?<\/section>/i;
  const match = html.match(slidePattern);
  if (!match) throw new Error("Template preview requires at least one .slide section.");
  let firstSlide = activateSlide(match[0]);
  firstSlide = ensurePreviewText(firstSlide, deckTitle, subtitle);
  if (String(author ?? "").trim() || String(date ?? "").trim()) {
    const meta = [author, date].map((item) => String(item ?? "").trim()).filter(Boolean).join(" / ");
    firstSlide = firstSlide.replace(
      /(<section\b[^>]*>)/i,
      `$1\n<meta name="personal-ppt-preview-meta" content="${escapeHtml(meta)}">`
    );
  }
  return keepOnlyFirstSlide(html, firstSlide);
}

async function copySupportFile(source, destination) {
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) return false;
  await copyFile(source, destination);
  return true;
}

export async function copyPreviewSupportFiles({ templateDir, libraryRoot, outDir }) {
  await mkdir(outDir, { recursive: true });
  const entries = await readdir(templateDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (["template.html", "template.json", "design.md"].includes(entry.name)) continue;
    await copySupportFile(path.join(templateDir, entry.name), path.join(outDir, entry.name));
  }
  if (!existsSync(path.join(outDir, "deck-stage.js"))) {
    await copySupportFile(
      path.join(libraryRoot, "runtime", "deck-stage.js"),
      path.join(outDir, "deck-stage.js")
    );
  }
}

export async function writeThirdPartyNotice({ libraryRoot, outDir }) {
  const licensePath = path.join(libraryRoot, "LICENSE");
  if (!existsSync(licensePath)) {
    const bundledNotice = path.resolve(
      libraryRoot,
      "..",
      "..",
      THIRD_PARTY_NOTICE_FILE
    );
    if (!existsSync(bundledNotice)) {
      throw new Error(`Third-party notice not found: ${bundledNotice}`);
    }
    const noticePath = path.join(outDir, THIRD_PARTY_NOTICE_FILE);
    await copyFile(bundledNotice, noticePath);
    return noticePath;
  }
  const license = await readFile(licensePath, "utf8");
  const content = `# Third-Party Notices

This file records license notices for template material used by generated
preview or deck files. It is not linked from rendered slide HTML and must not
be added to slide copy, cover text, speaker-facing footers, or visible
presentation chrome.

## beautiful-html-templates

Source: ${BEAUTIFUL_TEMPLATE_SOURCE}

\`\`\`text
${license.trim()}
\`\`\`
`;
  const noticePath = path.join(outDir, THIRD_PARTY_NOTICE_FILE);
  await writeFile(noticePath, content, "utf8");
  return noticePath;
}
