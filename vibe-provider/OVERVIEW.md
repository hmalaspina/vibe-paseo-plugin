# Mistral Vibe provider

This plugin adds Mistral Vibe, the open source coding agent by Mistral, as an
agent provider in Paseo. A Paseo agent created with the "vibe" provider runs a
real Vibe session in your workspace: same models, same approval policies, same
project context (AGENTS.md, skills) as the Vibe CLI.

It talks to Vibe through its native `vibe-app-server` protocol, the same
JSON-RPC over stdio surface the Mistral desktop app uses, so sessions stream
live, changes apply mid-session, and approvals surface in Paseo. It does not
shell out through the one-shot programmatic mode.

## Setup

- Paseo daemon 0.17.3 or newer.
- Mistral Vibe 3.1 or newer installed and on PATH, for example
  `uv tool install mistral-vibe`. If Vibe's Python tool directory is not on the
  daemon's PATH (uv installs binaries to `~/.local/bin`), the plugin also looks
  there, or you can point the provider command at the absolute path of
  `vibe-app-server` in Paseo provider settings.
- A Mistral API key in the daemon's environment as `MISTRAL_API_KEY`, or a
  signed-in Vibe profile. The provider reports a clear diagnostic in its status
  when the key is missing.

## Capabilities and status

This is an early build. It registers the provider, reaches the app-server,
publishes the model and agent catalog (models, thinking levels, agent profiles,
defaults read from your Vibe config), and reports installation and health
status. Sessions open, prompts, and approvals land over the next milestones;
until then the provider negotiates no session capabilities, so Paseo will refuse
to create agents with it rather than half-work.

Known limits: one connection addresses one root session (one app-server process
per conversation); event replay is not implemented yet (Vibe exports no replay,
the provider keeps its own event state); telemetry stays off, the plugin never
touches your Vibe config.

## Structured output (prompt.output_schema)

When a prompt carries an `outputSchema`, the turn requires a schema-validated
structured answer, the convention Paseo orchestrators read: the plugin declares
the client tool `paseo.paseo_structured_output` over the app-server connection
(capabilities `clientTools: ["tools/call"]` + `clientToolDefinitions`, with the
embedded built-in plugin `agent-plugin/paseo`, materialized per session through
the `--additional-builtin-plugin-root` launch argument), the model submits its
final answer through that tool, and the plugin validates it with ajv: a bad
value is a tool error the model reads and fixes; an accepted value is published
on the turn's timeline as a `paseo_structured_output` tool call carrying
`metadata.paseoStructuredOutput`, plus the JSON value as an assistant message.
A turn that ends successfully without a valid submission is marked failed. The
client-tool surface of the wire is programmatic-only (no `modelAccess` on the
wire), so the model calls the tool from a `run_typescript` program
(`tools.paseo.paseo_structured_output({ value })`).
