import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  discoverSystemBrowserCandidates,
  parseBrowserVersion,
  probeBrowserCandidate,
  selectVerifiedSystemBrowser
} from "../lib/system-browser-discovery.mjs";

function fakeFileSystem(paths) {
  const existing = new Set(paths.map((entry) => path.normalize(entry)));
  return {
    exists: (candidate) => existing.has(path.normalize(candidate))
  };
}

function commandRunner(
  responses,
  fallback = {
    status: 127,
    stdout: "",
    stderr: "command unavailable"
  }
) {
  return (command, args) => {
    const key = `${command}\0${args.join("\0")}`;
    return responses.get(key) ?? fallback;
  };
}

test("macOS discovery combines standard, user, PATH, and Spotlight candidates", () => {
  const home = "/Users/example";
  const standardChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const userEdge =
    "/Users/example/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
  const customBrave =
    "/Volumes/Apps/Brave Browser.app/Contents/MacOS/Brave Browser";
  const pathChromium = "/opt/homebrew/bin/chromium";
  const responses = new Map([
    [
      "/usr/bin/mdfind\0kMDItemCFBundleIdentifier == 'com.google.Chrome'",
      {
        status: 0,
        stdout: "/Applications/Google Chrome.app\n",
        stderr: ""
      }
    ],
    [
      "/usr/bin/mdfind\0kMDItemCFBundleIdentifier == 'com.microsoft.edgemac'",
      {
        status: 0,
        stdout: "",
        stderr: ""
      }
    ],
    [
      "/usr/bin/mdfind\0kMDItemCFBundleIdentifier == 'com.brave.Browser'",
      {
        status: 0,
        stdout: "/Volumes/Apps/Brave Browser.app\n",
        stderr: ""
      }
    ],
    [
      "/usr/bin/mdfind\0kMDItemCFBundleIdentifier == 'org.chromium.Chromium'",
      {
        status: 0,
        stdout: "",
        stderr: ""
      }
    ],
    [
      "/usr/bin/mdfind\0kMDItemCFBundleIdentifier == 'com.vivaldi.Vivaldi'",
      {
        status: 0,
        stdout: "",
        stderr: ""
      }
    ]
  ]);
  const { exists } = fakeFileSystem([
    standardChrome,
    userEdge,
    customBrave,
    pathChromium
  ]);

  const result = discoverSystemBrowserCandidates({
    platform: "darwin",
    home,
    env: { PATH: "/opt/homebrew/bin:/usr/bin" },
    exists,
    runCommand: commandRunner(responses, {
      status: 0,
      stdout: "",
      stderr: ""
    })
  });

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.command),
    [standardChrome, userEdge, pathChromium, customBrave]
  );
  assert.equal(
    result.candidates.filter((candidate) => candidate.command === standardChrome)
      .length,
    1
  );
  assert.ok(
    result.attempts.some(
      (attempt) => attempt.source === "macos-spotlight" && attempt.status === "completed"
    )
  );
});

test("Windows discovery combines registry, standard, and PATH candidates", () => {
  const edge =
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const chrome = "D:\\Portable\\Chrome\\chrome.exe";
  const brave =
    "C:\\Users\\example\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
  const responses = new Map([
    [
      "reg\0query\0HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\0/ve",
      {
        status: 0,
        stdout: `    (Default)    REG_SZ    ${chrome}\r\n`,
        stderr: ""
      }
    ]
  ]);
  const { exists } = fakeFileSystem([edge, chrome, brave]);

  const result = discoverSystemBrowserCandidates({
    platform: "win32",
    home: "C:\\Users\\example",
    env: {
      PATH: "D:\\Portable\\Chrome",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local"
    },
    exists,
    runCommand: commandRunner(responses),
    pathApi: path.win32
  });

  assert.ok(result.candidates.some((candidate) => candidate.command === edge));
  assert.ok(result.candidates.some((candidate) => candidate.command === chrome));
  assert.ok(result.candidates.some((candidate) => candidate.command === brave));
  assert.ok(
    result.attempts.some(
      (attempt) => attempt.source === "windows-app-paths" && attempt.status === "partial"
    )
  );
});

test("Linux discovery records PATH and standard-location evidence", () => {
  const chromium = "/usr/bin/chromium";
  const chrome = "/opt/google/chrome/google-chrome";
  const { exists } = fakeFileSystem([chromium, chrome]);

  const result = discoverSystemBrowserCandidates({
    platform: "linux",
    home: "/home/example",
    env: { PATH: "/usr/local/bin:/usr/bin" },
    exists,
    runCommand: commandRunner(new Map())
  });

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.command),
    [chromium, chrome]
  );
  assert.ok(
    result.attempts.some(
      (attempt) => attempt.source === "executable-path" && attempt.status === "completed"
    )
  );
});

test("unsupported system discovery is unknown instead of absent", () => {
  const result = discoverSystemBrowserCandidates({
    platform: "freebsd",
    env: {},
    exists: () => false,
    runCommand: commandRunner(new Map())
  });

  assert.equal(result.status, "unknown");
  assert.equal(result.coverage, "unsupported");
  assert.deepEqual(result.candidates, []);
});

test("browser version parser recognizes Chrome Edge Chromium and Brave", () => {
  assert.deepEqual(parseBrowserVersion("Google Chrome 146.0.7680.80"), {
    product: "Google Chrome",
    version: "146.0.7680.80",
    major: 146
  });
  assert.deepEqual(parseBrowserVersion("Microsoft Edge 145.0.1.2"), {
    product: "Microsoft Edge",
    version: "145.0.1.2",
    major: 145
  });
  assert.deepEqual(parseBrowserVersion("Chromium 144.0.0.0"), {
    product: "Chromium",
    version: "144.0.0.0",
    major: 144
  });
  assert.deepEqual(parseBrowserVersion("Brave Browser 1.78.0 Chromium: 136.0.0.0"), {
    product: "Brave Browser",
    version: "136.0.0.0",
    major: 136
  });
  assert.equal(parseBrowserVersion("Safari 26.0"), null);
});

test("verified selection probes every candidate until CDP succeeds", async () => {
  const candidates = [
    { command: "/bad/chrome", product: "Google Chrome", source: "standard" },
    { command: "/good/edge", product: "Microsoft Edge", source: "registry" }
  ];
  const probed = [];
  const result = await selectVerifiedSystemBrowser(candidates, {
    probe: async (candidate) => {
      probed.push(candidate.command);
      return candidate.command.includes("good")
        ? {
            usable: true,
            product: "Microsoft Edge",
            version: "146.0.1.2",
            major: 146,
            cdp: true
          }
        : {
            usable: false,
            product: "Google Chrome",
            version: "80.0.0.0",
            major: 80,
            cdp: false,
            reason: "CDP launch failed"
          };
    }
  });

  assert.deepEqual(probed, ["/bad/chrome", "/good/edge"]);
  assert.equal(result.status, "available");
  assert.equal(result.browser.command, "/good/edge");
  assert.equal(result.probes.length, 2);
});

test("browser probe requires a recognized modern version and working CDP", async () => {
  const candidate = {
    command: "/browser",
    argsPrefix: [],
    product: "Chromium",
    source: "test"
  };
  const old = await probeBrowserCandidate(candidate, {
    minimumMajor: 120,
    readVersion: async () => "Chromium 119.0.0.0",
    probeCdp: async () => {
      throw new Error("old browser must not launch");
    }
  });
  assert.equal(old.usable, false);
  assert.match(old.reason, /older than required major 120/);

  const blocked = await probeBrowserCandidate(candidate, {
    minimumMajor: 120,
    readVersion: async () => "Chromium 146.0.0.0",
    probeCdp: async () => {
      throw new Error("remote debugging disabled");
    }
  });
  assert.equal(blocked.usable, false);
  assert.match(blocked.reason, /remote debugging disabled/);

  const usable = await probeBrowserCandidate(candidate, {
    minimumMajor: 120,
    readVersion: async () => "Chromium 146.0.0.0",
    probeCdp: async () => ({ endpoint: "ws://127.0.0.1/devtools/browser/test" })
  });
  assert.equal(usable.usable, true);
  assert.equal(usable.cdp, true);
  assert.equal(usable.version, "146.0.0.0");
});

test("real system Chrome passes a bounded CDP launch probe", async (context) => {
  if (process.platform !== "darwin") return context.skip("macOS integration fixture");
  const command =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(command)) {
    return context.skip("system Chrome is not installed");
  }

  const result = await probeBrowserCandidate({
    command,
    argsPrefix: [],
    product: "Google Chrome",
    source: "macos-applications"
  });
  if (!result.usable) {
    return context.skip(result.reason);
  }

  assert.equal(result.usable, true);
  assert.equal(result.cdp, true);
  assert.match(result.version, /^\d+\.\d+\.\d+\.\d+$/);
});
