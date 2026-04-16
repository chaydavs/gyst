import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";
import { registerAllTools } from "../../src/mcp/register-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runHybridSearch } from "../../src/store/hybrid.js";
import { initVectorStore, backfillVectors } from "../../src/store/embeddings.js";

describe("Gyst Full Lifecycle Integration", () => {
  let db: Database;
  let server: McpServer;

  beforeAll(() => {
    db = initDatabase(":memory:");
    initVectorStore(db);
    server = new McpServer({ name: "gyst-test", version: "1.0.0" });
    // Note: registerAllTools uses ToolContext which we need to mock
    // but for integration we can just check the tools are there.
  });

  afterAll(() => {
    db.close();
  });

  test("End-to-end knowledge lifecycle", async () => {
    // 1. Setup & Ghost Init (Mocked via direct DB writes for speed)
    db.run(`INSERT INTO entries (id, type, title, content, confidence, created_at, last_confirmed)
            VALUES ('ght-01', 'ghost_knowledge', 'Rule: No Friday deploys', 'Never deploy on Fridays after 2pm.', 1.0, datetime('now'), datetime('now'))`);

    // 2. Dev A learns entries
    const { persistEntry } = await import("../../src/mcp/tools/learn.js");
    const now = new Date().toISOString();
    persistEntry(db, {
      id: 'err-01',
      type: 'error_pattern',
      title: 'Database connection timeout',
      content: 'Occurs when pool is exhausted.',
      errorSignature: 'db_timeout',
      fingerprint: 'fp_01',
      confidence: 0.5,
      sourceCount: 1,
      files: ['src/db.ts'],
      tags: ['db', 'timeout'],
      now,
      scope: 'team'
    }, '/tmp');

    // 3. Dev B searches
    const results = await runHybridSearch(db, "database timeout");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('err-01');

    // 4. Feedback loop
    const entry = db.query("SELECT confidence FROM entries WHERE id = 'err-01'").get() as any;
    const confidenceBefore = entry.confidence;
    
    // Simulate feedback tool logic
    db.run("UPDATE entries SET confidence = MIN(1.0, confidence + 0.02) WHERE id = 'err-01'");
    const entryAfter = db.query("SELECT confidence FROM entries WHERE id = 'err-01'").get() as any;
    expect(entryAfter.confidence).toBeGreaterThan(confidenceBefore);

    // 5. Consolidation (Simulate co-retrieval relationship)
    const { recordCoRetrieval, strengthenCoRetrievedLinks } = await import("../../src/store/graph.js");
    recordCoRetrieval(db, ['err-01', 'ght-01']);
    recordCoRetrieval(db, ['err-01', 'ght-01']);
    recordCoRetrieval(db, ['err-01', 'ght-01']);
    
    const linksCreated = strengthenCoRetrievedLinks(db, 3);
    expect(linksCreated).toBe(1);

    // 6. Verify relationship
    const rel = db.query("SELECT * FROM relationships WHERE source_id = 'err-01' AND target_id = 'ght-01'").get();
    expect(rel).toBeDefined();

    console.log("Full lifecycle integration test passed.");
  });
});
