#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const source = process.argv[2];
  if (!source || process.argv.length > 3) {
    console.error("Usage: node scripts/restore-version.mjs /path/to/old-version");
    process.exitCode = 1;
    return;
  }

  const output = execFileSync(
    process.execPath,
    [
      path.join(scriptDir, "version-deck.mjs"),
      source,
      "--label",
      "restored",
      "--restored-from",
      source
    ],
    { encoding: "utf8" }
  );
  process.stdout.write(output);
}

main().catch((error) => {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
});
