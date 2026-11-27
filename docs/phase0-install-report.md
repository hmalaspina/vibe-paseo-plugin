# Phase 0 — Installation & smoke test of mistral-vibe

Date: 2026-11-23 · Environment: Linux without root privileges, uv 0.13.9,
`MISTRAL_API_KEY` provided by the environment (never written to disk or
displayed).

## 1. Installation
- Command: `uv tool install --python 3.14 mistral-vibe` → **succeeded on the first try** (3.12 fallback unnecessary).
- uv downloaded its managed CPython **cpython-3.14.10** (109 MB, `~/.local/share/uv/python/cpython-3.14.10-linux-x86_64-gnu/`).
- Tool venv: **400 MB**, ~95 packages in `~/.local/share/uv/tools/mistral-vibe/`. Notables: mistral-vibe 3.1.4, mistralai 3.5.0, mistralai-vibe-harness 0.1.22, agent-client-protocol 0.11.0, mcp 2.3.0, click, **sentry-sdk + opentelemetry** (telemetry built in → §3), plus a Rust component (log `vibe-rs.log`).
- Binaries (symlinks in `~/.local/bin` → `~/.local/share/uv/tools/mistral-vibe/bin/`): **vibe, vibe-acp, vibe-app-server**.
- ⚠️ `~/.local/bin` may be missing from the daemon's PATH → the plugin must use absolute paths or inject the PATH.
- A missing system `python3` has no impact: uv uses its managed CPython.

## 2. CLI checks
- `vibe --version` → **vibe 3.1.4** (`uv tool list` → `mistral-vibe v3.1.4`).
- Visible subcommands (`vibe --help`): `mcp`, `config`, `help` (+ `update` listed at the end of the help).
- **Hidden**: `vibe run-server` — "Serve many headless runs over JSON-RPC on stdin and stdout (experimental)", options `--max-runs`, `--runs-per-app-server` (default 16).
- **No `app-server` subcommand**: the server is the separate executable `vibe-app-server` (`--multiplex`, `--additional-builtin-plugin-root`), and the ACP mode the executable `vibe-acp` (minimal options: `--version`, `--setup`).
- `vibe config schema`: prints the full JSON schema of `config.toml` (~115 KB) — useful to validate the config on the plugin side.

## 3. Configuration
- File: `~/.vibe/config.toml` (precedence: project `.vibe/config.toml` > user; `VIBE_STRICT_CONFIG=1` for strict mode).
- **`enable_telemetry` defaults to `true`** → file created BEFORE any run (the Sentry crash-reporting and OTLP point to Mistral):
  ```toml
  enable_telemetry = false
  ```
- `enable_otel` is `false` by default (and requires `enable_telemetry`): nothing else to turn off.
- Structure of `~/.vibe/` after the run: `config.toml`, `logs/` (`vibe.log`, `vibe-rs.log`, `session/{active,unified,plugins}`), `trusted_folders.toml`, `vibehistory`, caches (`cache/`, `skills-registry-cache/`, `connector_bootstrap_cache.json`…). No secret stored: the key stays in the env (`api_key_env_var: MISTRAL_API_KEY` in the redacted export).

## 4. Headless smoke test [1 real LLM invocation]
- Command: `vibe --prompt "Réponds uniquement: OK" --max-turns 2 --output json --output-dir /tmp/opencode/vibe-smoke`, cwd `/tmp/opencode`.
- **exit code 0**, duration ~4 s. Stdout = the session's JSON journal (user turn → reasoning → assistant "OK").
- `export.json`: outcome **.finished**, `stop_reason`/`error` null, steps 1, exit_code 0, session `0103b22f-b27d-214a-c523-9b6ea89ba9b7`.
- Model: **mistral-large-4-0** (default; catalog: thinking default "high", hence the light reasoning emitted — `--thinking off` possible).
- Usage: input 8016 (including 3072 cached) / output 18 / **total 8034 tokens** · **cost_usd 0.00371364**.
- `--output-dir` also writes `session/` (chunks, `journal/*.jsonl`, `meta.json`, `context-breakdown.json`) — a stable, parsable structure, usable by a plugin.
- export.json properly redacted: full effective config (models, prices, providers, `enable_telemetry: false` confirmed), no key values.

## 5. Probe vibe-app-server [1 attempt]
- Input: one JSON-RPC line on stdin (`initialize`, `clientInfo paseo-spike 0.0.1`). Immediate stdout response, verbatim:
  ```json
  {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"vibe-app-server","version":"3.1.4"},"processId":54189,"platformCredentials":false}}
  ```
- empty stderr; **exit 0**: the server responds then **exits cleanly on stdin EOF** (8 s timeout not reached, no kill necessary).
- Conclusion: a **JSON-RPC 2.0 line-delimited over stdio** protocol (no LSP `Content-Length` framing), no parsing errors, no stray logs. Very directly consumable by a plugin.

## 6. Points of attention / blockers
- ⚠️ `~/.local/bin` not on PATH (the only real integration point to fix for the plugin).
- `enable_telemetry = true` by default → provisioning `~/.vibe/config.toml` mandatory at install (done; to replicate for any new environment).
- `enable_auto_update = true` by default → risk of a silent version change; consider `enable_auto_update = false` to pin the plugin's behavior.
- Headless works without interaction or trust (cwd `/tmp/opencode`); `default_approval_policy = accept-edits`; useful native guardrails: `--max-turns`, `--max-price`, `--max-tokens`, `--time-limit`, `--approval-policy`, `--agent`.
- **No blocker encountered.**

## 7. Budget consumed
- 1 real LLM invocation (smoke): **$0.0037**. The app-server probe only did an `initialize` handshake (no model call a priori). The other commands (help, version, config schema, greps) are free. The month's credits nearly untouched.
