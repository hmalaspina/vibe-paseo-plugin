# Phase 4 — Wire shapes verified in mistral-vibe

All the shapes below were verified by reading the source code (no execution).
Files: `vibe/app_server/protocol.py` (P), `vibe/app_server/models.py` (M),
`vibe/app_server/_effect_models.py` (E), `vibe/app_server/server.py` (S),
`vibe/app_server/_connection_protocol.py` (CP), `vibe/app_server/_unified_harness_backend_adapter.py` (UHA),
`vibe/app_server/_runtime.py` (R), `vibe/core/config/models.py` (CM),
`vibe/app_server/_mcp_add.py` / `mcp_catalog.py` (MCP), `vibe/app_server/_config_write.py` (CW).
Serialization: every `ProtocolModel` is **camelCase + `extra="forbid"`** (`_model.py`) —
the JSON keys below are the camelCase aliases; config-store models are snake_case.

---

## 1. MCP servers in AgentConfig (session/start)

### Definitions (P l.325-343, l.435)

```python
class SessionMCPHttpServer(ProtocolModel):   # "transport" discriminator
    transport: Literal["http", "streamable-http"]
    name: str
    url: str
    headers: dict[str, str] = {}

class SessionMCPStdioServer(ProtocolModel):
    transport: Literal["stdio"] = "stdio"
    name: str
    command: str
    args: list[str] = []
    env: dict[str, str] = {}
    cwd: str | None = None

type SessionMCPServer = Annotated[SessionMCPHttpServer | SessionMCPStdioServer,
                                   Field(discriminator="transport")]
```

`AgentConfig.mcp_servers: list[SessionMCPServer]` (P l.435; `SessionOptions = AgentConfig` l.461).
**No enabled / alwaysLoad / trust field** in the session shape: discrimination is
only by `transport`. (The `disabled`, `startup_timeout_sec`, `tool_timeout_sec`,
`sampling_enabled` fields exist on the config-file models — `CM._MCPBase` l.225-252 —
but NOT on the session wire.)

Internal projection (R l.3427-3454 `_project_session_mcp_server`): http → `MCPHttp`,
streamable-http → `MCPStreamableHttp` (headers → `auth=MCPStaticAuth(headers=...)`),
stdio → `MCPStdio(command=[server.command], args, env, cwd)`. These servers become an
`mcp_servers` override of the orchestrator config at startup (R l.3477-3483).

### Exact JSON for session/start

```jsonc
// agentConfig (camelCase) — local stdio:
{ "agentConfig": { "cwd": "/projet", "mcpServers": [
    { "transport": "stdio", "name": "my-server",
      "command": "bash", "args": ["scripts/asroot.sh"], "env": {"FOO": "bar"} }
]}}
// remote http/streamable-http:
{ "agentConfig": { "mcpServers": [
    { "transport": "streamable-http", "name": "fetch",
      "url": "https://mcp.example/mcp", "headers": {"Authorization": "Bearer x"} }
]}}
```

"MCPAddTransport" (`vibe/utils/mcp.py` l.5) = `Literal["http", "streamable-http"]` — used for the
`transport` parameter of `mcp/add` (extended to `"stdio"` inline, P l.2471).

### Mid-session add WITHOUT restarting

Two paths, neither requires a session restart:

- **`mcp/add`** (alias `mcp_catalog/add`, mappings P l.162-174, `mcp_catalog.py` l.83).
  Params `MCPAddParams` (P l.2466-2482):
  ```jsonc
  { "sessionId": "sess_root", "transport": "stdio", "name": "my-server",
    "command": "bash", "args": ["..."], "env": {"K": "V"} }
  // or http: {"sessionId": "...", "url": "https://...", "transport": "streamable-http",
  //            "name": "fetch", "headers": {...} (⇒ static auth), "allowInsecureHttp": false,
  //            "startupTimeoutSec": 10.0, "toolTimeoutSec": 60.0}
  ```
  Response `MCPAddResponse` (P l.2484-2488): `{name, url, created, runtime}` — `runtime`
  (RuntimeSnapshot, P l.1672) contains the updated MCP state (`mcp: MCPState` with `sources`).
  The server persists into the config layers (`_mcp_add.py` → `persist_stdio_mcp_server`) then
  **converges the live session's MCP state** (`mcp_catalog.py` `_add` l.292-320 → `_converge`).
  stdio requires `name`+`command`; env forbids values containing `\x00`; the remote
  options (url/headers/scopes) are rejected with stdio.
- **`config/write`** (P l.1869-1896): `ConfigWriteParams {sessionId, ops:[{op:"set"|"remove",
  path, value, targetLayer}], reason, reloadRuntime}` — paths = JSON pointers on the
  snake_case config dump (`_config_introspect.py` l.346 `config.model_dump(mode="json")`,
  key `mcp_servers`), e.g. `{"op":"set","path":"/mcp_servers","value":[{...}]}`.
  Rejected during a turn EXCEPT for turn-independent paths (UHA l.1572-1582: `/theme`, `/log_level`,
  etc. — not `/mcp_servers`); on write, `_write_config` (UHA l.10963) applies the patch then
  `_apply_written_config` re-derives the runtime at the next idle moment → MCP is loaded without
  restarting the session.

Mid-session cleanup: `mcp/remove {sessionId?, name}`; toggles `mcp/toggle {sessionId?, name,
source:"server", disabled, toolName?}` (P l.2458-2463). Without sessionId, the add is global (default
config) and hits subsequent sessions.

---

## 2. Child sessions (vibe subagents)

### PublicChildSession (M l.1229-1242)

```jsonc
{ "id": "sess_enfant",
  "name": "researcher",                  // name given at spawn; fallback "subagent"
  "agentType": "default",                // profile from the spawn, otherwise "subagent"
  "agentPath": "/root/researcher",       // path in the tree; null before naming
  "model": {"displayName": "...", "thinking": "..."} | null,
  "status": {"type":"running","activeTurnId":"..."} ,  // PublicSessionStatus
  "tokenUsage": {"inputTokens":0,"outputTokens":0,"cachedInputTokens":0,"totalTokens":0},
  "contextUsage": {...} | null,
  "createdAt": 1719000000000, "updatedAt": 1719000000000 }
```

Status = union discriminated by `type` (M l.1135-1141): `idle {}`; `running {activeTurnId}`;
`blocked {activeTurnId, callbackId, reason}`; `failed {message}`; `archived {}`.
**PublicChildSession does NOT have parentSessionId/rootSessionId/preview** — those are on
`PublicSession` (M l.1169-1211: `rootSessionId`, `parentSessionId`, `preview`, ...); a child's
"parent" is deduced from the root session we are subscribed to
(`session/childSessionUpdated.params.sessionId` = **the root's id**).

### session/childSessionUpdated notification

Method `"session/childSessionUpdated"` (UHA l.16989), params `ChildSessionUpdatedParams` (P l.3811):
```jsonc
{ "method": "session/childSessionUpdated",
  "params": { "eventId": 42, "sessionId": "sess_ROOT", "emittedAt": 1719...,
              "childSession": { ...PublicChildSession above } } }
```
Emitted on the **root's** event sequence (UHA `_child_summary_events` l.16962-16976),
after the history/turn events of the same state (l.16636-16648), then a root
`session/snapshot` if the state changed (l.16649-16654). No capability required for this one.

### childSessionEvents capability (CP l.118-120; S l.594-599; UHA l.16659-16688)

`initialize` → `capabilities.childSessionEvents: true`. Without it, `server._forward_backend_event`
**silently drops** any `SessionBackendEvent(child_session=True)`. With it, the client
attached to the root receives **each child's full stream under its own sessionId**:
`session/snapshot` (at child registration, l.16693-16706), `turn/started`,
`turn/completed`, `history/entryAdded`/`history/entryUpdated` (params with
`entry.sessionId` = the child), `turn/queue/updated`, `session/updated`. Each child has its
own event_id sequence (manifest fallback: `_history_event` l.18295-18315 — the child's
event_id is incremented on the child's state, not the root's). Stats/artifacts
remain root-only events (docstring l.16662-16665).

So: yes, with the capability the children's history/entryAdded events are streamed with
their own sessionId (and not only snapshots); the children list itself remains
available in `PublicSessionState.childSessions` + root patches.

### Reading a child

- `session/read {sessionId: "<enfant>", history: {limit: 200}}` (P l.530-533) works
  from the root connection: the un-attached session switches to stored reading (S l.1303-1310
  `_dispatch_stored_session`, triggered by NOT_FOUND of session/history/list) → `PublicSessionState`
  with `session.parentSessionId`. Also available via `session/list {rootSessionId | parentSessionId}`
  (P l.739-758).
- `session/subagents/read` (experimental, P l.678-687, 705-736): `{sessionId, timeoutMs?}` →
  `{subagents: [SubagentRun]}` with `sessionId`, `parentSessionId`, `rootSessionId`, `name`,
  `agentType`, `spawnActionId`, `spawnCallId`, `status` (`running|...|unknown`,
  `SubagentRunStatus` l.689+), `usage {inputTokens, outputTokens, cachedInputTokens, totalTokens}`,
  `costUsd`, `model`, `steps`. Likewise `session/subagents/wait`, `session/subagents/interrupt`.

### Creating a child yourself

On the server→client side, `session/spawn` (P l.3466-3518, requires the `sessionSpawn`
capability CP l.111): the server asks THE CLIENT to start a session and run `prompt`
in it (`SessionSpawnParams {parentSessionId, prompt, title, checkout, idempotencyKey, model,
reasoningEffort, approvalPolicy, agent, hops, attached}`; response
`{sessionId, title, clientSessionId, url}`). The client responds by calling `session/start`
itself — with `startedBySessionId` or `spawnedBySessionId` (P l.515-520) for an attached
spawn, otherwise a detached session. `session/fork` is a fork of an existing session
(client→server: `{idempotencyKey?, sourceSessionId, entryId?, agentConfig?, afterTurnId?,
historyLimit, attach}`), not a child spawn. Model-driven spawn is internal:
tool `agents.spawn` (formerly `subagent.spawn`).

### Effect ↔ child link (E l.205-215, 310-316)

The spawn's effect arrives as a history entry `type:"effect"` whose `detail` is
`SubagentEffectDetail {kind:"subagent", toolName:"agents.spawn"|"subagent.spawn",
input:{task, agent}, childSessionId: str|null, agentName: str|null}` — card built at the
start of the call, `childSessionId` filled in afterwards by patch
(history/entryUpdated), hence the tool output's `_meta`: `{"mistral.vibe.subagent":
{"childSessionId": "...", "spawnCallId": "..."}}` (`_subagent_runs.py` l.310-330).
The detail's `childSessionId` = the `session/childSessionUpdated`'s `childSession.id`: it is the
join key (UHA `_observe_child_metadata` l.16828-16848).

### Observable sequence of a turn that spawns a subagent (root client, childSessionEvents:true)

1. `turn/started` (params.sessionId = root)
2. `history/entryAdded` — entry `type:"effect"`, `detail.kind:"subagent"`,
   `detail.childSessionId: null` (args not done streaming yet)
3. (harness notifies the spawn) → on the child side: `session/snapshot` with `params.sessionId = enfant`
   (child registration), then on the root side: `session/childSessionUpdated` with
   `params.sessionId = root`, `childSession {"id": "<enfant>", "status": {"type": "running",
   "activeTurnId": ...}}`
4. `history/entryUpdated` — the same effect, `detail.childSessionId` now filled
5. Child's stream: `turn/started`, `history/entryAdded`/`entryUpdated`, `turn/completed`
   (params.sessionId = child; event_id ⟂ child sequence)
6. Root `session/childSessionUpdated` on each child status/usage change
   (→ `{"type":"idle"}` at the end)
7. Root `turn/completed`; the subagent effect moves to a completed `state`
   (output `{response, turnsUsed, completed}` — `SubagentEffectOutput` E l.210-213)

### Recommended ProviderEvent mapping

- history/entryAdded (effect kind subagent, childSessionId filled)
  → `session.opened {sessionId: childSessionId, parentSessionId: params.sessionId}` ;
  fallback: first `session/childSessionUpdated` with an unknown `childSession.id`
  → same session.opened (key = `childSession.id`).
- Child events (params.sessionId ≠ root) → child-session events
  (message, update, closed), scanned on ChildSessionUpdated's `status.type`
  (`idle` → session.closed / `blocked` → session.waiting).
- Parent: `params.sessionId` of any root event.

---

## 3. Settings / mid-session budgets

### session/settings/update (P l.1660-1669; sharing S l.1720-1724; UHA l.10765-10784)

```jsonc
// Request (camelCase) — at least one of the two, otherwise invalidParams:
{ "sessionId": "sess_1", "maxTurns": 40 }
// or
{ "sessionId": "sess_1", "maxTokens": 2000000 }
// Response: {} (EmptyResponse)
```
Types: `maxTurns`/`maxTokens` = `NonNegativeStrictInt` (strict int ≥ 0) or null. Empty response.
**Idle session required** (`_require_idle`, UHA l.10769); during a running turn → error.
These are session-local overrides `UnifiedSessionSettings {max_turns, max_tokens}` (UHA
l.937-951), never persisted to a config layer; applied at the next derivation
(`_apply_derivation`). No maxPrice/timeLimit here.

### Budget agentConfig keys (P l.411-440)

```python
max_turns: int | None = None                       # → "maxTurns"
max_price: float | None = Field(ge=0, allow_inf_nan=False)   # → "maxPrice"
max_session_tokens: int | None = Field(ge=0)       # → "maxSessionTokens"
```

- `maxTurns`: number of LLM turns for the session (int).
- `maxSessionTokens`: ceiling on tokens consumed across the *entire* tree (root + subagents)
  — fed into `SharedCompletionBudget(max_total_tokens=..., max_price=...)` (R l.1649-1654).
- `maxPrice`: **US dollars** — `CompletionPricing` bills "USD per million tokens"
  (harness `vibe/_completion_budget.py` l.16-43, `cost() = tokens × per_million / 1_000_000`),
  compared against `SharedCompletionBudget.max_price`; limit → `price_limit` (l.110-124) and
  the run stops. Zero = only free usage allowed, stop at the first cent.

### Recommended complete shapes (session/start)

```jsonc
{ "agentConfig": { "cwd": "/projet", "maxTurns": 30, "maxSessionTokens": 1500000,
                   "maxPrice": 2.5, "mcpServers": [ ... ] } }
// mid-session: {"method": "session/settings/update",
//                "params": {"sessionId": "sess_1", "maxTokens": 1500000}}
```

Caution: maxTurns/maxSessionTokens/maxPrice are readable/writable **neither via
session/settings/update** (which only knows the unified harness's maxTurns/maxTokens) nor
anywhere else mid-session — maxPrice/maxSessionTokens are FIXED AT OPENING (CompletionBudgetSlot of
the session context, R l.1646-1648; the budget is adopted/shared, a rebuild keeps it but
a relocate's options only replace it if they carry one).
