// Connection to vibe-app-server: handshake (§2), catalog via the host
// (config/read + agents/list WITHOUT sessionId — _omits_session_id routing,
// cf. docs/app-server-protocol.md §6), catalog → Paseo provider types
// mapping.
//
// Binary identification: user override (ProviderLaunch) first, otherwise
// "vibe-app-server" resolved via PATH augmented with ~/.local/bin (uv), cf.
// docs/phase0-install-report.md.

import { homedir } from "node:os";
import { join } from "node:path";
import { materializeEmbeddedAgentPlugin } from "./agent-plugin";
import type {
  ProviderCatalog,
  ProviderLaunch,
  ProviderModel,
  ProviderMode,
  ProviderSessionSummary,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { AppServerClient } from "./json-rpc";
import {
  AgentPluginWire,
  AgentsListResult,
  CallbackCallParams,
  ClientToolCallWire,
  ClientToolDefinitionWire,
  ClientToolResponseWire,
  ConfigReadResult,
  InitializeResult,
  ModelConfigView,
  PublicCallbackEntry,
  PublicSessionSummary,
  SessionListResult,
  VIBE_CLIENT_CAPABILITIES,
} from "./wire";

export const PLUGIN_VERSION = "0.1.0";

export interface VibeLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function vibeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const path = [join(homedir(), ".local/bin"), process.env.PATH].filter(Boolean).join(":");
  return { ...process.env, ...extra, PATH: path };
}

export function resolveVibeLaunch(launch?: ProviderLaunch): VibeLaunch {
  if (launch?.command) return { command: launch.command, args: launch.args ?? [], env: vibeEnv(launch.env) };
  return { command: "vibe-app-server", args: [], env: vibeEnv() };
}

/**
 * Root of the "paseo" built-in plugin embedded by the provider. Materialized
 * under ~/.paseo/runtime/... on first use (cf. server/agent-plugin.ts) because
 * the bundle evaluated by the daemon exposes no valid import.meta.url. Its
 * PARENT is passed to the launch `--additional-builtin-plugin-root` so the
 * plugin materializes in every session (required for client tool binding,
 * §2.3 erratum); the plugin's own folder is declared via
 * `agentPlugins:[{name,root}]`.
 */
export function embeddedAgentPluginRoot(): string {
  return materializeEmbeddedAgentPlugin();
}

export interface HandshakeOptions {
  /** Server→client callback handler. Default: ack + empty response (catalog/probe). */
  onCallback?: (
    callback: PublicCallbackEntry,
    ack: (callbackId: string) => void,
    respondError: (message: string) => void,
  ) => void;
  /**
   * Client tools (§2.3): declares `clientTools:["tools/call"]` +
   * `clientToolDefinitions` (via `agentPlugins`) at initialize and wires the
   * `tools/call` handler. Reserved for SESSION processes: the binding requires
   * a built-in plugin of the same namespace, materialized by the launch
   * `--additional-builtin-plugin-root` (cf. AgentSession.open).
   */
  clientTools?: {
    definitions: Array<Omit<ClientToolDefinitionWire, "outputSchema">>;
    plugins: AgentPluginWire[];
    onCall: (call: ClientToolCallWire) => ClientToolResponseWire;
  };
}

/** §2 handshake: initialize (minimal capabilities + approvals) → initialized. */
export async function handshake(client: AppServerClient, options: HandshakeOptions = {}): Promise<InitializeResult> {
  const capabilities: Record<string, unknown> = { ...VIBE_CLIENT_CAPABILITIES };
  if (options.clientTools) {
    capabilities.clientTools = ["tools/call"];
    capabilities.agentPlugins = options.clientTools.plugins;
    capabilities.clientToolDefinitions = options.clientTools.definitions.map((definition) => ({
      ...definition,
      outputSchema: null,
    }));
  }
  client.onServerRequest("callback/call", async (params, respond, respondError) => {
    const callback = (params as CallbackCallParams).callback;
    if (!callback?.callbackId) {
      respondError("callback payload missing callbackId");
      return;
    }
    if (options.onCallback) {
      options.onCallback(callback, (callbackId) => respond({ callbackId, accepted: true }), (message) => respondError(message));
      return;
    }
    // Default behavior (catalog/probe): immediate ack (§5.1) then a clean
    // close — no callback happens outside a turn.
    respond({ callbackId: callback.callbackId, accepted: true });
    if (callback.detail?.kind === "user_input" && callback.sessionId) {
      await client.request("callback/result", {
        sessionId: callback.sessionId,
        result: { callbackId: callback.callbackId, output: { type: "user_input", result: { answers: [], cancelled: true } } },
      }).catch(() => undefined);
    }
  });
  if (options.clientTools) {
    // tools/call (server→client, request with response): the response IS the
    // tool's result ({output, annotations} or {error} — a tool error read
    // by the model). tools/cancel is a notification without an id, routed
    // to the notification listeners (ignored, no handler required).
    client.onServerRequest("tools/call", (params, respond, respondError) => {
      let result: ClientToolResponseWire;
      try {
        result = options.clientTools!.onCall(params as ClientToolCallWire);
      } catch (error) {
        respondError(error instanceof Error ? error.message : String(error));
        return;
      }
      respond(result);
    });
  } else {
    client.onServerRequest("tools/call", (_params, _respond, respondError) => {
      respondError("-32601", "tools/call is not supported by the paseo vibe provider yet");
    });
  }
  for (const other of ["session/spawn", "platformCredentials/resolve"]) {
    client.onServerRequest(other, (_params, _respond, respondError) => {
      respondError("-32601", `${other} is not supported by the paseo vibe provider yet`);
    });
  }
  const result = await client.request<InitializeResult>("initialize", {
    clientInfo: { name: "paseo", version: PLUGIN_VERSION, entrypoint: "programmatic", terminalEmulator: "unknown" },
    capabilities,
  });
  client.notify("initialized", {});
  return result;
}

/** Availability probe (status): full handshake, then close. */
export async function probeServer(launch: VibeLaunch, timeoutMs = 15_000): Promise<InitializeResult> {
  const client = AppServerClient.spawn({ command: launch.command, args: launch.args, env: launch.env });
  try {
    return await handshakeLimited(client, timeoutMs);
  } finally {
    await client.close();
  }
}

/** Full provider catalog (Paseo picker), queried without a session:
 * config/read {cwd} + agents/list {} routed to the host. Zero LLM calls. */
export async function readCatalog(launch: VibeLaunch, cwd: string): Promise<ProviderCatalog> {
  const client = AppServerClient.spawn({ command: launch.command, args: launch.args, env: launch.env });
  try {
    await handshake(client);
    const [configRead, agentsResult] = await Promise.all([
      client.request<ConfigReadResult>("config/read", { cwd }),
      client.request<AgentsListResult>("agents/list", {}),
    ]);
    const view = configRead.config;
    const models = view.models.map((model) => toProviderModel(model, view.activeModel?.alias));
    const agents = agentsResult.agents.filter((agent) => agent.agentType === "agent");
    const levels = view.activeModel?.thinkingLevels ?? [];
    return {
      models,
      modes: agents.map((agent) => toProviderMode(agent.name, agent.displayName, agent.description)),
      thinkingOptions: levels.map((level) => ({ id: level, label: capitalize(level) })),
      defaultModel: view.defaultModelAlias ?? view.activeModel?.alias ?? models[0]?.id,
      defaultMode: view.defaultAgent ?? agentsResult.active?.name,
      defaultThinkingOption: view.activeModel?.thinking,
    };
  } finally {
    await client.close();
  }
}

export interface VibeSessionListOptions {
  /** Project filter (session/list {cwd}); absent = all sessions. */
  cwd?: string;
  /** Ceiling requested by the daemon (ProviderInput.sessions.limit). */
  limit?: number;
  /** Text filter (the daemon refilters too): title + preview, case-insensitive. */
  query?: string;
}

/**
 * §3.5 session/list — import of existing vibe sessions (provider cap
 * `session.list`). Routed to the Host (server.py `_dispatch_backend_host_read`)
 * so valid **without an attached session**: ephemeral spawn→handshake→
 * pages→close process (readCatalog pattern). Zero LLM calls.
 *
 * Only root sessions are offered (`parentSessionId`/`startedBySessionId`
 * null — not internal subagents), not archived, with a cwd (required by the
 * ProviderSessionSummary type and by the import). Subagent roots aside,
 * the response is sorted by descending activity.
 */
export async function listVibeSessions(launch: VibeLaunch, options: VibeSessionListOptions = {}): Promise<ProviderSessionSummary[]> {
  const wanted = typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : 50;
  const client = AppServerClient.spawn({ command: launch.command, args: launch.args, env: launch.env });
  const items: PublicSessionSummary[] = [];
  try {
    await handshake(client);
    let cursor: string | undefined;
    while (items.length < wanted) {
      const page = await client.request<SessionListResult>("session/list", {
        limit: Math.min(500, wanted - items.length),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(cursor ? { cursor } : {}),
      }, 60_000);
      items.push(...(page.items ?? []));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  } finally {
    await client.close();
  }
  const query = options.query?.trim().toLowerCase();
  const summaries = items
    .filter((session) => !session.parentSessionId && !session.startedBySessionId)
    .filter((session) => typeof session.cwd === "string" && session.cwd)
    .filter((session) => !query
      || `${session.title ?? ""}\n${session.preview ?? ""}`.toLowerCase().includes(query))
    .map((session) => ({
      persistence: { version: 1, data: { vibeSessionId: session.id } },
      cwd: session.cwd as string,
      ...(typeof session.title === "string" && session.title ? { title: session.title } : {}),
      ...(session.preview ? { description: session.preview } : {}),
      ...(typeof session.updatedAt === "number" ? { updatedAt: new Date(session.updatedAt).toISOString() } : {}),
    }));
  summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return summaries.slice(0, wanted);
}

/**
 * §3.4 session/archive {sessionId, archived} — cap `session.archive`.
 * Host operation (server.py `_dispatch_backend_host_metadata`): works
 * without an attached session, on the STORED session — ephemeral process.
 * The id is the vibe id from persistence (data.vibeSessionId).
 */
export async function archiveVibeSession(launch: VibeLaunch, vibeSessionId: string, archived: boolean): Promise<void> {
  const client = AppServerClient.spawn({ command: launch.command, args: launch.args, env: launch.env });
  try {
    await handshake(client);
    await client.request("session/archive", { sessionId: vibeSessionId, archived }, 60_000);
  } finally {
    await client.close();
  }
}

async function handshakeLimited(client: AppServerClient, timeoutMs: number): Promise<InitializeResult> {
  const onUnhandled = () => undefined;
  client.onServerRequest("callback/call", (params, respond) => {
    const callback = (params as { callback?: { callbackId?: string } }).callback;
    respond({ callbackId: callback?.callbackId ?? null, accepted: false });
    onUnhandled();
  });
  const result = await client.request<InitializeResult>("initialize", {
    clientInfo: { name: "paseo", version: PLUGIN_VERSION, entrypoint: "programmatic", terminalEmulator: "unknown" },
    capabilities: VIBE_CLIENT_CAPABILITIES,
  }, timeoutMs);
  client.notify("initialized", {});
  return result;
}

function capitalize(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function thinkingOptions(levels: readonly string[]): ProviderThinkingOption[] {
  return levels.map((level) => ({ id: level, label: capitalize(level) }));
}

export function toProviderModel(view: ModelConfigView, activeAlias?: string): ProviderModel {
  const options = thinkingOptions(view.thinkingLevels ?? []);
  const metadata: Record<string, NonNullable<unknown>> = {};
  if (view.supportsImages !== undefined) metadata.supportsImages = view.supportsImages;
  if (view.autoCompactThreshold !== undefined) metadata.autoCompactThreshold = view.autoCompactThreshold;
  if (view.imageDelivery !== undefined) metadata.imageDelivery = view.imageDelivery;
  if (view.source !== undefined) metadata.source = view.source;
  return {
    id: view.alias,
    label: view.displayName,
    description: view.name,
    // The daemon codec requires a number or the ABSENCE of the field: models
    // declared by the user without a known window carry null on the vibe side.
    ...(typeof view.maxContextLength === "number" ? { contextWindowMaxTokens: view.maxContextLength } : {}),
    isDefault: view.alias === activeAlias,
    thinkingOptions: options,
    ...(typeof view.thinking === "string" && view.thinking ? { defaultThinkingOptionId: view.thinking } : {}),
    metadata,
  };
}

export function toProviderMode(name: string, displayName: string, description?: string): ProviderMode {
  return { id: name, label: displayName, description };
}


