import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CdpPipeClient,
  CdpSessionClient,
  connectCdpTransport,
  retryCdpConnection,
  verifyCdpClient
} from "../lib/cdp-transport.mjs";

function createPipeClient(options = {}) {
  const browserOutput = new PassThrough();
  const browserInput = new PassThrough();
  const client = new CdpPipeClient(browserOutput, browserInput, options);
  return { browserOutput, browserInput, client };
}

test("CDP pipe writes NUL-delimited requests and accepts split responses", async () => {
  const { browserOutput, browserInput, client } = createPipeClient();
  await client.connect();

  const sent = [];
  browserInput.on("data", (chunk) => sent.push(chunk));
  const response = client.send("Browser.getVersion");

  assert.equal(
    Buffer.concat(sent).toString("utf8"),
    '{"id":1,"method":"Browser.getVersion","params":{}}\u0000'
  );

  browserOutput.write('{"id":1,"result":{"product":"Chrome/');
  browserOutput.write('146"}}\u0000');

  assert.deepEqual(await response, { product: "Chrome/146" });
  client.close();
});

test("CDP pipe rejects pending requests when its output closes", async () => {
  const { browserOutput, client } = createPipeClient();
  await client.connect();

  const pending = assert.rejects(
    client.send("Page.captureScreenshot"),
    /pipe closed/i
  );
  browserOutput.end();

  await pending;
});

test("CDP pipe closes after an unanswered request reaches its deadline", async () => {
  const { browserInput, client } = createPipeClient({ timeoutMs: 20 });
  await client.connect();

  await assert.rejects(
    client.send("Runtime.evaluate"),
    /Runtime\.evaluate timed out after 20ms/
  );
  assert.equal(browserInput.destroyed, true);
});

test("CDP transport falls back from pipe to WebSocket and records the failure", async () => {
  const calls = [];
  const websocketClient = {
    async connect() {
      calls.push("websocket-connect");
    },
    close() {
      calls.push("websocket-close");
    }
  };

  const result = await connectCdpTransport({
    pipe: async () => {
      calls.push("pipe");
      throw new Error("pipe unavailable");
    },
    websocket: async () => {
      calls.push("websocket");
      return websocketClient;
    }
  });

  assert.equal(result.kind, "websocket");
  assert.equal(result.client, websocketClient);
  assert.deepEqual(result.attempts, [
    {
      kind: "pipe",
      ok: false,
      error: "pipe unavailable"
    },
    {
      kind: "websocket",
      ok: true
    }
  ]);
  assert.deepEqual(calls, ["pipe", "websocket", "websocket-connect"]);
  websocketClient.close();
});

test("CDP transport reports every attempted transport when none connect", async () => {
  await assert.rejects(
    connectCdpTransport({
      pipe: async () => {
        throw new Error("pipe denied");
      },
      websocket: async () => {
        throw new Error("WebSocket blocked");
      }
    }),
    /pipe: pipe denied; websocket: WebSocket blocked/i
  );
});

test("CDP session routes page commands through the attached target", async () => {
  const calls = [];
  const browserClient = {
    async send(method, params, sessionId) {
      calls.push(
        sessionId ? { method, params, sessionId } : { method, params }
      );
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { targetId: "worker", type: "service_worker" },
            { targetId: "page-1", type: "page" }
          ]
        };
      }
      if (method === "Target.attachToTarget") {
        return { sessionId: "session-1" };
      }
      return { ok: true };
    }
  };

  const session = await CdpSessionClient.attachToPage(browserClient);
  assert.deepEqual(await session.send("Page.enable"), { ok: true });
  assert.deepEqual(calls, [
    { method: "Target.getTargets", params: {} },
    {
      method: "Target.attachToTarget",
      params: { targetId: "page-1", flatten: true }
    },
    {
      method: "Page.enable",
      params: {},
      sessionId: "session-1"
    }
  ]);
});

test("CDP verification executes Browser.getVersion", async () => {
  const calls = [];
  const result = await verifyCdpClient({
    async send(method, params) {
      calls.push({ method, params });
      return {
        product: "Chrome/146.0.0.0",
        protocolVersion: "1.3"
      };
    }
  });

  assert.deepEqual(calls, [{ method: "Browser.getVersion", params: {} }]);
  assert.deepEqual(result, {
    product: "Chrome/146.0.0.0",
    protocolVersion: "1.3"
  });
});

test("CDP connection retry reacquires state once and preserves each error", async () => {
  let attempts = 0;
  const result = await retryCdpConnection(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("stale endpoint");
      return "connected";
    },
    { attempts: 2 }
  );
  assert.equal(result, "connected");

  await assert.rejects(
    retryCdpConnection(
      async (attempt) => {
        throw new Error(`failure-${attempt}`);
      },
      { attempts: 2 }
    ),
    /attempt 1: failure-1; attempt 2: failure-2/i
  );
});
