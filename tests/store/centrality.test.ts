import { describe, test, expect, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'node:fs';
import { initDatabase } from '../../src/store/database.js';
import { computeDegreeCentrality, getTopCentralNodes } from '../../src/store/centrality.js';

const TEST_DB = '/tmp/gyst-test-centrality.db';

afterEach(() => { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

function insertEntry(db: ReturnType<typeof initDatabase>, id: string, title: string) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO entries (id, type, title, content, confidence, source_count, created_at, last_confirmed, status, scope)
     VALUES (?, 'learning', ?, '', 0.7, 1, ?, ?, 'active', 'team')`,
    [id, title, now, now]
  );
}

describe('computeDegreeCentrality', () => {
  test('returns empty map when no entries', () => {
    const db = initDatabase(TEST_DB);
    expect(computeDegreeCentrality(db).size).toBe(0);
    db.close();
  });

  test('hub node scores higher than leaf nodes', () => {
    const db = initDatabase(TEST_DB);
    insertEntry(db, 'hub', 'Hub');
    insertEntry(db, 'leaf1', 'Leaf1');
    insertEntry(db, 'leaf2', 'Leaf2');
    db.run(`INSERT INTO relationships (source_id, target_id, type) VALUES ('hub', 'leaf1', 'related_to')`);
    db.run(`INSERT INTO relationships (source_id, target_id, type) VALUES ('hub', 'leaf2', 'related_to')`);

    const centrality = computeDegreeCentrality(db);
    expect(centrality.get('hub')!).toBeGreaterThan(centrality.get('leaf1')!);
    db.close();
  });
});

describe('getTopCentralNodes', () => {
  test('returns at most N nodes', () => {
    const db = initDatabase(TEST_DB);
    for (let i = 0; i < 5; i++) insertEntry(db, `n${i}`, `Node ${i}`);
    expect(getTopCentralNodes(db, 3).length).toBeLessThanOrEqual(3);
    db.close();
  });
});
