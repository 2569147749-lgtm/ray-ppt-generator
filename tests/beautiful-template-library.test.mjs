import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildTitlePreviewHtml,
  loadBeautifulTemplateCandidates,
  selectBeautifulTemplateCandidates
} from "../lib/beautiful-template-library.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const beautifulLibraryRoot = path.join(
  skillRoot,
  "..",
  "beautiful-html-templates",
  "library"
);
const previewScript = path.join(
  skillRoot,
  "scripts",
  "preview-template-candidates.mjs"
);

test("loads the beautiful library as non-contract preview candidates", async () => {
  const candidates = await loadBeautifulTemplateCandidates({
    skillRoot,
    libraryRoot: beautifulLibraryRoot
  });

  assert.equal(candidates.length, 34);
  assert.equal(candidates[0].source, "beautiful-html-templates");
  assert.match(candidates[0].id, /^beautiful:/);
  assert.equal(candidates[0].contracts, null);
  assert.equal(candidates[0].license.visibleInRenderedDeck, false);
  assert.ok(candidates.every((candidate) => existsSync(candidate.templatePath)));
});

test("loads bundled production templates when the external library is absent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ray-ppt-standalone-"));
  const isolatedSkillRoot = path.join(root, "ray-ppt-generator");
  mkdirSync(path.join(isolatedSkillRoot, "assets"), { recursive: true });
  cpSync(
    path.join(skillRoot, "assets", "templates"),
    path.join(isolatedSkillRoot, "assets", "templates"),
    { recursive: true }
  );
  cpSync(
    path.join(skillRoot, "THIRD_PARTY_NOTICES.md"),
    path.join(isolatedSkillRoot, "THIRD_PARTY_NOTICES.md")
  );

  const candidates = await loadBeautifulTemplateCandidates({
    skillRoot: isolatedSkillRoot
  });

  assert.equal(candidates.length, 34);
  assert.ok(candidates.every((candidate) => candidate.source === "beautiful-html-templates"));
  assert.ok(candidates.every((candidate) => existsSync(candidate.templatePath)));
});

test("selects three distinct candidates for occasion and mood", async () => {
  const candidates = await loadBeautifulTemplateCandidates({
    skillRoot,
    libraryRoot: beautifulLibraryRoot
  });

  const selected = selectBeautifulTemplateCandidates({
    templates: candidates,
    occasion: "founder pitch and product strategy review",
    mood: "confident editorial design-led",
    density: "balanced",
    scheme: "light"
  });

  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map((item) => item.slug)).size, 3);
  assert.ok(selected.some((item) => item.slug === "neo-grid-bold"));
  assert.ok(selected.every((item) => item.score > 0));
});

test("title preview uses real brief text and omits third-party notices", async () => {
  const candidates = await loadBeautifulTemplateCandidates({
    skillRoot,
    libraryRoot: beautifulLibraryRoot
  });
  const template = candidates.find((item) => item.slug === "soft-editorial");
  const html = buildTitlePreviewHtml({
    templateHtml: readFileSync(template.templatePath, "utf8"),
    title: "AI 研究平台年度汇报",
    subtitle: "从洞察生产到决策协同",
    author: "Strategy Ops",
    date: "2026-09-17"
  });

  assert.match(html, /AI 研究平台年度汇报/);
  assert.match(html, /从洞察生产到决策协同/);
  assert.doesNotMatch(html, /MIT License/);
  assert.doesNotMatch(html, /Copyright \(c\) 2026 Zara Zhang/);
  assert.equal((html.match(/class=["'][^"']*\bslide\b[^"']*["']/g) ?? []).length, 1);
});

test("preview CLI writes three personalized previews and a hidden notice", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-beautiful-preview-"));
  const requestPath = path.join(root, "request.json");
  const outputDir = path.join(root, "previews");
  writeFileSync(
    requestPath,
    JSON.stringify({
      title: "AI 研究平台年度汇报",
      subtitle: "从洞察生产到决策协同",
      author: "Strategy Ops",
      date: "2026-09-17",
      occasion: "founder pitch and product strategy review",
      mood: "confident editorial design-led",
      density: "balanced",
      scheme: "light"
    })
  );

  const result = spawnSync(
    process.execPath,
    [
      previewScript,
      "--request",
      requestPath,
      "--out",
      outputDir,
      "--library",
      beautifulLibraryRoot,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.candidates.length, 3);
  assert.equal(existsSync(path.join(outputDir, "preview-manifest.json")), true);
  assert.equal(existsSync(path.join(outputDir, "THIRD_PARTY_NOTICES.md")), true);

  const notice = readFileSync(path.join(outputDir, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notice, /MIT License/);
  assert.match(notice, /Copyright \(c\) 2026 Zara Zhang/);

  for (const candidate of report.candidates) {
    const previewHtml = readFileSync(candidate.previewPath, "utf8");
    assert.match(previewHtml, /AI 研究平台年度汇报/);
    assert.doesNotMatch(previewHtml, /MIT License/);
    assert.doesNotMatch(previewHtml, /Copyright \(c\) 2026 Zara Zhang/);
  }
});

test("standalone skill preview CLI does not require a sibling template skill", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ray-ppt-standalone-cli-"));
  const isolatedSkillRoot = path.join(root, "ray-ppt-generator");
  const requestPath = path.join(root, "request.json");
  const outputDir = path.join(root, "previews");
  cpSync(skillRoot, isolatedSkillRoot, { recursive: true });
  writeFileSync(
    requestPath,
    JSON.stringify({
      title: "Standalone Preview",
      occasion: "product strategy review",
      mood: "confident editorial",
      density: "balanced",
      scheme: "light"
    })
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(isolatedSkillRoot, "scripts", "preview-template-candidates.mjs"),
      "--request",
      requestPath,
      "--out",
      outputDir,
      "--json"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, RAY_PPT_BEAUTIFUL_LIBRARY: "" }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.candidates.length, 3);
  assert.equal(existsSync(report.noticePath), true);
  assert.ok(report.candidates.every((candidate) => existsSync(candidate.previewPath)));
});
