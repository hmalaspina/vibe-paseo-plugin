# Phase 0 — Spike report (exit criterion met)

**Date**: 2026-11-23 · **Spike**: `spike/vibe-spike.mjs` (~150 lines of Node, zero dependencies)

## Result: 🟢 GO native app-server

A complete turn was captured on the first try, with no protocol error:

```
initialize (vibe-app-server 3.1.4) → initialized → session/start
→ turn/start → 7 types of S→C notifications → turn/completed → session/read → session/stop
→ exit 0
```

Full transcript: `spike/transcript-*.jsonl` (176 KB, one `{"dir":"C→S|S→C",...}` per line).

## Validations

| Hypothesis from `docs/app-server-protocol.md` | Result |
|---|---|
| Framing: 1 JSON/line, camelCase, `extra=forbid` | ✅ no `invalid_params` on minimal params |
| `initialize` → `initialized` (params `{}`) sequence | ✅ |
| `session/start {agentConfig:{cwd,trustWorkspace}}` | ✅ session created, `status=idle` |
| `turn/start {sessionId, message[], idempotencyKey, clientUserMessageId}` | ✅ response `{turn, lastEventId}` |
| Streaming `history/entryAdded/Updated` with JSON patches (`append` op) | ✅ 3 entries (user, reasoning, assistant) + 9 updates |
| `session/updated` carries `tokenUsage` | ✅ final usage: 9621 in / 22 out / 3072 cached |
| `session/stop` → `{closed:true}` then clean exit | ✅ exit 0 |
| Server→client IDs = integers, `callback/call` ack | ⚠️ Not exercised (no tool called) — to test in Phase 3 with a prompt triggering a `bash` |

## Key discoveries for Phase 2

1. **`runtime/updated` = the catalog source**: notification emitted once per session,
   with the complete `runtime.config.activeModel` payload:
   `{name, alias, thinking:"high", thinkingLevels:["low","medium","high"],
     displayName, maxContextLength:1048576, autoCompactThreshold:400000,
     supportsImages, imageDelivery}` → maps 1:1 to
   `ProviderModel` (with `contextWindowMaxTokens` and `ProviderThinkingOption[]`).
2. **`PublicSessionState.session.{model,agent,approvalPolicy}` = null** after
   `session/start` without explicit config: the resolved defaults live only
   in `runtime/updated`. The Paseo provider MUST consume this notification
   (and/or `config/read`) to publish the real model/mode.
3. `session/statsUpdated` (4×): session metrics — candidate for
   `session.metrics` on the Paseo side.
4. `eventId` observed consecutive with no gap across the 32 events
   (a `lastEventId` watermark is viable — but do not forget: no server
   replay, `events/read` is a stub → the provider maintains its own state).

## Nomenclature observed in the transcript

 `session/updated` (14×) · `statsUpdated` (4×) · `runtime/updated` (1×) ·
 `turn/started|completed` · `history/entryAdded|entryUpdated` —
 consistent with doc §4.

## Phase 0 cost

| Item | LLM calls | Cost |
|---|---|---|
| Install + smoke (subagent) | 2 | $0.0037 |
| Spike (this run) | 1 (9,643 tokens) | ~$0.005 |
| **Total** | **3** | **< $0.01**  |
