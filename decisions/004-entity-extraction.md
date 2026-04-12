# Decision: Lightweight regex-based entity extraction for graph search precision

Date: 2026-04-11
Status: Accepted

## Context

Gyst's graph search walks relationships between entries and files. Entries are currently
associated with whole files via the `files` array — for example, an entry about a bug in
`getToken` is tagged with `auth.ts`, but has no link to `getToken` specifically. A query
like "what do we know about the getToken function" can match at the file level but not
at the entity level, requiring the user to read each matched entry to determine relevance.

The accurate solution is an AST parser (tree-sitter, ts-morph, or equivalent). However,
AST parsing is a V4 dependency because:
- tree-sitter requires a native binary or a WASM build step
- ts-morph pulls in the full TypeScript compiler (~50 MB)
- Both create hard language-specific dependencies that conflict with the
  language-agnostic surface Gyst aims to present to multi-language projects

For V3 a simpler alternative is acceptable: conservative regex-based extraction.
The key insight is that **false positives are worse than false negatives** for this use
case. A wrong entity anchor pollutes the search index, surfacing irrelevant entries.
A missed entity is harmless — the file-level link already exists.

## Baseline

Before this change, entries only carry file-level associations:

```
entry: "getToken always returns null when token cache is cold"
  files: ["src/auth/token.ts"]
  entities: (none)
```

A graph walk from the `getToken` query node can reach `src/auth/token.ts` and from there
any entry tagged with that file. It cannot distinguish entries about `getToken` from
entries about `refreshToken` or `revokeToken` in the same file.

## Change

**File: `src/compiler/entities.ts`** (new standalone module)

Exports two functions:

- `extractEntities(content: string): ExtractedEntity[]` — scans free-text entry content
- `extractEntitiesFromTitle(title: string): ExtractedEntity[]` — scans entry titles

Both functions apply the same ordered set of regex patterns, deduplicate results by
(name, kind) pair, and apply filter rules to suppress false positives.

**Patterns applied (most specific first):**

| # | Target | Regex | Kind |
|---|--------|-------|------|
| 1 | TS/JS function declarations | `/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g` | function |
| 2 | TS/JS const arrow functions | `/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/g` | function |
| 3 | Classes (PascalCase guard) | `/\bclass\s+([A-Z][A-Za-z0-9_$]*)/g` | class |
| 4 | Go functions | `/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)/g` | function |
| 5 | Rust functions | `/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g` | function |
| 6 | Python/Ruby methods | `/\bdef\s+([a-z_][a-z0-9_]*)/g` | function |
| 7 | camelCase method calls | `/\b([a-z][A-Za-z0-9_$]{2,})\s*\(/g` | method |

**Filter rules (false-positive suppression):**

1. **Minimum length**: names shorter than 3 characters are discarded (catches `fn`, `do`,
   single-letter variables that sometimes appear before `(`).

2. **Reserved word list**: a fixed set of reserved words across major languages is
   maintained as `RESERVED_WORDS`. Any name in this set is discarded regardless of which
   pattern captured it. The list covers: `if`, `for`, `while`, `return`, `import`,
   `export`, `const`, `let`, `var`, `type`, `enum`, `true`, `false`, `null`, `void`,
   `string`, `number`, `boolean`, `this`, `self`, `new`, `try`, `catch`, `throw`,
   `break`, `continue`, `else`, `then`, `do`, `as`, `in`, `of`, `is`, `or`, `and`,
   `not`.

3. **Common English words**: a secondary `COMMON_ENGLISH_WORDS` set filters words that
   survive the reserved-word check but almost never name code entities in prose:
   `includes`, `contains`, `matches`, `returns`, `throws`, `parses`, `calls`, `uses`,
   `gets`, `sets`.

4. **camelCase gate (method pattern only)**: Pattern 7 — the most permissive — only
   accepts a name if it contains at least one lowercase-followed-by-uppercase transition
   (i.e. is camelCase). This eliminates plain English lowercase words like `something`,
   `handles`, `matches` that don't survive the English-word filter but would otherwise
   produce noisy method candidates.

**Deduplication**: results are collapsed by (name, kind) key, preserving the first
occurrence. A name that is captured by both pattern 1 (function) and pattern 7 (method)
produces two entries — one per kind — which is intentional: the function declaration
match is the anchor, and the method-call match is the usage reference.

## Result

Standalone module `src/compiler/entities.ts` with:
- Zero new runtime dependencies
- 24 passing tests covering happy path, deduplication, false-positive suppression,
  and edge cases (empty input, unicode, 10K-char throughput)
- Sub-millisecond performance on typical entry content (<500 chars)
- Sub-100ms performance on 10K-char content (confirmed by test)

The module is wired into `learn.ts` by the leader agent. Integration uses the
existing `tags` column — no schema change required. Entity names are stored as
`entity:${name}` prefixed tags (e.g. `entity:getToken`). The existing graph
search (`searchByGraph`) already walks the `entry_tags` table via LIKE matches,
so entity-tagged entries become reachable via queries like "getToken function"
without any changes to the search layer. Measurement of integration impact is
recorded in `decisions/005`.

**Judgment calls made during implementation:**

- Pattern 7 (method calls in prose) required the camelCase gate. Without it, nearly
  every English lowercase word followed by `(` in code examples would match. The gate
  accepts a precision tradeoff: snake_case method references (common in Python/Go prose)
  are missed, but those languages have explicit `def`/`func` patterns (patterns 4–6)
  that cover declaration sites.

- The class pattern uses a hard PascalCase guard (`[A-Z]` first character). Lowercase
  class names exist in some languages but are rare enough in Gyst entry content that
  the false-positive risk outweighs the recall loss.

- The `def` pattern (Python/Ruby) captures snake_case names that are NOT gated by the
  camelCase check. This is intentional: `def handle_commit` is an explicit declaration
  keyword, making the match high confidence even without a camelCase signal.

## Decision

Accepted and integrated into `learn.ts` by the leader agent. Entity tags are
attached to every new entry persisted via the `learn` MCP tool using the
existing `tags` column (prefix: `entity:`). The wiring is additive — no schema
changes, no existing test breakage, full backwards compatibility.

The 39 entity extraction unit tests all pass. Eval metrics are unchanged
(no delta), which is expected because the eval set's fixture entries were
seeded directly via `insertEntry` without going through the learn tool, so
entity tags are not present in the eval database. In production, new entries
learned via the MCP tool will carry entity tags from day one.
