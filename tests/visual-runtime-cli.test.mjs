import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(skillRoot, "scripts", "resolve-visual-runtime.mjs");
const systemChrome =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test(
  "visual runtime preflight returns a verified explicit browser without installing",
  { skip: !existsSync(systemChrome) },
  () => {
    const result = spawnSync(
      process.execPath,
      [script, "--chrome", systemChrome, "--json"],
      { encoding: "utf8", timeout: 15000 }
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "ready");
    assert.equal(output.action, "use-local-browser");
    assert.equal(output.browser.source, "explicit");
    assert.equal(output.browser.executablePath, systemChrome);
  }
);

test(
  "visual runtime preflight writes an explicit reusable runtime cache",
  { skip: !existsSync(systemChrome) },
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ppt-runtime-cache-cli-"));
    const runtimeCache = path.join(root, "runtime-cache.json");
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--chrome",
        systemChrome,
        "--runtime-cache",
        runtimeCache,
        "--json"
      ],
      { encoding: "utf8", timeout: 15000 }
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "ready");
    const cached = JSON.parse(readFileSync(runtimeCache, "utf8"));
    assert.equal(cached.executablePath, systemChrome);
    assert.equal(cached.source, "explicit");
  }
);

test("visual runtime preflight rejects a missing decision artifact", () => {
  const result = spawnSync(
    process.execPath,
    [script, "--decision", "/missing/runtime-decision.json", "--json"],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /decision.*does not exist/i);
});
