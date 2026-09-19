function errorMessage(error, fallback) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

class CdpRequestClient {
  constructor({ timeoutMs = 10000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.failure = null;
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      this.failPending(
        new Error(`Chrome DevTools returned an invalid response: ${error.message}`)
      );
      return;
    }
    if (!message.id || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  failPending(error) {
    if (!this.failure) this.failure = error;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  request(method, params, sessionId, write, close) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      const timer = setTimeout(() => {
        const error = new Error(
          `Chrome DevTools request ${method} timed out after ${this.timeoutMs}ms.`
        );
        this.failPending(error);
        close();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        write(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {})
          })
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

export class CdpPipeClient extends CdpRequestClient {
  constructor(browserOutput, browserInput, options = {}) {
    super(options);
    this.browserOutput = browserOutput;
    this.browserInput = browserInput;
    this.buffer = "";
  }

  async connect() {
    if (!this.browserOutput?.readable || !this.browserInput?.writable) {
      throw new Error("Chrome DevTools pipe is not available.");
    }
    this.browserOutput.setEncoding("utf8");
    this.browserOutput.on("data", (chunk) => {
      this.buffer += chunk;
      let boundary = this.buffer.indexOf("\0");
      while (boundary >= 0) {
        const message = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 1);
        if (message) this.handleMessage(message);
        boundary = this.buffer.indexOf("\0");
      }
    });
    const onClosed = () => {
      this.failPending(new Error("Chrome DevTools pipe closed."));
    };
    this.browserOutput.once("end", onClosed);
    this.browserOutput.once("error", (error) => {
      this.failPending(
        new Error(`Chrome DevTools pipe failed: ${errorMessage(error, "unknown error")}`)
      );
    });
    this.browserInput.once("error", (error) => {
      this.failPending(
        new Error(`Chrome DevTools pipe failed: ${errorMessage(error, "unknown error")}`)
      );
    });
  }

  send(method, params = {}, sessionId = null) {
    if (!this.browserInput?.writable || this.browserInput.destroyed) {
      return Promise.reject(
        this.failure ?? new Error("Chrome DevTools pipe is not open.")
      );
    }
    return this.request(
      method,
      params,
      sessionId,
      (message) => this.browserInput.write(`${message}\0`),
      () => this.close()
    );
  }

  close() {
    this.failPending(new Error("Chrome DevTools pipe closed."));
    this.browserInput?.destroy();
    this.browserOutput?.destroy();
  }
}

export class CdpWebSocketClient extends CdpRequestClient {
  constructor(
    url,
    {
      timeoutMs = 10000,
      WebSocketImpl = globalThis.WebSocket
    } = {}
  ) {
    super({ timeoutMs });
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
  }

  async connect() {
    this.socket = new this.WebSocketImpl(this.url);
    await new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        clearTimeout(timer);
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
        this.socket.removeEventListener("close", onClose);
        callback(value);
      };
      const onOpen = () => finish(resolve);
      const onError = (event) =>
        finish(
          reject,
          new Error(
            `Chrome DevTools WebSocket connection failed: ${errorMessage(
              event?.error ?? event?.message,
              "unknown error"
            )}`
          )
        );
      const onClose = (event) =>
        finish(
          reject,
          new Error(
            `Chrome DevTools WebSocket closed before opening${
              event?.code ? ` (code ${event.code})` : ""
            }.`
          )
        );
      const timer = setTimeout(
        () =>
          finish(
            reject,
            new Error(
              `Chrome DevTools connection timed out after ${this.timeoutMs}ms.`
            )
          ),
        this.timeoutMs
      );
      this.socket.addEventListener("open", onOpen);
      this.socket.addEventListener("error", onError);
      this.socket.addEventListener("close", onClose);
    });
    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    this.socket.addEventListener("error", (event) => {
      this.failPending(
        new Error(
          `Chrome DevTools WebSocket connection failed: ${errorMessage(
            event?.error ?? event?.message,
            "unknown error"
          )}`
        )
      );
    });
    this.socket.addEventListener("close", (event) => {
      this.failPending(
        new Error(
          `Chrome DevTools WebSocket connection closed${
            event?.code ? ` (code ${event.code})` : ""
          }.`
        )
      );
    });
  }

  send(method, params = {}, sessionId = null) {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(
        this.failure ?? new Error("Chrome DevTools connection is not open.")
      );
    }
    return this.request(
      method,
      params,
      sessionId,
      (message) => this.socket.send(message),
      () => this.close()
    );
  }

  close() {
    this.failPending(new Error("Chrome DevTools connection closed."));
    this.socket?.close();
  }
}

export class CdpSessionClient {
  constructor(browserClient, sessionId) {
    this.browserClient = browserClient;
    this.sessionId = sessionId;
  }

  static async attachToPage(browserClient) {
    const { targetInfos = [] } = await browserClient.send("Target.getTargets", {});
    const page = targetInfos.find((target) => target.type === "page");
    if (!page?.targetId) {
      throw new Error("Chrome did not expose a page target.");
    }
    const { sessionId } = await browserClient.send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true
    });
    if (!sessionId) {
      throw new Error("Chrome did not attach a DevTools page session.");
    }
    return new CdpSessionClient(browserClient, sessionId);
  }

  send(method, params = {}) {
    return this.browserClient.send(method, params, this.sessionId);
  }

  close() {}
}

export async function verifyCdpClient(client) {
  const version = await client.send("Browser.getVersion", {});
  if (!version?.product) {
    throw new Error("Chrome DevTools Browser.getVersion returned no product.");
  }
  return version;
}

export async function retryCdpConnection(operation, { attempts = 2 } = {}) {
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      failures.push(`attempt ${attempt}: ${errorMessage(error, "unknown error")}`);
    }
  }
  throw new Error(`Chrome DevTools connection failed: ${failures.join("; ")}`);
}

export async function connectCdpTransport(factories) {
  const attempts = [];
  for (const kind of ["pipe", "websocket"]) {
    if (typeof factories[kind] !== "function") continue;
    try {
      const client = await factories[kind]();
      await client.connect();
      attempts.push({ kind, ok: true });
      return { kind, client, attempts };
    } catch (error) {
      attempts.push({
        kind,
        ok: false,
        error: errorMessage(error, "unknown error")
      });
    }
  }
  throw new Error(
    `Chrome DevTools transports failed: ${attempts
      .map((attempt) => `${attempt.kind}: ${attempt.error}`)
      .join("; ")}`
  );
}
