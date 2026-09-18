import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedName = "ray-ppt-generator";
const legacyName = ["personal", "ppt", "generator"].join("-");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filePath);
    if (!entry.isFile() || !/\.(?:md|mjs|json)$/.test(entry.name)) return [];
    return [filePath];
  });
}

test("skill directory and frontmatter use the published name", () => {
  assert.equal(path.basename(skillRoot), expectedName);
  const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, new RegExp(`^---\\nname: ${expectedName}\\n`, "m"));
});

test("published sources do not retain the legacy skill identity", () => {
  const stale = sourceFiles(skillRoot)
    .filter((filePath) => filePath !== fileURLToPath(import.meta.url))
    .filter((filePath) => statSync(filePath).size < 2_000_000)
    .flatMap((filePath) => {
      const content = readFileSync(filePath, "utf8").toLowerCase();
      return content.includes(legacyName) ||
        content.includes("personal ppt generator") ||
        content.includes("personal_ppt_") ||
        /(^|[^a-z0-9_])ppt_browser_/.test(content)
        ? [path.relative(skillRoot, filePath)]
        : [];
    });

  assert.deepEqual(stale, []);
});
