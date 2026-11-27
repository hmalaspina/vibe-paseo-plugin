// Line-delimited JSON-RPC client for vibe-app-server.
// Framing §1: 1 JSON per line, camelCase, server→client ids = integers
// (to relay as-is), errors with string codes.
// stdin EOF = clean server stop (§1); no replay (events/read stub).

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { ProtocolErrorShape, VibeProtocolError } from "./wire";

export interface AppServerSpawnOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

type Resolve = (value: unknown) => void;
type Reject = (error: Error) => void;
type ServerRequestHandler = (
  params: unknown,
  respond: (result: unknown) => void,
  respondError: (code: string, message?: string) => void,
) => Promise<void> | void;

const METHOD_NOT_FOUND_CODE = "-32601";

export class AppServerClient {
  private nextClientId = 1;
  private readonly pending = new Map<string | number, { resolve: Resolve; reject: Reject; timer: NodeJS.Timeout }>();
  private readonly serverHandlers = new Map<string, ServerRequestHandler>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  private child: ReturnType<typeof spawn> | null = null;
  readonly stderr: string[] = [];
  private stdinClosed = false;
  private disposed = false;

  private constructor(private readonly options: AppServerSpawnOptions) {}

  static spawn(options: AppServerSpawnOptions): AppServerClient {
    const client = new AppServerClient(options);
    client.start();
    return client;
  }

  private start(): void {
    const child = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env,
    });
    this.child = child;
    child.on("error", (error) => this.failPending(error));
    const rl = createInterface({ input: child.stdout as Readable });
    rl.on("line", (line) => this.dispatchLine(line));
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      this.stderr.push(text);
      if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200);
    });
    child.on("close", () => this.handleClose());
  }

  private dispatchLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      console.error(`[vibe-provider] non-JSON line from app-server: ${line.slice(0, 300)}`);
      return;
    }
    const { id, method, params, result, error } = message;
    if (id !== undefined && method !== undefined) {
      // Server→client request (callback/call, tools/call, …): quick ack required.
      void this.dispatchServerRequest(id as string | number, method as string, params).catch((e) =>
        console.error(`[vibe-provider] server request ${method} failed: ${e instanceof Error ? e.message : e}`),
      );
      return;
    }
    if (id !== undefined && (result !== undefined || error !== undefined)) {
      const entry = this.pending.get(id as string | number);
      if (entry) this.settle(id as string | number, entry, error, result);
      return;
    }
    if (method !== undefined) this.notifyNotifications(method as string, params);
  }

  private settle(id: string | number, entry: { resolve: Resolve; reject: Reject; timer: NodeJS.Timeout }, error: unknown, result: unknown): void {
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (error) {
      const shape = error as ProtocolErrorShape;
      entry.reject(new VibeProtocolError(shape.code, shape.message, shape.data));
    } else entry.resolve(result);
  }

  private async dispatchServerRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const handler = this.serverHandlers.get(method);
    if (!handler) {
      // Always answer: an ignored server request blocks the session (§5).
      this.write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND_CODE, message: `paseo vibe-provider does not handle ${method} yet` } });
      return;
    }
    await handler(params, (result) => this.write({ jsonrpc: "2.0", id, result }), (code: string, message?: string) =>
      this.write({ jsonrpc: "2.0", id, error: { code, message: message ?? code } }),
    );
  }

  private notifyNotifications(method: string, params: unknown): void {
    for (const listener of [...this.notificationListeners])
      listener(method, params);
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child || this.stdinClosed) return;
    try {
      (this.child.stdin as Writable).write(JSON.stringify(message) + "\n");
    } catch (error) {
      console.error(`[vibe-provider] write failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.disposed || !this.child) return Promise.reject(new Error("vibe app-server process is not running"));
    const id = `client-${this.nextClientId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VibeProtocolError("timeout", `vibe app-server did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as Resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  // A server→client request must be acked immediately (§5.1):
  // register handlers as early as possible.
  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverHandlers.set(method, handler);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private failPending(error: Error): void {
    for (const [, entry] of [...this.pending]) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private handleClose(): void {
    this.failPending(new Error("vibe app-server closed the connection"));
    for (const listener of [...this.closeListeners]) listener();
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (child && child.exitCode === null) {
      // stdin EOF = clean stop (§1). SIGTERM as a fallback.
      this.stdinClosed = true;
      child.stdin?.end();
      const exited = new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 5_000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
      await exited;
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), 2_000);
          child.once("close", () => { clearTimeout(timer); resolve(); });
        });
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      }
    }
    this.failPending(new Error("closed"));
    this.child = null;
  }
}
