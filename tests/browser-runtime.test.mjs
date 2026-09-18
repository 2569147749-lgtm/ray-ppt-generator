import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  browserSpecFor,
  ensureManagedBrowser,
  extractZipArchive,
  resolveBrowserExecutable,
  resolveBrowserPlatform
} from "../lib/browser-runtime.mjs";

function zipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const source = Buffer.from(entry.content ?? "");
    const method = entry.method ?? 8;
    const compressed = method === 0 ? source : deflateRawSync(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "ppt-browser-runtime-"));
}

test("maps supported operating systems and architectures to Chrome for Testing", () => {
  assert.equal(
    resolveBrowserPlatform({ platform: "darwin", arch: "arm64" }),
    "mac-arm64"
  );
  assert.equal(
    resolveBrowserPlatform({ platform: "darwin", arch: "x64" }),
    "mac-x64"
  );
  assert.equal(
    resolveBrowserPlatform({ platform: "win32", arch: "x64" }),
    "win64"
  );
  assert.equal(
    resolveBrowserPlatform({ platform: "win32", arch: "ia32" }),
    "win32"
  );
  assert.equal(
    resolveBrowserPlatform({ platform: "win32", arch: "arm64" }),
    "win64"
  );
  assert.equal(
    resolveBrowserPlatform({ platform: "linux", arch: "x64" }),
    "linux64"
  );
  assert.equal(
    resolveBrowserPlatform({ platform: "linux", arch: "arm64" }),
    "linux-arm64"
  );
  assert.throws(
    () => resolveBrowserPlatform({ platform: "freebsd", arch: "x64" }),
    /Unsupported browser platform: freebsd-x64/
  );
});

test("builds pinned official Chrome for Testing specifications", () => {
  const mac = browserSpecFor("mac-arm64");
  const windows = browserSpecFor("win64");
  const linux = browserSpecFor("linux64");

  assert.match(mac.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(mac.url, /^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\//);
  assert.match(mac.executableRelativePath, /chrome-headless-shell$/);
  assert.match(windows.executableRelativePath, /chrome-headless-shell\.exe$/);
  assert.match(linux.executableRelativePath, /chrome-headless-shell$/);
  assert.equal(new Set([mac.version, windows.version, linux.version]).size, 1);
});

test("extracts stored and deflated ZIP files and preserves executable mode", async () => {
  const root = tempDir();
  try {
    const archive = zipArchive([
      {
        name: "chrome-test/readme.txt",
        content: "managed browser",
        method: 0
      },
      {
        name: "chrome-test/chrome",
        content: "#!/bin/sh\nexit 0\n",
        mode: 0o100755
      }
    ]);

    await extractZipArchive(archive, root);

    assert.equal(
      readFileSync(path.join(root, "chrome-test", "readme.txt"), "utf8"),
      "managed browser"
    );
    assert.equal(
      readFileSync(path.join(root, "chrome-test", "chrome"), "utf8"),
      "#!/bin/sh\nexit 0\n"
    );
    if (process.platform !== "win32") {
      assert.ok(statSync(path.join(root, "chrome-test", "chrome")).mode & 0o100);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe or unsupported ZIP entries", async () => {
  for (const [entry, message] of [
    [{ name: "../escape", content: "bad" }, /Unsafe ZIP entry/],
    [{ name: "/absolute", content: "bad" }, /Unsafe ZIP entry/],
    [{ name: "encrypted", content: "bad", flags: 1 }, /Encrypted ZIP entries/],
    [{ name: "unsupported", content: "bad", method: 12 }, /compression method 12/],
    [
      {
        name: "linked-directory",
        content: "../../outside",
        mode: 0o120777
      },
      /Symbolic links are not supported/
    ]
  ]) {
    const root = tempDir();
    try {
      await assert.rejects(extractZipArchive(zipArchive([entry]), root), message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("installs a browser transactionally and reuses the completed cache", async () => {
  const root = tempDir();
  const spec = {
    version: "1.2.3.4",
    platform: "test64",
    url: "https://example.invalid/chrome.zip",
    executableRelativePath: path.join("chrome-test", "chrome")
  };
  const archive = zipArchive([
    {
      name: "chrome-test/chrome",
      content: "#!/bin/sh\nexit 0\n",
      mode: 0o100755
    }
  ]);
  let downloads = 0;
  try {
    const first = await ensureManagedBrowser({
      cacheDir: root,
      spec,
      download: async (_url, destination) => {
        downloads += 1;
        await writeFile(destination, archive);
      }
    });
    const second = await ensureManagedBrowser({
      cacheDir: root,
      spec,
      download: async () => {
        throw new Error("cache hit must not download");
      }
    });

    assert.equal(downloads, 1);
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(first.executablePath, second.executablePath);
    assert.ok(existsSync(first.executablePath));
    assert.equal(
      JSON.parse(
        readFileSync(path.join(path.dirname(path.dirname(first.executablePath)), "install.json"))
      ).version,
      spec.version
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed installation does not publish a partial browser", async () => {
  const root = tempDir();
  const spec = {
    version: "1.2.3.4",
    platform: "test64",
    url: "https://example.invalid/chrome.zip",
    executableRelativePath: path.join("chrome-test", "chrome")
  };
  try {
    await assert.rejects(
      ensureManagedBrowser({
        cacheDir: root,
        spec,
        download: async (_url, destination) => {
          await writeFile(destination, Buffer.from("not a zip"));
        }
      }),
      /valid ZIP/
    );
    assert.equal(existsSync(path.join(root, spec.version, spec.platform)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed installation checks temporary disk capacity before downloading", async () => {
  const root = tempDir();
  const spec = {
    version: "1.2.3.4",
    platform: "test64",
    url: "https://example.invalid/chrome.zip",
    executableRelativePath: path.join("chrome-test", "chrome")
  };
  let downloaded = false;
  try {
    await assert.rejects(
      ensureManagedBrowser({
        cacheDir: root,
        spec,
        minimumFreeBytes: 350 * 1024 * 1024,
        statfsImpl: async () => ({ bavail: 100, bsize: 1024 }),
        download: async () => {
          downloaded = true;
        }
      }),
      (error) => {
        assert.equal(error.code, "INSUFFICIENT_BROWSER_CACHE_SPACE");
        assert.match(error.message, /350 MiB/);
        return true;
      }
    );
    assert.equal(downloaded, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit browser path bypasses managed installation", async () => {
  const root = tempDir();
  const executable = path.join(root, process.platform === "win32" ? "chrome.exe" : "chrome");
  writeFileSync(executable, "");
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  try {
    const result = await resolveBrowserExecutable({
      explicitPath: executable,
      env: {},
      probe: async () => ({
        usable: true,
        cdp: true,
        product: "Google Chrome",
        version: "146.0.7680.80",
        major: 146
      }),
      install: async () => {
        throw new Error("explicit path must bypass install");
      }
    });
    assert.equal(result.executablePath, executable);
    assert.equal(result.source, "explicit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit browser path must pass the same CDP compatibility probe", async () => {
  const root = tempDir();
  const executable = path.join(root, "not-a-browser");
  await writeFile(executable, "");
  try {
    await assert.rejects(
      resolveBrowserExecutable({
        explicitPath: executable,
        env: {},
        probe: async () => ({
          usable: false,
          cdp: false,
          reason: "remote debugging disabled"
        })
      }),
      (error) => {
        assert.equal(error.code, "BROWSER_OVERRIDE_UNUSABLE");
        assert.match(error.message, /remote debugging disabled/);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment override is optional and offline mode reports an actionable miss", async () => {
  const root = tempDir();
  const executable = path.join(root, process.platform === "win32" ? "chrome.exe" : "chrome");
  await writeFile(executable, "");
  try {
    const overridden = await resolveBrowserExecutable({
      env: { CHROME_PATH: executable },
      probe: async () => ({
        usable: true,
        cdp: true,
        product: "Chromium",
        version: "146.0.0.0",
        major: 146
      }),
      install: async () => {
        throw new Error("environment override must bypass install");
      }
    });
    assert.equal(overridden.source, "environment");

    await assert.rejects(
      resolveBrowserExecutable({
        env: {},
        cacheDir: path.join(root, "empty-cache"),
        discover: () => ({
          status: "not-found-in-supported-sources",
          coverage: "complete",
          candidates: [],
          attempts: []
        })
      }),
      (error) => {
        assert.equal(error.code, "VISUAL_RUNTIME_UNAVAILABLE");
        assert.equal(error.discovery.status, "not-found-in-supported-sources");
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default resolution verifies a discovered system browser without downloading", async () => {
  const root = tempDir();
  const command = path.join(root, "chrome");
  await writeFile(command, "");
  try {
    const result = await resolveBrowserExecutable({
      env: {},
      cacheDir: path.join(root, "empty-cache"),
      discover: () => ({
        status: "candidates-found",
        coverage: "complete",
        candidates: [
          {
            command,
            argsPrefix: [],
            product: "Google Chrome",
            source: "macos-applications"
          }
        ],
        attempts: [{ source: "macos-applications", status: "completed" }]
      }),
      probe: async () => ({
        usable: true,
        cdp: true,
        product: "Google Chrome",
        version: "146.0.7680.80",
        major: 146
      }),
      install: async () => {
        throw new Error("default resolution must not download");
      }
    });

    assert.equal(result.source, "system");
    assert.equal(result.executablePath, command);
    assert.equal(result.product, "Google Chrome");
    assert.equal(result.version, "146.0.7680.80");
    assert.equal(result.discovery.coverage, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser runtime resolution reuses a verified runtime cache before system discovery", async () => {
  const root = tempDir();
  const command = path.join(root, "chrome");
  const runtimeCachePath = path.join(root, "runtime-cache.json");
  await writeFile(command, "");
  await writeFile(
    runtimeCachePath,
    `${JSON.stringify({
      executablePath: command,
      product: "Google Chrome",
      version: "146.0.7680.80",
      source: "system"
    })}\n`
  );
  let discovered = false;
  try {
    const result = await resolveBrowserExecutable({
      env: {},
      runtimeCachePath,
      discover: () => {
        discovered = true;
        throw new Error("runtime cache should bypass system discovery");
      },
      probe: async ({ command: probedCommand, source }) => {
        assert.equal(probedCommand, command);
        assert.equal(source, "runtime-cache");
        return {
          usable: true,
          cdp: true,
          product: "Google Chrome",
          version: "146.0.7680.80",
          major: 146
        };
      },
      install: async () => {
        throw new Error("runtime cache should bypass managed install");
      }
    });

    assert.equal(discovered, false);
    assert.equal(result.source, "runtime-cache");
    assert.equal(result.executablePath, command);
    assert.equal(result.version, "146.0.7680.80");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser runtime resolution writes a reusable runtime cache after success", async () => {
  const root = tempDir();
  const command = path.join(root, "chrome");
  const runtimeCachePath = path.join(root, "runtime-cache.json");
  await writeFile(command, "");
  try {
    const result = await resolveBrowserExecutable({
      env: {},
      cacheDir: path.join(root, "empty-cache"),
      runtimeCachePath,
      discover: () => ({
        status: "candidates-found",
        coverage: "complete",
        candidates: [
          {
            command,
            argsPrefix: [],
            product: "Google Chrome",
            source: "macos-applications"
          }
        ],
        attempts: [{ source: "macos-applications", status: "completed" }]
      }),
      probe: async () => ({
        usable: true,
        cdp: true,
        product: "Google Chrome",
        version: "146.0.7680.80",
        major: 146
      }),
      install: async () => {
        throw new Error("default resolution must not download");
      }
    });

    assert.equal(result.source, "system");
    const cached = JSON.parse(readFileSync(runtimeCachePath, "utf8"));
    assert.equal(cached.executablePath, command);
    assert.equal(cached.product, "Google Chrome");
    assert.equal(cached.version, "146.0.7680.80");
    assert.equal(cached.source, "system");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed installation requires explicit consent after local discovery", async () => {
  const root = tempDir();
  let installCalls = 0;
  try {
    const result = await resolveBrowserExecutable({
      env: {},
      cacheDir: path.join(root, "empty-cache"),
      allowManagedInstall: true,
      discover: () => ({
        status: "not-found-in-supported-sources",
        coverage: "complete",
        candidates: [],
        attempts: [{ source: "standard-locations", status: "completed" }]
      }),
      install: async ({ allowDownload }) => {
        installCalls += 1;
        if (!allowDownload) {
          throw Object.assign(new Error("cache miss"), {
            code: "MANAGED_BROWSER_CACHE_MISS"
          });
        }
        return {
          executablePath: path.join(root, "managed", "chrome"),
          cacheHit: false,
          spec: { version: "153.0.8010.47", platform: "test64" }
        };
      }
    });

    assert.equal(installCalls, 2);
    assert.equal(result.source, "managed");
    assert.equal(result.cacheHit, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial discovery remains unknown and cannot silently install", async () => {
  const root = tempDir();
  try {
    await assert.rejects(
      resolveBrowserExecutable({
        env: {},
        cacheDir: path.join(root, "empty-cache"),
        allowManagedInstall: false,
        discover: () => ({
          status: "not-found",
          coverage: "partial",
          candidates: [],
          attempts: [{ source: "windows-app-paths", status: "unavailable" }]
        }),
        install: async ({ allowDownload }) => {
          if (!allowDownload) {
            throw Object.assign(new Error("cache miss"), {
              code: "MANAGED_BROWSER_CACHE_MISS"
            });
          }
          throw new Error("must not install");
        }
      }),
      (error) => {
        assert.equal(error.code, "VISUAL_RUNTIME_DISCOVERY_INCOMPLETE");
        assert.equal(error.discovery.coverage, "partial");
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
