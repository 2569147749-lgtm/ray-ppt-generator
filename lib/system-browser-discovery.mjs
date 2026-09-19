import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const PRODUCTS = [
  {
    product: "Google Chrome",
    commands: ["google-chrome", "google-chrome-stable", "chrome"],
    macApp: "Google Chrome.app",
    macExecutable: "Google Chrome",
    bundleId: "com.google.Chrome",
    windowsExecutable: "chrome.exe",
    windowsSegments: ["Google", "Chrome", "Application", "chrome.exe"]
  },
  {
    product: "Google Chrome Beta",
    commands: ["google-chrome-beta"],
    macApp: "Google Chrome Beta.app",
    macExecutable: "Google Chrome Beta",
    bundleId: "com.google.Chrome.beta",
    windowsExecutable: "chrome.exe",
    windowsSegments: ["Google", "Chrome Beta", "Application", "chrome.exe"]
  },
  {
    product: "Google Chrome Dev",
    commands: ["google-chrome-unstable"],
    macApp: "Google Chrome Dev.app",
    macExecutable: "Google Chrome Dev",
    bundleId: "com.google.Chrome.dev",
    windowsExecutable: "chrome.exe",
    windowsSegments: ["Google", "Chrome Dev", "Application", "chrome.exe"]
  },
  {
    product: "Google Chrome Canary",
    commands: ["google-chrome-canary"],
    macApp: "Google Chrome Canary.app",
    macExecutable: "Google Chrome Canary",
    bundleId: "com.google.Chrome.canary",
    windowsExecutable: "chrome.exe",
    windowsSegments: ["Google", "Chrome SxS", "Application", "chrome.exe"]
  },
  {
    product: "Microsoft Edge",
    commands: ["microsoft-edge", "microsoft-edge-stable", "msedge"],
    macApp: "Microsoft Edge.app",
    macExecutable: "Microsoft Edge",
    bundleId: "com.microsoft.edgemac",
    windowsExecutable: "msedge.exe",
    windowsSegments: ["Microsoft", "Edge", "Application", "msedge.exe"]
  },
  {
    product: "Microsoft Edge Beta",
    commands: ["microsoft-edge-beta"],
    macApp: "Microsoft Edge Beta.app",
    macExecutable: "Microsoft Edge Beta",
    bundleId: "com.microsoft.edgemac.Beta",
    windowsExecutable: "msedge.exe",
    windowsSegments: ["Microsoft", "Edge Beta", "Application", "msedge.exe"]
  },
  {
    product: "Microsoft Edge Dev",
    commands: ["microsoft-edge-dev"],
    macApp: "Microsoft Edge Dev.app",
    macExecutable: "Microsoft Edge Dev",
    bundleId: "com.microsoft.edgemac.Dev",
    windowsExecutable: "msedge.exe",
    windowsSegments: ["Microsoft", "Edge Dev", "Application", "msedge.exe"]
  },
  {
    product: "Microsoft Edge Canary",
    commands: ["microsoft-edge-canary"],
    macApp: "Microsoft Edge Canary.app",
    macExecutable: "Microsoft Edge Canary",
    bundleId: "com.microsoft.edgemac.Canary",
    windowsExecutable: "msedge.exe",
    windowsSegments: ["Microsoft", "Edge SxS", "Application", "msedge.exe"]
  },
  {
    product: "Chromium",
    commands: ["chromium", "chromium-browser"],
    macApp: "Chromium.app",
    macExecutable: "Chromium",
    bundleId: "org.chromium.Chromium",
    windowsExecutable: "chromium.exe",
    windowsSegments: ["Chromium", "Application", "chromium.exe"]
  },
  {
    product: "Brave Browser",
    commands: ["brave-browser", "brave"],
    macApp: "Brave Browser.app",
    macExecutable: "Brave Browser",
    bundleId: "com.brave.Browser",
    windowsExecutable: "brave.exe",
    windowsSegments: [
      "BraveSoftware",
      "Brave-Browser",
      "Application",
      "brave.exe"
    ]
  },
  {
    product: "Vivaldi",
    commands: ["vivaldi", "vivaldi-stable"],
    macApp: "Vivaldi.app",
    macExecutable: "Vivaldi",
    bundleId: "com.vivaldi.Vivaldi",
    windowsExecutable: "vivaldi.exe",
    windowsSegments: ["Vivaldi", "Application", "vivaldi.exe"]
  },
  {
    product: "Arc",
    commands: ["arc"],
    macApp: "Arc.app",
    macExecutable: "Arc",
    bundleId: "company.thebrowser.Browser",
    windowsExecutable: "Arc.exe",
    windowsSegments: ["TheBrowserCompany", "Arc", "Application", "Arc.exe"]
  }
];

function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000
  });
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  };
}

export function buildBrowserLaunchOptions({
  platform = process.platform,
  profile,
  args = [],
  env = process.env,
  spawnOptions = {}
}) {
  const launchArgs = [
    ...args.slice(0, -1),
    "--disable-breakpad",
    "--noerrdialogs",
    ...args.slice(-1)
  ];
  return {
    args: launchArgs,
    spawnOptions: {
      ...spawnOptions,
      env:
        platform === "darwin"
          ? { ...env, CFFIXED_USER_HOME: profile }
          : env
    }
  };
}

function addCandidate(candidates, seen, candidate, exists) {
  if (!candidate.command || !exists(candidate.command)) return;
  const key =
    process.platform === "win32"
      ? candidate.command.toLowerCase()
      : path.normalize(candidate.command);
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(candidate);
}

function addPathCandidates({ candidates, seen, env, exists, pathApi }) {
  const entries = String(env.PATH ?? "")
    .split(pathApi.delimiter)
    .filter(Boolean);
  for (const product of PRODUCTS) {
    const commandNames =
      pathApi === path.win32
        ? [product.windowsExecutable, ...product.commands.map((name) => `${name}.exe`)]
        : product.commands;
    for (const directory of entries) {
      for (const commandName of commandNames) {
        addCandidate(
          candidates,
          seen,
          {
            product: product.product,
            command: pathApi.join(directory, commandName),
            argsPrefix: [],
            source: "executable-path",
            evidence: { directory, commandName }
          },
          exists
        );
      }
    }
  }
}

function discoverMac({ candidates, seen, home, env, exists, runCommand }) {
  const attempts = [];
  for (const root of ["/Applications", path.join(home, "Applications")]) {
    for (const product of PRODUCTS) {
      addCandidate(
        candidates,
        seen,
        {
          product: product.product,
          command: path.join(
            root,
            product.macApp,
            "Contents",
            "MacOS",
            product.macExecutable
          ),
          argsPrefix: [],
          source: root === "/Applications" ? "macos-applications" : "macos-user-applications",
          evidence: { root, bundleId: product.bundleId }
        },
        exists
      );
    }
  }
  addPathCandidates({
    candidates,
    seen,
    env,
    exists,
    pathApi: path.posix
  });
  attempts.push({
    source: "executable-path",
    status: "completed",
    detail: "Searched PATH for known Chromium executable names."
  });

  let completed = 0;
  for (const product of PRODUCTS) {
    const query = `kMDItemCFBundleIdentifier == '${product.bundleId}'`;
    const result = runCommand("/usr/bin/mdfind", [query]);
    if (result.status !== 0) continue;
    completed += 1;
    for (const appPath of result.stdout.split(/\r?\n/).filter(Boolean)) {
      addCandidate(
        candidates,
        seen,
        {
          product: product.product,
          command: path.join(
            appPath.trim(),
            "Contents",
            "MacOS",
            product.macExecutable
          ),
          argsPrefix: [],
          source: "macos-spotlight",
          evidence: { bundleId: product.bundleId, appPath: appPath.trim() }
        },
        exists
      );
    }
  }
  attempts.push({
    source: "macos-spotlight",
    status:
      completed === PRODUCTS.length
        ? "completed"
        : completed > 0
          ? "partial"
          : "unavailable",
    detail: `Completed ${completed}/${PRODUCTS.length} bundle identifier queries.`
  });
  attempts.push({
    source: "macos-standard-locations",
    status: "completed",
    detail: "Searched system and user Applications directories."
  });
  return attempts;
}

function parseRegistryPath(stdout) {
  const match = String(stdout).match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/im);
  return match?.[1]?.trim() ?? "";
}

function discoverWindows({
  candidates,
  seen,
  home,
  env,
  exists,
  runCommand,
  pathApi
}) {
  const attempts = [];
  const roots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA
  ].filter(Boolean);
  for (const root of roots) {
    for (const product of PRODUCTS) {
      addCandidate(
        candidates,
        seen,
        {
          product: product.product,
          command: pathApi.join(root, ...product.windowsSegments),
          argsPrefix: [],
          source: "windows-standard-locations",
          evidence: { root, executable: product.windowsExecutable }
        },
        exists
      );
    }
  }
  addPathCandidates({ candidates, seen, env, exists, pathApi });
  attempts.push({
    source: "executable-path",
    status: "completed",
    detail: "Searched PATH for known Chromium executable names."
  });

  const registryRoots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths"
  ];
  let completed = 0;
  const total = registryRoots.length * PRODUCTS.length;
  for (const registryRoot of registryRoots) {
    for (const product of PRODUCTS) {
      const key = `${registryRoot}\\${product.windowsExecutable}`;
      const result = runCommand("reg", ["query", key, "/ve"]);
      if (result.status === 127) continue;
      completed += 1;
      if (result.status !== 0) continue;
      const executablePath = parseRegistryPath(result.stdout);
      addCandidate(
        candidates,
        seen,
        {
          product: product.product,
          command: executablePath,
          argsPrefix: [],
          source: "windows-app-paths",
          evidence: { registryKey: key }
        },
        exists
      );
    }
  }
  attempts.push({
    source: "windows-app-paths",
    status:
      completed === total ? "completed" : completed > 0 ? "partial" : "unavailable",
    detail: `Read ${completed}/${total} App Paths registry entries.`
  });
  attempts.push({
    source: "windows-standard-locations",
    status: "completed",
    detail: `Searched ${roots.length} standard installation roots for ${home}.`
  });
  return attempts;
}

function discoverLinux({ candidates, seen, env, exists }) {
  const attempts = [];
  addPathCandidates({
    candidates,
    seen,
    env,
    exists,
    pathApi: path.posix
  });
  attempts.push({
    source: "executable-path",
    status: "completed",
    detail: "Searched PATH for known Chromium executable names."
  });
  const standard = [
    ["/opt/google/chrome/google-chrome", "Google Chrome"],
    ["/opt/microsoft/msedge/msedge", "Microsoft Edge"],
    ["/usr/bin/chromium", "Chromium"],
    ["/usr/bin/chromium-browser", "Chromium"],
    ["/usr/bin/google-chrome", "Google Chrome"],
    ["/usr/bin/microsoft-edge", "Microsoft Edge"],
    ["/usr/bin/brave-browser", "Brave Browser"],
    ["/snap/bin/chromium", "Chromium"]
  ];
  for (const [command, product] of standard) {
    addCandidate(
      candidates,
      seen,
      {
        product,
        command,
        argsPrefix: [],
        source: "linux-standard-locations",
        evidence: { command }
      },
      exists
    );
  }
  attempts.push({
    source: "linux-standard-locations",
    status: "completed",
    detail: "Searched common package and Snap executable locations."
  });
  return attempts;
}

export function discoverSystemBrowserCandidates({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  exists = existsSync,
  runCommand = defaultRunCommand,
  pathApi = platform === "win32" ? path.win32 : path.posix
} = {}) {
  const candidates = [];
  const seen = new Set();
  let attempts;
  if (platform === "darwin") {
    attempts = discoverMac({
      candidates,
      seen,
      home,
      env,
      exists,
      runCommand
    });
  } else if (platform === "win32") {
    attempts = discoverWindows({
      candidates,
      seen,
      home,
      env,
      exists,
      runCommand,
      pathApi
    });
  } else if (platform === "linux") {
    attempts = discoverLinux({ candidates, seen, env, exists });
  } else {
    return {
      status: "unknown",
      coverage: "unsupported",
      platform,
      candidates: [],
      attempts: [
        {
          source: "platform",
          status: "unsupported",
          detail: `System browser discovery does not support ${platform}.`
        }
      ]
    };
  }
  return {
    status: candidates.length > 0 ? "candidates-found" : "not-found-in-supported-sources",
    coverage: attempts.some((attempt) =>
      ["partial", "unavailable", "failed"].includes(attempt.status)
    )
      ? "partial"
      : "complete",
    platform,
    candidates,
    attempts
  };
}

export function parseBrowserVersion(output) {
  const value = String(output).trim();
  const version = value.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!version) return null;
  let product = null;
  if (/Brave/i.test(value)) product = "Brave Browser";
  else if (/Microsoft Edge|msedge/i.test(value)) product = "Microsoft Edge";
  else if (/Google Chrome/i.test(value)) product = "Google Chrome";
  else if (/Chromium/i.test(value)) product = "Chromium";
  else if (/Vivaldi/i.test(value)) product = "Vivaldi";
  if (!product) return null;
  return { product, version, major: Number(version.split(".")[0]) };
}

async function defaultReadVersion(candidate) {
  const result = spawnSync(
    candidate.command,
    [...(candidate.argsPrefix ?? []), "--version"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || result.stdout || `Browser exited ${result.status}`).trim()
    );
  }
  return String(result.stdout || result.stderr).trim();
}

async function terminateProbe(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const finished = () => resolve();
    child.once("exit", finished);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 500).unref();
  });
}

async function defaultProbeCdp(candidate, { timeoutMs = 5000 } = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ppt-browser-probe-"));
  const launch = buildBrowserLaunchOptions({
    profile,
    args: [
      ...(candidate.argsPrefix ?? []),
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank"
    ],
    spawnOptions: {
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    }
  });
  const child = spawn(
    candidate.command,
    launch.args,
    launch.spawnOptions
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const endpoint = stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
      if (endpoint) return { endpoint };
      if (child.exitCode !== null) {
        throw new Error(
          `Browser exited before CDP was ready: ${stderr.trim() || child.exitCode}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`CDP launch timed out after ${timeoutMs}ms.`);
  } finally {
    await terminateProbe(child);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

export async function probeBrowserCandidate(
  candidate,
  {
    minimumMajor = 120,
    readVersion = defaultReadVersion,
    probeCdp = defaultProbeCdp,
    timeoutMs = 5000
  } = {}
) {
  let parsed;
  try {
    parsed = parseBrowserVersion(await readVersion(candidate));
  } catch (error) {
    return {
      usable: false,
      cdp: false,
      reason: `Version check failed: ${error.message}`
    };
  }
  if (!parsed) {
    return {
      usable: false,
      cdp: false,
      reason: "Executable did not report a recognized Chromium browser version."
    };
  }
  if (parsed.major < minimumMajor) {
    return {
      ...parsed,
      usable: false,
      cdp: false,
      reason: `Browser major ${parsed.major} is older than required major ${minimumMajor}.`
    };
  }
  try {
    const cdp = await probeCdp(candidate, { timeoutMs });
    return {
      ...parsed,
      usable: true,
      cdp: true,
      endpointObserved: Boolean(cdp?.endpoint)
    };
  } catch (error) {
    return {
      ...parsed,
      usable: false,
      cdp: false,
      reason: `Headless CDP probe failed: ${error.message}`
    };
  }
}

export async function selectVerifiedSystemBrowser(candidates, { probe }) {
  const probes = [];
  for (const candidate of candidates) {
    const result = await probe(candidate);
    probes.push({ candidate, ...result });
    if (result.usable && result.cdp) {
      return {
        status: "available",
        browser: { ...candidate, ...result },
        probes
      };
    }
  }
  return {
    status: "not-usable",
    browser: null,
    probes
  };
}
