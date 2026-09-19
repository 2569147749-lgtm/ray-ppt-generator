import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { buildBrowserLaunchOptions } from "./system-browser-discovery.mjs";
import {
  CdpPipeClient,
  CdpSessionClient,
  CdpWebSocketClient,
  retryCdpConnection,
  verifyCdpClient
} from "./cdp-transport.mjs";

export const VISUAL_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 }
];

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function addNeighboringSlides(selected, slides, slideId) {
  const index = slides.findIndex((slide) => slide.id === slideId);
  if (index < 0) return false;
  for (const neighbor of slides.slice(Math.max(0, index - 1), index + 2)) {
    selected.add(neighbor.id);
  }
  return true;
}

export function selectVisualSlides({ sourceSlides = [], revisedSlides, plan = null }) {
  if (!plan) return revisedSlides.map((slide) => slide.id);

  const selected = new Set();
  const targets = [
    ...new Set((plan.changes ?? []).flatMap((change) => change.targets ?? []))
  ];
  for (const target of targets) {
    if (addNeighboringSlides(selected, revisedSlides, target)) continue;

    const sourceIndex = sourceSlides.findIndex((slide) => slide.id === target);
    if (sourceIndex < 0) continue;
    for (let distance = 1; distance < sourceSlides.length; distance += 1) {
      const candidates = [
        sourceSlides[sourceIndex - distance],
        sourceSlides[sourceIndex + distance]
      ].filter(Boolean);
      for (const candidate of candidates) {
        if (revisedSlides.some((slide) => slide.id === candidate.id)) {
          selected.add(candidate.id);
        }
      }
      if (candidates.some((candidate) => selected.has(candidate.id))) break;
    }
  }

  if (sourceSlides.length !== revisedSlides.length && revisedSlides.length > 0) {
    selected.add(revisedSlides[0].id);
    selected.add(revisedSlides.at(-1).id);
  }

  return revisedSlides
    .map((slide) => slide.id)
    .filter((slideId) => selected.has(slideId));
}

function reviewFindingReason(finding) {
  if (finding?.severity === "blocker") return "blocker";
  if (finding?.severity === "warning") return "warning";
  if (finding?.confidence === "low") return "low-confidence";
  return "finding";
}

function addAbnormalItem(captureScopes, captureId, item) {
  const scope = captureScopes.get(captureId);
  if (!scope) return false;
  scope.items.push(item);
  if (!scope.reasons.includes(item.reason)) scope.reasons.push(item.reason);
  return true;
}

function captureIdsForFinding(captures, finding) {
  if (finding?.capture && captures.some((capture) => capture.id === finding.capture)) {
    return [finding.capture];
  }
  if (!finding?.slide) return [];
  const matched = captures.filter((capture) => capture.slide === finding.slide);
  const desktop = matched.filter((capture) => capture.viewport === "desktop");
  return (desktop.length > 0 ? desktop : matched).map((capture) => capture.id);
}

function scopedFinding(finding, source, capture = null) {
  return {
    source,
    code: finding?.code ?? source,
    severity: finding?.severity ?? null,
    reason: reviewFindingReason(finding),
    slide: finding?.slide ?? capture?.slide ?? null,
    capture: capture?.id ?? finding?.capture ?? null,
    message: finding?.message ?? "",
    selectors: finding?.selectors ?? []
  };
}

export function buildVisualReviewScope(report) {
  const captures = report.captures ?? [];
  const captureScopes = new Map(
    captures.map((capture) => [
      capture.id,
      {
        id: capture.id,
        slide: capture.slide,
        slideNumber: capture.slideNumber,
        viewport: capture.viewport,
        file: capture.file,
        reasons: [],
        items: []
      }
    ])
  );
  const unassignedItems = [];

  for (const capture of captures) {
    if (capture.error) {
      addAbnormalItem(captureScopes, capture.id, {
        source: "capture",
        code: "capture-error",
        severity: "blocker",
        reason: "capture-error",
        slide: capture.slide,
        capture: capture.id,
        message: capture.error,
        selectors: []
      });
    }
    if (capture.valid === false) {
      addAbnormalItem(captureScopes, capture.id, {
        source: "capture",
        code: "invalid-capture",
        severity: "blocker",
        reason: "invalid-capture",
        slide: capture.slide,
        capture: capture.id,
        message: "Capture did not satisfy dimensions, nonblank, and automated checks.",
        selectors: []
      });
    }
    if (capture.automatedPassed === false) {
      addAbnormalItem(captureScopes, capture.id, {
        source: "capture",
        code: "automated-check-failed",
        severity: "blocker",
        reason: "automated-check-failed",
        slide: capture.slide,
        capture: capture.id,
        message: "Automated capture checks failed.",
        selectors: []
      });
    }
    for (const finding of capture.findings ?? []) {
      if (
        !["blocker", "warning"].includes(finding.severity) &&
        finding.confidence !== "low"
      ) {
        continue;
      }
      addAbnormalItem(
        captureScopes,
        capture.id,
        scopedFinding(finding, "capture", capture)
      );
    }
    if (capture.visualDiff?.status === "unexpected-change") {
      addAbnormalItem(captureScopes, capture.id, {
        source: "visual-diff",
        code: "unexpected-visual-change",
        severity: "blocker",
        reason: "unexpected-visual-change",
        slide: capture.slide,
        capture: capture.id,
        message: "Protected slide differs materially from its source version.",
        selectors: []
      });
    }
  }

  for (const source of [
    ["styleConsistency", report.styleConsistency?.findings ?? []],
    ["fontContinuity", report.fontContinuity?.findings ?? []],
    ["visualQuality", report.visualQuality?.findings ?? []],
    ["semanticEmphasis", report.semanticEmphasis?.findings ?? []]
  ]) {
    const [sourceName, findings] = source;
    for (const finding of findings) {
      if (
        !["blocker", "warning"].includes(finding.severity) &&
        finding.confidence !== "low"
      ) {
        continue;
      }
      const ids = captureIdsForFinding(captures, finding);
      if (ids.length === 0) {
        unassignedItems.push(scopedFinding(finding, sourceName));
        continue;
      }
      for (const id of ids) {
        addAbnormalItem(captureScopes, id, scopedFinding(finding, sourceName));
      }
    }
  }

  const scopedCaptures = [...captureScopes.values()];
  const requiredCaptureIds = scopedCaptures
    .filter((capture) => capture.items.length > 0)
    .map((capture) => capture.id);
  return {
    mode: "abnormal-only",
    requiredCaptureIds,
    abnormalCaptureCount: requiredCaptureIds.length,
    abnormalItemCount:
      scopedCaptures.reduce(
        (total, capture) => total + capture.items.length,
        0
      ) + unassignedItems.length,
    captures: scopedCaptures,
    unassignedItems
  };
}

export function buildVisualContactSheetHtml({ report, viewport = "desktop" }) {
  const scope = report.reviewScope ?? buildVisualReviewScope(report);
  const scopedById = new Map(scope.captures.map((capture) => [capture.id, capture]));
  const captures = (report.captures ?? []).filter(
    (capture) => capture.viewport === viewport
  );
  const cards = captures
    .map((capture) => {
      const scoped = scopedById.get(capture.id);
      const abnormal = scoped?.items?.length > 0;
      const reasons = scoped?.reasons?.join(", ") || "normal";
      const findings = (scoped?.items ?? [])
        .map(
          (item) =>
            `<li><strong>${htmlEscape(item.code)}</strong> ${htmlEscape(item.message)}</li>`
        )
        .join("");
      return `<article class="capture ${abnormal ? "abnormal" : "normal"}">
  <header>
    <span>${htmlEscape(capture.slideNumber ? `#${capture.slideNumber}` : "")}</span>
    <strong>${htmlEscape(capture.slide)}</strong>
    <em>${htmlEscape(reasons)}</em>
  </header>
  <img src="${htmlEscape(path.basename(capture.file ?? ""))}" alt="${htmlEscape(capture.id)}">
  ${findings ? `<ul>${findings}</ul>` : ""}
</article>`;
    })
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Visual Audit Contact Sheet - ${htmlEscape(viewport)}</title>
  <style>
    body{margin:0;padding:24px;background:#f6f4ed;color:#20211d;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    h1{margin:0 0 6px;font-size:24px}
    .meta{margin:0 0 20px;color:#5b5c54}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
    .capture{background:#fffef8;border:1px solid #d8d1bf;padding:10px}
    .capture.abnormal{border:3px solid #c73a2f}
    header{display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:baseline;margin-bottom:8px}
    header em{grid-column:1/-1;color:#6b6d61;font-style:normal}
    img{display:block;width:100%;aspect-ratio:16/10;object-fit:contain;background:#222}
    ul{margin:8px 0 0 18px;padding:0;color:#4e332f}
  </style>
</head>
<body>
  <h1>Visual Audit Contact Sheet</h1>
  <p class="meta">${htmlEscape(captures.length)} ${htmlEscape(viewport)} captures, ${htmlEscape(scope.abnormalCaptureCount)} abnormal captures, ${htmlEscape(scope.abnormalItemCount)} abnormal items.</p>
  <section class="grid">
${cards}
  </section>
</body>
</html>
`;
}

export function applyVisualReview(report, review, reviewedAt = new Date().toISOString()) {
  if (!review.reviewer?.trim()) {
    throw new Error("Visual review requires a non-empty reviewer.");
  }
  if (review.mode === "abnormal-only") {
    const contactSheetStatus = review.contactSheet?.status;
    if (!["pass", "fail"].includes(contactSheetStatus)) {
      throw new Error("Abnormal-only visual review requires a pass/fail contactSheet status.");
    }
    if (contactSheetStatus === "fail" && !String(review.contactSheet?.notes ?? "").trim()) {
      throw new Error("Failed contact sheet review requires notes.");
    }
  }
  const scope =
    review.mode === "abnormal-only" ? buildVisualReviewScope(report) : null;
  const expected = new Set(
    review.mode === "abnormal-only"
      ? scope.requiredCaptureIds
      : report.captures.map((capture) => capture.id)
  );
  const allCaptureIds = new Set(report.captures.map((capture) => capture.id));
  const received = new Map();
  for (const item of review.captures ?? []) {
    if (!allCaptureIds.has(item.id)) throw new Error(`Unknown visual capture in review: ${item.id}`);
    if (received.has(item.id)) throw new Error(`Duplicate visual review: ${item.id}`);
    if (!["pass", "fail"].includes(item.status)) {
      throw new Error(`Visual review "${item.id}" must be pass or fail.`);
    }
    received.set(item.id, {
      id: item.id,
      status: item.status,
      notes: String(item.notes ?? "")
    });
  }
  const missing = [...expected].filter((id) => !received.has(id));
  if (missing.length > 0) {
    throw new Error(`Visual review is missing captures: ${missing.join(", ")}`);
  }

  const reviews = report.captures.map((capture) => {
    const explicit = received.get(capture.id);
    if (explicit) return { ...explicit, autoPassed: false };
    return {
      id: capture.id,
      status: "pass",
      notes: "Auto-passed because no abnormal visual evidence was detected for this capture.",
      autoPassed: true
    };
  });
  const passed =
    (review.mode !== "abnormal-only" || review.contactSheet.status === "pass") &&
    reviews.every((item) => item.status === "pass");
  return {
    ...report,
    status: passed ? "passed" : "failed",
    updatedAt: reviewedAt,
    review: {
      reviewer: review.reviewer.trim(),
      reviewedAt,
      mode: review.mode ?? "complete",
      ...(scope ? { scope } : {}),
      ...(review.contactSheet
        ? {
            contactSheet: {
              status: review.contactSheet.status,
              file: review.contactSheet.file ?? null,
              notes: String(review.contactSheet.notes ?? "")
            }
          }
        : {}),
      captures: reviews
    }
  };
}

function intersection(first, second) {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

function outsideBy(rect, bounds) {
  return {
    left: Math.max(0, bounds.left - rect.left),
    top: Math.max(0, bounds.top - rect.top),
    right: Math.max(0, rect.right - bounds.right),
    bottom: Math.max(0, rect.bottom - bounds.bottom)
  };
}

function hasOutsideDistance(distances, tolerance = 1) {
  return Object.values(distances).some((distance) => distance > tolerance);
}

function segmentIntersectsRect(line, rect) {
  if (!line.start || !line.end) {
    const crossed = intersection(line.rect, rect);
    return crossed.width > 0.25 && crossed.height > 0.25;
  }
  const padding = Math.max(0.5, Number(line.thickness ?? 1) / 2);
  const bounds = {
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding
  };
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const p = [-dx, dx, -dy, dy];
  const q = [
    line.start.x - bounds.left,
    bounds.right - line.start.x,
    line.start.y - bounds.top,
    bounds.bottom - line.start.y
  ];
  let start = 0;
  let end = 1;
  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index] < 0) return false;
      continue;
    }
    const ratio = q[index] / p[index];
    if (p[index] < 0) start = Math.max(start, ratio);
    else end = Math.min(end, ratio);
    if (start > end) return false;
  }
  return true;
}

export function analyzeVisualGeometry(snapshot) {
  const findings = [];
  const elements = (snapshot.elements ?? []).filter((element) => !element.hidden);
  const textElements = elements.filter((element) => element.kind === "text");

  for (const element of elements) {
    const overflowX = Number(element.overflowX ?? 0);
    const overflowY = Number(element.overflowY ?? 0);
    if (
      element.kind === "text" &&
      !element.allowOverflow &&
      element.clipsOverflow !== false &&
      (overflowX > 1 || overflowY > 1)
    ) {
      findings.push({
        code: "text-overflow",
        severity: "blocker",
        selectors: [element.selector],
        rect: element.rect,
        overflow: { x: overflowX, y: overflowY },
        ...(element.autoFix ? { autoFix: element.autoFix } : {}),
        message: `${element.selector} has clipped or overflowing text.`
      });
    }

    if (!element.allowBounds) {
      const outside = outsideBy(element.rect, snapshot.slide);
      if (hasOutsideDistance(outside)) {
        findings.push({
          code: "slide-overflow",
          severity: "blocker",
          selectors: [element.selector],
          rect: element.rect,
          outside,
          message: `${element.selector} extends outside the authored slide.`
        });
      }
    }
  }

  for (let firstIndex = 0; firstIndex < elements.length; firstIndex += 1) {
    const first = elements[firstIndex];
    if (first.allowOverlap) continue;
    const firstRects = first.textRects?.length > 0 ? first.textRects : [first.rect];
    for (let secondIndex = firstIndex + 1; secondIndex < elements.length; secondIndex += 1) {
      const second = elements[secondIndex];
      if (
        second.allowOverlap ||
        (first.nodeId !== undefined && first.nodeId === second.nodeId) ||
        (second.nodeId !== undefined && first.ancestors?.includes(second.nodeId)) ||
        (first.nodeId !== undefined && second.ancestors?.includes(first.nodeId))
      ) {
        continue;
      }
      const secondRects = second.textRects?.length > 0 ? second.textRects : [second.rect];
      const overlap = firstRects
        .flatMap((firstRect) =>
          secondRects.map((secondRect) => intersection(firstRect, secondRect))
        )
        .find((candidate) => candidate.width > 6 && candidate.height > 6);
      if (!overlap) continue;
      findings.push({
        code: "element-overlap",
        severity: "blocker",
        selectors: [first.selector, second.selector],
        rect: overlap,
        message: `${first.selector} overlaps ${second.selector}.`
      });
    }
  }

  for (const line of snapshot.lines ?? []) {
    if (line.allowed) continue;
    for (const element of textElements) {
      if (element.allowLine) continue;
      const textRect = (
        element.textRects?.length > 0 ? element.textRects : [element.rect]
      ).find((candidate) => segmentIntersectsRect(line, candidate));
      if (!textRect) continue;
      findings.push({
        code: "line-through-text",
        severity: "blocker",
        selectors: [line.selector, element.selector],
        rect: intersection(line.rect, textRect),
        orientation: line.orientation,
        message: `${line.selector} crosses text in ${element.selector}.`
      });
    }
  }

  return findings;
}

function paeth(a, b, c) {
  const prediction = a + b - c;
  const distanceA = Math.abs(prediction - a);
  const distanceB = Math.abs(prediction - b);
  const distanceC = Math.abs(prediction - c);
  if (distanceA <= distanceB && distanceA <= distanceC) return a;
  return distanceB <= distanceC ? b : c;
}

function decodeScanlines(data, width, height, bytesPerPixel) {
  const rowLength = width * bytesPerPixel;
  const pixels = Buffer.alloc(rowLength * height);
  let inputOffset = 0;

  for (let row = 0; row < height; row += 1) {
    const filter = data[inputOffset];
    inputOffset += 1;
    const rowOffset = row * rowLength;
    for (let column = 0; column < rowLength; column += 1) {
      const raw = data[inputOffset + column];
      const left = column >= bytesPerPixel ? pixels[rowOffset + column - bytesPerPixel] : 0;
      const above = row > 0 ? pixels[rowOffset - rowLength + column] : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? pixels[rowOffset - rowLength + column - bytesPerPixel]
          : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + Math.floor((left + above) / 2);
      else if (filter === 4) value = raw + paeth(left, above, upperLeft);
      else throw new Error(`Unsupported PNG filter ${filter}.`);
      pixels[rowOffset + column] = value & 0xff;
    }
    inputOffset += rowLength;
  }
  return pixels;
}

function decodePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("Screenshot is not a valid PNG.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const imageData = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }

  if (!width || !height || imageData.length === 0) {
    throw new Error("Screenshot PNG is missing image data.");
  }
  if (bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG format: bit depth ${bitDepth}, color type ${colorType}.`);
  }

  const bytesPerPixel = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const pixels = decodeScanlines(
    inflateSync(Buffer.concat(imageData)),
    width,
    height,
    bytesPerPixel
  );
  return { width, height, colorType, bytesPerPixel, pixels };
}

function readPixel(image, x, y) {
  const offset = (y * image.width + x) * image.bytesPerPixel;
  const red = image.pixels[offset];
  const green =
    image.colorType === 0 || image.colorType === 4 ? red : image.pixels[offset + 1];
  const blue =
    image.colorType === 0 || image.colorType === 4 ? red : image.pixels[offset + 2];
  const alpha =
    image.colorType === 4
      ? image.pixels[offset + 1]
      : image.colorType === 6
        ? image.pixels[offset + 3]
        : 255;
  return [red, green, blue, alpha];
}

function averageColor(image, points) {
  const totals = [0, 0, 0, 0];
  for (const [x, y] of points) {
    const color = readPixel(image, x, y);
    for (let channel = 0; channel < 4; channel += 1) totals[channel] += color[channel];
  }
  return totals.map((total) => total / points.length);
}

function colorDistance(first, second) {
  return Math.sqrt(
    (first[0] - second[0]) ** 2 +
      (first[1] - second[1]) ** 2 +
      (first[2] - second[2]) ** 2
  );
}

function stripePoints(region, edge, start, thickness) {
  const points = [];
  const longStep = Math.max(1, Math.floor((edge === "left" || edge === "right" ? region.height : region.width) / 240));
  if (edge === "left" || edge === "right") {
    const xStart =
      edge === "left" ? region.left + start : region.right - start - thickness;
    for (let y = region.top; y < region.bottom; y += longStep) {
      for (let x = xStart; x < xStart + thickness; x += 1) points.push([x, y]);
    }
  } else {
    const yStart =
      edge === "top" ? region.top + start : region.bottom - start - thickness;
    for (let x = region.left; x < region.right; x += longStep) {
      for (let y = yStart; y < yStart + thickness; y += 1) points.push([x, y]);
    }
  }
  return points;
}

function stripeContrastRatio(image, region, edge, thickness, bandColor) {
  const vertical = edge === "left" || edge === "right";
  const longLength = vertical ? region.height : region.width;
  const step = Math.max(1, Math.floor(longLength / 240));
  let contrasted = 0;
  let sampled = 0;
  for (let position = 0; position < longLength; position += step) {
    const referencePoints = [];
    for (let depth = thickness + 2; depth < thickness + 4; depth += 1) {
      const x = vertical
        ? edge === "left"
          ? region.left + depth
          : region.right - depth - 1
        : region.left + position;
      const y = vertical
        ? region.top + position
        : edge === "top"
          ? region.top + depth
          : region.bottom - depth - 1;
      referencePoints.push([x, y]);
    }
    sampled += 1;
    if (colorDistance(bandColor, averageColor(image, referencePoints)) >= 35) {
      contrasted += 1;
    }
  }
  return contrasted / sampled;
}

export function detectEdgeStripes(buffer, { region, allowedEdges = [] }) {
  const image = decodePng(buffer);
  const bounds = {
    left: Math.max(0, Math.floor(region.left)),
    top: Math.max(0, Math.floor(region.top)),
    right: Math.min(image.width, Math.ceil(region.right)),
    bottom: Math.min(image.height, Math.ceil(region.bottom))
  };
  bounds.width = bounds.right - bounds.left;
  bounds.height = bounds.bottom - bounds.top;
  if (bounds.width < 20 || bounds.height < 20) return [];

  const allowed = new Set(allowedEdges);
  if (allowed.has("allow")) return [];
  const findings = [];
  const maxThickness = Math.max(
    3,
    Math.min(16, Math.floor(Math.min(bounds.width, bounds.height) / 4))
  );
  for (const edge of ["left", "right", "top", "bottom"]) {
    if (allowed.has(edge)) continue;
    let detected = null;
    for (let thickness = 3; thickness <= maxThickness; thickness += 1) {
      const bandPoints = stripePoints(bounds, edge, 0, thickness);
      const referencePoints = stripePoints(bounds, edge, thickness + 2, 2);
      if (bandPoints.length === 0 || referencePoints.length === 0) continue;
      const bandColor = averageColor(image, bandPoints);
      const uniformRatio =
        bandPoints.filter(
          ([x, y]) => colorDistance(readPixel(image, x, y), bandColor) <= 18
        ).length / bandPoints.length;
      const referenceColor = averageColor(image, referencePoints);
      const contrastRatio = stripeContrastRatio(
        image,
        bounds,
        edge,
        thickness,
        bandColor
      );
      if (
        uniformRatio >= 0.9 &&
        colorDistance(bandColor, referenceColor) >= 20 &&
        contrastRatio >= 0.8
      ) {
        detected = { thickness, color: bandColor.map(Math.round) };
      }
    }
    if (!detected) continue;
    findings.push({
      code: "abnormal-edge-stripe",
      severity: "blocker",
      edge,
      thickness: detected.thickness,
      color: detected.color,
      message: `A contrasting ${detected.thickness}px stripe touches the ${edge} slide edge.`
    });
  }
  return findings;
}

function sampledLine(image, orientation, fixed, longStart, longEnd) {
  const points = [];
  const step = Math.max(1, Math.floor((longEnd - longStart) / 240));
  for (let position = longStart; position < longEnd; position += step) {
    points.push(
      orientation === "horizontal" ? [position, fixed] : [fixed, position]
    );
  }
  const color = averageColor(image, points);
  const uniformRatio =
    points.filter(([x, y]) => colorDistance(readPixel(image, x, y), color) <= 18)
      .length / points.length;
  return { color, uniformRatio };
}

function overlapRatio(first, second) {
  const overlap = intersection(first, second);
  return (overlap.width * overlap.height) / Math.max(1, first.width * first.height);
}

function dominantRegionColor(image, region) {
  const buckets = new Map();
  const step = Math.max(
    1,
    Math.floor(Math.sqrt((region.width * region.height) / 12000))
  );
  for (let y = region.top; y < region.bottom; y += step) {
    for (let x = region.left; x < region.right; x += step) {
      const color = readPixel(image, x, y);
      const key = `${color[0] >> 4},${color[1] >> 4},${color[2] >> 4},${color[3] >> 4}`;
      const bucket = buckets.get(key) ?? { count: 0, totals: [0, 0, 0, 0] };
      bucket.count += 1;
      for (let channel = 0; channel < 4; channel += 1) {
        bucket.totals[channel] += color[channel];
      }
      buckets.set(key, bucket);
    }
  }
  const dominant = [...buckets.values()].sort((first, second) => second.count - first.count)[0];
  return dominant.totals.map((total) => total / dominant.count);
}

function mergeStripeCandidates(candidates) {
  const merged = [];
  for (const candidate of candidates) {
    const existing = merged.find(
      (item) =>
        item.orientation === candidate.orientation &&
        colorDistance(item.color, candidate.color) <= 18 &&
        (candidate.orientation === "horizontal"
          ? Math.abs(item.rect.top - candidate.rect.top) <= Math.max(item.thickness, candidate.thickness)
          : Math.abs(item.rect.left - candidate.rect.left) <= Math.max(item.thickness, candidate.thickness))
    );
    if (!existing) {
      merged.push(candidate);
      continue;
    }
    const left = Math.min(existing.rect.left, candidate.rect.left);
    const top = Math.min(existing.rect.top, candidate.rect.top);
    const right = Math.max(existing.rect.right, candidate.rect.right);
    const bottom = Math.max(existing.rect.bottom, candidate.rect.bottom);
    existing.rect = {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    };
    existing.thickness =
      existing.orientation === "horizontal"
        ? existing.rect.height
        : existing.rect.width;
    existing.spanRatio = Math.max(existing.spanRatio, candidate.spanRatio);
  }
  return merged;
}

export function detectInternalStripes(buffer, { region, ignoredRects = [] }) {
  const image = decodePng(buffer);
  const bounds = {
    left: Math.max(0, Math.floor(region.left)),
    top: Math.max(0, Math.floor(region.top)),
    right: Math.min(image.width, Math.ceil(region.right)),
    bottom: Math.min(image.height, Math.ceil(region.bottom))
  };
  bounds.width = bounds.right - bounds.left;
  bounds.height = bounds.bottom - bounds.top;
  if (bounds.width < 40 || bounds.height < 40) return [];
  const backgroundColor = dominantRegionColor(image, bounds);

  const candidates = [];
  for (const orientation of ["horizontal", "vertical"]) {
    const longStart = orientation === "horizontal" ? bounds.left : bounds.top;
    const longLength = orientation === "horizontal" ? bounds.width : bounds.height;
    const crossStart = orientation === "horizontal" ? bounds.top : bounds.left;
    const crossEnd = orientation === "horizontal" ? bounds.bottom : bounds.right;
    const windowLength = Math.floor(longLength * 0.6);
    const maxThickness = Math.min(16, Math.floor((crossEnd - crossStart) / 5));

    for (const fraction of [0, 0.2, 0.4]) {
      const windowStart = longStart + Math.floor(longLength * fraction);
      const windowEnd = Math.min(longStart + longLength, windowStart + windowLength);
      let group = null;
      const flush = () => {
        if (!group) return;
        const thickness = group.end - group.start + 1;
        if (
          thickness >= 3 &&
          thickness <= maxThickness &&
          group.start > crossStart + 2 &&
          group.end < crossEnd - 3
        ) {
          const before = sampledLine(
            image,
            orientation,
            group.start - 2,
            windowStart,
            windowEnd
          );
          const after = sampledLine(
            image,
            orientation,
            group.end + 2,
            windowStart,
            windowEnd
          );
          if (
            colorDistance(group.color, before.color) >= 30 &&
            colorDistance(group.color, after.color) >= 30 &&
            colorDistance(group.color, backgroundColor) >= 24
          ) {
            const stripeRect =
              orientation === "horizontal"
                ? {
                    left: windowStart,
                    top: group.start,
                    right: windowEnd,
                    bottom: group.end + 1,
                    width: windowEnd - windowStart,
                    height: thickness
                  }
                : {
                    left: group.start,
                    top: windowStart,
                    right: group.end + 1,
                    bottom: windowEnd,
                    width: thickness,
                    height: windowEnd - windowStart
                  };
            if (!ignoredRects.some((ignored) => overlapRatio(stripeRect, ignored) >= 0.8)) {
              candidates.push({
                code: "abnormal-internal-stripe",
                severity: "blocker",
                orientation,
                thickness,
                spanRatio: windowLength / longLength,
                color: group.color.map(Math.round),
                rect: stripeRect,
                message: `An unattributed ${orientation} stripe appears inside the slide.`
              });
            }
          }
        }
        group = null;
      };

      for (let fixed = crossStart; fixed < crossEnd; fixed += 1) {
        const summary = sampledLine(
          image,
          orientation,
          fixed,
          windowStart,
          windowEnd
        );
        if (summary.uniformRatio < 0.92) {
          flush();
          continue;
        }
        if (group && colorDistance(group.color, summary.color) <= 12) {
          group.end = fixed;
          continue;
        }
        flush();
        group = { start: fixed, end: fixed, color: summary.color };
      }
      flush();
    }
  }

  return mergeStripeCandidates(candidates);
}

export function inspectPng(buffer, expected = {}) {
  const image = decodePng(buffer);
  const colors = new Set();
  const sampleStride = Math.max(1, Math.floor((image.width * image.height) / 50000));
  for (let pixel = 0; pixel < image.width * image.height; pixel += sampleStride) {
    const x = pixel % image.width;
    const y = Math.floor(pixel / image.width);
    const [red, green, blue, alpha] = readPixel(image, x, y);
    if (alpha === 0) continue;
    colors.add(`${red},${green},${blue},${alpha}`);
    if (colors.size > 1) break;
  }

  return {
    width: image.width,
    height: image.height,
    dimensionsMatch:
      (expected.width === undefined || expected.width === image.width) &&
      (expected.height === undefined || expected.height === image.height),
    nonBlank: colors.size > 1
  };
}

export function comparePngPixels(firstBuffer, secondBuffer, options = {}) {
  const first = decodePng(firstBuffer);
  const second = decodePng(secondBuffer);
  if (first.width !== second.width || first.height !== second.height) {
    return { dimensionsMatch: false };
  }

  let differingPixels = 0;
  let maxChannelDelta = 0;
  let channelDeltaTotal = 0;
  const pixelCount = first.width * first.height;
  const ignoredRects = options.ignoredRects ?? [];
  for (let index = 0; index < pixelCount; index += 1) {
    const x = index % first.width;
    const y = Math.floor(index / first.width);
    if (
      ignoredRects.some(
        (rect) =>
          x >= Math.floor(rect.left) &&
          x < Math.ceil(rect.right) &&
          y >= Math.floor(rect.top) &&
          y < Math.ceil(rect.bottom)
      )
    ) {
      continue;
    }
    const firstPixel = readPixel(first, x, y);
    const secondPixel = readPixel(second, x, y);
    let differs = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(firstPixel[channel] - secondPixel[channel]);
      if (delta > 0) differs = true;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      channelDeltaTotal += delta;
    }
    if (differs) differingPixels += 1;
  }

  return {
    dimensionsMatch: true,
    differingPixels,
    differingPixelRatio: differingPixels / pixelCount,
    maxChannelDelta,
    meanChannelDelta: channelDeltaTotal / (pixelCount * 4)
  };
}

export function analyzeVisualDiff({
  metrics,
  planned = false,
  baselineFile = null,
  thresholds = {}
}) {
  const effectiveThresholds = {
    differingPixelRatio: thresholds.differingPixelRatio ?? 0.0005,
    maxChannelDelta: thresholds.maxChannelDelta ?? 8,
    meanChannelDelta: thresholds.meanChannelDelta ?? 0.01
  };
  const materiallyDifferent =
    !metrics.dimensionsMatch ||
    (
      metrics.differingPixelRatio >= effectiveThresholds.differingPixelRatio &&
      metrics.maxChannelDelta >= effectiveThresholds.maxChannelDelta &&
      metrics.meanChannelDelta >= effectiveThresholds.meanChannelDelta
    );
  let status = "identical";
  if (materiallyDifferent) status = planned ? "planned-change" : "unexpected-change";
  else if ((metrics.differingPixels ?? 0) > 0) status = "noise";

  const evidence = {
    baselineFile,
    planned,
    status,
    ...metrics
  };
  const findings =
    status === "unexpected-change"
      ? [
          {
            code: "unexpected-visual-change",
            severity: "blocker",
            message: "Protected slide differs materially from its source version.",
            differingPixelRatio: metrics.differingPixelRatio,
            maxChannelDelta: metrics.maxChannelDelta,
            meanChannelDelta: metrics.meanChannelDelta
          }
        ]
      : [];
  return { evidence, findings };
}

export async function terminateProcess(
  child,
  {
    forceDelayMs = 500,
    killProcess = process.kill
  } = {}
) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let forceKill;
    const finished = () => {
      clearTimeout(forceKill);
      child.off("exit", finished);
      resolve();
    };
    child.once("exit", finished);
    forceKill = setTimeout(() => {
      try {
        killProcess(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finished();
    }, forceDelayMs);
    try {
      killProcess(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  });
}

export class CdpClient extends CdpWebSocketClient {}

export async function guardBrowserOperation(child, operation) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Chrome exited unexpectedly with ${
        child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`
      }.`
    );
  }
  let onExit;
  const exited = new Promise((_, reject) => {
    onExit = (code, signal) => {
      reject(
        new Error(
          `Chrome exited unexpectedly with ${
            signal ? `signal ${signal}` : `code ${code}`
          }.`
        )
      );
    };
    child.once("exit", onExit);
  });
  try {
    return await Promise.race([operation, exited]);
  } finally {
    child.off("exit", onExit);
  }
}

async function waitForEndpoint(child, getStderr, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = getStderr().match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) return match[1];
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before DevTools was ready. ${getStderr().trim()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Chrome DevTools timed out after ${timeoutMs}ms.`);
}

async function findPageEndpoint(browserEndpoint, timeoutMs) {
  const browserUrl = new URL(browserEndpoint);
  const listUrl = `http://${browserUrl.hostname}:${browserUrl.port}/json/list`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      const targets = await fetch(listUrl, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, remainingMs)))
      }).then((response) => response.json());
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome may expose DevTools before the first page target is listed.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Chrome did not expose a page target.");
}

async function waitForPageSession(browserClient, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await CdpSessionClient.attachToPage(browserClient);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError ?? new Error("Chrome did not expose a page target.");
}

export function collectVisualGeometry() {
  const active = document.querySelector(".slide.active");
  if (!active) return null;
  const slideRect = active.getBoundingClientRect();
  const scaleX = slideRect.width / (active.offsetWidth || 1920);
  const scaleY = slideRect.height / (active.offsetHeight || 1080);
  const nodes = [...active.querySelectorAll("*")];
  const nodeIds = new Map(nodes.map((node, index) => [node, `n${index + 1}`]));

  function normalizedRect(rect) {
    const left = (rect.left - slideRect.left) / scaleX;
    const top = (rect.top - slideRect.top) / scaleY;
    const width = rect.width / scaleX;
    const height = rect.height / scaleY;
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height
    };
  }

  function normalizedPoint(point) {
    return {
      x: (point.x - slideRect.left) / scaleX,
      y: (point.y - slideRect.top) / scaleY
    };
  }

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0.01 &&
      rect.width > 0.5 &&
      rect.height > 0.5
    );
  }

  function selector(element, suffix = "") {
    if (element.id) return `#${CSS.escape(element.id)}${suffix}`;
    if (element.dataset.role) return `[data-role="${element.dataset.role}"]${suffix}`;
    if (element.dataset.itemId) return `[data-item-id="${element.dataset.itemId}"]${suffix}`;
    if (element.dataset.chartPoint) {
      return `[data-chart-point="${CSS.escape(element.dataset.chartPoint)}"]${suffix}`;
    }
    if (element.dataset.chart) {
      return `[data-chart="${CSS.escape(element.dataset.chart)}"]${suffix}`;
    }
    if (element.dataset.colorKey) {
      return `[data-color-key="${CSS.escape(element.dataset.colorKey)}"]${suffix}`;
    }
    const className = [...element.classList][0];
    if (className) return `.${CSS.escape(className)}${suffix}`;
    return `${element.tagName.toLowerCase()}${suffix}`;
  }

  function allowed(element, name) {
    const owner = element.closest(`[data-visual-${name}]`);
    return owner?.getAttribute(`data-visual-${name}`) === "allow";
  }

  function textAutoFix(element) {
    if (
      element.getAttribute("data-visual-autofix") !== "fit-text" ||
      !element.dataset.role
    ) {
      return null;
    }
    const item = element.closest("[data-item-id]");
    const scope = item ?? active;
    const roleMatches = [...scope.querySelectorAll("[data-role]")].filter(
      (candidate) => candidate.dataset.role === element.dataset.role
    );
    const itemMatches = item
      ? [...active.querySelectorAll("[data-item-id]")].filter(
          (candidate) => candidate.dataset.itemId === item.dataset.itemId
        )
      : [];
    const style = getComputedStyle(element);
    const fontSize = Number.parseFloat(style.fontSize);
    const minFontSize = Number.parseFloat(
      element.getAttribute("data-visual-min-font-size") ?? ""
    );
    if (
      roleMatches.length !== 1 ||
      (item && itemMatches.length !== 1) ||
      !Number.isFinite(fontSize) ||
      !Number.isFinite(minFontSize) ||
      minFontSize <= 0 ||
      minFontSize >= fontSize
    ) {
      return null;
    }
    return {
      command: "fit-text",
      slide: active.dataset.slideId || active.id,
      target: element.dataset.role,
      itemId: item?.dataset.itemId ?? null,
      fontSize,
      minFontSize,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight
    };
  }

  function ancestors(element) {
    const result = [];
    for (let parent = element.parentElement; parent && parent !== active; parent = parent.parentElement) {
      const id = nodeIds.get(parent);
      if (id) result.push(id);
    }
    return result;
  }

  function union(rects) {
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  const elements = [];
  for (const element of nodes) {
    if (!visible(element)) continue;
    const ownTextNodes = [...element.childNodes].filter(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
    );
    const textRects = ownTextNodes.flatMap((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()]
        .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
        .map(normalizedRect);
    });
    const isMedia = /^(IMG|VIDEO|CANVAS|SVG)$/.test(element.tagName);
    const forced = element.hasAttribute("data-visual-check");
    if (textRects.length === 0 && !isMedia && !forced) continue;
    const elementRect = normalizedRect(element.getBoundingClientRect());
    const measuredRect = textRects.length > 0 ? union(textRects) : elementRect;
    elements.push({
      nodeId: nodeIds.get(element),
      ancestors: ancestors(element),
      selector: selector(element),
      kind: textRects.length > 0 ? "text" : "visual",
      rect: measuredRect,
      textRects,
      overflowX: Math.max(0, element.scrollWidth - element.clientWidth),
      overflowY: Math.max(0, element.scrollHeight - element.clientHeight),
      clipsOverflow:
        getComputedStyle(element).overflowX !== "visible" ||
        getComputedStyle(element).overflowY !== "visible",
      allowOverlap: allowed(element, "overlap"),
      allowOverflow: allowed(element, "overflow"),
      allowBounds: allowed(element, "bounds"),
      allowLine: allowed(element, "line"),
      autoFix: textAutoFix(element)
    });
  }

  const lines = [];
  function addLine(element, rect, suffix, allowedLine = false, segment = null) {
    const normalized = normalizedRect(rect);
    const horizontal = normalized.width >= normalized.height;
    const thickness = segment?.thickness ?? (horizontal ? normalized.height : normalized.width);
    const length = segment
      ? Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y)
      : horizontal
        ? normalized.width
        : normalized.height;
    if (thickness > 6 || length < 40 || length / Math.max(thickness, 0.25) < 8) return;
    lines.push({
      selector: selector(element, suffix),
      rect: normalized,
      start: segment ? normalizedPoint(segment.start) : undefined,
      end: segment ? normalizedPoint(segment.end) : undefined,
      thickness,
      orientation: horizontal ? "horizontal" : "vertical",
      allowed: allowedLine || allowed(element, "line")
    });
  }

  for (const element of nodes) {
    if (element.tagName === "line") {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      const strokeWidth = Math.max(
        1,
        Number.parseFloat(style.strokeWidth) ||
          Number.parseFloat(element.getAttribute("stroke-width")) ||
          1
      );
      const horizontal = rect.width >= rect.height;
      const svg = element.ownerSVGElement;
      const matrix = element.getScreenCTM();
      let segment = null;
      if (svg && matrix) {
        const start = svg.createSVGPoint();
        start.x = element.x1.baseVal.value;
        start.y = element.y1.baseVal.value;
        const end = svg.createSVGPoint();
        end.x = element.x2.baseVal.value;
        end.y = element.y2.baseVal.value;
        segment = {
          start: start.matrixTransform(matrix),
          end: end.matrixTransform(matrix),
          thickness: strokeWidth
        };
      }
      addLine(
        element,
        {
          left: rect.left - (horizontal ? 0 : (strokeWidth * scaleX) / 2),
          top: rect.top - (horizontal ? (strokeWidth * scaleY) / 2 : 0),
          right: rect.right + (horizontal ? 0 : (strokeWidth * scaleX) / 2),
          bottom: rect.bottom + (horizontal ? (strokeWidth * scaleY) / 2 : 0),
          width: rect.width + (horizontal ? 0 : strokeWidth * scaleX),
          height: rect.height + (horizontal ? strokeWidth * scaleY : 0)
        },
        "",
        false,
        segment
      );
      continue;
    }
    if (!visible(element)) continue;
    const rect = element.getBoundingClientRect();
    addLine(element, rect, "");
    const style = getComputedStyle(element);
    const borders = [
      ["top", Number.parseFloat(style.borderTopWidth), { left: rect.left, top: rect.top, width: rect.width, height: Number.parseFloat(style.borderTopWidth) }],
      ["right", Number.parseFloat(style.borderRightWidth), { left: rect.right - Number.parseFloat(style.borderRightWidth), top: rect.top, width: Number.parseFloat(style.borderRightWidth), height: rect.height }],
      ["bottom", Number.parseFloat(style.borderBottomWidth), { left: rect.left, top: rect.bottom - Number.parseFloat(style.borderBottomWidth), width: rect.width, height: Number.parseFloat(style.borderBottomWidth) }],
      ["left", Number.parseFloat(style.borderLeftWidth), { left: rect.left, top: rect.top, width: Number.parseFloat(style.borderLeftWidth), height: rect.height }]
    ];
    for (const [edge, width, borderRect] of borders) {
      if (width > 0) addLine(element, borderRect, `::border-${edge}`);
    }

    for (const pseudo of ["::before", "::after"]) {
      const pseudoStyle = getComputedStyle(element, pseudo);
      if (pseudoStyle.content === "none" || pseudoStyle.display === "none") continue;
      const pseudoWidth =
        pseudoStyle.width === "auto"
          ? rect.width -
            (Number.parseFloat(pseudoStyle.left) || 0) -
            (Number.parseFloat(pseudoStyle.right) || 0)
          : Number.parseFloat(pseudoStyle.width);
      const pseudoHeight =
        pseudoStyle.height === "auto"
          ? rect.height -
            (Number.parseFloat(pseudoStyle.top) || 0) -
            (Number.parseFloat(pseudoStyle.bottom) || 0)
          : Number.parseFloat(pseudoStyle.height);
      if (!Number.isFinite(pseudoWidth) || !Number.isFinite(pseudoHeight)) continue;
      const left =
        rect.left +
        (Number.isFinite(Number.parseFloat(pseudoStyle.left))
          ? Number.parseFloat(pseudoStyle.left) * scaleX
          : rect.width - (Number.parseFloat(pseudoStyle.right) || 0) * scaleX - pseudoWidth * scaleX);
      const top =
        rect.top +
        (Number.isFinite(Number.parseFloat(pseudoStyle.top))
          ? Number.parseFloat(pseudoStyle.top) * scaleY
          : rect.height - (Number.parseFloat(pseudoStyle.bottom) || 0) * scaleY - pseudoHeight * scaleY);
      addLine(
        element,
        {
          left,
          top,
          right: left + pseudoWidth * scaleX,
          bottom: top + pseudoHeight * scaleY,
          width: pseudoWidth * scaleX,
          height: pseudoHeight * scaleY
        },
        pseudo
      );
    }
  }

  const stripeValue = active.getAttribute("data-visual-stripe") ?? "";
  const stripeAllowances =
    stripeValue === "allow"
      ? ["allow"]
      : stripeValue
          .split(/\s+/)
          .map((value) => value.replace(/^allow-/, ""))
          .filter(Boolean);
  const stripeIgnoreRects = [
    ...active.querySelectorAll('[data-visual-stripe="allow"]')
  ]
    .filter(visible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      };
    });
  const paginationIgnoreRects = [...document.querySelectorAll("#counter, #progress")]
    .filter(visible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      };
    });

  function styleNumber(style, property) {
    const value = Number.parseFloat(style[property]);
    return Number.isFinite(value) ? value : null;
  }

  function textStyle(element) {
    if (!element || !visible(element)) return null;
    const style = getComputedStyle(element);
    return {
      fontFamily: style.fontFamily,
      fontSize: styleNumber(style, "fontSize"),
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      color: style.color
    };
  }

  const activeStyle = getComputedStyle(active);
  const title = active.querySelector('[data-role="title"]');
  const footerElement = active.querySelector(".footer, [data-role='footer']");
  const footerRect = footerElement?.getBoundingClientRect();
  const footerStyle = footerElement ? getComputedStyle(footerElement) : null;
  const familyCounts = new Map();
  for (const element of nodes) {
    if (!visible(element)) continue;
    const hasOwnText = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
    );
    if (!hasOwnText) continue;
    const family = getComputedStyle(element).fontFamily;
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }
  const titleStyle = textStyle(title);
  const styleProfile = {
    slide: active.dataset.slideId || active.id,
    layout: active.dataset.layout || "unknown",
    insets: {
      left: styleNumber(activeStyle, "paddingLeft"),
      right: styleNumber(activeStyle, "paddingRight"),
      top: styleNumber(activeStyle, "paddingTop"),
      bottom: styleNumber(activeStyle, "paddingBottom")
    },
    title: titleStyle,
    footer:
      footerElement && footerRect && footerStyle
        ? {
            left: (footerRect.left - slideRect.left) / scaleX,
            right:
              active.offsetWidth -
              (footerRect.right - slideRect.left) / scaleX,
            bottom:
              active.offsetHeight -
              (footerRect.bottom - slideRect.top) / scaleY,
            fontSize: styleNumber(footerStyle, "fontSize"),
            color: footerStyle.color,
            borderColor: footerStyle.borderTopColor
          }
        : null,
    semanticColors: {
      slideBackground: activeStyle.backgroundColor,
      ...(titleStyle ? { title: titleStyle.color } : {}),
      ...(footerStyle
        ? {
            footerText: footerStyle.color,
            footerBorder: footerStyle.borderTopColor
          }
        : {})
    },
    fontFamilies: [...familyCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((first, second) => second.count - first.count || first.value.localeCompare(second.value))
  };

  function semanticSelector(element) {
    if (element.dataset.emphasisId) {
      return `[data-emphasis-id="${CSS.escape(element.dataset.emphasisId)}"]`;
    }
    const item = element.closest("[data-item-id]");
    if (item?.dataset.itemId && element.dataset.role) {
      return `[data-item-id="${item.dataset.itemId}"] [data-role="${element.dataset.role}"]`;
    }
    return selector(element);
  }

  function numericWeight(style) {
    const parsed = Number.parseFloat(style.fontWeight);
    if (Number.isFinite(parsed)) return parsed;
    return style.fontWeight === "bold" ? 700 : 400;
  }

  function hasVisibleBackground(style, ownerStyle) {
    if (style.backgroundImage !== "none" && style.backgroundImage !== ownerStyle.backgroundImage) {
      return true;
    }
    const color = style.backgroundColor;
    return (
      color !== ownerStyle.backgroundColor &&
      color !== "transparent" &&
      !/^rgba?\([^)]*,\s*0(?:\.0+)?\)$/.test(color)
    );
  }

  const emphasisCandidates = [...active.querySelectorAll("[data-edit]")]
    .flatMap((owner) => {
      const ownerStyle = getComputedStyle(owner);
      const ownerWeight = numericWeight(ownerStyle);
      const ownerSize = styleNumber(ownerStyle, "fontSize");
      const role = owner.dataset.role || owner.tagName.toLowerCase();
      return [...owner.querySelectorAll("*")]
        .filter(visible)
        .filter((element) => !element.hasAttribute("data-edit"))
        .filter(
          (element) =>
            element.hasAttribute("data-emphasis-id") ||
            [...element.childNodes].some(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
            )
        )
        .flatMap((element) => {
          const style = getComputedStyle(element);
          const treatments = [];
          const weight = numericWeight(style);
          const size = styleNumber(style, "fontSize");
          if (
            /^(STRONG|B)$/.test(element.tagName) ||
            weight >= ownerWeight + 100
          ) {
            treatments.push("bold");
          }
          if (size !== null && ownerSize !== null && size > ownerSize * 1.05) {
            treatments.push("enlarge");
          }
          if (style.color !== ownerStyle.color) treatments.push("color");
          if (
            element.tagName === "MARK" ||
            hasVisibleBackground(style, ownerStyle)
          ) {
            treatments.push("highlight");
          }
          if (
            treatments.length === 0 &&
            !element.hasAttribute("data-emphasis-id")
          ) {
            return [];
          }
          return [
            {
              slide: active.dataset.slideId || active.id,
              role,
              id: element.dataset.emphasisId || null,
              text: element.innerText.replace(/\s+/g, " ").trim(),
              treatments,
              selector: semanticSelector(element)
            }
          ];
        });
    });

  function lineCharacterCounts(element) {
    const lines = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (let offset = 0; offset < text.length; offset += 1) {
        if (/\s/.test(text[offset])) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width <= 0.1 || rect.height <= 0.1) continue;
        let line = lines.find((candidate) => Math.abs(candidate.top - rect.top) <= 2);
        if (!line) {
          line = { top: rect.top, count: 0 };
          lines.push(line);
        }
        line.count += 1;
      }
    }
    return lines
      .sort((first, second) => first.top - second.top)
      .map((line) => line.count);
  }

  function fontRuns(element) {
    const runs = new Map();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      const owner = node.parentElement;
      if (!text || !owner || !visible(owner)) continue;
      const style = getComputedStyle(owner);
      const fontFamily = style.fontFamily
        .split(",")[0]
        .trim()
        .replace(/^["']|["']$/g, "");
      const fontWeight = Number.parseFloat(style.fontWeight);
      const fontSize = styleNumber(style, "fontSize");
      if (!fontFamily || !Number.isFinite(fontWeight) || fontSize === null) {
        continue;
      }
      const key = `${fontFamily}\u0000${fontWeight}`;
      if (runs.has(key)) continue;
      let fontAvailable = null;
      try {
        const escapedFamily = fontFamily.replace(/["\\]/g, "\\$&");
        fontAvailable = document.fonts.check(
          `${fontWeight} ${fontSize}px "${escapedFamily}"`,
          text.slice(0, 64)
        );
      } catch {
        fontAvailable = null;
      }
      runs.set(key, { fontFamily, fontWeight, fontAvailable });
    }
    return [...runs.values()].sort(
      (first, second) =>
        first.fontFamily.localeCompare(second.fontFamily) ||
        first.fontWeight - second.fontWeight
    );
  }

  const typography = [
    ...active.querySelectorAll(
      '[data-edit], [data-role="title"], [data-role="item-title"], [data-role="item-body"], [data-visual-typography-check]'
    )
  ]
    .filter(visible)
    .filter(
      (element, index, candidates) =>
        candidates.indexOf(element) === index && element.textContent?.trim()
    )
    .map((element) => {
      const style = getComputedStyle(element);
      const fontSize = styleNumber(style, "fontSize");
      const parsedLineHeight = styleNumber(style, "lineHeight");
      const counts = lineCharacterCounts(element);
      return {
        selector: semanticSelector(element),
        role: element.dataset.role || element.tagName.toLowerCase(),
        itemId: element.closest("[data-item-id]")?.dataset.itemId ?? null,
        text: element.innerText.trim(),
        fontFamily: style.fontFamily,
        fontWeight: Number.parseFloat(style.fontWeight),
        fontRuns: fontRuns(element),
        fontSize,
        lineHeight:
          parsedLineHeight ?? (fontSize === null ? null : fontSize * 1.2),
        lineCount: counts.length,
        lineCharacterCounts: counts,
        allow: allowed(element, "typography")
      };
    });

  const images = [...active.querySelectorAll("img")]
    .filter(visible)
    .map((image) => {
      const style = getComputedStyle(image);
      const box = normalizedRect(image.getBoundingClientRect());
      const naturalWidth = image.naturalWidth;
      const naturalHeight = image.naturalHeight;
      const sourceAspect =
        naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : null;
      const renderedAspect = box.height > 0 ? box.width / box.height : null;
      let drawnWidth = box.width;
      let drawnHeight = box.height;
      if (sourceAspect && style.objectFit === "contain") {
        const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
        drawnWidth = naturalWidth * scale;
        drawnHeight = naturalHeight * scale;
      } else if (sourceAspect && style.objectFit === "cover") {
        const scale = Math.max(box.width / naturalWidth, box.height / naturalHeight);
        drawnWidth = naturalWidth * scale;
        drawnHeight = naturalHeight * scale;
      }
      const visibleFraction =
        drawnWidth > 0 && drawnHeight > 0
          ? Math.min(1, (box.width * box.height) / (drawnWidth * drawnHeight))
          : null;
      return {
        selector: semanticSelector(image),
        role: image.dataset.role ?? null,
        src: image.currentSrc || image.src,
        alt: image.alt,
        naturalWidth,
        naturalHeight,
        drawnWidth,
        drawnHeight,
        renderedAspect,
        sourceAspect,
        objectFit: style.objectFit,
        objectPosition: style.objectPosition,
        visibleFraction,
        allowCrop: allowed(image, "image-crop"),
        allowRepeat: allowed(image, "image-repeat"),
        allowAccessibility: allowed(image, "accessibility")
      };
    });

  const charts = [...active.querySelectorAll("[data-chart]")]
    .filter(visible)
    .map((chart) => {
      const points = [...chart.querySelectorAll("[data-chart-value]")]
        .filter(visible)
        .map((point) => {
          const mark = point.querySelector("[data-chart-mark]");
          const track = mark?.parentElement;
          const markRect = mark?.getBoundingClientRect();
          const trackRect = track?.getBoundingClientRect();
          return {
            selector: selector(point),
            label:
              point.dataset.chartLabel ??
              point.getAttribute("aria-label") ??
              "",
            value: Number.parseFloat(point.dataset.chartValue),
            drawnFraction:
              markRect && trackRect && trackRect.width > 0
                ? markRect.width / trackRect.width
                : null
          };
        });
      return {
        selector: selector(chart),
        type: chart.dataset.chartType ?? "",
        title: chart.dataset.chartTitle ?? "",
        source: chart.dataset.chartSource ?? "",
        scale: {
          min: Number.parseFloat(chart.dataset.chartScaleMin),
          max: Number.parseFloat(chart.dataset.chartScaleMax)
        },
        ticks: [...chart.querySelectorAll("[data-chart-tick]")]
          .filter(visible)
          .map((tick) => Number.parseFloat(tick.textContent)),
        points,
        allow: allowed(chart, "chart")
      };
    });

  function colorChannels(value) {
    const channels = String(value).match(/[\d.]+/g)?.map(Number) ?? [];
    if (channels.length < 3) return null;
    return {
      red: channels[0],
      green: channels[1],
      blue: channels[2],
      alpha: channels[3] ?? 1
    };
  }

  function effectiveBackground(element) {
    for (
      let current = element;
      current && current !== document.documentElement;
      current = current.parentElement
    ) {
      const color = colorChannels(getComputedStyle(current).backgroundColor);
      if (color && color.alpha >= 0.99) return color;
    }
    return colorChannels(activeStyle.backgroundColor);
  }

  function relativeLuminance(color) {
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return (
      0.2126 * channel(color.red) +
      0.7152 * channel(color.green) +
      0.0722 * channel(color.blue)
    );
  }

  function textContrastRatio(element) {
    const foreground = colorChannels(getComputedStyle(element).color);
    const background = effectiveBackground(element);
    if (!foreground || !background) return null;
    const first = relativeLuminance(foreground);
    const second = relativeLuminance(background);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }

  const accessibilityTexts = nodes
    .filter(visible)
    .filter((element) => element.getAttribute("aria-hidden") !== "true")
    .filter((element) =>
      [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
      )
    )
    .map((element) => {
      const style = getComputedStyle(element);
      return {
        selector: semanticSelector(element),
        text: [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join(" ")
          .trim(),
        fontSize: styleNumber(style, "fontSize"),
        fontWeight: Number.parseFloat(style.fontWeight),
        contrastRatio: textContrastRatio(element),
        allow: allowed(element, "accessibility")
      };
    });

  const colorEncodings = [...active.querySelectorAll("[data-color-encoding]")]
    .filter(visible)
    .map((group) => ({
      selector: selector(group),
      allow: allowed(group, "accessibility"),
      items: [...group.querySelectorAll("[data-color-key]")]
        .filter(visible)
        .map((item) => ({
          selector: selector(item),
          label:
            item.dataset.colorLabel ??
            item.getAttribute("aria-label") ??
            "",
          allow: allowed(item, "accessibility")
        }))
    }));

  const signals = new Set();
  if (typography.length > 0) signals.add("text");
  if (/\d/.test(active.innerText)) signals.add("number");
  if (charts.length > 0) signals.add("chart");
  if (images.length > 0) signals.add("image");
  if (
    active.querySelector('[data-role="items"], [data-item-id], [data-visual-signal="items"]')
  ) {
    signals.add("items");
  }
  for (const element of active.querySelectorAll("[data-visual-signal]")) {
    for (const signal of element.dataset.visualSignal.split(/\s+/).filter(Boolean)) {
      signals.add(signal);
    }
  }
  const primaryEmphasis = [
    ...active.querySelectorAll('[data-visual-emphasis="primary"]')
  ]
    .filter(visible)
    .map((element) => ({
      selector: semanticSelector(element),
      role:
        element.dataset.emphasisRole ??
        element.dataset.role ??
        element.tagName.toLowerCase()
    }));
  const semantic = {
    intent: active.dataset.visualIntent ?? "",
    signals: [...signals].sort(),
    primaryEmphasis,
    allow: allowed(active, "semantic")
  };
  const accessibility = {
    slideLabel: active.getAttribute("aria-label") ?? "",
    texts: accessibilityTexts,
    images: images.map((image) => ({
      selector: image.selector,
      alt: image.alt,
      allow: image.allowAccessibility ?? false
    })),
    colorEncodings,
    allow: allowed(active, "accessibility")
  };

  const layoutBlocks = [...active.children]
    .filter(visible)
    .filter(
      (element) =>
        !element.matches("header, footer, .topline, .footer") &&
        element.getAttribute("aria-hidden") !== "true" &&
        !allowed(element, "layout")
    )
    .map((element) => ({
      selector: selector(element),
      rect: normalizedRect(element.getBoundingClientRect())
    }));
  const blockArea = layoutBlocks.reduce(
    (total, block) => total + block.rect.width * block.rect.height,
    0
  );
  const weightedCenter = layoutBlocks.reduce(
    (total, block) => {
      const area = block.rect.width * block.rect.height;
      total.x += (block.rect.left + block.rect.width / 2) * area;
      total.y += (block.rect.top + block.rect.height / 2) * area;
      return total;
    },
    { x: 0, y: 0 }
  );
  const repeatedGroups = [...active.querySelectorAll('[data-role="items"]')]
    .filter(visible)
    .map((group) => {
      const children = [...group.children].filter(visible);
      const rects = children.map((element) =>
        normalizedRect(element.getBoundingClientRect())
      );
      const horizontalSpan =
        rects.length > 0
          ? Math.max(...rects.map((rect) => rect.left + rect.width / 2)) -
            Math.min(...rects.map((rect) => rect.left + rect.width / 2))
          : 0;
      const verticalSpan =
        rects.length > 0
          ? Math.max(...rects.map((rect) => rect.top + rect.height / 2)) -
            Math.min(...rects.map((rect) => rect.top + rect.height / 2))
          : 0;
      const orientation =
        horizontalSpan >= verticalSpan ? "horizontal" : "vertical";
      const ordered = [...rects].sort((first, second) =>
        orientation === "horizontal"
          ? first.left - second.left
          : first.top - second.top
      );
      const gaps = ordered.slice(1).map((rect, index) =>
        orientation === "horizontal"
          ? rect.left - ordered[index].right
          : rect.top - ordered[index].bottom
      );
      return {
        selector: selector(group),
        orientation,
        gaps,
        crossAxisPositions: ordered.map((rect) =>
          orientation === "horizontal" ? rect.top : rect.left
        ),
        allow: allowed(group, "layout")
      };
    });
  const qualityProfile = {
    slide: active.dataset.slideId || active.id,
    layout: active.dataset.layout || "unknown",
    typography,
    images,
    charts,
    emphasisCandidates,
    semantic,
    accessibility,
    metrics: {
      centerX:
        blockArea > 0
          ? weightedCenter.x / blockArea / active.offsetWidth
          : 0.5,
      centerY:
        blockArea > 0
          ? weightedCenter.y / blockArea / active.offsetHeight
          : 0.5,
      coverage: Math.min(
        1,
        blockArea / (active.offsetWidth * active.offsetHeight)
      )
    },
    blocks: layoutBlocks,
    repeatedGroups
  };
  return {
    slide: {
      left: 0,
      top: 0,
      right: active.offsetWidth,
      bottom: active.offsetHeight,
      width: active.offsetWidth,
      height: active.offsetHeight
    },
    slideViewport: {
      left: slideRect.left,
      top: slideRect.top,
      right: slideRect.right,
      bottom: slideRect.bottom,
      width: slideRect.width,
      height: slideRect.height
    },
    stripeAllowances,
    stripeIgnoreRects,
    paginationIgnoreRects,
    styleProfile,
    qualityProfile,
    elements,
    lines
  };
}

async function waitForPage(client, url, expectedSlide, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const evaluated = await client.send("Runtime.evaluate", {
        expression: `({
          href: location.href,
          ready: document.readyState,
          activeSlide: document.querySelector('.slide.active')?.dataset.slideId ||
            document.querySelector('.slide.active')?.id || null
        })`,
        returnByValue: true
      });
      const state = evaluated.result.value;
      if (
        state?.ready === "complete" &&
        state.href === url &&
        (!expectedSlide || state.activeSlide === expectedSlide)
      ) {
        return;
      }
    } catch {
      // Navigation replaces the execution context while this poll is running.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Chrome page did not become ready after ${timeoutMs}ms.`);
}

async function collectPlatformFonts(client, geometry) {
  const typography = geometry?.qualityProfile?.typography ?? [];
  if (typography.length === 0) return;
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
  } catch (error) {
    for (const element of typography) {
      element.platformFonts = [];
      element.platformFontError = error.message;
    }
    return;
  }
  let documentNodeId;
  try {
    documentNodeId = (await client.send("DOM.getDocument", { depth: 0 })).root
      .nodeId;
  } catch (error) {
    for (const element of typography) {
      element.platformFonts = [];
      element.platformFontError = error.message;
    }
    return;
  }
  for (const element of typography) {
    try {
      const requested = await client.send("DOM.querySelector", {
        nodeId: documentNodeId,
        selector: `.slide.active ${element.selector}`
      });
      if (!requested.nodeId) {
        throw new Error(
          `No active-slide node matched ${element.selector}.`
        );
      }
      const result = await client.send("CSS.getPlatformFontsForNode", {
        nodeId: requested.nodeId
      });
      element.platformFonts = (result.fonts ?? []).map((font) => ({
        fontFamily: font.familyName,
        postScriptName: font.postScriptName,
        isCustomFont: font.isCustomFont,
        glyphCount: font.glyphCount
      }));
    } catch (error) {
      element.platformFonts = [];
      element.platformFontError = error.message;
    }
  }
}

async function captureWithClient(client, task, renderSessionId) {
  const {
    url,
    outputPath,
    width,
    height,
    expectedSlide,
    timeoutMs
  } = task;
  const startedAt = Date.now();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
    screenWidth: width,
    screenHeight: height
  });
  await client.send("Page.navigate", { url });
  await waitForPage(client, url, expectedSlide, timeoutMs);
  const expression = `(async () => {
    await document.fonts.ready;
    const auditStyle = document.createElement('style');
    auditStyle.dataset.visualAuditMotion = 'settled';
    auditStyle.textContent = \`
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
    \`;
    document.head.append(auditStyle);
    const active = document.querySelector('.slide.active');
    const images = [...(active?.querySelectorAll('img') ?? [])];
    await Promise.all(images.map(async image => {
      if (!(image.complete && image.naturalWidth > 0)) {
        await new Promise(resolve => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 5000);
        });
      }
      await image.decode?.().catch(() => {});
    }));
    await new Promise(resolve => setTimeout(resolve, 150));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const geometry = (${collectVisualGeometry.toString()})();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      activeSlide: active?.dataset.slideId || active?.id || null,
      activeAnimations: document.getAnimations().filter(
        animation => animation.playState === 'running'
      ).length,
      geometry,
      brokenImages: images
        .filter(image => !image.complete || image.naturalWidth === 0)
        .map(image => image.currentSrc || image.src)
    };
  })()`;
  const evaluated = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  const runtime = evaluated.result.value;
  await collectPlatformFonts(client, runtime.geometry);
  if (runtime.viewportWidth !== width || runtime.viewportHeight !== height) {
    throw new Error(
      `Chrome viewport mismatch: expected ${width}x${height}, got ${runtime.viewportWidth}x${runtime.viewportHeight}.`
    );
  }
  if (expectedSlide && runtime.activeSlide !== expectedSlide) {
    throw new Error(
      `Chrome activated slide "${runtime.activeSlide}", expected "${expectedSlide}".`
    );
  }
  if (runtime.brokenImages.length > 0) {
    throw new Error(`Broken images on ${expectedSlide}: ${runtime.brokenImages.join(", ")}`);
  }
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  const buffer = Buffer.from(screenshot.data, "base64");
  await writeFile(outputPath, buffer);
  return {
    bytes: buffer.length,
    durationMs: Date.now() - startedAt,
    renderSessionId,
    ...runtime
  };
}

export async function renderScreenshots({
  chromePath,
  tasks,
  timeoutMs = 10000
}) {
  if (!existsSync(chromePath)) throw new Error(`Chrome does not exist: ${chromePath}`);
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const profile = path.join(
    path.dirname(tasks[0].outputPath),
    `.chrome-profile-${process.pid}-${Date.now()}`
  );
  await rm(profile, { recursive: true, force: true });

  const firstTask = tasks[0];
  const commonArgs = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    `--user-data-dir=${profile}`,
    `--window-size=${firstTask.width},${firstTask.height}`
  ];
  const launchBrowser = (transport) => {
    const launch = buildBrowserLaunchOptions({
      profile,
      args: [
        ...commonArgs,
        transport === "pipe"
          ? "--remote-debugging-pipe"
          : "--remote-debugging-port=0",
        "about:blank"
      ],
      spawnOptions: {
        detached: true,
        stdio:
          transport === "pipe"
            ? ["ignore", "ignore", "pipe", "pipe", "pipe"]
            : ["ignore", "ignore", "pipe"]
      }
    });
    return spawn(chromePath, launch.args, launch.spawnOptions);
  };

  let child;
  let stderr = "";
  let client;
  let browserClient;
  let transport;
  const transportFailures = [];
  try {
    try {
      child = launchBrowser("pipe");
      stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      browserClient = new CdpPipeClient(child.stdio[4], child.stdio[3], {
        timeoutMs
      });
      await guardBrowserOperation(child, browserClient.connect());
      await guardBrowserOperation(child, verifyCdpClient(browserClient));
      client = await guardBrowserOperation(
        child,
        waitForPageSession(browserClient, timeoutMs)
      );
      transport = "pipe";
    } catch (error) {
      transportFailures.push(`pipe: ${error.message}`);
      browserClient?.close();
      browserClient = null;
      if (child) await terminateProcess(child);

      child = launchBrowser("websocket");
      stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      try {
        const browserEndpoint = await waitForEndpoint(child, () => stderr, timeoutMs);
        client = await retryCdpConnection(async () => {
          const pageEndpoint = await guardBrowserOperation(
            child,
            findPageEndpoint(browserEndpoint, timeoutMs)
          );
          const candidateClient = new CdpClient(pageEndpoint, { timeoutMs });
          try {
            await guardBrowserOperation(child, candidateClient.connect());
            return candidateClient;
          } catch (error) {
            candidateClient.close();
            throw error;
          }
        });
        await guardBrowserOperation(child, client.send("Browser.getVersion"));
        transport = "websocket";
      } catch (websocketError) {
        throw new Error(
          `${transportFailures.join("; ")}; websocket: ${websocketError.message}`
        );
      }
    }
    await guardBrowserOperation(child, client.send("Page.enable"));
    await guardBrowserOperation(child, client.send("Runtime.enable"));
    const renderSessionId = `chrome-${child.pid}-${transport}`;
    const results = [];
    for (const task of tasks) {
      try {
        results.push(
          await guardBrowserOperation(
            child,
            captureWithClient(client, {
              ...task,
              timeoutMs: task.timeoutMs ?? timeoutMs
            }, renderSessionId)
          )
        );
      } catch (error) {
        results.push({
          error: error.message,
          renderSessionId
        });
      }
    }
    return results;
  } catch (error) {
    const renderSessionId = child?.pid
      ? `chrome-${child.pid}-${transport ?? "unavailable"}`
      : null;
    return tasks.map(() => ({
      error: error.message,
      renderSessionId
    }));
  } finally {
    client?.close();
    browserClient?.close();
    if (child) await terminateProcess(child);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

export async function renderScreenshot(options) {
  const [result] = await renderScreenshots({
    chromePath: options.chromePath,
    tasks: [options],
    timeoutMs: options.timeoutMs
  });
  if (result.error) throw new Error(result.error);
  return result;
}

export async function inspectScreenshot(filePath, expected, stripeOptions = null) {
  const buffer = await readFile(filePath);
  return {
    bytes: buffer.length,
    ...inspectPng(buffer, expected),
    stripeFindings: stripeOptions
      ? [
          ...detectEdgeStripes(buffer, stripeOptions),
          ...detectInternalStripes(buffer, stripeOptions)
        ]
      : []
  };
}
