#!/usr/bin/env node
// Phase 1 catalog probe — mirrors server/connection.ts readCatalog():
// initialize → config/read {cwd} + agents/list {cwd} (without a session: the
// host answers, cf. server.py _omits_session_id) → close. No turn → zero LLM calls.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN = join(homedir(), ".local/bin/vibe-app-server");
const CWD = process.argv[2] ?? process.cwd();
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
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

try {
  const init = await req("initialize", {
    clientInfo: { name: "paseo", version: "0.1.0", entrypoint: "programmatic", terminalEmulator: "unknown" },
    capabilities: { callbackKinds: ["approval", "user_input"], clientTools: [], sessionSpawn: false, sessionPeers: false, sessionPeerRestore: false, sessionPeerMarkSeen: false, agentWorktrees: false, agentProjects: false, childSessionEvents: false, disabledNotifications: [], agentPlugins: [], clientToolDefinitions: [] },
  });
  console.log(`init: ${init.serverInfo.version}`);
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  const [config, agents] = await Promise.all([
    req("config/read", { cwd: CWD }),
    req("agents/list", {}),
  ]);
  console.log(`models: ${config.config.models.length} → ${config.config.models.map((m) => m.alias).slice(0, 8).join(", ")}${config.config.models.length > 8 ? ", …" : ""}`);
  const active = config.config.activeModel;
  console.log(`activeModel: ${active?.alias} (thinking=${active?.thinking}, levels=[${active?.thinkingLevels}], ctx=${active?.maxContextLength})`);
  console.log(`defaultModelAlias=${config.config.defaultModelAlias} defaultAgent=${config.config.defaultAgent}`);
  console.log(`agents(${agents.agents.length}): ${agents.agents.map((a) => `${a.agentType}:${a.name}`).join(", ")}`);
  console.log(`policies(${agents.approvalPolicies.length}): ${agents.approvalPolicies.map((p) => `${p.name}(${p.safety})`).join(", ")}`);

  child.stdin.end();
  setTimeout(() => child.kill("SIGKILL"), 3000);
  console.log("CATALOG OK — zero LLM calls");
  process.exit(0);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  child.kill("SIGKILL");
  process.exit(1);
}
