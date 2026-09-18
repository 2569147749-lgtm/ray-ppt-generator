import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteTextFiles } from "./atomic-files.mjs";

const REQUIRED_AGENT_CAPABILITIES = [
  "localContent",
  "javascript",
  "viewport",
  "screenshot",
  "domGeometry"
];

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

export function evaluateAgentBrowserReport(report) {
  if (!report) {
    return {
      status: "unknown",
      compatible: [],
      reason: "Agent tool inventory has not been inspected."
    };
  }
  requireObject(report, "Agent capability report");
  if (report.status !== "inspected") {
    throw new Error('Agent capability report status must be "inspected".');
  }
  if (!String(report.inventorySource ?? "").trim()) {
    throw new Error("Agent capability report requires inventorySource.");
  }
  if (!String(report.inspectedAt ?? "").trim()) {
    throw new Error("Agent capability report requires inspectedAt.");
  }
  if (!Array.isArray(report.tools)) {
    throw new Error("Agent capability report requires a tools array.");
  }
  const compatible = report.tools.filter((tool) => {
    if (!String(tool.name ?? "").trim() || !String(tool.adapter ?? "").trim()) {
      return false;
    }
    return REQUIRED_AGENT_CAPABILITIES.every(
      (capability) => tool.capabilities?.[capability] === true
    );
  });
  return {
    status: compatible.length > 0 ? "available" : "unavailable",
    compatible,
    inspectedAt: report.inspectedAt,
    inventorySource: report.inventorySource,
    inspectedTools: report.tools.map((tool) => String(tool.name ?? "")).filter(Boolean),
    ...(compatible.length === 0
      ? {
          reason:
            "No inspected Agent tool satisfies the complete visual-audit capability contract."
        }
      : {})
  };
}

function validateRemote(remote) {
  if (!remote) return { status: "unknown" };
  requireObject(remote, "Remote renderer report");
  if (remote.status === "unavailable") {
    if (!String(remote.evidence ?? "").trim()) {
      throw new Error("Unavailable remote renderer requires evidence.");
    }
    return remote;
  }
  if (remote.status !== "available") {
    throw new Error('Remote renderer status must be "available" or "unavailable".');
  }
  let endpoint;
  try {
    endpoint = new URL(remote.endpoint);
  } catch {
    throw new Error("Remote renderer requires a valid HTTPS endpoint.");
  }
  if (endpoint.protocol !== "https:") {
    throw new Error("Remote renderer requires an HTTPS endpoint.");
  }
  if (!["unknown", "granted", "denied"].includes(remote.consent)) {
    throw new Error("Remote renderer consent must be unknown, granted, or denied.");
  }
  return { ...remote, endpoint: endpoint.href };
}

function consentOf(decision) {
  const consent = decision?.consent ?? "unknown";
  if (!["unknown", "granted", "denied"].includes(consent)) {
    throw new Error("Consent must be unknown, granted, or denied.");
  }
  return consent;
}

export function nextVisualRuntimeAction(decision) {
  requireObject(decision, "Visual runtime decision");
  requireObject(decision.local, "Local discovery report");

  if (decision.local.status === "available") {
    return {
      action: "use-local-browser",
      browser: decision.local.browser
    };
  }
  if (
    decision.local.coverage === "partial" &&
    decision.local.userConfirmedNoAdditionalBrowser !== true
  ) {
    return {
      action: "resolve-local-discovery-gap",
      attempts: decision.local.attempts ?? []
    };
  }

  const agent = evaluateAgentBrowserReport(decision.agent);
  if (agent.status === "unknown") {
    return {
      action: "inspect-agent-capabilities",
      requiredCapabilities: [...REQUIRED_AGENT_CAPABILITIES],
      requiredInventorySources: [
        "active tools",
        "installed browser Skills",
        "configured browser plugins",
        "configured MCP servers"
      ]
    };
  }
  if (agent.status === "available") {
    return {
      action: "use-agent-browser",
      tool: agent.compatible[0],
      evidence: agent
    };
  }

  const remote = validateRemote(decision.remote);
  if (remote.status === "unknown") {
    return { action: "inspect-remote-renderer" };
  }
  if (remote.status === "available") {
    if (remote.consent === "unknown") {
      return {
        action: "request-remote-consent",
        endpoint: remote.endpoint
      };
    }
    if (remote.consent === "granted") {
      return {
        action: "use-remote-renderer",
        endpoint: remote.endpoint
      };
    }
  }

  const downloadConsent = consentOf(decision.download);
  if (downloadConsent === "unknown") {
    return {
      action: "request-download-consent",
      downloadMiB: 120,
      installedMiBEstimate: 200,
      temporaryMiBEstimate: 350
    };
  }
  if (downloadConsent === "granted") {
    return { action: "install-managed-browser" };
  }

  const skipConsent = consentOf(decision.skip);
  if (skipConsent === "unknown") {
    return { action: "request-skip-confirmation" };
  }
  if (skipConsent !== "granted") {
    return { action: "blocked", reason: "Visual audit has no authorized runtime." };
  }
  const reason = String(decision.skip?.reason ?? "").trim();
  if (!reason) throw new Error("Skipping visual audit requires a reason.");
  return { action: "skip-visual-audit", reason };
}

export function validateVisualRuntimeDecision(decision) {
  if (!decision.agent) {
    throw new Error("Agent capability inspection is required before later fallbacks.");
  }
  const next = nextVisualRuntimeAction(decision);
  if (decision.selectedAction !== next.action) {
    throw new Error(
      `Selected action "${decision.selectedAction}" does not match required action "${next.action}".`
    );
  }
  return { ...decision, next };
}

export async function recordVisualAuditSkip(
  deckDir,
  {
    reason,
    decisionPath = null,
    skippedAt = new Date().toISOString()
  }
) {
  const normalizedReason = String(reason ?? "").trim();
  if (!normalizedReason) {
    throw new Error("Skipping visual audit requires a reason.");
  }
  const projectPath = path.join(deckDir, "deck-project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  const visualAudit = {
    status: "skipped",
    report: null,
    captures: 0,
    reason: normalizedReason,
    decision: decisionPath,
    updatedAt: skippedAt
  };
  await atomicWriteTextFiles([
    {
      path: projectPath,
      content: `${JSON.stringify(
        {
          ...project,
          updatedAt: skippedAt,
          visualAudit
        },
        null,
        2
      )}\n`
    }
  ]);
  return visualAudit;
}
