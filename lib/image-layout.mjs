function validDimensions(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(`Invalid image dimensions: ${width}x${height}.`);
  }
  return { width, height };
}

function inspectPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("Invalid PNG image.");
  }
  return validDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

function inspectGif(buffer) {
  const signature = buffer.toString("ascii", 0, 6);
  if (buffer.length < 10 || !["GIF87a", "GIF89a"].includes(signature)) {
    throw new Error("Invalid GIF image.");
  }
  return validDimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}

function inspectJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("Invalid JPEG image.");
  }
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf
  ]);
  let offset = 2;
  while (offset + 3 < buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return validDimensions(
        buffer.readUInt16BE(offset + 5),
        buffer.readUInt16BE(offset + 3)
      );
    }
    offset += length;
  }
  throw new Error("JPEG dimensions were not found.");
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function inspectWebp(buffer) {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new Error("Invalid WebP image.");
  }
  const type = buffer.toString("ascii", 12, 16);
  if (type === "VP8X") {
    return validDimensions(
      readUInt24LE(buffer, 24) + 1,
      readUInt24LE(buffer, 27) + 1
    );
  }
  if (type === "VP8 " && buffer.toString("hex", 23, 26) === "9d012a") {
    return validDimensions(
      buffer.readUInt16LE(26) & 0x3fff,
      buffer.readUInt16LE(28) & 0x3fff
    );
  }
  if (type === "VP8L" && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return validDimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  throw new Error("WebP dimensions were not found.");
}

function inspectAvif(buffer) {
  const marker = Buffer.from("ispe");
  const index = buffer.indexOf(marker);
  if (index < 0 || index + 16 > buffer.length) {
    throw new Error("AVIF dimensions were not found.");
  }
  return validDimensions(
    buffer.readUInt32BE(index + 8),
    buffer.readUInt32BE(index + 12)
  );
}

export function inspectImageDimensions(buffer, extension) {
  const normalized = String(extension).toLowerCase();
  if (normalized === ".png") return inspectPng(buffer);
  if (normalized === ".jpg" || normalized === ".jpeg") return inspectJpeg(buffer);
  if (normalized === ".gif") return inspectGif(buffer);
  if (normalized === ".webp") return inspectWebp(buffer);
  if (normalized === ".avif") return inspectAvif(buffer);
  throw new Error(`Unsupported image type "${normalized || "none"}".`);
}

export function chooseImageLayout(width, height) {
  validDimensions(width, height);
  const aspectRatio = Number((width / height).toFixed(4));
  let layout;
  if (aspectRatio < 0.9) layout = "portrait";
  else if (aspectRatio < 1.15) layout = "square";
  else if (aspectRatio <= 1.5) layout = "landscape-standard";
  else layout = "landscape-wide";
  return { width, height, aspectRatio, layout };
}
