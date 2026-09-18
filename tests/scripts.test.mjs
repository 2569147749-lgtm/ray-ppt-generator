import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionScript = path.join(skillRoot, "scripts", "version-deck.mjs");
const validateScript = path.join(skillRoot, "scripts", "validate-deck.mjs");
const verifyDraftScript = path.join(skillRoot, "scripts", "verify-draft.mjs");

function makeTempDeck() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-skill-test-"));
  const deck = path.join(root, "product-deck");
  mkdirSync(path.join(deck, "assets"), { recursive: true });
  writeFileSync(path.join(deck, "index.html"), validDeckHtml(), "utf8");
  writeFileSync(path.join(deck, "assets", "screen.png"), "image", "utf8");
  return { root, deck };
}

function validDeckHtml(slides = "") {
  return `<!doctype html>
<html>
<head><title>Test deck</title><style>
.deck-stage{width:1920px;height:1080px}
@media (prefers-reduced-motion: reduce){}
</style></head>
<body>
<main id="deckStage">
${slides || `
<section class="slide active" id="cover" aria-label="Cover"></section>
<section class="slide" id="end" aria-label="End"></section>`}
</main>
<button id="prev"></button><button id="next"></button>
<span id="counter"></span><span id="progress"></span>
<script>const keys=["ArrowRight","ArrowLeft"]; addEventListener("touchstart",()=>{}); addEventListener("touchend",()=>{});</script>
</body></html>`;
}

test("version script creates incrementing copies and preserves the source", () => {
  const { deck } = makeTempDeck();
  const original = readFileSync(path.join(deck, "index.html"), "utf8");

  const firstOutput = execFileSync(
    process.execPath,
    [versionScript, deck, "--label", "three-node-flow"],
    { encoding: "utf8" }
  );
  const firstPath = firstOutput.trim().split("\n").at(-1);

  assert.match(firstPath, /product-deck-v001-three-node-flow$/);
  assert.equal(readFileSync(path.join(deck, "index.html"), "utf8"), original);
  assert.equal(readFileSync(path.join(firstPath, "index.html"), "utf8"), original);

  const revision = JSON.parse(readFileSync(path.join(firstPath, "revision.json"), "utf8"));
  assert.equal(revision.version, 1);
  assert.equal(revision.label, "three-node-flow");
  assert.equal(revision.source, deck);

  const secondOutput = execFileSync(
    process.execPath,
    [versionScript, deck, "--label", "shorter-copy"],
    { encoding: "utf8" }
  );
  assert.match(secondOutput.trim().split("\n").at(-1), /product-deck-v002-shorter-copy$/);
});

test("validator rejects duplicate ids", () => {
  const { deck } = makeTempDeck();
  writeFileSync(
    path.join(deck, "index.html"),
    validDeckHtml(`
<section class="slide active" id="same" aria-label="First"></section>
<section class="slide" id="same" aria-label="Second"></section>`),
    "utf8"
  );

  const result = spawnSync(process.execPath, [validateScript, path.join(deck, "index.html")], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Duplicate id: same/);
});

test("validator rejects multiple initially active slides", () => {
  const { deck } = makeTempDeck();
  writeFileSync(
    path.join(deck, "index.html"),
    validDeckHtml(`
<section class="slide active" id="first" aria-label="First"></section>
<section class="slide active" id="second" aria-label="Second"></section>`),
    "utf8"
  );

  const result = spawnSync(process.execPath, [validateScript, path.join(deck, "index.html")], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected exactly one initially active slide/);
});

test("validator rejects images without alt text", () => {
  const { deck } = makeTempDeck();
  writeFileSync(
    path.join(deck, "index.html"),
    validDeckHtml(`
<section class="slide active" id="first" aria-label="First"><img src="assets/screen.png"></section>
<section class="slide" id="second" aria-label="Second"></section>`),
    "utf8"
  );

  const result = spawnSync(process.execPath, [validateScript, path.join(deck, "index.html")], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Image is missing alt text/);
});

test("validator rejects an incomplete template quality contract", () => {
  const { deck } = makeTempDeck();
  writeFileSync(
    path.join(deck, "layout-contracts.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        template: "incomplete",
        layouts: {
          unknown: {
            supportedCommands: ["set-text"],
            itemClass: null,
            minItems: 0,
            maxItems: 0,
            coupled: [],
            adaptation: "Keep content readable."
          }
        }
      },
      null,
      2
    )}\n`
  );

  const result = spawnSync(
    process.execPath,
    [validateScript, path.join(deck, "index.html")],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid template contract/);
  assert.match(result.stderr, /chartQuality/);
});

test("verify-draft aggregates inspect and available static verification steps", () => {
  const { deck } = makeTempDeck();
  const result = spawnSync(
    process.execPath,
    [verifyDraftScript, "--deck", deck, "--write", "--json"],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "passed");
  assert.equal(report.steps.inspect.status, "passed");
  assert.equal(report.steps.staticValidation.status, "passed");
  assert.equal(report.steps.deckPlan.status, "skipped");
  assert.equal(report.steps.changeVerification.status, "skipped");
  assert.ok(report.steps.inspect.slideCount >= 2);
  assert.equal(
    JSON.parse(readFileSync(path.join(deck, "draft-verification.json"), "utf8"))
      .status,
    "passed"
  );
});
