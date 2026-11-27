#!/usr/bin/env node
// Phase 0 spike — minimal JSON-RPC client for vibe-app-server.
// Goal: capture a full turn (initialize → session/start → turn/start
//       → streaming notifications → turn/completed → session/stop).
// Ref: docs/app-server-protocol.md §1 (framing), §2 (handshake), §3 (cycle), §8 (skeleton).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { openSync, writeSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const BIN = join(homedir(), ".local/bin/vibe-app-server");
const CWD = process.argv[2] ?? process.cwd();
const PROMPT = process.argv[3] ?? "Réponds uniquement: OK";
const OUT = join(dirname(fileURLToPath(import.meta.url)), `transcript-${Date.now()}.jsonl`);
const transcript = openSync(OUT, "w");
const log = (dir, obj) => writeSync(transcript, JSON.stringify({ dir, t: Date.now(), msg: obj }) + "\n");

const child = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let nextId = 1;
const pending = new Map(); // id -> resolve
const waiters = [];       // notifications to filter

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `client-${nextId++}`;
    const msg = { jsonrpc: "2.0", id, method, params: params ?? {} };
    pending.set(id, { resolve, reject });
    log("C→S", msg);
    child.stdin.write(JSON.stringify(msg) + "\n");
  });

const notify = (method, params) => {
  const msg = { jsonrpc: "2.0", method, params: params ?? {} };
  log("C→S", msg);
  child.stdin.write(JSON.stringify(msg) + "\n");
};

const reply = (id, result) => { // server→client response (id = server integer)
  const msg = { jsonrpc: "2.0", id, result };
  log("C→S", msg);
  child.stdin.write(JSON.stringify(msg) + "\n");
};

const notifyIn = (method, params) => { // server→client notification
  for (const w of waiters) w(method, params);
};

const serverRequest = { // server→client requests: immediate ack mandatory
  "callback/call": async (id, params) => {
    reply(id, { callbackId: params.callback.callbackId, accepted: true });
    const cb = params.callback;
    console.error(`[callback] ${cb.callbackId} ${cb.detail?.kind}: ${cb.title}`);
    if (cb.detail?.kind === "approval") {
      await request("callback/result", { // §5: auto-approve for the spike
        sessionId: cb.sessionId,
        result: { callbackId: cb.callbackId, output: { type: "approval", decision: { type: "approve", pathScope: null }, feedback: null } },
      });
    }
    if (cb.detail?.kind === "user_input") {
      await request("callback/result", {
        sessionId: cb.sessionId,
        result: { callbackId: cb.callbackId, output: { type: "user_input", result: { answers: [], cancelled: true } } },
      });
    }
  },
};

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  log("S→C", msg);
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    return;
  }
  if (msg.method && msg.id !== undefined) { serverRequest[msg.method]?.(msg.id, msg.params); return; }
  if (msg.method) notifyIn(msg.method, msg.params);
});

child.stderr.on("data", (d) => console.error(`[stderr] ${d}`));
child.on("exit", (code) => console.error(`[exit] code=${code}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const main = async () => {
  const timer = setTimeout(() => { console.error("[timeout 120s]"); child.kill("SIGTERM"); }, 120_000);
  try {
    // 1-2. initialize (§2) — minimal capabilities, programmatic entrypoint
    const init = await request("initialize", {
      clientInfo: { name: "paseo-spike", version: "0.1.0", entrypoint: "programmatic", terminalEmulator: "unknown" },
      capabilities: { callbackKinds: ["approval", "user_input"], clientTools: [], sessionSpawn: false, sessionPeers: false, sessionPeerRestore: false, sessionPeerMarkSeen: false, agentWorktrees: false, agentProjects: false, childSessionEvents: false, disabledNotifications: [], agentPlugins: [], clientToolDefinitions: [] },
    });
    console.error(`[init] ${init.serverInfo.name} ${init.serverInfo.version} pid=${init.processId}`);
    // 3. initialized (empty params required)
    notify("initialized", {});
    // 4. session/start (§3.1)
    const started = await request("session/start", { agentConfig: { cwd: CWD, trustWorkspace: true }, historyLimit: 200 });
    const sessionId = started.state.session.id;
    console.error(`[session] ${sessionId} status=${started.state.session.status.type} lastEventId=${started.lastEventId}`);
    console.error(`[session] model=${JSON.stringify(started.state.session.model)} agent=${JSON.stringify(started.state.session.agent)} approvalPolicy=${JSON.stringify(started.state.session.approvalPolicy)}`);
    // 6. turn/start + stream capture (§3.3, §4)
    let turnEnd = null; let lastEventId = started.lastEventId; const kinds = {}; let assistant = "";
    const track = (method, params) => {
      if (params?.sessionId && params.sessionId !== sessionId) return;
      if (params?.eventId) { if (params.eventId <= lastEventId) console.error(`[gap] ${lastEventId}→${params.eventId}`); lastEventId = params.eventId; }
      kinds[method] = (kinds[method] ?? 0) + 1;
      if (method === "turn/completed") turnEnd = params.turn.status;
      if (method === "history/entryUpdated" && typeof params.patch === "object")
        for (const op of params.patch) if (op.op === "append" && op.path?.endsWith("/text")) assistant += op.value;
    };
    waiters.push(track);
    const turn = await request("turn/start", {
      sessionId,
      message: [{ type: "text", text: PROMPT }],
      idempotencyKey: randomUUID(),
      clientUserMessageId: "paseo-spike-1",
    });
    console.error(`[turn] ${turn.turn.id} status=${turn.turn.status} lastEventId=${turn.lastEventId}`);
    const deadline = Date.now() + 110_000;
    while (turnEnd === null && Date.now() < deadline) await sleep(200);
    waiters.splice(waiters.indexOf(track), 1);
    console.error(`[turn/end] ${turnEnd} events=${lastEventId} notifs=${JSON.stringify(kinds)}`);
    console.error(`[assistant] ${assistant.slice(0, 400)}`);
    // 10. final state + session/stop
    const final = await request("session/read", { sessionId });
    console.error(`[usage] ${JSON.stringify(final.state.session.tokenUsage)} status=${final.state.session.status.type}`);
    const stop = await request("session/stop", { sessionId, reason: null });
    console.error(`[stop] ${JSON.stringify(stop)}`);
    console.log(`TRANSCRIPT=${OUT} TURN=${turnEnd} USAGE=${JSON.stringify(final.state.session.tokenUsage)}`);
  } finally {
    clearTimeout(timer);
    await sleep(500);
    child.stdin.end();
    await sleep(1500);
    child.kill("SIGKILL");
    closeSync(transcript);
  }
  process.exit(0);
};
main().catch((e) => { console.error(`[fatal] ${e.message}`); child.kill("SIGKILL"); process.exit(1); });
