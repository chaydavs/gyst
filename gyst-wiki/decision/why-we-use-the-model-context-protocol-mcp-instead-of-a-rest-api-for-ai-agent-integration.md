---
type: decision
confidence: 0.87
last_confirmed: '2026-04-12T16:34:45.078Z'
sources: 4
affects:
  - src/mcp/server.ts
  - docs/decisions/mcp-vs-rest.md
tags:
  - mcp
  - rest
  - api
  - decision
  - ai-integration
  - claude-code
---
# Why we use the Model Context Protocol (MCP) instead of a REST API for AI agent integration

Decision made 2024-Q2: MCP chosen over a custom REST API because: (1) Claude Code and Cursor have native MCP support — using MCP means zero custom integration code in the AI client; (2) MCP's tool schema system provides type-safe parameter passing that REST requires manual validation for; (3) MCP's streaming response support handles long-running search operations better than polling; (4) MCP is becoming the de facto standard for AI tool integration. REST API is still exposed for human-facing CLI use. If MCP adoption stalls, REST fallback is already implemented.

## Evidence

**Affected files:**
- `src/mcp/server.ts`
- `docs/decisions/mcp-vs-rest.md`

**Sources:** 4
