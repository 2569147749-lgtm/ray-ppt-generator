import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyCommands } from "../lib/deck-dom.mjs";
import {
  chooseImageLayout,
  inspectImageDimensions
} from "../lib/image-layout.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(skillRoot, "scripts");
const templatePath = path.join(
  skillRoot,
  "assets",
  "templates",
  "yellow-editorial",
  "template.html"
);
const contractsPath = path.join(
  skillRoot,
  "assets",
  "templates",
  "yellow-editorial",
  "layout-contracts.json"
);

function imageReadyHtml(html) {
  return html.replace(
    '<footer class="footer"><span>产品设计，让好的结果更容易重复。</span>',
    '<div class="media-layout" data-role="media-layout"><div class="media-copy">说明</div><figure class="media-frame"><img data-role="evidence-image" src="assets/old.png" alt="旧截图"></figure></div><footer class="footer"><span>产品设计，让好的结果更容易重复。</span>'
  );
}

function pngHeader(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, 4, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function createDeck(name = "image-deck") {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-image-test-"));
  const deck = path.join(root, name);
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      deck
    ],
    { encoding: "utf8" }
  );
  const htmlPath = path.join(deck, "index.html");
  writeFileSync(
    htmlPath,
    imageReadyHtml(readFileSync(htmlPath, "utf8")),
    "utf8"
  );
  writeFileSync(path.join(deck, "assets", "old.png"), pngHeader(1200, 900));
  return { root, deck, htmlPath };
}

test("layout contracts expose image replacement as an optional semantic command", () => {
  const contracts = JSON.parse(readFileSync(contractsPath, "utf8"));
  assert.deepEqual(contracts.semanticCommands, ["replace-image"]);
  assert.deepEqual(Object.keys(contracts.imageAdaptation.variants), [
    "portrait",
    "square",
    "landscape-standard",
    "landscape-wide"
  ]);
});

test("template provides adaptive media composition for every image ratio", () => {
  const html = readFileSync(templatePath, "utf8");
  assert.match(html, /\.media-layout\{/);
  assert.match(html, /\.media-frame\{/);
  assert.match(
    html,
    /\[data-image-layout="portrait"\] \.media-layout\{grid-template-columns:1\.35fr \.75fr/
  );
  assert.match(
    html,
    /\[data-image-layout="landscape-wide"\] \.media-layout\{grid-template-columns:\.65fr 1\.55fr/
  );
  assert.match(html, /object-fit:var\(--image-fit,contain\)/);
});

test("image dimensions select portrait, standard, and wide layout variants", () => {
  assert.deepEqual(chooseImageLayout(900, 1200), {
    width: 900,
    height: 1200,
    aspectRatio: 0.75,
    layout: "portrait"
  });
  assert.equal(chooseImageLayout(1200, 900).layout, "landscape-standard");
  assert.equal(chooseImageLayout(1600, 900).layout, "landscape-wide");
});

test("PNG dimension inspection reads the source pixels instead of its filename", () => {
  const dimensions = inspectImageDimensions(pngHeader(1600, 900), ".png");
  assert.deepEqual(dimensions, { width: 1600, height: 900 });
});

test("dimension inspection supports JPEG, GIF, WebP, and AVIF headers", () => {
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x84, 0x04, 0xb0,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00
  ]);
  const gif = Buffer.alloc(10);
  gif.write("GIF89a", 0, "ascii");
  gif.writeUInt16LE(1200, 6);
  gif.writeUInt16LE(900, 8);
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp[24] = 0x3f;
  webp[25] = 0x06;
  webp[27] = 0x83;
  webp[28] = 0x03;
  const avif = Buffer.alloc(20);
  avif.write("ispe", 4, "ascii");
  avif.writeUInt32BE(900, 12);
  avif.writeUInt32BE(1200, 16);

  assert.deepEqual(inspectImageDimensions(jpeg, ".jpg"), {
    width: 1200,
    height: 900
  });
  assert.deepEqual(inspectImageDimensions(gif, ".gif"), {
    width: 1200,
    height: 900
  });
  assert.deepEqual(inspectImageDimensions(webp, ".webp"), {
    width: 1600,
    height: 900
  });
  assert.deepEqual(inspectImageDimensions(avif, ".avif"), {
    width: 900,
    height: 1200
  });
});

test("new deck preflights user images and writes an adaptive image manifest", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-initial-images-test-"));
  const wide = path.join(root, "wide.png");
  const portrait = path.join(root, "portrait.png");
  writeFileSync(wide, pngHeader(1600, 900));
  writeFileSync(portrait, pngHeader(900, 1200));
  const requested = path.join(root, "requested-images.json");
  writeFileSync(
    requested,
    `${JSON.stringify({
      images: [
        {
          source: wide,
          assetName: "hero.png",
          alt: "产品全景",
          purpose: "首页产品截图"
        },
        {
          source: portrait,
          assetName: "portrait.png",
          alt: "用户肖像",
          purpose: "人物介绍"
        }
      ]
    })}\n`
  );
  const deck = path.join(root, "deck");

  execFileSync(
    process.execPath,
    [
      path.join(scripts, "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      deck,
      "--images",
      requested
    ],
    { encoding: "utf8" }
  );

  const manifest = JSON.parse(
    readFileSync(path.join(deck, "image-manifest.json"), "utf8")
  );
  assert.deepEqual(
    manifest.images.map(({ assetName, width, height, layout, fit }) => ({
      assetName,
      width,
      height,
      layout,
      fit
    })),
    [
      {
        assetName: "hero.png",
        width: 1600,
        height: 900,
        layout: "landscape-wide",
        fit: "contain"
      },
      {
        assetName: "portrait.png",
        width: 900,
        height: 1200,
        layout: "portrait",
        fit: "contain"
      }
    ]
  );
  assert.deepEqual(readFileSync(path.join(deck, "assets", "hero.png")), readFileSync(wide));
  assert.deepEqual(
    readFileSync(path.join(deck, "assets", "portrait.png")),
    readFileSync(portrait)
  );
});

test("new deck rejects duplicate initial asset names before creating output", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-initial-images-test-"));
  const first = path.join(root, "first.png");
  const second = path.join(root, "second.png");
  writeFileSync(first, pngHeader(1200, 900));
  writeFileSync(second, pngHeader(1600, 900));
  const requested = path.join(root, "requested-images.json");
  writeFileSync(
    requested,
    JSON.stringify({
      images: [
        { source: first, assetName: "same.png", alt: "第一张" },
        { source: second, assetName: "same.png", alt: "第二张" }
      ]
    })
  );
  const deck = path.join(root, "deck");

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "new-deck.mjs"),
      "--template",
      "yellow-editorial",
      "--unplanned-scaffold",
      "--out",
      deck,
      "--images",
      requested
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Duplicate initial image assetName "same.png"/);
  assert.equal(existsSync(deck), false);
});

test("replace-image updates image metadata and its adaptive slide layout", () => {
  const html = imageReadyHtml(readFileSync(templatePath, "utf8"));
  const result = applyCommands(html, [
    {
      id: "replace-evidence",
      command: "replace-image",
      slide: "comparison",
      target: "evidence-image",
      src: "assets/new-screen.png",
      alt: '新版 "业务" 截图',
      imageWidth: 1600,
      imageHeight: 900,
      aspectRatio: 1.7778,
      imageLayout: "landscape-wide",
      fit: "contain"
    }
  ]);

  assert.match(
    result.html,
    /data-role="evidence-image" src="assets\/new-screen\.png" alt="新版 &quot;业务&quot; 截图"[^>]*data-image-layout="landscape-wide"[^>]*data-image-fit="contain"/
  );
  assert.match(
    result.html,
    /data-slide-id="comparison"[^>]*data-image-layout="landscape-wide"[^>]*--image-aspect:1\.7778/
  );
  assert.deepEqual(result.affectedSlides, ["comparison"]);
});

test("replace-image rejects a target outside the adaptive media layout contract", () => {
  const html = readFileSync(templatePath, "utf8").replace(
    '<footer class="footer"><span>产品设计，让好的结果更容易重复。</span>',
    '<img data-role="evidence-image" src="assets/old.png" alt="旧截图"><footer class="footer"><span>产品设计，让好的结果更容易重复。</span>'
  );

  assert.throws(
    () =>
      applyCommands(html, [
        {
          id: "replace-evidence",
          command: "replace-image",
          slide: "comparison",
          target: "evidence-image",
          src: "assets/new.png",
          alt: "新版截图",
          imageWidth: 1600,
          imageHeight: 900,
          aspectRatio: 1.7778,
          imageLayout: "landscape-wide",
          fit: "contain"
        }
      ]),
    /adaptive media-layout/
  );
});

test("modify-deck copies a local image, replaces its reference, and verifies it", () => {
  const { root, deck, htmlPath } = createDeck();
  const source = path.join(root, "provided.png");
  writeFileSync(source, pngHeader(1200, 900));
  const planPath = path.join(deck, "image-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Replace the evidence image",
      changes: [
        {
          id: "replace-evidence",
          type: "asset",
          command: "replace-image",
          targets: ["comparison"],
          slide: "comparison",
          target: "evidence-image",
          source,
          assetName: "evidence.png",
          alt: "业务流程新版截图",
          request: "Replace the evidence image.",
          impact: ["asset", "crop", "accessibility"]
        }
      ]
    }),
    "utf8"
  );

  execFileSync(
    process.execPath,
    [
      path.join(scripts, "modify-deck.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--write"
    ],
    { encoding: "utf8" }
  );
  const storedPlanPath = path.join(deck, "change-plan.json");
  const verification = spawnSync(
    process.execPath,
    [
      path.join(scripts, "verify-changes.mjs"),
      "--deck",
      deck,
      "--plan",
      storedPlanPath,
      "--json"
    ],
    { encoding: "utf8" }
  );

  assert.deepEqual(
    readFileSync(path.join(deck, "assets", "evidence.png")),
    readFileSync(source)
  );
  assert.match(
    readFileSync(htmlPath, "utf8"),
    /data-role="evidence-image" src="assets\/evidence\.png" alt="业务流程新版截图"[^>]*data-image-layout="landscape-standard"/
  );
  const storedPlan = JSON.parse(readFileSync(storedPlanPath, "utf8"));
  assert.deepEqual(
    {
      width: storedPlan.changes[0].imageWidth,
      height: storedPlan.changes[0].imageHeight,
      layout: storedPlan.changes[0].imageLayout,
      fit: storedPlan.changes[0].fit
    },
    {
      width: 1200,
      height: 900,
      layout: "landscape-standard",
      fit: "contain"
    }
  );
  assert.equal(verification.status, 0, verification.stderr);
  assert.equal(JSON.parse(verification.stdout).changes[0].status, "verified");
});

test("validator rejects adaptive image metadata that disagrees with the source pixels", () => {
  const { root, deck, htmlPath } = createDeck();
  const source = path.join(root, "provided.png");
  writeFileSync(source, pngHeader(1200, 900));
  const planPath = path.join(deck, "image-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      changes: [
        {
          id: "replace-evidence",
          command: "replace-image",
          slide: "comparison",
          target: "evidence-image",
          source,
          assetName: "evidence.png",
          alt: "业务流程新版截图"
        }
      ]
    })
  );
  execFileSync(
    process.execPath,
    [
      path.join(scripts, "modify-deck.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--write"
    ],
    { encoding: "utf8" }
  );
  writeFileSync(
    htmlPath,
    readFileSync(htmlPath, "utf8").replace(
      'data-image-width="1200"',
      'data-image-width="1600"'
    )
  );

  const result = spawnSync(
    process.execPath,
    [path.join(scripts, "validate-deck.mjs"), htmlPath],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /metadata 1600x900 does not match source 1200x900/);
});

test("modify-deck does not copy an image when a later command fails", () => {
  const { root, deck, htmlPath } = createDeck();
  const source = path.join(root, "provided.png");
  writeFileSync(source, pngHeader(1600, 900));
  const projectPath = path.join(deck, "deck-project.json");
  const originalHtml = readFileSync(htmlPath, "utf8");
  const originalProject = readFileSync(projectPath, "utf8");
  const planPath = path.join(deck, "image-rollback-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      summary: "Replace then fail",
      changes: [
        {
          id: "replace-evidence",
          command: "replace-image",
          slide: "comparison",
          target: "evidence-image",
          source,
          assetName: "evidence.png",
          alt: "业务流程新版截图"
        },
        {
          id: "invalid",
          command: "set-text",
          slide: "metrics",
          target: "missing-role",
          value: "Invalid"
        }
      ]
    }),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(scripts, "modify-deck.mjs"),
      "--deck",
      deck,
      "--plan",
      planPath,
      "--write"
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-role/);
  assert.equal(readFileSync(htmlPath, "utf8"), originalHtml);
  assert.equal(readFileSync(projectPath, "utf8"), originalProject);
  assert.equal(existsSync(path.join(deck, "assets", "evidence.png")), false);
  assert.equal(existsSync(path.join(deck, "change-plan.json")), false);
});
