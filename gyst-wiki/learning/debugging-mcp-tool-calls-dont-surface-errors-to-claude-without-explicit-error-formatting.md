---
type: learning
confidence: 0.88
last_confirmed: '2026-04-12T16:34:45.086Z'
sources: 3
affects:
  - src/mcp/server.ts
  - src/mcp/tools.ts
tags:
  - mcp
  - debugging
  - error-handling
  - claude-code
  - learning
---
# Debugging: MCP tool calls don't surface errors to Claude without explicit error formatting

When an MCP tool throws an unhandled exception, Claude Code receives a generic 'tool execution failed' message with no details. Developers can't debug from this. Fix: wrap all MCP tool handlers in try-catch and return structured error content: `return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, code: err.code }) }], isError: true }`. This surfaces the actual error in Claude's tool response. Also set `isError: true` so Claude knows the call failed and can retry with corrected parameters.

## Evidence

**Affected files:**
- `src/mcp/server.ts`
- `src/mcp/tools.ts`

**Sources:** 3
