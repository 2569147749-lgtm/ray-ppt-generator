import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateAgentBrowserReport,
  nextVisualRuntimeAction,
  recordVisualAuditSkip,
  validateVisualRuntimeDecision
} from "../lib/visual-runtime-decision.mjs";

const unavailableLocal = {
  status: "not-found-in-supported-sources",
  coverage: "complete",
  candidates: [],
  attempts: [{ source: "standard-locations", status: "completed" }]
};

test("Agent capability cannot be declared absent without an inspected tool inventory", () => {
  assert.deepEqual(evaluateAgentBrowserReport(null), {
    status: "unknown",
    compatible: [],
    reason: "Agent tool inventory has not been inspected."
  });
  assert.throws(
    () =>
      evaluateAgentBrowserReport({
        status: "inspected",
        tools: []
      }),
    /inventorySource/
  );
});

test("Agent browser requires every capability used by the visual audit", () => {
  const result = evaluateAgentBrowserReport({
    status: "inspected",
    inventorySource: "active-agent-tool-registry",
    inspectedAt: "2026-09-17T12:00:00.000Z",
    tools: [
      {
        name: "screenshot-only",
        capabilities: {
          localContent: true,
          javascript: false,
          viewport: true,
          screenshot: true,
          domGeometry: false
        }
      },
      {
        name: "full-browser-adapter",
        adapter: "agent://browser/full",
        capabilities: {
          localContent: true,
          javascript: true,
          viewport: true,
          screenshot: true,
          domGeometry: true
        }
      }
    ]
  });

  assert.equal(result.status, "available");
  assert.deepEqual(result.compatible.map((tool) => tool.name), [
    "full-browser-adapter"
  ]);
});

test("fallback sequence stops for Agent inspection before remote or download", () => {
  const action = nextVisualRuntimeAction({
    local: unavailableLocal,
    agent: null,
    remote: {
      status: "available",
      endpoint: "https://renderer.example.com",
      consent: "granted"
    },
    download: { consent: "granted" }
  });

  assert.equal(action.action, "inspect-agent-capabilities");
  assert.deepEqual(action.requiredCapabilities, [
    "localContent",
    "javascript",
    "viewport",
    "screenshot",
    "domGeometry"
  ]);
  assert.deepEqual(action.requiredInventorySources, [
    "active tools",
    "installed browser Skills",
    "configured browser plugins",
    "configured MCP servers"
  ]);
});

test("compatible Agent browser wins before remote rendering", () => {
  const action = nextVisualRuntimeAction({
    local: unavailableLocal,
    agent: {
      status: "inspected",
      inventorySource: "active-agent-tool-registry",
      inspectedAt: "2026-09-17T12:00:00.000Z",
      tools: [
        {
          name: "browser",
          adapter: "agent://browser",
          capabilities: {
            localContent: true,
            javascript: true,
            viewport: true,
            screenshot: true,
            domGeometry: true
          }
        }
      ]
    },
    remote: {
      status: "available",
      endpoint: "https://renderer.example.com",
      consent: "granted"
    }
  });

  assert.equal(action.action, "use-agent-browser");
  assert.equal(action.tool.name, "browser");
});

test("remote rendering requires a configured HTTPS service and upload consent", () => {
  const inspectedAgent = {
    status: "inspected",
    inventorySource: "active-agent-tool-registry",
    inspectedAt: "2026-09-17T12:00:00.000Z",
    tools: []
  };
  assert.equal(
    nextVisualRuntimeAction({
      local: unavailableLocal,
      agent: inspectedAgent,
      remote: {
        status: "available",
        endpoint: "https://renderer.example.com",
        consent: "unknown"
      }
    }).action,
    "request-remote-consent"
  );
  assert.equal(
    nextVisualRuntimeAction({
      local: unavailableLocal,
      agent: inspectedAgent,
      remote: {
        status: "available",
        endpoint: "https://renderer.example.com",
        consent: "granted"
      }
    }).action,
    "use-remote-renderer"
  );
  assert.throws(
    () =>
      nextVisualRuntimeAction({
        local: unavailableLocal,
        agent: inspectedAgent,
        remote: {
          status: "available",
          endpoint: "http://renderer.example.com",
          consent: "granted"
        }
      }),
    /HTTPS/
  );
});

test("managed download and audit skip both require explicit consent", () => {
  const inspectedAgent = {
    status: "inspected",
    inventorySource: "active-agent-tool-registry",
    inspectedAt: "2026-09-17T12:00:00.000Z",
    tools: []
  };
  const base = {
    local: unavailableLocal,
    agent: inspectedAgent,
    remote: {
      status: "unavailable",
      evidence: "No remote renderer is configured."
    }
  };

  assert.equal(
    nextVisualRuntimeAction({
      ...base,
      download: { consent: "unknown" }
    }).action,
    "request-download-consent"
  );
  assert.equal(
    nextVisualRuntimeAction({
      ...base,
      download: { consent: "granted" }
    }).action,
    "install-managed-browser"
  );
  assert.equal(
    nextVisualRuntimeAction({
      ...base,
      download: { consent: "denied" },
      skip: { consent: "unknown" }
    }).action,
    "request-skip-confirmation"
  );
  assert.deepEqual(
    nextVisualRuntimeAction({
      ...base,
      download: { consent: "denied" },
      skip: {
        consent: "granted",
        reason: "User declined every rendering option."
      }
    }),
    {
      action: "skip-visual-audit",
      reason: "User declined every rendering option."
    }
  );
});

test("decision artifact rejects skipped steps and validates the complete sequence", () => {
  assert.throws(
    () =>
      validateVisualRuntimeDecision({
        local: unavailableLocal,
        download: { consent: "granted" },
        selectedAction: "install-managed-browser"
      }),
    /Agent capability inspection is required/
  );

  const decision = validateVisualRuntimeDecision({
    local: unavailableLocal,
    agent: {
      status: "inspected",
      inventorySource: "active-agent-tool-registry",
      inspectedAt: "2026-09-17T12:00:00.000Z",
      tools: []
    },
    remote: {
      status: "unavailable",
      evidence: "No remote renderer is configured."
    },
    download: { consent: "granted" },
    selectedAction: "install-managed-browser"
  });

  assert.equal(decision.selectedAction, "install-managed-browser");
  assert.equal(decision.next.action, "install-managed-browser");
});

test("explicit skip is recorded without claiming the visual audit passed", async () => {
  const deck = mkdtempSync(path.join(os.tmpdir(), "ppt-runtime-skip-"));
  writeFileSync(
    path.join(deck, "deck-project.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      template: "test",
      visualAudit: { status: "required", report: null, captures: 0 }
    })}\n`
  );
  try {
    const result = await recordVisualAuditSkip(deck, {
      reason: "User declined every rendering option.",
      decisionPath: path.join(deck, "visual-runtime-decision.json"),
      skippedAt: "2026-09-17T12:00:00.000Z"
    });
    const project = JSON.parse(
      readFileSync(path.join(deck, "deck-project.json"), "utf8")
    );

    assert.equal(result.status, "skipped");
    assert.equal(project.visualAudit.status, "skipped");
    assert.equal(project.visualAudit.report, null);
    assert.equal(project.visualAudit.captures, 0);
    assert.equal(
      project.visualAudit.reason,
      "User declined every rendering option."
    );
  } finally {
    await rm(deck, { recursive: true, force: true });
  }
});
