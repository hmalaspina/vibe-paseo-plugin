// Embedded "paseo" agent plugin (structured output, B5): materialized at a
// STABLE home path instead of being resolved via import.meta.url — the
// daemon evaluates the compiled bundle (bundle-evaluator + eval), where
// import.meta.url is not a valid URL → "Invalid URL" on every session.open.
// Idempotent + memoized per process; the source of truth for the CONTENTS
// is here (the agent-plugin/ files serve as a readable reference).

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_MANIFEST = `{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "paseo_host",
  "version": "1.0.0",
  "description": "Paseo host integration: structured-output submission for orchestrators.",
  "author": {
    "name": "Paseo"
  },
  "extensions": {
    "ai.mistral.vibe": {
      "schemaVersion": 1,
      "toolNamespace": "paseo_host"
    }
  }
}
`;

const SKILL = `---
name: paseo-structured-output
description: Submit a turn's final answer as structured (JSON Schema) output through the paseo_host.paseo_structured_output client tool, inside a run_typescript program.
---

# Paseo structured output

When the current turn asks for a structured final answer (the user message carries a
\`<paseo-structured-output>\` block with a JSON Schema), submit your complete final
answer by calling the client tool \`paseo_host.paseo_structured_output\` from a
\`run_typescript\` program:

\`\`\`typescript
async function main() {
  const result = await tools.paseo_host.paseo_structured_output({
    value: { /* your complete final answer */ },
  });
  return result;
}
\`\`\`

\`value\` must satisfy the JSON Schema given in the block exactly. The tool validates
it and answers: an error means the value was rejected — fix the reported problems
and call it again. Once the tool accepts the submission, end the turn immediately
without additional text or tool calls. Do not answer the structured question in
plain prose.
`;

let cachedRoot: string | null = null;

/**
 * Writes (idempotently) the embedded agent plugin under
 * ~/.paseo/runtime/vibe-provider/agent-plugin/paseo and returns that path.
 * The PARENT of that folder is passed to the launch --additional-builtin-plugin-root.
 */
export function materializeEmbeddedAgentPlugin(): string {
  if (cachedRoot) return cachedRoot;
  const root = join(homedir(), ".paseo", "runtime", "vibe-provider", "agent-plugin", "paseo");
  mkdirSync(join(root, "skills", "paseo-structured-output"), { recursive: true });
  writeFileSync(join(root, "plugin.json"), PLUGIN_MANIFEST);
  writeFileSync(join(root, "skills", "paseo-structured-output", "SKILL.md"), SKILL);
  cachedRoot = root;
  return root;
}
