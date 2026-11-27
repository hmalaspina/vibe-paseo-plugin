# Feature-parity registry — vibe provider vs first-class harnesses

Each feature: implemented/tested per batch, cost counted per LLM call
(real model prices: ~$0.7 / $2.1 / $0.07 per M tokens in / out / cached).
Legend: ✅ validated e2e, ⬜ remaining.


| # | Feature | Batch | Commit | LLM tests | Cost | Status |
|---|---|---|---|---|---|---|
| 1 | prompt.image | B1 | 9ded826 | 3 calls (2× color swatch + 1× word reading) | ~$0.06 estimated (actual ≈ $0.015, recomputed in B3) | ✅ |
| 2 | prompt.command (+ session.commands) | B2 | ccd877c | 1 call (/hello monde) | ~$0.02 estimated (actual ≈ $0.005, recomputed in B3) | ✅ |
| 3 | costUsd + session.metrics | B3 | e5610ea | 1 call (OK) | $0.0049 | ✅ |
| 4 | session.revert / archive / list / can_stop_runtime | B4 | 75ef9a0 | 2 calls (validated run) — 7 more burned by driver bugs (cf. journal) | $0.00207 productive / ~$0.017 total | ✅ |
| 5 | prompt.output_schema | B5 | d9d72b4 | 2 calls (success + impossible schema) + zero-LLM rejection probe | $0.00858 (2 calls) | ✅ |
| 6 | timeline fidelity (todo, worktree, process, user_question, scratchpad, session/read resync, compaction, structured replay) | B6 | 45bde9d | 2 calls (todo 2 waves + structured KIWI) + zero-LLM replay/resync smoke | $0.00987 (2 calls) | ✅ |
| 7 | icon + installation.checkForUpdates/update | B7 | 318c9b9 | 0 LLM calls (direct driver: real inspect/checkForUpdates/update, PyPI + uv) | $0.00 | ✅ |
| 8 | permission.tool_policy (MCP preapprovals) | B8 | f8c2997 | 1 LLM call (MCP echo turn + shell rm) + zero-LLM MCP open/discovery smoke | $0.00987 | ✅ |

## Measurement journal

(filled in by the batches — tokens in/out/cached per call, estimated cost, what was
validated, what failed)

### B1 — prompt.image (2026-11-23)

- **Impl**: `translatePromptContent()` in `session.ts` — text → text block,
  image → `{"type":"image","attachment":{"source":{"kind":"inline","data":<raw b64>},"alias":"image-N","mimeType":<mime>}}`
  (shape verified in `mistral-vibe/vibe/app_server/models.py`: `alias`+`mimeType`
  REQUIRED, pydantic extra=forbid; erratum recorded in `docs/app-server-protocol.md` §3.3) ;
  `uploaded_file` → text block "Attached file: <path>"; other attachments: if
  `text` → text block, else warn+skip. `trySteer` takes the same blocks (turn/steer
  = ContentBlock[]). Capability `prompt.image` added to `SESSION_CAPABILITIES`.
- **E2E** (driver `/tmp/opencode/b1-image-driver.mts`, direct tsx plugin, model
  mistral-large-4-0, thinking low, 3 calls — initially planned budget: 1, exceeded
  to isolate a model quirk, see below):
  1. Red **1×1** PNG, "What color is it?" → in 9793 (cached 3072),
     out 148 → "White." — complete turn WITHOUT protocol error, but the model
     sees a "blank/white" swatch (explicit reasoning): an artifact of the vision
     preprocessor on a 1×1 image, not of the transport (stored b64 byte-for-byte
     identical).
  2. Red **64×64 full-frame** PNG, same question → in 9803 (cached 3072),
     out 78 → "Black." — same: the model describes "a solid black square" although
     the image is red (255,0,0), verified at the last observation point
     (`generations/*/projection-state.json`, exact content before the API call).
     Conclusion: mistral-large-4-0 names colors poorly on solid fills.
  3. **424×112 PNG with "ROUGE" written in black/white bitmap + red border**,
     "Which word is written in this image?" → in 9864 (cached 3072), out 37 →
     **"ROUGE"** ✅ — correct reading of a 5-letter word invented for the test:
     definitive proof that the pixels reach the model end to end.
- **Wire**: strict server-side validation passed on the first try (no
  `invalid_image_attachment`/`images_not_supported` error); the vibe history persists the
  complete image block; `input_modalities: ["text","image"]` in the catalog.
- **Tokens/cost** (3 turns): in 29,460 (of which 9,216 cached) / out 263 →
  **≈ $0.06** (at $2/M in — $6/M out, nominal prices; actual cache discount n/a
  at these prices).
- Cleanup: no paseo agent created (direct driver), nothing to delete.
- Model follow-up (outside plugin scope): mistral-large-4-0's color naming on
  solid fills is dubious (2 wrong answers on a solid swatch vs a correct OCR
  reading) — to requalify on the harness/mistral-vibe side if needed.

### B2 — prompt.command + session.commands (2026-11-23)

- **Impl**: in `session.ts` — (1) `session.commands`: each
  `RuntimeSnapshot.skills` (runtime/read at open + runtime/updated)
  `userInvocable/active/enabled` becomes a `ProviderCommand
  {name, description, kind:"skill"}`; cache by JSON signature → a single
  event per change (no spam). (2) `prompt.command`:
  `{type:"command", name, arguments}` → a `turn/start` turn whose text
  is `/name arguments` (the wire's slash convention, cf. erratum §3.3);
  the skill body is injected server-side by the Unified adapter.
  (3) runtime/read added to the open flow (a fresh session never receives
  runtime/updated — erratum §3.2); bonus: `session.config` (models/modes/
  policies) emitted from the very first open of a fresh session, not only after
  resume/configure. (4) `wire.ts`: `SkillSummary` typed. Capability
  `prompt.command` added to `SESSION_CAPABILITIES` (negotiated).
- **Mapping**: the whole vibe slash menu = **skills** (the 4 builtin
  `vibe:*` + local/project/registry/plugins as snapshots flow in); vibe's
  "prompts" are system prompts (no kind "command" to
  expose); no argumentHint (not exposed by vibe).
- **E2E** (driver `/tmp/opencode/b2-commands-driver.mts`, direct tsx plugin,
  cwd `/tmp/opencode/b2-cmds` with `.vibe/skills/hello/SKILL.md`, model
  mistral-large-4-0, thinking low, 1 LLM call, PASS on the first try):
  1. `session.open` → `session.commands` with 5 skills (4 builtin `vibe:*`
     + `hello` kind skill), a single event (dedup OK) → gate before the LLM.
  2. Prompt `{type:"command", name:"hello", arguments:"monde"}` →
     turn/start accepted, turn completed, response **"hello monde"** ✅
     (the model echoed it line for line: regex grading, not a transport
     defect).
- **Tokens/cost** (1 turn): in 9,835 (of which 3,072 cached) / out 62 /
  total 9,897 → **≈ $0.02** (at $2/M in — $6/M out, nominal prices; actual
  cache discount n/a at these prices).
- Errata recorded in `docs/app-server-protocol.md`: §3.2 (runtime/updated
  never after session/start → runtime/read), §3.3 (slash invocation via the
  turn text), §6.3 (`SkillSummary` shape + prompts = system prompts +
  host skills/list without sessionId).
- Cleanup: no paseo agent created (direct driver), nothing to delete.

### B3 — costUsd + session.metrics (2026-11-23)

- **Impl**: in `session.ts` — (1) **costUsd**: the active model's prices
  come from `agentStatsSnapshot.inputPricePerMillion`/`outputPricePerMillion`/
  `cachedInputPricePerMillion` (seeded by `runtime/read` at open + every
  `session/statsUpdated`), the cost formula is the one from
  `vibe/utils/pricing.py`: `((prompt-cached)×in + cached×(cachePrice ?? in) +
  out×out_price)/1e6`, cache clamped to the prompt. Cumulative counters =
  max(session/start `tokenUsage`, `session/updated` patches, stats) to
  stay correct across a resume. `session.usage` (emitted on every
  `session/statsUpdated` and at turn completion) now carries a
  **cumulative** `totalCostUsd` — the daemon's semantics
  (`agent.lastUsage` = session snapshot; opencode sends `session.cost`,
  Claude its current `total_cost_usd`), with `contextWindowMaxTokens` =
  the active model's `maxContextLength` and `contextWindowUsedTokens` =
  `stats.contextTokens` (gauge). Noise guard: usage not emitted at 0 tokens,
  dedup by signature. (2) **session.metrics**: negotiated capability
  (`SESSION_CAPABILITIES` + gate by caps passed to `AgentSession`); rows
  Tokens (in/out), Cache %, Steps, Context (gauge/window, ok/warning/danger
  tones at 80/95%), Cost — dedup by signature (daemon pattern
  `createSessionMetricsReporter`). (3) **turn footer**: `session.turn`
  completed deferred (~20 ms, the same server batch's statsUpdated follows
  turn/completed) to include Duration / Throughput (tok/s in+out) / turn
  Tokens via deltas (pre-turn baseline captured at turn/started).
- **E2E** (driver `/tmp/opencode/b3-metrics-driver.mts`, direct tsx plugin,
  zero-LLM price probe via `runtime/read`, then 1 LLM call — mistral-large-4-0
  thinking low, prompt "Réponds uniquement: OK" — PASS on the first try):
  1. Probe: real prices in=**$0.7**/M, out=**$2.1**/M, cached=**$0.07**/M,
     model window 1,048,576 / compaction threshold 400,000.
  2. OK turn (response "OK"): final usage `totalCostUsd=0.00487424` =
     an **exact** manual recomputation ((9626-3072)×0.7 + 3072×0.07 + 34×2.1)/1e6 ;
     `contextWindowMaxTokens=1048576`, `contextWindowUsedTokens=9660`.
  3. `session.metrics`: 3 events (Steps 1 → Steps 2 → final with
     Tokens/Cache 32%/Steps/Context/Cost $0.005) — dedup OK.
  4. Turn-completed footer: Duration 3.2s · Throughput 2999.1 tok/s (in+out) ·
     Tokens 9,626 in / 34 out (the footer's "Steps" line = steps delta > 1,
     added after the run, validated by zero-LLM smoke + typecheck).
  5. Zero-LLM smoke after refinements (open+close without prompt): no
     stray usage/metrics events.
- **Tokens/cost** (1 turn): in 9,626 (of which 3,072 cached) / out 34 →
  **$0.00487** (real prices 0.7/2.1/0.07 — NB: the "$2/$6
  nominal" estimates in the B1/B2 journals were ~3× too high; actual B1 cost ≈
  $0.015, B2 ≈ $0.005).
- Errata recorded in `docs/app-server-protocol.md` §4.5: the exact pricing
  shape (per-million prices on the stats snapshot, the
  `session_token_cost` formula, the statsUpdated's `contextWindow` = the
  compaction threshold ≠ model window, `lastTurn*` = last measured call,
  `lastTurnDuration`/`tokensPerSecond` never filled).
- Cleanup: no paseo agent created (direct driver), nothing to delete.

### B4 — session.revert (rewind) + archive/unarchive + session.list + can_stop_runtime (2026-11-23)

- **Caps added**: `session.revert.conversation`, `session.revert.both`
  (NOT `session.revert.files` — vibe cannot restore files without
  truncating the conversation), `session.archive`, `session.unarchive`,
  `session.list`, `session.can_stop_runtime`.
- **session.revert** (`session.ts`): token `{entryId}` → resolved anchor
  (direct user message; otherwise the same turn's user message — revertTokens
  are placed on every timeline.item; otherwise the raw id, resumed
  sessions don't keep the entry in the map) → `session/rewind`
  **inplace:true** (same session id — no ghost fork at every rewind),
  `restoreFiles = scope ≠ "conversation"`. Vibe requires a settled session:
  prior interrupt of an active turn (previous opencode revertBoth) + retry on
  `conflict` (12×250 ms — the backend only reaps the lingering task after
  turn/completed). After the response: entries replaced by `state.history`,
  `lastEventId = state.eventId`, notice if `restoreErrors`. Daemon
  semantics (plugin-provider `replayBinding`): after the revert the daemon closes then
  reopens with `history:"replay"` and the persistence — inplace keeps it
  unchanged, flow validated word for word by the driver.
- **session.archive/unarchive** (`connection.ts archiveVibeSession`):
  ephemeral process spawn→handshake→`session/archive {sessionId, archived}`
  → close (Host operator — works WITHOUT an attached session), id from
  `persistence.data.vibeSessionId` (`readPersistedSessionId` exported).
- **session.list** (`connection.ts listVibeSessions`): ephemeral process,
  paginated `session/list` (pages of min(500, remaining)), root-only filters
  (without `parentSessionId`/`startedBySessionId` — vibe's internal subagents
  excluded), cwd required, case-insensitive `query` (title+preview — the daemon
  refilters), `updatedAt` desc sort → `ProviderSessionSummary` (persistence
  `{version 1, data {vibeSessionId}}`, cwd, title?, description = preview,
  updatedAt ISO). The real import remains `session.open {persistence,
  history:"replay"}` (already working).
- **session.can_stop_runtime**: answered by the event of the same name (NOT
  request.completed — the daemon matches the session id on the response);
  semantics = veto of the idle-runtime garbage collector (60 min); our canStop =
  no active turn AND no "running" `backgroundProcess` (tracked via the
  root `session/snapshot`, case added — `_translate_snapshot_update` only
  emits it on a retrying/backgrounds/loops/goal change).
- **Bonus timeline FIX** (erratum §4.3): vibe does NOT emit `history/entryAdded`
  for the user message of turns ≥ 2 (the entry is still persisted).
  The plugin now synthesizes the user_message item at prompt time (id =
  `prompt.clientMessageId` → wire `clientUserMessageId`, verified = the
  entry's id in the store), idempotently
  (skip if the wire entry is there, overwritten if it arrives). Without this fix, the
  user messages of subsequent turns did NOT appear in the Paseo
  timeline — discovered by this batch on a multi-turn run.
- **E2E** (driver `/tmp/opencode/b4-driver.mts`, direct tsx, mistral-large-
  4-0 thinking low, 2 LLM calls, PASS — run 5):
  1. can_stop **during** turn 1 → false ✅; idle → true ✅.
  2. LLM#1 "memorize BANANE": in 9,632 (of which 9,216 cached) / out 42 →
     $0.00103; LLM#2 "last word?": in 9,702 / out 28 → $0.00104,
     answer "BANANE".
  3. `session.revert {token of the turn-2 user entry, scope:"conversation"}` →
     rewind OK (restoreErrors=0, same vibe id); close + reopen
     {persistence, history:"replay"} → 3 items including **1 user / 1 assistant**:
     the replayed history stops at turn 1 (answer "OK"), NO turn-2
     ids ✅ (the daemon would do exactly this close+reopen).
  4. Phase 2 (0 LLM): `sessions {cwd}` → our session is listed (persistence
     with vibeSessionId); query "rewind" matches / "zzz-nonexistent" → 0;
     `session.archive` → absent from the listing AND the vibe wire `archivedAt`
     set ✅; `session.unarchive` → visible again ✅.
  5. Zero-LLM extras (`b4-probe.mts` + `b4-ghost-revert.mts`): raw
     rewind on the aborted run-1 ghost (complete SessionRewindResponse shape,
     `checkpoint-rewind-<id>` entry, truncated history); plugin revert
     anchor `b4-m1` → replay reopen → **0 items** (total rewind) ✅.
- **Tokens/cost**: validated run in 19,334 (of which 18,432 cached) / out 70 →
  **$0.00207** (real prices 0.7/2.1/0.07). TOTAL B4 cost ≈ **$0.017**: 9
  LLM calls initiated instead of the 2 planned — 4 runs aborted by DRIVER
  bugs (2×2 calls: off-by-one `eventsIdx > marker2` which excluded the
  turn-2 user item, waitFor without scanning past events; 1 appendFile
  callbacks-vs-promises run, died before any call; 1 SIGPIPE probe) and 1
  "nonexistent skill" probe that still calls the model (skill resolution does NOT
  precede the LLM call). The plugin itself: clean failures,
  never a crash, no rerun attributable to its code.
- Errata recorded in `docs/app-server-protocol.md`: §3.4 (archive response),
  §3.5 (rewind params/response + inplace/checkpoint; session/list subset of
  PublicSession + roots/CWD filter), §4.3 (user entryAdded missing at
  turn ≥ 2 + the synthesis fix; root session/snapshot → backgroundProcesses).
- Cleanup: no paseo agent created (direct driver), nothing to delete;
  the test vibe ghosts (cwd /tmp/opencode/b4, 5 sessions listed, one of them
  archived/unarchived twice) are harmless — resumable or archivable
  via the new cap.

### B5 — prompt.output_schema (structured output, client tool + ajv) (2026-11-23)

- **Daemon convention retained** (investigation in the installed daemon): the
  opencode v2 provider publishes the validated value on the timeline item of the
  **tool_call named `paseo_structured_output`** (first completed
  submission), under **`metadata.paseoStructuredOutput`**
  (`providers/opencode/v2/structured-output.js` l.17-20: `part.state.metadata?
  .paseoStructuredOutput`, validated by an assert at the end of the turn) +
  an **`assistant_message`** `JSON.stringify(value)`
  (`providers/opencode/v2/timeline.js` l.106-119). On the plugin-provider side the
  daemon passes `tool_call` (metadata included) and `assistant_message`
  through as-is (`plugin-provider.js mapTimelineItem` l.1779-1821): the plugin
  therefore emits BOTH items ITSELF on the accepted tools/call. The turn
  assert (success without a valid submission → failed turn,
  `v2/turns.js` finish() `turn.output?.assert(history)`) is reproduced on the
  session side (`missing_structured_output`).
- **Impl** (`session.ts` + `connection.ts` + `wire.ts`): capability
  `prompt.output_schema` negotiated. At the open of EVERY session: spawn
  `vibe-app-server --additional-builtin-plugin-root <vibe-provider/agent-plugin>`
  (embedded "paseo" builtin plugin, agent-plugins.org 1.0.0 manifest, carrier
  of the namespace) + handshake options `clientTools` (the only way: ephemeral
  processes keep the base) declaring `clientTools:["tools/call"]`,
  `agentPlugins:[{name:"paseo",root}]`,
  `clientToolDefinitions:[{namespace:"paseo",name:"paseo_structured_output",
  generic inputSchema {value:{}}]`. `tools/call` handler (replaces the
  −32601): schema of the active turn (set by the `outputSchema` prompt, cleared
  by a prompt without one / at the end of the turn), validation **ajv@8**
  ({strict:false, allErrors} — same options as the daemon), rejection →
  `{error:{message:"Invalid structured output: <errorsText>",code:
  "invalid_output",details.errors}}` (TOOL error read by the model → retry),
  no request → the opencode error "This turn has no structured-output
  request", acceptance → `{output:"Final structured answer accepted…"}` +
  daemon items (tool_call metadata + assistant JSON), resubmission →
  "already accepted" idempotent (first callId/value kept). The
  `<paseo-structured-output>` guidance block (schema + a
  run_typescript snippet) is appended to the turn text — programmatic
  exposure makes it mandatory (erratum §2.3).
- **E2E** (driver `/tmp/opencode/b5-driver.mts`, direct tsx, mistral-large-4-0
  thinking low, 2 LLM calls):
  1. LLM#1 `outputSchema {res enum ["alpha","beta"]}` "which letter is
     first": the model submits `tools.paseo.paseo_structured_output` in a
     run_typescript program, value **`{"res":"alpha"}` validated on the first
     try** → tool_call `paseo_structured_output` status completed
     `metadata={"paseoStructuredOutput":{"res":"alpha"}}` + assistant_message
     `{"res":"alpha"}`; turn completed ✅. in 20,228 (of which 12,800 cached) /
     out 109 → **$0.00632**.
  2. LLM#2 impossible schema `{res enum ["zzz"]}` on "which letter is
     first": the model ETHICALLY REFUSES to submit a wrong value
     (reasoning: "the schema enum forces a wrong answer… I'll decline"),
     the turn ends WITHOUT a call → assert → turn **failed
     missing_structured_output** + prompt_result failed, no deadlock
     (the 60 s watchdog not reached) ✅. in 10,477 (of which 9,728 cached) / out 178
     → **$0.00226**. The HANDLER's rejection→retry loop not being reached
     by the model (a refusal, not a validation error), it is proven by a
     zero-LLM probe.
  3. Zero-LLM probe (`b5-reject-probe.mts`): ajv rejection → `invalid_output`
     + details.errors, without `value` → shape rejection, without a structured
     request → "This turn has no structured-output request", valid value →
     accepted + metadata + assistant JSON, resubmission → already accepted
     (callId/value unchanged), unknown tool → unknown_client_tool, items
     failed×2 + completed+meta ×1 + assistant ×1 ✅. Plus the zero-LLM open
     smoke (initialize client tools accepted, plugin materialized — skill
     `paseo:paseo-structured-output`).
- **Tokens/cost** (2 calls): in 30,705 (of which 22,528 cached) / out 287 →
  **$0.00858** (real prices 0.7/2.1/0.07).
- **Assumed divergences**: (a) the structured turn's assistant text is NOT
  removed from the timeline (opencode removes it daemon-side
  `v2/timeline.js` textPart; the plugin-provider has no daemon-side
  equivalent, we keep the model trace visible — the canonical value remains
  metadata + assistant JSON); (b) post-revert replay: the client tool's
  items are NOT in the vibe history (client tool calls via
  run_typescript create no effect entry) → the published value does not
  replay on resume (the orchestrator reads at turn time, not at
  revert; noted for B6 if needed).
- Errata recorded in `docs/app-server-protocol.md` §2.3: modelAccess
  absent from the wire (extra=forbid), programmatic exposure (callable only
  via `tools.<ns>.<name>` inside run_typescript), binding = agentPlugins +
  builtin plugin (`--additional-builtin-plugin-root`), exact shapes of
  `tools/call` (params + ClientToolCallResponse + tools/cancel
  notification), 600 s timeout.
- Cleanup: no paseo agent created (direct driver), nothing to delete;
  the test vibe ghosts (cwd /tmp/opencode/b5, 3 sessions: 1 smoke + 2 LLM
  turns) are harmless.

### B6 — timeline fidelity: todo/worktree/process/user_question/scratchpad, §4.4 resync, compaction, structured replay (2026-11-23)

- **Effect mapping** (`session.ts toolCallDetail/timelineItemFor`, shapes
  verified in `vibe/app_server/_effect_models.py` + the projectors, errata
  §4.2 recorded): `todo` → **ProviderTimelineItem type "todo"** (NOT tool_call;
  items text/completed/status/id — the state lives in `detail.input.todos`
  from the write's addition, then in the authoritative `state.output.todos`
  `TodoEffectOutput` at completion; `cancelled` → completed:false without
  status, the Paseo enum doesn't know it); `worktree` → `worktree_setup`
  (path/branch from `detail.input`, progress phase+counts in the log,
  `commands: []` — vibe does not expose the git commands, required field
  left empty); `user_question` → `plain_text` (questions+options
  reformatted, the user_input callback goes out separately as a
  permission); `process`/`scratchpad` → `plain_text`
  (square_terminal/pencil, text output or files); the catch-all MCP
  `tool` keeps `unknown` BUT input/output as compact JSON when
  not a string. **Todo dedup**: consecutive state signature — an identical
  write (input then output of the SAME entry) does not emit 2 cards
  (omp pattern `emitTodoItem`; daemon-side, an emitted todo item is a new
  card, not an upsert).
- **§4.4 resync by eventId gap**: the real resync implemented — `session/read
  {sessionId, history:{limit:500}, turns:{limit:500}}` → `applyStateReplacement`
  (rebuild entries/tokenUsage/lastEventId + reconciliation of the missed turns)
  → **surgical emission**: added entries (never seen) go out alone; MODIFIED
  ones go out again ONLY if a turn is ACTIVE (daemon merge by callId within the
  same turn, proof `packages/server/src/server/agent/timeline-projection.ts`
  `mergeIdentityEntries`: `existing.turnId !== entry.turnId → null` —
  no cross-turn merge); NEVER re-emitted: todo effects nor structured
  (no merge by id). **Daemon idempotence verified in code**:
  `timelineStore.append` = strict append (no upsert), BUT
  `mapTimelineItem` dedups text items by id (same text → null, prefix →
  suffix only), the projection merges tool_call by `callId`+turnId,
  plugin by pluginId/id. → re-emitting EVERYTHING would duplicate all the
  non-text items; we complete administratively (a "Resynchronised" notice
  with a report) and the diff re-emits only what is missing. A turn missed in
  the gap: `reconcileTurns` replays the closure (approximated footer, exact
  structured assert). Bonus fix: the `entries` map is now SEEDED from the
  re-read state at open (replay OR skip) — without it, the first real gap
  re-emitted the ENTIRE history as "added".
- **Compaction/handoff** (`session/compacted`, `session/contextCleared`):
  `applyStateReplacement` on the notification's `state` (same path as the
  resync, id/usage/entries tracked) + a first-class timeline item
  `{type:"compaction", status:"completed", trigger:"auto"}` (daemon pattern:
  claude `compact_boundary`/codex) + notice. Tested by proxy (path shared
  with the resync, the trigger does not occur in the tests).
- **Structured output replay (B5-c surprise resolved)**: the submitted
  value (tools/call `paseo_structured_output`) does not exist in the
  vibe history. Per-turn memory `turnId → {value, callId}` (bounded to 16
  turns) **carried in the persistence** (`data.structuredOutputs` —
  a daemon reload = a new plugin process, the RAM memory would be lost);
  at open with `history:"replay"` (the ONLY moment the daemon rebuilds its
  timeline: `hydrateTimelineFromProvider` after rewind / agent
  reload), we re-emit the `metadata.paseoStructuredOutput` tool_call +
  the JSON assistant_message for each replayed-history turn. NO
  replay at mid-session resync: tools/call is a REQUEST (insensitive to
  eventId gaps), the items went out live → re-emitting would create
  duplicates (append-only store).
- **Reasoning summaries** (task 5): empty `text` + non-empty `summary[]` →
  text = joined summaries ("• " per item).
- **E2E** (driver `/tmp/opencode/b6-driver.mts`, direct tsx, mistral-large-
  4-0 thinking low, 2 LLM calls, PASS on the first try):
  1. LLM#1 "todo list 3 items (alpha/beta/gamma), mark the 2nd done,
     reply TODO-OK": turn completed; **2 items type "todo" emitted — 2
     waves: (1:pending, 2:pending, 3:pending) then (1:pending,
     2:COMPLETED, 3:pending)** ✅; NO "unknown"/todo tool_call for the
     effect; answer TODO-OK. in 30,111 (of which 22,528 cached) / out 197 →
     $0.0073.
  2. **Resync (0 LLM)** — driver-only debug input `session.debug {op:
     "simulate-gap", drop:6}` (the daemon cannot produce this input:
     strict ProviderInputSchema): drop of the 5 entries of the local
     tracking + session/read resync → 5 items re-emitted, **ALL ids known,
     identical payload (full text tolerated: daemon suffix-dedup), no
     unknown id, a single "Resynchronised" notice**, live session (can_stop
     true afterwards) ✅. The 2 todo waves re-emitted here are NOT daemon
     duplicates in a real gap: the plugin is the only timeline path, the lost
     notifications never produced items.
  3. LLM#2 outputSchema {word} "KIWI": first-try submission →
     completed tool_call + metadata `{"word":"KIWI"}` + assistant JSON +
     **enriched persistence `structuredOutputs{turnId:{value,callId}}`** ✅.
     in 21,175 (of which 19,968 cached) / out 158 → $0.0026.
  4. **Simulated daemon reload (0 LLM)**: close → reopen {persistence,
     history:"replay"} → 10 items replayed including the 2 todo waves **with
     final status** AND the structured tool_call re-emitted with
     exact metadata.paseoStructuredOutput + assistant JSON ✅ (daemon
     replayBinding after rewind/reload: the store is reseeded with our items).
- **Zero-LLM smoke** (`/tmp/opencode/b6-smoke.mts`: replay of the B5 ghost
  session + simulate-gap): PASS×2 (before and after the entry-seeding
  fix). Clean strict typecheck.
- **Tokens/cost** (2 calls): in 51,286 (of which 42,496 cached) / out 355 →
  **$0.00987** (real prices 0.7/2.1/0.07).
- Cleanup: no paseo agent created (direct driver); the test vibe ghosts
  (cwd /tmp/opencode/b6, 1 b6 session; the smoke replays the B5 ghost
  read-only) are harmless.

### B7 — provider icon + installation.checkForUpdates (PyPI) + update (uv tool upgrade) (2026-11-23)

- **Icon**: `vibe-provider/icon.svg` (410 B) — the pixelated "V" of the vibe
  logo (ASCII block from the mistral-vibe README, 18×9 grid recentered in
  an 18×18 viewBox), monochrome `fill="currentColor"` +
  `shape-rendering="crispEdges"` (goose-provider pattern); declared
  `icon: "icon.svg"` in the ProviderRegistration (path relative to the
  plugin's folder, cf. goose), `"icon.svg"` added to the `files` of
  package.json. Fidelity verified pixel by pixel against the source ASCII
  block; well-formed XML (ElementTree parse), 410 B < 3 KB.
- **Impl**: new `server/installation.ts` (`createVibeInstallation()`;
  `provider.ts` relieved of the inline inspect, imports cleaned up). (1)
  `inspect` unchanged in behavior (`vibe --version` via execCommand,
  15 s timeout). (2) `checkForUpdates`: `installedVersion` from the context
  when present, otherwise self-inspect via the same path; PyPI source of
  truth `https://pypi.org/pypi/mistral-vibe/json` (`info.version`), 10 s
  fetch (`AbortSignal.any` of the context signal + timeout), HTTP≠2xx or
  JSON without a version → `unknown` with a message (no crash on invalid
  JSON); PEP 440-light decimal comparison (numeric segments, `3.1.4 > 3.1`,
  non-numeric segments lexicographically): greater →
  `{status:"available", versions:[latest]}`, otherwise `{status:"current"}`.
  (3) `update`: `uv tool upgrade mistral-vibe` via `spawnProcess` (stdio
  pipe), stdout/stderr streamed live to `report({type:"stdout"|
  "stderr"})` + initial report message; 120 s watchdog guardrail →
  `terminateProcess`; timeout/abort/non-zero exit → `failed` with message;
  success → re-inspect → before/after version message. Caveat logged
  BEFORE execution (a single `console.warn` line): uv replaces the tool's
  venv, the vibe processes already spawned by the daemon keep the old
  version until they die — a direct spawn suffices (~30 s realistic max;
  under systemd, a transient job suits long updates).
- **E2E** (driver `/tmp/opencode/b7-installation-driver.mts`, direct tsx
  plugin, zero LLM):
  1. `inspect` → `{"status":"installed","version":"3.1.4"}`.
  2. `checkForUpdates` without installedVersion (self-inspect) → `current`;
     with 3.1.4 → `current` (PyPI = 3.1.4, up to date); with 0.0.1 injected →
     `{"status":"available","versions":["3.1.4"]}`; aborted signal →
     `unknown` with message (no crash).
  3. REAL `update` executed ONCE (no active vibe process verified
     beforehand via pgrep): `uv tool upgrade mistral-vibe` → "Nothing to
     upgrade" stderr streamed to the report, exit 0 →
     `{"status":"succeeded","message":"mistral-vibe 3.1.4 (already the
     latest PyPI release)"}`; version BEFORE = AFTER = 3.1.4 (latest
     PyPI release — no unsolicited change).
- **Checks**: strict typecheck 0 errors; `paseo plugin reload vibe-provider`
  OK (running); `paseo provider ls` → vibe `available` (the icon does not
  appear there in the CLI but breaks nothing).
- **Tokens/cost**: 0 LLM calls → **$0.00**.
- Cleanup: no paseo agent created (direct driver, no vibe spawn); uv
  changed nothing ("Nothing to upgrade"), the `vibe` binary re-tested at
  3.1.4 afterwards.

### B8 — permission.tool_policy: MCP preapprovals auto-approved provider-side (2026-11-24)

- **Daemon investigation (zero LLM)**: `config.toolPolicy` =
  `{preapproved:[{kind:"mcp", server, tool}]}` where `server` = a key of
  the SAME request's `config.mcpServers` (validation `agent-manager.js`
  `validateToolPolicyServers`, explicit error otherwise); the daemon passes the
  toolPolicy as-is to the plugin (`plugin-provider.js mapSessionConfig`) BUT
  requires the `permission.tool_policy` capability negotiated as soon as a
  session.open carries one (`requiredProviderCapabilities` → "Provider does
  not support permission.tool_policy" before any dispatch). Plugins receive
  `supportsExactMcpPreapproval: true` by default
  (`createPluginProviderDefinition`). The internal MCP bridge goes through a
  server named **`"paseo"`**
  (`PASEO_MCP_SERVER_NAME`, runtime-mcp-config.js)** injected as http type
  (`?callerAgentId=…`) when `mcp.injectIntoAgents` — so an orchestrator's
  grants for the 42 orchestration tools are
  `{server:"paseo", tool:"list_providers"}` etc. The daemon does NOT build a
  toolPolicy itself (hub/daemon-executions and stored agent configs
  carry it). Materialization at the first-class providers: opencode →
  permission rule `allow` `${server}_${tool}` pattern `*`; claude →
  `mcp__${server}__${tool}`; codex → internal config.
- **Vibe investigation**: the toolName of an MCP approval callback is
  `{group}.{tool}` (§5.2 — `_session.py` `gated_tool_name` +
  `_projection.py:2075`), group = `mcp_{normalized segment of the server}`
  (`_mcp_naming.py`) → server "paseo" + "list_providers" =
  `mcp_paseo.list_providers` (confirmed by B4b observation). NO per-tool
  allowlist on the vibe config side (`_MCPBase`: name/prompt/timeouts/disabled
  only — no bypass/approvalMode per tool) → **provider-side**
  implementation (the only place where the approvals rail is visible).
  The default `accept-edits` policy "asks for every MCP tool"
  (`_vibe_bot_tools.py`) → deterministic callbacks, no classifier.
- **Impl** (`session.ts`): (1) capability `permission.tool_policy` added
  to SESSION_CAPABILITIES (negotiated at connect — the daemon offers
  the full PROVIDER_CAPABILITIES). (2) `preapprovedToolKeys(server, tool)`:
  reproduces vibe's normalization (`_normalize_segment`/`_normalize_identifier`
  — non-identifier → `_`, leading digit → `_` prefix) → key
  `mcp_<server>.<tool>` + raw spelling as fallback; the vibe-digested
  collision cases (2 homonymous servers after normalization) fall back to
  human approval — conservative fallback. (3) `AgentSession` memorizes
  the set at open (raw grants from config.toolPolicy) and logs
  `toolPolicy: N preapproved key(s)`. (4) `handleCallback` kind
  "approval": toolName ∈ set → **auto-decision `approve_for_session`**
  (direct `callback/result`, ack already done, pathScope "exact" if choices,
  `feedback:null`), log `tool mcp_demo.echo auto-approved (toolPolicy)`,
  NO `session.permission` emitted; any other approval → human flow
  intact. `approve_for_session` (≠ `approve`) makes vibe retain the grant
  FOR ITS session: later calls of the same tool no longer re-callback at
  all. Children go through the same handler → **free root-set
  inheritance** (an unattended's toolPolicy covers its subagents).
- **E2E** (driver `/tmp/opencode/b8-policy/b8-driver.mts`, direct tsx plugin,
  mistral-large-4-0 thinking low, **1 LLM call**; zero-LLM smoke
  `b8-smoke.mts` beforehand):
  1. Smoke (0 LLM): capability negotiated ✅, session.open with
     `toolPolicy {preapproved:[{kind:"mcp",server:"demo",tool:"echo"}]}` +
     fake stdio MCP "demo" (1 tool `echo`, a single process) accepted
     (strict SDK schema) ✅, preapproval log ✅, injection + MCP DISCOVERY
     proven by the fake server's trace (initialize + tools/list) ✅,
     default `accept-edits` policy confirmed.
  2. Single turn: "call mcp_demo.echo("policy"), create a tmpfile then
     `rm -f tmpfile`, end with POLICY-OK". The model calls
     `tools.mcp_demo.echo` → **plugin log `tool mcp_demo.echo
     auto-approved (toolPolicy)`, ZERO session.permission for this tool**,
     completed effect output `ok: policy` (`_meta.approval.decision:
     "execute"` wire-side) ✅; **negative control in the same turn**
     `file_system.bash` (printf/rm) → session.permission EMITTED (title
     "Approve file_system.bash") → the driver approves it manually
     (behavior allow) → command executed (tmpfile created then deleted,
     stderr "No such file or directory" observed by the model itself) ✅;
     final answer POLICY-OK ✅. NB: `rm -f tmpfile` rather than the
     mission's `echo p` for a DETERMINISTIC control (the accept-edits
     resolver might auto-grant an innocent `echo`; `rm` is phase-2
     probe-validated as always-asked).
  3. Driver artifact (not a plugin defect): the echo tool_call item is
     emitted TWICE (entryAdded running then entryUpdated completed — same
     id, merged daemon-side by callId within the same turn); the first
     draft of the counter counted 2 calls → counting deduplicated by
     unique id, corrected (1 real call). Not re-run: the run already
     proved the functional assertions, a 2nd LLM call would have violated
     the budget.
- **Tokens/cost** (1 turn, 4 steps including search_tool_functions at
  startup): in 52,252 (of which 43,520 cached) / out 338 → **$0.00987**
  (manual recomputation @0.7/2.1/0.07 identical to the plugin's count to
  within a fraction of a cent: $0.0098686).
- **Parity closure**: all Paseo v1 provider capabilities are
  covered EXCEPT `session.revert.files` (impossible vibe-side: file
  rewind without truncating the conversation does not exist — see B4,
  capability deliberately not negotiated) and `timeline.plugin` (timeline
  items with a plugin-rendered payload: vibe exposes no equivalent
  concept, the effects remap onto the provider schema's native types —
  out of scope, not negotiated).
- Cleanup: no paseo agent created (direct driver); the test vibe ghosts
  (cwd /tmp/opencode/b8-policy, 2 sessions: 1 smoke + 1 turn) are
  harmless — resumable or archivable via the B4 cap.

- **Approval UI fix (2026-11-27)**: persistent permission tile + infinite
  spinner after approval — the provider never emitted
  `session.permission_resolved` (the confirmation expected by the daemon
  after forwarding the response; cf. translatePermissionResolution →
  agent.pendingPermissions.delete). Three paths: successful manual
  response, server-side resolution (entry callback answered/cancelled/
  expired, root+child), memorization of the request's Paseo session.
  Validated e2e: empty PendingPermissions, wait returns the response,
  turn completed. Cost: 2 LLM runs (~$0.02). OPS note (installation
  managed from git): local changes do not run — commit + push then
  `paseo plugin update vibe-provider --ref main --yes`.
