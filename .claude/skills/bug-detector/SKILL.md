---
name: bug-detector
description: Detects bugs, logic errors, and unsafe patterns in TypeScript code. Use when writing new functions, reviewing code, fixing errors, or when the user says "check for bugs" or "review this." Auto-activate when editing files in src/.
allowed-tools: Read, Grep, Glob
paths: "src/**/*.ts"
---

When reviewing or writing code in this project, check for these categories:

## Null and Undefined
- Every database query result must be checked for null before access
- Optional chaining (?.) is required when accessing properties of objects that come from external input (MCP tool params, database rows, parsed markdown)
- Never assume arrays from database queries are non-empty

## Async and Concurrency
- Every Promise must be awaited or explicitly handled with .catch()
- Database transactions must use try/finally to ensure rollback on error
- Promise.all() calls must handle partial failures — if one search strategy fails in recall, the others should still return results
- Never fire-and-forget async operations without error handling

## SQLite Specific
- All user input used in SQL must go through parameterized queries (? placeholders), never string concatenation
- FTS5 queries must escape special characters: quotes, parentheses, asterisks, AND/OR/NOT
- WAL mode must be set before any writes
- Foreign key enforcement must be enabled per connection (PRAGMA foreign_keys=ON)
- Transactions must wrap multi-table writes (creating entry + files + tags + FTS index)

## Type Safety
- No `any` types. Use `unknown` with type guards for external data
- Zod schemas must validate all MCP tool inputs before processing
- Return types must be explicit on all public functions
- Union types must be exhaustively handled (use `never` in default case)

## Error Handling
- Custom error types from src/utils/errors.ts, not generic Error
- Never swallow errors silently — at minimum log with logger.error()
- MCP tool handlers must return user-friendly error messages, not stack traces
- Database errors must be caught and wrapped with context about what operation failed

## Resource Leaks
- Database connections must be closed in finally blocks or using disposable patterns
- File handles from fs operations must be closed
- Temporary files must be cleaned up
