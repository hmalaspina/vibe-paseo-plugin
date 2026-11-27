#!/usr/bin/env node
// Phase 2 e2e probe — real turn WITH a tool call to validate the shapes:
//   callback/call (approval): exact payload, ack, callback/result approve
//   history/entryAdded type:"effect" kind:"shell": detail.input + state
//   session/updated tokenUsage, turn/completed
// Budget: a single LLM call.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BIN = join(homedir(), ".local/bin/vibe-app-server");
const CWD = process.argv[2] ?? "/tmp/vibe-e2e";
mkdirSync(CWD, { recursive: true });
const env = { ...process.env, PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH}` };

const child = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"], env });
const pending = new Map();
let n = 0;
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
const req = (method, params) =>
  new Promise((res, rej) => {
    const id = `client-${++n}`;
    pending.set(id, { res, rej });
    send({ jsonrpc: "2.0", id, method, params: params ?? {} });
  });
const seen = { methods: {}, effects: [], callback: null };
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    return;
  }
  if (m.method) {
    seen.methods[m.method] = (seen.methods[m.method] ?? 0) + 1;
    if (m.method === "callback/call") { seen.callback = m; handleCallback(m); return; }
    const params = m.params ?? {};
    if (m.method === "history/entryAdded" && params.entry?.type === "effect") {
      seen.effects.push({ entry: params.entry });
    }
    if (m.method === "history/entryUpdated") {
      const last = seen.effects[seen.effects.length - 1];
      if (last && params.entryId === last.entry.id) console.log(`[effect patch] ${JSON.stringify(params.patch).slice(0, 400)}`);
    }
    if (m.method === "session/updated") {
      const usage = (params.patch ?? []).filter((op) => op.path === "/tokenUsage");
      if (usage.length) console.log(`[usage] ${JSON.stringify(usage[0].value)}`);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

function handleCallback(m) {
  const cb = m.params.callback;
  console.log(`\n=== CALLBACK approval ===`);
  console.log(JSON.stringify(cb, null, 2).slice(0, 2500));
  // immediate ack (integer id relayed as-is)
  send({ jsonrpc: "2.0", id: m.id, result: { callbackId: cb.callbackId, accepted: true } });
  // approve decision
  req("callback/result", {
    sessionId: cb.sessionId,
    result: { callbackId: cb.callbackId, output: { type: "approval", decision: { type: "approve", pathScope: null }, feedback: null } },
  }).then(() => console.log("[callback/result] accepted"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await req("initialize", {
    clientInfo: { name: "paseo", version: "0.1.0", entrypoint: "programmatic", terminalEmulator: "unknown" },
    capabilities: { callbackKinds: ["approval", "user_input"], clientTools: [], sessionSpawn: false, sessionPeers: false, sessionPeerRestore: false, sessionPeerMarkSeen: false, agentWorktrees: false, agentProjects: false, childSessionEvents: false, disabledNotifications: [], agentPlugins: [], clientToolDefinitions: [] },
  });
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  const started = await req("session/start", { agentConfig: { cwd: CWD, trustWorkspace: true }, historyLimit: 200, kind: "normal" });
  const sessionId = started.state.session.id;
  console.log(`session ${sessionId} status=${started.state.session.status?.type} model=${JSON.stringify(started.state.session.model)} policy=${JSON.stringify(started.state.session.approvalPolicy)}`);

  const turn = await req("turn/start", {
    sessionId,
    message: [{ type: "text", text: "Crée un fichier temp.txt contenant le mot \"x\" (outil write), puis utilise l'outil bash pour exécuter exactement : rm -f temp.txt -- puis réponds juste : Done." }],
    clientUserMessageId: "probe-turn-1",
  });
  console.log(`turn ${turn.turn.id} lastEventId=${turn.lastEventId}`);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (seen.methods["turn/completed"]) break;
  }
  await sleep(800); // let session/updated & stats arrive

  console.log(`\n=== NOTIFS === ${JSON.stringify(seen.methods)}`);
  for (const { entry } of seen.effects) {
    console.log(`\n=== EFFECT kind=${entry.detail?.kind} ===`);
    console.log(`detail.input = ${JSON.stringify(entry.detail?.input)}`);
    console.log(`detail.display = ${JSON.stringify(entry.detail?.display)}`);
    console.log(`state initial = ${JSON.stringify(entry.state)}`);
  }

  const final = await req("session/read", { sessionId });
  console.log(`\ntokenUsage final: ${JSON.stringify(final.state.session.tokenUsage)}`);
  console.log(`status final: ${JSON.stringify(final.state.session.status)}`);

  await req("session/stop", { sessionId, reason: null });
  console.log("\nE2E OK");
  child.stdin.end();
  setTimeout(() => child.kill("SIGKILL"), 3000);
  process.exit(0);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  child.kill("SIGKILL");
  process.exit(1);
}
