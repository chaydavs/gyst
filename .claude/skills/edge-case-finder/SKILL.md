---
name: edge-case-finder
description: Identifies edge cases and boundary conditions that need handling. Use when implementing new features, writing tests, or when the user says "what could go wrong" or "edge cases." Activate when creating or modifying files in src/.
allowed-tools: Read, Grep, Glob
paths: "src/**/*.ts"
---

For every function or feature being built, systematically check these edge cases:

## Input Boundaries
- Empty string inputs to learn() and recall() — what happens?
- Extremely long inputs (5000+ chars for content, 200+ chars for title)
- Unicode, emoji, and special characters in titles, content, tags
- File paths with spaces, dots, hyphens, Windows backslashes
- Queries that are valid FTS5 syntax vs queries that break FTS5 (unmatched quotes, bare AND/OR)
- Zero results from all three search strategies simultaneously
- Negative or zero values for max_results
- Type field with a value not in the enum

## Database Edges
- First-ever query on empty database (no entries, no FTS index content)
- Duplicate entry_id generation (UUID collision, though astronomically unlikely)
- FTS5 index out of sync with entries table (entry deleted but FTS row remains)
- SQLite database file locked by another process
- Database file corrupted or missing (must rebuild from markdown)
- Transaction interrupted mid-write (power loss, process kill)
- Concurrent writes from two MCP server processes

## Knowledge Compilation
- Two entries with identical error signatures but different fixes (genuine conflict)
- An entry that references a file that no longer exists in the repo
- Markdown file with malformed or missing YAML frontmatter
- Confidence score calculation when sourceCount is 0
- Decay calculation when daysSinceLastConfirmed is 0 (just confirmed)
- Entry that has been superseded — should never appear in recall results
- Circular supersession chain (A supersedes B supersedes A)

## MCP Protocol
- Client sends malformed JSON-RPC request
- Client disconnects mid-tool-call
- Tool call with missing required parameters
- Tool call with extra unexpected parameters
- Very rapid sequential tool calls (agent calling learn() 10 times in a loop)
- Initialize request with unsupported protocol version

## Git Hook
- Commit with no changed files (empty commit)
- Merge commit with hundreds of changed files
- Commit message that is empty or just whitespace
- Binary files in the diff (images, compiled assets)
- Git repo in detached HEAD state
- Hook running when gyst-wiki/ directory doesn't exist yet

## File System
- gyst-wiki/ directory doesn't exist on first run
- No write permissions to gyst-wiki/ directory
- Disk full when writing markdown file
- Markdown file with same slug already exists (name collision)

When you find an edge case that isn't handled, add handling code AND a test.
