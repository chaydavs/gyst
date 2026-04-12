---
name: code-uniformity
description: Enforces consistent code patterns across the Gyst codebase. Use when writing new code, reviewing changes, or when the user mentions "consistency," "uniformity," "patterns," or "refactor." Auto-activate on any src/**/*.ts file.
allowed-tools: Read, Grep, Glob
paths: "src/**/*.ts"
---

Before writing or approving any code, verify it follows these project patterns. When you find inconsistencies, fix them.

## Function Structure

Every public function in this project follows this pattern:
1. JSDoc comment with @param and @returns
2. Input validation (zod parse or manual checks)
3. Core logic
4. Structured logging on success or failure
5. Return typed result

Check existing functions in the same module to match the exact style. If src/store/search.ts uses `db.query<Type, Params>(sql).all(...)`, don't switch to `db.prepare(sql).all(...)` in a new function in the same file.

## Error Pattern

All error handling must follow this project's pattern:
```typescript
try {
  // operation
} catch (error) {
  logger.error("descriptive message", { operation: "functionName", error });
  throw new GystError("user-facing message", "ERROR_CODE");
}
```
Never use bare `throw new Error()`. Always use the custom types from src/utils/errors.ts.

## Database Access

All database operations follow this pattern:
```typescript
const rows = db.query<RowType, ParamType[]>(sql).all(...params);
const row = db.query<RowType, ParamType[]>(sql).get(...params);
db.run(sql, params);
```
Never use db.exec() for queries with parameters. Never build SQL strings with template literals.

## Import Order

1. Node/Bun built-ins (path, fs, crypto)
2. External packages (@modelcontextprotocol/sdk, zod, etc.)
3. Internal absolute (../store/database, ../utils/logger)
4. Types (import type { ... })

Blank line between each group.

## Naming

- Files: kebab-case (error-patterns.ts, not errorPatterns.ts)
- Functions: camelCase (searchByBM25, not search_by_bm25)
- Classes: PascalCase (GystError, not gystError)
- Constants: UPPER_SNAKE (HALF_LIVES, not halfLives)
- Types/Interfaces: PascalCase (EntryType, not entryType)
- Database columns: snake_case (source_count, not sourceCount)
- Markdown frontmatter keys: snake_case (last_confirmed)

## Logging

Every significant operation logs:
```typescript
logger.info("what happened", { relevant: "context" });
logger.error("what failed", { operation: "name", error });
logger.debug("detail", { data }); // for development only
```
Never console.log. Never log sensitive data (content of entries is OK, but never API keys, auth tokens).

When you notice a file that doesn't follow these patterns, flag it and offer to fix it.
