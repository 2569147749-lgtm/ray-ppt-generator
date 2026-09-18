import { createWriteStream, existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";
import {
  discoverSystemBrowserCandidates,
  probeBrowserCandidate,
  selectVerifiedSystemBrowser
} from "./system-browser-discovery.mjs";

export const MANAGED_BROWSER_VERSION = "153.0.8010.47";

const DOWNLOAD_ROOT =
  `https://storage.googleapis.com/chrome-for-testing-public/${MANAGED_BROWSER_VERSION}`;

const BROWSER_SPECS = {
  "mac-arm64": {
    executableRelativePath: path.join(
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell"
    )
  },
  "mac-x64": {
    executableRelativePath: path.join(
      "chrome-headless-shell-mac-x64",
      "chrome-headless-shell"
    )
  },
  win32: {
    executableRelativePath: path.join(
      "chrome-headless-shell-win32",
      "chrome-headless-shell.exe"
    )
  },
  win64: {
    executableRelativePath: path.join(
      "chrome-headless-shell-win64",
      "chrome-headless-shell.exe"
    )
  },
  linux64: {
    executableRelativePath: path.join(
      "chrome-headless-shell-linux64",
      "chrome-headless-shell"
    )
  },
  "linux-arm64": {
    executableRelativePath: path.join(
      "chrome-headless-shell-linux-arm64",
      "chrome-headless-shell"
    )
  }
};

const sleep = (durationMs) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

export function resolveBrowserPlatform({
  platform = process.platform,
  arch = process.arch
} = {}) {
  const key = `${platform}-${arch}`;
  const mapped = {
    "darwin-arm64": "mac-arm64",
    "darwin-x64": "mac-x64",
    "win32-ia32": "win32",
    "win32-x64": "win64",
    "win32-arm64": "win64",
    "linux-x64": "linux64",
    "linux-arm64": "linux-arm64"
  }[key];
  if (!mapped) throw new Error(`Unsupported browser platform: ${key}`);
  return mapped;
}

export function browserSpecFor(platformId = resolveBrowserPlatform()) {
  const base = BROWSER_SPECS[platformId];
  if (!base) throw new Error(`Unsupported Chrome for Testing platform: ${platformId}`);
  return {
    version: MANAGED_BROWSER_VERSION,
    platform: platformId,
    url: `${DOWNLOAD_ROOT}/${platformId}/chrome-headless-shell-${platformId}.zip`,
    ...base
  };
}

export function defaultBrowserCacheDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir()
} = {}) {
  if (env.RAY_PPT_BROWSER_CACHE) return path.resolve(env.RAY_PPT_BROWSER_CACHE);
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ray-ppt-generator", "browser");
  }
  if (env.XDG_CACHE_HOME) {
    return path.join(env.XDG_CACHE_HOME, "ray-ppt-generator", "browser");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", "ray-ppt-generator", "browser");
  }
  return path.join(home, ".cache", "ray-ppt-generator", "browser");
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Archive is not a valid ZIP file.");
}

function checkedSlice(buffer, start, length, label) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    start + length > buffer.length
  ) {
    throw new Error(`ZIP ${label} is outside the archive bounds.`);
  }
  return buffer.subarray(start, start + length);
}

function safeEntryPath(destination, entryName) {
  if (
    !entryName ||
    entryName.includes("\\") ||
    entryName.startsWith("/") ||
    /^[a-zA-Z]:/.test(entryName)
  ) {
    throw new Error(`Unsafe ZIP entry: ${entryName}`);
  }
  const normalized = path.posix.normalize(entryName);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Unsafe ZIP entry: ${entryName}`);
  }
  const outputPath = path.resolve(destination, ...normalized.split("/"));
  const relative = path.relative(path.resolve(destination), outputPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe ZIP entry: ${entryName}`);
  }
  return outputPath;
}

function readZipEntries(archive) {
  const endOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }
  checkedSlice(archive, centralOffset, centralSize, "central directory");

  const entries = [];
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      checkedSlice(archive, offset, 46, "central entry").readUInt32LE(0) !==
      0x02014b50
    ) {
      throw new Error("Archive has an invalid ZIP central directory.");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const name = checkedSlice(
      archive,
      offset + 46,
      nameLength,
      "entry name"
    ).toString("utf8");
    if (flags & 1) throw new Error(`Encrypted ZIP entries are not supported: ${name}`);
    if (![0, 8].includes(compressionMethod)) {
      throw new Error(
        `Unsupported ZIP compression method ${compressionMethod}: ${name}`
      );
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > 2 * 1024 * 1024 * 1024) {
      throw new Error("ZIP archive expands beyond the 2 GiB safety limit.");
    }
    entries.push({
      name,
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      localHeaderOffset
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryPayload(archive, entry) {
  const header = checkedSlice(
    archive,
    entry.localHeaderOffset,
    30,
    `local header for ${entry.name}`
  );
  if (header.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`ZIP local header is invalid: ${entry.name}`);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const compressed = checkedSlice(
    archive,
    entry.localHeaderOffset + 30 + nameLength + extraLength,
    entry.compressedSize,
    `payload for ${entry.name}`
  );
  const content =
    entry.compressionMethod === 0 ? compressed : inflateRawSync(compressed);
  if (content.length !== entry.uncompressedSize) {
    throw new Error(`ZIP entry size mismatch: ${entry.name}`);
  }
  return content;
}

export async function extractZipArchive(archive, destination) {
  if (!Buffer.isBuffer(archive)) {
    throw new TypeError("ZIP archive must be provided as a Buffer.");
  }
  const entries = readZipEntries(archive);
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const outputPath = safeEntryPath(destination, entry.name);
    const unixMode = (entry.externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    if (entry.name.endsWith("/") || fileType === 0o040000) {
      await mkdir(outputPath, { recursive: true });
      continue;
    }
    if (fileType === 0o120000) {
      throw new Error(`Symbolic links are not supported in browser archives: ${entry.name}`);
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    const content = entryPayload(archive, entry);
    await writeFile(outputPath, content);
    if (process.platform !== "win32" && unixMode) {
      await chmod(outputPath, unixMode & 0o777);
    }
  }
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Browser download failed with HTTP ${response.status}: ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function installPaths(cacheDir, spec) {
  const versionRoot = path.join(cacheDir, spec.version);
  const installRoot = path.join(versionRoot, spec.platform);
  return {
    versionRoot,
    installRoot,
    executablePath: path.join(installRoot, spec.executableRelativePath),
    metadataPath: path.join(installRoot, "install.json"),
    lockPath: `${installRoot}.lock`
  };
}

async function isCompleteInstall(paths, spec) {
  if (!existsSync(paths.executablePath) || !existsSync(paths.metadataPath)) return false;
  try {
    const metadata = JSON.parse(await readFile(paths.metadataPath, "utf8"));
    return metadata.version === spec.version && metadata.platform === spec.platform;
  } catch {
    return false;
  }
}

async function acquireInstallLock(paths, {
  timeoutMs = 120_000,
  staleMs = 15 * 60_000
} = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await mkdir(paths.lockPath);
      await writeFile(
        path.join(paths.lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`
      );
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await isCompleteInstall(paths, {
        version: path.basename(path.dirname(paths.installRoot)),
        platform: path.basename(paths.installRoot)
      })) {
        return "completed";
      }
      const lockStat = await stat(paths.lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleMs) {
        await rm(paths.lockPath, { recursive: true, force: true });
        continue;
      }
      await sleep(100);
    }
  }
  throw new Error(`Timed out waiting for browser installation lock: ${paths.lockPath}`);
}

export async function ensureManagedBrowser({
  cacheDir = defaultBrowserCacheDir(),
  spec = browserSpecFor(),
  allowDownload = true,
  download = downloadFile,
  lockOptions,
  onStatus,
  minimumFreeBytes = 350 * 1024 * 1024,
  statfsImpl = statfs
} = {}) {
  const paths = installPaths(path.resolve(cacheDir), spec);
  if (await isCompleteInstall(paths, spec)) {
    return { executablePath: paths.executablePath, cacheHit: true, spec };
  }
  if (!allowDownload) {
    const error = new Error(
      `No managed browser is cached at ${paths.installRoot}, and browser download is disabled.`
    );
    error.code = "MANAGED_BROWSER_CACHE_MISS";
    error.cachePath = paths.installRoot;
    throw error;
  }

  await mkdir(paths.versionRoot, { recursive: true });
  const fileSystem = await statfsImpl(paths.versionRoot);
  const availableBytes =
    Number(fileSystem.bavail ?? fileSystem.bfree) * Number(fileSystem.bsize);
  if (availableBytes < minimumFreeBytes) {
    const requiredMiB = Math.ceil(minimumFreeBytes / 1024 / 1024);
    const availableMiB = Math.floor(availableBytes / 1024 / 1024);
    const error = new Error(
      `Managed browser installation requires ${requiredMiB} MiB free in ${paths.versionRoot}; only ${availableMiB} MiB is available.`
    );
    error.code = "INSUFFICIENT_BROWSER_CACHE_SPACE";
    error.requiredBytes = minimumFreeBytes;
    error.availableBytes = availableBytes;
    throw error;
  }
  const lockState = await acquireInstallLock(paths, lockOptions);
  if (lockState === "completed" || (await isCompleteInstall(paths, spec))) {
    return { executablePath: paths.executablePath, cacheHit: true, spec };
  }

  const temporaryRoot = path.join(
    paths.versionRoot,
    `.${spec.platform}.install-${process.pid}-${Date.now()}`
  );
  const archivePath = path.join(temporaryRoot, "browser.zip");
  const extractedPath = path.join(temporaryRoot, "extracted");
  try {
    await mkdir(temporaryRoot, { recursive: true });
    onStatus?.({ phase: "download-start", spec, destination: archivePath });
    await download(spec.url, archivePath);
    onStatus?.({ phase: "extract-start", spec, destination: extractedPath });
    const archive = await readFile(archivePath);
    await extractZipArchive(archive, extractedPath);
    const executablePath = path.join(extractedPath, spec.executableRelativePath);
    const executableStat = await lstat(executablePath).catch(() => null);
    if (!executableStat?.isFile()) {
      throw new Error(
        `Downloaded browser is missing its executable: ${spec.executableRelativePath}`
      );
    }
    if (process.platform !== "win32") await chmod(executablePath, 0o755);
    await writeFile(
      path.join(extractedPath, "install.json"),
      `${JSON.stringify(
        {
          version: spec.version,
          platform: spec.platform,
          url: spec.url,
          installedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`
    );
    await rm(paths.installRoot, { recursive: true, force: true });
    await rename(extractedPath, paths.installRoot);
    onStatus?.({ phase: "installed", spec, executablePath: paths.executablePath });
    return {
      executablePath: paths.executablePath,
      cacheHit: false,
      spec
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    await rm(paths.lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function validateOverride(candidate, source, probe) {
  const executablePath = path.resolve(candidate);
  if (!existsSync(executablePath)) {
    throw new Error(`Browser override from ${source} does not exist: ${executablePath}`);
  }
  const result = await probe({
    command: executablePath,
    argsPrefix: [],
    product: "Chromium browser",
    source
  });
  if (!result.usable || !result.cdp) {
    const error = new Error(
      `Browser override from ${source} is not usable: ${result.reason ?? "CDP probe failed"}`
    );
    error.code = "BROWSER_OVERRIDE_UNUSABLE";
    error.probe = result;
    throw error;
  }
  return {
    executablePath,
    argsPrefix: [],
    source,
    cacheHit: true,
    product: result.product,
    version: result.version,
    major: result.major
  };
}

async function readRuntimeCache(runtimeCachePath, probe) {
  if (!runtimeCachePath) return null;
  const cachePath = path.resolve(runtimeCachePath);
  if (!existsSync(cachePath)) return null;
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    const executablePath = path.resolve(cached.executablePath ?? "");
    if (!executablePath || !existsSync(executablePath)) return null;
    const result = await probe({
      command: executablePath,
      argsPrefix: cached.argsPrefix ?? [],
      product: cached.product ?? "Chromium browser",
      source: "runtime-cache"
    });
    if (!result.usable || !result.cdp) return null;
    return {
      executablePath,
      argsPrefix: cached.argsPrefix ?? [],
      source: "runtime-cache",
      originalSource: cached.source ?? null,
      cacheHit: true,
      product: result.product ?? cached.product ?? null,
      version: result.version ?? cached.version ?? null,
      major: result.major ?? cached.major ?? null,
      discovery: cached.discovery ?? null
    };
  } catch {
    return null;
  }
}

async function writeRuntimeCache(runtimeCachePath, browser) {
  if (!runtimeCachePath || !browser?.executablePath) return;
  const cachePath = path.resolve(runtimeCachePath);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        executablePath: browser.executablePath,
        argsPrefix: browser.argsPrefix ?? [],
        source: browser.source,
        product: browser.product ?? null,
        version: browser.version ?? browser.spec?.version ?? null,
        major: browser.major ?? null,
        platform: browser.spec?.platform ?? process.platform,
        discovery: browser.discovery ?? null,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
}

export async function resolveBrowserExecutable({
  explicitPath = "",
  env = process.env,
  cacheDir,
  runtimeCachePath = env.RAY_PPT_BROWSER_RUNTIME_CACHE || "",
  allowDownload,
  allowManagedInstall,
  platform = process.platform,
  arch = process.arch,
  install = ensureManagedBrowser,
  discover = discoverSystemBrowserCandidates,
  probe = probeBrowserCandidate,
  download,
  onStatus
} = {}) {
  if (explicitPath) {
    const browser = await validateOverride(explicitPath, "explicit", probe);
    await writeRuntimeCache(runtimeCachePath, browser);
    return browser;
  }
  if (env.CHROME_PATH) {
    const browser = await validateOverride(env.CHROME_PATH, "environment", probe);
    await writeRuntimeCache(runtimeCachePath, browser);
    return browser;
  }
  const cachedRuntime = await readRuntimeCache(runtimeCachePath, probe);
  if (cachedRuntime) return cachedRuntime;
  const spec = browserSpecFor(resolveBrowserPlatform({ platform, arch }));
  const discovery = discover({ platform, arch, env });
  if (discovery.candidates.length > 0) {
    const verified = await selectVerifiedSystemBrowser(discovery.candidates, {
      probe
    });
    if (verified.status === "available") {
      const browser = {
        executablePath: verified.browser.command,
        argsPrefix: verified.browser.argsPrefix ?? [],
        source: "system",
        product: verified.browser.product,
        version: verified.browser.version,
        major: verified.browser.major,
        cacheHit: true,
        discovery: {
          ...discovery,
          probes: verified.probes
        }
      };
      await writeRuntimeCache(runtimeCachePath, browser);
      return browser;
    }
    discovery.probes = verified.probes;
  }

  const resolvedCacheDir =
    cacheDir ?? defaultBrowserCacheDir({ platform, env });
  try {
    const cached = await install({
      cacheDir: resolvedCacheDir,
      spec,
      allowDownload: false,
      onStatus
    });
    const browser = { ...cached, source: "managed", discovery };
    await writeRuntimeCache(runtimeCachePath, browser);
    return browser;
  } catch (error) {
    if (error.code !== "MANAGED_BROWSER_CACHE_MISS") throw error;
  }

  const consentedInstall = allowManagedInstall ?? allowDownload ?? false;
  if (discovery.coverage === "partial" && !consentedInstall) {
    const error = new Error(
      "System browser discovery was incomplete; do not assume Chromium is absent."
    );
    error.code = "VISUAL_RUNTIME_DISCOVERY_INCOMPLETE";
    error.discovery = discovery;
    throw error;
  }
  if (!consentedInstall) {
    const error = new Error(
      "No verified local Chromium runtime was found. Agent, remote, download, or skip decision is required."
    );
    error.code = "VISUAL_RUNTIME_UNAVAILABLE";
    error.discovery = discovery;
    throw error;
  }

  const installed = await install({
    cacheDir: resolvedCacheDir,
    spec,
    allowDownload: true,
    onStatus,
    ...(download ? { download } : {})
  });
  const browser = { ...installed, source: "managed", discovery };
  await writeRuntimeCache(runtimeCachePath, browser);
  return browser;
}
