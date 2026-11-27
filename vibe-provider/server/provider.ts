// "vibe" ProviderRegistration — Paseo provider protocol v1.
// Phase 2: full sessions (open/prompt/interrupt/configure/close),
// permissions approvals wiring, usage, runtime config; steer/mcp/paseo
// in-session tools come later. We negotiate nothing we do not
// implement.

import { homedir } from "node:os";
import type {
  ProviderConnectRequest,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { negotiateProviderCapabilities } from "@getpaseo/plugin/server/provider";
import { createVibeInstallation } from "./installation";
import { archiveVibeSession, listVibeSessions, readCatalog, probeServer, resolveVibeLaunch } from "./connection";
import { AgentSession, SESSION_CAPABILITIES, readPersistedSessionId } from "./session";

function requestFailure(requestId: string, message: string, code?: string): ProviderEvent {
  return { type: "request.failed", requestId, error: { message, ...(code ? { code } : {}) } };
}

function inputRequestId(input: ProviderInput): string | undefined {
  return "requestId" in input ? (input.requestId as string) : undefined;
}

/** Finds the session handling this id: direct root, or parent root of a child. */
function resolveSession(sessions: Map<string, AgentSession>, sessionId: string): AgentSession | undefined {
  const direct = sessions.get(sessionId);
  if (direct) return direct;
  for (const session of sessions.values()) {
    if (session.hasChild(sessionId)) return session;
  }
  return undefined;
}

async function handleInput(
  launch: ReturnType<typeof resolveVibeLaunch>,
  sessions: Map<string, AgentSession>,
  capabilities: readonly string[],
  emit: (event: ProviderEvent) => void,
  input: ProviderInput,
): Promise<void> {
  switch (input.type) {
    case "catalog": {
      const requestId = input.requestId;
      const cwd = input.cwd;
      // Without a cwd (global scope), homedir = vibe user config, no project scan.
      const catalogCwd = cwd ?? homedir();
      console.log(`[vibe-provider] catalog cwd=${catalogCwd}`);
      try {
        const catalog = await readCatalog(launch, catalogCwd);
        emit({ type: "catalog", requestId, catalog });
        emit({ type: "request.completed", requestId });
      } catch (error) {
        emit(requestFailure(requestId, describeError(error), "catalog_failed"));
      }
      return;
    }
    case "session.open": {
      const requestId = input.requestId;
      console.log(`[vibe-provider] session.open id=${input.sessionId} cwd=${input.config.cwd} model=${JSON.stringify(input.config.model)} mode=${JSON.stringify(input.config.mode)} persist=${input.config.persist}`);
      try {
        const session = await AgentSession.open(
          {
            launch,
            config: { ...input.config, paseoSessionId: input.sessionId },
            requestId,
            cwd: input.config.cwd,
            history: input.history,
            persistence: input.persistence,
            capabilities,
          },
          emit,
        );
        sessions.set(input.sessionId, session);
        console.log(`[vibe-provider] session opened paseo=${session.sessionId} vibe=${session.vibeSessionId ?? "?"}`);
      } catch (error) {
        console.error(`[vibe-provider] session.open failed: ${describeError(error)}`);
        emit(requestFailure(requestId, describeError(error), "session_open_failed"));
      }
      return;
    }
    case "session.prompt": {
      const session = resolveSession(sessions, input.sessionId);
      if (!session) {
        console.warn(`[vibe-provider] prompt for unknown session ${input.sessionId}`);
        return;
      }
      // "steer" delivery accepted (prompt.steer negotiated): the session
      // routes to turn/steer or turn/start. Any other value → turn/start.
      await session.prompt(input.prompt);
      return;
    }
    case "session.interrupt": {
      const session = resolveSession(sessions, input.sessionId);
      if (!session) return void console.warn(`[vibe-provider] interrupt for unknown session ${input.sessionId}`);
      await session.interrupt(input.requestId);
      return;
    }
    case "session.permission": {
      const session = resolveSession(sessions, input.sessionId);
      if (!session) return void console.warn(`[vibe-provider] permission for unknown session ${input.sessionId}`);
      await session.respondToPermission(input.permissionId, input.response);
      return;
    }
    case "session.configure": {
      const session = resolveSession(sessions, input.sessionId);
      if (!session) return void console.warn(`[vibe-provider] configure for unknown session ${input.sessionId}`);
      await session.configure(input.changes, input.requestId);
      return;
    }
    case "session.close": {
      const session = resolveSession(sessions, input.sessionId);
      if (!session) return void console.warn(`[vibe-provider] close for unknown session ${input.sessionId}`);
      sessions.delete(input.sessionId);
      await session.close(input.requestId);
      return;
    }
    case "session.revert": {
      const requestId = input.requestId;
      console.log(`[vibe-provider] session.revert id=${input.sessionId} scope=${input.scope} token=${JSON.stringify(input.token)}`);
      const session = resolveSession(sessions, input.sessionId);
      if (!session) {
        emit(requestFailure(requestId, `revert: no open session ${input.sessionId}`, "unknown_session"));
        return;
      }
      try {
        await session.revert(input.token, input.scope, requestId);
      } catch (error) {
        emit(requestFailure(requestId, describeError(error), "revert_failed"));
      }
      return;
    }
    case "session.can_stop_runtime": {
      // Idle-cleanup veto (§ lifecycle): the daemon only asks once prompts
      // and turns are closed; we answer with the requested session id
      // (the daemon control matches the id on the response).
      const session = resolveSession(sessions, input.sessionId);
      const canStop = session ? session.canStop() : true;
      console.log(`[vibe-provider] session.can_stop_runtime id=${input.sessionId} canStop=${canStop}`);
      emit({ type: "session.can_stop_runtime", requestId: input.requestId, sessionId: input.sessionId, canStop });
      return;
    }
    case "session.archive":
    case "session.unarchive": {
      // Archives the state of a STORED vibe session (Paseo import) — Host
      // operation: ephemeral spawn→handshake→session/archive→close process,
      // never on a live session's process.
      const requestId = input.requestId;
      const vibeSessionId = readPersistedSessionId(input.persistence);
      const archived = input.type === "session.archive";
      console.log(`[vibe-provider] ${input.type} vibe=${vibeSessionId ?? "?"}`);
      if (!vibeSessionId) {
        emit(requestFailure(requestId, `persistence carries no vibeSessionId: ${JSON.stringify(input.persistence)}`, "invalid_persistence"));
        return;
      }
      try {
        await archiveVibeSession(launch, vibeSessionId, archived);
        emit({ type: "request.completed", requestId });
      } catch (error) {
        emit(requestFailure(requestId, describeError(error), `${input.type}_failed`));
      }
      return;
    }
    case "sessions": {
      // session.list cap — import of existing vibe sessions (§3.5).
      const requestId = input.requestId;
      console.log(`[vibe-provider] sessions list cwd=${input.cwd ?? "*"} query=${JSON.stringify(input.query ?? "")} limit=${input.limit ?? "-"}`);
      try {
        const summaries = await listVibeSessions(launch, { cwd: input.cwd, limit: input.limit, query: input.query });
        console.log(`[vibe-provider] sessions list -> ${summaries.length} sessions`);
        emit({ type: "sessions", requestId, sessions: summaries });
        emit({ type: "request.completed", requestId });
      } catch (error) {
        emit(requestFailure(requestId, describeError(error), "sessions_failed"));
      }
      return;
    }
    default: {
      // Driver-only debug hook (e2e tests): the daemon cannot produce
      // "session.debug" (strict ProviderInputSchema daemon-side) — simulates
      // an eventId gap + resync (B6). No effect beyond a session/read.
      const debug = input as unknown as { type?: string; sessionId?: string; op?: string; drop?: number };
      if (debug.type === "session.debug") {
        const session = resolveSession(sessions, String(debug.sessionId ?? ""));
        if (!session) {
          emit(requestFailure(inputRequestId(input) ?? "debug", `debug: no open session ${debug.sessionId}`, "unknown_session"));
          return;
        }
        if (debug.op === "simulate-gap") {
          session.debugSimulateGap(typeof debug.drop === "number" ? debug.drop : 3);
          emit({ type: "request.completed", requestId: inputRequestId(input) ?? "debug" });
          return;
        }
        emit(requestFailure(inputRequestId(input) ?? "debug", `debug: unknown op ${debug.op}`, "unknown_debug_op"));
        return;
      }
      const requestId = inputRequestId(input);
      if (requestId) {
        emit(requestFailure(requestId, `Mistral Vibe provider: unknown or unimplemented input type`, "not_implemented"));
      } else {
        console.warn(`[vibe-provider] dropped provider input ${(input as { type: string }).type}`);
      }
      return;
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const detail = "data" in error && error.data ? ` (${JSON.stringify(error.data).slice(0, 500)})` : "";
    return `${error.message}${detail}`;
  }
  return String(error);
}

export function createVibeProvider(): ProviderRegistration {
  return {
    id: "vibe",
    label: "Mistral Vibe",
    description: "The Mistral Vibe coding agent, driven natively through vibe-app-server (JSON-RPC over stdio).",
    // Path relative to the plugin folder (cf. goose-provider): the pixelated
    // "V" of the vibe logo (mistral-vibe README), monochrome via currentColor.
    icon: "icon.svg",
    docsUrl: "https://github.com/mistralai/mistral-vibe",
    command: ["vibe-app-server"],
    installation: createVibeInstallation(),
    status: async ({ launch }) => {
      try {
        const result = await probeServer(resolveVibeLaunch(launch));
        const keyMissing = !process.env.MISTRAL_API_KEY && !(launch?.env && "MISTRAL_API_KEY" in launch.env);
        return {
          available: true,
          ...(keyMissing
            ? {
                diagnostic: `app-server ${result.serverInfo.version} reachable, but MISTRAL_API_KEY is not set: sessions will fail to authenticate against the Mistral API.`,
              }
            : {}),
        };
      } catch (error) {
        return {
          available: false,
          diagnostic: `vibe-app-server is not reachable: ${describeError(error)}. Install with "uv tool install mistral-vibe" or set the provider command in Paseo settings.`,
        };
      }
    },
    connect: async (request: ProviderConnectRequest): Promise<ProviderConnection> => {
      const launch = resolveVibeLaunch(request.launch);
      const capabilities = negotiateProviderCapabilities(request.capabilities, SESSION_CAPABILITIES);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Map<string, AgentSession>();
      const emit = (event: ProviderEvent) => {
        for (const listener of listeners) listener(event);
      };
      return {
        version: 1,
        capabilities,
        send: (input) => handleInput(launch, sessions, capabilities, emit, input),
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: async () => {
          await Promise.allSettled([...sessions.values()].map((session) => session.close()));
          sessions.clear();
          listeners.clear();
        },
      };
    },
  };
}

