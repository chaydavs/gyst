---
name: self-hosted-compat
description: Tests Gyst compatibility with self-hosted LLMs running through Ollama, vLLM, and OpenCode. Use when the user mentions "self-hosted," "local LLM," "Ollama," "vLLM," "OpenCode," "private," or "on-premise." Also use when testing MCP compatibility across different clients.
allowed-tools: Bash, Read, Write, Grep
---

# Self-Hosted LLM Compatibility Testing

Gyst must work with models that have NO memory features.
These users have the smallest context windows and the greatest need.

## Target Users

- Model: Qwen2.5-Coder, Devstral, Llama 3.3, DeepSeek V3 (via Ollama or vLLM)
- Context: 4K–128K tokens (Ollama defaults to 4K unless configured)
- Memory: zero. No CLAUDE.md equivalent, no auto-memory, nothing.
- Tools: OpenCode, Continue.dev, Aider, Cline (some support MCP)
- Infrastructure: Local GPU or company GPU server

## Compatibility Test Matrix

### Test 1: MCP stdio handshake
```bash
printf '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"opencode","version":"0.1"}},"id":1}\n' | bun run src/mcp/server.ts
```
Must respond with server capabilities including all 7 tools (learn,
recall, conventions, failures, activity, status, feedback).

### Test 2: Recall response fits in 4K context
Ollama default context is 4096 tokens. Gyst recall must return useful
results within ~2000 tokens (leaving room for system prompt + query +
model response).

```typescript
import { countTokens } from "./src/utils/tokens.ts";
const response = /* simulated recall output */;
const tokens = countTokens(response);
// Assert tokens < 2000 for compact mode
```

### Test 3: MCP HTTP with generic auth
```bash
bun run src/server/http.ts &
SERVER_PID=$!

curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer test-key" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

kill $SERVER_PID
```

Should return tool list regardless of backend model.

### Test 4: Tool responses are model-agnostic
Verify recall output doesn't use Claude-specific formatting
(no XML tags, no `<thinking>` blocks). Plain markdown that any
model can parse.

## Compact Mode for Small Context Windows

Add a `context_budget` parameter to the recall tool:

```typescript
const RecallInput = z.object({
  query: z.string(),
  context_budget: z.number().min(500).max(10000).optional().default(5000),
  // ... other fields
});
```

When `context_budget < 2000`:
- Return only top 3 results instead of 5
- Truncate each entry to title + first 2 sentences + fix (if error_pattern)
- Skip evidence section
- Skip related entries

When `context_budget < 1000`:
- Return only top 1 result
- Title + fix only, no explanation

## Integration Guide Snippets

### Ollama + OpenCode
```json
// opencode.json
{
  "mcpServers": {
    "gyst": {
      "command": "gyst",
      "args": ["serve"]
    }
  }
}
```

### Continue.dev + Ollama
Add MCP server in Continue settings, point at local Gyst binary.
Local model now has team memory.

### Any OpenAI-compatible endpoint (vLLM, LM Studio)
Gyst's HTTP server works with any client that supports MCP
Streamable HTTP transport:
- Local: `http://localhost:3000/mcp`
- Team shared: `https://your-server/mcp` with Bearer token

## Real-World Validation Checklist

If Ollama is available:

```bash
ollama pull qwen2.5-coder:7b
gyst serve &

# Test a tool call directly
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"recall","arguments":{"query":"authentication error"}},"id":1}'
```

Key validation: does the recall response make sense to a 7B model?
Smaller models need simpler, more direct context. If recall returns
3 paragraphs of explanation, a 7B model might ignore it. Test with
compact mode and verify the model uses the information correctly.

## What NOT to Assume

- Don't assume the client supports MCP. Many self-hosted tools don't.
- Don't assume context is ≥ 32K. Ollama defaults to 4K.
- Don't assume the model follows Claude-specific conventions.
- Don't return markdown tables — many small models can't parse them.
- Don't use emoji or Unicode — breaks some tokenizers.
