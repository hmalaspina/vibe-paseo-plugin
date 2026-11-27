// Wire types (subset) — source of truth: docs/app-server-protocol.md (§2, §3.1, §6)
// Casing: camelCase on the wire; enums snake_case.

export interface ServerInfo {
  name: string;
  version: string;
}

export interface InitializeResult {
  serverInfo: ServerInfo;
  processId?: number;
  platformCredentials?: boolean;
}

// §2.1 — must be declared to receive the approvals (Phase 3).
// childSessionEvents: true (phase 4): streams child session events with
// their own sessionId, otherwise the server drops them.
//
// NB: client tools (tools/call) are NOT declared here but via handshake
// options (connection.handshake {clientTools}) — only for live session
// processes; ephemeral processes (catalog/probe/list/archive) keep this
// base. Cf. erratum §2.3.
export const VIBE_CLIENT_CAPABILITIES = {
  callbackKinds: ["approval", "user_input"],
  clientTools: [],
  sessionSpawn: false,
  sessionPeers: false,
  sessionPeerRestore: false,
  sessionPeerMarkSeen: false,
  agentWorktrees: false,
  agentProjects: false,
  childSessionEvents: true,
  disabledNotifications: [],
  agentPlugins: [],
  clientToolDefinitions: [],
} as const;

// ─── §2.3/§5bis Client tools (clientToolDefinitions + tools/call) ──────────
//
// Protocol erratum (verified on v3.1.4 + upstream main, _connection_protocol.py +
// _runtime.py configure_agent_plugins): the initialize wire has NO `modelAccess`
// field (ClientToolDefinitionParams extra="forbid") — definitions passed over
// the wire are ALWAYS model_access="programmatic" → "programmatic" exposure
// core-side: the model calls them from a run_typescript program via
// `tools.<namespace>.<name>`, never as a direct tool-call.
// Moreover the binding requires `agentPlugins:[{name,root}]` WITH a BUILTIN
// plugin of the same name materialized in the session (launch
// `--additional-builtin-plugin-root <dir>`), otherwise client_tool_groups_for
// silently drops the group.

/** Client tool submitted by paseo for prompt.output_schema (opencode pattern:
 * plugin-side ajv validation, the model retries on a tool error). */
export const STRUCTURED_OUTPUT_TOOL_NAME = "paseo_structured_output";
/**
 * Client tool namespace. Do NOT name it "paseo": the daemon injects an MCP
 * server named "paseo" (PASEO_MCP_SERVER_NAME) and vibe refuses namespaces
 * homonymous with a session MCP server (usage_error at session/start).
 */
export const CLIENT_TOOL_NAMESPACE = "paseo_host";
export const STRUCTURED_OUTPUT_TOOL_QUALIFIED = `${CLIENT_TOOL_NAMESPACE}.${STRUCTURED_OUTPUT_TOOL_NAME}`;

/** Generic inputSchema set at initialize: the value is validated at
 * tools/call against the active prompt's outputSchema (ajv). */
export const STRUCTURED_OUTPUT_INPUT_SCHEMA = {
  type: "object",
  properties: { value: {} },
  required: ["value"],
  additionalProperties: false,
} as const;

export const STRUCTURED_OUTPUT_DESCRIPTION =
  "Submit the final answer in the required structured format. " +
  "The `value` must satisfy the JSON Schema attached to the current turn's " +
  "structured-output request; an invalid value is rejected with the " +
  "validation errors so you can fix it and submit again.";

/** ClientToolDefinitionParams (_connection_protocol.py, camelCase wire). */
export interface ClientToolDefinitionWire {
  name: string;
  namespace: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
}

/** AgentPlugin (declares the "paseo" built-in plugin carrying the namespace). */
export interface AgentPluginWire {
  name: string;
  root: string;
}

/** ClientToolCallerParams — the calling session (vibe root or subagent). */
export interface ClientToolCallerWire {
  sessionId: string;
  rootSessionId: string;
  parentSessionId?: string | null;
  name?: string | null;
  agentType?: string | null;
}

/** ClientToolCallParams — server→client `tools/call` request. */
export interface ClientToolCallWire {
  callId: string;
  /** "namespace.name". */
  name: string;
  input: unknown;
  toolCallId: string;
  caller: ClientToolCallerWire;
}

/** ClientToolCallResponse — wire response: either output (annotations ≠ the
 * model's view), or error (tool error READ BY THE MODEL, retryable). */
export interface ClientToolResponseWire {
  output?: unknown;
  annotations?: Record<string, unknown>;
  error?: {
    message: string;
    code?: string | null;
    details?: unknown;
  } | null;
}

// §6.1 (phase4-wire-shapes.md §1) — SessionMCPServer (discriminated by transport)
export interface StdioMcpServer {
  transport: "stdio";
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
}

export interface HttpMcpServer {
  transport: "http" | "streamable-http";
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export type SessionMcpServer = StdioMcpServer | HttpMcpServer;

// Child sessions (phase4-wire-shapes.md §2) — PublicChildSession (subset)
export interface PublicChildSession {
  id: string;
  name?: string;
  agentType?: string;
  agentPath?: string;
  model?: JsonObject;
  status?: { type: string } & JsonObject;
  tokenUsage?: TokenUsage;
  contextUsage?: TokenUsage;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

// §6.1 — config/read
export interface ModelConfigView {
  name: string;
  alias: string;
  thinking: string;
  supportsImages: boolean;
  displayName: string;
  maxContextLength?: number;
  autoCompactThreshold?: number;
  thinkingLevels?: string[];
  imageDelivery?: string;
  source?: string;
}

export interface ConfigView {
  models: ModelConfigView[];
  activeModel?: ModelConfigView;
  activeModelPinned?: boolean;
  defaultModelAlias?: string;
  defaultAgent?: string;
  defaultApprovalPolicy?: string;
}

export interface ConfigReadResult {
  config: ConfigView;
}

// §6.2 — agents/list
export interface AgentSummary {
  name: string;
  displayName: string;
  description?: string;
  agentType: "agent" | "subagent";
}

export interface ApprovalPolicySummary {
  name: string;
  displayName: string;
  description?: string;
  safety: "safe" | "neutral" | "destructive" | "smart" | "yolo";
}

export interface AgentsListResult {
  active: AgentSummary;
  agents: AgentSummary[];
  activeApprovalPolicy: ApprovalPolicySummary;
  approvalPolicies: ApprovalPolicySummary[];
}

// §3.1 — session/start (subset; the real state is much larger)
export interface PublicSessionMinimal {
  id: string;
  status?: { type: string } & Record<string, unknown>;
  /** Session cumulative, cross-resume (patched afterwards by session/updated). */
  tokenUsage?: TokenUsage;
  [key: string]: unknown;
}

export type UnknownRecord = Record<string, unknown>;

/** models.py PublicSessionState (subset) — carried by session/start, rewind. */
export interface PublicSessionState {
  format?: string;
  /** Session sequence (wire eventId); absent on some snapshots. */
  eventId?: number;
  session: PublicSessionMinimal;
  history?: HistoryEntry[];
  turns?: UnknownRecord[];
  /** models.py PublicBackgroundProcess[] (wire camelCase), § lifecycle. */
  backgroundProcesses?: PublicBackgroundProcess[];
  [key: string]: unknown;
}

export interface SessionStartResult {
  state: PublicSessionState;
  lastEventId: number;
}

/** §4.4 resync — session/read {sessionId, history?, turns?} → {state, lastEventId}
 * (SessionReadResponse: PublicSessionState + watermark EventWatermarkResponse).
 * PageRequest: {cursor?, limit 1..500 (default 200), direction "forward"|"backward"}. */
export interface SessionReadResult {
  state: PublicSessionState;
  lastEventId: number;
}

// ─── §3.4-§3.5 Lifecycle: archive, list, rewind ─────────────────────────


/** models.py PublicBackgroundProcess — a process detached from a turn. */
export interface PublicBackgroundProcess {
  processId: string;
  command: string;
  status: "running" | "completed" | "failed" | "stopped" | "orphaned";
  exitCode?: number | null;
  createdAt: string;
}

/** models.py PublicSession (subset used by the §3.5 listing). */
export interface PublicSessionSummary {
  id: string;
  title?: string | null;
  preview?: string;
  status?: { type: string } & JsonObject;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number | null;
  cwd?: string | null;
  rootSessionId?: string | null;
  parentSessionId?: string | null;
  startedBySessionId?: string | null;
  [key: string]: unknown;
}

/** session/list → SessionListResponse (subset). */
export interface SessionListResult {
  items: PublicSessionSummary[];
  nextCursor?: string | null;
  previousCursor?: string | null;
}

/** session/archive → SessionArchiveResponse (subset). */
export interface SessionArchiveResult {
  archivedAt?: number | null;
  /** Only with includeStartedSessions (never requested here). */
  startedSessions?: JsonObject;
  [key: string]: unknown;
}

/**
 * session/rewind → SessionRewindReponse (§3.5, protocol.py l.1363):
 * `message` = the text of the rewound user message (the composer puts it
 * back), `state` = the POST-rewind state (inplace: same session, truncated
 * history).
 */
export interface SessionRewindResult {
  message: string;
  restoreErrors: string[];
  restoredPaths: string[];
  state: PublicSessionState;
  sessionLog?: JsonObject;
}

// §1 wire error: string codes (invalid_params, conflict, …).
export interface ProtocolErrorShape {
  code: string;
  message: string;
  data?: unknown;
}

export class VibeProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "VibeProtocolError";
  }
}

// ─── §3.3 Turns ────────────────────────────────────────────────────────────

export interface PublicTurn {
  id: string;
  sessionId?: string;
  status: "in_progress" | "completed" | "failed" | "interrupted";
  startedAt?: number;
  completedAt?: number;
  error?: { message?: string; code?: string } & Record<string, unknown>;
  stopReason?: "limit" | "length";
  budgetStopReason?: "token_limit" | "price_limit";
  inputEntryId?: string;
  [key: string]: unknown;
}

export interface TurnStartResult {
  turn: PublicTurn;
  lastEventId: number;
}

export interface TurnInterruptResult {
  accepted: boolean;
  lastEventId?: number;
}

// ─── §4 History & notifications ─────────────────────────────────────────

export type JsonObject = Record<string, unknown>;

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** §3.3 — ContentBlock[] written to the server (turn/start, turn/steer).
 * Shape verified in vibe/app_server/models.py: TextContentBlock |
 * ImageContentBlock(attachment: ImageAttachment); the attachment requires
 * `source` (discriminated by kind), `alias` AND `mimeType` (camelCase,
 * extra=forbid, without a default value). */
export type TurnContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      attachment: {
        source: { kind: "inline"; data: string };
        alias: string;
        mimeType: string;
      };
    };

export interface HistoryEntryBase {
  id: string;
  sessionId?: string;
  turnId?: string;
  inputEntryId?: string;
  createdAt?: number;
  updatedAt?: number;
  generationStatus?: "in_progress" | "completed";
  relatedEntryId?: string;
}

export interface MessageEntry extends HistoryEntryBase {
  type: "message";
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  source?: string;
  outcome?: JsonObject;
}

export interface ReasoningEntry extends HistoryEntryBase {
  type: "reasoning";
  text: string;
  summary?: string[];
}

export interface EffectEntry extends HistoryEntryBase {
  type: "effect";
  title?: string;
  detail: EffectDetail;
  state: EffectState;
  toolCallId?: string;
}

export interface CallbackHistoryEntry extends HistoryEntryBase {
  type: "callback";
  callbackId: string;
  title?: string;
  detail: JsonObject;
  state: JsonObject;
}

export type HistoryEntry =
  | MessageEntry
  | ReasoningEntry
  | EffectEntry
  | CallbackHistoryEntry
  | (HistoryEntryBase & { type: string });

/** todo kind: TodoEffectItem wire camelCase (vibe/app_server/_effect_models.py).
 * The current list lives in `detail.input.todos` (write submission) as soon
 * as the effect is added, then in `state.output.todos` (TodoEffectOutput,
 * set by the projector at completion) — statuses pending|in_progress|
 * completed|cancelled, never an activeForm. */
export interface TodoItemWire {
  id?: string;
  content?: string;
  status?: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "low" | "medium" | "high";
}

export interface TodoEffectInputWire {
  action?: string;
  todos?: TodoItemWire[] | null;
}

export interface EffectDetail {
  kind: string;
  toolName?: string;
  input?: JsonObject;
  display?: {
    summary?: string;
    content?: string;
    suffix?: string;
    verb?: string;
    message?: string;
    statusText?: string;
  };
  childSessionId?: string | null;
  /** worktree kind: progress patched in flight (naming|fetching|checking_out
   * phase; counts only set during checking_out). */
  progress?: { phase: string; completedFiles?: number | null; totalFiles?: number | null } | null;
  [key: string]: unknown;
}

export interface EffectState {
  status: "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled" | "skipped";
  output?: unknown;
  outputText?: string;
  durationMs?: number;
  error?: { message?: string; code?: string };
  reason?: string;
  callbackId?: string;
  decision?: JsonObject;
  [key: string]: unknown;
}

export interface EventNotificationParams extends JsonObject {
  eventId?: number;
  sessionId: string;
  emittedAt?: number;
  /** session/statsUpdated: stats + window (compaction threshold). */
  stats?: AgentStatsSnapshot;
  contextWindow?: number;
}

export interface PatchOperation {
  op: "add" | "append" | "replace" | "remove" | "test";
  path: string;
  value?: unknown;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

/**
 * §4.5 AgentStatsSnapshot — verified in vibe/app_server/models.py (snake_case
 * fields, wire camelCase, cf. tests/app_server/test_events.py): session
 * cumulative tokens (the same counters as PublicSession.tokenUsage, carried
 * by the events), active model prices per million (the initial runtime/read
 * carries ONLY the prices, tokens at 0), last call's context gauge, and the
 * last turn's figures.
 */
export interface AgentStatsSnapshot extends JsonObject {
  /** Agent steps of the current turn (apt ~ 1 per model call; resync/reset). */
  steps?: number;
  /** Counted model calls; null as long as none is measured (§ models.py). */
  modelCalls?: number | null;
  sessionPromptTokens?: number;
  sessionCompletionTokens?: number;
  sessionCachedTokens?: number;
  /** USD prices per million tokens (0.0 = unpriced model → zero cost). */
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  /** null → the cache is billed at the input price. */
  cachedInputPricePerMillion?: number | null;
  contextTokens?: number;
  lastTurnPromptTokens?: number;
  lastTurnCompletionTokens?: number;
  lastTurnCachedTokens?: number;
  /** Delivered as 0.0 by the Python backend (never filled) — unused. */
  lastTurnDuration?: number;
  tokensPerSecond?: number;
}

// §6.3 — SkillSummary (vibe/app_server/models.py + _projection.py): every
// skill of the slash menu. Verified: `userInvocable` (user-invocable
// front-matter, default true) hides the slash menu when false; `source` ∈
// builtin|local|registry|plugin, `scope` ∈ builtin|global|project|session;
// enabled/locked/active are set to true/false/true by _skill_summary() at
// execution. The skill body is `prompt` (String, not serialized by us — not
// needed).
export interface SkillSummary {
  name: string;
  description: string;
  prompt?: string;
  userInvocable?: boolean;
  source?: "builtin" | "local" | "registry" | "plugin";
  scope?: "builtin" | "global" | "project" | "session";
  registry?: { skillId: string; version: number; alias?: string | null } | null;
  enabled?: boolean;
  locked?: boolean;
  active?: boolean;
  path?: string | null;
  linked?: boolean;
}

// §6.3 RuntimeSnapshot (subset used). `stats` only carries the active
// model's prices there (tokens 0), `contextWindow` is the compaction
// threshold (_runtime.py: context_window=compaction_threshold).
export interface RuntimeSnapshot {
  config?: ConfigView;
  activeAgent?: AgentSummary;
  agents?: AgentSummary[];
  activeApprovalPolicy?: ApprovalPolicySummary;
  approvalPolicies?: ApprovalPolicySummary[];
  skills?: SkillSummary[];
  stats?: AgentStatsSnapshot;
  contextWindow?: number;
  [key: string]: unknown;
}

export interface RuntimeReadResult {
  runtime: RuntimeSnapshot;
  sessionLog?: JsonObject;
  ready?: boolean;
}

// ─── §5 Callbacks ──────────────────────────────────────────────────────────

export interface RequiredPermission extends JsonObject {
  scope: "command_pattern" | "outside_directory" | "file_pattern" | "url_pattern";
  invocationPattern?: string;
  sessionPattern?: string;
  label?: string;
}

export interface ApprovalCallbackDetail {
  kind: "approval";
  effect?: EffectDetail;
  requiredPermissions?: RequiredPermission[];
  choices?: string[];
  pathScopeChoices?: string[];
  relatedEntryId?: string | null;
  reason?: string | null;
}

export interface UserInputCallbackDetail {
  kind: "user_input";
  request?: {
    questions?: Array<{
      question?: string;
      header?: string;
      options?: Array<{ label?: string; description?: string }>;
      multiSelect?: boolean;
      hideOther?: boolean;
    }>;
    footerNote?: string | null;
  };
  relatedEntryId?: string | null;
}

export type CallbackDetail = ApprovalCallbackDetail | UserInputCallbackDetail | (JsonObject & { kind: string });

export interface PublicCallbackEntry extends HistoryEntryBase {
  type: "callback";
  callbackId: string;
  sessionId: string;
  turnId?: string;
  title?: string;
  detail: CallbackDetail;
  state: { type: string } & JsonObject;
}

export interface CallbackCallParams {
  callback: PublicCallbackEntry;
}

export type ApprovalDecisionType = "approve" | "approve_for_session" | "approve_permanently" | "deny" | "cancel_turn";

export interface CallbackApprovalOutput {
  type: "approval";
  decision: { type: ApprovalDecisionType; pathScope: "exact" | "directory_recursive" | null };
  feedback?: string | null;
}

export interface CallbackUserInputOutput {
  type: "user_input";
  result: {
    answers: Array<{ question?: string; answer?: string; isOther?: boolean }>;
    cancelled: boolean;
  };
}

