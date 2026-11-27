# `vibe-app-server` wire protocol — reference for the Paseo client

> **Source of truth**: reverse-engineering of the local source code
> a clone of the [mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe) repository (Python package `vibe/app_server/`).
> This protocol is not documented anywhere publicly; this document IS the
> reference. All method and field names below are **exact**
> (extracted from the code, not guessed) except where stated otherwise in section 7.
>
> Key files: `protocol.py` (all wire types + `SERVER_METHODS`),
> `server.py` (`AppServer`, the dispatch), `_connection_protocol.py`
> (capabilities), `models.py` (`PublicSessionState`, history entries),
> `events.py` (client-side notification reducer), `stdio.py` /
> `transport.py` (framing), `session.py` / `connection.py` /
> `client.py` (in-tree reference client).

---

## 1. Transport & framing

- The binary is `vibe-app-server` (declared in `pyproject.toml`:
  `vibe-app-server = "vibe.app_server.stdio:main"`; `entrypoint.py` also handles
  internal subcommands `--internal-posix-pty-helper` and
  `--internal-background-worker`).
- **JSON-RPC 2.0 over stdio, one JSON message per line** (no
  LSP-style `Content-Length`). Cf. `transport.py`:
  `json.dumps(message, separators=(",", ":")) + "\n"` on stdout, read
  line by line on stdin. No compression, no binary.
- **stdout is exclusively reserved for the JSON-RPC stream.** Logs go to
  `~/.vibe/logs/vibe.log` (init at startup, `stdio.py:main`). stderr carries
  only fatal bootstrap errors.
- **Case: camelCase on the wire.** All models derive from
  `ProtocolModel` (`_model.py`): `alias_generator=to_camel`,
  `serialize_by_alias=True`, `populate_by_name=True`. A Python
  `session_id` field is written `sessionId` on the wire. `StrEnum` enums are
  serialized in **lowercase snake_case** (`auto()` → lowercase member
  name: `in_progress`, `invalid_request`, `approve_permanently`, ...).
- **Strictness: `extra="forbid"`** — an unknown field in a
  client→server request `params` is rejected (`invalidParams`). However
  `ClientCapabilities` has `extra="ignore"` (unknown capabilities tolerated).
- Message shapes:

```jsonc
// Client→server request
{"jsonrpc":"2.0","id":"client-1","method":"session/start","params":{...}}
// Client→server notification (no id)
{"jsonrpc":"2.0","method":"initialized","params":{}}
// Success response
{"jsonrpc":"2.0","id":"client-1","result":{...}}
// Error response (the "error" field replaces "result")
{"jsonrpc":"2.0","id":"client-1","error":{"code":"invalid_params","message":"Invalid request parameters","data":{"errorCount":1,"issues":[{"path":["sessionId"],"message":"Field required"}]}}}
// Server→client request (id is ALWAYS an integer on the server side)
{"jsonrpc":"2.0","id":3,"method":"callback/call","params":{...}}
// Server→client notification
{"jsonrpc":"2.0","method":"turn/completed","params":{...}}
```

- **IDs**: client→server, int or string of your choice (the in-tree client
  uses `"client-1"`, `"client-2"`, ...); server→client they are
  **sequential integers** (`self._next_request_id`), and the client's
  responses to the server **must** relay the integer as-is (otherwise
  `JsonRpcProtocolError`). A response to an unknown id is a fatal
  connection error for the server.
- **Error codes: strings, not integers** (`ProtocolErrorCode`,
  StrEnum, `protocol.py`): `invalid_request`, `invalid_params`,
  `not_initialized`, `not_found`, `conflict`, `stale_turn`, `not_steerable`,
  `callback_closed`, `compaction_failed`, `unauthorized`, `forbidden`,
  `method_not_found`, `not_implemented`, `stale_cursor`, `internal_error`.
  `data` is `null` or an object; for `invalid_params` it contains
  `{"errorCount": int, "issues": [{"path": [...], "message": str}]}`.
- `ProtocolError` wire: `{"code": "...", "message": "...", "data": ...}`.
- **End of stream**: EOF on stdin terminates the server (sessions remain
  persisted, the turn in progress is marked "interrupted" at the next
  re-attach). SIGTERM is treated as EOF (`end_on_sigterm`). The `session/stop`
  request (§3) makes the server respond then **close the connection cleanly**.
- `events/read` exists but is a **stub**: it always responds with an empty
  batch (`EventBatch{type:"events",events:[]}`, server.py `_events_read`) —
  there is **no server replay**. The client must maintain its state from
  the notifications + `session/read`.
- The `multiplex.py` module adds a `vibe-app-server --multiplex` variant:
  each line becomes `{"channelId":"123","message":<jsonrpc>}` (with
  `"message":null` to close the channel; cf. §7) — useful to drive N
  sessions over a single process.

---

## 2. `initialize` handshake

Imposed order: **`initialize` request → (response) → `initialized` notification**
→ everything else. Any request before initialize fails with
`not_initialized` ("initialize must be the first request"); `initialize`
twice → `invalid_request` ("initialize may only be called once"). Only
client→server notifications accepted: `initialized` and
`platformCredentials/invalidated` (if capability) — any other client
notification is a protocol error.

### 2.1 Request

```jsonc
// {"method":"initialize","params":{...}} with:
{
  "clientInfo": {
    "name": "paseo",                  // required
    "version": "1.0.0",               // required
    "title": null,                     // optional
    "entrypoint": "programmatic",      // required: "cli" | "acp" | "desktop" | "programmatic" | "unknown"
                                       //   (type AgentEntrypoint, vibe/utils/__init__.py)
    "terminalEmulator": "unknown"      // TerminalEmulator enum (vibe/utils/terminal.py); "unknown" ok
  },
  "capabilities": {                     // ClientCapabilities, extra="ignore"
    "callbackKinds": ["approval", "user_input"],   // Literal "approval" | "user_input" | "connector_auth"
    "clientTools": [],                  // Literal "filesystem/read" | "filesystem/write" | "terminal" | "tools/call"
    "sessionSpawn": false,             // accept server session/spawn requests
    "sessionPeers": false,
    "sessionPeerRestore": false,
    "sessionPeerMarkSeen": false,
    "agentWorktrees": false,
    "agentProjects": false,
    "clientToolDefinitions": [],        // [{name, namespace, description, inputSchema, outputSchema?}] — ERRATUM §2.3: NO modelAccess on the wire (extra="forbid" on the item); exposure ALWAYS programmatic; binding requires agentPlugins + a builtin plugin of the same name (cf. §2.3)
    "childSessionEvents": false,        // stream child-session events
    "disabledNotifications": [],        // names of notifications not to send
    "platformCredentials": null,        // {version:1, kind:"oauth_access_token"|"oidc_id_token"}
    "agentPlugins": []                  // [{name, root}] — requires "tools/call" in clientTools
  },
  "account": {                          // optional: the connection's "owner"
    "organizationId": "...", "workspaceId": "...", "userId": "..."
  }
}
```

For a minimal Paseo provider: `callbackKinds: ["approval","user_input"]`
(mandatory, otherwise the server refuses to deliver approvals — see
`_deliver_callback`: `RuntimeError("Client does not support {kind}
callbacks")`) and nothing else. The reference client `connection.py` sends
`initialize` then `notify("initialized")`.

### 2.2 Response

```jsonc
{
  "serverInfo": { "name": "vibe-app-server", "version": "..." },
  "processId": 12345,
  "platformCredentials": false   // true iff platformCredentials was declared
}
```

`InitializeResponse` does **not** contain a list of supported methods
(the `EXPERIMENTAL_SERVER_METHODS` docstring is misleading): detect
`method_not_found` at runtime. The exact server version is in
`serverInfo.version` (useful for feature-gating). No notification is
emitted spontaneously between `initialize` and `initialized`.

### 2.3 Capabilities — what they trigger

| Server→client capability | Effect if true |
|---|---|
| `callbackKinds` | Delivery of `callback/call` (approval / user_input / connector_auth) |
| `clientTools` | The server can make `clientTool/readTextFile`, `clientTool/writeTextFile`, `clientTool/terminal/{create,wait,output,kill,release}` requests |
| `clientToolDefinitions` / `agentPlugins` | The server calls the client's tools via the server→client method **`tools/call`** (+ `tools/cancel {callId}` notification on abort); response `{output, annotations, error?{message,code,details}}`; requires `"tools/call"` in `clientTools` — cf. erratum B5 below |
| `sessionSpawn` | The server can send the **`session/spawn`** request (params `SessionSpawnParams`) to ask the client to open a child session |
| `sessionPeers` / `sessionPeerRestore` / `sessionPeerMarkSeen` | Server requests `session/peer/{list,read,send,archive,restore,markSeen}` |
| `childSessionEvents` | Child-session events are streamed too (`session/childSessionUpdated`) |
| `platformCredentials` | The server can send the **`platformCredentials/resolve`** request `{audience,minimumValidityMs,rejectedRevision?}` → response `{status:"ready",kind,token,audience,expiresAt,revision,...}` or `{status:"unavailable",reason:"missing"\|"reauthentication_required"\|"transient"\|"invalid"\|"unauthorized_after_refresh"}` |

#### Erratum B5 — the truth about client tools on the wire (v3.1.4 + upstream main, verified by test)

1. **`modelAccess` does NOT exist on the wire**:
   `ClientToolDefinitionParams`
   (_connection_protocol.py) has only
   `{name, namespace, description, inputSchema, outputSchema}` and the item is
   `extra="forbid"` — passing `modelAccess` makes `initialize` fail
   (`invalid_params`). The `model_access` concept ("direct"|"programmatic"|"both")
   exists only on the embedding side (`ClientToolDefinition`,
   _client_provided_tools.py) and on the experimental agent-socket
   (`vibe -p --agent-socket`, _agent_socket.py).
2. **Programmatic exposure by default**: `_runtime.configure_agent_plugins`
   (called at initialize) builds `ClientToolDefinition` WITHOUT
   `model_access` → default `"programmatic"` → core exposure
   `"programmatic"`: the model CANNOT call the tool in a direct tool-call;
   it calls it from a `run_typescript` program via
   `tools.<namespace>.<name>` (cf. the core sandbox doc, "tool_use":
   "Tool functions are available under `tools.<group>.<function>`").
   The only required counterpart: the runtime builtins
   (`run_typescript`, `search_tool_functions`) active — by default.
3. **The binding requires a materialized builtin plugin**: a definition's
   namespace must be the name of an `agentPlugins:[{name,root}]`, AND that plugin
   must be resolved with `scope=BUILTIN` in the session
   (`client_tool_groups_for`/`bound_client_plugin_names`, _runtime.py) —
   otherwise the group is silently DROPPED and no `tools/call` ever
   arrives. The path is `--additional-builtin-plugin-root <dir>` (CLI
   argument of `vibe-app-server`, stdio.py: `<dir>` contains
   `<namespace>/plugin.json`, an agent-plugins.org 1.0.0 manifest — cf.
   `vibe-provider/agent-plugin/paseo/`). `ClientCapabilities` itself is
   `extra="ignore"`, but not the definition items.
4. **`initialize` REFUSES definitions without a plugin**:
   `configure_agent_plugins` → `ValueError("Client tools require a declared
   Agent Plugin")` (namespace ∉ agentPlugins) and `"Client tools require
   tools/call"` if the capability is missing — hence the trio
   `clientTools:["tools/call"]` + `agentPlugins` + `clientToolDefinitions`.
5. **Server timeout**: 600 s (`CLIENT_TOOL_TIMEOUT_SECONDS`) per call;
   beyond → tool error `client_tool_timeout`. A JSON-RPC error response
   (−32xxx) instead of the result becomes a tool error
   `client_tool_unavailable` READ BY THE MODEL (the model can retry) — the
   clean channel for a business rejection is the `error` field in the RESULT.
6. **`tools/call` shapes** (server→client request, expected response) —
   verified e2e B5:
   ```jsonc
   // S→C: ClientToolCallParams (camelCase, validated by ClientToolCallResponse on the response side)
   {"jsonrpc":"2.0","id":7,"method":"tools/call","params":{
     "callId":"client_tool:<action-id>",      // unique per call
     "name":"paseo.paseo_structured_output",  // "<namespace>.<name>"
     "input":{"value":<JsonValue>},           // the definition's inputSchema
     "toolCallId":"<core tool-call id>",
     "caller":{"sessionId":"<calling session (vibe root or child)>",
               "rootSessionId":"<root>", "parentSessionId":null,
               "name":null, "agentType":null}}}
   // C→S: ClientToolCallResponse — `output` = result READ BY THE MODEL,
   //        `annotations` = for session readers (not the model),
   //        `error` = TOOL error read by the model (retry):
   {"jsonrpc":"2.0","id":7,"result":{"output":"Final structured answer accepted. …","annotations":{}}}
   // or {"result":{"error":{"message":"Invalid structured output: …","code":"invalid_output","details":{"errors":[…]}}}}
   ```
   `tools/cancel {callId}` is a NOTIFICATION without id (server abort;
   no response expected). A call can come from a vibe child session
   (`caller.sessionId` = the child): plugin-side we attach the submission to
   the root's active structured turn.

NB: `sessionSpawn` (table row) remains true but is not implemented
by the Paseo provider at this stage — cf. `connection.ts` (response −32601).

---

## 3. Session lifecycle

**Key model: one connection = ONE attached root session.** The server has a
single `self._root` (`SessionBackend`). All session-scoped methods
require a session to be attached; otherwise
`conflict`: *"Start, resume, or continue a session before using this
method"*. The `sessionId` is present in the params of every session method
(for robustness), but routing happens on the attached session.
→ **One `vibe-app-server` process per Paseo conversation** (or `--multiplex`).

### 3.1 Opening: `session/start`

```jsonc
{"method":"session/start","params":{
  "agentConfig": { ...AgentConfig, see 3.1.1 },
  "historyLimit": 200,           // 1..500, default 200
  "idempotencyKey": null,         // optional str
  "kind": "normal",               // "normal" | "ephemeral" (ephemeral = picker, not counted)
  "project": null,                // optional {kind:"local"|"cloud", id}
  "title": null,                   // optional str (min 1)
  "model": null,                  // optional alias, applied before the 1st turn
  "reasoningEffort": null,        // optional thinking level
  "sessionOnly": false,           // true = does not write the user default
  "firstTurn": null,               // {message:[ContentBlock], clientUserMessageId?}: starts a turn
  "startedBySessionId": null,
  "spawnedBySessionId": null,
  "hops": null
}}
// → SessionStartResponse
{"state": { ...PublicSessionState }, "lastEventId": 0}
```

#### 3.1.1 `AgentConfig` (= `SessionOptions`, the "session options")

Fields (all optional; camelCase on the wire):
`completion` (`{type:"mistral", model:"mistral-small-latest"}`),
`sandbox` (free-form dict), `instructions` (str), `workdir` (str; **never an
empty string**), `tools` (`[{type:"client_tool",name,description,inputSchema,outputSchema}]`),
`hooks`, `cwd` (non-empty str), `workspaceRoots` ([str]), `worktree`
(`{kind:"existing"| "auto" | "create", ...}`), `agent` (profile name),
`approvalPolicy` (str), `autoApprove` (bool), `enabledTools`, `disabledTools`,
`maxTurns`, `maxPrice`, `maxSessionTokens`, `headless`, `trustWorkspace`,
`mcpServers`, `terminalKey`, `systemPrompt` (non-blank if present).

For Paseo: `{"cwd": "/chemin/du/repo", "trustWorkspace": true, "agent": "..."}` etc.
`session/resume` takes the same `agentConfig` (it is re-applied).

#### 3.1.2 `PublicSessionState` (returned everywhere)

```jsonc
{
  "format": "vibe.public-session-state/v1",
  "eventId": 47,                    // watermark of THIS session's events
  "session": { /* PublicSession */ },
  "isQuiescent": null,
  "history": [ /* PublicHistoryEntry, cf. §4 */ ],
  "historyBeforeCursor": null,
  "turns": [ /* PublicTurn */ ],
  "activeCallbacks": [ /* open PublicCallbackEntry */ ],
  "childSessions": [ /* PublicChildSession */ ],
  "backgroundProcesses": [],
  "turnQueue": {"items": [], "paused": false, "maxItems": 32, "editing": null},
  "retrying": null                  // PublicRetryState ratelimit|server_error|timed_out
}
```

`PublicSession`: `id`, `rootSessionId?`, `parentSessionId?`,
`startedBySessionId?`, `owesReply`, `title?`, `preview`, `status`, `createdAt`,
`updatedAt`, `bumpedAt`, `pinnedAt?`, `archivedAt?`, `isUnseen`, `cwd?`,
`workspaceRoots`, `worktree?{name,branch,path,created}`, `model?`,
`reasoningEffort?`, `agent?`, `approvalPolicy?`, `tokenUsage?`,
`contextUsage?`, `harness?`("legacy"|"unified"), `loops`, `goal?`, `project?`.
`status` is a union discriminated by `type`:
`{"type":"idle"}` | `{"type":"running","activeTurnId":...}` |
`{"type":"blocked","activeTurnId":...,"callbackId":...,"reason":...}` |
`{"type":"failed","message":...}` | `{"type":"archived"}`.

### 3.2 Re-attaching: `session/resume`, `session/continue`

```jsonc
{"method":"session/resume","params":{
  "sessionId": "<id>",             // sessions persisted on disk, cf. 3.6
  "agentConfig": { ... },
  "historyLimit": 200,
  "interruptLeftTurn": false        // true = ends as "interrupted" the turn
                                    // left "running" (killed process) instead of resuming it
}}
// → SessionResumeResponse {"state":..., "lastEventId": N}

{"method":"session/continue","params":{ "agentConfig":{...}, "historyLimit":200 }}
// → SessionContinueResponse: resumes the last eligible session for cwd/terminalKey
```

After `resume`/`continue` the server sends **`runtime/updated`** (cf. §6.3)
and, if a turn was still running when the previous process died,
re-announces **`turn/started`** BEFORE any callbacks (internal 5 s delay).
Notifications are held during the attach then flushed
in order.

> **Erratum validated e2e (B2)** — `runtime/updated` is emitted **only after
> resume/continue** (and after dispatched config writes, `server.py`
> `_dispatch_backend_lifecycle`), **never after `session/start`**: a
> fresh session has no initial runtime frame. The client seeds via
> **`runtime/read {sessionId}`** (session backend method, cf. §6.3) —
> that is what the in-tree Rust TUI does ("Authoritative first-frame values
> from runtime/read"). `skills/list`, on the other hand, is a **host**
> method that REJECTS sessionIds (list by cwd, without an attached
> session): for the per-session menu, `runtime/read`/`runtime/updated`.skills
> is the only source.

### 3.3 Prompt & streaming: `turn/start` (then notifications, §4)

```jsonc
{"method":"turn/start","params":{
  "sessionId": "...",
  "message": [ {"type":"text","text":"Explique ce repo"} ],   // ContentBlock[]:
                   // {"type":"text","text":str}
                   // {"type":"image","attachment":{source:{kind:"file",path}|{kind:"inline",data:<raw base64, no data:>}, alias, mimeType}}
                   //   ⚠ erratum (verified in models.py): `alias` and `mimeType`
                   //   are REQUIRED (pydantic ImageAttachment without a default,
                   //   extra=forbid; `mime_type` → camelCase `mimeType`) and
                   //   live at the attachment level, not the source.
                   // {"type":"resource","resource":{...UserResource}}
  "idempotencyKey": null,       // UUID recommended (idempotent replay)
  "injected": false,
  "clientUserMessageId": null,  // free id chosen by the client, comes back in events
  "autoTitle": null,
  "userDisplayContent": null,
  "mentionStats": null
}}
// → TurnStartResponse {"turn": {...PublicTurn}, "lastEventId": N}
```

A multi-turn conversation = one `turn/start` request per user message;
each turn hands control back when finished (`turn/completed` + up-to-date
`state` via the notifications). **Part** streaming arrives via
`history/entryAdded` / `history/entryUpdated` notifications (§4).

> **Erratum validated e2e (B2)** — skill invocation: no mention block and no
> `mentionStats` required; the wire is a **simple turn whose text**
> carries `/name args` at the start (slash command) or `/name` in a
> mention outside code (`_skill_invocation.py::invoked_skill_names`,
> casefold, unknown names or `user_invocable:false` → nothing). The
> Unified adapter appends the skill body to the user message in a
> `<skill_content name="…">…</skill_content>` block
> (`core/tools/builtins/skill.py`).
> `mentionStats` is a UI autocomplete stat, not an invocation mechanism.

**`turn/steer`**: `{sessionId, expectedTurnId, message, clientUserMessageId?,
injectInvokedSkill, mentionStats?}` → `{accepted:true, lastEventId}` — injects
a message into the running turn (`not_steerable` / `stale_turn` rejection).

**`turn/interrupt`**: `{sessionId, expectedTurnId}` →
`{accepted:true, lastEventId}`. Error responses to tolerate:
`stale_turn`, or `conflict` with message `"No active turn"` /
`"No matching active turn"`.

`PublicTurn`: `id`, `sessionId`, `status` (`in_progress` | `completed` |
`failed` | `interrupted`), `inputEntryId?`, `startedAt`, `completedAt?`,
`error?{message,code?,details?}`, `stopReason?` (`limit` | `length`),
`budgetStopReason?` (`token_limit` | `price_limit`), `queueItemId?`,
`skipReason?`, `rejectReason?`. Turn error codes (`TurnErrorCode`):
`rate_limit` (the retry arrives via the `turn/retrying` notification),
`context_too_long`,
`response_to_long`, `refusal`, `invalid_image_attachment`,
`images_not_supported`, `compaction_failed`, `incomplete_stream`,
`backend_error`, `invalid_model`, `invalid_api_key`, `internal_error`,
`usage_limit`, `pricing_unavailable`, `credential_unavailable`.

**Queue** (a substitute for `turn/start` when a turn is running):
`session/turn/enqueue` `{sessionId, entries:[{role:"user"|"context",
content:[...], entryId?, annotations?}], idempotencyKey?}` →
`{queueItemId, waits?, turnId?}`; associated methods
`session/turn/queue/{read,remove,replace,steer,resume}` and
`session/turn/queue/edit/{start,save,cancel,abandon}`; the queue's
state arrives as a `turn/queueUpdated` notification (payload
`PublicTurnQueue`) and is also in `state.turnQueue`.

### 3.4 Closing: `session/stop`

```jsonc
{"method":"session/stop","params":{"sessionId":"...","reason":null}}
// → {"closed": true}
```
The response goes out, then the server **closes the connection and the
process shuts down** (gracefully). Nothing else to do (next: EOF). Let the
running turn finish first if needed (`turn/interrupt`). Other cleanup:
`session/delete` `{sessionId}` (destroys the persisted session),
`session/archive` `{sessionId, archived, requireIdle?, includeStartedSessions?}`
→ `{archivedAt: ms|null, startedSessions?}` (Host operator: works
**without an attached session**, on the stored session; archiving reveals
a `busy` conflict only with `requireIdle:true`).

### 3.5 Reading without attaching / listing

- **`session/read`** `{sessionId, history?:{cursor?,limit?,direction?}, turns?:{...}}`
  → `{state, lastEventId}` — also works **without an attached session**
  (the Host reads the stored session). This is the resync mechanism (§4.4).
- **`session/list`** `{cursor?, limit?(1..500, default 50), rootSessionId?,
  parentSessionId?, cwd?, cwds?, pinned?, includeArchived?, owesReply?,
  sessionIds?, interrupted?}` → `{items:[PublicSession], nextCursor?,
  previousCursor?}`. `interrupted:true` lists sessions with a turn left
  "running" (dead process) — offer them on resume.
- `session/history/list` `{sessionId, turnId?, page?}` →
  `{items:[PublicHistoryEntry], nextCursor?, previousCursor?}` ;
  `session/history/get` `{sessionId, historyLimit?}` ;
  `session/turns/list` for past turns.
- `session/history/clear` `{sessionId}` (handoff `session/contextCleared`),
  `session/compact` `{sessionId, extraInstructions}` (handoff
  `session/compacted`),
  `session/rewind` `{sessionId, entryId, restoreFiles?, inplace?}`
  (non-inplace = **fork**, new session id), `session/fork`
  `{idempotencyKey?, sourceSessionId, entryId?, agentConfig?, afterTurnId?,
  historyLimit?, attach?}`.

> **Erratum validated e2e (B4)** — `session/rewind`: precise params/response
> (protocol.py `SessionRewindParams/Response`): `{sessionId, entryId,
> restoreFiles:false by default, inplace:false by default}`. The anchor
> MUST be a **user** message (NOT_FOUND otherwise). Response `{message
> (text of the rewound message), restoreErrors:[], restoredPaths:[], state:
> PublicSessionState, sessionLog}` — `state` is the **post-rewind** state
> (with `eventId`). `inplace:true` keeps the session id (backend operator
> `_rewind`), adds a `type:"checkpoint"` entry
> `checkpoint-rewind-<entryId>` at the end of the history, emitted as a
> `history/entryAdded` notification right after the response (plus a
> `session/updated` `updatedAt`). `inplace:false` goes through the Host
> `rewind_fork` (the connection re-attaches to the new session; the
> fork's ghost stays in the store). Rewind requires a "settled" session
> (`_require_settled`: an active turn → `conflict`) — interrupt first,
> then retry while the backend reaps the lingering task.

> **Erratum validated e2e (B4)** — `session/list`: Host operator (works
> **without an attached session**, ephemeral process OK). `PublicSession`
> (the subset used for import): `{id, title?|null, preview:"", status,
> createdAt, updatedAt, bumpedAt?|null, pinnedAt?|null, archivedAt?|null,
> cwd?|null, rootSessionId?|null, parentSessionId?|null,
> startedBySessionId?|null, …}`. Without `includeArchived:true`, archived
> sessions are excluded; `cwd` filters by strict equality of the resolved
> paths (`_session_cwd_matches_any`), not by prefix. Vibe's internal
> subagents appear in the listing (`parentSessionId`/`startedBySessionId`
> set) — the importable "roots" are those without a parent or a starter.
- Metadata: `session/rename` `{sessionId,title}`;
  `session/relocate` `{sessionId, cwd}`; `session/pin` `{sessionId, pinned}`;
  `session/markAsSeen`; `session/move` `{sessionId, project:{kind:...}}`.

### 3.6 Persistence

- The journal lives in **`$VIBE_HOME/logs/session/`** (default
  `~/.vibe/logs/session/`, cf. `vibe/core/paths/_vibe_home.py`:
  `SESSION_LOG_DIR = VIBE_HOME / "logs" / "session"`), one folder per
  session `<prefix>-<shortId>` containing `meta.json` + `messages.jsonl`
  (`sessionLogging.save_dir` / `session_prefix` can be configured).
- The session is **persisted as soon as a turn runs** (SessionKind.NORMAL);
  the session `id` is an opaque UUID identifier (the folders use a
  short id). Re-attaching = starting a new `vibe-app-server` process then
  `initialize` → `session/resume {sessionId}` (the `agentConfig` params
  are re-applied on the fly).
- On a crash/restart, the running turn is left `running` on
  disk: the client detects it via `session/list {interrupted:true}` and
  ends it cleanly with `session/resume {interruptLeftTurn:true}` — or
  lets it continue. A lease lock (`session/lease/subscribe`,
  `session/lease/{updated,ended}` notifications) exists for
  multi-process.

---

## 4. Turn notifications → timeline

All these notifications are
`{"jsonrpc":"2.0","method":"<m>","params":{...}}` objects. Every session
event's params inherit from **`EventNotificationParams`**:
`{eventId:int, sessionId:str, emittedAt:int(ms epoch)}` — **`eventId` is
strictly consecutive per session** (server: `_sequence_notification`
increments a per-session watermark).

Table (exact names confirmed in `_parse_event_params` of `events.py`,
the harness adapter, and server.py):

| Wire method | Params (beyond eventId/sessionId/emittedAt) | Content |
|---|---|---|
| `session/snapshot` | `state: PublicSessionState` | complete state replacement |
| `session/updated` | `patch: [JsonPatchOperation]` | RFC6902-ish patch on `state.session` (`op: add\|append\|replace\|remove\|test`) |
| `history/entryAdded` | `turnId?`, `entry: PublicHistoryEntry` | new entry (message, reasoning, effect...) |
| `history/entryUpdated` | `turnId?`, `entryId`, `patch: [JsonPatchOperation]` | patch on the entry, streaming included |
| `turn/started` | `turn: PublicTurn` | |
| `turn/completed` | `turn: PublicTurn` | settles the turn (status/stopReason/error) |
| `turn/queueUpdated` | `queue: PublicTurnQueue` | |
| `turn/retrying` | `category` (`rate_limited`\|`server_error`\|`timed_out`), `detail` | no eventId |
| `session/statsUpdated` | `stats: AgentStatsSnapshot`, `contextWindow:int` | |
| `session/childSessionUpdated` | `childSession: PublicChildSession` | (if `childSessionEvents`) |
| `session/compacted` | `oldSessionId`, `state`, `sessionLog`, `summaryLength` | **handoff**: replace the whole state |
| `session/contextCleared` | `oldSessionId`, `state`, `sessionLog` | same handoff |
| `artifacts/created` / `artifacts/updated` | `artifact: PublicSessionArtifact` | detected PR/MR |
| `warning` | `warning: PublicError` | non-fatal warning |
| `error` (derived from ServerError — no direct emission seen yet; class `ServerErrorParams`) | `error: PublicError` | cf. §7 |
| `runtime/updated` | `sessionId`, `runtime: RuntimeSnapshot` | after resume/config switch, cf. §6.3 |
| `config/changed` | (empty) | if `config/subscribe` was called |
| `session/lease/updated` / `session/lease/ended` | — | session lease |
| `imports/updated`, `storage/usage/updated`, `mcp/authUrl`, `connector_catalog/authRequired` | — | outside Paseo v1 scope |

### 4.1 `PublicHistoryEntry` (discriminated by `type`)

Common base: `id`, `sessionId`, `turnId?`, `inputEntryId?`, `createdAt`,
`updatedAt`, `generationStatus` ("in_progress"|"completed"),
`relatedEntryId?`.

- `type:"message"`: `role` ("system"|"user"|"assistant"), `content:[ContentBlock]`
  (cf. 3.3), `source?` ("turn_start"|"turn_steer"|"harness"),
  `outcome?` (`{type:"committed"}` or `{type:"discarded",cause}`).
- `type:"reasoning"`: `text` (the streamed thinking), `summary:[str]`,
  `outcome?`.
  **This is where the reasoning arrives**, not in a separate event.
- `type:"effect"`: a tool call. `title`, `detail: EffectDetail`,
  `state: EffectState`, `toolCallId?`.
- `type:"callback"`: cf. §5. `callbackId`, `title`, `detail`, `state`.
- `type:"checkpoint"` and `type:"notice"` (hooks/goal notices) also exist.

### 4.2 `EffectDetail` (discriminated by `kind`, StrEnum)

All have `toolName` and `display:{summary, content?, suffix, verb, message?,
statusText}`. `kind` ∈ `tool` (free-form JSON input), `shell`
(`input.command`, output via state), `file_edit`, `file_search`, `file_read`,
`todo`, `file_write`, `user_question`, `web_search`, `web_fetch`, `skill`,
`subagent` (`input:{task,agent}`, `childSessionId?`, `agentName?`),
`worktree`, `process`, `scratchpad`.

`EffectState` (discriminated by `status`): `pending` |
`running` (`outputText`) | `blocked` (`callbackId`) |
`completed` (`output`, `outputText`, `durationMs`, `display`,
`decision?`, `approvalType?("always"|"never"|"ask")`,
`approvalSource?("config"|"smart"|"user"|"bypass"|"never")`) |
`failed` (+`error:PublicError`) | `cancelled` (+`reason`) | `skipped`
(+`reason`).

> **Validated by e2e probe (v3.1.4)** — real shapes observed:
> - `file_write`: `detail.input = {filePath, content}` (camelCase! not
>   `path`), `display.summary = "Writing temp.txt"`.
> - `shell`: `detail.input = {command}`; in the `completed` state,
>   `state.output` is an **object** `{stdout, stderr, output, truncated}`
>   (text display goes through `state.outputText` or `stdout`).
> - `toolName` is **namespaced**: `file_system.bash`.
> - The patterns judged safe by the policy (e.g. `echo`) execute
>   **without a callback** (`approvalType:"always"`,
>   `approvalSource:"config"`); only the `ask` ones trigger
>   `callback/call`.
> - The `callback` entry carries `inputEntryId` = the turn's
>   `clientUserMessageId`, and `relatedEntryId` points to the blocked
>   `effect` entry.
> - `callback/call` → ack → `callback/result {approve}`: the effect
>   resumes with `approvalSource:"user"`. The full flow was verified
>   live.
> - Replaying a persisted session with `history:"skip"` makes the dead
>   turn visible via `session/list {interrupted:true}` (not tested at
>   the probe).

> **Erratum validated e2e (B6)** — `EffectDetail` shapes of the remaining
> kinds (verified in `vibe/app_server/_effect_models.py` + the projectors,
> wire camelCase, extra=forbid):
> - **`todo`**: `detail.input = {action:"read"|"write", todos?:
>   [{id, content, status:"pending"|"in_progress"|"completed"|"cancelled",
>   priority:"low"|"medium"|"high"}]|null}`. The write carries its list
>   from the effect's addition; at completion the projector sets
>   `state.output = TodoEffectOutput = {todos:[… same shape]}` — the
>   authoritative list. A `read` carries nothing in input (plugin-side
>   item = at completion). `summary` = "Writing N todos" (write) /
>   "Reading todos" (read).
> - **`worktree`** (`toolName:"worktree"`, `_worktree_effects.py`):
>   DURING creation, `detail.input` is ABSENT and only
>   `detail.progress
>   = {phase:"naming"|"fetching"|"checking_out", completedFiles?, totalFiles?}`
>   is patched; a resolved worktree carries `detail.input = {name,
>   branch, path}`
>   (+ quirk: the output stays empty BY DESIGN — "the branch and path
>   are already in detail.input, and the runner renders a completed
>   effect's output as raw JSON without one").
> - **`process`**: `detail.input` = free-form JSON of the executed
>   process —
>   `process.start`: `{command, cwd?, env?}`; `stop`/`output`:
>   `{processId}`; the completed output wraps `_ProcessOutputEnvelope
>   {toolName:"process.start"|"process.stop"|"process.output",
>   processId?, status?, exitCode?}`.
> - **`scratchpad`**: input discriminated by `action` —
>   `{action:"list"}` |
>   `{action:"read", path}` | `{action:"write", path, content}` ;
>   completed output `{path?, content?, files:[… names]}` (a list
>   returns only files).
> - **`user_question`**: `detail.input` = the `UserQuestionRequest` of §5
>   (multiSelect questions/options… wire camelCase) — the effect goes
>   `blocked` on its callback, then completed with the answers.
> - **`session/read`** (§3.5/§4.4): `history`/`turns` are
>   `PageRequest {cursor?, limit 1..500 (default 200), direction
>   "forward"|"backward" (default backward)}` — without a cursor, the
>   backward page returns the LAST 500 entries/turns.

### 4.3 Streaming of a turn (typical observed order)

1. `turn/start` response → `turn.status="in_progress"`, then a
   `turn/started` notification.
2. `history/entryAdded` with the user entry (a single one,
   `inputEntryId`).
3. For each reasoning: `history/entryAdded` (`type:"reasoning"`,
   `generationStatus:"in_progress"`) then `history/entryUpdated` with
   `{"op":"append","path":"/text","value":"..."}` (custom `append` op).
4. For each assistant message: same via
   `history/entryAdded` `type:"message"` → `append` patches on
   `/content/0/text`; the entry moves to `generationStatus:"completed"`
   (`replace` patch), with `outcome` once the turn is committed.
5. Each tool: `history/entryAdded` `type:"effect"` (`state:"pending"`),
   patches to `running` (`replace` op on `/state/...` + `append` on
   `/state/outputText`), then for approval → **callback** (§5), then
   `completed`/`failed`. A `blocked` effect references the `callbackId`.
6. `turn/completed` (final status, `error?`, `stopReason?`), followed by
   `session/updated` (tokenUsage, etc.) and `session/statsUpdated`.

> **Erratum validated e2e (B4)** — step 2 (the user message's
> `history/entryAdded`) is **not reliable beyond the first turn**: the
> turn-1 pre-response batch carries it, but the following turns receive
> NO entryAdded for the user message (the entry is still persisted:
> visible on resume). The plugin must synthesize the user timeline item
> from the prompt (id = `clientUserMessageId`, which vibe promotes to
> the entry's id — verified in the store), idempotently (skipped if the
> wire entry is already there, overwritten if it eventually arrives).

> **Verified in code (B4)** — **root** `session/snapshot` notification:
> the root only receives one on a change not expressible as a patch
> (`_translate_snapshot_update`: `retrying`, `backgroundProcesses`,
> `loops`, `goal`); the snapshot carries the complete state, including
> `backgroundProcesses: [{processId, command, status: "running"|
> "completed"|"failed"|"stopped"|"orphaned", exitCode?|null, createdAt}]`
> (models.py `PublicBackgroundProcess`) — the source for "can we stop
> the runtime?" (`session/backgroundProcess/{output,stop}` also exist,
> §7).

The streaming paths listed by the client-side reduction
(`events.py:_STREAMING_TEXT_PATHS`): `/content/0/text`, `/text`,
`/state/outputText` — the `append` op semantically means "concatenate".

### 4.4 Continuity & resync

The official client maintains `lastEventId` per session. If a received
`eventId` ≠ `lastEventId+1` (gap), or an inconsistent `sessionId`: **call
`session/read {sessionId}`** and replace the state with `response.state`
(`event_id` included), then continue. An `EventSequenceError` exception
triggers a `session/read` in `session.py:_resync`. `history/entryUpdated`
and `session/updated` are patches to apply to the local objects — but
resync by complete snapshot is always available.

### 4.5 Usage / tokens

`session/statsUpdated.params.stats` (`AgentStatsSnapshot`): among others
`sessionPromptTokens`, `sessionCompletionTokens`, `sessionCachedTokens`,
`contextTokens`, `lastTurnPromptTokens`, `lastTurnCompletionTokens`,
`lastTurnDuration`, `tokensPerSecond`, prices per million,
`tool_calls_*` counters. `PublicSession.tokenUsage` /
`contextUsage` (`{inputTokens,outputTokens,totalTokens,cachedInputTokens}`)
are patched by `session/updated`.

> **Erratum validated e2e (B3)** — pricing shape verified in
> `vibe/app_server/models.py` + `tests/test_events.py` (wire camelCase):
> `AgentStatsSnapshot` carries the **active model's** prices via
> `inputPricePerMillion: float (0.0)`, `outputPricePerMillion: float (0.0)`
> and `cachedInputPricePerMillion: float | null` — `null` ⇒ the cache is
> billed at the input price. The official cost formula is
> `vibe/utils/pricing.py session_token_cost`:
> `cached = min(cached_tokens, prompt_tokens)`;
> `cost = ((prompt-cached)×in + cached×(cachedPrice ?? in) +
> completion×out) / 1e6` — applied to the pricing-only seed of
> `runtime/read.stats` (0 tokens), to the `session/statsUpdated` events
> (cumulative counters — same values as `PublicSession.tokenUsage`, cf.
> `_advance_stats`) and to the subagents (`costUsd` of
> `session/subagents/read`). Other fields: `steps` (agent steps,
> incremented approximately per batch — a user message already counts
> as 1), `modelCalls` (`null` before the first measured call);
> the statsUpdated's `params.contextWindow` is the **compaction
> threshold** (≥ `RuntimeSnapshot.context_window`, e.g. 400,000 for
> mistral-large-4-0) and NOT the model window, which is
> `config.activeModel.maxContextLength` (e.g. 1,048,576). The
> `lastTurn*` fields are the deltas of the **last measured call** (reset
> on every snapshot that spends), not of the whole turn;
> `lastTurnDuration` and `tokensPerSecond` stay at `0.0` — never filled
> by the Python backend.
> Verified by probe: mistral-large-4-0 ⇒ $0.7/M in, $2.1/M out, $0.07/M
> cached (exactly reproduces the `cost_usd` of the phase 0 report).

---

## 5. Callbacks: approvals & user_input

### 5.1 Delivery (server → client)

The server sends a **JSON-RPC request** (a response is expected):

```jsonc
{"jsonrpc":"2.0","id":7,"method":"callback/call","params":{
  // CallbackCallParams
  "callback": { /* PublicCallbackEntry, discriminated by type:"callback" */
    "id": "...", "sessionId": "...", "turnId": "...",
    "createdAt": 0, "updatedAt": 0, "generationStatus": "in_progress",
    "callbackId": "cb-...",         // ← response key
    "title": "Approval needed",
    "detail": { ...discriminated by kind, cf. 5.2 / 5.3 },
    "state": {"type":"open"}
  }
}}
```

**Step 1 — immediate ack** (always):

```jsonc
{"jsonrpc":"2.0","id":7,"result":{"callbackId":"cb-...","accepted":true}}
```
`accepted:false` counts as a delivery refusal (the server rejects the
callback). The `id` must be the integer received, and `callbackId` must be
**exactly the one from the params** (verified by
`validate_callback_acknowledgement`). If the client answers with a JSON-RPC
error, the server considers the callback rejected.

**Step 2 — business response**: a new client→server request:

```jsonc
{"jsonrpc":"2.0","id":"client-9","method":"callback/result","params":{
  "sessionId": "...",                     // the callback's session
  "result": {                              // CallbackResult
    "callbackId": "cb-...",
    "output": { ...CallbackOutput, cf. 5.2/5.3 },   // OR "error": {message, code?, details?}
  }
}}
// → {"accepted": true, "lastEventId": N}      // CallbackResultResponse
```

The open callback is also visible in the state (`PublicCallbackEntry`,
the effects' `state.blocked`) and the `type:"callback"` history entry
moves from `{"type":"open"}` to `{"type":"answered","output":...}` /
`{"type":"cancelled","reason":...}` / `{"type":"expired","reason":...}`
via `history/entryUpdated`.

### 5.2 Approval (`detail.kind:"approval"`)

```jsonc
"detail": {
  "kind": "approval",
  "effect": { /* the tool call's EffectDetail */ },
  "requiredPermissions": [ {   // RequiredPermission
      "scope": "command_pattern",  // "command_pattern"|"outside_directory"|"file_pattern"|"url_pattern"
      "invocationPattern": "...", "sessionPattern": "...", "label": "..."
  } ],
  "choices": ["approve","approve_for_session","approve_permanently","deny","cancel_turn"],
  "pathScopeChoices": ["exact","directory_recursive"],  // if paths outside cwd
  "relatedEntryId": null, "reason": null   // smart-approve reason
}
```

Response (`output`):

```jsonc
{"type":"approval","decision":{"type":"approve","pathScope":null},"feedback":null}
```
`decision.type` ∈ `approve` | `approve_for_session` | `approve_permanently` |
`deny` | `cancel_turn`. If `pathScopeChoices` is non-empty **and** paths are
involved: `pathScope` ∈ `exact` | `directory_recursive` (a choice not
offered fails). Without paths, leave `pathScope` at `null`.
`feedback`: optional free text.

### 5.3 User input (`detail.kind:"user_input"`)

```jsonc
"detail": {
  "kind": "user_input",
  "request": {              // UserQuestionRequest (vibe/questions.py)
    "questions": [ {
      "question": "Quelle base ?",
      "header": "DB",                  // <= 20 chars
      "options": [ {"label":"Postgres","description":"..."}, ... ], // >= 2
      "multiSelect": false,
      "hideOther": false
    } ],
    "footerNote": null
  },
  "relatedEntryId": null
}
```

Response:

```jsonc
{"type":"user_input","result":{
  "answers": [ {"question":"Quelle base ?","answer":"Postgres","isOther":false} ],
  "cancelled": false      // true = the user cancelled (answers may be [])
}}
```

### 5.4 `connector_auth`

Cf. `_forward_connector_authorization`: leads to
`connector_catalog/authRequired` notifications + an OAuth flow (login
via `mcp/login`/`connector_catalog/...`). Outside Paseo v1 scope — declare
the kind only if you want to handle it, otherwise omit it from
`callbackKinds`.

### 5.5 Robustness points to remember

- Callbacks not delivered during the attach are **redelivered** after the
  next `resume` (`_redeliver_open_callbacks`); do not ignore them twice.
- `disabledNotifications` never cuts session events or
  `callback/call` (requests do not go through `_route_notification`,
  and events always traverse it: the filter
  `method in disabled_notifications and not isinstance(params,
  EventNotificationParams)` excludes them from the exclusion). It only
  cuts the "top-level" notifications: `runtime/updated`, `config/changed`,
  `imports/updated`, `storage/usage/updated`, etc.
- If the connection dies with an open callback, the server rejects the
  callback (`_reject_callback`) — Paseo-side: re-resume to recover the
  `blocked` state.
- **Deterministic MCP tool names in approvals** (validated by the B8
  driver, v3.1.4): the `effect.toolName` of an MCP tool approval callback
  is `{group}.{tool}` where group = `mcp_{segment(server)}` (names
  normalized by `_mcp_naming.py`: non-`[A-Za-z0-9_$]` characters → `_`,
  a leading `_` if the tool name starts with a digit; digests only in
  the case of homonym collisions) — e.g. server `mcpServers["demo"]` +
  tool `echo` → `mcp_demo.echo` (title `"Approve mcp_demo.echo"`). The
  completed effect's state carries
  `_meta.approval {approvalSource, approvalType:"ask", decision:"execute"}`.
  The default `accept-edits` policy asks (PROMPT) for **every** MCP tool.

---

## 6. Catalog & config

> **Erratum validated by probe (v3.1.4)** — routing of the "optional"
> methods:
> `_SESSION_OPTIONAL_METHODS` = {`agents/list`, `config/read`,
> `skills/list`, `workspace/trust/decision`} (server.py
> `_omits_session_id`).
> - **Without** `sessionId` in the params → the request goes to the
>   **host handler** (no attached session needed; `config/read` then
>   honors `cwd`).
> - **With** a `sessionId` and an attached session → the request goes
>   to the **session backend**, which does not implement them →
>   `method_not_found`.
> - `agents/list` accepts **only** `sessionId` (no `cwd` —
>   `invalid_params`).
>
> The catalog is therefore done without a session: `initialize` →
> `config/read {cwd}` + `agents/list {}` → close. Zero LLM calls.
> Validated by spike/probe-catalog.mjs (2 models, default/explore
> agents, ask/accept-edits/auto-approve policies).

### 6.1 Models & thinking levels

- **`config/read`** `{sessionId?, cwd?}` → `{config: ConfigView, ...}`.
  `ConfigView.models`: a list of `ModelConfigView`
  `{name, alias, thinking, supportsImages, displayName, maxContextLength?,
  autoCompactThreshold?, thinkingLevels:[ThinkingLevel], imageDelivery?,
  source?, requires?{kind:"higher_plan"}}`. This is THE picker source:
  alias = the identifier to use in `TurnStart`/`config/model/write`.
  Also: `activeModel` (ModelConfigView), `activeModelPinned`,
  `defaultModelAlias`, `defaultAgent`, `defaultApprovalPolicy`.
- **ThinkingLevel**: a constrained free string (pattern); canonical
  values `THINKING_LEVELS = ("off","low","medium","high","xhigh","max")`
  (`vibe/config_values.py`); per model, `thinkingLevels` lists what is
  actually supported.
- `config/effective/read` reads a session's effective config; the
  `RuntimeSnapshot.runtime` (`runtime/updated` notification) contains
  everything: `config (ConfigView)`, `activeAgent`, `agents`,
  `activeApprovalPolicy`, `approvalPolicies`, `skills`, `tools`, `stats`,
  `contextWindow`, `issues`, `hooksCount`, `connectors`, `mcp`,
  `bypassToolPermissions`.

> **Erratum validated e2e (B2)** — exact shape of `runtime.skills`
> (`SkillSummary`, camelCase, `models.py` + `_projection.py`):
> `{name, description, prompt, userInvocable, source
> ("builtin"|"local"|"registry"|"plugin"), scope ("builtin"|"global"|
> "project"|"session"), registry|null, enabled, locked, active}` — at
> execution `_skill_summary` sets `enabled:true, locked:false,
> active:true`; `userInvocable:false` (front-matter `user-invocable`)
> hides the skill from the slash menu. Local skills live in
> `.vibe/skills/<name>/SKILL.md` (+ `.agents/skills/`), YAML front-matter
> `name`+`description` required, and `name` must match the folder name.
> ⚠ Vibe's "prompts" (`.vibe/prompts/*.md`, `GLOBAL_*_PROMPTS_DIR`)
> are **system prompt** files (resolved by id for `system_prompt_id`
> via `core/prompts/__init__.py::load_prompt`), NOT slash-commands:
> nothing in vibe maps to Claude's "prompts", and the skills cover the
> whole slash menu. No wire `argument-hint`: the `argument-hint`
> front-matter of Claude/Codex imports is explicitly "UI metadata not
> exposed by Vibe CLI" (`core/plugins/_foreign.py`).

### 6.2 Agents & policies

- **`agents/list`** `{sessionId?}` → `AgentsListResponse`:
  `{active: AgentSummary, agents: [AgentSummary],
  activeApprovalPolicy: ApprovalPolicySummary, approvalPolicies: [...]}`
  (`AgentSummary = {name, displayName, description,
  agentType:"agent"|"subagent"}` ;
  `ApprovalPolicySummary = {name, displayName, description,
  safety:"safe"|"neutral"|"destructive"|"smart"|"yolo"}`).
- Agent profiles are **TOML** files discovered in
  `~/.vibe/agents/*.toml` (global) and `<project>/.agents/*.toml` /
  `.vibe/agents` (project) — cf. `vibe/core/paths/_local_config_files.py`
  + `_agent_types.py`.
  (To re-verify at the spike for the exact path depending on the
  version.)
- Switching to "a given agent" mode: `session/agent/update`
  `{sessionId, agentName}` (a policy name is tolerated there =
  pre-split compatibility); changing policy:
  `session/approvalPolicy/update` `{sessionId, approvalPolicy}`.
  Both respond `RuntimeMutationResponse`
  `{runtime: RuntimeSnapshot, status: "applied"|"pending"}` + an
  `runtime/updated` notification if applied. The `agentConfig.agent` /
  `approvalPolicy` parameter of `session/start`/`resume` establishes the
  initial choice (resume **re-pins** it).
- `session/settings/update` `{sessionId, maxTurns?, maxTokens?}`.

### 6.3 Mid-session changes

- **`config/model/write`** `{sessionId, modelAlias?, reasoningEffort?,
  sessionOnly?}` → response
  `{runtime: RuntimeSnapshot, status: "applied"|"pending",
  strippedHistoryImages: int, rejected: bool, failures: [str], ...}`
  (`ConfigWriteResponse`). `status:"pending"` = a turn is running, the
  pick takes effect at its end and arrives as a `runtime/updated`
  notification (cf. `_runtime_resources.write_model`).
  This is "pick model + thinking without waiting for idle" — the
  switch is announced by **`runtime/updated`** (payload
  `RuntimeSnapshot`) and `session/updated`.
- **`runtime/read`** `{sessionId}` → `{runtime: RuntimeSnapshot,
  sessionLog: SessionLogSummary, ready: bool}`: on demand, what
  `runtime/updated` pushes.
- `config/write` `{sessionId, ops:[{op:"set"|"remove", path:"/...",
  value?, targetLayer?}], reason?, reloadRuntime?}` — rejected during a
  turn.
- `config/reload` re-reads the user/project files.
- `config/subscribe` → a `config/changed` notification on any config
  settings/catalog change (listen, then re-run `agents/list` etc.).

### 6.4 Useful special actions

- `session/compact` `{sessionId, extraInstructions?}` → compaction
  (handoff notification `session/compacted`), the response contains the
  summary directly.
- `session/context/inject` `{sessionId, input:[ContentBlock], asMessage?,
  injectInvokedSkill?, clientUserMessageId?, mentionStats?}`.
- `narration/summarize` (turn summary), `review/state`/`review/hunks`
  (turn diff), `feedback/record`, `telemetry/record` — see protocol.py
  for the params if needed.

---

## 7. Unknowns / to verify at the spike

1. **`error` notification**: the `ServerErrorParams` class exists
   (`{error: PublicError}`) but I could not find a `method="error"`
   emitted with certainty in the unified adapter. To observe at the
   spike (safest: do not implement, rely on `PublicTurn.error`).
2. **Low-level JSON-RPC errors**: if the server receives a
   non-JSON/invalid message client→server, it raises
   `InvalidJsonRpcMessage` (the connection dies). The exact behavior on
   a missing `params` param is unconfirmed (the `Notification` model
   requires it; always send `"params":{}`).
3. **Exact discovery path of the agent TOML profiles** (§6.2): probable
   but not guaranteed (project `.agents/` vs `~/.vibe/agents`). The
   spike will drop a TOML and list via `agents/list`.
4. **`--multiplex`**: implemented (`multiplex.py`), frames
   `{"channelId":"N","message":...}`, `open` reserved for
   `vibe run-server` (requires `agentSocket`), `channelId` regex
   `^[1-9][0-9]{0,15}$`, close = `"message":null`. **Untested** — for
   Paseo v1, prefer one process per session; multiplex remains an
   optimization lead.
5. **Exact order of `turn/started` vs `runtime/updated` after resume**
   and the callback replay: described from the code
   (`_wait_for_running_announcement`, 5 s timeout before sending anyway)
   — to validate on a real trace.
6. **Fields omitted by `exclude_if`** — several fields are omitted when
   empty/falsy (e.g. `hops` omitted if 0): the client must tolerate
   missing optionals (this is ADR 0014 design, additive tolerance);
   but **emitting** unknown fields is forbidden. Recommended frame
   Node-side: only send fields explicitly listed here.
7. **Approvals `pathScope`**: this doc derives from
   `_approval_permissions.py`; verify at the spike the
   `directory_recursive`-omitted case when there is a single path (the
   code then returns just `[EXACT]`... confirm the wire rendering).
8. **`callback/call` kinds vs `state.blocked`**: an effect can be
   `blocked` WITHOUT a `callback/call` going out if the kind is not in
   the `callbackKinds` → always declare `["approval","user_input"]`.
9. **`session/read` params `history`/`turns` PageRequest**: there are
   particular server-side validations `history_limit`/`turns_limit` —
   the exact behavior of `direction:"forward"` is unverified.
10. **The `vibe-app-server` of the pyPI package `mistral-vibe`**: the
    server version influences the optional fields (ADR 0014: "old
    clients tolerated"); check `InitializeResponse.serverInfo.version`
    and feature-gate on reading the responses (tolerant), never on
    emission.
11. The **subsystems running in the background** (worktrees, imports,
    storage) emit optional notifications: silently ignore any unknown
    method (the server may add some; the official client does it via
    `UnknownNotificationError`).
12. `TurnStartResponse` contains `turn` AND `lastEventId`; do NOT rely
    on the responses alone for streaming (all the events arrive as
    notifications) — `lastEventId` serves as the watermark's lower
    bound.

---

## 8. Minimal transcript (exact skeleton)

Scenario: initialize → open session → send a prompt → receive the
streaming → responses. `C→S` = the client writes a line on stdin,
`S→C` = the server writes a line on stdout. Client ids in `client-N`.

```jsonc
// ── 1. C→S: initialize
{"jsonrpc":"2.0","id":"client-1","method":"initialize","params":{
  "clientInfo":{"name":"paseo","version":"0.1.0","entrypoint":"programmatic","terminalEmulator":"unknown"},
  "capabilities":{"callbackKinds":["approval","user_input"],"clientTools":[],
                  "sessionSpawn":false,"sessionPeers":false,"sessionPeerRestore":false,
                  "sessionPeerMarkSeen":false,"agentWorktrees":false,"agentProjects":false,
                  "childSessionEvents":false,"disabledNotifications":[],
                  "agentPlugins":[],"clientToolDefinitions":[]}
}}

// ── 2. S→C: response
{"jsonrpc":"2.0","id":"client-1","result":{
  "serverInfo":{"name":"vibe-app-server","version":"<x.y.z>"},
  "processId":12345,"platformCredentials":false
}}

// ── 3. C→S: initialized notification (empty params required)
{"jsonrpc":"2.0","method":"initialized","params":{}}

// ── 4. C→S: session opening (Paseo project cwd)
{"jsonrpc":"2.0","id":"client-2","method":"session/start","params":{
  "agentConfig":{"cwd":"/chemin/du/projet","trustWorkspace":true},
  "historyLimit":200
}}

// ── 5. S→C: initial state (shorthand — the real response is a complete PublicSessionState)
{"jsonrpc":"2.0","id":"client-2","result":{
  "state":{"format":"vibe.public-session-state/v1","eventId":0,
    "session":{"id":"sess-1234-…","status":{"type":"idle"},"tokenUsage":null, …},
    "turnQueue":{"items":[],"paused":false,"maxItems":32,"editing":null}},
  "lastEventId":0
}}

// ── 6. C→S: prompt
{"jsonrpc":"2.0","id":"client-3","method":"turn/start","params":{
  "sessionId":"sess-1234-…",
  "message":[{"type":"text","text":"Résume l'architecture de ce repo en 5 bullets."}],
  "idempotencyKey":"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
  "clientUserMessageId":"paseo-msg-1"
}}

// ── 7. S→C: turn response (before streaming)
{"jsonrpc":"2.0","id":"client-3","result":{
  "turn":{"id":"turn-…","sessionId":"sess-1234-…","status":"in_progress",
          "inputEntryId":null,"startedAt":1770000000000,"completedAt":null},
  "lastEventId":2
}}

// ── 8. S→C: notification stream (typical excerpt — the concrete eventIds
//         may differ, only +1 continuity per session is guaranteed)
{"jsonrpc":"2.0","method":"turn/started","params":{"eventId":1,"sessionId":"sess-1234-…","emittedAt":1770000000000,"turn":{...idem...}}}
{"jsonrpc":"2.0","method":"history/entryAdded","params":{"eventId":2,"sessionId":"sess-1234-…","emittedAt":1770000000001,"turnId":"turn-…",
  "entry":{"type":"message","role":"user","id":"entry-u1","sessionId":"sess-1234-…","turnId":"turn-…",
    "createdAt":1770000000001,"updatedAt":1770000000001,"generationStatus":"completed",
    "content":[{"type":"text","text":"Résume l'architecture de ce repo en 5 bullets."}] ,"source":null,"outcome":null}}}
{"jsonrpc":"2.0","method":"history/entryAdded","params":{"eventId":3,"sessionId":"sess-1234-…","emittedAt":1770000000010,"turnId":"turn-…",
  "entry":{"type":"reasoning","id":"entry-r1","sessionId":"sess-1234-…","turnId":"turn-…",
    "createdAt":1770000000010,"updatedAt":1770000000010,"generationStatus":"in_progress","text":"","summary":[]}}}
{"jsonrpc":"2.0","method":"history/entryUpdated","params":{"eventId":4,"sessionId":"sess-1234-…","emittedAt":1770000000011,"turnId":"turn-…",
  "entryId":"entry-r1","patch":[{"op":"append","path":"/text","value":"Le repo est organisé en 3 couches…"}]}}
{"jsonrpc":"2.0","method":"history/entryAdded","params":{"eventId":5,"sessionId":"sess-1234-…","emittedAt":1770000000020,"turnId":"turn-…",
  "entry":{"type":"message","role":"assistant","id":"entry-a1","sessionId":"sess-1234-…","turnId":"turn-…",
    "createdAt":1770000000020,"updatedAt":1770000000020,"generationStatus":"in_progress",
    "content":[{"type":"text","text":""}],"source":"turn_start","outcome":null}}}
{"jsonrpc":"2.0","method":"history/entryUpdated","params":{"eventId":6,"sessionId":"sess-1234-…","emittedAt":1770000000021,"turnId":"turn-…",
  "entryId":"entry-a1","patch":[{"op":"append","path":"/content/0/text","value":"1. `vibe/app_server` …"}]}}
{"jsonrpc":"2.0","method":"history/entryUpdated","params":{"eventId":7,"sessionId":"sess-1234-…","emittedAt":1770000000022,"turnId":"turn-…",
  "entryId":"entry-a1","patch":[{"op":"replace","path":"/updatedAt","value":1770000000022},{"op":"replace","path":"/generationStatus","value":"completed"}]}}
{"jsonrpc":"2.0","method":"session/updated","params":{"eventId":8,"sessionId":"sess-1234-…","emittedAt":1770000000023,
  "patch":[{"op":"replace","path":"/tokenUsage","value":{"inputTokens":812,"outputTokens":344,"totalTokens":1156,"cachedInputTokens":0}}]}}
{"jsonrpc":"2.0","method":"turn/completed","params":{"eventId":9,"sessionId":"sess-1234-…","emittedAt":1770000000024,
  "turn":{"id":"turn-…","sessionId":"sess-1234-…","status":"completed","startedAt":1770000000000,"completedAt":1770000000024}}}

// ── 9. (if the model calls a tool) S→C: approval request — answer it in order:
{"jsonrpc":"2.0","id":7,"method":"callback/call","params":{
  "callback":{"type":"callback","id":"entry-c1","sessionId":"sess-1234-…","turnId":"turn-…",
    "createdAt":1770000000040,"updatedAt":1770000000040,"generationStatus":"in_progress",
    "callbackId":"cb-001","title":"Run shell command",
    "detail":{"kind":"approval",
      "effect":{"kind":"shell","toolName":"bash","display":{"summary":"`ls -la`","statusText":"running"},"input":{"command":"ls -la"}},
      "requiredPermissions":[{"scope":"command_pattern","invocationPattern":"ls -la","sessionPattern":"ls -la","label":"ls -la"}],
      "choices":["approve","approve_for_session","approve_permanently","deny","cancel_turn"],
      "pathScopeChoices":[],"relatedEntryId":null,"reason":null},
    "state":{"type":"open"}}}}
// 9a. C→S: ack (id 7 = the integer received, identical callbackId)
{"jsonrpc":"2.0","id":7,"result":{"callbackId":"cb-001","accepted":true}}
// 9b. C→S: decision
{"jsonrpc":"2.0","id":"client-4","method":"callback/result","params":{
  "sessionId":"sess-1234-…",
  "result":{"callbackId":"cb-001","output":{"type":"approval","decision":{"type":"approve","pathScope":null},"feedback":null}}}}
// 9c. S→C: {"jsonrpc":"2.0","id":"client-4","result":{"accepted":true,"lastEventId":N}}

// ── 10. End of conversation: C→S
{"jsonrpc":"2.0","id":"client-5","method":"session/stop","params":{"sessionId":"sess-1234-…","reason":null}}
// S→C: {"jsonrpc":"2.0","id":"client-5","result":{"closed":true}}
// (the server then closes the connection; the process shuts down)
```

Node.js implementation points to remember from the skeleton:
1. read/write in **lines** (readline), UTF-8, one `JSON.parse` per line;
2. route every incoming line: has `id` + (`result`|`error`) → a response
   to one of our pending requests; `method` + `id` (without
   result/error) → a server→client request (`callback/call`,
   `tools/call`, `clientTool/*`, `session/spawn`, `session/peer/*`,
   `platformCredentials/resolve`); `method` alone → notification;
3. answer every server→client request (`callback/call` ack
   **immediate**, otherwise the turn stays blocked);
4. maintain `lastEventId` per session (watermark), resync via
   `session/read` on a gap;
5. on `turn/completed`, optionally re-read `session/read` for a clean
   state before the next turn (cheap safety net).
