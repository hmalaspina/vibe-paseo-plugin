// Vibe agent session: one vibe-app-server process per Paseo session (§3:
// "one connection = one attached root session").
//
// Paseo provider protocol ⇄ vibe mapping:
//   session.open    → session/start (new) or session/resume (persistence)
//   session.prompt  → turn/start (+ prompt_result {type:"turn"})
//   session.interrupt → turn/interrupt
//   session.configure → config/model/write + session/agent/update
//   session.close   → session/stop
//   callbacks approval → session.permission / session.permission
// Notifications (§4) → timeline.item / session.turn / session.usage / session.config.
//
// Phase 2 limits: no steer (not negotiated), mcpServers ignored, resync
// via notice (full replay not implemented), sub-agents not tracked.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  ProviderCommand,
  ProviderConfigChanges,
  ProviderContent,
  ProviderEvent,
  ProviderMcpServerConfig,
  ProviderMetric,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderTimelineItem,
  ProviderToolCallDetail,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { AppServerClient } from "./json-rpc";
import {
  embeddedAgentPluginRoot,
  handshake,
  PLUGIN_VERSION,
  VibeLaunch,
  toProviderModel,
} from "./connection";
import {
  AgentsListResult,
  AgentStatsSnapshot,
  ApprovalCallbackDetail,
  CallbackApprovalOutput,
  CallbackHistoryEntry,
  CallbackUserInputOutput,
  CallbackCallParams,
  ConfigReadResult,
  ContentBlock,
  EventNotificationParams,
  HistoryEntry,
  MessageEntry,
  PatchOperation,
  PublicBackgroundProcess,
  PublicCallbackEntry,
  PublicChildSession,
  PublicSessionState,
  PublicTurn,
  SessionReadResult,
  EffectDetail,
  EffectEntry,
  EffectState,
  ReasoningEntry,
  RuntimeSnapshot,
  RuntimeReadResult,
  SessionMcpServer,
  SessionRewindResult,
  SessionStartResult,
  SkillSummary as SkillSummaryWire,
  TodoEffectInputWire,
  TodoItemWire,
  TokenUsage,
  TurnContentBlock,
  TurnInterruptResult,
  TurnStartResult,
  UserInputCallbackDetail,
  AgentPluginWire,
  ClientToolCallWire,
  ClientToolResponseWire,
  STRUCTURED_OUTPUT_DESCRIPTION,
  STRUCTURED_OUTPUT_INPUT_SCHEMA,
  STRUCTURED_OUTPUT_TOOL_NAME,
  STRUCTURED_OUTPUT_TOOL_QUALIFIED,
  CLIENT_TOOL_NAMESPACE,
} from "./wire";

export const SESSION_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  // B5: structured output — the turn requires a schema-validated submission
  // (paseo.paseo_structured_output client tool + ajv validation plugin-side).
  "prompt.output_schema",
  "session.metrics",
  "session.persistence",
  "session.configure",
  "session.subsession",
  // Lifecycle (batch 4): conversation ± files rewind (not files alone —
  // vibe cannot restore files without truncating the conversation),
  // archive/unarchive Host operations, session/list import, runtime stop veto.
  "session.revert.conversation",
  "session.revert.both",
  "session.archive",
  "session.unarchive",
  "session.list",
  "session.can_stop_runtime",
  "permission",
  // B8: MCP preapprovals (config.toolPolicy) — daemon-preapproved tools are
  // auto-approved provider-side, WITHOUT human permission.
  "permission.tool_policy",
] as const;

type Emit = (event: ProviderEvent) => void;

export interface SessionConfigWithId extends ProviderSessionConfig {
  /** Session id chosen by the daemon (Paseo-side event key). */
  paseoSessionId: string;
}

export interface OpenSessionOptions {
  launch: VibeLaunch;
  config: SessionConfigWithId;
  requestId: string;
  cwd: string;
  history: "replay" | "skip";
  persistence?: ProviderPersistence;
  /** Capabilities negotiated with this daemon (⊆ SESSION_CAPABILITIES). */
  capabilities: readonly string[];
}

interface TrackedTurn {
  clientMessageId?: string;
  /** Cumulative tokens + steps captured at turn start (for the deltas). */
  usageAtStart?: TokenUsage;
  stepsAtStart?: number;
  /** Set when the closed turn is flushed: resync does not re-close an already closed turn. */
  closed?: boolean;
}
function messageText(entry: MessageEntry): string {
  return (entry.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function effectOutputText(state: EffectState | undefined): string | undefined {
  if (!state) return undefined;
  if (typeof state.outputText === "string" && state.outputText) return state.outputText;
  if (typeof state.output === "string") return state.output;
  if (state.output && typeof state.output === "object") {
    const record = state.output as { stdout?: unknown; stderr?: unknown };
    if (typeof record.stdout === "string") {
      return record.stderr && typeof record.stderr === "string" && record.stderr
        ? `${record.stdout}${record.stdout.endsWith("\n") ? "" : "\n"}${record.stderr}`
        : record.stdout;
    }
  }
  return undefined;
}

function baseTimestamp(entry: { createdAt?: number; updatedAt?: number }, params?: { emittedAt?: number }): string | undefined {
  const ms = entry.updatedAt ?? entry.createdAt ?? params?.emittedAt;
  return typeof ms === "number" ? new Date(ms).toISOString() : undefined;
}

/** Normalizes a wire list of TodoEffectItem (camelCase, extra=forbid). */
function todoItemsOf(value: unknown): TodoItemWire[] {
  return Array.isArray(value) ? (value as TodoItemWire[]) : [];
}

/** Canonical JSON (sorted keys) — stable entry comparison for resync,
 * independent of key insertion order (patch vs server snapshot). */
function stableStringify(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sort(record[key])]));
    }
    return input;
  };
  return JSON.stringify(sort(value)) ?? "null";
}

/** Readable compact JSON for unmapped details (string: as-is). */
function compactJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value) ?? "{}";
}

/** §5 UserQuestionRequest wire camelCase → readable text (questions+options).
 * Reused for process/scratchpad (input record: returns ""). */
function questionsText(input: unknown): string {
  const request = input as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label?: string; description?: string }>; multiSelect?: boolean }>; footerNote?: string | null } | undefined;
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  if (questions.length === 0) return "";
  const lines: string[] = [];
  for (const question of questions) {
    const header = typeof question?.header === "string" && question.header ? `[${question.header}] ` : "";
    lines.push(`${header}${question.question ?? ""}${question.multiSelect ? " (multiple choice)" : ""}`);
    for (const option of question.options ?? []) {
      lines.push(`  • ${option?.label ?? ""}${option?.description ? ` — ${option.description}` : ""}`);
    }
  }
  if (typeof request?.footerNote === "string" && request.footerNote) lines.push(request.footerNote);
  return lines.join("\n");
}

/** Typed Paseo detail of a vibe effect (§4.2 → ProviderToolCallDetail). */
function toolCallDetail(detail: EffectDetail | undefined, state: EffectState | undefined): ProviderToolCallDetail {
  if (!detail) return { type: "unknown", input: {}, output: {} };
  const input = (detail.input ?? {}) as Record<string, never>;
  const output = effectOutputText(state);
  switch (detail.kind) {
    case "shell":
      return { type: "shell", command: String(input.command ?? ""), cwd: input.cwd as string | undefined, output };
    case "file_read":
      return { type: "read", filePath: String(input.filePath ?? input.path ?? input.file_path ?? ""), content: output };
    case "file_edit":
      return {
        type: "edit",
        filePath: String(input.filePath ?? input.path ?? input.file_path ?? ""),
        oldString: (input.old_string as string) ?? (input.old as string),
        newString: (input.new_string as string) ?? (input.new as string),
        unifiedDiff: (input.diff ?? input.unified_diff) as string | undefined,
      };
    case "file_write":
      return { type: "write", filePath: String(input.filePath ?? input.path ?? input.file_path ?? ""), content: (input.content as string) ?? output };
    case "file_search":
      return {
        type: "search",
        query: String(input.query ?? input.pattern ?? ""),
        content: output,
        filePaths: Array.isArray(input.files) ? (input.files as string[]) : undefined,
        mode: "content",
      };
    case "web_search":
      return { type: "search", toolName: "web_search", query: String(input.query ?? ""), content: output };
    case "web_fetch":
      return { type: "fetch", url: String(input.url ?? ""), result: output };
    case "sub_agent":
      return {
        type: "sub_agent",
        subAgentType: (input.agent as string) ?? undefined,
        description: (input.task as string) ?? detail.display?.summary,
        log: output ?? detail.display?.summary ?? "",
        childSessionId: typeof detail.childSessionId === "string" && detail.childSessionId ? detail.childSessionId : undefined,
      };
    // B6: worktree → worktree_setup (WorktreeEffectInput {name, branch, path}
    // + progress patched in flight; output stays empty by design — the runner
    // renders raw JSON, the useful state lives in detail.input, _worktree_effects).
    case "worktree": {
      const progress = detail.progress;
      const lines: string[] = [detail.display?.summary ?? "worktree"];
      if (progress && typeof progress.phase === "string") {
        const counts = typeof progress.completedFiles === "number" && typeof progress.totalFiles === "number"
          ? ` (${progress.completedFiles}/${progress.totalFiles} files)`
          : "";
        lines.push(`phase: ${progress.phase}${counts}`);
      } else if (detail.display?.statusText) {
        lines.push(detail.display.statusText);
      }
      return {
        type: "worktree_setup",
        worktreePath: String(input.path ?? ""),
        branchName: String(input.branch ?? ""),
        log: lines.join("\n"),
        // vibe does not expose the checkout's git commands: empty list (field
        // required by the provider schema), progress lives in the log.
        commands: [],
      };
    }
    // B6: question asked by the agent → plain_text (the matching user_input
    // callback goes out separately as session.permission).
    case "user_question":
      return {
        type: "plain_text",
        label: detail.display?.summary ?? "Question",
        text: questionsText(detail.input) || detail.display?.summary || "",
      };
    // B6: process.* (start/stop/output) → plain_text terminal.
    case "process":
      return {
        type: "plain_text",
        label: detail.display?.summary ?? detail.toolName ?? "process",
        text: output ?? (questionsText(detail.input) || compactJson(state?.output)),
        icon: "square_terminal",
      };
    // B6: scratchpad (list/read/write) → plain_text pencil.
    case "scratchpad": {
      // ScratchpadEffectOutput {path, content, files} (wire camelCase): the
      // readable text is a read/write; a list renders the file names.
      const out = (state?.output ?? {}) as { content?: unknown; files?: unknown };
      const text = typeof out.content === "string" && out.content
        ? out.content
        : Array.isArray(out.files) && out.files.length > 0
          ? (out.files as string[]).map((file) => `• ${String(file)}`).join("\n")
          : output ?? compactJson(detail.input);
      return {
        type: "plain_text",
        label: detail.display?.summary ?? detail.toolName ?? "scratchpad",
        text,
        icon: "pencil",
      };
    }
    default:
      // kind "tool" (catch-all MCP), "skill", etc.: readable unknown —
      // input/output as COMPACT JSON when not a string (Paseo readability).
      return { type: "unknown", input: compactJson(detail.input), output: compactJson(state?.output) };
  }
}

function toolCallStatus(state: EffectState | undefined): { status: "running" | "completed" | "canceled" | "failed"; error: unknown } {
  switch (state?.status) {
    case "completed":
      return { status: "completed", error: null };
    case "failed":
      return { status: "failed", error: { message: state.error?.message ?? "tool call failed", code: state.error?.code } };
    case "cancelled":
    case "skipped":
      return { status: "canceled", error: null };
    default:
      return { status: "running", error: null };
  }
}

// ─── B8: permission.tool_policy (MCP preapprovals) ─────────────────────────

/** Vibe normalization of a name segment (harness _mcp_naming.py:
 * `_normalize_segment` — non-identifier characters to `_`, never empty). */
function normalizeSegment(value: string): string {
  const normalized = [...value].map((char) => (/[A-Za-z0-9_$]/.test(char) ? char : "_")).join("");
  return normalized || "_";
}

/** Vibe normalization of a tool identifier (`_normalize_identifier`:
 * segment + `_` prefix if the first character is a digit). */
function normalizeIdentifier(value: string): string {
  const segment = normalizeSegment(value);
  return /^[0-9]/.test(segment) ? `_${segment}` : segment;
}

/**
 * Auto-approval keys of a {server,tool} grant: the EXACT toolName vibe puts
 * in approval callbacks is `{group}.{tool}` (§5.2 — verified in
 * _session.py/_projection.py), group = `mcp_{segment(server)}`,
 * tool = normalized identifier — e.g. server "paseo" + "list_providers" →
 * `mcp_paseo.list_providers`. We also cover the raw spelling
 * `mcp_{server}.{tool}`: daemon names are already clean identifiers (same
 * convention), normalization only diverges on exotic characters — and a
 * match failure falls back to human approval (never the opposite). Only the
 * collision cases digested from vibe (two homonymous servers after
 * normalization) stay without auto-approval: an acceptable conservative
 * fallback.
 */
function preapprovedToolKeys(server: string, tool: string): Set<string> {
  const keys = new Set<string>();
  keys.add(`mcp_${normalizeSegment(server)}.${normalizeIdentifier(tool)}`);
  keys.add(`mcp_${server}.${tool}`);
  return keys;
}

export class AgentSession {
  private client: AppServerClient | null = null;
  private entries = new Map<string, HistoryEntry>();
  private turns = new Map<string, TrackedTurn>();
  private openCallbacks = new Map<string, { detailKind: string; pathScopeChoices: string[]; vibeSessionId: string; permissionSessionId: string }>();
  private unsubs: Array<() => void> = [];
  private closeEmitted = false;
  private closing = false;
  private tokenUsage: TokenUsage | null = null;
  /** Last AgentStatsSnapshot seen (statsUpdated > runtime/read seed). */
  private stats: AgentStatsSnapshot | null = null;
  /** Active model window (maxContextLength), otherwise compaction threshold. */
  private modelWindowTokens: number | undefined;
  private compactionThresholdTokens: number | undefined;
  /** Deferred session.turn completed: lets the statsUpdated that follows (same
   * server batch) close the counters before the turn footer. */
  private pendingTurn: { turn: PublicTurn; state: "completed" | "failed" | "canceled" } | null = null;
  private pendingTurnTimer: ReturnType<typeof setTimeout> | null = null;
  /** Signature of the last session.metrics emitted (anti-spam). */
  private metricsSignature = "";
  /** Signature of the last session.usage emitted (anti-spam). */
  private usageSignature = "";

  /** Paseo identifier (chosen by the daemon, present in every event). */
  readonly sessionId: string;
  /** Vibe session identifier (wire params, resume key). */
  vibeSessionId = "";
  /** Capabilities negotiated at connect (gates session.metrics). */
  private readonly negotiated: ReadonlySet<string>;
  private lastEventId = 0;
  private activeTurnId: string | null = null;
  /** Child sessions (vibe subagents), by vibe id — phase 4. */
  private readonly children = new Map<string, { entries: Map<string, HistoryEntry>; turns: Map<string, TrackedTurn>; lastEventId: number; todo: { signature: string | null } }>();
  /** Last emitted "todo" item signature (root) — dedup of consecutive
   * identical writes, daemon omp emitTodoItem pattern: the Paseo UI has
   * NO identity merge on todo items (timelineItemIdentity only covers
   * tool_call/plugin), each emission = a new card. */
  private readonly todoState = { signature: null as string | null };
  /** Resync §4.4 in flight (anti-reentrancy guard: only one session/read at a
   * time; notifications keep being processed live). */
  private resyncInFlight = false;
  /** B6: structured values accepted per turn (turnId → {value, callId}) —
   * the memory of paseo_structured_output tool_calls, absent from the vibe
   * history: replayed at open with history:"replay" (daemon reload) and
   * pushed into persistence to survive the process. Capped at the last 16 turns. */
  private readonly structuredOutputs = new Map<string, { value: JsonValue; callId: string }>();
  /** Turns already replayed by structuredOutputs (anti double emission). */
  private readonly replayedStructuredTurns = new Set<string>();
  /** Background processes of the session (§ 4 / models.py PublicBackgroundProcess),
   * kept up to date by root session/snapshot — empty in practice except for a
   * detached shell; serves the can-stop-runtime question. */
  private backgroundProcesses: PublicBackgroundProcess[] = [];
  /** Current approval policy (shadow, to avoid redundant updates). */
  private approvalPolicy: string | undefined;
  /** Signature of the last session.commands emitted (dedup of runtime snapshots). */
  private commandsSignature = "";
  /** B8: MCP tools preapproved by the daemon (config.toolPolicy), keys =
   * exact toolNames of approval callbacks (`mcp_<server>.<tool>`). CHILD
   * sessions inherit: their callbacks go through this same handler. */
  private readonly preapprovedTools: ReadonlySet<string> = new Set();

  /**
   * Structured output of the active turn (B5, capability prompt.output_schema):
   * set by the prompt carrying outputSchema, lives as long as the turn lives,
   * replaced by the next prompt (cleared when outputSchema is absent). ajv
   * validation plugin-side (opencode structured-output-plugin pattern): an
   * invalid tools/call answers a TOOL ERROR the model reads and fixes; no
   * valid submission by the end of the turn → turn marked failed (daemon
   * opencode v2 assert).
   */
  private structured: {
    turnId: string | null;
    schema: JsonValue;
    validator: ValidateFunction;
    accepted: boolean;
    /** First validated value — the value published to the daemon. */
    value: JsonValue | undefined;
    /** Wire callId of the accepted submission (id of the emitted timeline items). */
    callId: string | undefined;
    calls: number;
    rejections: number;
  } | null = null;
  /** Session ajv compiler (strict:false, allErrors — cf. daemon
   * structured-output.js / agent-response-loop.js, same options). */
  private readonly ajv = new Ajv({ strict: false, allErrors: true });

  private constructor(
    private readonly launch: VibeLaunch,
    private readonly config: SessionConfigWithId,
    private readonly emit: Emit,
    negotiated: readonly string[],
  ) {
    this.sessionId = config.paseoSessionId;
    this.negotiated = new Set(negotiated);
    // B8: toolPolicy materialization (daemon plugin-provider mapSessionConfig
    // convention — {preapproved:[{kind:"mcp",server,tool}]}): {server,tool}
    // pairs → full vibe keys, silent auto-approval.
    const grants = config.toolPolicy?.preapproved ?? [];
    const keys = new Set<string>();
    for (const grant of grants) {
      if (typeof grant?.server === "string" && typeof grant?.tool === "string") {
        for (const key of preapprovedToolKeys(grant.server, grant.tool)) keys.add(key);
      }
    }
    this.preapprovedTools = keys;
  }

  static async open(options: OpenSessionOptions, emit: Emit): Promise<AgentSession> {
    const session = new AgentSession(options.launch, options.config, emit, options.capabilities);
    const agentPluginRoot = embeddedAgentPluginRoot();
    session.client = AppServerClient.spawn({
      command: options.launch.command,
      // --additional-builtin-plugin-root: materializes the "paseo" built-in
      // plugin in every session, otherwise the server (client_tool_groups_for,
      // _runtime.py) drops the client tool group declared at initialize
      // (§2.3 erratum) and no tools/call ever arrives.
      args: [...options.launch.args, "--additional-builtin-plugin-root", join(agentPluginRoot, "..")],
      env: { ...options.launch.env, ...options.config.env },
    });
    const client = session.client;
    session.unsubs.push(
      client.onClose(() => session.handleUnexpectedClose()),
    );
    await handshake(client, {
      onCallback: (callback, ack, respondError) => session.handleCallback(callback, ack, respondError),
      clientTools: {
        definitions: [
          {
            namespace: CLIENT_TOOL_NAMESPACE,
            name: STRUCTURED_OUTPUT_TOOL_NAME,
            description: STRUCTURED_OUTPUT_DESCRIPTION,
            inputSchema: STRUCTURED_OUTPUT_INPUT_SCHEMA as unknown as Record<string, unknown>,
          },
        ],
        plugins: [{ name: CLIENT_TOOL_NAMESPACE, root: agentPluginRoot } satisfies AgentPluginWire],
        onCall: (call) => session.handleClientToolCall(call),
      },
    });
    session.unsubs.push(
      client.onNotification((method, params) => session.handleNotification(method, params)),
    );

    const persistedId = readPersistedSessionId(options.persistence);
    const agentConfig: Record<string, unknown> = {
      cwd: options.cwd,
      trustWorkspace: true,
    };
    if (options.config.mode) agentConfig.agent = options.config.mode;
    if (typeof options.config.providerOptions?.approvalPolicy === "string") {
      agentConfig.approvalPolicy = options.config.providerOptions.approvalPolicy;
    }
    if (options.config.systemPrompt) agentConfig.instructions = options.config.systemPrompt;
    // MCP (phase 4): injection of the servers configured by the daemon.
    const mcpServers = mapMcpServers(options.config.mcpServers);
    if (mcpServers.length > 0) agentConfig.mcpServers = mcpServers;
    // B8: trace of the preapprovals in force (permission.tool_policy).
    if (session.preapprovedTools.size > 0) {
      console.log(`[vibe-provider] toolPolicy: ${session.preapprovedTools.size} preapproved key(s) (${[...session.preapprovedTools].join(", ")})`);
    }
    // Budgets (phase 4): from providerOptions or the legacy settings.
    const optionsRecord = {
      ...(options.config.settings ?? {}),
      ...(options.config.providerOptions ?? undefined),
    } as Record<string, unknown>;
    const budget = (key: string): number | undefined => {
      const value = optionsRecord[key];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const maxTurns = budget("maxTurns");
    if (maxTurns !== undefined) agentConfig.maxTurns = Math.floor(maxTurns);
    const maxSessionTokens = budget("maxSessionTokens");
    if (maxSessionTokens !== undefined) agentConfig.maxSessionTokens = Math.floor(maxSessionTokens);
    const maxPrice = budget("maxPrice");
    if (maxPrice !== undefined) agentConfig.maxPrice = maxPrice;

    const common = {
      agentConfig,
      historyLimit: 500,
    };
    const result = persistedId
      ? await client.request<SessionStartResult>("session/resume", {
          ...common,
          sessionId: persistedId,
          interruptLeftTurn: false,
        }, 60_000)
      : await client.request<SessionStartResult>("session/start", {
          ...common,
          kind: "normal",
          ...(options.config.title ? { title: options.config.title } : {}),
          ...(options.config.model ? { model: options.config.model } : {}),
          ...(options.config.thinkingOption ? { reasoningEffort: options.config.thinkingOption } : {}),
        }, 60_000);

    session.vibeSessionId = result.state.session.id;
    session.lastEventId = result.lastEventId;
    // Cumulative counters (resume: TrueCumulative includes earlier spend).
    const initialUsage = (result.state.session as { tokenUsage?: TokenUsage }).tokenUsage;
    if (initialUsage && typeof initialUsage === "object") session.tokenUsage = initialUsage;
    // B6: the entries map starts from the re-read state (replay OR skip) —
    // without this, a first eventId gap would re-emit the WHOLE history as
    // "added" after resync (duplicates in the daemon's append-only timeline).
    for (const entry of result.state.history ?? []) session.entries.set(entry.id, entry as HistoryEntry);
    // B6: structured-output memory persisted (turnId → {value, callId}) —
    // client tool_calls leave NO entry in the vibe history.
    session.loadStructuredMemory(options.persistence);

    emit({
      type: "session.opened",
      requestId: options.requestId,
      sessionId: session.sessionId,
      capabilities: SESSION_CAPABILITIES,
      restoration: "core",
      cwd: options.cwd,
      ...(options.config.title ? { title: options.config.title } : {}),
    });
    if (options.config.persist) {
      session.emitPersistence();
    }
    // Composer slash menu: a NEW session never receives an initial
    // runtime/updated (only resume/continue emit one, cf. server.py
    // _dispatch_backend_lifecycle); we seed via runtime/read, as the in-tree
    // Rust client does. Resumes will duplicate with their runtime/updated →
    // the signature cache dedupes.
    await session.readRuntime();
    emit({ type: "session.ready", requestId: options.requestId, sessionId: session.sessionId });
    if (options.requestId) emit({ type: "request.completed", requestId: options.requestId });

    if (options.history === "replay") {
      for (const entry of result.state.history ?? []) {
        const item = session.timelineItemFor(entry as HistoryEntry, undefined);
        if (item) emit({ type: "timeline.item", sessionId: session.sessionId, item, timestamp: baseTimestamp(entry as HistoryEntry) });
      }
      // B6: structured-output turns replay their daemon publication
      // (tool_call metadata.paseoStructuredOutput + assistant_message JSON) —
      // the vibe history does not contain these client tool calls.
      session.replayStructuredOutputs(result.state);
    }
    return session;
  }

  private emitPersistence(): void {
    this.emit({
      type: "session.persistence",
      sessionId: this.sessionId,
      // B6: data.structuredOutputs (turnId → {value, callId}) — the
      // structured-output memory, to replay the items on daemon reload.
      persistence: {
        version: 1,
        data: {
          vibeSessionId: this.vibeSessionId,
          ...(this.structuredOutputs.size > 0
            ? { structuredOutputs: Object.fromEntries(this.structuredOutputs) }
            : {}),
        },
      },
    });
  }

  async prompt(prompt: ProviderPrompt, requestId?: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("session is closed");
    const inputType = prompt.input.type;
    if (inputType !== "message" && inputType !== "command") {
      if (requestId) this.emit({ type: "request.failed", requestId, error: { message: `vibe provider only supports message and command prompts, got ${inputType}`, code: "unsupported_prompt" } });
      return;
    }
    // prompt.command (capability "prompt.command"): vibe commands/skills are
    // invoked through the wire slash convention — a turn whose text mentions
    // `/name args` at the front (vibe/app_server/_skill_invocation.py:
    // leading_skill_name + mentions outside code; the adapter appends the
    // skill body to the message and resolves user_invocable).
    const message = prompt.input.type === "command"
      ? [{ type: "text", text: `/${prompt.input.name}${prompt.input.arguments ? ` ${prompt.input.arguments}` : ""}` } satisfies TurnContentBlock]
      : translatePromptContent(prompt.input.content);
    if (message.length === 0) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: { message: "prompt content is empty after translation (no text/image blocks)" } },
      });
      return;
    }
    // prompt.output_schema (B5): the schema lives as long as the turn lives; a
    // prompt without outputSchema clears a previous request. We announce it to
    // the model through a dedicated text block (the system is not rewritable
    // per turn, and the client tool's inputSchema is generic — validation is
    // ours).
    if (this.negotiated.has("prompt.output_schema")) {
      if (prompt.outputSchema === undefined) {
        this.structured = null;
      } else {
        const schema = prompt.outputSchema as JsonValue;
        try {
          this.structured = {
            turnId: this.activeTurnId,
            schema,
            validator: this.ajv.compile(schema as unknown as Record<string, unknown>),
            accepted: false,
            value: undefined,
            callId: undefined,
            calls: 0,
            rejections: 0,
          };
        } catch (error) {
          this.structured = null;
          this.emit({
            type: "session.prompt_result",
            sessionId: this.sessionId,
            clientMessageId: prompt.clientMessageId,
            result: { type: "failed", error: { message: `invalid outputSchema: ${describe(error)}`, code: "invalid_output_schema" } },
          });
          return;
        }
        message.push({ type: "text", text: structuredGuidanceBlock(schema) } satisfies TurnContentBlock);
      }
    } else if (prompt.outputSchema !== undefined) {
      // Daemon without prompt.output_schema negotiated: the provider contract
      // requires the capability, which we claim at connect — a clean refusal
      // rather than a turn whose structured output would be silently ignored.
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: { message: "prompt.output_schema was not negotiated with this daemon", code: "unsupported_output_schema" } },
      });
      return;
    }
    // §3.3 turn/steer: injection into the active turn. Falls back to turn/start
    // if the turn just ended (not_steerable / stale_turn / no active turn).
    if (prompt.delivery === "steer" && this.activeTurnId) {
      const steered = await this.trySteer(client, this.activeTurnId, message, prompt.clientMessageId);
      if (steered !== "fallback") return;
    }    try {
      const result = await client.request<TurnStartResult>("turn/start", {
        sessionId: this.vibeSessionId,
        message,
        idempotencyKey: randomUUID(),
        clientUserMessageId: prompt.clientMessageId ?? randomUUID(),
      }, 120_000);
      const existing = this.turns.get(result.turn.id) ?? {};
      this.turns.set(result.turn.id, {
        ...existing,
        clientMessageId: prompt.clientMessageId,
        ...(existing.usageAtStart ? {} : { usageAtStart: this.cumulativeUsage(), stepsAtStart: this.stats?.steps ?? 0 }),
      });
      this.activeTurnId = result.turn.id;
      // The prompt's structured request attaches to the turn that carries it.
      if (this.structured) this.structured.turnId = result.turn.id;
      this.emitSyntheticUserItem(prompt, result.turn.id, message);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "turn", turnId: result.turn.id },
      });
    } catch (error) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: { message: describe(error) } },
      });
    }
  }

  /**
   * The turn's user message does not always arrive over the wire: the server
   * emits history/entryAdded before the turn/start response for the FIRST
   * turn (verified), but the next turn's batch may omit it (observed on turn 2
   * in e2e — no notification although the entry is persisted). The daemon
   * (revertTokens, timeline) AND the user need the item: we synthesize it from
   * the prompt, idempotently — the wire entry (id = clientUserMessageId,
   * verified in the store) sets/overwrites the real entry; any double emission
   * is deduped by the daemon (same user text → item dropped) and by the
   * resume (state.history replayed once).
   */
  private emitSyntheticUserItem(prompt: ProviderPrompt, turnId: string, message: TurnContentBlock[]): void {
    const entryId = this.syntheticEntryId(prompt) ?? "";
    if (!entryId || this.entries.has(entryId)) return;
    // Minimal synthetic entry: correct rewind anchor resolution (the turn's
    // user message), overwritten by the wire entry if it eventually arrives.
    const synthetic: MessageEntry = {
      id: entryId,
      type: "message",
      role: "user",
      turnId,
      content: message.map((block) => (block.type === "text" ? { type: "text", text: block.text } : this.unknownBlock(block))),
    };
    this.entries.set(entryId, synthetic);
    const text = messageText(synthetic);
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: { type: "user_message", id: entryId, text, ...(prompt.clientMessageId ? { clientMessageId: prompt.clientMessageId } : {}), revertToken: { entryId } },
      timestamp: new Date().toISOString(),
    });
  }

  /** The client id — the one vibe promotes to the user entry's id. */
  private syntheticEntryId(prompt: ProviderPrompt): string | undefined {
    return prompt.clientMessageId ?? undefined;
  }

  /** Image (or other) block of a prompt: readable text in the synthetic entry. */
  private unknownBlock(block: TurnContentBlock): ContentBlock {
    return block.type === "image" ? { type: "text", text: "[attached image]" } : { type: "text", text: block.type };
  }

  /** Returns "steered"|"failed"|"fallback" (fallback → turn/start). */
  private async trySteer(
    client: AppServerClient,
    expectedTurnId: string,
    message: TurnContentBlock[],
    clientMessageId: string,
  ): Promise<"steered" | "failed" | "fallback"> {
    try {
      await client.request("turn/steer", {
        sessionId: this.vibeSessionId,
        expectedTurnId,
        message,
        clientUserMessageId: clientMessageId ?? randomUUID(),
      }, 60_000);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId,
        result: { type: "steer", turnId: expectedTurnId },
      });
      return "steered";
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "not_steerable" || code === "stale_turn" || code === "conflict") {
        console.warn(`[vibe-provider] steer rejected (${code}); falling back to a new turn`);
        return "fallback";
      }
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId,
        result: { type: "failed", error: { message: describe(error) } },
      });
      return "failed";
    }
  }

  async interrupt(requestId?: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.request<TurnInterruptResult>("turn/interrupt", {
        sessionId: this.vibeSessionId,
        expectedTurnId: this.activeTurnId,
      }, 30_000);
      if (requestId) this.emit({ type: "request.completed", requestId });
    } catch (error) {
      // §3.3: tolerate stale_turn / conflict without an active turn.
      const code = (error as { code?: string }).code;
      if (requestId) {
        if (code === "stale_turn" || code === "conflict") {
          this.emit({ type: "request.completed", requestId });
          return;
        }
        this.emit({ type: "request.failed", requestId, error: { message: describe(error) } });
      }
    }
  }

  /**
   * § Lifecycle — answers the daemon cleaning up an idle runtime (idle-runtime-
   * cleanup: canStop is a VETO; false keeps the process alive). The daemon
   * only asks once prompts/turns are closed locally; here we only refuse if
   * vibe work remains: an active turn, or a `running` background process
   * (session/snapshot) whose death would lose state.
   */
  canStop(): boolean {
    if (this.activeTurnId) return false;
    return !this.backgroundProcesses.some((process) => process.status === "running");
  }

  /**
   * §3.5 session.revert (caps session.revert.conversation/both) — rewind
   * anchored on `entryId` over a user message: everything after it is
   * truncated. Mapping:
   *   conversation → session/rewind {restoreFiles:false}
   *   both         → session/rewind {restoreFiles:true} (+ file snapshots)
   *   files        → never requested (cap not negotiated: vibe cannot
   *                  restore files without truncating the conversation).
   * vibe requires a "settled" session (_require_rewindable): we interrupt an
   * active turn (previous opencode revertBoth), then retry as long as the
   * backend reaps the turn's lingering task. `inplace:true` keeps the vibe id
   * — persistence does not change; the daemon closes then reopens the session
   * with history:"replay" right after (plugin-provider replayBinding).
   */
  async revert(token: unknown, scope: "conversation" | "files" | "both", requestId: string): Promise<void> {
    const client = this.client;
    if (!client || !this.vibeSessionId) {
      this.emit({ type: "request.failed", requestId, error: { message: "session is closed", code: "session_closed" } });
      return;
    }
    const entryId = (token as { entryId?: unknown } | null | undefined)?.entryId;
    if (typeof entryId !== "string" || !entryId) {
      this.emit({ type: "request.failed", requestId, error: { message: `revert token ${JSON.stringify(token)} carries no vibe entryId`, code: "invalid_revert_token" } });
      return;
    }
    const anchor = this.resolveRewindAnchor(entryId);
    if (this.activeTurnId) {
      await client.request("turn/interrupt", { sessionId: this.vibeSessionId, expectedTurnId: this.activeTurnId }, 30_000).catch(() => undefined);
    }
    const restoreFiles = scope !== "conversation";
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      let result: SessionRewindResult;
      try {
        result = await client.request<SessionRewindResult>("session/rewind", {
          sessionId: this.vibeSessionId,
          entryId: anchor,
          restoreFiles,
          inplace: true,
        }, 60_000);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "conflict" && attempt < 11) {
          // The interrupt settles asynchronously: the backend only reaps the
          // turn's lingering task (cf. _require_settled) after the
          // turn/completed — we let the conflict settle before retrying.
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        lastError = error;
        break;
      }
      console.log(`[vibe-provider] rewind anchor=${anchor} restoreFiles=${restoreFiles} -> session=${result.state?.session?.id ?? "?"} restoreErrors=${result.restoreErrors?.length ?? 0}`);
      this.applyRewindState(result);
      this.emit({ type: "request.completed", requestId });
      return;
    }
    const code = (lastError as { code?: string } | null)?.code;
    this.emit({
      type: "request.failed",
      requestId,
      error: { message: `session/rewind ${anchor} failed: ${describe(lastError)}`, ...(code ? { code } : {}) },
    });
  }

  /**
   * A rewind anchor must be a user message (vibe _rewound_entry, NOT_FOUND
   * otherwise). revertTokens are set on every timeline.item; for an
   * assistant/reasoning/effect entry we walk up to the user message of the
   * same turn. Unknown entry (sessions resumed without replay): the id stays
   * a valid vibe id to pass as-is — the server decides.
   */
  private resolveRewindAnchor(entryId: string): string {
    const entry = this.entries.get(entryId);
    if (!entry) return entryId;
    if (entry.type === "message" && (entry as MessageEntry).role === "user") return entryId;
    const turnId = entry.turnId;
    if (turnId) {
      let anchor: HistoryEntry | undefined;
      for (const candidate of this.entries.values()) {
        if (candidate.type !== "message" || (candidate as MessageEntry).role !== "user" || candidate.turnId !== turnId) continue;
        if (!anchor || (candidate.createdAt ?? 0) < (anchor.createdAt ?? 0)) anchor = candidate;
      }
      if (anchor) return anchor.id;
    }
    return entryId;
  }

  /** Post-rewind state: we re-sync the internal maps; the daemon closes then
   * reopens the session (persistence + history:"replay") right after. */
  private applyRewindState(result: SessionRewindResult): void {
    const state = result.state as PublicSessionState | undefined;
    if (!state) return;
    if (typeof state.session?.id === "string" && state.session.id && state.session.id !== this.vibeSessionId) {
      // inplace keeps the id; a derived id (server handoff) follows persistence.
      this.vibeSessionId = state.session.id;
      this.emitPersistence();
    }
    if (Array.isArray(state.history)) {
      this.entries.clear();
      for (const entry of state.history) this.entries.set(entry.id, entry);
    }
    if (typeof state.eventId === "number") this.lastEventId = Math.max(this.lastEventId, state.eventId);
    if (Array.isArray(state.backgroundProcesses)) this.backgroundProcesses = state.backgroundProcesses;
    if (Array.isArray(result.restoreErrors) && result.restoreErrors.length > 0) {
      this.emit({
        type: "session.notice",
        sessionId: this.sessionId,
        notice: {
          id: `rewind-restore-${Date.now()}`,
          severity: "warning",
          title: "Files not restored",
          description: `The rewind did not restore: ${result.restoreErrors.slice(0, 3).join("; ")}`,
        },
      });
    }
  }

  // ─── B6: resync §4.4 (eventId gap) & state replacement ────────────────

  /** Resync (§4.4) scheduled from gap detection — at most one session/read at
   * a time (notifications keep flowing live). Lost notifications ≠ lost for
   * the daemon: the plugin IS the only path to the timeline, so re-emitting
   * the missing entries HERE is the first display of these items (never a
   * daemon duplicate). Daemon semantics (plugin-provider mapTimelineItem +
   * timeline-projection timelineItemIdentity) verified in the code: text
   * items (user/assistant/reasoning) are deduped by id (same text → drop,
   * prefix → suffix only); tool_calls merge by callId WITHIN THE SAME turnId;
   * todo/error/notification/compaction have NO merge at all. → Emission
   * policy: NEW entries go out as-is; MODIFIED entries only go out again if
   * they belong to the ACTIVE turn (callId merge guaranteed daemon-side);
   * never a re-emission for todo effects (one card per emission). */
  private scheduleResync(reason: string): void {
    if (!this.client || !this.vibeSessionId) return;
    if (this.resyncInFlight) return;
    this.resyncInFlight = true;
    void this.resyncFromRead(reason)
      .catch((error) => {
        console.error(`[vibe-provider] resync session/read failed: ${describe(error)}`);
        this.emit({
          type: "session.notice",
          sessionId: this.sessionId,
          notice: { id: `resync-failed-${Date.now()}`, severity: "warning", title: "Resync failed", description: `Re-reading the session failed (${describe(error)}); tracking resumes from live notifications.` },
        });
      })
      .finally(() => { this.resyncInFlight = false; });
  }

  private async resyncFromRead(reason: string): Promise<void> {
    const client = this.client;
    if (!client || !this.vibeSessionId) return;
    const result = await client.request<SessionReadResult>("session/read", {
      sessionId: this.vibeSessionId,
      history: { limit: 500 },
      turns: { limit: 500 },
    }, 30_000);
    this.applyStateReplacement(`resync (${reason})`, result.state, result.lastEventId);
  }

  /**
   * Full state replacement from PublicSessionState (gap resync,
   * session/compacted, session/contextCleared): rebuilds entries/usage/
   * lastEventId, reconciles missed turns, then emits surgically —
   * cf. scheduleResync for the idempotent emission policy.
   */
  private applyStateReplacement(source: string, state: PublicSessionState | undefined, watermark: number | undefined): void {
    if (!state) return;
    if (typeof state.session?.id === "string" && state.session.id && state.session.id !== this.vibeSessionId) {
      // inplace keeps the id; a handoff (server compaction) follows persistence.
      this.vibeSessionId = state.session.id;
      this.emitPersistence();
    }
    const usage = (state.session as { tokenUsage?: TokenUsage }).tokenUsage;
    if (usage && typeof usage === "object") this.tokenUsage = usage;
    // History diff: added (never seen → to emit), changed (to re-emit per
    // the policy), removed (compaction: we forget them).
    const fresh = Array.isArray(state.history) ? state.history : [];
    const freshIds = new Set(fresh.map((entry) => entry.id));
    const added: HistoryEntry[] = [];
    const changed: HistoryEntry[] = [];
    for (const entry of fresh) {
      const known = this.entries.get(entry.id);
      if (!known) added.push(entry);
      else if (stableStringify(known) !== stableStringify(entry)) changed.push(entry);
    }
    const removedCount = [...this.entries.keys()].filter((id) => !freshIds.has(id)).length;
    this.entries.clear();
    for (const entry of fresh) this.entries.set(entry.id, entry);
    if (typeof watermark === "number") this.lastEventId = Math.max(this.lastEventId, watermark);
    else if (typeof state.eventId === "number") this.lastEventId = Math.max(this.lastEventId, state.eventId);
    if (Array.isArray(state.backgroundProcesses)) this.backgroundProcesses = state.backgroundProcesses;
    this.reconcileTurns(state);
    const ctx = this.rootTimelineContext();
    let emittedAdded = 0;
    let emittedUpdated = 0;
    let skippedUpdated = 0;
    for (const entry of added) {
      const item = this.timelineItemFor(entry, undefined, ctx);
      if (item) {
        this.emit({ type: "timeline.item", sessionId: this.sessionId, item, timestamp: baseTimestamp(entry) });
        emittedAdded += 1;
      }
    }
    for (const entry of changed) {
      if (!this.reemitSafe(entry)) {
        skippedUpdated += 1;
        continue;
      }
      const item = this.timelineItemFor(entry, undefined, ctx);
      if (item) {
        this.emit({ type: "timeline.item", sessionId: this.sessionId, item, timestamp: baseTimestamp(entry) });
        emittedUpdated += 1;
      }
    }
    console.log(`[vibe-provider] state replacement (${source}): ${added.length} added (${emittedAdded} emitted), ${changed.length} changed (${emittedUpdated} updated, ${skippedUpdated} noted), ${removedCount} removed, eventId=${this.lastEventId}`);
    this.emit({
      type: "session.notice",
      sessionId: this.sessionId,
      notice: {
        id: `resync-${Date.now()}`,
        severity: "info",
        title: source.startsWith("resync") ? "Resynchronised" : source.includes("compacted") ? "Context compacted" : "Context cleared",
        description: `State re-read from vibe (${source}): ${emittedAdded} item(s) recovered, ${emittedUpdated} updated, ${skippedUpdated} change(s) noted without duplicate risk.`,
      },
    });
  }

  /** A MODIFIED entry can only go out again if its daemon-side merge is an
   * upsert: tool_call with identical callId in the SAME active turn, texts
   * with identical id (daemon dedup). Todo effects (one card per emission)
   * and the structured tool's effects (items handled at tools/call) never go
   * out again. */
  private reemitSafe(entry: HistoryEntry): boolean {
    const turnId = entry.turnId;
    if (!turnId || turnId !== this.activeTurnId) return false;
    if (entry.type === "effect") {
      const detail = (entry as EffectEntry).detail;
      if (detail?.kind === "todo") return false;
      if ((detail?.toolName ?? "").includes(STRUCTURED_OUTPUT_TOOL_NAME)) return false;
    }
    return true;
  }

  /** Turns missed inside the gap: seen "started" live but closed server-side →
   * we emit the closure (footer approximated from the cumulatives at hand);
   * the exact footer (Duration/Throughput) is best-effort, whereas the
   * structured assert replays exactly (the request lives until the turn is
   * flushed). */
  private reconcileTurns(state: PublicSessionState): void {
    const turns = Array.isArray(state.turns) ? (state.turns as unknown as PublicTurn[]) : [];
    for (const turn of turns) {
      if (!turn?.id || turn.status === "in_progress") continue;
      if (this.pendingTurn && this.pendingTurn.turn.id === turn.id) continue;
      const tracked = this.turns.get(turn.id);
      if (!tracked || tracked.closed) continue;
      const finalState = turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : "canceled";
      this.pendingTurn = { turn, state: finalState };
      this.flushPendingTurn();
    }
  }

  /**
   * Debug driver-only: simulates the loss of the last `drop` entries of the
   * LOCAL tracking then resyncs (session/read + diff + re-emission) — the
   * exact path a real eventId gap takes. The daemon cannot produce the
   * "session.debug" input (strict ProviderInputSchema): strictly an e2e test
   * tool, with no effect when the session is empty.
   */
  debugSimulateGap(drop: number): void {
    const ids = [...this.entries.keys()];
    const tail = ids.slice(-Math.max(0, Math.min(Math.trunc(drop) || 0, ids.length)));
    for (const id of tail) this.entries.delete(id);
    console.warn(`[vibe-provider] debug simulate-gap: -${tail.length} local entries, resync triggered`);
    this.scheduleResync(`debug simulate-gap (-${tail.length} entries)`);
  }

  async configure(changes: ProviderConfigChanges, requestId?: string): Promise<void> {
    if (!this.client) return;
    try {
      if (changes.model) {
        await this.client.request("config/model/write", {
          sessionId: this.vibeSessionId,
          modelAlias: changes.model,
          ...(changes.thinkingOption ? { reasoningEffort: changes.thinkingOption } : {}),
        }, 60_000);
      } else if (changes.thinkingOption) {
        await this.client.request("config/model/write", {
          sessionId: this.vibeSessionId,
          reasoningEffort: changes.thinkingOption,
        }, 60_000);
      }
      if (changes.mode) {
        await this.client.request("session/agent/update", {
          sessionId: this.vibeSessionId,
          agentName: changes.mode,
        }, 60_000);
      }
      // providerOptions (phase 4): approvalPolicy → session/approvalPolicy/update;
      // maxTurns → session/settings/update (idle session required by vibe).
      const providerOptions = (changes.providerOptions ?? {}) as Record<string, unknown>;
      const approvalPolicyValue = providerOptions.approvalPolicy;
      if (typeof approvalPolicyValue === "string" && approvalPolicyValue !== this.approvalPolicy) {
        await this.client.request("session/approvalPolicy/update", {
          sessionId: this.vibeSessionId,
          approvalPolicy: approvalPolicyValue,
        }, 60_000);
        this.approvalPolicy = approvalPolicyValue;
      }
      const maxTurnsValue = providerOptions.maxTurns;
      if (typeof maxTurnsValue === "number" && Number.isFinite(maxTurnsValue) && maxTurnsValue >= 0) {
        await this.client.request("session/settings/update", {
          sessionId: this.vibeSessionId,
          maxTurns: Math.floor(maxTurnsValue),
        }, 60_000);
      }
      if (requestId) this.emit({ type: "request.completed", requestId });
    } catch (error) {
      if (requestId) this.emit({ type: "request.failed", requestId, error: { message: describe(error) } });
    }
  }

  async respondToPermission(permissionId: string, response: ProviderPermissionResponse): Promise<void> {
    const client = this.client;
    const record = this.openCallbacks.get(permissionId);
    if (!client || !record) {
      console.warn(`[vibe-provider] permission ${permissionId} is no longer open`);
      return;
    }
    this.openCallbacks.delete(permissionId);
    try {
      if (record.detailKind === "approval") {
        const decision = approvalDecision(response);
        const output: CallbackApprovalOutput = {
          type: "approval",
          decision: {
            type: decision,
            pathScope: decision === "approve" && record.pathScopeChoices.length > 0 ? "exact" : null,
          },
          feedback: response.behavior === "deny" ? (response.message ?? null) : null,
        };
        await client.request("callback/result", {
          sessionId: record.vibeSessionId,
          result: { callbackId: permissionId, output },
        });
      } else if (record.detailKind === "user_input") {
        const answers = approvalAnswers(response);
        const output: CallbackUserInputOutput = {
          type: "user_input",
          result: { answers, cancelled: response.behavior !== "allow" },
        };
        await client.request("callback/result", {
          sessionId: record.vibeSessionId,
          result: { callbackId: permissionId, output },
        });
      } else {
        return;
      }
      // Resolution confirmed: without this event, the request tile and the
      // spinner on the Paseo side persist indefinitely (the daemon waits for
      // the provider's confirmation, cf. translatePermissionResolution).
      this.emit({ type: "session.permission_resolved", sessionId: record.permissionSessionId, permissionId });
    } catch (error) {
      console.error(`[vibe-provider] permission reply failed: ${describe(error)}`);
    }
  }

  async close(requestId?: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const client = this.client;
    try {
      if (client && this.vibeSessionId) {
        await client.request("session/stop", { sessionId: this.vibeSessionId, reason: null }, 30_000).catch(() => undefined);
      }
    } finally {
      if (client) await client.close();
      if (requestId) this.emit({ type: "request.completed", requestId });
      this.flushPendingTurn();
      this.emitClosed(undefined);
    }
  }

  private emitClosed(error?: { message: string }): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    if (error) this.emit({ type: "session.runtime_failed", sessionId: this.sessionId, error });
    this.emit({ type: "session.closed", sessionId: this.sessionId, ...(error ? { error } : {}) });
  }

  private handleUnexpectedClose(): void {
    // An exit during close() is the normal flow (session/stop → EOF).
    this.emitClosed(this.closing ? undefined : { message: "vibe-app-server exited unexpectedly" });
  }

  private handleCallback(callback: PublicCallbackEntry, ack: (id: string) => void, respondError: (message: string) => void): void {
    ack(callback.callbackId);
    const detail = callback.detail;
    // A child session's callbacks carry its sessionId — the permission must
    // reference the matching Paseo sub-session.
    const permissionSessionId = callback.sessionId && callback.sessionId !== this.vibeSessionId ? callback.sessionId : this.sessionId;
    if (detail?.kind === "approval") {
      const approval = detail as ApprovalCallbackDetail;
      // B8 (capability permission.tool_policy): a tool preapproved by the
      // daemon must NEVER block an unattended agent — approve_for_session
      // auto-decision (vibe remembers the grant for its session: no
      // re-callback for subsequent calls), without emitting session.permission.
      // Children go through the same path: they inherit the root set (cf.
      // daemon materialization opencode v2 permissions.js, preapprovals →
      // allow rules provider-side; here the equivalent is the callback rail).
      const toolName = approval.effect?.toolName ?? "";
      if (this.preapprovedTools.has(toolName) && this.client) {
        const output: CallbackApprovalOutput = {
          type: "approval",
          decision: {
            type: "approve_for_session",
            pathScope: (approval.pathScopeChoices ?? []).length > 0 ? "exact" : null,
          },
          feedback: null,
        };
        void this.client.request("callback/result", {
          sessionId: callback.sessionId ?? this.vibeSessionId,
          result: { callbackId: callback.callbackId, output },
        })
          .then(() => console.log(`[vibe-provider] tool ${toolName} auto-approved (toolPolicy)`))
          .catch((error) => console.error(`[vibe-provider] tool ${toolName} auto-approval failed: ${describe(error)}`));
        return;
      }
      const stateChoices = approval.pathScopeChoices ?? [];
      this.openCallbacks.set(callback.callbackId, { detailKind: "approval", pathScopeChoices: stateChoices, vibeSessionId: callback.sessionId ?? this.vibeSessionId, permissionSessionId });
      const request: ProviderPermissionRequest = {
        id: callback.callbackId,
        name: approval.effect?.toolName ?? "tool",
        kind: "tool",
        title: callback.title,
        description: approval.effect?.display?.summary,
        input: (approval.effect?.input ?? {}) as Record<string, never>,
        detail: toolCallDetail(approval.effect, undefined),
      };
      this.emit({ type: "session.permission", sessionId: permissionSessionId, request });
    } else if (detail?.kind === "user_input") {
      const userInput = detail as UserInputCallbackDetail;
      this.openCallbacks.set(callback.callbackId, { detailKind: "user_input", pathScopeChoices: [], vibeSessionId: callback.sessionId ?? this.vibeSessionId, permissionSessionId });
      const request: ProviderPermissionRequest = {
        id: callback.callbackId,
        name: "user_question",
        kind: "question",
        title: callback.title ?? "Vibe asked a question",
        suggestions: (userInput.request?.questions ?? []).map((question) => ({
          question: question.question ?? "",
          header: question.header ?? "",
          options: (question.options ?? []).map((option) => ({ label: option.label ?? "", description: option.description ?? "" })),
          multiSelect: Boolean(question.multiSelect),
        })),
      };
      this.emit({ type: "session.permission", sessionId: permissionSessionId, request });
    } else {
      console.warn(`[vibe-provider] unhandled callback kind: ${(detail as { kind?: string })?.kind}`);
      respondError(`callback kind ${(detail as { kind?: string })?.kind} is not handled`);
    }
  }

  /**
   * tools/call server→client (B5) — handlers of the client tools declared at
   * initialize. Single declared tool: paseo.paseo_structured_output. The wire
   * response is the tool's result: `output` (the model reads it) or `error`
   * (TOOL ERROR read by the model, which retries). Daemon convention (opencode
   * v2 providers, structured-output.js + timeline.js): the accepted value is
   * published on a tool_call item named paseo_structured_output, status
   * completed, `metadata.paseoStructuredOutput` + an assistant_message
   * `JSON.stringify(value)` (the plugin-provider lets tool_call metadata and
   * assistant_message through as-is — mapTimelineItem).
   */
  private handleClientToolCall(call: ClientToolCallWire): ClientToolResponseWire {
    if (call?.name !== STRUCTURED_OUTPUT_TOOL_QUALIFIED && call?.name !== STRUCTURED_OUTPUT_TOOL_NAME) {
      return { error: { message: `unknown client tool: ${call?.name}`, code: "unknown_client_tool" } };
    }
    const structured = this.structured;
    if (!structured) {
      // Same answer as the opencode structured-output-plugin; read by the
      // model as a tool error.
      return { error: { message: "This turn has no structured-output request", code: "no_output_schema" } };
    }
    structured.calls += 1;
    const input = call.input as { value?: unknown } | null | undefined;
    const value = input && typeof input === "object" && "value" in input ? input.value : undefined;
    if (value === undefined) {
      structured.rejections += 1;
      const message = `Invalid structured output: the call input must be an object like { "value": <final answer> } (got ${JSON.stringify(call.input)?.slice(0, 200)})`;
      this.emitStructuredToolCall(call, "failed", message);
      return { error: { message, code: "invalid_output", details: { errors: [] } } };
    }
    let valid = false;
    try {
      valid = structured.validator(value);
    } catch (error) {
      structured.rejections += 1;
      const message = `Invalid structured output: schema validation crashed: ${describe(error)}`;
      this.emitStructuredToolCall(call, "failed", message);
      return { error: { message, code: "invalid_output" } };
    }
    if (!valid) {
      structured.rejections += 1;
      const errors = JSON.parse(JSON.stringify(structured.validator.errors ?? [])) as unknown[];
      // Default errorsText: "data/res must be equal to one of the allowed values".
      const message = `Invalid structured output: ${this.ajv.errorsText(structured.validator.errors)}`;
      this.emitStructuredToolCall(call, "failed", message);
      return { error: { message, code: "invalid_output", details: { errors } } };
    }
    const first = !structured.accepted;
    if (first) {
      structured.accepted = true;
      structured.value = value as JsonValue;
      structured.callId = call.callId;
      console.log(`[vibe-provider] structured output accepted (call=${call.callId}, rejections=${structured.rejections})`);
      // B6: per-turn memory + persistence — the replay (daemon reload) will
      // re-emit the items absent from the vibe history.
      if (structured.turnId) {
        this.structuredOutputs.set(structured.turnId, { value: value as JsonValue, callId: call.callId });
        while (this.structuredOutputs.size > 16) {
          const oldest = this.structuredOutputs.keys().next().value;
          if (oldest === undefined) break;
          this.structuredOutputs.delete(oldest);
        }
        this.replayedStructuredTurns.add(structured.turnId);
        this.emitPersistence();
      }
    }
    const output = first
      ? "Final structured answer accepted. End this turn without additional text or tool calls."
      : "Final structured answer already accepted for this turn. End the turn without additional text or tool calls.";
    this.emitStructuredToolCall(call, "completed", output);
    return { output, annotations: {} };
  }

  /**
   * Canonical timeline item of the structured tool_call: ONE entry per
   * submission (failed or accepted). The native projection of this tool's
   * wire effects is discarded (timelineItemFor) to avoid doubling, and the
   * accepted value goes out under `metadata.paseoStructuredOutput` — the key
   * the daemon reads (providers/opencode/v2/{structured-output,timeline}.js).
   */
  private emitStructuredToolCall(call: ClientToolCallWire, status: "completed" | "failed", output: string): void {
    const structured = this.structured;
    const isFirstAcceptance = status === "completed" && structured !== null && structured.accepted && structured.callId === call.callId;
    const detail: ProviderToolCallDetail = {
      type: "unknown",
      input: (call.input ?? {}) as Record<string, never>,
      output: output as unknown as Record<string, never>,
    };
    const item: ProviderTimelineItem = status === "failed"
      ? { type: "tool_call", id: call.callId, callId: call.callId, name: STRUCTURED_OUTPUT_TOOL_NAME, detail, status: "failed", error: { message: output } }
      : {
        type: "tool_call",
        id: call.callId,
        callId: call.callId,
        name: STRUCTURED_OUTPUT_TOOL_NAME,
        detail,
        status: "completed",
        error: null,
        // Daemon convention: the submission's first validated value.
        ...(isFirstAcceptance && structured?.value !== undefined
          ? { metadata: { paseoStructuredOutput: structured.value } }
          : {}),
      };
    this.emit({ type: "timeline.item", sessionId: this.sessionId, item, timestamp: new Date().toISOString() });
    if (isFirstAcceptance) {
      // Publication of the value to the timeline (daemon v2 pattern: JSON
      // assistant message of the validated value — what orchestrators read).
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: { type: "assistant_message", id: `structured-${call.callId}`, text: JSON.stringify(structured?.value), messageId: `structured-${call.callId}` },
        timestamp: new Date().toISOString(),
      });
    }
  }

  /** B6: persistence carries the structured-output memory with the vibe
   * session (the vibe history has NO trace of these client tool_calls) —
   * daemon reload / process resume can replay the items. */
  private loadStructuredMemory(persistence: OpenSessionOptions["persistence"]): void {
    const data = (persistence?.data as { structuredOutputs?: Record<string, unknown> } | undefined)?.structuredOutputs;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    for (const [turnId, record] of Object.entries(data)) {
      if (!turnId || !record || typeof record !== "object") continue;
      const value = (record as { value?: unknown }).value;
      const callId = (record as { callId?: unknown }).callId;
      if (value !== undefined && typeof callId === "string" && callId) {
        this.structuredOutputs.set(turnId, { value: value as JsonValue, callId });
      }
    }
  }

  /**
   * Replays the structured outputs at history:"replay" (the only moment the
   * daemon REBUILDS its timeline from our items — hydrateTimelineFromProvider,
   * otherwise the store is append-only): for each replayed-history turn
   * carrying a memorized value, we re-emit the B5-convention tool_call
   * (metadata.paseoStructuredOutput) + the JSON assistant_message. NO replay
   * at mid-session resync: the items went out live at tools/call (a request,
   * not a notification — insensitive to eventId gaps) and the daemon store
   * does not dedupe them by id.
   */
  private replayStructuredOutputs(state: PublicSessionState): void {
    if (this.structuredOutputs.size === 0) return;
    const turnIds = new Set<string>();
    for (const entry of state.history ?? []) {
      if (typeof entry?.turnId === "string" && entry.turnId) turnIds.add(entry.turnId);
    }
    for (const turn of state.turns ?? []) {
      const id = (turn as { id?: unknown }).id;
      if (typeof id === "string" && id) turnIds.add(id);
    }
    for (const [turnId, record] of this.structuredOutputs) {
      if (!turnIds.has(turnId) || this.replayedStructuredTurns.has(turnId)) continue;
      this.replayedStructuredTurns.add(turnId);
      console.log(`[vibe-provider] replay structured output (turn=${turnId.slice(0, 8)}…, call=${record.callId.slice(0, 8)}…)`);
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: {
          type: "tool_call",
          id: record.callId,
          callId: record.callId,
          name: STRUCTURED_OUTPUT_TOOL_NAME,
          detail: { type: "unknown", input: { value: record.value }, output: "Final structured answer accepted. End this turn without additional text or tool calls." },
          status: "completed",
          error: null,
          metadata: { paseoStructuredOutput: record.value },
        },
        timestamp: new Date().toISOString(),
      });
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: { type: "assistant_message", id: `structured-${record.callId}`, text: JSON.stringify(record.value), messageId: `structured-${record.callId}` },
        timestamp: new Date().toISOString(),
      });
    }
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = rawParams as EventNotificationParams;
    if (!params?.sessionId) return;
    // A completed turn waits for its statsUpdated (same server batch, cf. onTurnCompleted): any subsequent notification triggers it. session/statsUpdated handles its own flush (after merging the counters).
    if (method !== "session/statsUpdated") this.flushPendingTurn();
    if (this.vibeSessionId && params.sessionId !== this.vibeSessionId) {
      // Flow of a child session (capability childSessionEvents) — phase 4.
      this.handleChildNotification(method, params);
      return;
    }
    if (typeof params?.eventId === "number") {
      if (params.eventId > this.lastEventId + 1) {
        // §4.4: gap — real resync via session/read (reconstruction + diff +
        // surgical re-emission), plus the traceability notice.
        console.warn(`[vibe-provider] event gap ${this.lastEventId}→${params.eventId} (session ${this.sessionId}): resync session/read`);
        this.scheduleResync(`event gap ${this.lastEventId}→${params.eventId}`);
      }
      this.lastEventId = Math.max(this.lastEventId, params.eventId);
    }
    switch (method) {
      case "session/snapshot": {
        // The root only receives a snapshot on changes not readable via patch
        // (retrying, backgroundProcesses, loops, goal — cf. server.py
        // _translate_snapshot_update): we only extract the backgrounds from it.
        const state = (params as { state?: PublicSessionState }).state;
        const processes = state?.backgroundProcesses;
        if (Array.isArray(processes)) this.backgroundProcesses = processes;
        return;
      }
      case "session/childSessionUpdated": {
        // Always delivered (root-tagged): opens the child if unknown
        // (safety net — usually the child session/snapshot opens it first).
        const childSession = params.childSession as PublicChildSession | undefined;
        if (childSession?.id && !this.children.has(childSession.id)) {
          this.handleChildNotification("session/snapshot", { ...params, sessionId: childSession.id });
        }
        return;
      }
      case "turn/started":
        this.onTurnStarted(params.turn as PublicTurn, params);
        return;
      case "turn/completed":
        this.onTurnCompleted(params.turn as PublicTurn, params);
        return;
      case "history/entryAdded":
        this.onEntryAdded(params.entry as HistoryEntry, params);
        return;
      case "history/entryUpdated":
        this.onEntryUpdated(params.entryId as string, params.patch as PatchOperation[], params);
        return;
      case "session/updated":
        this.onSessionUpdated(params.patch as PatchOperation[]);
        return;
      case "session/statsUpdated": {
        // §4.5: cumulative counters + active model prices + context gauge.
        // Emitted both live (every state batch) and after turn/completed.
        this.onStatsUpdated(
          params.stats as AgentStatsSnapshot | undefined,
          params.contextWindow,
        );
        return;
      }
      case "runtime/updated":
        this.onRuntimeUpdated(params.runtime as RuntimeSnapshot);
        return;
      case "session/compacted":
      case "session/contextCleared": {
        // Handoff (§4): the state is REPLACED — same handling as the resync
        // (B6): map reconstruction from state + diff + surgical re-emission
        // of the new entries, followed by the new session id.
        const handoff = params as { state?: PublicSessionState };
        const compacted = method === "session/compacted";
        if (compacted) {
          // First-class timeline marker (daemon pattern: claude
          // compact_boundary / codex context compaction / omp manual).
          this.emit({
            type: "timeline.item",
            sessionId: this.sessionId,
            item: { type: "compaction", id: `compaction-${params.eventId ?? Date.now()}`, status: "completed", trigger: "auto" },
            timestamp: new Date().toISOString(),
          });
        }
        if (handoff.state) {
          this.applyStateReplacement(method, handoff.state, typeof params.eventId === "number" ? params.eventId : undefined);
        } else {
          // Defensive: without state, we at least track the vibe session id.
          const state = (params as { state?: { session?: { id?: string } } }).state;
          if (state?.session?.id && state.session.id !== this.vibeSessionId) {
            this.vibeSessionId = state.session.id;
            this.emitPersistence();
          }
        }
        this.emit({
          type: "session.notice",
          sessionId: this.sessionId,
          notice: { id: `${method}-${params.eventId ?? Date.now()}`, severity: "info", title: compacted ? "Context compacted" : "Context cleared", description: compacted ? "Vibe compacted the session and handed off a new state; the timeline continues after the compaction marker." : "Vibe cleared the session context and handed off a new state." },
        });
        return;
      }
      case "warning":
        this.emit({ type: "session.notice", sessionId: this.sessionId, notice: { id: `warn-${params.eventId ?? Date.now()}`, severity: "warning", title: "Warning", description: describe(params.warning) } });
        return;
      case "turn/retrying":
        this.emit({ type: "session.notice", sessionId: this.sessionId, notice: { id: `retry-${Date.now()}`, severity: "info", title: "Retrying", description: `Vibe is retrying after ${String((params as { category?: string }).category ?? "an error")}.` } });
        return;
      default:
        return;
    }
  }

  /**
   * Events of a child session (vibe subagent). Each child is opened as a
   * Paseo sub-session on the first event seen (sessionId = the child's vibe
   * id, parentSessionId = our root Paseo sessionId).
   */
  private handleChildNotification(method: string, params: EventNotificationParams): void {
    const childId = params.sessionId;
    let child = this.children.get(childId);
    if (!child) {
      child = { entries: new Map(), turns: new Map(), lastEventId: 0, todo: { signature: null } };
      this.children.set(childId, child);
      this.emit({
        type: "session.opened",
        sessionId: childId,
        parentSessionId: this.sessionId,
        capabilities: SESSION_CAPABILITIES,
        restoration: "parent",
        cwd: this.config.cwd,
      });
      console.log(`[vibe-provider] child session opened ${childId} (parent ${this.sessionId})`);
    }
    if (typeof params.eventId === "number" && params.eventId > child.lastEventId) child.lastEventId = params.eventId;
    const ctx = { turns: child.turns, todo: child.todo };
    switch (method) {
      case "session/snapshot": {
        // Initial state of the child: replay of the known history.
        const state = (params as { state?: { history?: unknown[] } }).state;
        for (const entry of (state?.history ?? []) as HistoryEntry[]) {
          child.entries.set(entry.id, entry);
          const item = this.timelineItemFor(entry, params, ctx);
          if (item) this.emit({ type: "timeline.item", sessionId: childId, item, timestamp: baseTimestamp(entry, params) });
        }
        return;
      }
      case "history/entryAdded": {
        const entry = params.entry as HistoryEntry | undefined;
        if (!entry?.id) return;
        child.entries.set(entry.id, entry);
        this.resolvePendingCallback(entry);
        const item = this.timelineItemFor(entry, params, ctx);
        if (item) this.emit({ type: "timeline.item", sessionId: childId, item, timestamp: baseTimestamp(entry, params) });
        return;
      }
      case "history/entryUpdated": {
        const entryId = params.entryId as string | undefined;
        const patch = params.patch as PatchOperation[] | undefined;
        if (!entryId || !Array.isArray(patch)) return;
        const existing = child.entries.get(entryId);
        if (!existing) return;
        const updated = applyPatch(existing as unknown as Record<string, unknown>, patch);
        child.entries.set(entryId, updated as unknown as HistoryEntry);
        this.resolvePendingCallback(updated as unknown as HistoryEntry);
        const item = this.timelineItemFor(updated as unknown as HistoryEntry, params, ctx);
        if (item) this.emit({ type: "timeline.item", sessionId: childId, item, timestamp: baseTimestamp(updated as unknown as HistoryEntry, params) });
        return;
      }
      case "turn/started":
      case "turn/completed": {
        const turn = params.turn as PublicTurn | undefined;
        if (!turn) return;
        const state = turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "canceled" : "started";
        this.emit({
          type: "session.turn",
          sessionId: childId,
          turnId: turn.id,
          state,
          ...(state === "failed" ? { error: { message: turn.error?.message ?? "turn failed" } } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  hasChild(sessionId: string): boolean {
    return this.children.has(sessionId);
  }

  private onTurnStarted(turn: PublicTurn | undefined, params: EventNotificationParams): void {
    if (!turn) return;
    let tracked = this.turns.get(turn.id);
    if (!tracked) {
      tracked = {};
      this.turns.set(turn.id, tracked);
    }
    // Pre-turn footprint: the footer deltas are computed at turn completion.
    if (!tracked.usageAtStart) {
      tracked.usageAtStart = this.cumulativeUsage();
      tracked.stepsAtStart = this.stats?.steps ?? 0;
    }
    this.activeTurnId = turn.id;
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId: turn.id, state: "started" });
  }

  private onTurnCompleted(turn: PublicTurn | undefined, params: EventNotificationParams): void {
    if (!turn) return;
    // The server batch places the final statsUpdated JUST AFTER turn/completed
    // (_interleave_stats): we defer the emission so the footer's Duration/
    // Throughput/Tokens read the closed counters. Flushed by the next
    // notification, otherwise a guard timer (20 ms >> batch latency).
    if (this.pendingTurn) this.flushPendingTurn();
    const state = turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : "canceled";
    this.pendingTurn = { turn, state };
    this.pendingTurnTimer = setTimeout(() => this.flushPendingTurn(), 20);
    void params;
  }

  private flushPendingTurn(): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    this.pendingTurn = null;
    if (this.pendingTurnTimer) {
      clearTimeout(this.pendingTurnTimer);
      this.pendingTurnTimer = null;
    }
    const turn = pending.turn;
    const tracked = this.turns.get(turn.id);
    let isError = pending.state === "failed";
    let pendingState = pending.state;
    let errorMessage = turn.error?.message ?? "turn failed";
    let errorCode = turn.error?.code;
    // Structured-output assert (daemon opencode v2 turns.js finish()
    // pattern: a successful turn WITHOUT a valid submission = failed turn);
    // no assert on failure/cancellation (a value accepted earlier in the
    // turn stays published). The request dies with the turn (B5 mission).
    const structured = this.turnStructuredFor(turn.id);
    if (pendingState === "completed" && structured && !structured.accepted) {
      pendingState = "failed";
      isError = true;
      errorMessage = "Vibe finished without submitting the required structured output";
      errorCode = "missing_structured_output";
      console.log(`[vibe-provider] structured output missing at turn end (calls=${structured.calls}, rejections=${structured.rejections})`);
    }
    if (structured && structured.turnId === turn.id) this.structured = null;
    const footprint = turnFootprint(turn, tracked?.usageAtStart ?? ZERO_USAGE, this.cumulativeUsage());
    const metrics: ProviderMetric[] = [];
    if (pendingState === "completed") {
      const stepsDelta = Math.max(0, (this.stats?.steps ?? 0) - (tracked?.stepsAtStart ?? 0));
      if (stepsDelta > 1) metrics.push({ label: "Steps", value: String(stepsDelta) });
      if (footprint.durationMs > 0) metrics.push({ label: "Duration", value: formatMetricDuration(footprint.durationMs) });
      if (footprint.inputTokens + footprint.outputTokens > 0 && footprint.durationMs > 0) {
        metrics.push({ label: "Throughput", value: `${(((footprint.inputTokens + footprint.outputTokens) * 1000) / footprint.durationMs).toFixed(1)} tok/s (in+out)` });
      }
      if (footprint.inputTokens + footprint.outputTokens > 0) {
        metrics.push({ label: "Tokens", value: `${formatTokens(footprint.inputTokens)} in / ${formatTokens(footprint.outputTokens)} out` });
      }
    }
    this.emit({
      type: "session.turn",
      sessionId: this.sessionId,
      turnId: turn.id,
      state: pendingState,
      ...(isError ? { error: { message: errorMessage, ...(errorCode ? { code: errorCode } : {}) } } : {}),
      ...(metrics.length > 0 ? { metrics } : {}),
    });
    this.emitUsage(turn.id);
    this.emitSessionMetrics();
    if (tracked?.clientMessageId && isError) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: tracked.clientMessageId,
        result: { type: "failed", error: { message: errorMessage, ...(errorCode ? { code: errorCode } : {}) } },
      });
    }
    // The turn is wrapped up: a later resync does not re-close it.
    if (tracked) tracked.closed = true;
    if (this.activeTurnId === turn.id) this.activeTurnId = null;
  }

  /** The structured request carried BY THIS turn (null otherwise — steer included). */
  private turnStructuredFor(turnId: string): AgentSession["structured"] {
    const structured = this.structured;
    return structured && structured.turnId === turnId ? structured : null;
  }

  /**
   * §4.5 session/statsUpdated: refreshes stats/prices/window, then pushes the
   * cumulative cost (session.usage) and the provider-owned lines (session.metrics).
   */
  private onStatsUpdated(stats: AgentStatsSnapshot | undefined, contextWindow: number | undefined): void {
    if (!stats || typeof stats !== "object") return;
    this.stats = stats;
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      this.compactionThresholdTokens = contextWindow;
    }
    this.emitUsage(this.activeTurnId ?? undefined);
    this.emitSessionMetrics();
    this.flushPendingTurn();
  }

  /**
   * Session cumulative counters: max across sources (session/start +
   * session/updated + statsUpdated, which carry the same counters — cf.
   * _advance_stats) to stay correct on a resume where the runtime reseeds to 0.
   */
  private cumulativeUsage(): TokenUsage {
    const patch = this.tokenUsage ?? {};
    const stats = this.stats ?? {};
    return {
      inputTokens: Math.max(patch.inputTokens ?? 0, stats.sessionPromptTokens ?? 0),
      outputTokens: Math.max(patch.outputTokens ?? 0, stats.sessionCompletionTokens ?? 0),
      totalTokens: Math.max(patch.totalTokens ?? 0, (stats.sessionPromptTokens ?? 0) + (stats.sessionCompletionTokens ?? 0)),
      cachedInputTokens: Math.max(patch.cachedInputTokens ?? 0, stats.sessionCachedTokens ?? 0),
    };
  }

  /** Cumulative USD cost of the session — vibe formula (vibe/utils/pricing.py):
   * cache clamped to the prompt, cache price otherwise input price, all /1e6.
   * Price 0 (unpriced model) → cost 0. */
  private sessionCostUsd(usage: TokenUsage): number {
    const stats = this.stats;
    const inputPrice = finitePrice(stats?.inputPricePerMillion, 0);
    const outputPrice = finitePrice(stats?.outputPricePerMillion, 0);
    const cachedPrice = finitePrice(stats?.cachedInputPricePerMillion, inputPrice);
    const prompt = usage.inputTokens ?? 0;
    const cached = Math.min(usage.cachedInputTokens ?? 0, prompt);
    return ((prompt - cached) * inputPrice + cached * cachedPrice + (usage.outputTokens ?? 0) * outputPrice) / 1_000_000;
  }

  private sessionWindowTokens(): number | undefined {
    return this.modelWindowTokens ?? this.compactionThresholdTokens;
  }

  /** session.usage: cumulative tokens + totalCostUsd (cumulative, cf. daemon:
   * opencode sends session.cost, Claude its total_cost_usd — never per-turn). */
  private emitUsage(turnId?: string): void {
    if (!this.stats && !this.tokenUsage) return;
    const usage = this.cumulativeUsage();
    if ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) === 0) {
      // Nothing measured (pre-model-call batch): keep the $0.00 out of the UI.
      return;
    }
    const window = this.sessionWindowTokens();
    const contextTokens = this.stats?.contextTokens;
    const providerUsage: ProviderUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      totalCostUsd: this.sessionCostUsd(usage),
      ...(window ? { contextWindowMaxTokens: window } : {}),
      ...(typeof contextTokens === "number" && contextTokens > 0 ? { contextWindowUsedTokens: contextTokens } : {}),
    };
    // Anti-noise: the daemon replaces lastUsage on every event; only push a
    // genuinely different usage (flush after statsUpdated, etc.).
    const signature = JSON.stringify(providerUsage);
    if (signature === this.usageSignature) return;
    this.usageSignature = signature;
    this.emit({
      type: "session.usage",
      sessionId: this.sessionId,
      ...(turnId ? { turnId } : {}),
      usage: providerUsage,
    });
  }

  /**
   * Provider-owned lines (capability session.metrics, §4) — signature-based
   * anti-noise: only emitted when a value changes (cf. daemon
   * createSessionMetricsReporter).
   */
  private emitSessionMetrics(): void {
    if (!this.negotiated.has("session.metrics")) return;
    const metrics: ProviderMetric[] = [];
    const usage = this.cumulativeUsage();
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cachedTokens = usage.cachedInputTokens ?? 0;
    if (inputTokens + outputTokens > 0) {
      metrics.push({ label: "Tokens", value: `${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out` });
      if (cachedTokens > 0 && inputTokens > 0) {
        metrics.push({ label: "Cache", value: `${Math.round((100 * cachedTokens) / inputTokens)}%`, tone: "ok" });
      }
    }
    const steps = this.stats?.steps;
    if (typeof steps === "number" && steps > 0) {
      metrics.push({ label: "Steps", value: String(Math.floor(steps)) });
    }
    const contextTokens = this.stats?.contextTokens ?? 0;
    const window = this.sessionWindowTokens();
    if (contextTokens > 0 && window) {
      metrics.push({
        label: "Context",
        value: `${formatTokens(contextTokens)} / ${formatTokens(window)}`,
        ...(contextTone(contextTokens / window) ? { tone: contextTone(contextTokens / window) } : {}),
      });
    }
    const cost = this.sessionCostUsd(usage);
    if (cost > 0) metrics.push({ label: "Cost", value: formatSessionCost(cost) });
    const signature = JSON.stringify(metrics);
    if (signature === this.metricsSignature) return;
    this.metricsSignature = signature;
    this.emit({ type: "session.metrics", sessionId: this.sessionId, metrics });
  }

  /**
   * SERVER-side resolution of a callback (§5.5: the "callback" entry moves to
   * answered/cancelled/expired WITHOUT a response from us — end-of-turn
   * expiry, model cancel, post-resume redelivery). Confirms daemon-side
   * (otherwise tile + spinner blocked), with the Paseo session memorized at
   * emission (root or child).
   */
  private resolvePendingCallback(entry: HistoryEntry | undefined): void {
    if (!entry || entry.type !== "callback") return;
    const callback = entry as CallbackHistoryEntry;
    if (!callback.callbackId) return;
    const stateType = (callback.state as { type?: string } | undefined)?.type;
    if (!stateType || stateType === "open") return;
    const record = this.openCallbacks.get(callback.callbackId);
    if (!record) return;
    this.openCallbacks.delete(callback.callbackId);
    this.emit({ type: "session.permission_resolved", sessionId: record.permissionSessionId, permissionId: callback.callbackId });
  }

  private onEntryAdded(entry: HistoryEntry | undefined, params: EventNotificationParams): void {
    if (!entry?.id) return;
    this.entries.set(entry.id, entry);
    this.resolvePendingCallback(entry);
    const item = this.timelineItemFor(entry, params);
    if (item) {
      this.emit({ type: "timeline.item", sessionId: this.sessionId, item, timestamp: baseTimestamp(entry, params) });
    }
  }

  private onEntryUpdated(entryId: string | undefined, patch: PatchOperation[] | undefined, params: EventNotificationParams): void {
    if (!entryId || !Array.isArray(patch)) return;
    let entry = this.entries.get(entryId);
    if (!entry) {
      // Never-seen entry (callback entries…): no reconstruction. We cannot
      // emit a coherent item without an initial state.
      return;
    }
    const updated = applyPatch(entry as unknown as Record<string, unknown>, patch);
    this.entries.set(entryId, updated as unknown as HistoryEntry);
    this.resolvePendingCallback(updated as unknown as HistoryEntry);
    const item = this.timelineItemFor(updated as unknown as HistoryEntry, params);
    if (item) {
      this.emit({ type: "timeline.item", sessionId: this.sessionId, item, timestamp: baseTimestamp(updated as unknown as HistoryEntry, params) });
    }
  }

  private onSessionUpdated(patch: PatchOperation[] | undefined): void {
    if (!Array.isArray(patch)) return;
    for (const op of patch) {
      if (op.op === "replace" && op.path === "/tokenUsage") {
        const usage = op.value as TokenUsage;
        if (usage && typeof usage === "object") this.tokenUsage = usage;
      }
    }
  }

  private onRuntimeUpdated(runtime: RuntimeSnapshot | undefined): void {
    if (!runtime?.config) return;
    const activeModel = runtime.config.activeModel;
    const agents = (runtime.agents ?? []).filter((agent) => agent.agentType === "agent");
    const options = (activeModel?.thinkingLevels ?? []).map((level) => ({ id: level, label: level.charAt(0).toUpperCase() + level.slice(1) }));
    this.approvalPolicy = runtime.activeApprovalPolicy?.name;
    // §6.3: runtime/updated carries "prices only" stats (tokens at 0) —
    // seed once; the full statsUpdated take over.
    if (!this.stats && runtime.stats) this.stats = runtime.stats;
    if (typeof runtime.contextWindow === "number" && runtime.contextWindow > 0) {
      this.compactionThresholdTokens = runtime.contextWindow;
    }
    this.modelWindowTokens = typeof activeModel?.maxContextLength === "number" && activeModel.maxContextLength > 0
      ? activeModel.maxContextLength
      : undefined;
    this.emit({
      type: "session.config",
      sessionId: this.sessionId,
      config: {
        model: activeModel?.alias,
        mode: runtime.activeAgent?.name,
        thinkingOption: activeModel?.thinking,
        models: (runtime.config.models ?? []).map((model) => toProviderModel(model, activeModel?.alias)),
        modes: agents.map((agent) => ({ id: agent.name, label: agent.displayName, description: agent.description })),
        thinkingOptions: options,
        providerOptions: runtime.activeApprovalPolicy ? { approvalPolicy: runtime.activeApprovalPolicy.name } : {},
        controls: [
          {
            type: "select",
            key: "approvalPolicy",
            label: "Approval policy",
            choices: (runtime.approvalPolicies ?? []).map((policy) => ({
              value: policy.name,
              label: policy.displayName,
              ...(policy.description ? { description: policy.description } : {}),
            })),
          },
        ],
      },
    });
    this.emitCommands(runtime.skills);
  }

  /** Initial runtime state: runtime/read (session backend, cf. §6.3). */
  private async readRuntime(): Promise<void> {
    const client = this.client;
    if (!client || !this.vibeSessionId) return;
    try {
      const result = await client.request<RuntimeReadResult>("runtime/read", {
        sessionId: this.vibeSessionId,
      }, 30_000);
      this.onRuntimeUpdated(result.runtime);
    } catch (error) {
      console.warn(`[vibe-provider] runtime/read failed: ${describe(error)}`);
    }
  }

  /**
   * Composer slash menu: every user-invocable vibe skill becomes a
   * ProviderCommand of kind "skill" (vibe's "prompts" — .vibe/prompts/*.md —
   * are system prompts, not commands; nothing maps to kind "command").
   * Signature cache: runtime/read (open) + runtime/updated (resume/config)
   * dedupe — no event spam.
   */
  private emitCommands(skills: SkillSummaryWire[] | undefined): void {
    const names = new Set<string>();
    const commands: ProviderCommand[] = [];
    for (const skill of skills ?? []) {
      if (!skill.name || names.has(skill.name)) continue;
      if (skill.userInvocable === false || skill.active === false || skill.enabled === false) continue;
      names.add(skill.name);
      commands.push({ name: skill.name, description: skill.description ?? "", kind: "skill" });
    }
    const signature = JSON.stringify(commands);
    if (signature === this.commandsSignature) return;
    this.commandsSignature = signature;
    this.emit({ type: "session.commands", sessionId: this.sessionId, commands });
  }

  /** Projection context of a session (root or child): tracked turns + todo
   * dedup slot (consecutive identical writes do not re-emit). */
  private rootTimelineContext(): { turns: Map<string, TrackedTurn>; todo: { signature: string | null } } {
    return { turns: this.turns, todo: this.todoState };
  }

  private timelineItemFor(entry: HistoryEntry, params: EventNotificationParams | undefined, ctx: { turns: Map<string, TrackedTurn>; todo: { signature: string | null } } = this.rootTimelineContext()): ProviderTimelineItem | null {
    void params;
    const revertToken = { entryId: entry.id };
    switch (entry.type) {
      case "message": {
        const message = entry as MessageEntry;
        const text = messageText(message);
        if (message.role === "user") {
          const trackedTurn = message.turnId ? ctx.turns.get(message.turnId) : undefined;
          return { type: "user_message", id: message.id, text, ...(trackedTurn?.clientMessageId ? { clientMessageId: trackedTurn.clientMessageId } : {}), revertToken };
        }
        if (message.role === "assistant") {
          return { type: "assistant_message", id: message.id, text, revertToken };
        }
        return null;
      }
      case "reasoning": {
        const reasoning = entry as ReasoningEntry;
        // B6: no streamed text but summaries (some backends do not stream
        // the thinking) → the text becomes the joined summaries.
        const hasText = typeof reasoning.text === "string" && reasoning.text.length > 0;
        const text = hasText
          ? reasoning.text
          : Array.isArray(reasoning.summary)
            ? reasoning.summary.map((line) => `• ${line}`).join("\n")
            : "";
        return { type: "reasoning", id: reasoning.id, text, revertToken };
      }
      case "effect": {
        const effect = entry as EffectEntry;
        // B5: submissions to the paseo.paseo_structured_output client tool have
        // their canonical item emitted at tools/call (metadata + value); the
        // native projection of their wire effect is discarded to avoid doubling.
        const toolName = effect.detail?.toolName ?? "";
        if (toolName.includes(STRUCTURED_OUTPUT_TOOL_NAME)) return null;
        // B6: the todo effect is NOT a tool_call — ProviderTimelineItem
        // of type "todo" with structured items (the Paseo UI renders a todo list).
        if (effect.detail?.kind === "todo") return this.todoItemFor(effect, ctx);
        const detail = toolCallDetail(effect.detail, effect.state);
        if (toolCallStatus(effect.state).status === "failed") {
          return { type: "tool_call", id: effect.id, callId: effect.id, name: effect.detail?.toolName ?? "tool", detail, status: "failed", error: { message: effect.state?.error?.message ?? "tool call failed" }, revertToken };
        }
        const status = toolCallStatus(effect.state).status;
        return { type: "tool_call", id: effect.id, callId: effect.id, name: effect.detail?.toolName ?? "tool", detail, status, error: null, revertToken };
      }
      default:
        return null;
    }
  }

  /**
   * B6: todo effect → ProviderTimelineItem "todo". The items' state lives in
   * `state.output.todos` (TodoEffectOutput: authoritative list set by the
   * projector at write completion) otherwise in `detail.input.todos` (write
   * submission, available as soon as the effect is added; a "read" carries
   * nothing there — its item goes out at completion). Wire statuses: pending |
   * in_progress | completed | cancelled (cancelled → completed:false without a
   * status: the Paseo enum does not know cancelled). Consecutive identical
   * writes → no re-emission (omp emitTodoItem pattern: daemon-side every
   * emitted todo item is a NEW card, not an upsert — cf. timelineItemIdentity
   * which only covers tool_call/plugin).
   */
  private todoItemFor(effect: EffectEntry, ctx: { turns: Map<string, TrackedTurn>; todo: { signature: string | null } }): ProviderTimelineItem | null {
    void ctx.turns;
    const inputTodos = todoItemsOf((effect.detail?.input as TodoEffectInputWire | undefined)?.todos);
    const outputTodos = todoItemsOf((effect.state?.output as { todos?: unknown } | undefined)?.todos);
    const todos = outputTodos.length > 0 ? outputTodos : inputTodos;
    if (todos.length === 0) return null;
    const signature = todos.map((todo) => `${String(todo.id ?? "")}|${String(todo.content ?? "")}|${todo.status ?? ""}`).join("\n");
    if (ctx.todo.signature === signature) return null;
    ctx.todo.signature = signature;
    return {
      type: "todo",
      id: effect.id,
      revertToken: { entryId: effect.id },
      items: todos.map((todo) => ({
        text: String(todo.content ?? ""),
        completed: todo.status === "completed",
        ...(typeof todo.id === "string" && todo.id ? { id: todo.id } : {}),
        ...(todo.status === "pending" || todo.status === "in_progress" || todo.status === "completed" ? { status: todo.status } : {}),
      })),
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Per-million price from the §4.5 snapshot: positive-finite, otherwise the fallback. */
function finitePrice(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Token delta of the turn (closed cumulative − cumulative before). */
interface TurnFootprint {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

function turnFootprint(turn: PublicTurn, start: TokenUsage, end: TokenUsage): TurnFootprint {
  const completedAt = typeof turn.completedAt === "number" ? turn.completedAt : Date.now();
  const startedAt = typeof turn.startedAt === "number" ? turn.startedAt : completedAt;
  const delta = (field: keyof TokenUsage): number => Math.max(0, (end[field] ?? 0) - (start[field] ?? 0));
  return {
    durationMs: Math.max(0, completedAt - startedAt),
    inputTokens: delta("inputTokens"),
    outputTokens: delta("outputTokens"),
    cachedTokens: delta("cachedInputTokens"),
  };
}

/** Zero footprint: conservative fallback when the turn was never seen starting. */
const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 };

/** Duration format of the daemon (providers/shared metrics.js), adopted as-is. */
function formatMetricDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms > 0 && ms < 50) return "<0.1s";
  if (ms < 600_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** 12345 → "12 345" (thin separator, readable in a UI line). */
function formatTokens(value: number): string {
  return Math.floor(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Daemon $ convention (formatMetricCost): <$0.001, 3 decimals < $1, 2 decimals above. */
function formatSessionCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.0005) return "<$0.001";
  return usd < 0.9995 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** Context occupancy tone: neutral < 80%, warning < 95%, danger beyond. */
function contextTone(ratio: number): "ok" | "warning" | "danger" | undefined {
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  if (ratio >= 0.95) return "danger";
  if (ratio >= 0.8) return "warning";
  return "ok";
}

/**
 * ProviderContent[] (Paseo) → TurnContentBlock[] (vibe §3.3).
 * - text → text block (also covers the Paseo text attachment, type "text"
 *   mimeType text/plain, which carries `text`).
 * - image → inline base64 attachment (cf. imageBlock).
 * - uploaded_file → text block "Attached file: <path>" (good enough for
 *   this batch).
 * - other attachments (forge_change_request, github_pr, …): if `text`
 *   present → text block; otherwise warn + skip.
 */
function translatePromptContent(content: ProviderContent[]): TurnContentBlock[] {
  const blocks: TurnContentBlock[] = [];
  let imageIndex = 0;
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image" && typeof part.data === "string") {
      blocks.push(imageBlock(part.data, part.mimeType, ++imageIndex));
    } else if (part.type === "uploaded_file" && typeof part.path === "string") {
      blocks.push({ type: "text", text: `Attached file: ${part.path}` });
    } else if (typeof (part as { text?: unknown }).text === "string") {
      blocks.push({ type: "text", text: (part as { text: string }).text });
    } else {
      console.warn(`[vibe-provider] prompt content part of type ${part.type} is not translatable yet, skipped`);
    }
  }
  return blocks;
}

/**
 * Structured-output guidance block (B5): appended to the turn text when the
 * prompt carries outputSchema. Modeled on the structured-output-plugin
 * opencode system push, adapted to vibe's exposure model: wire client tools
 * (§2.3 erratum) are programmatic — the model calls them from a
 * run_typescript program via tools.<namespace>.<name>, never as a direct
 * tool-call.
 */
function structuredGuidanceBlock(schema: JsonValue): string {
  return [
    "<paseo-structured-output>",
    "THIS TURN REQUIRES A STRUCTURED FINAL ANSWER — do not answer in plain prose.",
    "Complete the user's task, then submit the final answer by calling the client tool",
    `\`${STRUCTURED_OUTPUT_TOOL_QUALIFIED}\` inside a run_typescript program:`,
    "```typescript",
    "async function main() {",
    `  const result = await tools.${CLIENT_TOOL_NAMESPACE}.${STRUCTURED_OUTPUT_TOOL_NAME}({ value: { /* your complete final answer */ } });`,
    "  return result;",
    "}",
    "```",
    "`value` is your complete final answer and MUST satisfy this JSON Schema exactly:",
    JSON.stringify(schema, null, 2),
    "If the tool returns an error, your value was rejected: fix the reported problems and submit again.",
    "After the tool accepts your submission, end the turn immediately without additional text or tool calls.",
    "Do not write the final answer as an ordinary text message — only the tool submission counts.",
    "</paseo-structured-output>",
  ].join("\n");
}

/**
 * Inline image block (§3.3, verified in vibe/app_server/models.py:
 * ImageAttachment requires source+alias+mimeType, extra=forbid). Paseo `data`
 * is bare base64; any `data:` prefix is stripped and its mime reused when
 * mimeType is missing.
 */
function imageBlock(data: string, mimeType: string | undefined, index: number): TurnContentBlock {
  let payload = data;
  let mime = mimeType;
  if (data.startsWith("data:")) {
    const comma = data.indexOf(",");
    if (comma > 0) {
      const headerMime = data.slice(5, comma).split(";")[0];
      payload = data.slice(comma + 1);
      if (!mime) mime = headerMime;
    }
  }
  return {
    type: "image",
    attachment: {
      source: { kind: "inline", data: payload },
      alias: `image-${index}`,
      mimeType: mime || "image/png",
    },
  };
}

/** ProviderMcpServerConfig (Paseo) → SessionMcpServer (vibe, camelCase §6/phase4). */
function mapMcpServers(servers: Readonly<Record<string, ProviderMcpServerConfig>> | undefined): SessionMcpServer[] {
  const mapped: SessionMcpServer[] = [];
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (server?.type === "stdio") {
      const env = server.env && typeof server.env === "object"
        ? Object.fromEntries(Object.entries(server.env).filter(([, value]) => typeof value === "string"))
        : undefined;
      mapped.push({
        transport: "stdio",
        name,
        command: server.command,
        ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
        ...(env ? { env } : {}),
      });
    } else if (server?.type === "http" || server?.type === "sse") {
      const headers = server.headers && typeof server.headers === "object"
        ? Object.fromEntries(Object.entries(server.headers).filter(([, value]) => typeof value === "string"))
        : undefined;
      mapped.push({
        // Paseo "sse" = legacy MCP SSE; vibe speaks "streamable-http" (modern).
        transport: server.type === "sse" ? "streamable-http" : "http",
        name,
        url: server.url,
        ...(headers ? { headers } : {}),
      });
    } else {
      console.warn(`[vibe-provider] MCP server ${name}: type ${(server as { type?: string })?.type} not supported, ignored`);
    }
  }
  return mapped;
}

/** Paseo persistence (data.vibeSessionId) → vibe session id, the wire key. */
export function readPersistedSessionId(persistence: OpenSessionOptions["persistence"]): string | undefined {
  const id = (persistence?.data as { vibeSessionId?: unknown } | undefined)?.vibeSessionId;
  return typeof id === "string" && id ? id : undefined;
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && "message" in value) return String((value as { message: unknown }).message);
  return JSON.stringify(value)?.slice(0, 300) ?? "unknown error";
}

function approvalDecision(response: ProviderPermissionResponse): CallbackApprovalOutput["decision"]["type"] {
  if (response.behavior === "deny") {
    return response.interrupt === true ? "cancel_turn" : "deny";
  }
  return "approve";
}

function approvalAnswers(response: ProviderPermissionResponse): CallbackUserInputOutput["result"]["answers"] {
  const input = (response as ProviderPermissionResponse & { updatedInput?: { answers?: unknown[] } }).updatedInput ?? {};
  const answers = (input as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return [];
  return answers.map((answer) => {
    if (answer && typeof answer === "object") {
      const record = answer as Record<string, unknown>;
      return { question: record.question as string | undefined, answer: record.answer as string | undefined, isOther: Boolean(record.isOther) };
    }
    return { answer: String(answer) };
  });
}

function applyPatch(target: Record<string, unknown>, patch: PatchOperation[]): Record<string, unknown> {
  const clone = structuredClone(target);
  for (const op of patch) {
    const keys = pointerPath(op.path);
    if (!keys) continue;
    if (op.op === "append") {
      const current = pointerGet(clone, keys);
      if (typeof current === "string") pointerSet(clone, keys, current + String(op.value));
      else if (Array.isArray(current)) current.push(op.value);
      else if (current === undefined) pointerSet(clone, keys, op.value);
    } else if (op.op === "replace" || op.op === "add") {
      pointerSet(clone, keys, op.value);
    } else if (op.op === "remove") {
      pointerRemove(clone, keys);
    }
  }
  return clone;
}

function pointerPath(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  return path.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function pointerGet(target: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = target;
  for (const key of keys) current = (current as Record<string, unknown>)?.[decodeKey(key)];
  return current;
}

function pointerSet(target: Record<string, unknown>, keys: string[], value: unknown): void {
  let current: Record<string, unknown> = target;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = decodeKey(keys[index]);
    const next = current[key];
    if (!next || typeof next !== "object") current[key] = Number.isInteger(Number(keys[index + 1])) ? [] : {};
    current = current[key] as Record<string, unknown>;
  }
  current[decodeKey(keys[keys.length - 1])] = value;
}

function pointerRemove(target: Record<string, unknown>, keys: string[]): void {
  let current: Record<string, unknown> = target;
  for (let index = 0; index < keys.length - 1; index++) {
    current = current[decodeKey(keys[index])] as Record<string, unknown>;
    if (!current) return;
  }
  delete current[decodeKey(keys[keys.length - 1])];
}

function decodeKey(key: string): string {
  if (/^\d+$/.test(key)) return key;
  return key;
}
