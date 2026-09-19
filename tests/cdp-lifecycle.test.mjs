import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as visualAudit from "../lib/visual-audit.mjs";

class FakeWebSocket extends EventTarget {
  static instances = [];

  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

test("CDP connection rejects when the WebSocket never opens", async () => {
  assert.equal(typeof visualAudit.CdpClient, "function");
  const client = new visualAudit.CdpClient("ws://example.test", {
    timeoutMs: 20,
    WebSocketImpl: FakeWebSocket
  });

  await assert.rejects(client.connect(), /connection timed out after 20ms/i);
});

test("CDP rejects pending requests when the WebSocket closes", async () => {
  assert.equal(typeof visualAudit.CdpClient, "function");
  const client = new visualAudit.CdpClient("ws://example.test", {
    timeoutMs: 100,
    WebSocketImpl: FakeWebSocket
  });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  await connecting;

  const rejected = assert.rejects(
    client.send("Page.captureScreenshot"),
    /connection closed/i
  );
  socket.close();
  await rejected;
});

test("CDP rejects an unanswered request at its deadline", async () => {
  assert.equal(typeof visualAudit.CdpClient, "function");
  const client = new visualAudit.CdpClient("ws://example.test", {
    timeoutMs: 20,
    WebSocketImpl: FakeWebSocket
  });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  await connecting;

  await assert.rejects(
    client.send("Runtime.evaluate"),
    /Runtime\.evaluate timed out after 20ms/
  );
  assert.equal(socket.readyState, 3);
  await assert.rejects(
    client.send("Page.captureScreenshot"),
    /Runtime\.evaluate timed out after 20ms/
  );
});

test("browser process exit rejects an in-flight operation", async () => {
  assert.equal(typeof visualAudit.guardBrowserOperation, "function");
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const guarded = visualAudit.guardBrowserOperation(
    child,
    new Promise(() => {})
  );

  child.exitCode = 17;
  child.emit("exit", 17, null);

  await assert.rejects(guarded, /Chrome exited unexpectedly with code 17/i);
});

test("browser termination resolves even when the child never emits exit", async () => {
  assert.equal(typeof visualAudit.terminateProcess, "function");
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  const childSignals = [];
  child.kill = (signal) => {
    childSignals.push(signal);
  };
  const groupSignals = [];

  await visualAudit.terminateProcess(child, {
    forceDelayMs: 10,
    killProcess: (pid, signal) => {
      groupSignals.push({ pid, signal });
    }
  });

  assert.deepEqual(groupSignals, [
    { pid: -4242, signal: "SIGTERM" },
    { pid: -4242, signal: "SIGKILL" }
  ]);
  assert.deepEqual(childSignals, []);
});

test("browser exit becomes a capture error and cleans the temporary profile", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ppt-browser-exit-test-"));
  const outputPath = path.join(root, "slide.png");
  const results = await visualAudit.renderScreenshots({
    chromePath: process.execPath,
    tasks: [
      {
        url: "about:blank",
        outputPath,
        width: 1440,
        height: 900,
        expectedSlide: "slide"
      }
    ],
    timeoutMs: 1000
  });

  assert.equal(results.length, 1);
  assert.match(results[0].error, /Chrome exited before DevTools was ready/i);
  assert.equal(
    readdirSync(root).some((entry) => entry.startsWith(".chrome-profile-")),
    false
  );
});
