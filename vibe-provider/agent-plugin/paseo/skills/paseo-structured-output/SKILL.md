---
name: paseo-structured-output
description: Submit a turn's final answer as structured (JSON Schema) output through the paseo_host.paseo_structured_output client tool, inside a run_typescript program.
---

# Paseo structured output

When the current turn asks for a structured final answer (the user message carries a
`<paseo-structured-output>` block with a JSON Schema), submit your complete final
answer by calling the client tool `paseo_host.paseo_structured_output` from a
`run_typescript` program:

```typescript
async function main() {
  const result = await tools.paseo_host.paseo_structured_output({
    value: { /* your complete final answer */ },
  });
  return result;
}
```

`value` must satisfy the JSON Schema given in the block exactly. The tool validates
it and answers: an error means the value was rejected — fix the reported problems
and call it again. Once the tool accepts the submission, end the turn immediately
without additional text or tool calls. Do not answer the structured question in
plain prose.
