---
name: enforce-uniformity
description: Enforces code uniformity across the entire Gyst codebase. This skill activates on EVERY file edit in src/. It checks patterns, naming, imports, error handling, logging, and database access. Use when writing, reviewing, or modifying any TypeScript file. Auto-activate always.
allowed-tools: Read, Grep, Glob, Bash
paths: "src/**/*.ts, tests/**/*.ts"
---

# Gyst Code Uniformity Rules

CHECK THESE ON EVERY FILE EDIT. Not sometimes. Every time.

## Before Writing Any Code

1. Read 2-3 existing files in the same directory to match their exact style
2. Check the import order of the nearest file — match it
3. Check how errors are handled in the nearest file — match it
4. Check how logging is done in the nearest file — match it

## Function Pattern

Every public function follows this shape:

```typescript
/**
 * What this function does and why it exists.
 * @param name - description
 * @returns description
 */
export function functionName(param: ParamType): ReturnType {
  // 1. Validate input
  // 2. Core logic
  // 3. Log result
  // 4. Return typed result
}
```

No exceptions. If a function does not follow this, fix it.

## Error Handling

The only acceptable pattern:

```typescript
try {
  // operation
} catch (error) {
  logger.error("what failed in human words", { operation: "functionName", error });
  throw new GystError("user-facing message", "ERROR_CODE");
}
```

NEVER: bare `throw new Error()`. NEVER: `catch (e: any)`. NEVER: empty catch blocks.
ALWAYS: use error types from `src/utils/errors.ts`.

## Import Order

```typescript
// 1. Node/Bun built-ins
import { existsSync } from "fs";
import { join } from "path";

// 2. External packages
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// 3. Internal modules
import { initDatabase } from "../store/database.js";
import { logger } from "../utils/logger.js";

// 4. Types only
import type { Database } from "bun:sqlite";
import type { KnowledgeEntry } from "../compiler/extract.js";
```

Blank line between each group. Alphabetical within groups.

## Database Access

The only acceptable patterns:

```typescript
// READ one row
const row = db
  .query<RowType, [string]>("SELECT ... WHERE id = ?")
  .get(id);

// READ multiple rows
const rows = db
  .query<RowType, [string]>("SELECT ... WHERE type = ?")
  .all(type);

// WRITE
db.run("INSERT INTO ... VALUES (?, ?)", [val1, val2]);

// TRANSACTION for multi-table writes
db.transaction(() => {
  db.run("INSERT INTO entries ...", [...]);
  db.run("INSERT INTO entry_files ...", [...]);
})();
```

ALWAYS type the row shape AND param tuple in `db.query<Row, Params>(...)`.
NEVER build SQL with template literals.

## Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `git-hook.ts` |
| Functions | camelCase | `searchByBM25` |
| Classes | PascalCase | `GystError` |
| Constants | UPPER_SNAKE | `HALF_LIVES` |
| Types/Interfaces | PascalCase | `EntryType` |
| DB columns | snake_case | `source_count` |
| Frontmatter keys | snake_case | `last_confirmed` |
| Test descriptions | lowercase sentence | `"returns empty array for no matches"` |

## Logging

```typescript
logger.info("what happened", { key: "value" });
logger.error("what failed", { operation: "name", error });
logger.debug("detail for dev only", { data });
```

NEVER use the console directly. NEVER log entry content that might contain user code.
ALWAYS include operation name in error logs.

## Tests

Every test file follows this structure:

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

describe("moduleName", () => {
  beforeAll(() => { /* setup */ });
  afterAll(() => { /* teardown */ });

  describe("functionName", () => {
    test("describes expected behavior in lowercase", () => {
      // arrange
      // act
      // assert
    });
  });
});
```

## When You Find a Violation

1. Fix it immediately — do not leave it for later
2. Check if the same violation exists in other files in the same directory
3. If it does, fix all of them in the same edit
4. Log what you fixed in `.claude/memory/MEMORY.md` under "What Worked"

## Automated Checks

CI enforces (`.github/workflows/ci.yml`):

- `bun run lint` — zero TypeScript errors (strict mode catches `any`)
- `bun test` — all tests pass
- grep for direct console usage in `src/` — fails if found
- grep for secrets in `src/` — fails if found
