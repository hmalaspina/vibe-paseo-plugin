# vibe-paseo-plugin

Native Paseo provider for **mistral-vibe** (vibe-cli), as a Paseo plugin
(`server.registerProvider`).
Integration surface: `vibe-app-server` (line-delimited JSON-RPC over stdio) —
the internal protocol used by the Mistral desktop app.

## Status

| Phase | Status |
|---|---|
| 0 — Recon & spike | ✅ docs (full wire protocol, reports) |
| 1 — Plugin scaffold | ✅ operational catalog |
| 2 — Minimal loop | ✅ demonstrated e2e (commit da73023) |
| 3 — Permissions | ✅ approvals + questions (validated e2e over the wire) |
| 4 — Fidelity (steer, MCP, sub-agents, controls) | ✅ MCP injection + sub-agent tree + steer + controls policy/budgets (validated e2e) |
| 5 — Lifecycle | ✅ rewind (session.revert), archive/unarchive, session.list (import), can_stop_runtime (validated e2e) |
| 6 — Structured output | ✅ prompt.output_schema: `paseo_host.paseo_structured_output` client tool + ajv validation + daemon convention (validated e2e) |
| 7 — Timeline fidelity | ✅ todo/worktree/process/user_question/scratchpad, eventId-gap resync, compaction, structured-output replay (validated e2e) |
| 8 — Preapprovals | ✅ `permission.tool_policy`: daemon-preapproved MCP tools auto-resolved provider-side, human rail intact (validated e2e) |
| 9 — UI resolution | ✅ `session.permission_resolved` (tile/spinner unblocked after approval, server-side resolutions included) |

**Provider parity closed**: every capability of the Paseo provider protocol v1
is covered, EXCEPT `session.revert.files` (impossible on the vibe side:
restoring files without truncating the conversation does not exist) and
`timeline.plugin` (vibe exposes no plugin-rendered timeline payload; the
capability is deliberately left unnegotiated). Detailed per-feature register:
`docs/feature-parity.md`.

## End-to-end test (reference)

```sh
paseo run --provider vibe --title "test" "Réponds uniquement: OK"
# → AGENT … completed, provider vibe, timeline message/reasoning/OK,
#   usage reported (tokens in/out/cached + cost)
paseo plugin logs vibe-provider     # plugin ops instrumentation
```

## Installation

### Prerequisites

- **paseo ≥ 0.17.3** daemon, with plugins enabled:
  `~/.paseo/config.json` → `"pluginsEnabled": true`.
- **mistral-vibe** CLI installed (`uv tool install mistral-vibe`, or pip) —
  the package provides `vibe`, `vibe-acp` and `vibe-app-server`.
- `git`, `node`/`npm` in the daemon's environment.
- A Mistral key (`MISTRAL_API_KEY`) or an authenticated vibe profile.

### From this Git repository (managed install)

```sh
paseo plugin install https://github.com/hmalaspina/vibe-paseo-plugin \
  --path vibe-provider --ref main
```

- The manifest (`paseo-plugin.json`) declares `"build": [["npm", "ci"]]`,
  run by the daemon at install/update time: dependencies (`ajv`) are
  materialized in the plugin's `node_modules` — sources alone are not enough
  (the daemon's esbuild bundler resolves non-SDK imports from the plugin's
  `node_modules`).
- Update: `paseo plugin update vibe-provider --ref main --yes`
  (reloading interrupts active provider sessions).
- To pin a version: `--ref refs/tags/vX.Y.Z` (the repository's tags serve as
  version anchors).

### From a local copy

```sh
git clone https://github.com/hmalaspina/vibe-paseo-plugin
paseo plugin install ./vibe-paseo-plugin/vibe-provider
```

### Binary resolution (daemon PATH)

If `vibe-app-server` is not in the daemon's PATH (typical of a uv install:
`~/.local/bin`), two options:

1. the plugin already adds `~/.local/bin` to the PATH of the processes it
   spawns;
2. otherwise, override in `~/.paseo/config.json`:

```jsonc
{
  "agents": {
    "providers": {
      "vibe": { "command": ["/chemin/absolu/vers/vibe-app-server"] }
    }
  }
}
```

### Recommended vibe configuration

In `~/.vibe/config.toml`:

```toml
enable_telemetry = false    # default: true (Sentry + OTLP)
enable_auto_update = false   # keeps version control on the orchestrator side
```

### Declaring additional models

The local mistral-vibe catalog lists a small subset of the hosted models.
Others are declared via `[[models]]` (source: the API list,
`GET https://api.mistral.ai/v1/models`):

```toml
[[models]]
name = "zai-glm-5-3"          # exact id on the Mistral API side
alias = "zai-glm-5-3"         # picker identifier (paseo sees it)
provider = "mistral"
display_name = "Z.ai GLM 5.3"
# optional: thinking, thinking_levels, max_context_length,
#           input_price/output_price/cached_input_price (USD per million)
```

These models show up immediately in `paseo provider models vibe` (the catalog
is refreshed by the daemon; force it via a plugin update/reload).

## Known pitfalls (found during e2e)

- **Session IDs**: the daemon picks the sessionId (input field) and routes ALL
  ProviderEvents by that id; the vibe id (returned by session/start) is only
  used on the wire and in persistence. Confusing them → silent hang on the
  daemon side (await session.ready never resolves).
- **Evaluated bundles**: the daemon compiles the plugin (esbuild) then
  evaluates it via `eval` — `import.meta.url` is not a valid URL there. Any
  embedded path must be materialized in a stable location (cf.
  `server/agent-plugin.ts`), never resolved through `import.meta`.
- **Client tool namespace**: do not name it like a session MCP server (the
  daemon's MCP bridge is named `paseo`) — vibe rejects it at session/start;
  and the namespace must be the `name` of the `agentPlugins` entry AND of the
  manifest (`configure_agent_plugins`).
- **`session/stop` → EOF** is a normal process exit: do not emit it as
  `runtime_failed` (`closing` flag).
- **Global catalog**: without a project cwd, pass the homedir (vibe user
  config), never the daemon's `process.cwd()`.
- **Unknown context windows**: a model declared without `max_context_length`
  carries `null` on the vibe side — the daemon's provider codec requires a
  number OR the absence of the field (never null).
- **Permission resolution**: after an approval response, the provider MUST
  emit `session.permission_resolved` (otherwise the tile + spinner stay
  blocked on the Paseo side); also cover server-side resolutions (entry
  `callback` → answered/cancelled/expired), root and children.
- **User message of turns ≥ 2**: the vibe wire does not emit the matching
  entryAdded (erratum §4.3) — the plugin synthesizes the timeline item at
  prompt time (idempotent); the rewind anchor stays valid in both cases.
- **Item re-emission ≠ daemon upsert**: the daemon's timeline store is
  append-only; only the projection merges. A re-emitted item is a NEW card →
  resync re-emits only the missing one (cf. B6).
- A "ghost" vibe session survives on disk (`~/.vibe/logs/session/`) when a
  run is killed before session/stop — harmless, resumable.

## Layout

- `vibe-provider/` — the plugin: `index.server.ts` +
  `server/{json-rpc,connection,session,provider,wire,agent-plugin,installation}.ts`
  + `agent-plugin/paseo/` (embedded built-in plugin for client tools)
- `docs/app-server-protocol.md` — full wire reference (incl. errata)
- `docs/phase4-wire-shapes.md` — MCP/child sessions/settings shapes
- `docs/phase0-*.md` — recon/install/spike reports
- `docs/feature-parity.md` — per-feature register (commits, costs, validations)
- `spike/` — JSONL probes (full turn, catalog, approval) + drivers

## Architecture decisions

- Go native with the app-server (the ACP alternative covers less surface: no
  rewind, budgets, policies, native sub-agents or instruction files).
- Catalog: `config/read` + `agents/list` host-side (without an attached
  session); per session, first runtime frame via `runtime/read` (session/start
  never emits runtime/updated), then `runtime/updated` notifications.
- Negotiated capabilities: `prompt.message`, `prompt.image`, `prompt.command`,
  `prompt.steer`, `prompt.output_schema`, `session.persistence`,
  `session.configure`, `session.subsession`,
  `session.revert.conversation`, `session.revert.both`, `session.archive`,
  `session.unarchive`, `session.list`, `session.can_stop_runtime`,
  `permission`, `permission.tool_policy`.
- **output_schema**: the `paseo_host.paseo_structured_output` client tool
  (namespace distinct from the daemon's `paseo` MCP server) receives
  submissions, validated by ajv plugin-side (rejection = a tool error the
  model fixes); acceptance published per the daemon convention (`tool_call`
  `metadata.paseoStructuredOutput` + JSON assistant_message); a successful
  turn without a valid submission = failed (`missing_structured_output`). The
  value is carried in persistence to be replayed after reload/rewind.
- **MCP**: `config.mcpServers` (stdio/http, sse→streamable-http) injected
  into `agentConfig.mcpServers` at open — the daemon's MCP bridge tools are
  visible in vibe sessions.
- **Budgets**: `maxTurns`, `maxSessionTokens` (tokens), `maxPrice` (USD) at
  open via providerOptions; `session/approvalPolicy/update` +
  `session/settings/update` hot. Control composer: `approvalPolicy` select.
- **Sub-agents**: `childSessionEvents:true`; a child's first event →
  `session.opened {parentSessionId, restoration:"parent"}`, then the child's
  timeline and turns forwarded; a child's callbacks reference its own
  sub-session.
- **Approvals**: `allow→approve`, `deny→deny`, `deny+interrupt→cancel_turn`,
  `question→user_input/answers`; resolution confirmed by
  `session.permission_resolved` (response or server-side resolution).
- **permission.tool_policy**: `toolPolicy.preapproved [{kind:"mcp", server,
  tool}]` materialized as a set of toolNames; a matched callback is
  auto-resolved `approve_for_session` provider-side (frictionless for
  unattended agents), while any non-preapproved tool follows the human rail.
  Subagents inherit the set.
- **Timeline fidelity**: `todo` effect → structured todo item (dedup by
  signature); `worktree` → `worktree_setup`; `user_question`/`process`/
  `scratchpad` → `plain_text`; surgical resync on an eventId gap
  (`session/read`, re-emitting the missing entry only); compaction = state
  replacement + `compaction` item; reasoning without text → summaries.

## Known limitations

- **Child session permissions**: the daemon does not surface them in
  `paseo permit` (keyed by root agent) → a child blocked on a
  non-preapproved tool wedges the parent's wait (workaround: `paseo stop`).
  To be revisited daemon-side (careful with the parent) or a configurable
  auto-deny.
- `session.opened` of children without `toolCallId` (correlation to the
  `agents.spawn` tool_call possible via the `childSessionId` effect — to
  wire).
- CLI messages inheriting the parent context arrive wrapped in a
  `<paseo-system>` block that vibe models prudently treat as a possible
  injection: possible test bias in real conditions, not a plugin defect.

## Versions

- `v0.1.0` — provider parity closed (all the features above except
  permission resolution), validated e2e.
- `main` — tracks current development (permission resolution included).

## License

Apache-2.0 — see [LICENSE](LICENSE). Chosen to match the surrounding stack
(mistral-vibe, the Paseo plugin SDK, ACP) and for its explicit patent grant
and patent-retaliation clause.
