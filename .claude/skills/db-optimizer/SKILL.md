---
name: db-optimizer
description: Optimizes SQLite queries, schema design, and FTS5 usage for the Gyst knowledge base. Use when writing database queries, modifying schema, debugging slow searches, or when the user mentions "slow," "performance," "query," "index," or "database."
allowed-tools: Read, Grep, Glob, Bash
paths: "src/store/**/*.ts"
---

## Query Optimization Rules
1. Always use prepared statements (db.prepare()) — they're cached and faster than db.query()
2. Use EXPLAIN QUERY PLAN to verify indexes are being used
3. For FTS5 BM25 queries, always specify column weights: `bm25(entries_fts, 10.0, 5.0, 1.0)`
4. Limit all SELECT queries. Never return unbounded results. Default LIMIT 100.
5. Use covering indexes when possible

## FTS5 Specific
- The porter tokenizer handles English stemming but mangles code identifiers
- ALL text must pass through codeTokenize() before FTS5 insertion
- FTS5 special characters that must be escaped in queries: " * ( ) : ^
- Escape function: `query.replace(/[\"*():^]/g, ' ')`
- For prefix searches, append *
- Column filters: `title:authentication` searches only the title column

## Index Strategy
Current indexes:
- idx_entries_type, idx_entries_status, idx_entries_confidence
- idx_entries_error_sig, idx_entry_files_path, idx_entry_tags_tag

Consider adding:
- Composite index on (status, confidence) for filtered recall queries
- Composite index on (type, status) for convention lookups
- Index on sources(entry_id) for join performance

## WAL Mode
```typescript
db.run("PRAGMA journal_mode=WAL");
db.run("PRAGMA busy_timeout=5000");
db.run("PRAGMA synchronous=NORMAL");
db.run("PRAGMA cache_size=-64000");
```

## Performance Targets
- recall() end-to-end: < 500ms
- learn() end-to-end: < 200ms
- FTS5 search over 1000 entries: < 50ms
- Database startup: < 100ms
